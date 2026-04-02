# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-04-02

### Features

- **仮想デスクトップ対応** — 別デスクトップから Pike を起動した際、既存ウィンドウに切替えず新ウィンドウを開く（IVirtualDesktopManager COM API）
- **ステータスバー改善** — バージョン表示と GitHub リポジトリリンクを追加
- **CWD 検出改善** — Rust 側で PTY の cwd を返す方式に変更。TUI 動作中の PTY にコマンドが漏れる問題を解消
- **通常ターミナル保証** — プロジェクト展開時に autoStart なしのターミナルタブがなければ自動追加

### Fixed

- タブ切替時の TUI 再描画を改善（double rAF + サイズキャプチャ）
- clippy 警告をすべて解消、CI で `-D warnings` を有効化

### Developer Experience

- **Biome 導入** — フロントエンドの lint + formatter を統一。CI に `biome check` を追加
- CI: `core.autocrlf=false` で CRLF エラー修正、`npm audit --audit-level=critical` に変更

## [0.2.2] - 2026-04-01

### Features

- **ブランチマージグラフ** — Git パネルで List / Graph 切替。`git log --all` + 親ハッシュ・refs を取得し、レーン割当アルゴリズムで分岐・マージを SVG 描画。dark/light テーマ対応のレーンカラー
- **デスクトップ通知** — バックグラウンドタブのターミナル終了時に Windows トースト通知。Web Notification API 優先、Tauri plugin フォールバック。クリックでウィンドウフォーカス + タブ切替。Settings で ON/OFF 切替
- **ターミナル自動クローズ** — 非 pinned ターミナルタブはプロセス終了 1 秒後に自動クローズ
- **外部 URL オープン** — SideBar 歯車メニューに GitHub リンク追加。confirm ダイアログ付きで外部ブラウザ起動
- **Markdown リンク処理** — プレビュー内の外部 URL は confirm → ブラウザ、ローカルファイルリンクはプロジェクトルート内に限定して EditorTab で開く（ディレクトリトラバーサル防止、URL エンコード対応）

### Fixed

- タブ切替時に TUI アプリ（Claude Code 等）の表示が崩れる問題を修正（PTY resize nudge で SIGWINCH 発火）
- git log のレコード区切りを NUL → ASCII RS/FS に変更（`%D` 空文字との衝突で大半のコミットがパースできなかった問題を修正）
- `open_url` コマンドのシェルインジェクション脆弱性を修正（`cmd.exe /C start` → `explorer.exe` + http/https バリデーション）

### Dependencies

- `tauri-plugin-notification` 2（デスクトップ通知フォールバック用）

## [0.2.1] - 2026-04-01

### Features

- **クイックオープン (Ctrl+P)** — `rg --files` でファイル一覧を取得し、fzf 風ファジーマッチで絞り込み。`:行番号` でジャンプ、最近開いたファイルを上位表示
- **ターミナルアクティビティ通知** — 非アクティブなターミナルタブにアクセントカラーのドット表示、プロセス終了時に終了コードバッジ表示
- **Git ahead/behind 表示** — リモートとの差分件数をコミットボタン下にテキスト表示、pull/push 候補がある場合はボタンを primary スタイルに変更
- **SVG プレビュー** — エディタの Edit/Split/Preview トグルで SVG ファイルを DOMPurify サニタイズ付きで表示
- **プロジェクトパネル改善** — Windows プロジェクトにフォルダ選択ダイアログ (Browse)、名前順/最近使用順ソート切替
- **検索パネル修正** — 正規表現 OFF 時に `(` 等の特殊文字でエラーになる問題を修正

### Fixed

- ターミナルタブから別タブへ移動して戻った際に表示が崩れる問題を修正 (requestAnimationFrame + terminal.refresh)
- 「別ウィンドウで開く」ボタンが新ウィンドウを開かず既存ウィンドウにフォーカスするバグを修正 (is_visible チェック追加)
- i18n locale 切替が即座に反映されない問題を修正 (computed 経由でリアクティブ依存を確保)
- TerminalTab で PTY spawn 中に unmount された場合の TypeError を修正

