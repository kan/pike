# Pike Codex Delegationモード 実装指示書

> Claude Code向けの実装タスク定義。Pikeに内蔵coding agent機能(Delegationモード)としてOpenAI Codex App Serverを統合する。

## ゴール

PikeのTauri backendから`codex app-server`サブプロセスを起動し、JSON-RPC over stdioで通信する内蔵agent機能を実装する。ユーザーはPike上でChatGPTにサインインするだけで、自分のChatGPT subscription枠を使ってcoding agentを利用できる状態にする。

## ブランチとバージョン

- **ブランチ**: この機能の開発はすべて `main` から切った専用ブランチ `feature/codex-delegation` (もしくは同等の名前) で行う。`main` には直接コミットしない。Phase単位でcommitを積み、機能完成後にPRを作成する想定。
- **バージョン**: 現行の `0.3.x` から一つ進めて `0.4.0` とする。最初のPhase Aのcommit時点で以下のファイルのバージョンを更新すること:
  - `src-tauri/Cargo.toml` の `package.version`
  - `src-tauri/tauri.conf.json` の `version` (存在する場合)
  - `package.json` の `version`
  - その他Pikeプロジェクトでバージョン参照がある箇所
- 0.4.0は Delegationモード機能の追加バージョンと位置づける。リリース時点でChangelog/README のfeatureセクションにCodex統合の説明を追加する。

## アーキテクチャ概要

```
Pike Frontend (Vue/TS)
    ↕ Tauri command/event
Pike Backend (Rust)
    ├─ CodexRuntime trait (Windows native / WSL distro 切替)
    ├─ Codex AppServer Client (JSON-RPC over stdio)
    └─ spawn: codex app-server
              ↕ stdio JSONL
         Codex Process (Windows or WSL)
```

統合手段は **Codex App Server** を使う。Codex SDK (TypeScript/Python) は使わない。理由はNode.js依存を避けるためと、IDE統合に必要な双方向プロトコル(approval等)がApp Server側にしかないため。

## スコープ

### Phase 1で実装するもの

- `CodexRuntime` trait と Windows/WSL 実装
- Codex App Server child processの起動・stdio JSON-RPCクライアント
- ChatGPT OAuth認証フロー (`chatgpt`モード)
- Thread/turn の基本ライフサイクル管理
- Streaming event受信とPike UIへの流し込み
- File change approval (Pikeエディタで差分プレビュー)
- Command execution approval (ダイアログ)
- 現在開いているファイルの自動コンテキスト注入
- セッション永続化 (threadIdの保存と`resumeThread`)

### Phase 1で実装しないもの (将来の作業)

- カスタムMCPサーバ (Pike独自ツール)
- `chatgptAuthTokens`モードでの認証一元化
- AGENTS.md自動生成
- Skills/Hooks対応
- Sub-agent対応
- ローカルLLMやAnthropic API対応 (Nativeモードで別途)

## 実装順序

各Phaseは独立してテスト可能であること。前Phaseが動かない状態で次に進まない。

### Phase A: CodexRuntime抽象とプロセス起動

**目的**: Codex app-serverをchild processとして起動でき、stdin/stdoutのpipeが確立できる。

**ファイル構成**:
```
src-tauri/src/codex/
  mod.rs
  runtime.rs       # CodexRuntime trait
  runtime_windows.rs
  runtime_wsl.rs
  process.rs       # ChildプロセスとI/O管理
```

**CodexRuntime trait**:
```rust
pub trait CodexRuntime: Send + Sync {
    fn spawn_app_server(&self, working_dir: &Path) -> Result<tokio::process::Child>;
    fn translate_path_from_codex(&self, codex_path: &str) -> PathBuf;
    fn translate_path_to_codex(&self, host_path: &Path) -> String;
    fn display_environment_name(&self) -> String;
    fn codex_version(&self) -> Result<String>;
}

pub struct WindowsNativeRuntime;
pub struct WslRuntime { pub distro: String }
```

