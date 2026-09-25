# ディレクトリ構成

Pike のファイル単位の構成。CLAUDE.md の「ディレクトリ構成」から切り出したもので、起動時には
読み込まない。**`src/` と `src-tauri/src/` にファイルを足したら、ここにも 1 行足す**
（`just check-docs` がファイル名で照合する。`mod.rs` は親ディレクトリ名で照合する）。

```
pike/
├── CLAUDE.md                  # AI 開発向け: 全体像・規約・運用
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
├── tests/                     # フロントの純粋なロジックのテスト（*.test.ts。just test-ts、#403）
├── src-tauri/
│   ├── Cargo.toml
│   ├── rustfmt.toml       # Rust の整形設定（#313。max_width = 100）
│   ├── tauri.conf.json
│   ├── Info.plist         # macOS の TCC 許可ダイアログの説明文（#296。tauri がマージする）
│   ├── entitlements.plist # macOS の hardened runtime のリソースアクセス（#296。XML コメント不可）
│   └── src/
│       ├── main.rs            # Tauri エントリポイント
│       ├── lib.rs             # Tauri Builder 設定・コマンド登録
│       ├── types.rs           # ShellConfig・WSL_EXTRA_PATH・bash_quote 等の共通型/ヘルパー
│       ├── agents.rs          # PATH にあるエージェントの検出（#275。一覧はフロントの表）
│       ├── agent_hook.rs      # エージェントの hook からの申告を受ける口（#299。`pike agent-hook`）
│       ├── agent_sessions.rs  # 再開できる過去セッションの一覧（#267。出所は 4 つとも違う）
│       ├── agent_usage/
│       │   ├── mod.rs         # 使用量を種別に依らない形で返す（#263。id でアダプタへ振り分け）
│       │   ├── copilot.rs     # Copilot の premium request（~/.copilot の events.jsonl）
│       │   └── opencode.rs    # opencode のトークンと費用（`opencode db … --format json`）
│       ├── font.rs            # フォント列挙（font-kit でモノスペース検出）
│       ├── cli.rs             # CLI 引数パース・CliState・single-instance 連携
│       ├── wait.rs            # `pike --wait`（GIT_EDITOR 連携）・WM_COPYDATA 待機管理
│       ├── elevate.rs         # 管理者ターミナル（--new-instance で昇格起動、#138）
│       ├── browser.rs         # ブラウザのタブの子 webview（#368。`unstable` の `add_child`）
│       ├── html_preview.rs    # HTML のプレビューの配信（#399。`pike-preview` のスキームと仮想ファイル）
│       ├── site_rules.rs      # ドメインごとの JS と CSS を差し込むスクリプトの組み立て（#368）
│       ├── jira/              # Jira の拡張機能の JS（#380。jirapp から写した正本。site_rules.rs が include_str! で埋め込む）
│       ├── http.rs            # 外部ホストへの取得の共通部（クライアント使い回し・上限付き読み）
│       ├── page_title.rs      # 貼り付けた URL のページタイトル取得（Markdown リンク、#241）
│       ├── favicon.rs         # ブラウザのタブに出すサイトのアイコンの取得（#400）
│       ├── remote_image.rs    # 承認済みホストの画像取得（Markdown プレビュー、#239）
│       ├── cache.rs           # mtime キャッシュと、キーごとの probe レジストリ（#315）
│       ├── shell_probe.rs     # シェルに PATH と環境変数を 1 回で聞く共有部（#275）
│       ├── ssh_agent.rs       # 鍵を ssh-agent に預ける（#386。パスフレーズは子の stdin 経由）
│       ├── settings_sync.rs   # 設定・プロジェクト一覧の同期ファイル読み書き（#164）
│       ├── settings_gist.rs   # 設定の同期の同期先としての GitHub Gist（#403。`gh api` 経由、本文は標準入力）
│       ├── window_geom.rs     # プロジェクト単位のウィンドウ geometry（#200）と仮想デスクトップ（#317）
│       ├── drop_paths.rs      # タブバーへの OS ファイルドロップの実パス解決（WebView2 COM）
│       ├── ime_debug.rs       # IME 調査用の一時ログ（原因判明後に削除する）
│       ├── vdesk/mod.rs       # 仮想デスクトップ（#317、Windows 専用 COM。他 OS は stub）
│       ├── jumplist/mod.rs    # タスクバーのジャンプリスト（#160、Windows 専用 COM）
│       ├── appmenu/mod.rs     # macOS のアプリケーションメニュー（#254、macOS 専用）
│       ├── tray/mod.rs        # システムトレイ（#161）
│       ├── toast/
│       │   ├── mod.rs         # デスクトップ通知（#318、Windows 専用。押すとウィンドウが前に出る）
│       │   └── activation.rs  # 押されたことを受ける `pike://` の組み立てと読み取り（#334）
│       ├── diagnostics/mod.rs # 外部リンタ実行 → Problems パネル
│       ├── codex_usage/mod.rs # 間接 Codex（CLI）のトークン使用量集計（~/.codex 解析）
│       ├── claude_usage/
│       │   ├── mod.rs         # Claude Code のトークン使用量集計（~/.claude ログ解析）
│       │   ├── config.rs      # CLAUDE_CONFIG_DIR の解決とアカウント読み出し（#225）
│       │   ├── rate.rs        # `claude -p "/usage"` のレート制限パース（#117）
│       │   └── sessions.rs    # 再開できる過去セッションの Claude ぶんの収集（#220。口は agent_sessions.rs）
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
│       └── bin/               # 検証バイナリ（verify_pty / verify_tmux / verify_bollard / verify_busy / verify_toast）
├── src/                       # Vue/TypeScript フロント
│   ├── App.vue                # ルート（PTY ルーター初期化・プロジェクト復元）
│   ├── main.ts
│   ├── i18n/                  # 国際化（日英）: index.ts（useI18n/locale）+ en.ts / ja.ts
│   ├── types/
│   │   ├── tab.ts             # Tab Union type・ShellType・SidebarPanel・共通ヘルパー
│   │   ├── project.ts         # ProjectConfig・PinnedTabDef
│   │   ├── agentUsage.ts      # 使用量の共通の形（#263。種別ごとの型を持たない）
│   │   ├── agentSession.ts    # 再開できるセッション 1 件（#267）
│   │   ├── js-beautify.d.ts   # js-beautify の型（同梱されないので使う 3 関数だけ宣言、#366）
│   │   ├── diagnostics.ts  docker.ts
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
│   │   ├── AgentSessionsMenu.vue # 「最近のセッション」の行とサブメニュー（起動メニューの 2 か所で共有、#267）
│   │   ├── ProjectIcon.vue      # プロジェクトの絵文字アイコン（#203）
│   │   ├── WatcherNotice.vue    # ファイル監視の知らせの帯（ツリーと設定画面で共有、#385）
│   │   ├── ToolNotice.vue       # 足りないツールの帯の見た目（ファイル監視と ripgrep で共有）
│   │   ├── layout/
│   │   │   ├── ProjectSelect.vue # プロジェクトの表示と切替（サイドバー上部 / タブバー左、#298）
│   │   │   ├── SideBar.vue    # アイコンナビ + パネル
│   │   │   ├── TabPane.vue    # 作業領域（1〜2 ペイン）とタブの中身の配置（#308）
│   │   │   ├── TabBar.vue     # 1 ペインぶんのタブバー（+ / シェル選択 / 各種メニュー、#308）
│   │   │   ├── TabItem.vue    # タブバーの 1 枚（固定タブの列と通常の列で共有、#305）
│   │   │   ├── TabIcon.vue    # タブの種別のアイコン（タブバーと溢れた一覧で共有、#400）
│   │   │   └── StatusBar.vue  # ブランチ/worktree セレクタ/ahead-behind/トークン使用量/エンコード/改行/repo リンク
│   │   ├── panels/
│   │   │   ├── FileTreePanel.vue  # ファイルツリー
│   │   │   ├── ProjectPanel.vue   # プロジェクト一覧・登録・編集・削除（GroupComboBox/ProjectListItem に分割）
│   │   │   ├── GroupComboBox.vue  ProjectListItem.vue  ColorSelect.vue  IconSelect.vue
│   │   │   ├── AllowedHostList.vue # 承認済みホストの一覧（設定画面。画像 #239 とリンク #311 で共有）
│   │   │   ├── ProfileRow.vue     # 並べ替え + 表示/非表示の 1 行（シェル #129 とエージェント #275 で共有）
│   │   │   ├── ProjectPlatformFields.vue # プラットフォーム/distro/シェルの選択欄（#373 以降は編集フォームだけ）
│   │   │   ├── GitPanel.vue  SearchPanel.vue  DockerPanel.vue  TasksPanel.vue
│   │   │   ├── DiagnosticsPanel.vue # Problems（外部リンタの結果・🤖 で修正依頼を注入）
│   │   │   ├── IssuesPanel.vue    # GitHub issue の一覧（gh 経由、#278）
│   │   │   ├── BrowserPanel.vue   # ブラウザのタブの新しいタブ・ブックマーク・閲覧履歴（#368）
│   │   │   ├── SiteRuleList.vue   # ドメインごとの JS と CSS のルールの一覧（設定画面、#368）
│   │   │   ├── OutlinePanel.vue   # シンボルアウトライン
│   │   │   └── outline/           # OutlineTreeView.vue / OutlineHistoryView.vue
│   │   ├── editor/
│   │   │   ├── FindBar.vue          # タブ右上に浮く検索バー（diff タブ #176 とプレビュー #360 で共有）
│   │   │   ├── HtmlPreview.vue      # HTML のプレビュー（#399。子 webview を Preview / Split の枠に重ねる）
│   │   │   ├── MacroButtons.vue     # キーボードマクロの記録・再生ボタン（#180）
│   │   │   ├── MarkdownToolbar.vue  # Markdown 入力支援のボタン列（#241）
│   │   │   ├── MinimapToggle.vue    # ミニマップの表示切り替え（タブ単位、#282）
│   │   │   └── WrapToggle.vue       # 折り返しの切り替え（タブ単位、#241）
│   │   ├── settings/          # 設定画面の器（#314。節・小見出し・1 項目・一致の強調）
│   │   │   ├── SettingSection.vue  # 1 セクション（左ナビの飛び先）
│   │   │   ├── SettingGroup.vue    # セクションの中の小見出し
│   │   │   ├── SettingItem.vue     # 1 項目（名前と説明を i18n キーで受けて描く）
│   │   │   ├── SettingToggle.vue   # 並んだボタンから 1 つ選ぶ（ON/OFF・3 択）
│   │   │   └── HighlightText.vue   # 絞り込みに一致した部分の強調
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
│   │       ├── CommitTab.vue      # コミット 1 つのメッセージと全ファイルの差分（グラフ表示のクリック、#374）
│   │       ├── BrowserTab.vue     # 外部のページ（子 webview をタブの領域に重ねる、#368。試作）
│   │       ├── AgentStatusTab.vue # エージェント状態（/status 相当。アカウント・レート・トークン、#226）
│   │       ├── SyncConflictsTab.vue # 設定の同期の衝突を項目ごとに選ぶ（#403）
│   │       └── SettingsTab.vue    # 設定画面（8 セクションの中身と左ナビ・絞り込みの入力欄、#314）
│   ├── stores/
│   │   ├── tabs.ts            # タブ状態管理 (Pinia)
│   │   ├── sidebar.ts  settings.ts  project.ts
│   │   ├── fileTree.ts  git.ts  search.ts  docker.ts  tasks.ts  worktree.ts
│   │   ├── diagnostics.ts  issues.ts
│   │   ├── browser.ts         # ブラウザのタブの閲覧履歴（#368。マシンごと。ブックマークは settings.ts）
│   │   ├── sync.ts            # 設定の同期の調停役（#403。同期するのは main だけ、衝突は保留して選ばせる）
│   │   ├── agents.ts          # 使えるエージェントの検出（シェル単位、#275）
│   │   ├── agentUsage.ts      # エージェントごとの使用量ストア（表 1 行につき 1 本、#263）
│   │   ├── shellProbe.ts      # 「シェルごとに 1 回だけ聞いて覚える」の共通部（#275）
│   │   ├── usageStore.ts      # createUsageStore ファクトリ（ポーリング基盤）
│   │   └── statusMessage.ts   # StatusBar 汎用メッセージ（jumpTo 進捗等）
│   ├── composables/
│   │   ├── useAgentHookPrompt.ts  # hook の登録をシェルごとに 1 度だけ聞く（#299 / #265）
│   │   ├── useAgentMenu.ts    # エージェントの起動メニューの構成と再開一覧（#375。ターミナルの起動ボタンとタブバーの ▾ で共有）
│   │   ├── useAgentNotice.ts  # エージェントの入力待ちを受けて通知する（#265）
│   │   ├── useKeyboardShortcuts.ts  useShortcutsModal.ts
│   │   ├── useAppActions.ts  # ショートカットと macOS メニューが共有する動作の実体（#254）
│   │   ├── useAppMenu.ts     # macOS のメニューバーからの操作を受ける（#254）
│   │   ├── useBusyExit.ts    # Pike ごと終了する前の確認（#178。close と ⌘Q が共有）
│   │   ├── useConfirmDialog.ts  usePtyRouter.ts  useFsWatcher.ts  useCliOpen.ts  useAnchoredPopup.ts
│   │   ├── useCopyOnSelect.ts # 選択した文字列をクリップボードへ（#342。#408 で常に / 毎回確認 / OFF の 3 値。値の定義は lib/copyOnSelect.ts）
│   │   ├── useCsvSelection.ts # CSV プレビューの列・行の選択とタブ区切りのコピー（Excel 風）
│   │   ├── useTerminalUrlLinks.ts # 出力の URL のリンク化を設定で付け外しする（#343）
│   │   ├── useDragResize.ts  # 横幅を変えるドラッグの配線（サイドバーの幅・diff の分割線、#297）
│   │   ├── useTabDrag.ts     # タブを掴んでいるあいだの状態（2 本のタブバーで共有、#308）
│   │   ├── useProjectAccent.ts # プロジェクトカラーを面として塗るための色の組（#298）
│   │   ├── useActiveFile.ts  # いま見ているファイル（ツリーと Git パネルの強調、#274）
│   │   ├── useFocusPolling.ts # アクティブなあいだだけポーリングする共通部（#277）
│   │   ├── usePanelAvailability.ts # サイドバーのパネルが使えるかの唯一の出典（#278）
│   │   ├── useSettingsSearch.ts # 設定画面の絞り込み（#314。登録・一致・強調の切り分け）
│   │   ├── useDockerLogRouter.ts  useAgentUsage.ts
│   │   ├── useBrowserRouter.ts # ブラウザのタブへの通知をラベルで振り分ける（#368。usePtyRouter と同じ形）
│   │   ├── useChildWebview.ts # 子 webview の位置合わせ・隠す・閉じる（#399。ブラウザのタブと HTML のプレビューで共有）
│   │   ├── useDragAndDrop.ts  useEditorInfo.ts  useImagePaste.ts
│   │   ├── useOutlineSource.ts  useUpdater.ts  useTerminalInject.ts
│   │   ├── usePreviewFind.ts # プレビューの検索（#360。数え直しと移動の契機）
│   │   ├── useTerminalPeek.ts # 別プロジェクトのターミナルを外から覗く口（#319）
│   │   ├── useMarkdownImages.ts  # Markdown への画像挿入（選択/貼り付け/ドロップ、#241）
│   │   ├── useMarkdownLinkPaste.ts # 貼り付けた URL をタイトル付きリンクにする（#241）
│   ├── lib/
│   │   ├── fileIcons.ts  tabIcons.ts  fontDetection.ts  tauri.ts  window.ts  paths.ts  storage.ts  format.ts  notify.ts
│   │   ├── pikeDir.ts        # .pike/ の作成と .gitignore の設置（アップロードの置き場）
│   │   ├── reorder.ts        # ドラッグでの並べ替え（プロジェクト一覧とサイドバーのアイコン列、#364）
│   │   ├── syncMerge.ts      # 設定の同期の 3-way マージ（#403。種別を知らない純粋な計算）
│   │   ├── syncFormat.ts     # 同期ファイルとマージの項目の行き来・同期の種類（#403）
│   │   ├── browserIcons.ts   # ブラウザのタブのサイトのアイコン（#400。オリジンごとに覚える）
│   │   ├── browserHandoff.ts # 別プロジェクトの同じ URL のタブへ子 webview を譲る（#402）
│   │   ├── overlay.ts        # 手前に浮いているものの数（#396。ブラウザのタブの子 webview を隠す判断）
│   │   ├── fileType.ts       # ファイル名 → 種別のキー（#347。ハイライト/アウトライン/ジャンプ/アイコンが共有）
│   │   ├── codeHighlight.ts  # プレビューのコードブロックの色付け（#359。4 つのプレビューで共有）
│   │   ├── csvPreview.ts     # CSV プレビューの表（読み込み・並べ替え・ページ送りの HTML）
│   │   ├── copyOnSelect.ts   # ターミナルの「選択時にコピー」の 3 値と、古い版の真偽値との読み替え（#408）
│   │   ├── domFind.ts        # 描画済み DOM の文字検索と CSS Custom Highlight の登録（#360）
│   │   ├── host.ts           # ホスト OS の判定とホスト依存の既定値（出し分けの唯一の出典）
│   │   ├── keys.ts           # ショートカットの修飾キー判定（mac は Cmd / 他は Ctrl、#254）
│   │   ├── agents.ts        # Pike が知っているエージェントの表（#275。id・起動コマンドの正本）
│   │   ├── shortcuts.ts     # ショートカットの割り当て表（#254。キーの正本）
│   │   ├── usageFormat.ts    # レート枠の表示整形と `Meter` 型（StatusBar と状態タブで共有、#226）
│   │   ├── issueTree.ts      # issue の親子を `parent` だけで組んで平らに落とす（#278）
│   │   ├── issueRefs.ts      # 本文の `#123` を別 issue タブへのリンクにする（marked 拡張、#278）
│   │   ├── issuePrompt.ts    # エージェントに渡す issue の指示文（#336。注入とコピーで共有）
│   │   ├── commitPatch.ts    # コミット全体の差分をファイルごとの統合形式の行に落とす（#374）
│   │   ├── gitGraph.ts  gitRemote.ts  gitignore.ts  diffParser.ts  diffExpand.ts  diffSearch.ts  languages.ts  mermaid.ts  popupPosition.ts
│   │   ├── frontmatter.ts  frontmatterParse.ts  # Markdown フロントマターの範囲検出 / 値のパース（#229）
│   │   ├── markdownFootnotes.ts  # プレビューの脚注（marked 拡張、#241）
│   │   ├── rstPreview.ts      # reStructuredText のプレビュー（自前の変換、#284）
│   │   ├── displayWidth.ts    # 等幅フォントでの表示幅（diff の横幅と rst の表が共有、#284）
│   │   ├── text.ts            # HTML 組み立ての共有部（Html 型・エスケープ・CSV 分割、#284）と文字列の一致位置（`findRanges`）
│   │   ├── sanitizeHtml.ts    # DOMPurify に渡す URI スキームの許可（4 つのプレビューで共有、#311）
│   │   ├── externalImages.ts  # プレビューの外部画像のホスト判定と取得キャッシュ（#239）
│   │   ├── terminalLinks.ts  shellIcons.ts  projectColors.ts  projectIcons.ts  projectPaths.ts
│   │   ├── themeModes.ts      # テーマのモードのアイコンと文言（設定画面とステータスバーで共有、#407）
│   │   ├── openFile.ts        # 拡張子でタブ種別を振り分ける唯一の入口（editor/preview/pdf）
│   │   ├── openUrl.ts         # 外部ブラウザで URL を開く唯一の入口（確認とホストの許可、#311）
│   │   ├── tabTitle.ts        # タブの表示名（シングルトンタブは kind から i18n を引く）
│   │   ├── manual.ts  slug.ts # アプリ内マニュアルの読み込みと見出しスラッグ
│   │   ├── dropPaths.ts       # WebView2 経由でドロップされたファイルの実パス取得
│   │   ├── imeDebugLog.ts  imeFocusPark.ts  # IME 調査用（原因判明後に削除する）
│   │   ├── editorGitGutter.ts  editorMinimap.ts  editorThemes.ts  editorSearch.ts
│   │   ├── editorFormat.ts   # クイック整形（#366。JSON / js-beautify / 行の整形）
│   │   ├── editorLoadMore.ts # 部分読み込みの「続きを読む」を本文の末尾に出す（#362）
│   │   ├── editorPathJump.ts # 本文の `パス:行` を Ctrl+Click / F12 で開く（#376。検索結果の書き出しのタグジャンプ）
│   │   ├── editorMacro.ts    # キーボードマクロの記録と再生（#180。サクラエディタ風）
│   │   ├── editorJumpTo.ts  editorConflict.ts  editorDiagnostics.ts  editorMarkdown.ts
│   │   ├── editorPresetKeys.ts # ショートカットのプリセットで変わる CodeMirror のキー（#261）
│   │   ├── jumpTo/            # 定義ジャンプ（findInFile/parseImports/resolveImport/vueComponent）
│   │   └── outline/           # アウトライン抽出（index.ts + extractors/ 18 言語）
│   └── assets/
│       └── theme.css          # CSS Variables テーマ定義（ダーク/ライト）
└── .claude/
    ├── structure.md       # このファイル
    ├── rules/             # 領域別の実装ルール（paths: で必要なときだけ読み込む。索引は CLAUDE.md）
    └── skills/
        └── release/SKILL.md  # リリース手順
```
