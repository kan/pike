# Pike — Claude Code ガイド

## プロジェクト概要

**Pike** は Tauri v2 (Rust + Vue/TypeScript) で構築する Windows 向け軽量開発環境。
「AI エージェント × ターミナル」に特化し、VS Code より大幅に軽いことが最重要の差別化点。

### 設計思想
- **軽さ最優先**: Monaco は使わない。CodeMirror 6 のみ。拡張機能システムは作らない
- **タブ統一**: エディタ・ターミナル・Docker logs をすべて同一タブで扱う
- **Rust はステートレスに**: Rust は I/O ブリッジに徹する。セッション復帰は各ツールの resume 機能（`claude --continue` 等）に委譲
- **外部依存は明示**: rg なければ grep、と graceful degrade する。tmux はオプション機能

### ターゲット環境
- **OS**: Windows 11（メイン開発・動作環境）
- **実行環境**: WSL2 上のシェル・Docker コンテナ、または Windows ホスト上のシェル
- **GUI**: Tauri v2 webview (Windows ネイティブプロセス)
- **対応シェル**: WSL bash / cmd.exe / PowerShell / Git Bash

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│  Tauri WebView (Windows プロセス)                        │
│  ┌────────────┐  ┌──────────────────────────────────┐  │
│  │ 左サイドバー│  │ タブペイン                        │  │
│  │ アイコン   │  │ [📌CC][📌Codex][editor][shell][+]│  │
│  │ ナビ       │  │                                    │  │
│  │ ─────────  │  │  xterm.js / CodeMirror 6          │  │
│  │ 🗂 files   │  │  (アクティブタブのコンテンツ)      │  │
│  │ 🌿 git     │  │                                    │  │
│  │ 🔍 search  │  └──────────────────────────────────┘  │
│  │ 🐋 docker  │                                         │
│  │ 📁 projects│                                         │
│  └────────────┘                                         │
└──────────────┬──────────────────────────────────────────┘
               │ Tauri IPC (invoke / events)
┌──────────────▼──────────────────────────────────────────┐
│  Rust バックエンド                                        │
│  pty_manager   git_manager   fs_watcher   search         │
│  project_store docker_client                             │
└──────────────┬──────────────────────────────────────────┘
               │ wsl.exe spawn / bollard / git2 / notify
