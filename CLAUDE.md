# Pike — Claude Code ガイド

## プロジェクト概要

**Pike** は Tauri v2 (Rust + Vue/TypeScript) で構築する軽量開発環境。第一ターゲットは Windows で、
macOS はローカルのシェルで開発できるところまで対応する。
「AI エージェント × ターミナル」に特化し、VS Code より大幅に軽いことが最重要の差別化点。

### 設計思想
- **軽さ最優先**: Monaco は使わない。CodeMirror 6 のみ。拡張機能システムは作らない
- **タブ統一**: エディタ・ターミナル・Docker logs をすべて同一タブで扱う
- **Rust はステートレスに**: Rust は I/O ブリッジに徹する。セッション復帰は各ツールの resume 機能（`claude --continue` 等）に委譲
- **外部依存は明示**: rg なければ grep、と graceful degrade する。tmux はオプション機能

### ターゲット環境
- **OS**: Windows 11（メイン開発・動作環境）。macOS はローカルのシェルで開発できるところまで対応する（詳細と制約は `.claude/rules/platform.md`）
- **実行環境**: WSL2 上のシェル・Docker コンテナ、または Windows ホスト上のシェル。macOS ではホストのログインシェル
- **GUI**: Tauri v2 webview（ホストのネイティブプロセス。Windows は WebView2、macOS は WKWebView）
- **対応シェル**: WSL bash / cmd.exe / PowerShell / Git Bash / ローカル Unix シェル（macOS）

---

## 詳細ルール（触る領域のものを読む）

このファイルには全体像と運用を置き、領域別の実装ルールは `.claude/rules/` に分けてある。**`@import` していないので、その領域を触るときに自分で読むこと。** どれも非自明な判断・定数・落とし穴の記録で、読まずに書くと過去に踏んだものを踏み直す。

| ファイル | 中身 |
|---|---|
| `rust.md` | Tauri コマンドの形・状態管理・PTY のライフタイム・非同期・命名規約 |
| `frontend.md` | Vue/Pinia の構成・タブ管理・xterm.js・スタイル・アイコン・i18n・設定画面・禁止事項 |
| `testing.md` | 自動テストの範囲・検証バイナリの置き場 |
| `terminal.md` | PTY とシェル対応・ターミナルの coding agent 補助・キーボードショートカットの取り合い |
| `project.md` | プロジェクト管理と同期・ウィンドウの生成と復元・トレイ・ジャンプリスト・`pike` CLI |
| `git.md` | git CLI ブリッジ・worktree・コンフリクト解消 |
| `editor.md` | エディタとプレビュー・ファイルツリー・検索/タスク/アウトライン/診断/issue の各パネル・ファイル監視 |
| `agent.md` | トークン使用量（エージェントはターミナルで動かす、#275） |
| `docker.md` | bollard 連携・compose の探索・ログ・ポートフォワード |
| `build.md` | 開発ビルド・本番ビルド限定の落とし穴（CSP）・E2E スクリーンショット・CI・セルフアップデート |
| `platform.md` | Windows / macOS の分岐の作法・GUI プロセスの PATH・macOS で持たない機能・rg サイドカー |

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│  Tauri WebView (ネイティブプロセス)                      │
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
│  │ ⚠ problems │                                         │
│  │ ✅ issues   │                                         │
│  └────────────┘                                         │
└──────────────┬──────────────────────────────────────────┘
               │ Tauri IPC (invoke / events)
┌──────────────▼──────────────────────────────────────────┐
│  Rust バックエンド                                        │
│  pty_manager   git_manager   fs_watcher   search         │
│  project_store docker_client                             │
└──────────────┬──────────────────────────────────────────┘
               │ wsl.exe spawn / ホストのシェル / bollard / git CLI / notify