**重要**:
- Pikeには既にWSL distro検出とパス変換のロジックがあるはず。新規実装ではなく既存コードを呼び出すアダプタとして実装すること。
- `WslRuntime::spawn_app_server`は `wsl.exe -d <distro> -- codex app-server` を起動する。
- `WindowsNativeRuntime::spawn_app_server`は `codex.exe app-server` を起動する。
- stdin/stdout/stderrは `Stdio::piped()` で取得。stderrはログに流す。
- working_dirの渡し方: WSL runtimeでは `wsl.exe --cd <linux-path>` を使う。Windows runtimeでは `Command::current_dir()` を使う。

**動作確認**:
- Pikeから空のworking_dirで起動 → プロセスが立ち上がりstdoutに何か出力されることを確認。

### Phase B: JSON-RPCクライアントとinitializeハンドシェイク

**目的**: Codex App Serverとinitialize handshakeが成功し、`codexHome`等のサーバ情報を取得できる。

**ファイル構成**:
```
src-tauri/src/codex/
  protocol/
    mod.rs
    messages.rs    # serde structでJSON-RPCメッセージ定義
    client.rs      # 送受信ループ
```

**プロトコル**:
- 通信形式: JSON Lines over stdio (各行が1つのJSON-RPCメッセージ)
- 標準のJSON-RPC 2.0だが、`"jsonrpc": "2.0"` フィールドは省略される (Codex独自)
- 双方向: クライアント→サーバのrequestに加え、サーバ→クライアントのrequestもある(approval等)

**メッセージ型生成**:
```bash
codex app-server generate-json-schema --out schemas/
```
このスキーマからRustの型を生成するか、手動でserdeのstructを書く。最低限、Phase B-Eで使うものだけ書けば良い:
- `InitializeParams` / `InitializeResult`
- `Notification` (`initialized`)

**実装**:
```rust
pub struct AppServerClient {
    child: tokio::process::Child,
    request_tx: mpsc::Sender<OutgoingMessage>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl AppServerClient {
    pub async fn connect(runtime: &dyn CodexRuntime, working_dir: &Path) -> Result<Self> { ... }
    pub async fn request<R: DeserializeOwned>(&self, method: &str, params: Value) -> Result<R> { ... }
    pub async fn notify(&self, method: &str, params: Value) -> Result<()> { ... }
    pub fn subscribe_notifications(&self) -> broadcast::Receiver<Notification> { ... }
    pub fn subscribe_server_requests(&self) -> mpsc::Receiver<ServerRequest> { ... }
    pub async fn respond_to_server_request(&self, id: u64, result: Value) -> Result<()> { ... }
}
```

**注意点**:
- stdoutを行単位で読むtokio task、stdinに書くtokio task、それぞれ独立して回す。
- request/responseの相関はidで取る。サーバから来るrequest(idあり)とnotification(idなし)を区別する。
- パースエラーは握りつぶさずログに出す。デバッグ時に致命的に重要。

**動作確認**:
- `initialize` → `initialized` の往復が成功し、サーバが返す`userAgent`/`codexHome`/`platformFamily`をログに出せる。

### Phase C: ChatGPT OAuth認証フロー

**目的**: ユーザーがPike上で「Sign in with ChatGPT」を押すと、ブラウザが開いてOAuthが完了し、Pikeが認証済み状態を認識できる。

**JSON-RPC method**:
- `account/read` — 現在の認証状態を取得
- `account/login/start` (params: `{ type: "chatgpt" }`) — ブラウザフロー開始
- `account/login/cancel` — 進行中のログインをキャンセル
- `account/logout`

**Server-initiated notifications**:
- `account/updated` — 認証状態変化(`authMode`, `planType`等を含む)