┌──────────────▼──────────────────────────────────────────┐
│  WSL2 (Ubuntu)                                           │
│  tmux sessions ← Claude Code / bash / etc.              │
│  Docker (WSL2 backend) ← コンテナ群                      │
└─────────────────────────────────────────────────────────┘
```

---

## ディレクトリ構成

```
pike/
├── CLAUDE.md                  # このファイル
├── docs/
│   ├── MILESTONE.md           # マイルストーン・進捗管理
│   └── pike-codex-*.md        # Codex連携 実装指示書
├── scripts/
│   └── download-rg.sh         # rg サイドカーバイナリのダウンロード
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs            # Tauri エントリポイント
│       ├── lib.rs             # Tauri Builder 設定・コマンド登録
│       ├── types.rs           # ShellConfig 等の共通型定義
│       ├── font.rs            # フォント列挙（font-kit でモノスペース検出）
│       ├── cli.rs             # CLI 引数パース・CliState・single-instance 連携
│       ├── agent/
│       │   ├── mod.rs         # 統一エージェント API モジュール
│       │   ├── types.rs       # AgentRuntime trait・AgentEvent・AgentCapabilities
│       │   ├── commands.rs    # agent_* Tauri コマンド（13個）
│       │   ├── state.rs       # ウィンドウ別セッション管理
│       │   ├── codex_runtime.rs  # Codex app-server → AgentRuntime 実装
│       │   └── acp_runtime.rs    # ACP JSON-RPC → AgentRuntime 実装
│       ├── pty/
│       │   └── mod.rs         # PTY 管理（WSL/cmd/PowerShell/Git Bash 対応）
│       ├── watcher/
│       │   └── mod.rs         # ファイル監視（notify + WSL inotifywait）
│       └── project/
│           └── mod.rs         # プロジェクト CRUD・WSL ディストロ検出
├── src/                       # Vue/TypeScript フロント
│   ├── App.vue                # ルート（PTY ルーター初期化・プロジェクト復元）
│   ├── main.ts
│   ├── types/
│   │   ├── tab.ts             # Tab Union type・ShellType・共通ヘルパー
│   │   ├── project.ts         # ProjectConfig・PinnedTabDef
│   │   └── agent.ts           # AgentEvent・AgentCapabilities・AgentAuthState
│   ├── components/
│   │   ├── ProjectSwitcher.vue  # fzf 風プロジェクト切替 + 新規作成モーダル
│   │   ├── QuickOpen.vue        # Ctrl+P クイックオープン（rg --files + fuzzy match）
│   │   ├── ConfirmDialog.vue    # カスタム確認ダイアログ（Teleport）
│   │   ├── layout/
│   │   │   ├── SideBar.vue    # アイコンナビ + パネル
│   │   │   └── TabPane.vue    # タブバー + コンテンツ + シェル選択
│   │   ├── panels/
│   │   │   ├── FileTreePanel.vue  # ファイルツリー
│   │   │   └── ProjectPanel.vue   # プロジェクト一覧・登録・編集・削除
│   │   ├── agent/
│   │   │   └── AgentApprovalDialog.vue  # 統一 approval ダイアログ
│   │   └── tabs/
│   │       ├── TerminalTab.vue    # xterm.js + PTY（autoStart 対応）
│   │       ├── AgentChatTab.vue   # 統一エージェントチャット（Codex / Claude Code）
│   │       ├── SettingsTab.vue    # 設定画面（フォント・カラースキーム・ダークモード・エディタ設定）
│   │       ├── CsvTab.vue         # CSV/TSV テーブルプレビュー
│   │       ├── PdfTab.vue         # PDF プレビュー（iframe）
│   │       └── MermaidTab.vue     # Mermaid ダイアグラムプレビュー
│   ├── stores/
│   │   ├── tabs.ts            # タブ状態管理 (Pinia)
│   │   ├── sidebar.ts         # サイドバー状態
│   │   ├── settings.ts        # アプリ設定（フォント・カラースキーム・ダークモード・エディタ設定）
│   │   ├── project.ts         # プロジェクト管理・切替・永続化
│   │   └── agent.ts           # 統一エージェント状態管理（agent_* API 使用）
│   ├── composables/
│   │   ├── useKeyboardShortcuts.ts  # Ctrl+T/W/Tab/Shift+P/P
│   │   ├── useConfirmDialog.ts      # カスタム確認ダイアログ composable
│   │   ├── usePtyRouter.ts         # PTY イベント集中ルーター + CWD 検出 + グローバル exit フック
│   │   ├── useFsWatcher.ts        # ファイル監視イベントルーター
│   │   ├── useCliOpen.ts          # CLI 引数によるファイル/プロジェクト自動オープン
│   │   ├── useTerminalNotifications.ts  # ターミナル終了デスクトップ通知
│   │   └── useAgentRouter.ts      # agent:// イベントルーター（統一エージェント API）
│   ├── lib/
│   │   ├── fileIcons.ts       # material-file-icons ラッパー（キャッシュ付き）
│   │   ├── fontDetection.ts   # フォント名ユーティリティ（buildFontFamily/extractFontName）
│   │   ├── gitGraph.ts        # ブランチマージグラフ描画（レーン割当 + SVG）
│   │   ├── editorGitGutter.ts # CodeMirror 6 git diff ガター拡張
│   │   ├── editorMinimap.ts   # CodeMirror 6 ミニマップ（@replit/codemirror-minimap）
│   │   ├── editorThemes.ts   # CodeMirror 6 エディタテーマ定義（6種）
│   │   ├── editorSearch.ts    # CodeMirror 6 カスタム検索パネル
│   │   ├── tauri.ts           # IPC ラッパー
│   │   └── window.ts          # ウィンドウラベル判定（main / project-{id}）
│   └── assets/
│       └── theme.css          # CSS Variables テーマ定義（ダーク/ライト）
└── .claude/
    └── rules/
        ├── rust.md            # Rust 実装ルール
        ├── frontend.md        # フロント実装ルール
        └── testing.md         # テスト方針