┌──────────────▼──────────────────────────────────────────┐
│  WSL2 (Windows) / ホストのログインシェル (macOS)          │
│  Claude Code / bash / zsh / etc.                         │
│  Docker (WSL2 backend) ← コンテナ群                      │
└─────────────────────────────────────────────────────────┘
```

---

## ディレクトリ構成

```
pike/
├── CLAUDE.md                  # このファイル（AI 開発向け: 全体像・構造・規約・運用）
├── README.md                  # ユーザー向け概要・インストール・マニュアルへの導線
├── justfile                   # 開発タスクの入口（#231。CI の各ステップもここを呼ぶ）
├── docs/
│   └── manual/                # ユーザーマニュアル（日本語・フォルダ分割）
│       ├── README.md          # マニュアル索引
│       ├── *.md               # 機能別ページ（getting-started, editor, git 等）
│       └── img/               # スクリーンショット（README のヒーロー画像もここ。#279）
├── scripts/
│   ├── download-rg.sh         # rg サイドカーバイナリのダウンロード
│   ├── bump-version.mjs       # バージョンを 3 ファイルに書き込む（just bump が呼ぶ）
│   ├── check-docs.mjs         # ドキュメント整合チェック（just check-docs が呼ぶ）
│   ├── check-shortcuts.ts     # マニュアルの早見表と実装の割り当ての照合（just check-shortcuts、#280）
│   └── make-icons.sh          # アイコン一式を icon.svg から作り直す（#256）
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── Info.plist         # macOS の TCC 許可ダイアログの説明文（#296。tauri がマージする）
│   ├── entitlements.plist # macOS の hardened runtime のリソースアクセス（#296。XML コメント不可）
│   └── src/
│       ├── main.rs            # Tauri エントリポイント
│       ├── lib.rs             # Tauri Builder 設定・コマンド登録
│       ├── types.rs           # ShellConfig・WSL_EXTRA_PATH・bash_quote 等の共通型/ヘルパー
│       ├── font.rs            # フォント列挙（font-kit でモノスペース検出）
│       ├── cli.rs             # CLI 引数パース・CliState・single-instance 連携
│       ├── wait.rs            # `pike --wait`（GIT_EDITOR 連携）・WM_COPYDATA 待機管理
│       ├── elevate.rs         # 管理者ターミナル（--new-instance で昇格起動、#138）
│       ├── http.rs            # 外部ホストへの取得の共通部（クライアント使い回し・上限付き読み）
│       ├── page_title.rs      # 貼り付けた URL のページタイトル取得（Markdown リンク、#241）
│       ├── remote_image.rs    # 承認済みホストの画像取得（Markdown プレビュー、#239）
│       ├── settings_sync.rs   # 設定・プロジェクト一覧の同期ファイル読み書き（#164）
│       ├── window_geom.rs     # プロジェクト単位のウィンドウ geometry（#200）
│       ├── drop_paths.rs      # タブバーへの OS ファイルドロップの実パス解決（WebView2 COM）
│       ├── ime_debug.rs       # IME 調査用の一時ログ（原因判明後に削除する）
│       ├── jumplist/mod.rs    # タスクバーのジャンプリスト（#160、Windows 専用 COM）
│       ├── appmenu/mod.rs     # macOS のアプリケーションメニュー（#254、macOS 専用）
│       ├── tray/mod.rs        # システムトレイ（#161）
│       ├── diagnostics/mod.rs # 外部リンタ実行 → Problems パネル
│       ├── codex_usage/mod.rs # 間接 Codex（CLI）のトークン使用量集計（~/.codex 解析）
│       ├── claude_usage/
│       │   ├── mod.rs         # Claude Code のトークン使用量集計（~/.claude ログ解析）
│       │   ├── config.rs      # CLAUDE_CONFIG_DIR の解決とアカウント読み出し（#225）
│       │   ├── rate.rs        # `claude -p "/usage"` のレート制限パース（#117）
│       │   └── sessions.rs    # 再開できる過去セッション一覧（#220）
│       ├── pty/
│       │   ├── mod.rs         # PTY 管理（WSL/cmd/PowerShell/PowerShell 7/Git Bash 対応）
│       │   └── busy.rs        # シェル以外のプロセスが動いているかの判定（#178）
│       ├── watcher/
│       │   └── mod.rs         # ファイル監視（notify + WSL inotifywait）
│       ├── project/
│       │   ├── mod.rs         # プロジェクト CRUD・WSL ディストロ検出・グループ永続化
│       │   └── transient.rs   # 登録せずに開いたディレクトリのメモリ内プロジェクト（#230）
│       ├── fs/
│       │   └── mod.rs         # WSL/Windows 両対応ファイル操作・IGNORED_DIRS
│       ├── git/
│       │   └── mod.rs         # git CLI ブリッジ（status/log/diff/commit/push/pull 等）
│       ├── docker/
│       │   ├── mod.rs         # bollard クライアント・compose パース・ログストリーム
│       │   └── tunnel.rs      # 未公開ポートへの socat ポートフォワード（#120）
│       ├── issues/
│       │   └── mod.rs         # gh 経由の GitHub issue 一覧（#278）
│       ├── search/
│       │   └── mod.rs         # rg/grep バックエンド判定・検索・list_project_files
│       ├── tasks.rs           # package.json/Makefile/deno.json/Cargo.toml のタスク再帰検出
│       └── bin/               # 検証バイナリ（verify_pty / verify_tmux / verify_bollard / verify_busy）
├── src/                       # Vue/TypeScript フロント
│   ├── App.vue                # ルート（PTY ルーター初期化・プロジェクト復元）
│   ├── main.ts
│   ├── i18n/                  # 国際化（日英）: index.ts（useI18n/locale）+ en.ts / ja.ts
│   ├── types/
│   │   ├── tab.ts             # Tab Union type・ShellType・SidebarPanel・共通ヘルパー
│   │   ├── project.ts         # ProjectConfig・PinnedTabDef
│   │   ├── claudeUsage.ts  codexUsage.ts  diagnostics.ts  docker.ts
│   │   ├── git.ts  search.ts  tasks.ts  issues.ts
│   ├── components/
│   │   ├── ProjectSwitcher.vue  # fzf 風プロジェクト切替 + 新規作成モーダル
│   │   ├── QuickOpen.vue        # Ctrl+P コマンドパレット（ファイル/>タスク/@タブ/:行/!ブランチ/?ヘルプ）
│   │   ├── ConfirmDialog.vue    # カスタム確認ダイアログ（Teleport、prompt 入力対応）
│   │   ├── KeyboardShortcuts.vue # ショートカット一覧モーダル
│   │   ├── HelpButton.vue       # 各 UI からマニュアル該当ページを開く「?」ボタン
│   │   ├── RateMeters.vue       # 利用率の帯グラフ（StatusBar と状態タブで共有、#226）
│   │   ├── ColorDot.vue         # プロジェクトカラーのドット（#121）
│   │   ├── RenameNote.vue       # 「名前が変わった」見出し（diff タブと履歴タブで共有、#306）
│   │   ├── ProjectIcon.vue      # プロジェクトの絵文字アイコン（#203）
│   │   ├── layout/
│   │   │   ├── ProjectSelect.vue # プロジェクトの表示と切替（サイドバー上部 / タブバー左、#298）
│   │   │   ├── SideBar.vue    # アイコンナビ + パネル
│   │   │   ├── TabPane.vue    # タブバー + コンテンツ + シェル選択
│   │   │   ├── TabItem.vue    # タブバーの 1 枚（固定タブの列と通常の列で共有、#305）
│   │   │   └── StatusBar.vue  # ブランチ/worktree セレクタ/ahead-behind/トークン使用量/エンコード/改行/repo リンク
│   │   ├── panels/
│   │   │   ├── FileTreePanel.vue  # ファイルツリー
│   │   │   ├── ProjectPanel.vue   # プロジェクト一覧・登録・編集・削除（GroupComboBox/ProjectListItem に分割）
│   │   │   ├── GroupComboBox.vue  ProjectListItem.vue  ColorSelect.vue  IconSelect.vue
│   │   │   ├── AllowedHostList.vue # 承認済みホストの一覧（設定画面。画像 #239 とリンク #311 で共有）
│   │   │   ├── ProjectPlatformFields.vue # プラットフォーム/distro/シェルの選択欄（作成・編集の 3 フォームで共有）
│   │   │   ├── GitPanel.vue  SearchPanel.vue  DockerPanel.vue  TasksPanel.vue
│   │   │   ├── DiagnosticsPanel.vue # Problems（外部リンタの結果・🤖 で修正依頼を注入）
│   │   │   ├── IssuesPanel.vue    # GitHub issue の一覧（gh 経由、#278）
│   │   │   ├── OutlinePanel.vue   # シンボルアウトライン
│   │   │   └── outline/           # OutlineTreeView.vue / OutlineHistoryView.vue
│   │   ├── editor/
│   │   │   ├── MarkdownToolbar.vue  # Markdown 入力支援のボタン列（#241）
│   │   │   ├── MinimapToggle.vue    # ミニマップの表示切り替え（タブ単位、#282）
│   │   │   └── WrapToggle.vue       # 折り返しの切り替え（タブ単位、#241）
│   │   └── tabs/
│   │       ├── TerminalTab.vue    # xterm.js + PTY（autoStart 対応）
│   │       ├── EditorTab.vue      # CodeMirror 6 + Edit/Split/Preview（md/csv/json/svg/mermaid）
│   │       ├── PreviewTab.vue     # 画像ビューワ（ズーム/回転/反転/パン/fit、表示専用）
│   │       ├── PdfTab.vue         # PDF プレビュー（iframe）
│   │       ├── DiffTab.vue        # 左右分割 diff
│   │       ├── HistoryTab.vue     # ファイル別 git log（git log -L 行範囲対応）
│   │       ├── DockerLogsTab.vue  # コンテナログ（xterm 読み取り専用）
│   │       ├── ManualTab.vue      # アプリ内マニュアル（docs/manual を F1 / ? ボタンで表示）
│   │       ├── IssueTab.vue       # GitHub issue 1 件の読み取り専用表示（gh 経由、#278）
│   │       ├── AgentStatusTab.vue # エージェント状態（/status 相当。アカウント・レート・トークン、#226）
│   │       └── SettingsTab.vue    # 設定画面（フォント・カラースキーム・ダーク・エディタ・言語）
│   ├── stores/
│   │   ├── tabs.ts            # タブ状態管理 (Pinia)
│   │   ├── sidebar.ts  settings.ts  project.ts
│   │   ├── fileTree.ts  git.ts  search.ts  docker.ts  tasks.ts  worktree.ts
│   │   ├── diagnostics.ts  issues.ts
│   │   ├── usageStore.ts      # createUsageStore ファクトリ（ポーリング基盤）
│   │   ├── claudeUsage.ts  claudeRate.ts  codexUsage.ts  # トークン使用量・レート
│   │   └── statusMessage.ts   # StatusBar 汎用メッセージ（jumpTo 進捗等）
│   ├── composables/
│   │   ├── useKeyboardShortcuts.ts  useShortcutsModal.ts
│   │   ├── useAppActions.ts  # ショートカットと macOS メニューが共有する動作の実体（#254）
│   │   ├── useAppMenu.ts     # macOS のメニューバーからの操作を受ける（#254）
│   │   ├── useBusyExit.ts    # Pike ごと終了する前の確認（#178。close と ⌘Q が共有）
│   │   ├── useConfirmDialog.ts  usePtyRouter.ts  useFsWatcher.ts  useCliOpen.ts  useAnchoredPopup.ts
│   │   ├── useDragResize.ts  # 横幅を変えるドラッグの配線（サイドバーの幅・diff の分割線、#297）
│   │   ├── useProjectAccent.ts # プロジェクトカラーを面として塗るための色の組（#298）
│   │   ├── useActiveFile.ts  # いま見ているファイル（ツリーと Git パネルの強調、#274）
│   │   ├── useFocusPolling.ts # アクティブなあいだだけポーリングする共通部（#277）
│   │   ├── usePanelAvailability.ts # サイドバーのパネルが使えるかの唯一の出典（#278）
│   │   ├── useDockerLogRouter.ts  useAgentUsage.ts
│   │   ├── useDragAndDrop.ts  useEditorInfo.ts  useImagePaste.ts
│   │   ├── useOutlineSource.ts  useUpdater.ts  useTerminalInject.ts
│   │   ├── useMarkdownImages.ts  # Markdown への画像挿入（選択/貼り付け/ドロップ、#241）
│   │   ├── useMarkdownLinkPaste.ts # 貼り付けた URL をタイトル付きリンクにする（#241）
│   ├── lib/
│   │   ├── fileIcons.ts  tabIcons.ts  fontDetection.ts  tauri.ts  window.ts  paths.ts  storage.ts  format.ts  notify.ts
│   │   ├── pikeDir.ts        # .pike/ の作成と .gitignore の設置（アップロードの置き場）
│   │   ├── host.ts           # ホスト OS の判定とホスト依存の既定値（出し分けの唯一の出典）
│   │   ├── keys.ts           # ショートカットの修飾キー判定（mac は Cmd / 他は Ctrl、#254）
│   │   ├── shortcuts.ts     # ショートカットの割り当て表（#254。キーの正本）
│   │   ├── usageFormat.ts    # レート枠の表示整形と `Meter` 型（StatusBar と状態タブで共有、#226）
│   │   ├── issueTree.ts      # issue の親子を `parent` だけで組んで平らに落とす（#278）
│   │   ├── issueRefs.ts      # 本文の `#123` を別 issue タブへのリンクにする（marked 拡張、#278）
│   │   ├── gitGraph.ts  gitRemote.ts  gitignore.ts  diffParser.ts  diffExpand.ts  diffSearch.ts  languages.ts  mermaid.ts  popupPosition.ts
│   │   ├── frontmatter.ts  frontmatterParse.ts  # Markdown フロントマターの範囲検出 / 値のパース（#229）
│   │   ├── markdownFootnotes.ts  # プレビューの脚注（marked 拡張、#241）
│   │   ├── rstPreview.ts      # reStructuredText のプレビュー（自前の変換、#284）
│   │   ├── displayWidth.ts    # 等幅フォントでの表示幅（diff の横幅と rst の表が共有、#284）
│   │   ├── text.ts            # HTML 組み立ての共有部（Html 型・エスケープ・CSV 分割、#284）
│   │   ├── sanitizeHtml.ts    # DOMPurify に渡す URI スキームの許可（4 つのプレビューで共有、#311）
│   │   ├── externalImages.ts  # プレビューの外部画像のホスト判定と取得キャッシュ（#239）
│   │   ├── terminalLinks.ts  shellIcons.ts  projectColors.ts  projectIcons.ts  projectPaths.ts
│   │   ├── openFile.ts        # 拡張子でタブ種別を振り分ける唯一の入口（editor/preview/pdf）
│   │   ├── openUrl.ts         # 外部ブラウザで URL を開く唯一の入口（確認とホストの許可、#311）
│   │   ├── tabTitle.ts        # タブの表示名（シングルトンタブは kind から i18n を引く）
│   │   ├── manual.ts  slug.ts # アプリ内マニュアルの読み込みと見出しスラッグ
│   │   ├── dropPaths.ts       # WebView2 経由でドロップされたファイルの実パス取得
│   │   ├── imeDebugLog.ts  imeFocusPark.ts  # IME 調査用（原因判明後に削除する）
│   │   ├── editorGitGutter.ts  editorMinimap.ts  editorThemes.ts  editorSearch.ts
│   │   ├── editorJumpTo.ts  editorConflict.ts  editorDiagnostics.ts  editorMarkdown.ts
│   │   ├── editorPresetKeys.ts # ショートカットのプリセットで変わる CodeMirror のキー（#261）
│   │   ├── jumpTo/            # 定義ジャンプ（findInFile/parseImports/resolveImport/vueComponent）
│   │   └── outline/           # アウトライン抽出（index.ts + extractors/ 18 言語）
│   └── assets/
│       └── theme.css          # CSS Variables テーマ定義（ダーク/ライト）
└── .claude/
    └── rules/             # 領域別の実装ルール（@import せず、触る領域のものを読む）
        ├── rust.md        # Rust 実装の基本方針
        ├── frontend.md    # フロント実装の基本方針・UI 共通部品
        ├── testing.md     # テスト方針
        ├── terminal.md    # PTY・シェル・ターミナルの agent 補助
        ├── project.md     # プロジェクト管理・ウィンドウ・OS 統合・CLI
        ├── git.md         # git 統合・worktree
        ├── editor.md      # エディタ・プレビュー・各パネル・ファイル監視
        ├── agent.md       # Agent Runtime・usage
        ├── docker.md      # Docker 連携
        ├── build.md       # 開発/本番ビルド・E2E・CI・アップデート
        └── platform.md    # Windows / macOS の分岐・PATH・サイドカー
