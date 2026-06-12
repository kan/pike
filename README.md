# Pike

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)

Lightweight AI-coding-focused development environment — a fast alternative to VS Code for terminal-centric workflows.

Built with Tauri v2 (Rust + Vue/TypeScript). Windows-first.

![Editor with file tree](docs/screenshot-editor.png)

![Git panel with Claude Code](docs/screenshot-git.png)

## Features

- **Multi-terminal tabs** — xterm.js + PTY (WSL / cmd / PowerShell / Git Bash)
- **Terminal agent helpers** — for running `claude` & co. in a terminal: one-click launch/prompt buttons (configurable), clickable `file:line` in output (incl. `rg`/`grep`) to open the editor, and "send to terminal" from an editor selection or a diagnostic row
- **AI agents** — Claude Code & Codex as unified chat tabs (Agent runtime over ACP / Codex app-server), session resume, slash commands, `@`-mention file context
- **File editor** — CodeMirror 6 with syntax highlighting (30+ languages), minimap, search & replace, git diff gutter, jump-to-definition (Ctrl+Click / F12)
- **Previews** — Markdown, Mermaid, CSV/TSV, JSON/JSONL, SVG, images, PDF
- **Symbol outline** — outline panel (18 languages) with cursor follow + per-file git history
- **Task runner** — auto-discovers `package.json` / `Makefile` / `deno.json` scripts and runs them in a terminal tab
- **Command palette** — `Ctrl+P` for files, `>` tasks, `@` tabs, `:` line jump, `!` git branch
- **Git panel** — staging, commit, push/pull, diff viewer, commit & branch graph
- **Git worktree switcher** — status-bar selector re-points the file tree / git / search / tasks / docker / editor at a selected worktree, for reviewing parallel agent work in one window
- **Docker panel** — compose services, start/stop/restart, live logs, `docker exec` shell
- **Project search** — ripgrep (bundled) / grep fallback
- **File tree** — drag & drop, rename, delete, git status icons, file watcher auto-refresh
- **Multi-window** — open projects in separate windows
- **Session persistence** — tab order, active tab, pinned tabs auto-restored on restart
- **Dark / Light mode** — switchable from settings
- **i18n** — Japanese / English
- **Self-updater** — auto check & update from GitHub Releases
- **pike CLI** — `pike file.rs:42` to open files, `pike <dir>` to switch projects, `--wait` for `GIT_EDITOR`

## Install

Download the latest installer from [GitHub Releases](https://github.com/kan/pike/releases/latest):

| File | Description |
|------|-------------|
| `Pike_x.x.x_x64-setup.exe` | Windows installer (NSIS) — recommended |
| `Pike_x.x.x_x64_en-US.msi` | Windows installer (MSI) |

After installation, Pike will check for updates automatically. You can also check manually from the gear menu.

## Build from Source

### Prerequisites

- **Windows 11**
- **Node.js** >= 20
- **Rust** >= 1.77
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
- **WSL2** (optional — for WSL shell and Docker integration)

### Build & run

```bash
# Install dependencies
npm install

# Download bundled ripgrep binary
bash scripts/download-rg.sh

# Development (can run alongside installed Pike)
npm run tauri:dev

# Production build
npm run tauri build
```

### pike CLI

```bash
# Open a file (jumps to line 42)
pike src/main.rs:42

# Open a directory as project
pike .

# Open file via subcommand
pike open path/to/file.ts
```

## Architecture

```
Tauri WebView (Windows)
├── Vue 3 + Pinia (UI)
│   ├── xterm.js terminals
│   ├── CodeMirror 6 editor
│   └── Panels — file tree, git, search, docker, projects, tasks, outline
├── Tauri IPC
└── Rust backend
    ├── portable-pty — PTY management
    ├── bollard — Docker API
    ├── git CLI wrapper (WSL + Windows)
    └── File system ops (WSL + Windows)
```

## License

[MIT](LICENSE)