```

---

## 現在のフォーカス

**→ docs/MILESTONE.md の「現在のマイルストーン」セクションを参照**

実装を始める前に必ず docs/MILESTONE.md で現在の M番号と完了条件を確認すること。

---

## Tauri IPC 規約

コマンド名は `snake_case`、フロントからは `invoke('command_name', { ...args })` で呼ぶ。

```typescript
// フロント側の呼び出し例
import { invoke } from '@tauri-apps/api/core'
const result = await invoke<PtyOutput>('pty_write', { id: termId, data: input })
```

```rust
// Rust 側のコマンド定義例
#[tauri::command]
async fn pty_write(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    // ...
}
```

ストリーミングデータ（PTY stdout、Docker logs）は `emit` イベントで Rust → フロントに push する：

```rust
app_handle.emit("pty_output", PtyOutputPayload { id, data }).unwrap();
```

---

## 重要な技術メモ

### PTY / シェル対応
- PTY 管理は `portable-pty` クレートを使う（ConPTY 対応済み）
- `pty_spawn` コマンドが `ShellConfig` に応じてシェルを起動:
  - WSL: `wsl.exe [-d distro] [--cd path] bash`
  - cmd: `cmd.exe`
  - PowerShell: `powershell.exe -NoLogo`
  - Git Bash: `C:\Program Files\Git\bin\bash.exe --login`（自動検出）
- 環境変数 `TERM=xterm-256color` を cmd 以外に設定
- リサイズは `pty.resize()` で PTY サイズを更新
- `autoStart` 対応: PTY spawn 後に指定コマンドを自動実行（例: `claude`）
- `PtySession` に `Drop` 実装: セッション破棄時に `child.kill()` で子プロセスを確実に終了
- ウィンドウ破棄時（`WindowEvent::Destroyed`）に全 PTY セッション・Docker log stream を一括 cleanup（main ウィンドウのみ）
- タブ切替時の TUI 再描画: `nextTick` → `requestAnimationFrame` → `terminal.refresh()` + PTY resize nudge（1col 縮小→復元で SIGWINCH 発火）
- ターミナルアクティビティ通知: 非アクティブタブの出力でドット表示（`hasActivity`）、プロセス終了で終了コードバッジ（`exitCode`）、非 pinned タブはプロセス終了 1 秒後に自動クローズ
- デスクトップ通知: バックグラウンドタブの PTY 終了時に `Notification` API でトースト通知。`onclick` でウィンドウフォーカス + タブ切替。`ptyRouter.onGlobalExit()` フック経由。Settings で ON/OFF 切替可能

### プロジェクト管理
- プロジェクト設定は `%APPDATA%/com.tauri.dev/projects/{id}/project.json` に保存
- 開いている全プロジェクト ID を `last_project.txt` に永続化し、起動時に全ウィンドウを自動復元
- プロジェクトは WSL / Windows の2プラットフォームに対応
- WSL プロジェクト: ディストロ指定、ルートは WSL パス
- Windows プロジェクト: デフォルトシェル（cmd/PowerShell/Git Bash）選択、ルートは Windows パス
- プロジェクト切替時: 全タブ kill → pinnedTabs 復元（なければ Claude Code 固定タブを自動作成）
- Windows プロジェクトでは「+」ボタン横のドロップダウンでデフォルト以外のシェルも選択可能

### ファイルツリー / エディタ
- Rust `fs` モジュールが WSL/Windows 両対応のファイル操作を提供（list_dir / read_file / write_file）
- WSL: `wsl.exe find`, `wsl.exe cat`, `wsl.exe bash -c "cat > ..."` 経由
- Windows: `std::fs` 直接アクセス
- ファイルサイズ事前チェック（2MB 制限）
- CodeMirror 6 でエディタタブ。oneDark テーマ、29言語のシンタックスハイライト対応
- Ctrl+S で保存、ダーティ表示（タブタイトルに `*`）。Ctrl+Z/Shift+Z で Undo/Redo
- エディタ内検索・置換: Ctrl+F / Ctrl+H でカスタム検索パネル（右上フローティング、アイコンボタン、マッチ数表示）
- Git diff ガター: 追加行（緑）・変更行（黄）・削除行（赤三角）をガターに表示。`git_diff_lines` コマンドで行単位の差分を取得
- ミニマップ: `@replit/codemirror-minimap` を採用。blocks モード、シンタックスカラー反映、正確なスクロール同期、git diff ガター表示
- エディタコンテキストメニュー: Undo/Redo/Cut/Copy/Paste/Git History（Teleport パターン）
- ファイルツリーに git ステータス色表示（precomputed Map で O(1) ルックアップ）
- 画像プレビュータブ（base64 経由）、Markdown プレビュー（Edit/Split/Preview 3モード、スクロール同期、250ms デバウンス）
- Markdown プレビュー内リンク: 外部 URL は confirm 付きで `open_url` 経由の外部ブラウザ起動、ローカルファイルはプロジェクトルート内に限定して EditorTab で開く（`resolveLocalPath` でディレクトリトラバーサル防止 + `decodeURIComponent` 対応）
- 文字コード対応: `encoding_rs` で自動検出 + 指定エンコードでの開き直し/保存（StatusBar 2段階 UI）
- 改行コード LF/CRLF 切替（StatusBar クリック）、保存時に適用
- ファイルツリーコンテキストメニュー: リネーム（インライン入力）、削除（カスタム confirm ダイアログ）、Git History（専用タブ）
- ドラッグ&ドロップ移動 + Ctrl でコピー（`dragDropEnabled: false` で Tauri ネイティブ D&D を無効化）
- ダーティエディタタブの閉じ確認ダイアログ（カスタム confirm）
- WSL コマンドにパス引数前の `--` を付与（フラグ injection 防止）
- 外部 URL オープン: `open_url` コマンドは http/https のみ許可（Rust 側でバリデーション）。`explorer.exe` 経由で開く（`cmd.exe /C start` はシェルメタ文字インジェクションの危険があるため不使用）。フロント側でも confirm ダイアログを表示

### Git 統合
- `git` CLI 経由（WSL/Windows 両対応）。`git2` クレートは使わない
- Rust 側 `build_git_command` が ShellConfig に応じて `wsl.exe git` / `git` を組み立て
- ステータスバーにブランチ名+ダーティ表示、クリックでブランチ切替
- Git パネル: ステージング/アンステージ、コミット、push/pull/refresh、コミットツリー展開
- diff タブ: 左右分割表示、文字単位ハイライト（common prefix/suffix 方式）
- ahead/behind: `git status --porcelain=v2 --branch` の `# branch.ab` 行をパース。GitPanel コミットボタン下にテキスト表示、SideBar の pull/push ボタンを primary スタイルに変更
- コミットログは `%B`（全文）取得、一覧は1行目のみ表示、ホバーで全文ツールチップ
- ブランチマージグラフ: `git log --all` + `%P`（親ハッシュ）/`%D`（refs）で取得、`gitGraph.ts` のレーン割当アルゴリズムで SVG 描画。List / Graph 切替
- git log フォーマット区切り: ASCII Unit Separator (`%x1f`) + Record Separator (`%x1e`) を使用（NUL だと `%D` が空のコミットでレコード区切りと衝突するため）