**実装**:
```rust
pub enum AuthState {
    Unauthenticated,
    AuthenticatingChatGpt,  // ブラウザ表示中
    Authenticated { mode: AuthMode, plan_type: Option<String> },
    Error(String),
}

pub struct AuthManager {
    client: Arc<AppServerClient>,
    state: watch::Sender<AuthState>,
}

impl AuthManager {
    pub async fn start_chatgpt_login(&self) -> Result<()>;
    pub async fn logout(&self) -> Result<()>;
    pub fn subscribe_state(&self) -> watch::Receiver<AuthState>;
}
```

**Tauri commands** (frontend向け):
- `codex_auth_status` → 現在の状態を返す
- `codex_auth_login_chatgpt` → ログイン開始
- `codex_auth_logout`
- イベント `codex://auth/state` でstate変化をfrontendに通知

**重要な前提**:
- 認証はruntime単位で別物。WindowsNativeRuntimeとUbuntu-24.04のWslRuntimeはそれぞれ独立してログインが必要。
- `AuthManager`は`AppServerClient`単位で持つこと。

**動作確認**:
- Pike UIにログインボタンを置き、押してブラウザが開くこと。ログイン完了後、状態が`Authenticated`になりPlanTypeが取得できること。

### Phase D: Thread/turnの基本実行

**目的**: ユーザーがチャット欄にプロンプトを入力すると、Codexがturnを実行し、応答がストリーミング表示される。

**JSON-RPC methods**:
- `thread/start` — 新しいthreadを開始
- `thread/resume` (params: `{ threadId }`) — 既存threadを再開
- `turn/start` (params: `{ threadId, input, model?, sandboxPolicy?, approvalPolicy? }`) — turnを開始
- `turn/interrupt`

**Server notifications**:
- `thread/started`
- `turn/started`, `turn/completed` (usage/token情報含む), `turn/failed`
- `item/started`, `item/completed`
- `item/agentMessage/delta` — テキストstreamingのdelta
- `item/reasoning/delta` — 推論内容(モデルが対応する場合)
- `turn/diff/updated` — unified diff

**Item型の最低対応**:
- `AgentMessageItem` — エージェントの返答テキスト
- `CommandExecutionItem` — シェルコマンド実行(command, exitCode, stdout, stderr)
- `FileChangeItem` — ファイル変更(path, diff)
- `TodoListItem` — エージェントの計画
- `ReasoningItem` — 推論の要約

それ以外のitemは`{type: string, raw: Value}`にfallbackして無視せず保持。将来対応のため。

**実装**:
```rust
pub struct ThreadSession {
    client: Arc<AppServerClient>,
    runtime: Arc<dyn CodexRuntime>,
    thread_id: Mutex<Option<String>>,
    items: RwLock<Vec<TurnItem>>,
}

impl ThreadSession {
    pub async fn start_or_resume(&self, working_dir: &Path) -> Result<()>;
    pub async fn submit_turn(&self, prompt: String) -> Result<TurnHandle>;
    pub async fn interrupt_current_turn(&self) -> Result<()>;
}
```

**Tauri commands**:
- `codex_submit_turn(prompt: String)` 
- `codex_interrupt_turn()`
- イベント `codex://turn/event` で各種itemやdeltaをfrontendに流す

**Sandboxポリシーのデフォルト**:
- `workspace-write` を初期値とする(ファイル書き込み許可、ネットワークblock)。
- 設定でユーザーが変更可能にしておくが、UI実装はPhase Fでよい。

**動作確認**:
- 「helloと言って」程度の単純なプロンプトでturnが完了し、応答テキストがstreamingで表示される。
- 「READMEを読んで要約して」のような実ファイル読み込みが伴うプロンプトで、CommandExecutionItemやFileChangeItemが流れてくる(実際の編集はないが、読み取りコマンドは走る)。

### Phase E: Approval (file change / command execution)

**目的**: Codexが破壊的アクションをしようとした時、Pike UIで承認を取れる。ファイル変更は差分をエディタでプレビューしてから承認する。

