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
│  │ 📋 tasks   │                                         │
│  │ 🔭 outline │                                         │
│  └────────────┘                                         │
└──────────────┬──────────────────────────────────────────┘
               │ Tauri IPC (invoke / events)
┌──────────────▼──────────────────────────────────────────┐
│  Rust バックエンド                                        │
│  pty_manager   git_manager   fs_watcher   search         │
│  project_store docker_client                             │
└──────────────┬──────────────────────────────────────────┘
               │ wsl.exe spawn / bollard / git CLI / notify
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
├── CLAUDE.md                  # このファイル（AI 開発向け: 構造・規約・技術メモ）
├── README.md                  # ユーザー向け概要・インストール・マニュアルへの導線
├── docs/
│   ├── manual/                # ユーザーマニュアル（日本語・フォルダ分割）
│   │   ├── README.md          # マニュアル索引
│   │   └── *.md               # 機能別ページ（getting-started, editor, git 等）
│   └── *.png                  # README/マニュアル用スクリーンショット
├── plugins/                   # エージェント（Claude Code / Codex）向けスキル・プラグイン（#139）
│   ├── pike-todo/             # Claude Code プラグイン（pike todo CLI スキル）
│   └── codex/pike-todo/       # Codex 用スキル（内容は Claude 版と同一）
├── scripts/
│   └── download-rg.sh         # rg サイドカーバイナリのダウンロード
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs            # Tauri エントリポイント
│       ├── lib.rs             # Tauri Builder 設定・コマンド登録
│       ├── types.rs           # ShellConfig・WSL_EXTRA_PATH・bash_quote 等の共通型/ヘルパー
│       ├── font.rs            # フォント列挙（font-kit でモノスペース検出）
│       ├── cli.rs             # CLI 引数パース・CliState・single-instance 連携
│       ├── todo_cli.rs        # `pike todo` サブコマンド（.pike/todo.md 直接操作、#139）
│       ├── wait.rs            # `pike --wait`（GIT_EDITOR 連携）・WM_COPYDATA 待機管理
│       ├── agent/
│       │   ├── mod.rs         # 統一エージェント API モジュール
│       │   ├── types.rs       # AgentRuntime trait・AgentEvent・AgentCapabilities
│       │   ├── commands.rs    # agent_* Tauri コマンド
│       │   ├── state.rs       # ウィンドウ別セッション管理
│       │   ├── codex_runtime.rs  # Codex app-server → AgentRuntime 実装
│       │   └── acp_runtime.rs    # ACP JSON-RPC → AgentRuntime 実装
│       ├── codex/             # Codex app-server プロトコル実装（agent/codex_runtime が wrap）
│       │   ├── mod.rs  auth.rs  approval.rs  runtime.rs  session.rs
│       │   └── protocol/      # client.rs / items.rs / messages.rs / mod.rs
│       ├── claude_usage/
│       │   └── mod.rs         # Claude Code のトークン使用量集計（~/.claude ログ解析）
│       ├── pty/
│       │   └── mod.rs         # PTY 管理（WSL/cmd/PowerShell/Git Bash 対応）
│       ├── watcher/
│       │   └── mod.rs         # ファイル監視（notify + WSL inotifywait）
│       ├── project/
│       │   └── mod.rs         # プロジェクト CRUD・WSL ディストロ検出・グループ永続化
│       ├── fs/
│       │   └── mod.rs         # WSL/Windows 両対応ファイル操作・IGNORED_DIRS
│       ├── git/
│       │   └── mod.rs         # git CLI ブリッジ（status/log/diff/commit/push/pull 等）
│       ├── docker/
│       │   └── mod.rs         # bollard クライアント・compose パース・ログストリーム
│       ├── search/
│       │   └── mod.rs         # rg/grep バックエンド判定・検索・list_project_files
│       ├── tasks.rs           # package.json/Makefile/deno.json のタスク再帰検出
│       └── bin/               # 検証バイナリ（verify_pty / verify_tmux / verify_bollard）
├── src/                       # Vue/TypeScript フロント
│   ├── App.vue                # ルート（PTY ルーター初期化・プロジェクト復元）
│   ├── main.ts
│   ├── i18n/                  # 国際化（日英）: index.ts（useI18n/locale）+ en.ts / ja.ts
│   ├── types/
│   │   ├── tab.ts             # Tab Union type・ShellType・SidebarPanel・共通ヘルパー
│   │   ├── project.ts         # ProjectConfig・PinnedTabDef
│   │   ├── agent.ts           # AgentEvent・AgentCapabilities・AgentAuthState
│   │   ├── chat.ts  claudeUsage.ts  docker.ts  git.ts  search.ts  tasks.ts
│   ├── components/
│   │   ├── ProjectSwitcher.vue  # fzf 風プロジェクト切替 + 新規作成モーダル
│   │   ├── QuickOpen.vue        # Ctrl+P コマンドパレット（ファイル/>タスク/@タブ/:行/!ブランチ/?ヘルプ）
│   │   ├── ConfirmDialog.vue    # カスタム確認ダイアログ（Teleport、prompt 入力対応）
│   │   ├── KeyboardShortcuts.vue # ショートカット一覧モーダル
│   │   ├── layout/
│   │   │   ├── SideBar.vue    # アイコンナビ + パネル
│   │   │   ├── TabPane.vue    # タブバー + コンテンツ + シェル選択
│   │   │   └── StatusBar.vue  # ブランチ/worktree セレクタ/ahead-behind/トークン使用量/エンコード/改行/repo リンク
│   │   ├── panels/
│   │   │   ├── FileTreePanel.vue  # ファイルツリー
│   │   │   ├── ProjectPanel.vue   # プロジェクト一覧・登録・編集・削除（GroupComboBox/ProjectListItem に分割）
│   │   │   ├── GroupComboBox.vue  ProjectListItem.vue
│   │   │   ├── GitPanel.vue  SearchPanel.vue  DockerPanel.vue  TasksPanel.vue
│   │   │   ├── OutlinePanel.vue   # シンボルアウトライン
│   │   │   └── outline/           # OutlineTreeView.vue / OutlineHistoryView.vue
│   │   ├── agent/
│   │   │   └── AgentApprovalDialog.vue  # 統一 approval ダイアログ
│   │   └── tabs/
│   │       ├── TerminalTab.vue    # xterm.js + PTY（autoStart 対応）
│   │       ├── AgentChatTab.vue   # 統一エージェントチャット（Codex / Claude Code）
│   │       ├── EditorTab.vue      # CodeMirror 6 + Edit/Split/Preview（md/csv/json/svg/mermaid）
│   │       ├── PreviewTab.vue     # 画像ビューワ（ズーム/回転/反転/パン/fit、表示専用）
│   │       ├── PdfTab.vue         # PDF プレビュー（iframe）
│   │       ├── DiffTab.vue        # 左右分割 diff
│   │       ├── HistoryTab.vue     # ファイル別 git log（git log -L 行範囲対応）
│   │       ├── DockerLogsTab.vue  # コンテナログ（xterm 読み取り専用）
│   │       └── SettingsTab.vue    # 設定画面（フォント・カラースキーム・ダーク・エディタ・言語）
│   ├── stores/
│   │   ├── tabs.ts            # タブ状態管理 (Pinia)
│   │   ├── sidebar.ts  settings.ts  project.ts  agent.ts
│   │   ├── fileTree.ts  git.ts  search.ts  docker.ts  tasks.ts  worktree.ts
│   │   ├── claudeUsage.ts     # トークン使用量
│   │   └── statusMessage.ts   # StatusBar 汎用メッセージ（jumpTo 進捗等）
│   ├── composables/
│   │   ├── useKeyboardShortcuts.ts  useShortcutsModal.ts
│   │   ├── useConfirmDialog.ts  usePtyRouter.ts  useFsWatcher.ts  useCliOpen.ts
│   │   ├── useAgentRouter.ts  useDockerLogRouter.ts  useTerminalNotifications.ts
│   │   ├── useDragAndDrop.ts  useEditorInfo.ts  useImagePaste.ts
│   │   ├── useOutlineSource.ts  useUpdater.ts  useTerminalInject.ts
│   ├── lib/
│   │   ├── fileIcons.ts  fontDetection.ts  tauri.ts  window.ts  paths.ts  storage.ts  format.ts  notify.ts
│   │   ├── gitGraph.ts  gitRemote.ts  diffParser.ts  languages.ts  mermaid.ts  codexHistory.ts  terminalLinks.ts
│   │   ├── editorGitGutter.ts  editorMinimap.ts  editorThemes.ts  editorSearch.ts  editorJumpTo.ts
│   │   ├── jumpTo/            # 定義ジャンプ（findInFile/parseImports/resolveImport/vueComponent）
│   │   └── outline/           # アウトライン抽出（index.ts + extractors/ 18 言語）
│   └── assets/
│       └── theme.css          # CSS Variables テーマ定義（ダーク/ライト）
└── .claude/
    └── rules/
        ├── rust.md            # Rust 実装ルール
        ├── frontend.md        # フロント実装ルール
        └── testing.md         # テスト方針