### Docker 統合
- `bollard` クレートで Docker API に接続（named pipe → TCP:2375 → TCP:2376 フォールバック）
- クライアントは `OnceCell` でキャッシュし、毎コマンドの再接続を回避
- compose.yml を `serde_yaml` でパースしてサービス一覧表示
- コンテナ状態を compose ラベル（`com.docker.compose.service`）でサービスにマッチ
- start / stop / restart / refresh を UI から実行、5秒ポーリングで状態更新
- ログストリーミングは 50ms バッファリング + Tauri イベント emit
- DockerLogsTab は xterm.js ベース（読み取り専用、`convertEol: true`）
- `docker exec` シェル: bollard exec API でコンテナ内シェルを検出（bash → sh フォールバック）、プロジェクトのシェル内で `docker exec -it` を autoStart 実行

### セッション永続化
- タブの並び順・アクティブタブ・種別を `ProjectConfig.lastSession` に保存
- Pinia `$subscribe` でタブ変更を検知 → 1秒デバウンスで `project.json` に書き出し
- `beforeunload` で即時保存（best-effort、async なので保証なし）
- プロジェクト復元時: `lastSession` があればそこから復元、なければ `pinnedTabs` にフォールバック
- AI エージェントのセッション復帰は各ツールの resume 機能に委譲（`RESUME_MAP` で `claude` → `claude --continue` に変換）
- tmux はオプション機能として `pty_spawn_tmux` コマンドで利用可能（必須ではない）
- タブのドラッグ&ドロップ入れ替え（HTML5 Drag and Drop API、box-shadow でドロップ位置表示）
- タブコンテキストメニュー: Pin/Unpin、Close、Close Others、Close to the Right、Close Saved、Close All
  - ファイル系タブ（editor/preview/diff/history）では Copy Path、エディタタブでは Git History も表示
  - バルク操作は pinned タブをスキップ、未保存エディタがある場合は一括確認ダイアログ