**Server-initiated requests** (Pike側でハンドラ実装):
- `item/commandExecution/requestApproval`
  - フィールド: `itemId`, `threadId`, `turnId`, `command`, `cwd`, `commandActions`, `proposedExecpolicyAmendment`, `networkApprovalContext`, `availableDecisions`
  - 応答: `accept` / `acceptForSession` / `decline` / `cancel` / `acceptWithExecpolicyAmendment`
- `item/fileChange/requestApproval`
  - フィールド: `itemId`, `threadId`, `turnId`, `reason`, `grantRoot`
  - 応答: `accept` / `acceptForSession` / `decline` / `cancel`

**処理フロー**:

```rust
// AppServerClient のserver_request streamを購読
while let Some(req) = server_requests.recv().await {
    match req.method.as_str() {
        "item/commandExecution/requestApproval" => {
            let params: CommandApprovalParams = serde_json::from_value(req.params)?;
            // frontendにイベント送信、ユーザー応答を待つ
            let decision = ui_request_command_approval(params).await?;
            client.respond_to_server_request(req.id, decision).await?;
        }
        "item/fileChange/requestApproval" => {
            // 差分をエディタでプレビュー、ユーザー応答を待つ
            ...
        }
        _ => { /* 未対応はdeclineで返す */ }
    }
}
```

**Pike UI側の責務**:
- Command approval: モーダルダイアログにcommand、cwd、実行環境名 (`runtime.display_environment_name()`) を表示
- File change approval: Pikeのエディタで差分をinline diffプレビュー、acceptで適用される
- "Accept for session" を選んだ場合はPikeのセッション状態として記録

**実行環境の表示**: ダイアログには必ず実行環境を併記すること。例: 「Execute in Ubuntu-24.04 (WSL): `rm -rf node_modules`」。誤解事故防止のため必須。

**動作確認**:
- 「適当なファイルを作ってhelloと書き込んで」でファイル変更承認ダイアログが出ること。
- 「`ls`を実行して」でコマンド実行承認が出ること(workspace-writeでは安全コマンドはskipされる場合あり)。

### Phase F: コンテキスト注入とIDE統合の磨き込み

**目的**: Pike IDEとしての差別化要素を実装する。

**実装項目**:

1. **現在のエディタ状態をturn promptに注入**
   - `submit_turn`時に、Pikeで現在開いているファイルのpath、カーソル位置、選択範囲を取得
   - prompt先頭に以下のような形で付与:
     ```
     [Pike context]
     Current file: src/main.rs
     Cursor: line 42, col 8
     Selection: lines 40-45
     
     [User prompt]
     <ユーザーが入力したテキスト>
     ```
   - パスは`runtime.translate_path_to_codex()`で変換

2. **CommandExecutionItem を既存xterm.jsペインにストリーム**
   - Pikeには既にterminal pane (xterm.js + portable-pty) があるはず
   - Codex由来のコマンド実行は専用の表示モードでこのペインに流す
   - 通常のターミナルセッションとは色やprefixで区別する

3. **TodoListItem をサイドバーに表示**
   - エージェントの内部planを「Codexの計画」として可視化
   - チェックボックスや進行状況の表示

4. **threadIdの永続化**
   - Pikeのワークスペース設定に最新のthreadIdを保存
   - ワークスペース再オープン時は`thread/resume`で継続

5. **バージョン整合性チェック**
   - Pike起動時に各runtimeの`codex --version`を取得
   - 大きく異なる場合(major.minorが違う等)は警告を出す

## ファイル構成 (推奨)

