# DevTerm — Claude Code ガイド

## プロジェクト概要

**DevTerm** は Tauri v2 (Rust + Vue/TypeScript) で構築する Windows 向け軽量開発環境。
「AI エージェント × ターミナル」に特化し、VS Code より大幅に軽いことが最重要の差別化点。

### 設計思想
- **軽さ最優先**: Monaco は使わない。CodeMirror 6 のみ。拡張機能システムは作らない
- **タブ統一**: エディタ・ターミナル・Docker logs をすべて同一タブで扱う
- **Rust はステートレスに**: Rust は I/O ブリッジに徹する。セッション復帰は各ツールの resume 機能（`claude --continue` 等）に委譲
- **外部依存は明示**: rg なければ grep、と graceful degrade する。tmux はオプション機能

### ターゲット環境
- **OS**: Windows 11（メイン開発・動作環境）
- **実体**: WSL2 (Ubuntu) 上のシェル・プロセス、その上の Docker コンテナ
- **GUI**: Tauri v2 webview (Windows ネイティブプロセス)

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
devterm/
├── CLAUDE.md                  # このファイル
├── MILESTONE.md               # マイルストーン・進捗管理
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs            # Tauri エントリポイント
│       ├── pty/
│       │   ├── mod.rs         # PTY 管理・ConPTY ラッパー
│       │   └── session.rs     # tmux セッション管理
│       ├── git/
│       │   └── mod.rs         # git2 ラッパー
│       ├── fs/
│       │   └── mod.rs         # ファイルツリー・notify
│       ├── search/
│       │   └── mod.rs         # rg/grep ラッパー
│       ├── docker/
│       │   └── mod.rs         # bollard ラッパー
│       └── project/
│           └── mod.rs         # プロジェクト設定の永続化
├── src/                       # Vue/TypeScript フロント
│   ├── App.vue
│   ├── main.ts
│   ├── components/
│   │   ├── layout/
│   │   │   ├── SideBar.vue    # アイコンナビ + パネル
│   │   │   └── TabPane.vue    # タブバー + コンテンツ
│   │   ├── panels/
│   │   │   ├── FileTree.vue
│   │   │   ├── GitPanel.vue
│   │   │   ├── SearchPanel.vue
│   │   │   ├── DockerPanel.vue
│   │   │   └── ProjectPanel.vue
│   │   └── tabs/
│   │       ├── TerminalTab.vue   # xterm.js
│   │       ├── EditorTab.vue     # CodeMirror 6
│   │       └── DockerLogsTab.vue
│   ├── stores/
│   │   ├── tabs.ts            # タブ状態管理 (Pinia)
│   │   ├── sidebar.ts         # サイドバー状態
│   │   └── project.ts         # 現在のプロジェクト
│   └── lib/
│       └── tauri.ts           # IPC ラッパー
└── .claude/
    └── rules/
        ├── rust.md            # Rust 実装ルール
        ├── frontend.md        # フロント実装ルール
        └── testing.md         # テスト方針
```

---

## 現在のフォーカス

**→ MILESTONE.md の「現在のマイルストーン」セクションを参照**

実装を始める前に必ず MILESTONE.md で現在の M番号と完了条件を確認すること。

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

### PTY / WSL2
- PTY 管理は `portable-pty` クレートを使う（ConPTY 対応済み）
- spawn コマンドは `wsl.exe`、引数で bash を指定
- 環境変数 `TERM=xterm-256color` を必ず渡す
- リサイズは `pty.resize()` で PTY サイズを更新

### セッション復帰
- AI エージェントのセッション復帰は各ツールの resume 機能に委譲
  - Claude Code: `claude --continue`
  - Codex: 対応する resume オプション
- tmux はオプション機能として `pty_spawn_tmux` コマンドで利用可能（必須ではない）

### Docker / bollard
- フォールバック戦略で接続（musql と同一パターン）:
  1. `Docker::connect_with_local_defaults()` — named pipe / DOCKER_HOST 環境変数
  2. `Docker::connect_with_http("tcp://127.0.0.1:2375")` — WSL2 dockerd (unencrypted)
  3. `Docker::connect_with_http("tcp://127.0.0.1:2376")` — WSL2 dockerd (encrypted)
- 各接続で `ping()` して到達確認、最初に成功したものを使う
- Docker Desktop なしでも WSL2 の dockerd が TCP を公開していれば接続可能

### CodeMirror 6
- シンタックスハイライトのみ、LSP・補完は実装しない
- 言語パッケージは使うもの（Go, Rust, TypeScript, Vue, YAML 等）だけ import
- ファイル保存は `Ctrl+S` → `invoke('fs_write_file', ...)`

### 検索 (rg / grep)
- 起動時に `which rg` で backend 判定、以降固定
- rg: `rg --json -F/-e --glob` でパース容易な出力
- grep: `grep -rn --include/--exclude` でフォールバック
- フロントには検索バックエンドをバッジ表示

---

@import .claude/rules/rust.md
@import .claude/rules/frontend.md
@import .claude/rules/testing.md
