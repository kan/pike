# Changelog

All notable changes to this project will be documented in this file.

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