### Docker / bollard
- フォールバック戦略で接続（musql と同一パターン）:
  1. `Docker::connect_with_local_defaults()` — named pipe / DOCKER_HOST 環境変数
  2. `Docker::connect_with_http("tcp://127.0.0.1:2375")` — WSL2 dockerd (unencrypted)
  3. `Docker::connect_with_http("tcp://127.0.0.1:2376")` — WSL2 dockerd (encrypted)
- 各接続で `ping()` して到達確認、最初に成功したものを使う
- Docker Desktop なしでも WSL2 の dockerd が TCP を公開していれば接続可能

### マルチウィンドウ
- ProjectSwitcher の Ctrl+Enter または ProjectPanel の ExternalLink ボタンで新ウィンドウにプロジェクトを開く
- ウィンドウラベル `project-{id}` でプロジェクトを識別。同一プロジェクトの二重起動は既存ウィンドウをフォーカス
- Tauri v2 の各ウィンドウは独立 JS コンテキスト → Pinia ストアは自然にウィンドウごとに分離
- PTY/Docker イベントは `app.emit()` で全ウィンドウにブロードキャスト、ルーターが ID でフィルタ
- 全ウィンドウ（main + 子）が `last_project.txt` に自身のプロジェクト ID を登録し、起動時に復元
- main ウィンドウ close → アプリ終了 + 全 PTY/Docker session cleanup
- 子ウィンドウ close → `beforeunload` で session 保存 + PTY kill（ベストエフォート）

### 開発ビルド
- `npm run tauri:dev` で開発版を起動（`tauri.dev.conf.json` で identifier を `com.pike.dev.debug` に上書き）
- インストール版 Pike (`com.pike.dev`) と開発版 (`com.pike.dev.debug`) は single-instance が別扱いになるため共存可能
- `import.meta.env.DEV` が true の場合、ウィンドウタイトルに `[DEBUG]` プレフィックスを付与
- `npm run tauri dev` は identifier が本番と同一のため、インストール版と競合する点に注意

### pike CLI
- バイナリ名 `pike.exe`（`Cargo.toml` `[[bin]] name = "pike"`）
- `tauri-plugin-single-instance` で二重起動を防止、引数を既存インスタンスに転送
- `pike file.rs:42` → ファイルを開いてジャンプ、`pike open <file>` も同様
- `pike .` / `pike <dir>` → ディレクトリに一致するプロジェクトに切替
- ファイルパスから最も適合するプロジェクトを自動マッチ（最長 root 一致）
- マッチしない場合は ad-hoc プロジェクトを自動作成（PowerShell）
- 別プロジェクトのファイルは新ウィンドウで開く（`CliState.pending` でアクションを転送）
- 既存エディタタブがある場合はフォーカス＋リロード（`reloadRequested` タイムスタンプ）