```

---

## 開発の進め方

マイルストーン駆動の初期開発フェーズ（M1〜M14）は完了済み。現在は **GitHub Issue 駆動**で機能追加・修正を行う運用。作業前に対象 Issue を確認すること。

ドキュメントの役割分担を守ること:

- **README.md** … ユーザー向け（概要・インストール・主な機能・マニュアルへの導線）。AI 開発の内部情報は書かない。
- **docs/manual/** … ユーザーマニュアル（日本語）。使い方・操作手順はここに集約し、拡充する。
- **CLAUDE.md（本ファイル）** … AI 開発のための情報のうち、全体像・構造・規約・運用。ユーザー向けの使い方は書かない。
- **.claude/rules/** … 領域別の実装ルールと落とし穴。実装の細部はここに書く（上の索引を参照）。

### ドキュメント校正ルール

**日本語のユーザー向けドキュメントを更新・追加したら、コミット前に必ず校正する。**

- 対象：`README.md` / `docs/manual/` 配下 / `CHANGELOG.md`（リリース時に足す新しいセクション）
- 対象外：`CLAUDE.md` と `e2e/README.md`（どちらも密な技術メモで、読み手が開発者）、英語で書く `SECURITY.md`

1. **textlint（機械チェック）** を npx で実行し、**今回書いた箇所**の ai-writing 系の指摘を 0 にする（既存の指摘は 4 を参照）:

   ```bash
   npx --yes --package textlint \
     --package textlint-rule-preset-ai-writing \
     --package textlint-rule-preset-ja-technical-writing \
     -- textlint --rule preset-ai-writing --rule preset-ja-technical-writing \
     README.md docs/manual/*.md CHANGELOG.md
   ```
   （リポジトリに textlint は未導入。実行は npx で都度行う）

2. **`japanese-tech-writing` スキル**（判断ベース）で、textlint が拾えない空句・冗長・演出・論証を点検する。

3. **守る表記規約**（textlint とスキル整形の両立で確立済み）:
   - 箇条書きの太字ラベルの区切りは**全角コロン**で `**用語**：説明` と書く。半角コロン `:` は `no-ai-list-formatting` に触れるため使わない。
   - 地の文・見出しで **em ダッシュ `—` を使わない**（全角コロンか句読点にする）。
   - 誇張語（「大幅に」等）・LLM 空句（「重要なのは」「正面から」「多角的」等）を使わない。
   - 二重助詞・一文内の過多カンマ（4 個以上）を避ける。

4. **据え置いてよい指摘**:
   - `no-mix-dearu-desumasu`（本文の「です・ます」と箇条書き・表セルの体言止めの混在）と、列挙が主因の `sentence-length`。マニュアルとして自然なので無理に潰さない。
   - **CHANGELOG の過去セクション**。出荷済みの記録なので、表記の一括正規化（全角コロンへの統一など）以外は書き換えない。校正するのはそのリリースで足す節だけ。
   - 誤検出の常連が 2 つある。UI 名やエスケープシーケンスに出るリテラルの `?`（`no-exclamation-question-mark`）と、行を折り返した括弧（`no-unmatched-pair` が閉じ括弧を見失う）。

5. **見出しを変更したら、ページ内アンカー（`](#...)`）との整合を確認する**。Pike のプレビューは見出しテキストを「小文字化＋`[^\p{L}\p{N}_\s-]` 除去＋空白→ハイフン」で slug 化して `id` を振る（`src/lib/slug.ts`）。アンカーはこの slug 規則に一致させる。

### コミット前チェック

**コミットの前は、変更の規模に応じて次を実行し、指摘を反映してからコミットする。**

| 変更の規模 | 実行するもの |
|---|---|
| ある程度の規模の実装・修正 | `/code-review` → `simplify` → `just check` |
| 軽微なコード修正 | `simplify` → `just check`（自明な 1 行修正などは直接コミットしてもよい） |
| ドキュメントのみ（`README.md` / `docs/manual/` / `CHANGELOG.md`） | 「ドキュメント校正ルール」の校正 ＋ `just check-docs` |
| CLAUDE.md / `.claude/rules/` のみ | `just check-docs`（開発者向けなので日本語校正の対象外） |
| バージョン bump のみ | 何も要らない |

- **順序を守る**。`/code-review`（バグ探索）で挙がったものを直してから `simplify`（再利用・単純化・効率・抽象度の品質整理）を回す。simplify はバグを探さないので、先に回しても直すべきコードを整えるだけになる。
- どちらもコードを書き換えるため、必ず**ユーザの動作確認より前**に実行する（ユーザは適用後のコードを試す）。
- `/code-review` はスキルとして実行できる。ユーザーが自分でコマンドを打つこともある。

その上でコミット前に **`just check`** を実行し、エラー・警告がゼロであることを確認する。中身は次の 6 つで、CI（`ci.yml`）も同じレシピを呼ぶ:

- **Frontend**: `just lint`（= `npm run lint` = `biome check src/`）
- **TypeScript 型検査**: `just typecheck`（= `npx vue-tsc --noEmit`。`tsc` ではなく `vue-tsc` を使うこと — Vue SFC の型チェックに必要）
- **ドキュメント整合**: `just check-docs`（= `node scripts/check-docs.mjs`）
- **ショートカット照合**: `just check-shortcuts`（= `tsx scripts/check-shortcuts.ts`。マニュアルの早見表と実装の割り当てを突き合わせる。#280）
- **Rust**: `just clippy`（= `src-tauri/` で `cargo clippy -- -D warnings`）
- **Rust テスト**: `just test`（= `src-tauri/` で `cargo test`）

### ドキュメント乖離のチェック

`npm run check:docs` は機械的に照合できる乖離だけを見る。落ちたらコミット前に直す。

1. `src/` と `src-tauri/src/` のファイルが CLAUDE.md のディレクトリ構成に載っているか（**新しいファイルを足したら構成にも 1 行足す**）
2. CLAUDE.md と `.claude/rules/` が挙げるファイルパスが実在するか（削除・改名の取り残し）
3. CLAUDE.md と `.claude/rules/` がバッククォートで挙げるシンボル名が実在するか（**関数の改名・削除の取り残し**。2 はパスしか見ないので、ここが無かったあいだに `build_git_command` のような死んだ名前が 9 件溜まった）。**README とマニュアルは対象外**（読み手が利用者で、架空の例が普通に出てくる）。他所の API と、「もう無い」と書くために出す名前は、スクリプト内の `EXTERNAL_NAMES` / `GONE_NAMES` に理由付きで並べる。**名前の出典として読むのは追跡ファイルだけ**（`git ls-files`）で、生成物や手元の作業ファイルは数えない。ここを歩き回りにすると「手元では通って CI で落ちる」が起きる（`src-tauri/gen/` で実際に踏んだ）
4. README とマニュアルが参照する画像が実在するか、逆に参照されない画像が残っていないか（画像の置き場は `docs/manual/img/` に集約する。README のヒーロー画像もここ。#279）
5. md 間のリンクとページ内アンカーが解決するか（`src/lib/slug.ts` と同じ slug 規則。あちらを変えるとスクリプトが検知して落ちる）

スクリプトで判定できない「説明が実装と合っているか」は、差分の性質から自分で判断する。**ユーザーに見える挙動を変えたら、実装と同じコミットで対応するドキュメントも直す**:

| 変えたもの | 直すドキュメント |
|---|---|
| UI の操作・表示 | `docs/manual/` の該当ページ（機能一覧レベルの変化なら README も） |
| 設定項目の追加・変更 | `docs/manual/settings.md` |
| キーボードショートカット | `docs/manual/shortcuts-and-cli.md` と `components/KeyboardShortcuts.vue` の一覧 |
| `pike` CLI の引数・サブコマンド | `docs/manual/shortcuts-and-cli.md` |
| 非自明な実装判断・定数・落とし穴 | `.claude/rules/` の該当ファイル（全体像・運用に関わるものは CLAUDE.md。数値は出典のコードを併記して drift を防ぐ） |

過去に溜まった乖離の実例（2026-07-30 の棚卸しで検出）: 新規ファイル 20 件超がツリー未記載、実在しない `useTerminalNotifications.ts` の記載、サイドバー一覧から TODO と Problems 落ち、`git init`（#156）とタブのツールチップ（#198）がマニュアル未記載、Problems パネルの説明が実装と不一致。**いずれも「実装した回のコミットで一緒に直していれば発生しなかった」もの**なので、まとめてやらずその場で直す。

2026-08-27（v0.43.0 前）の棚卸しでは、macOS 対応（#253）が入ったのに Windows 専用のままの記述が
README・マニュアル・CLAUDE.md に残っていたほか、次の 5 件が実装と食い違っていた: `testing.md` の
検証バイナリ一覧に `verify_busy.rs` が無い、`project.md` の「2 プラットフォーム」、`editor.md` の
「Windows: `std::fs` 直接アクセス」（実際の分岐は WSL かどうかだけ）、`docker.md` の TCP フォールバックの
位置づけ、`shortcuts-and-cli.md` の「タスクバーとシステムトレイ（Windows 専用）」（トレイは macOS でも動く）。
**プラットフォームを増やす変更は、この種の記述を横断的に古くする**ので、次に同じことをするときは
`grep -rn Windows` で全ドキュメントを一度洗う。

### コミット & push 運用ルール
個人開発のため、自分の変更に PR は作らない。Claude が変更を加えた場合は以下のフローを厳守:

1. **コミット前に必ずユーザの動作確認 OK を取る** — `cargo clippy` / `biome` / `vue-tsc` が通っていてもコミットしてはいけない。ユーザは GUI 上で実際に挙動を試す必要があるため、Claude が「テスト通った」だけで自動コミットすると確認前に履歴が確定してしまう。「コミットしていい？」と聞くか、ユーザが明示的に「コミットして」と言うまで待つ
2. **`main` ブランチに直接コミット**（feature ブランチや PR は作らない）
3. **`git push` は実行しない** — push の判断はユーザに委ねる（ユーザはローカル確認後に自分で push する運用）。**例外はリリース依頼時**（次項 5）
4. ユーザから明示的に「PR にして」「ブランチ切って」等の指示があった場合のみ、その指示に従う
   - **外部からの PR は来る**（#253 が実例）。取り込むときは通常のコミット前チェックと同じ扱いで、
     `/code-review` → `simplify` を回してから main へマージする。ロックファイルを共有する
     dependabot の PR は、1 件ずつマージするとリベース待ちが連鎖するので、ローカルでまとめて
     取り込んで push する（PR は依存が更新された時点で自動クローズされる）
5. **リリース依頼は end-to-end で Claude が実行する**: ユーザから「リリースして」と依頼されたら、それはバージョン bump コミットだけでなく、`main` の push・タグ作成と push・Release ワークフロー完了待ち・ドラフトのリリースノート記載と公開までの一括依頼。個別の push 確認は不要（「リリース手順」セクションの手順をそのまま完遂する）

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
async fn pty_write(id: String, data: String, state: State<'_, PtyState>) -> Result<(), String> {
    // ...
}
```

ストリーミングデータ（PTY stdout、Docker logs）は `emit` イベントで Rust → フロントに push する：

```rust
app_handle.emit("pty_output", PtyOutputPayload { id, data }).unwrap();
```

---

## リリース手順

新しいバージョンをリリースする際は、以下の手順を順番に実行する。ユーザからリリース依頼を受けたら、push・タグ・ドラフト公開まで含めて Claude がすべて実行する（通常のコミット運用と異なり push の個別確認は不要。CI の完了待ちはバックグラウンド watch で行う）。

### 1. rg サイドカーのバージョン確認

`scripts/download-rg.sh` の `VERSION` を [ripgrep のリリース](https://github.com/BurntSushi/ripgrep/releases)
と突き合わせ、新しい版が出ていれば上げる。上げたら**手元のバイナリを消してから取り直す**:

```bash
rm -f src-tauri/binaries/rg-*
just fetch-rg
```

**この確認を自動でやる仕組みは無い。** dependabot が見るのは npm / cargo / github-actions の
3 つで、シェルスクリプトの中のバージョン文字列は対象外。CI も同じスクリプトを呼ぶだけなので、
`VERSION` が古いままなら CI が作る成果物も古いままになる（毎回ダウンロードすることと、
毎回最新を取ることは別）。消してから取り直すのは、スクリプトがファイルの有無しか見ないため
（詳細は `.claude/rules/platform.md`）。

バイナリは `.gitignore` 済みなので、コミットするのは `scripts/download-rg.sh` だけ。
バージョン bump とは別のコミットにする（`chore: rg サイドカーを X.Y.Z に上げる`）。

### 2. バージョン番号の更新

```bash
just bump X.Y.Z
```

5 ファイルを一度に揃える。**手で編集しない**（取り残しが実際に何度も出ている）:

- `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
- `package.json` → `"version": "X.Y.Z"`
- `src-tauri/Cargo.toml` → `version = "X.Y.Z"`
- `Cargo.lock` … レシピが `cargo check` を走らせる
- `package-lock.json` … レシピが `npm install --package-lock-only` を走らせる

`scripts/bump-version.mjs` は置換が 1 箇所だけ当たることを確認してから書く（依存の version 行を巻き込んだら止まる）。`package-lock.json` は v0.38.0 まで手順から抜けていて、`0.37.0` のまま取り残されていた（dependabot 対応で lockfile を触ったときに発覚）。レシピにしたのはこれを繰り返さないため。

### 3. CHANGELOG.md の更新

**書く対象は前回のタグからの差分で洗い出す。**

```bash
git log --oneline <前回のタグ>..HEAD
```

**記憶で書かないこと。** そのセッションで対応した issue を思い出して並べると、**前のリリース
以降に積まれていた他の変更が丸ごと落ちる**。v0.47.0 で実際に踏んだ: 前回タグの直後に入っていた
3 件（#300 の文字化け、#283 の macOS 署名、#296 の TCC）が抜けたまま公開し、あとから
CHANGELOG とリリースノートを直すことになった。**公開してからでは直しても既読の人には届かない。**

同じ一覧を後述の「8. リリースの公開」のリリースノートにも使う（片方だけ直すとずれる）。

その上で `CHANGELOG.md` の先頭に新しいセクションを追加し、**「ドキュメント校正ルール」の校正を
かける**（今回足した節だけが対象。過去の節は出荷済みの記録なので触らない）。

### 4. スクリーンショットの撮り直し

**マイナー bump のリリースでは必ず撮り直す。** 画像には StatusBar のバージョンが写るので、
**bump 済みのツリーで撮る**（bump → 撮影 → 同期 → タグ の順。詳細は `.claude/rules/build.md`）。

```bash
just e2e-build           # 出力を | tail に通さないこと（落ちても 0 が返る）
just e2e
just e2e-sync-check      # 差分を確認してから
just e2e-sync            # マニュアルとヒーローの 2 本（枚数は各スクリプトが出す）
```

同期したら、代表的な画像を目視で確認する（バージョン表記と、その回で変えた UI が写っているか）。
あわせてマニュアルを棚卸しする: 新機能の記載漏れ、`grep -rn Windows` でのプラットフォーム記述の
古さ、「撮っているのに使われていない画像」（`.claude/rules/build.md` の comm のワンライナー）。

画像はバージョン bump とは別のコミットにする（`docs: vX.Y.Z でスクリーンショットを撮り直す`）。

### 5. コミット & プッシュ

```bash
git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock package-lock.json CHANGELOG.md
git commit -m "Bump version to vX.Y.Z"
git push origin main
```

**2 つの lockfile を含めること**。忘れると作業ツリーに drift が残り、あとから `chore: Cargo.lock を vX.Y.Z に同期` という追加コミットが必要になる（過去に何度も発生）。

### 6. Security Check の確認

GitHub Actions の `Security Check` ワークフローが成功することを確認する。

### 7. タグの作成 & プッシュ

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

タグ push で `Release` ワークフローが自動起動し、Windows と macOS(arm64) の 2 ジョブが
**Windows → macOS の順に直列で**同じドラフトへ成果物をアップロードする。**macOS 版も
Developer ID 署名・公証済みで、updater の対象**（#283。詳細は `.claude/rules/build.md`）。

**公開前に、ドラフトの `latest.json` の `platforms` に `windows-x86_64` と
`darwin-aarch64` の両方があることを確認する。** 片方の OS しか載っていない
`latest.json` を公開すると、もう片方の全クライアントが黙って更新を受け取れなくなる
（片方のジョブが落ちたときに起きうる。理由は `.claude/rules/build.md`）。
足りなければ公開せず、直してタグを打ち直す。

### 8. リリースの公開

ワークフロー完了後、GitHub Releases でドラフトを確認し、リリースノートを記載して公開する。
**中身は CHANGELOG に足した節から起こす**（手順 3 の `git log` で洗い出したもの）。両方を
別々に書くと、片方にしか無い項目ができる:

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

