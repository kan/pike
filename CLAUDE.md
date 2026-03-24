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
hearth/
├── CLAUDE.md                  # このファイル
├── MILESTONE.md               # マイルストーン・進捗管理
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs            # Tauri エントリポイント
│       ├── lib.rs             # Tauri Builder 設定・コマンド登録
│       ├── types.rs           # ShellConfig 等の共通型定義
│       ├── pty/
│       │   └── mod.rs         # PTY 管理（WSL/cmd/PowerShell/Git Bash 対応）
│       └── project/
│           └── mod.rs         # プロジェクト CRUD・WSL ディストロ検出
├── src/                       # Vue/TypeScript フロント
│   ├── App.vue                # ルート（PTY ルーター初期化・プロジェクト復元）
│   ├── main.ts
│   ├── types/
│   │   ├── tab.ts             # Tab Union type・ShellType・共通ヘルパー
│   │   └── project.ts         # ProjectConfig・PinnedTabDef
│   ├── components/
│   │   ├── ProjectSwitcher.vue  # fzf 風プロジェクト切替 + 新規作成モーダル
│   │   ├── layout/
│   │   │   ├── SideBar.vue    # アイコンナビ + パネル
│   │   │   └── TabPane.vue    # タブバー + コンテンツ + シェル選択
│   │   ├── panels/
│   │   │   ├── FileTreePanel.vue  # ファイルツリー（stub）
│   │   │   └── ProjectPanel.vue   # プロジェクト一覧・登録・編集・削除
│   │   └── tabs/
│   │       └── TerminalTab.vue    # xterm.js + PTY（autoStart 対応）
│   ├── stores/
│   │   ├── tabs.ts            # タブ状態管理 (Pinia)
│   │   ├── sidebar.ts         # サイドバー状態
│   │   └── project.ts         # プロジェクト管理・切替・永続化
│   ├── composables/
│   │   ├── useKeyboardShortcuts.ts  # Ctrl+T/W/Tab/Shift+P
│   │   └── usePtyRouter.ts         # PTY イベント集中ルーター + CWD 検出
│   ├── lib/
│   │   └── tauri.ts           # IPC ラッパー
│   └── assets/
│       └── theme.css          # CSS Variables テーマ定義
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

### プロジェクト管理
- プロジェクト設定は `%APPDATA%/com.tauri.dev/projects/{id}/project.json` に保存
- 最後に開いたプロジェクト ID を `last_project.txt` に永続化し、起動時に自動復元
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
- Ctrl+S で保存、ダーティ表示（タブタイトルに `*`）
- ファイルツリーに git ステータス色表示（precomputed Map で O(1) ルックアップ）
- 画像プレビュータブ（base64 経由）、Markdown プレビュー（Edit/Split/Preview 3モード、スクロール同期、250ms デバウンス）
- 文字コード対応: `encoding_rs` で自動検出 + 指定エンコードでの開き直し/保存（StatusBar 2段階 UI）
- 改行コード LF/CRLF 切替（StatusBar クリック）、保存時に適用
- ファイルツリーコンテキストメニュー: リネーム（インライン入力）、削除（confirm）、Git History（専用タブ）
- ドラッグ&ドロップ移動 + Ctrl でコピー（`dragDropEnabled: false` で Tauri ネイティブ D&D を無効化）
- ダーティエディタタブの閉じ確認ダイアログ
- WSL コマンドにパス引数前の `--` を付与（フラグ injection 防止）

### Git 統合
- `git` CLI 経由（WSL/Windows 両対応）。`git2` クレートは使わない
- Rust 側 `build_git_command` が ShellConfig に応じて `wsl.exe git` / `git` を組み立て
- ステータスバーにブランチ名+ダーティ表示、クリックでブランチ切替
- Git パネル: ステージング/アンステージ、コミット、push/pull、コミットツリー展開
- diff タブ: 左右分割表示、文字単位ハイライト（common prefix/suffix 方式）
- コミットログは `%B`（全文）取得、一覧は1行目のみ表示、ホバーで全文ツールチップ

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