### CodeMirror 6
- シンタックスハイライトのみ、LSP・補完は実装しない
- 言語パッケージは使うもの（Go, Rust, TypeScript, Vue, YAML 等）だけ import
- ファイル保存は `Ctrl+S` → `invoke('fs_write_file', ...)`

### アイコン
- UI アイコンは `lucide-vue-next` で統一（サイドバー・タブ・パネルボタン等）
- ファイルアイコンは `material-file-icons` の SVG（`getIcon(name).svg`）
- `src/lib/fileIcons.ts` でファイル名 → SVG のキャッシュ付きラッパーを提供
- SVG は `v-html` で注入、`:deep(svg) { width: 16px; height: 16px }` でサイズ制御

### カスタム確認ダイアログ
- `window.confirm()` は WebView のオリジン URL がタイトルに表示されるため使わない
- `src/composables/useConfirmDialog.ts` が `confirmDialog(msg): Promise<boolean>` を提供
- `src/components/ConfirmDialog.vue` を `App.vue` に配置（Teleport で body 直下に描画）
- Enter で OK、Escape / オーバーレイクリックでキャンセル

### ウィンドウ状態永続化
- `tauri-plugin-window-state` でウィンドウサイズ・位置・最大化状態を自動保存・復元
- サイドバーの展開状態（activePanel）と幅は `localStorage` で永続化

### セルフアップデート
- `tauri-plugin-updater` + `tauri-plugin-process` で GitHub Releases の `latest.json` を参照
- 署名キー: `~/.tauri/pike.key`（秘密鍵）、公開鍵は `tauri.conf.json` の `plugins.updater.pubkey` に埋め込み
- CI: `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` を GitHub Secrets に設定
- Settings タブの About セクションに「更新を確認」ボタン + 「更新して再起動」ボタン
- SideBar 歯車アイコンに更新通知ドット（起動時に `check()` でバックグラウンド確認）
- `bundle.createUpdaterArtifacts: true` で `.sig` ファイルを自動生成

### Agent Runtime（統一エージェント API）
- `src-tauri/src/agent/` に `AgentRuntime` trait を定義。Codex app-server と ACP (Agent Client Protocol) の両方を同一インターフェースで扱う
- `AgentRuntime` trait: `start_session`, `submit_turn`, `interrupt_turn`, `respond_approval`, `auth_status` 等
- `CodexAppServerRuntime`: 既存の `codex/` モジュールを wrap。`codex://` ではなく `agent://` イベントを emit
- `ACPRuntime`: `claude-agent-acp` 等の ACP 対応エージェントと JSON-RPC over stdio で通信
- `AgentEvent` enum: 両プロトコルの通知を統一表現（MessageDelta, ItemStarted, ApprovalCommandRequest 等）
- `AgentCapabilities`: runtime ごとのサポート機能を宣言（モデル選択、ロールバック、sandbox 設定等）
- Tauri commands: `agent_start_session`, `agent_submit_turn` 等 13 個。既存の `codex_*` commands と並行して登録
- フロント: `stores/agent.ts` (Pinia), `composables/useAgentRouter.ts` (event router), `types/agent.ts`
- `AgentChatTab.vue`: `agent-chat` タブ。capabilities に応じて UI を条件分岐（auth bar, sandbox 表示等）
- 既存の `codex-chat` タブ（`CodexChatTab.vue` + `codex` store）は互換性のため維持。新規セッションは `agent-chat` タブを使用

### コミット前チェック
コミット前に以下を実行し、エラー・警告がゼロであることを確認する:

- **Rust**: `cargo clippy -- -D warnings`（`src-tauri/` で実行）
- **Frontend**: `npm run lint`（= `biome check src/`）
- **TypeScript 型検査**: `npx vue-tsc --noEmit`（`tsc` ではなく `vue-tsc` を使うこと — Vue SFC の型チェックに必要）

### コミット & push 運用ルール
個人開発のため PR レビューは原則不要。Claude が変更を加えた場合は以下のフローを厳守:

1. **コミット前に必ずユーザの動作確認 OK を取る** — `cargo clippy` / `biome` / `vue-tsc` が通っていてもコミットしてはいけない。ユーザは GUI 上で実際に挙動を試す必要があるため、Claude が「テスト通った」だけで自動コミットすると確認前に履歴が確定してしまう。「コミットしていい？」と聞くか、ユーザが明示的に「コミットして」と言うまで待つ
2. **`main` ブランチに直接コミット**（feature ブランチや PR は作らない）
3. **`git push` は実行しない** — push の判断はユーザに委ねる（main への直接 push はリポジトリ設定で禁止されているが、ユーザはローカル確認後に自分で push する運用）
4. ユーザから明示的に「PR にして」「ブランチ切って」等の指示があった場合のみ、その指示に従う
5. **リリース時のバージョン bump も同様**: `main` に直接コミット、push はユーザが実行

### CI/CD
- `.github/workflows/ci.yml`: push/PR で `biome check`、`npm run build`（vue-tsc + vite）、`cargo clippy -- -D warnings`、`cargo test` を実行（Windows runner）
- `.github/workflows/release.yml`: タグ push (`v*`) で `tauri-apps/tauri-action@v0` が Windows ビルド → GitHub Releases にドラフトアップロード
- `.github/workflows/security.yml`: push/PR で `cargo audit` + `npm audit`、週次スケジュール実行
- `.github/dependabot.yml`: npm / Cargo / GitHub Actions の依存更新 PR を週次自動作成

### ファイル監視 (File Watcher)
- Windows プロジェクト: `notify` クレート（v7）で `ReadDirectoryChangesW` ベースの再帰監視
- WSL プロジェクト: `wsl.exe inotifywait -m -r` を長寿命サブプロセスとして起動（`inotify-tools` 必要、未インストール時は graceful degrade）
- イベントバッチ処理: 200ms デバウンス + 1s max wait でフロントに送信
- `IGNORED_DIRS` (.git, node_modules 等) をフィルタ
- `fs_changed` イベントで `changedDirs`（ツリー更新用）+ `changedFiles`（エディタ更新用）を送信
- エディタ外部変更検知: clean タブは自動リロード、dirty タブはインライン警告バー（Reload/Overwrite/Dismiss）
- 自己書き込み除外: `markRecentlySaved()` で 2秒 TTL のパス Set を管理
- ウィンドウ破棄時に全 watcher 停止（`watcher::stop_all`）
- Rust `WatcherState` を `AppState` で管理、`fs_watch_start` / `fs_watch_stop` コマンド

### プレビュー拡張
- CSV/TSV: `CsvTab` でテーブル表示、RFC 4180 準拠パーサ（引用符対応）、10,000行 truncate、sticky ヘッダ
- PDF: `PdfTab` で `<iframe src="data:application/pdf;base64,...">` による WebView2 内蔵レンダリング
- Mermaid: `MermaidTab` で `.mermaid`/`.mmd` ファイルを SVG 描画（Preview/Source 切替）
- Markdown 内 mermaid: `EditorTab` の previewHtml 更新時に `code.language-mermaid` ブロックを検出し `mermaid.render()` で SVG に差し替え
- SVG: `EditorTab` の Edit/Split/Preview トグルで SVG 表示（`DOMPurify.sanitize` + `SVG_PURIFY_OPTS`）。`IMAGE_EXTS` から除外し EditorTab で開く
- ファイルツリー `openFile()` が拡張子で csv/tsv/pdf/mermaid/mmd を判定し適切なタブを開く

### 検索 (rg / grep)
- 起動時に `which rg` で backend 判定、以降固定
- rg: `rg --json -F/-e --glob` でパース容易な出力
- grep: `grep -rn --include/--exclude` でフォールバック
- フロントには検索バックエンドをバッジ表示
- 結果クリックでエディタタブを開き、`initialLine` で該当行にジャンプ
- 最大 500 件で truncate、デバウンス 300ms
- rg サイドカーバンドル: `src-tauri/binaries/rg-{target}.exe` を `externalBin` でアプリに同梱
  - Windows プロジェクト: システム rg → バンドル版 rg → grep の順でフォールバック
  - WSL プロジェクト: WSL の rg → WSL の grep（バンドル版は Windows バイナリのため使用不可）
  - `scripts/download-rg.sh` でビルド前にダウンロード（バイナリは .gitignore）