### Dependencies

- `@types/dompurify` 削除 (dompurify 本体が型定義を提供)

## [0.2.0] - 2026-03-31

### Features

- **ファイル監視** — プロジェクト内のファイル変更をリアルタイム検知し、ファイルツリーを自動更新
  - Windows: `notify` クレート (ReadDirectoryChangesW)
  - WSL: `inotifywait` (inotify-tools)。未インストール時はファイルツリーに導入案内を表示
  - 200ms デバウンス + 1s max wait のバッチ処理で大量変更に対応
- **エディタ外部変更検知** — 開いているファイルが外部で変更された場合に自動リロード（未保存時は警告バー表示）
- **ファイルツリー新規作成** — コンテキストメニュー（フォルダ）とヘッダボタンから新規ファイル・フォルダを作成可能。ファイル作成後は自動でエディタタブを開く
- **CSV/TSV プレビュー** — エディタの Edit/Split/Preview トグルでテーブル表示。引用符対応パーサ、10,000行 truncate
- **PDF プレビュー** — WebView2 内蔵レンダリング（iframe + base64）
- **Mermaid プレビュー** — `.mermaid`/`.mmd` ファイルを Edit/Split/Preview トグルで SVG 描画。ズーム機能付き
- **Markdown 内 Mermaid** — ` ```mermaid ` コードブロックをプレビュー内で SVG にインライン描画

### Dependencies

- `notify` 7 (Rust ファイル監視クレート)
- `mermaid` 11 (Mermaid ダイアグラム描画)

## [0.1.4] - 2026-03-31

### Fixed

- リリースビルドでターミナル・エディタが正しく表示されない問題を修正 (CSP を無効化、XSS 防御は DOMPurify で維持)
- セルフアップデーターの「更新して再起動」実行時に TypeError が発生する問題を修正 (Vue Proxy と private fields の衝突を markRaw で回避)

## [0.1.3] - 2026-03-30

### Fixed

- セルフアップデーターの「更新して再起動」が失敗する問題を修正 (`process:default` capability 追加)
- アップデートエラー時に具体的なエラーメッセージを表示するよう改善
- リリースビルドでターミナルの色・フォント、エディタ内容が表示されない問題を修正 (CSP 調整)

## [0.1.2] - 2026-03-30

### Fixed

- Windows リリースビルドで wsl.exe 等のコンソールウィンドウが表示される問題を修正 (CREATE_NO_WINDOW)
- セルフアップデーターの署名パスワード環境変数を明示的に設定

## [0.1.1] - 2026-03-30

### Security

- Markdown プレビューの XSS 脆弱性を修正 (DOMPurify によるサニタイズ)
- Content Security Policy (CSP) を有効化し、インラインスクリプト実行を禁止
- プロジェクト操作コマンドに path traversal 防御を追加

### Dependencies

- bollard 0.18 → 0.20 (API 移行対応)
- portable-pty 0.8 → 0.9
- TypeScript 5.9 → 6.0
- actions/checkout v4 → v6, actions/setup-node v4 → v6

## [0.1.0] - 2026-03-30

Initial public release.

### Features

- **Multi-terminal tabs** — xterm.js + PTY (WSL / cmd / PowerShell / Git Bash)
- **AI agent support** — Claude Code, Codex etc. as pinned tabs with session resume (`claude --continue`)
- **File editor** — CodeMirror 6 with syntax highlighting (29 languages), minimap, search & replace, git diff gutter
- **Git panel** — staging, commit, push/pull, diff viewer, commit tree, branch switching
- **Docker panel** — compose services, start/stop/restart, live logs, `docker exec` shell
- **Project search** — ripgrep (bundled) / grep fallback
- **File tree** — drag & drop, rename, delete, git status icons, context menu
- **Session persistence** — tab order, active tab, pinned tabs auto-restored on restart
- **Dark / Light mode** — switchable from settings
- **i18n** — Japanese / English
- **pike CLI** — `pike file.rs:42` to open files, `pike <dir>` to switch projects
- **Multi-window** — open projects in separate windows
- **Self-updater** — check for updates from settings, auto-download & restart
