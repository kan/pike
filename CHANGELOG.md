# Changelog

All notable changes to this project will be documented in this file.

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