- `list_project_files` コマンド: `rg --files` / `find` でプロジェクト内ファイル一覧取得（QuickOpen 用）

### クイックオープン (Ctrl+P)
- `QuickOpen.vue`: ProjectSwitcher と同じオーバーレイ + モーダル構造
- `rg --files` 結果をフロントでキャッシュ、プロジェクト切替時にリセット
- fzz 風 fuzzy match（ファイル名優先 → パスマッチ）、最近開いたファイルを上位表示
- `filename:42` サフィックスで行番号ジャンプ対応
- `project.showQuickOpen` で表示状態管理

### 設定画面
- サイドバー下部の歯車アイコンからシングルトンタブとして開く
- 設定は `localStorage` (`pike:settings`) に永続化
- ダーク/ライトモード切替: `data-theme` 属性で CSS Variables を切り替え
- ターミナルフォント: `font-kit` クレートでシステムのモノスペースフォントを列挙（`spawn_blocking` で非同期実行）
- フォントスキャンは Settings タブを開いた時に遅延ロード（起動時には実行しない）
- カラースキーム: 6種（Default Dark, Solarized Dark/Light, Monokai, Dracula, Nord）
- フォント・サイズ変更は既存ターミナルにライブ反映、カラースキーム変更は `terminal.refresh()` + PTY resize nudge で TUI 再描画
- 設定タブにターミナルプレビュー表示（選択中のフォント・サイズ・カラースキームを即時反映）
- Editor セクション: ミニマップ ON/OFF、ワードラップ ON/OFF、タブサイズ（2/4/8）。CM6 Compartment でライブ反映
- settings タブはセッション永続化の対象外（`snapshotSession` は terminal/editor のみフィルタ）
- ターミナル終了デスクトップ通知: ON/OFF トグル。Web Notification API 優先、Tauri plugin フォールバック

---

## リリース手順

新しいバージョンをリリースする際は、以下の手順を順番に実行する。

### 1. バージョン番号の更新

3ファイルのバージョンを一致させる（例: `0.2.0`）:

- `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
- `package.json` → `"version": "X.Y.Z"`
- `src-tauri/Cargo.toml` → `version = "X.Y.Z"`

その後 `cd src-tauri && cargo check` を実行して `Cargo.lock` の `pike` エントリを新バージョンに追従させる（実行しないと lockfile drift が発生して後続で別コミットでの同期が必要になる）。

### 2. CHANGELOG.md の更新

`CHANGELOG.md` の先頭に新しいセクションを追加する。

### 3. コミット & プッシュ

```bash
git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
git commit -m "Bump version to vX.Y.Z"
git push origin main
```

**Cargo.lock を含めること**。忘れると作業ツリーに drift が残り、あとから `chore: Cargo.lock を vX.Y.Z に同期` という追加コミットが必要になる（過去に何度も発生）。

### 4. Security Check の確認

GitHub Actions の `Security Check` ワークフローが成功することを確認する。

### 5. タグの作成 & プッシュ

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

タグ push で `Release` ワークフローが自動起動し、Windows ビルド → GitHub Releases にドラフトアップロードされる。

### 6. リリースの公開

ワークフロー完了後、GitHub Releases でドラフトを確認し、リリースノートを記載して公開する:

```bash
gh release edit vX.Y.Z --repo kan/pike --draft=false --notes "$(cat <<'EOF'
## Pike vX.Y.Z

### Changes
- ...

EOF
)"
```

### 注意事項

- `tauri-action` は `tauri.conf.json` の `version` をリリース名・タグ名の `__VERSION__` に埋め込む。**必ずタグを打つ前にバージョンを更新すること**
- `TAURI_SIGNING_PRIVATE_KEY` が GitHub Secrets に設定されていること（署名なしビルドは updater で検証失敗する）
- タグを打ち直す場合: `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z` → 修正後に再タグ

---

@import .claude/rules/rust.md
@import .claude/rules/frontend.md
@import .claude/rules/testing.md