```
src-tauri/src/codex/
  mod.rs                       # 公開API
  runtime.rs                   # CodexRuntime trait
  runtime_windows.rs           # WindowsNativeRuntime
  runtime_wsl.rs               # WslRuntime
  process.rs                   # Child process管理
  protocol/
    mod.rs
    client.rs                  # JSON-RPCクライアント
    messages.rs                # メッセージ型定義
    items.rs                   # Item型(AgentMessage, CommandExecution, ...)
  auth.rs                      # AuthManager
  session.rs                   # ThreadSession
  approval.rs                  # Approval handler
  context.rs                   # Editor状態 → prompt 注入

src-tauri/src/commands/
  codex.rs                     # Tauri commands

src/components/codex/          # Vue側
  ChatPane.vue
  ApprovalDialog.vue
  TodoListPanel.vue
  AuthPanel.vue
```

## 重要なゴッチャと事前知識

**1. パス変換は双方向**: Codexは`/home/kan/...`を返してくる。Pikeのエディタは`\\wsl.localhost\Ubuntu-24.04\home\kan\...`で開いている。`FileChangeItem`を受け取ったら必ず`translate_path_from_codex()`を通すこと。逆に、エディタで開いているファイルのパスをCodexに渡す時は`translate_path_to_codex()`を通すこと。

**2. 認証は環境ごと**: WindowsとUbuntu-24.04のCodexは別々の`~/.codex/auth.json`を持つ。Pikeは現在の作業環境のruntimeに紐づくAuthManagerを参照する。

**3. プロセスは長命**: Codex app-serverはturn毎に起動するのではなく、session中ずっと生かしておく。起動オーバーヘッド削減のため。

**4. JSON-RPC形式の特殊性**: Codexは`"jsonrpc": "2.0"`フィールドを省略する。標準のserde_json::Valueでパースする時に意識すること。

**5. 未知のメッセージは握りつぶさない**: バージョン更新でCodex側に新しいitem typeやnotification methodが追加される可能性がある。未知のメッセージはエラーにせず、Valueとして保持してログに記録する。

**6. stderr は重要**: codex app-serverはstderrにログを出す。Pikeの開発中は必ずキャプチャしてログに流すこと。トラブルシューティングに必須。

**7. workspace-writeでもCodexは安全コマンドを自動承認する**: 全コマンドでapprovalが出るわけではない。`echo`や`ls`はsandboxポリシー次第でskipされる。動作確認時に「approvalが出ない=壊れてる」と誤判定しないこと。

**8. WSL起動時のworking_dir**: `wsl.exe`にcurrent_dirを設定するだけでは効かない場合がある。`wsl.exe --cd <linux-path> -d <distro> -- codex app-server`の形で明示的に指定する。

**9. Hooks (PreToolUse等) はWindows非対応**: Windows native runtimeでは使えない機能がある。Phase 1ではhooksは使わないので無視してよい。

**10. テスト用フィクスチャ**: Codex app-serverの実プロセスを使わずに単体テストしたい場合、`CodexRuntime`をモック実装してダミーのChildを返す形にすると、protocol clientのテストができる。

## チェックポイント

各Phase完了時にユーザー(Kan)が手動確認するチェックリスト:

- [ ] **Phase A**: `codex app-server`プロセスが起動し、stdoutから何か読める
- [ ] **Phase B**: initialize/initialized handshakeが完了し、サーバ情報がログに出る
- [ ] **Phase C**: ChatGPTログインボタンでブラウザが開き、ログイン完了後にPlanTypeが取れる
- [ ] **Phase D**: 「helloと言って」で応答テキストがストリーミング表示される
- [ ] **Phase E**: 「ファイルを作って」で差分プレビューと承認ダイアログが出る
- [ ] **Phase F**: 開いているファイルの内容を踏まえた応答が得られる

各Phase完了時にcommitすること。動かない状態で次のPhaseに進まない。

## 参考リンク

- Codex App Server protocol: `openai/codex` repo の `codex-rs/app-server/README.md`
- スキーマ生成: `codex app-server generate-json-schema --out <dir>`
- 関連crate: `codex-app-server-protocol`, `codex-app-server-sdk` (crates.io)