```

---

## 開発の進め方

マイルストーン駆動の初期開発フェーズ（M1〜M14）は完了済み。現在は **GitHub Issue 駆動**で機能追加・修正を行う運用。作業前に対象 Issue を確認すること。

ドキュメントの役割分担を守ること:

- **README.md** … ユーザー向け（概要・インストール・主な機能・マニュアルへの導線）。AI 開発の内部情報は書かない。
- **docs/manual/** … ユーザーマニュアル（日本語）。使い方・操作手順はここに集約し、拡充する。
- **CLAUDE.md（本ファイル）** … AI 開発のための情報（構造・技術メモ・規約）。ユーザー向けの使い方は書かない。

### ドキュメント校正ルール

**CLAUDE.md を除くドキュメント（README.md・`docs/manual/` 配下）を更新・追加したら、コミット前に必ず校正する。**（CLAUDE.md 自身は密な技術仕様なので対象外）

1. **textlint（機械チェック）** を npx で実行し、ai-writing 系の指摘を 0 にする:

   ```bash
   npx --yes --package textlint \
     --package textlint-rule-preset-ai-writing \
     --package textlint-rule-preset-ja-technical-writing \
     -- textlint --rule preset-ai-writing --rule preset-ja-technical-writing \
     README.md docs/manual/*.md
   ```
   （リポジトリに textlint は未導入。実行は npx で都度行う）

2. **`japanese-tech-writing` スキル**（判断ベース）で、textlint が拾えない空句・冗長・演出・論証を点検する。

3. **守る表記規約**（textlint とスキル整形の両立で確立済み）:
   - 箇条書きの太字ラベルの区切りは**全角コロン**で `**用語**：説明` と書く。半角コロン `:` は `no-ai-list-formatting` に触れるため使わない。
   - 地の文・見出しで **em ダッシュ `—` を使わない**（全角コロンか句読点にする）。
   - 誇張語（「大幅に」等）・LLM 空句（「重要なのは」「正面から」「多角的」等）を使わない。
   - 二重助詞・一文内の過多カンマ（4 個以上）を避ける。

4. **据え置いてよい指摘**: `no-mix-dearu-desumasu`（本文の「です・ます」と箇条書き・表セルの体言止めの混在）と、列挙が主因の `sentence-length`。マニュアルとして自然なので無理に潰さない。

5. **見出しを変更したら、ページ内アンカー（`](#...)`）との整合を確認する**。Pike のプレビューは見出しテキストを「小文字化＋`[^\p{L}\p{N}_\s-]` 除去＋空白→ハイフン」で slug 化して `id` を振る（`src/lib/slug.ts`）。アンカーはこの slug 規則に一致させる。

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

### ターミナルの coding agent 補助（#89）
`claude` 等をターミナルで使う運用を、Pike の既存機能（エディタ / 診断）と橋渡しする一連の機能。注入はすべて `ptyWrite` 経由。

- **起動ボタン**: ターミナル右上のフローティング split ボタン（`TerminalTab.vue`）。主＝先頭コマンド / ▾＝一覧。クリックで `agentCommands`（`pike:settings`）を**シェル対応の clear プレフィックス付き**（cmd=`cls`、PowerShell=`clear; `、bash=`clear && `）で注入＋Enter。`buildAutoStartLine` のロジックを流用。代替画面（alternate screen）検出で vim/less 等の全画面 TUI 中は非表示
- **定型プロンプト挿入ボタン**: 起動ボタンの隣の2つ目のドロップダウン。`agentPrompts`（`{ label, text }[]`、`pike:settings`）を**ブラケットペースト（`ESC[200~…ESC[201~`）で挿入のみ・Enter なし**（複数行も1入力として届き途中確定しない）。2つのメニューは相互排他、alt-screen 中は非表示。挿入の primitive は `lib/tauri.ts` の `ptyPasteText`
- **出力の `file:line` クリックでエディタを開く**: `lib/terminalLinks.ts` の `findPathLinks`（インライン `path:line(:col)` 検出。拡張子必須で誤検出抑制、Windows ドライブ・URL 除外）＋ rg/grep の heading 出力対応（マッチ行の行番号 → 直近のファイル名見出しを辿る）。`TerminalTab.vue` が xterm の link provider として登録（ワイド文字対応の char→セル列マップで範囲を正確化）。相対パスは `activeRoot` 起点で解決し `addEditorTab({ path, initialLine })`
- **エディタ選択範囲・診断をターミナルへ注入**: `composables/useTerminalInject.ts` の `injectToTerminal(text)` が注入先ターミナルを解決（**`lastTerminalId`（直近アクティブなターミナル）→ アクティブタブ → pinned → 任意**）し `ptyPasteText` で挿入、当該タブをアクティブ化。注入先が無ければ statusMessage で通知。`stores/tabs.ts` の `lastTerminalId` は `activeTabId` watcher で更新（タブ閉じは use 時の liveness 再チェックで自己修復）
  - EditorTab: 右クリック「ターミナルに送る」（選択時のみ）→ `relpath:行` 参照 + 選択本文を注入
  - DiagnosticsPanel: 各行ホバーの 🤖 ボタン → `t('diagnostics.fixPrompt')`（i18n、UI 言語追従）で修正依頼文を注入
- **設定**: `agentCommands` / `agentPrompts` は Settings の Terminal セクションで追加/編集/削除/並べ替え。両方とも `pike:settings` の配列で deep-watch 永続化

### プロジェクト管理
- プロジェクト設定は `%APPDATA%/com.tauri.dev/projects/{id}/project.json` に保存
- 開いている全プロジェクト ID を `last_project.txt` に永続化し、起動時に全ウィンドウを自動復元
- プロジェクトは WSL / Windows の2プラットフォームに対応
- WSL プロジェクト: ディストロ指定、ルートは WSL パス
- Windows プロジェクト: デフォルトシェル（cmd/PowerShell/Git Bash）選択、ルートは Windows パス
- プロジェクト切替時: 全タブ kill → pinnedTabs 復元（なければ Claude Code 固定タブを自動作成）
- Windows プロジェクトでは「+」ボタン横のドロップダウンでデフォルト以外のシェルも選択可能
- プロジェクトのグループ分け: `ProjectConfig.group?: string` で各プロジェクトの所属グループを保持。グループ一覧と表示順は `%APPDATA%/com.tauri.dev/groups.json` に明示的に永続化（プロジェクト未割当の空グループも保持可能）。`project_groups_list` / `project_groups_save` コマンドで CRUD
- ProjectPanel UI: 未分類プロジェクトはリスト直下にフラット表示（ヘッダーなし）、グループ所属はグループバー配下に折りたたみ可能で配置。「+ グループを追加」ボタンで空グループを作成、グループバーの鉛筆で一括リネーム（所属プロジェクトの `group` も更新）、✕ で削除（所属プロジェクトは ungroup）
- プロジェクトの編集フォームではコンボボックス形式: `<select>` で「グループなし / 既存グループ / + 新規グループ...」、新規選択で text input に切替
- ドラッグ&ドロップ: プロジェクト項目をグループバーにドロップすると `setProjectGroup` で所属を変更
- 折りたたみ状態は `localStorage` (`pike:project-group-collapsed`) に永続化
- プロジェクトカラー（#121）: `ProjectConfig.color?: string` は**プリセット名**（'red' 等）を保存し、hex は描画時に `lib/projectColors.ts` の `projectColorValue` で解決（パレット調整が config 移行なしで効く。手編集の生 hex `#rrggbb` のみ許容し、`url()` 等の任意 CSS 値は style バインドに到達しない）。プリセット 8 色は musql と同一パレット、name が i18n キー `projectColor.{name}` を兼ねる。選択 UI は `panels/ColorSelect.vue`（スウォッチ付きカスタムドロップダウン。close は他メニューと同じ「open 時に window mousedown を once で張る + ルートで `@mousedown.stop`」方式）で、ProjectPanel の作成・編集フォームと ProjectSwitcher の新規作成モーダルに配置。表示はカラードット共通コンポーネント `ColorDot.vue`（ProjectPanel 一覧・ProjectSwitcher）と、**App.vue のウィンドウ左端 3px 縦アクセントライン**（absolute overlay、`pointer-events: none`。サイドバー内だと折りたたみ時に見えないため window レベル。上端の横ラインは悪目立ちするため左端に変更）。**クロスウィンドウ同期**: `project_update` が書き込み後に `project_updated`（`{ sourceLabel, config }`）を全ウィンドウへ emit、各ウィンドウは自ラベルを除外して `applyExternalUpdate` で in-memory コピー（projects 配列 + currentProject、lastSession はウィンドウローカル保持）を更新。これが無いと flushSession / switchProject の全量書き戻しが他ウィンドウの編集を古いデータで消す（lost update）

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
- 画像ビューワタブ（base64 経由、ズーム/回転/反転/パン/fit の表示専用操作）、Markdown プレビュー（Edit/Split/Preview 3モード、スクロール同期、250ms デバウンス）
- Markdown プレビュー内リンク: 外部 URL は confirm 付きで `open_url` 経由の外部ブラウザ起動、ローカルファイルはプロジェクトルート内に限定して EditorTab で開く（`resolveLocalPath` でディレクトリトラバーサル防止 + `decodeURIComponent` 対応）
- 文字コード対応: `encoding_rs` で自動検出 + 指定エンコードでの開き直し/保存（StatusBar 2段階 UI）
- 改行コード LF/CRLF 切替（StatusBar クリック）、保存時に適用
- ファイルツリーコンテキストメニュー: リネーム（インライン入力）、削除（カスタム confirm ダイアログ）、Git History（専用タブ）、フォルダ限定「エクスプローラーで開く」（`fs_open_in_explorer`。WSL は `\\wsl.localhost\{distro}` UNC に変換して explorer.exe 起動）
- ドラッグ&ドロップ移動 + Ctrl でコピー（`dragDropEnabled: false` で Tauri ネイティブ D&D を無効化）
- ダーティエディタタブの閉じ確認ダイアログ（カスタム confirm）
- WSL コマンドにパス引数前の `--` を付与（フラグ injection 防止）
- 外部 URL オープン: `open_url` コマンドは http/https のみ許可（Rust 側でバリデーション）。`explorer.exe` 経由で開く（`cmd.exe /C start` はシェルメタ文字インジェクションの危険があるため不使用）。フロント側でも confirm ダイアログを表示

### Git 統合
- `git` CLI 経由（WSL/Windows 両対応）。`git2` クレートは使わない
- Rust 側 `build_git_command` が ShellConfig に応じて `wsl.exe git` / `git` を組み立て
- ステータスバーにブランチ名+ダーティ表示、クリックでブランチ切替
- Git パネル: ステージング/アンステージ、コミット、push/pull/refresh、コミットツリー展開
- 非 git リポジトリ対応（#156）: `git status` がエラーの時、`git_is_repo`（`git rev-parse --is-inside-work-tree`、非 repo でも Err にせず `false` を返す）で「リポジトリじゃない」を切り分け、`gitStore.isRepo=false` にして生の git エラーを出さない。GitPanel は専用ビュー（メッセージ + 「リポジトリを初期化」ボタン → `git_init`）を表示（VSCode 風）。init 後は status/log/remote を再読込
- コンフリクト（unmerged）表示: `parse_status` が porcelain v2 の `u ` 行をパースし `GitStatusResult.conflicted`（status は XY コード `UU`/`AA` 等）に格納。GitPanel 最上部の専用「Conflicts」セクションでパスを赤字（`--danger`）表示、クリックで作業ツリーのファイルをエディタで開く（解消ツールは未実装）。SideBar の Git バッジ件数に conflicted を加算し、コンフリクト時は danger（赤）バッジ。エディタは `lib/editorConflict.ts`（CodeMirror ViewPlugin）でマーカー行（`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`）と各セクション本文を色分けハイライト（半透明オーバーレイで両テーマ対応、表示のみ）
- diff タブ: 左右分割表示、文字単位ハイライト（common prefix/suffix 方式）
- ahead/behind: `git status --porcelain=v2 --branch` の `# branch.ab` 行をパース。GitPanel コミットボタン下にテキスト表示、SideBar の pull/push ボタンを primary スタイルに変更
- コミットログは `%B`（全文）取得、一覧は1行目のみ表示、ホバーで全文ツールチップ
- ブランチマージグラフ: `git log --all` + `%P`（親ハッシュ）/`%D`（refs）で取得、`gitGraph.ts` のレーン割当アルゴリズムで SVG 描画。List / Graph 切替
- git log フォーマット区切り: ASCII Unit Separator (`%x1f`) + Record Separator (`%x1e`) を使用（NUL だと `%D` が空のコミットでレコード区切りと衝突するため）

### Git worktree 連動
- `git_worktree_list` コマンド（`git worktree list --porcelain` をパース）が `{ path, branch, head, isBare, isDetached, isMain }[]` を返す。bare クローン構成では bare エントリを main 扱いせず**最初の非 bare** を `isMain` とし、`prunable`（ディレクトリ消失）worktree は一覧から除外
- **参照ルートの単一の真実**: `stores/project.ts` の `activeRoot`（非 null computed = `activeWorktreeRoot ?? currentProject.root ?? ''`）。file tree / git / search / tasks / docker、およびエディタの git 操作（diff ガター・History・定義ジャンプ・MD リンク解決）はすべて `project.root` ではなく `activeRoot` を参照する。root 相対操作で残る `project.root` 直参照は worktree 追従漏れのサイン（ターミナル cwd / agent cwd / 画像アップロード先など意図的にプロジェクト固定の箇所を除く）
- `stores/worktree.ts`: worktree 一覧・`setActiveWorktree(w)`（`isMain` フラグで null/パスを決定。文字列一致に依存しない）・focus 連動ポーリング（`gitStore.status` が非 null の git リポジトリのみ。同一ウィンドウ内ターミナルでの `git worktree add` を反映、古い load 結果は projectId で stale ガード）
- ステータスバーの worktree セレクタ（`FolderGit2`、worktree が 2 つ以上の時のみ表示）。選択で 5 パネル + エディタを再読込
- fs watcher は App.vue の `watch(activeRoot)` 単一所有で再ポイント（worktree 切替・プロジェクト切替の両方をカバー。リポジトリ外の worktree でも更新を取得）
- 切替単位はウィンドウ（プロジェクト）ごとに 1 つ。起動時は常に main worktree（`activeWorktreeRoot=null`）から開始、セッション非永続。タブ切替による自動追従は未実装（agent を root で起動し内部で worktree を選ぶ運用では cwd ベース検出が効かないため手動セレクタを主軸とする。将来 agent タブ常用時に再検討）

### Docker 統合
- `bollard` クレートで Docker API に接続（named pipe → TCP:2375 → TCP:2376 フォールバック）
- クライアントは `OnceCell` でキャッシュし、毎コマンドの再接続を回避
- compose.yml を `serde_yaml` でパースしてサービス一覧表示
- コンテナ状態を compose ラベル（`com.docker.compose.service`）でサービスにマッチ
- start / stop / restart / refresh を UI から実行、5秒ポーリングで状態更新
- compose up / down（#157）: SideBar の docker パネルヘッダー（Play / Square、compose サービス検出時のみ表示）→ confirm 後に `docker compose up -d` / `docker compose down` をターミナルタブで実行（`dockerStore.composeUp/composeDown`、cwd=activeRoot・closeOnExit。タスク実行と同じパターン）
- ログストリーミングは 50ms バッファリング + Tauri イベント emit
- DockerLogsTab は xterm.js ベース（読み取り専用、`convertEol: true`）
- `docker exec` シェル: bollard exec API でコンテナ内シェルを検出（bash → sh フォールバック）、プロジェクトのシェル内で `docker exec -it` を autoStart 実行
- ポートフォワード（#120）: `docker/tunnel.rs`。未公開ポートへ `alpine/socat` 一時コンテナ（`auto_remove` + `pike.tunnel*` ラベル、対象と同一ネットワーク優先=非 bridge）で `127.0.0.1` から転送。**owner ラベル**（`pike.tunnel.owner`=アプリ identifier、setup で `DockerState.instance_id` に設定）でインスタンススコープ化し、共存する installed/dev が互いのトンネルを掃除しない。**ローカルポートはデーモン割当**（`host_port=""` → start 後 inspect で取得。ホスト側プローブは TOCTOU と WSL2 名前空間不一致があるため不使用）。**接続先はカスタムネットワークならコンテナ名**（Docker 内蔵 DNS。restart/recreate の IP 変化に追従）、bridge のみ IP。start 失敗時は手動ロールバック削除（auto_remove は start 前に効かない）。作成後に TCP 接続プローブで readiness 確認（best-effort ~1s）。トンネル一覧は `docker_list_containers` が 1 回の list を `{ containers, tunnels }`（`ContainerListResult`）に分配して返す（running + 自 owner のみ。専用 list コマンドなし、ポーリングの API 往復も 1 回）。掃除は初回 Docker 接続時（自 owner のクラッシュ残骸をラベル sweep、`join_all` 並列）と `RunEvent::Exit`（このセッションで作成した場合のみ=`tunnels_created` フラグ、3 秒 timeout 付き `block_on`。Exit コールバックは Tauri の teardown 前に走りランタイムは生存）。停止は remove 失敗を伝搬（auto_remove 競合で消滅済みなら成功扱い）。ポート候補は inspect の `exposed_ports`（EXPOSE / compose expose 由来、`/tcp` のみ）。UI は DockerPanel 実行中サービス行の Cable ボタン → `promptDialog` でポート入力 → サービス行直下にトンネル行（`open_url` で開く / 停止）。対象コンテナが消えた/再作成されたトンネルは「その他のフォワード」セクションに表示して停止可能にする。作成中ガードは `tunnelBusy: string[]`（コンテナ別）

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
- **特定ウィンドウ宛てイベントの受信は `getCurrentWindow().listen()` を使う**（`@tauri-apps/api/event` の素の `listen()` は使わない）: Rust が `app.emit_to(label, …)` で 1 ウィンドウに送っても、素の `listen()` はデフォルト target が `Any` のため**全ウィンドウで発火**する。`cli_open` のようにルーティング済みの宛先ウィンドウだけで処理したいイベントは、必ず `getCurrentWindow().listen()`（target = 自ラベル）で受ける（過去に `useCliOpen` が素の `listen()` を使い、外部ファイルを開くと全ウィンドウが開こうとしてエラーになった）。全ブロードキャスト＋ID フィルタ方式（PTY/Docker）とは使い分ける
- 全ウィンドウ（main + 子）が `last_project.txt` に自身のプロジェクト ID を登録し、起動時に復元
- **main ウィンドウ close → トレイに常駐（#161、後述「システムトレイ」）**。main は破棄せず hide し、アプリは終了しない。実際の終了はトレイの「終了」（`app.exit`）のみ。子ウィンドウを全部閉じても hidden main が残るためアプリは常駐し続ける（旧: main close＝アプリ終了・`app-should-exit` 自動終了は廃止）
- 子ウィンドウ close → `beforeunload` で session 保存 + PTY kill（ベストエフォート）

### 開発ビルド
- `npm run tauri:dev` で開発版を起動（`tauri.dev.conf.json` で identifier を `com.pike.dev.debug` に上書き）
- インストール版 Pike (`com.pike.dev`) と開発版 (`com.pike.dev.debug`) は single-instance が別扱いになるため共存可能
- `import.meta.env.DEV` が true の場合、ウィンドウタイトルに `[DEBUG]` プレフィックスを付与
- `npm run tauri dev` は identifier が本番と同一のため、インストール版と競合する点に注意

### CSP と動的スタイル注入（本番ビルド限定の落とし穴、#v0.26.3）
`tauri.conf.json` の `app.security.csp` を設定すると、**本番（埋め込み）ビルドでのみ** Tauri が `style-src` / `script-src` に nonce/hash を注入する（`tauri` クレートの `manager::set_csp` → `replace_csp_nonce`）。CSP 仕様上、**nonce か hash が directive に 1 つでも入ると同 directive の `'unsafe-inline'` は無視される**。

- **症状**: xterm（ターミナルの色・フォント）と CodeMirror（style-mod で実行時に `<style>` を注入。エディタ本文・シンタックス色）が実行時注入するスタイルが全滅する。ターミナルは色/フォント崩れ、エディタは本文が消えて**行番号ガターだけ**残る。**dev（`tauri:dev`）は Vite 配信で nonce/hash 注入が走らないため再現しない**＝「本番ビルドだけ崩れる」形になる
- **対策**: `app.security.dangerousDisableAssetCspModification: ["style-src"]` を設定し、**style-src への nonce/hash 注入だけを止めて `'unsafe-inline'` を有効に保つ**（CodeMirror/xterm 等の CSS-in-JS 系ライブラリ向けの Tauri 標準の対処）。`script-src`（XSS 対策の要）の nonce/hash 注入は維持する。config の型は `DisabledCspModificationKind`（`bool` または directive 名の配列）、キーは `deny_unknown_fields` なので誤字はビルドエラーになる
- **切り分けの注意**: この不具合は dev で再現しないため、原因調査は**本番ビルドで**行う必要がある。加えて、同一 identifier（`com.pike.dev`）のインストール版が起動中だと single-instance で新ビルドの起動が既存インスタンスに転送され、**古い壊れた画面を検証してしまう**。切り分け時は `--config tauri.dev.conf.json`（identifier を `com.pike.dev.debug` に）を付けて `tauri build` し、併存起動できる別 identifier ビルドで確認するのが確実。埋め込み後の実 HTML/CSP は `target/release/build/pike-*/out/tauri-codegen-assets/*.html`（brotli 圧縮、`zlib.brotliDecompressSync` で復元可）で確認できる
- **`index.html` にインライン `<style>` を置かない**のが安全側（Tauri がその hash を style-src に足して同じ問題を誘発しうる）。基本レイアウトは `src/assets/theme.css`（`main.ts` 先頭 import でバンドル CSS の `<link>` になり render-blocking＝FOUC も起きない）に置く

### ウィンドウ背景透過（#162）
設定「外観」の 不透明 / 透過 / アクリル と不透明度スライダーで、ウィンドウ背景を半透明にする。Rust は window-vibrancy で実行時にアクリルを apply/clear（`window_set_backdrop`）、ウィンドウは常に transparent 生成。

- **合成の仕組み**: `theme.css` の背景変数は `rgb(<成分> / var(--surface-alpha))` で合成する。`--surface-alpha` は App.vue が backdrop 設定から算出して `documentElement` に書き込む 1 変数で、これだけで全サーフェスが一括で半透明になる。基盤レイヤーは `#app` の 1 枚だけ（html/body/#app で重ね塗りすると不透明度が掛け算になる）
- **浮遊サーフェスは不透明**: コンテキストメニュー・ドロップダウン・ダイアログ・ツールチップは透けると読み辛いので `.popup-surface` クラスをルート要素に付ける。**新しいポップアップを追加したら必ず付けること**（付け忘れは backdrop を有効にしたときだけ再現するので、既定の不透明モードでは気付けない）
- **なぜクラスで `--bg-*` を再宣言するのか**: カスタムプロパティの `var()` は**宣言した要素**（`:root`）で置換が確定し、子孫は合成済みの色を継承する。よって子孫で `--surface-alpha` だけ上書きしても効かない。`.popup-surface` はポップアップが実際に塗る 4 変数（`--bg-primary/secondary/tertiary`・`--tab-hover-bg`）を再宣言して、置換をその要素で起こす。背景変数を増やすときは `*-rgb` 側とこのブロックの同期に注意
- **ポップアップの色味**: 素のテーマ色だとアクリル上で黒浮きするため、`--popup-lift-color`（dark=白 / light=黒）を `--popup-lift`（= `(1 - --surface-alpha) × 10%`）だけ `color-mix` で混ぜ、周囲が背景の透けで持ち上がったぶんを不透明色で模倣する。係数 10 は目視調整値
- ターミナルは xterm 背景を透明にしラッパー 1 層でティント（`xtermTheme`）、エディタは CodeMirror の透過 Compartment で背景を透明化する

### E2E スクリーンショット自動化（#142）
マニュアル画像（`docs/manual/img/`）の自動再撮影パイプライン。詳細・設計の正本は `e2e/README.md`。

1. `npm run e2e:build`: 撮影用バイナリをビルド（`PIKE_E2E=1` + `--features e2e` + `tauri.e2e.conf.json`。identifier=`com.pike.e2e` で既存 Pike / dev 版と single-instance 衝突しない）
2. `npm run e2e`: wdio 実行。`e2e/specs/*.ts` が ja/en × light/dark の 4 バリアントで `artifacts/screenshots/{画面}-{lang}-{theme}.png` に撮影（`artifacts/` は gitignore）。ウィンドウ寸法は 2 クラス: クローズアップ＝既定 1280×832（内枠 1259×777）、全体レイアウト系（layout.ts の `FULL`）＝1600×1000（内枠 1578×945）
3. `scripts/sync-manual-images.sh --check` でドライラン → 引数なしで `docs/manual/img/` へ同期。スクリプト内 `MAP` が「マニュアル名 ← E2E ベース名」を対応付け、ja の dark（`{名前}.png`）+ light（`{名前}-light.png`）の 2 枚を持つ（GitHub の `<picture>` 切替用）
4. 変更画像を目視確認してコミット

- 外枠付きヒーロー画像（README / overview の `screenshot-*`）は `scripts/frame-screenshot.sh` で別途生成（sync の MAP 対象外）
- 撮影画面を追加したら `e2e/specs/` に追記し、マニュアルで使う場合は `sync-manual-images.sh` の MAP にも対応を追加
- 撮影コードを本番ビルドに混入させない仕組み（`e2e` Cargo feature / vite define `__PIKE_E2E__` / `capabilities-runtime` の実行時登録）は `e2e/README.md` を参照

### pike CLI
- バイナリ名 `pike.exe`（`Cargo.toml` `[[bin]] name = "pike"`）
- `tauri-plugin-single-instance` で二重起動を防止、引数を既存インスタンスに転送
- `pike file.rs:42` → ファイルを開いてジャンプ、`pike open <file>` も同様。**複数ファイル引数対応**（`CliAction::OpenFiles { files: Vec<CliFileTarget{path,line,distro}> }`、pike.exe へのドラッグ&ドロップ / エクスプローラー「プログラムから開く」経由）
- `pike .` / `pike <dir>` → ディレクトリに一致するプロジェクトに切替（ディレクトリは**先頭引数のみ**有効）
- マッチしない場合は ad-hoc プロジェクトを自動作成（PowerShell）
- ファイル引数のルーティング: `--from-window` 発ウィンドウ → **全ファイルを含む**プロジェクトウィンドウ → グローバルウィンドウの順（`CliState.pending` でアクションを転送）
- 既存エディタタブがある場合はフォーカス＋リロード（`reloadRequested` タイムスタンプ）
- **NSIS インストーラフック**（`src-tauri/nsis/hooks.nsi`、`tauri.conf.json` の `bundle.windows.nsis.installerHooks`）: POSTINSTALL でユーザー PATH に `$INSTDIR` を冪等追加（#146。REG_EXPAND_SZ 維持・updater の再インストールでも重複しない）と、**エクスプローラー「プログラムから開く」候補登録**（`SHCTX\Software\Classes\Applications\pike.exe` に `FriendlyAppName` + `shell\open\command`。SupportedTypes 非設定 = 全拡張子の「別のアプリを選択」一覧に出る。既定の関連付けは変更しない）。PREUNINSTALL で両方を削除。MSI インストーラにはこのフックは無い（NSIS 推奨の理由の 1 つ）

### Windows ジャンプリスト（タスクバー右クリック、#160）
- タスクバーのピン留め / 実行中ボタンを右クリックしたときのメニュー（ジャンプリスト）に独自項目を差し込む。`src-tauri/src/jumplist/mod.rs`（Windows 専用、`ICustomDestinationList` COM API）
- 構成: (1) Tasks カテゴリ「新しいターミナルウィンドウ」→ `pike.exe --terminal`（グローバルターミナル窓、作業ディレクトリ=`%USERPROFILE%`）、(2) 独自カテゴリ「プロジェクト」→ 登録プロジェクトを **`last_opened` 降順**で最大 `MAX_PROJECTS`=10 件。選ぶと `pike.exe <root>`（single-instance の `OpenDirectory` ルーティングを再利用＝既存ウィンドウならフォーカス、無ければ新規＋セッション復元）、(3) `AppendKnownCategory(KDC_RECENT)` で既定の「最近開いたファイル」を復元（カスタムリストを構築すると明示追加しない限り消えるため）
- **WSL プロジェクトのパス引数**: root がネイティブパス（`/home/...`）なので、CLI で解釈できる UNC 形 `\\wsl.localhost\<distro>\...`（`open_arg_for`）に変換して渡す。`cli::resolve_path_arg` が native へ戻して `OpenDirectory` のマッチに使う（WSL 停止中は canonicalize 失敗で file 扱いに劣化するが実害小）
- **タイトルは VT_LPWSTR**: `IPropertyStore` の `PKEY_Title` に手組み PROPVARIANT（`CoTaskMemAlloc` した文字列、Drop の `PropVariantClear` が解放）を入れる。crate の `From<&str>` は **VT_BSTR** になりジャンプリストのタイトルとして表示されないため
- **COM スレッド**: shell オブジェクトは STA。フロントのコマンド（tokio スレッド）では COM 未初期化なので `AppHandle::run_on_main_thread` で main（wry が STA 初期化済み）に載せて構築。そこでは `CoInitializeEx` が S_FALSE を返すので `CoUninitialize` は呼ばない
- **AppUserModelID**: 明示設定せず exe パス由来の暗黙 ID に載せる（インストーラのショートカット・実行プロセス・カスタムリストが同一 ID になり整合。dev ビルドと本番は exe パスが違うので自然に分離）
- **更新契機**: `stores/project.ts` の **`watch`（`projects` の id/name/root/lastOpened ＋ `locale` だけをキー化）** → `menusRefresh(locale)` コマンド（jump list と tray を 1 コマンドで更新。Rust 側でプロジェクト一覧を 1 回だけ読んで両者に渡す＝二重ディスク読み回避）。起動時のロード・プロジェクト追加/削除/編集・切替（recency）・UI 言語切替を 1 箇所でカバーする。**session flush（`lastSession` 書き換え）は同一オブジェクトを触るが、Vue のプロパティ単位トラッキングでキーのゲッターが再評価されず発火しない**（`currentProject` は `projects` の要素と同一参照なので naive な deep watch だと flush ごとに発火してしまう点に注意）。加えて Rust 側が **署名（exe＋lang＋各項目の title/args）を比較して不変なら CommitList をスキップ**するので二重に過剰再構築を防ぐ。ラベルは Rust からフロント i18n を読めないため locale を引数で受け 2 文字列だけ言語別に持つ
- ユーザーが「一覧から削除」した項目は `BeginList` の removed 配列（引数で照合）で除外し、`AppendCategory` 失敗時も Tasks/Recent は生かす

### システムトレイ（タスクトレイ、#161）
- `src-tauri/src/tray/mod.rs`（`tauri` の `tray-icon` feature）。トレイに常駐し、ウィンドウを閉じても復帰できる。`tray/mod.rs` は presentation（アイコン・メニュー・ツールチップ構築）に徹し、メニューの動作は lib.rs の `pub(crate) fn tray_menu_action` / `toggle_main_window` に委譲（ウィンドウ生成/フォーカスの private ヘルパーが lib.rs 側にあるため）
- **クローズ動作 = トレイ常駐（設定で切替）**: main の `CloseRequested` は常に `prevent_close`（生の破棄は async ランタイムを落とし他ウィンドウの Codex cleanup が panic するため必ず防ぐ）した上で、**設定 `closeToTray`（既定 ON）で分岐**。ON → `hide` + `main-minimized-to-tray` emit（session/PTY/ポーリングは生かしたまま、トレイから復帰、実終了はトレイ「終了」の `app.exit(0)` のみ）。OFF → `app.exit(0)` で終了（× で終了する従来挙動。Destroyed の Codex cleanup は `try_current()` ガードで runtime 消失時も panic しない）。設定はフロントの localStorage にあり Rust から読めないので、プロセスグローバルな `static CLOSE_TO_TRAY: AtomicBool`（既定 true）を `tray_set_close_to_tray` コマンドで同期（App.vue の `watch(settingsStore.closeToTray, immediate)`、**main ウィンドウのみ**。他ウィンドウでの切替はクロスウィンドウ設定ブロードキャストで main のストアに伝播し main の watch が発火する）。旧 `app-should-exit` 自動終了・`window-hide-requested` でのポーリング停止は廃止
- **左クリック**: `toggle_main_window`（表示中かつフォーカス時は hide、それ以外は show+unminimize+focus）。`show_menu_on_left_click(false)` でメニューは右クリック専用
- **右クリックメニュー**（`build_menu`、id 規約 `tray:show` / `tray:new-terminal` / `tray:switcher` / `tray:quit` / `tray:proj:{id}`）: 表示 / 新しいターミナルウィンドウ（`create_global_window`+OpenTerminal）/ 最近のプロジェクト（サブメニュー、`read_all_projects_sorted` 最大 8 件、選ぶと該当ウィンドウ focus か `build_window`）/ プロジェクトを開く…（main を show して `tray-open-switcher` を emit_to→スイッチャー表示）/ 終了
- **更新契機**: jump list と共通の `menus_refresh` コマンド（前述）が `tray::refresh(app, lang, &projects)` を呼び `app.tray_by_id("main").set_menu` で作り直す。プロジェクト一覧は menus_refresh が 1 回だけ読んで jump list と共有。起動時の `tray::build` はサブメニュー空（静的項目のみ）で作り、mount 後の menus_refresh が一覧つきに差し替える。ラベルは locale 引数で言語別（Rust からフロント i18n は読めない）
- **使用量ツールチップ**: main の StatusBar だけが（トレイは 1 プロセス 1 リソースなので）usage を整形して `traySetTooltip` で push。Claude 5h レート（アカウント単位なので代表値）優先、無ければトークン総量、無ければ "Pike"。hide 中もポーリングを止めないので畳んだ状態でも更新される
- **初回ヒント**: 初めて閉じたとき `resolveNotifier`（`lib/notify.ts`）で OS 通知（`localStorage['pike:tray-hint-shown']` で 1 回のみ）。ウィンドウが消えたと勘違いさせないため
- アイコンは `app.default_window_icon()` を流用（追加の image feature 不要）

### pike todo CLI（#139）
- `pike todo ...` は TODO パネルの実体 `.pike/todo.md` を**直接読み書きして stdout に出力し exit する独立 CLI**。GUI へ IPC せず、起動していなくても動く。GUI 起動中なら `todo` store の `fsWatcher.onFileChange` がファイル変更を検知してパネルを自動リロードするため、端末⇔パネルが同期する
- `src-tauri/src/todo_cli.rs`。`main.rs` で Tauri ランタイム起動前・**`try_forward_pty_origin_and_exit` より前**に `try_todo_and_exit()` でフック（後だと `todo` がファイルパスとして GUI へルーティングされてしまう）
- パース/シリアライズは `src/stores/todo.ts` と同一仕様（`(\s*[-*]\s+)\[([ xX])\]` を task 行、見出し・空行・自由記述は raw として round-trip 保持。保存は `[X]`→`[x]` 正規化・末尾改行 1 個）。GUI と同じく `.pike` 生成時に `.gitignore`（`*`）を書く
- サブコマンド: `list`（`--json` 対応、番号は 1 始まり）/ `add <text...>` / `done <n...>` / `undone <n...>` / `rm <n...>` / `clear`（タスク行のみ削除）/ `help`。番号は list 出力位置
- TODO ファイル解決（`resolve_todo_file`）: cwd から上方向に **既存 `.pike/` を最優先**（無ければ `.git` リポジトリルート、無ければ cwd）に `.pike/todo.md`。GUI は端末を project.root で開くので通常 cwd == root、サブディレクトリからでも辿れる
- release は `windows_subsystem = "windows"` でコンソール非割当のため、出力前に `AttachConsole(ATTACH_PARENT_PROCESS)`（`Win32_System_Console`）で親端末に接続（ConPTY 継承時は失敗するが無害）
- エージェント（Claude Code / Codex）向けスキルは `plugins/` に配置（後述の「エージェントプラグイン」）

### エージェントプラグイン（plugins/、#139）
- `plugins/` に Claude Code / Codex 双方向けの Agent Skills（`SKILL.md` 形式は両者共通）を収録。現状は `pike todo` CLI の使い方を説明する `pike-todo` スキルのみ
- `plugins/pike-todo/`（Claude Code プラグイン: `.claude-plugin/plugin.json` + `skills/pike-todo/SKILL.md`）、`plugins/.claude-plugin/marketplace.json`（`claude plugin marketplace add ./plugins` 用）、`plugins/codex/pike-todo/SKILL.md`（Codex 用・内容は Claude 版と同一）。導入手順は `plugins/README.md`
- **CLI の挙動を変えたら 2 つの SKILL.md（claude 版・codex 版）を両方更新する**（同一内容の複製。drift 注意）
- 将来 CLI の操作対象を増やす際はスキルを拡充（issue #139 の bullet 3-4 は別 issue 想定）

### グローバルモード（#123）
- プロジェクト非依存・サイドバー無しのウィンドウ。ラベル prefix `global-`（Rust `GLOBAL_PREFIX` / front `isGlobalWindow()`、旧 `secondary-` を置換）
- **ウィンドウラベル prefix を追加・変更したら `src-tauri/capabilities/default.json` の `windows` も更新すること**。ここはラベルのホワイトリストで、漏れると新ウィンドウで IPC（invoke / listen / set_title 等）が全部 permission エラーになり、App.vue の onMounted が途中で落ちてタブが一切開かない（DevTools コンソールの `not allowed on window "..."` が症状）
- App.vue の `globalMode` ref が制御: SideBar / ProjectSwitcher / QuickOpen を非表示、プロジェクト復元をスキップ、**全タブを閉じるとウィンドウも close**（`tabs.length` の watch、prev>0 → 0 のみ）
- 発動経路は 3 つ:
  1. **エディタ**: `--wait` と、プロジェクトウィンドウに一致しないファイル引数（`global-` ウィンドウ生成 + pending）。**コールドスタートのファイル引数**（「プログラムから開く」等）は main ウィンドウが `peekInitialCliAction()` で openFiles を検知して globalMode に入る（`last_project.txt` は消費しないので次回の素の起動で全プロジェクト復元される）
  2. **ターミナル**: 起動済みで引数なし `pike` → `CliAction::OpenTerminal { cwd, shell: Option<ShellConfig> }`（`cli::terminal_action_for_cwd`: cwd が WSL UNC ならその distro の WSL を `Some` で指定、それ以外は `shell=None`＝「指定なし」。#125）。フロント `useCliOpen` が `None` の時は Settings の `globalShell` で開き、`globalShell` が WSL なら Windows の cwd を捨てて WSL ホーム開始（`--cd ~`）、Windows シェルなら cwd 引き継ぎ。従来の「既存ウィンドウにフォーカス」挙動を置換（Windows Terminal 代替）
  3. **OpenDirectory の ad-hoc 作成失敗フォールバック**（ターミナルタブ）
- **WSL パスの UNC 化**: プロジェクト無しウィンドウのファイル I/O は Windows 側（`shellForIO` fallback = powershell）で走るため、WSL native パスは `CliFileTarget.distro` ヒントから `\\wsl.localhost\{distro}\...` に組み立てて開く（front `tabPathFor` ↔ Rust `wait_tab_path` が同期必須: --wait の解放照合はタブの path で行われる）
- CLI で開くファイルは拡張子ルーティング（画像→PreviewTab / pdf→PdfTab / 他→EditorTab、`useCliOpen.openFileTarget`）。PdfTab は shell fallback（powershell）でプロジェクト無しでも表示可
- **ターミナルの「+」**: グローバルモードでは Settings の `globalShell`（`ShellType`、既定 powershell）で起動。この設定はマシンの WSL distro に依存するため **`pike:sync-path` と同じマシンローカル扱い**: 独立キー `pike:global-shell` に保存し、同期ファイル・クロスウィンドウ broadcast の対象外（`sanitizeGlobalShell` で破損値ガード）。▾ ドロップダウンの内容は **シェルプロファイル**（後述 #129）駆動。アイコンは `lib/shellIcons.ts` の `SHELL_KIND_ICONS`（TabPane と SettingsTab で共有）。distro 検出はメニュー初回オープン時に lazy
- **シェルプロファイル（#129）**: ターミナル追加の ▾ プルダウンと各シェル選択肢の並び順・表示/非表示を管理。`ShellProfile { id, shell, hidden? }` の配列を `stores/settings.ts` が `pike:shell-profiles` キーにマシンローカル永続化（globalShell と同じく同期・broadcast 対象外）。`syncShellProfiles(distros)` が `detect_wsl_distros` 結果と照合（新規 distro は先頭に追加・消えた distro は除去・既存の順序と hidden は維持。**空検出は過渡状態とみなし reconcile skip** = カスタマイズ消失防止）。`windowsShellOptions(currentKind?)` / `visibleWslDistros(detected, currentDistro?)` が hidden 除外の選択肢を返す（現在値は hidden でも残す）。`defaultWindowsShellKind()` は作成フォームの既定（powershell 優先）。`ensureVisiblePerCategory` で WSL/Windows 各カテゴリ最低 1 つは可視を保証（UI の `canHideShellProfile` と二重ガード）。既定シェルは ▾ で hidden でも一覧に残す。UI は SettingsTab「シェル一覧」（↑↓・目トグル・デフォルトバッジ）
- **PowerShell 7（pwsh、#127）**: Windows PowerShell 5（`ShellConfig::Powershell`）と併存する独立シェル種別 `ShellConfig::Pwsh` / `ShellType {kind:'pwsh'}`。`pty/mod.rs` の `find_pwsh()` が PATH → `C:\Program Files\PowerShell\7\pwsh.exe` → bare `pwsh.exe`（Store 版の実行エイリアス対策）の順で解決。`cls`/`;`/`$LASTEXITCODE` の PowerShell 系分岐は front `isPowershellFamily(kind)` で powershell/pwsh 共通化
- **ProjectSwitcher（Ctrl+Shift+P）はグローバルモードでも使用可**。選択・新規作成は常に `openProjectWindow`（グローバルウィンドウ自身はプロジェクトレスを維持、`selectProject`）。グローバルウィンドウは起動時に projects を読まないため showSwitcher の watch で lazy load。QuickOpen（Ctrl+P）は非表示のまま
- **バイナリ安全装置**: `fs_read_file` の自動判定時に先頭 8KB の NUL バイトで Err を返す（EditorTab がエラー表示）。UTF-16 BOM は先に BOM 判定してテキスト扱い、UTF-8 BOM は従来どおり素通し（保存ラウンドトリップ維持）。StatusBar からの明示エンコード指定はガードなし（escape hatch）

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
- Tauri commands: `agent_start_session`, `agent_submit_turn` 等の `agent_*` 群
- フロント: `stores/agent.ts` (Pinia), `composables/useAgentRouter.ts` (event router), `types/agent.ts`
- `AgentChatTab.vue`: `agent-chat` タブ（`agentType: 'codex' | 'claude-code'`）。capabilities に応じて UI を条件分岐（auth bar, sandbox 表示等）。Codex / Claude のチャットはこの 1 タブに統合済み（旧 `CodexChatTab.vue` + `codex` store は廃止）
- バックエンドの `codex/` モジュール（app-server プロトコル）は `agent/codex_runtime.rs` が wrap する形で存続

### トークン使用量表示（Claude usage）
- `src-tauri/src/claude_usage/` が `~/.claude` 配下のログを解析し、セッションのトークン使用量を集計
- StatusBar にアクティブセッションの入力/出力トークン数と推定コストを表示。クリックでモデル別内訳ドロップダウン
- Codex は active な agent-chat タブのセッション usage（`thread/tokenUsage/updated` 由来）を表示
- **間接 Codex（CLI）usage**: Claude の codex スキルや `codex` を呼ぶスクリプト等、Pike の agent runtime を経由しない Codex も `src-tauri/src/codex_usage/` が `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` を解析して集計。`session_meta.cwd` を `project_root` と突き合わせ、`token_count` イベントの `total_token_usage`（累計）と `rate_limits.used_percent` を取得。pid が無いため**動作中判定はファイル mtime（直近 `ACTIVE_WINDOW_SECS`=300 秒、長いターンでもチラつかない幅）**。day-dir は session 開始日のフォルダに書かれるため最新 `SCAN_DAY_DIRS`=14 日分を走査（数字名の日付ディレクトリのみ。stat→mtime フィルタなので負荷は軽い）。未来 mtime（WSL/Windows 時計ズレ）は age 0=fresh 扱い。コストは**モデル別に集計**し cached を割引単価で計算（`input_tokens` は cached を含む）。StatusBar には Claude usage と**並べて** Bot アイコンで「トークン in/out + 5h 利用率%」を表示（クリックでモデル・キャッシュ・推論・5h/週間レート内訳）。native codex agent-chat タブが active な時はそちらを優先し CLI 表示は抑制（二重表示回避）。`gpt-5*-codex` は単価未登録のため費用は出さず利用率%を主指標とする
- **Claude レート制限（#117）**: `src-tauri/src/claude_usage/rate.rs` が `claude -p "/usage"` を `run_shell_line` で実行し、`Current <label>: N% used · resets <when>` 行をパース（5h セッション枠・週間枠・モデル別枠）。ラベル→`kind`（session/weekAll/other）の分類はパーサ隣の `window_kind` で行い、フロントは CLI 文言を文字列一致しない（session 枠が無ければチップの%表示自体を出さない）。CLI は起動に 10 秒超かかり時々ハングするため、**プロセス内キャッシュ（キーは wsl:distro / windows のインストール単位）+ fetch 直列化 Mutex + 90 秒タイムアウト**。試行間隔は `CacheEntry.last_attempt` で管理し、**active セッション中と失敗後リトライは 5 分（`TTL_ACTIVE`）、idle 中も 1 時間ごと（`TTL_IDLE`）に再取得**（別プロジェクトのセッションや 5h/週間枠の時間リセットで idle 中も値が動くため。sessionActive はプロジェクトスコープ、キャッシュはアカウントスコープという不一致を TTL_IDLE が緩和）。失敗時は前回値を保持するが **`STALE_KEEP_MAX`=2h を超えた古いデータは破棄**（CLI が恒久的に壊れたら表示を消す）。`fetched_at` はデータ取得時刻としてドロップダウンに表示。stdin は `null_device()` でクローズ（headless claude が stdin 待ちで 3 秒固まるため）。結果の `active` フィールドは usage-store ファクトリ契約（`{ active: boolean }`）に合わせた命名。手動更新は `createUsageStore` の `refreshUsage(force)` 経由（IPC 1 回）
- cwd↔root 一致判定（`cwd_matches_root`）と WSL ホーム解決（`wsl_home_subdir_cached`）は `types.rs` の共通ヘルパーで、`claude_usage` / `codex_usage` が共有
- フロント: ポーリング基盤は `stores/usageStore.ts` の `createUsageStore(id, fetcher)` ファクトリに集約（全フィールド deep 比較で rate%・cached 等も再描画。`refreshUsage(force)` で fetcher に force を伝搬）。`stores/claudeUsage.ts` / `stores/codexUsage.ts` / `stores/claudeRate.ts` は薄いラッパー（claudeRate の fetcher は claudeUsage の active を `sessionActive` として渡す）。型は `types/claudeUsage.ts` / `types/codexUsage.ts`、整形は `lib/format.ts` の `formatTokens` / `formatCost`。StatusBar の Claude 項目はトークン集計とレート%チップを統合表示（セッション非 active でもレート取得済みなら「Claude 5時間 N%」を表示、ドロップダウンに枠別利用率・リセット時刻・手動更新ボタン）

### タスクランナー（Tasks パネル）
- `tasks` サイドバーパネル。`src-tauri/src/tasks.rs` の `task_discover` がプロジェクトルートを**最大深さ 5**で再帰走査し、`package.json` / `Makefile` / `deno.json` / `Cargo.toml` を検出
- `package.json` の `scripts`、Makefile のターゲット、deno tasks、cargo（#122: 標準サブコマンド build/check/test/clippy/fmt + `[[bin]]` ごとの `run --bin {name}` を合成。パースは `toml` クレート。**Tauri 判定はマニフェスト隣の `tauri.conf.json` 存在**（tauri-cli 自身の契約。依存名スキャンだとプラグイン開発リポジトリ等で誤検出）で `tauri dev`/`tauri build` を追加。`src/main.rs` があれば `run`（`[[bin]]` 併存時は `run --bin {package名}`）。**workspace メンバーは標準セットを出さない**（ルートと重複して洪水になるため。bins/tauri/run のみ）。bin/package 名は Makefile と同じ文字種検証（英数 `-_.`）でシェルメタ文字注入を防止。`tauri.conf.json`/`main.rs` は existence-only マーカーとしてグロブに含め content は読まない。`[package]`/`[workspace]` を持たない Cargo.toml は対象外。vendor/ 配下は全タスク検出から除外、読み込みは `MAX_TASK_FILES`=300 で打ち切り）をそれぞれ「グループ」として一覧表示（ラベルに相対ディレクトリ名を付与）
- **cargo alias**: `.cargo/config.toml` の `[alias]` を検出し `cargo {alias名}` タスクとして表示。同じベースディレクトリ（`.cargo` の親）に Cargo.toml があればその cargo グループの**先頭**にマージ（同名の合成タスクは除去。alias は builtin を上書きできないため実行結果は同一）、なければ独立グループ「cargo alias」（例: musql の repo root）。alias 名は `is_safe_cargo_name` で検証（シェルに渡るのは名前のみ）、値（string / string 配列）は tooltip 表示用の展開コマンドにのみ使用。検出は rg なら `--hidden -g '!.git'` + `**/.cargo/config.toml` glob（隠しディレクトリのため）、find/walkdir フォールバックは basename `config.toml` マッチ後に親が `.cargo` のものだけ残す（Hugo 等の無関係な config.toml は content-read しない）。ancestor 方向の alias 継承（cargo 本来の config 解決）は追わず同一ディレクトリのみ
- 除外: `IGNORED_DIRS`（`.git node_modules __pycache__ .next .nuxt target dist build .cache .venv venv`）
- `.gitignore` を尊重するのは **rg バックエンド使用時のみ**（`rg --files --max-depth 5 -g <glob>`）。rg が無く `find`(WSL)/walkdir(Windows) フォールバックの場合は `.gitignore` を見ず `IGNORED_DIRS` のみで除外するため、ネストした `package.json` がより多く出る
- タスク実行はプロジェクトのデフォルトシェルで `autoStart` + `closeOnExit`（完了でタブ自動クローズ）。サブディレクトリのタスクは正しい CWD で起動
- グループ見出しの sourceFile クリックで定義ファイルをエディタタブで開く（#159。`taskStore.openSourceFile`、`group.cwd` + `basename(sourceFile)` で絶対パス化）
- フロント: `stores/tasks.ts` + `components/panels/TasksPanel.vue` + `types/tasks.ts`

### アウトラインパネル（Outline）
- `outline` サイドバーパネル。`lib/outline/` の言語別 extractor（18 言語: Markdown / TypeScript+JSX / Vue / HTML / CSS+SCSS / Rust / Python / Go / Perl / YAML / JSON / Ruby / Kotlin / Swift / PHP / Dockerfile / TOML / Makefile）でシンボルを抽出
- カーソル位置追従ハイライト・祖先自動展開・scrollIntoView、タブ別スクロール位置保持
- Outline / History 2 タブ構成（`OutlineTreeView.vue` / `OutlineHistoryView.vue`）。History はファイル別 git log を表示、行クリックで diff タブを開く
- 行オフセットは `buildLineOffsets` / `lineStart` で O(N) 前計算（`composables/useOutlineSource.ts`）

### 定義ジャンプ（Ctrl+Click / F12）
- `lib/editorJumpTo.ts` + `lib/jumpTo/`。TS/JS/Vue/Go の import パスを Ctrl+Click でファイル open
- 識別子は同一ファイル内宣言（Lezer 構文木）と import 経由のクロスファイル定義の両方に対応
- Vue カスタムコンポーネントは `<script setup>` の PascalCase import / Options-API `components` / `app.component()` グローバル登録の 3 段で解決
- path alias 解決: tsconfig/jsconfig の `compilerOptions.paths` と vite.config の `resolve.alias`（祖先方向に config 探索、モノレポ対応、設定変更で自動 invalidate）
- 進捗・結果は `stores/statusMessage.ts` 経由で StatusBar に表示（スピナー / 開いたファイル名 / 見つからない）

### QuickOpen コマンドパレット（Ctrl+P）
- 先頭文字でモード切替: 無印=ファイル fuzzy open、`>`=タスク実行、`@`=タブ切替、`:`=行ジャンプ、`!`=Git ブランチ切替、`?`=ヘルプ
- `> Claude` / `> Codex` で新規エージェントタブ作成。`filename:42` で行番号ジャンプ
- `rg --files` の結果をフロントでキャッシュ、プロジェクト切替時にリセット

### 国際化（i18n）
- `src/i18n/`: `index.ts` が `useI18n()` / 標準関数 `t` / `locale` ref（デフォルト `en`）を提供、`en.ts` / `ja.ts` がメッセージ辞書
- `messages` は `locale` に対する `computed` でリアクティブ（locale 切替で即時反映）。ストア等コンポーネント外では `t` を直接 import
- `{name}` プレースホルダを `replaceAll` で展開。言語切替は Settings タブ

### タブバーへの OS ファイルドロップ
- エクスプローラーからタブバーへの D&D。ファイル → `useCliOpen` の `openFileTarget`（export 済み。画像→Preview / pdf→Pdf / 他→Editor の拡張子ルーティング）、ディレクトリ → `addTerminalTab({ cwd, shell })`。**Windows プロジェクトとグローバルモードのみ有効**（WSL プロジェクトはエディタ I/O・ターミナル cwd の Windows→WSL パス変換が要るため無効）。ディレクトリの shell はプロジェクト default / グローバルは `globalShell`（WSL なら `defaultWindowsShellKind()` にフォールバック。Windows パスの cwd が WSL シェルでは捨てられるため）
- **実パス解決**（`dragDropEnabled: false` のため DOM の File にパスが無い）: `lib/dropPaths.ts` が WebView2 の `postMessageWithAdditionalObjects`（`pike:drop-paths:{id}` + File 群）で host に渡し、Rust `drop_paths.rs` の `WebMessageReceived` ハンドラが `ICoreWebView2File::Path` + `is_dir` を解決して `drop_paths` イベント（`{id, entries}`、window-scoped）で返す。ハンドラの attach は `build_window` と setup の main ウィンドウの 2 箇所（`with_webview`）。wry の IPC も同じ WebMessageReceived を使うが COM イベントは多重購読できるため共存
- **依存の注意**: `webview2-com` 0.38 の COM 型は windows-core **0.61** 系で、本体の `windows` 0.62 とは別インスタンス。`drop_paths.rs` では `windows_core`（0.61、直接依存に追加済み）の `Interface`/`PWSTR` を使うこと
- App.vue に未処理ドロップの window レベル preventDefault ガードあり（未処理の OS ファイルドロップは WebView がファイルへナビゲートし、アプリごと置き換わる＝全 PTY 破棄のため）

### ファイル/画像ペースト
- `composables/useImagePaste.ts`。クリップボード/D&D のファイルを `.pike/uploads/` に保存 → 相対パスを挿入（エージェントチャットは `@パス` メンション、ターミナルは bare path）。画像専用ではなく**任意のファイル**が対象（PDF 等も可）
- 判別は **file か string か**（`ClipboardEvent` は `item.kind === 'file'`、D&D は `dataTransfer.files`）。テキスト（string）は長さに関係なくインライン貼り付けのまま
- 保存ファイル名は元名を保持（`stem-{hex}.ext`、衝突回避）。名前を持たないクリップボード blob（画像等）は `upload-{ts}-{hex}.{ext}` を生成
- 初回保存時に各プロジェクトへ `.pike/.gitignore`（中身 `*`）を書き込み、退避ファイルを repo から除外
- **小ファイルのインライン展開**（設定 `inlineSmallTextFiles`、既定OFF / 閾値 `inlineSmallTextThreshold` 既定4KB）: **AgentChatTab 限定**。ファイルがサイズ上限以下 **かつ** 中身が UTF-8 テキスト（`isProbablyText` で NUL/不正バイト判定）なら、アップロードせず内容を直接挿入。PDF・画像等のバイナリは常にアップロード。ターミナルへのドロップは常にアップロード（`tryInlineFile` は使わない）
- xterm は Ctrl+V を SYN(`\x16`) として食うため `attachCustomKeyEventHandler` で横取り。右クリック/Ctrl+V は `navigator.clipboard.read()` 経由だが、この API は**画像とテキストのみ**返す（任意ファイルは取得不可）→ ターミナルへの任意ファイル投入は D&D が主経路
- ファイルツリー / OS からのドラッグ&ドロップにも対応

### ショートカット一覧モーダル
- `components/KeyboardShortcuts.vue` + `composables/useShortcutsModal.ts`。登録済みショートカットの一覧を表示
- WebView リロード抑止: `composables/useKeyboardShortcuts.ts` が Ctrl+R / Ctrl+Shift+R / F5 を `preventDefault`。誤操作でのリロード（全 PTY セッション破棄＝実質再起動）を防ぐ。ターミナルの Ctrl+R（bash 逆方向検索）は xterm がイベントを消費するため影響なし

### `pike --wait`（GIT_EDITOR 連携）
- `src-tauri/src/wait.rs`。`GIT_EDITOR="pike.exe --wait"` でコミットメッセージ編集に対応
- 二次インスタンスが WM_COPYDATA（single-instance プラグインの規約）でファイルパスを既存ウィンドウに転送、`WaitState` で wait_id ↔ (パス, ウィンドウラベル) を管理
- エディタタブを閉じると待機中プロセスが解放され、ウィンドウも自動で閉じる。ウィンドウ破棄時の abort は**そのウィンドウが所有する wait のみ**（グローバルターミナルウィンドウの開閉が無関係な GIT_EDITOR 待機を解放しないため）
- **ファイル引数なしの `--wait`**（素の `pike --wait` や directory 引数）は待機対象が無いため、abort イベントで即座に CLI を解放してから通常のアクション処理に回す（解放しないと CLI が永遠にブロックする）

### コミット前チェック

**コードを変更するコミットの前は、まず `simplify` スキル（ビルトイン）を実行し、指摘（再利用・単純化・効率・抽象度）を反映してから、以下の静的チェックを実行する。**

- 対象外（simplify をスキップしてよい）: **バージョン bump のみ**のコミットと、**ドキュメントのみ**（`README.md` / `docs/manual/` / `CHANGELOG.md`）のコミット。
- simplify はコードを書き換えるため、必ず**ユーザの動作確認より前**に実行する（ユーザは simplify 適用後のコードを試す）。
- simplify はバグ探索ではなく品質整理。バグ確認が要る場合は別途 `/code-review` を使う。

その上でコミット前に以下を実行し、エラー・警告がゼロであることを確認する:

- **Rust**: `cargo clippy -- -D warnings`（`src-tauri/` で実行）
- **Frontend**: `npm run lint`（= `biome check src/`）
- **TypeScript 型検査**: `npx vue-tsc --noEmit`（`tsc` ではなく `vue-tsc` を使うこと — Vue SFC の型チェックに必要）

### コミット & push 運用ルール
個人開発のため PR レビューは原則不要。Claude が変更を加えた場合は以下のフローを厳守:

1. **コミット前に必ずユーザの動作確認 OK を取る** — `cargo clippy` / `biome` / `vue-tsc` が通っていてもコミットしてはいけない。ユーザは GUI 上で実際に挙動を試す必要があるため、Claude が「テスト通った」だけで自動コミットすると確認前に履歴が確定してしまう。「コミットしていい？」と聞くか、ユーザが明示的に「コミットして」と言うまで待つ
2. **`main` ブランチに直接コミット**（feature ブランチや PR は作らない）
3. **`git push` は実行しない** — push の判断はユーザに委ねる（ユーザはローカル確認後に自分で push する運用）。**例外はリリース依頼時**（次項 5）
4. ユーザから明示的に「PR にして」「ブランチ切って」等の指示があった場合のみ、その指示に従う
5. **リリース依頼は end-to-end で Claude が実行する**: ユーザから「リリースして」と依頼されたら、それはバージョン bump コミットだけでなく、`main` の push・タグ作成と push・Release ワークフロー完了待ち・ドラフトのリリースノート記載と公開までの一括依頼。個別の push 確認は不要（「リリース手順」セクションの手順をそのまま完遂する）

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
- CSV/TSV・Mermaid・JSON/JSONL・SVG・Markdown は専用タブではなく **`EditorTab` の Edit/Split/Preview トグル**で描画する（タブ種別は `editor`。`isCsv` / `isMermaid` / `isSvg` / `isJson` 等の computed で分岐）
  - CSV/TSV: `buildCsvPreview` でテーブル化（RFC 4180 準拠の引用符対応パーサ、10,000 行 truncate、sticky ヘッダ）
  - Mermaid (`.mermaid`/`.mmd`): `renderStandaloneMermaid` が `lib/mermaid.ts` の `getMermaid()` を遅延 import して SVG 描画（ズーム対応）
  - JSON/JSONL: キー/文字列/数値/bool/null を色分け、JSONL は 1000 件 truncate、`\n`/`\r` を含む文字列値クリックでデコード済みポップアップ
  - SVG: `DOMPurify.sanitize` + `SVG_PURIFY_OPTS`。`IMAGE_EXTS` から除外し EditorTab で開く
- Markdown 内 mermaid: previewHtml 更新時に `code.language-mermaid` ブロックを検出し `mermaid.render()` で SVG に差し替え
- 画像: `PreviewTab.vue`（base64 dataUrl を `<img>` 表示）。上部ツールバーで**表示専用**（ファイルは無変更）のビューワ操作を提供:
  - 拡大 / 縮小 / 100% / ウィンドウに合わせる（fit）、左右 90° 回転・左右反転
  - スクロールコンテナは flex 中央寄せを使わず**ステージ側 `margin: auto`** で中央寄せ（`align-items: center` だと画像がビューポートより大きいとき上端がスクロール領域外に押し出され到達不能になる不具合を回避）。スクロール領域は**回転後のバウンディングボックス**（`stageW`/`stageH` computed）が駆動
  - ズームは transform scale ではなく img の width/height で表現し、回転・反転は `translate(-50%,-50%) rotate() scaleX()` の transform で適用
  - `applyZoom` がズーム前後のスクロール比から `scrollLeft/Top` を補正し、カーソル（または中央）位置を固定。Ctrl+ホイールズーム / ドラッグでパン（`canPan` 時のみ、グローバル mousemove/mouseup は `onUnmounted` でも除去）/ ダブルクリックで fit⇔100%
  - キーボード（canvas に `tabindex="0"`）: `+`/`-` ズーム、`0`=100%、`f`=fit、`r`/`Shift+R`=回転。透過グリッド（チェッカーボード）背景の切替、画像実寸（W×H）表示。ツールバー文言は `preview.*` i18n（日英）
- PDF: `PdfTab.vue`（`<iframe src="data:application/pdf;base64,...">` による WebView2 内蔵レンダリング）
- ファイルツリー `openFile()` が拡張子で画像→PreviewTab / PDF→PdfTab / その他→EditorTab を振り分ける

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

新しいバージョンをリリースする際は、以下の手順を順番に実行する。ユーザからリリース依頼を受けたら、push・タグ・ドラフト公開まで含めて Claude がすべて実行する（通常のコミット運用と異なり push の個別確認は不要。CI の完了待ちはバックグラウンド watch で行う）。

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
