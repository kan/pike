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
│   │   ├── ConfirmDialog.vue    # カスタム確認ダイアログ（Teleport）
│   │   ├── layout/
│   │   │   ├── SideBar.vue    # アイコンナビ + パネル
│   │   │   └── TabPane.vue    # タブバー + コンテンツ + シェル選択
│   │   ├── panels/
│   │   │   ├── FileTreePanel.vue  # ファイルツリー
│   │   │   └── ProjectPanel.vue   # プロジェクト一覧・登録・編集・削除
│   │   └── tabs/
│   │       ├── TerminalTab.vue    # xterm.js + PTY（autoStart 対応）
│   │       └── SettingsTab.vue    # 設定画面（フォント・カラースキーム・ダークモード・エディタ設定）
│   ├── stores/
│   │   ├── tabs.ts            # タブ状態管理 (Pinia)
│   │   ├── sidebar.ts         # サイドバー状態
│   │   ├── settings.ts        # アプリ設定（フォント・カラースキーム・ダークモード・エディタ設定）
│   │   └── project.ts         # プロジェクト管理・切替・永続化
│   ├── composables/
│   │   ├── useKeyboardShortcuts.ts  # Ctrl+T/W/Tab/Shift+P
│   │   ├── useConfirmDialog.ts      # カスタム確認ダイアログ composable
│   │   └── usePtyRouter.ts         # PTY イベント集中ルーター + CWD 検出
│   ├── lib/
│   │   ├── fileIcons.ts       # material-file-icons ラッパー（キャッシュ付き）
│   │   ├── fontDetection.ts   # フォント名ユーティリティ（buildFontFamily/extractFontName）
│   │   ├── editorGitGutter.ts # CodeMirror 6 git diff ガター拡張
│   │   ├── editorMinimap.ts   # CodeMirror 6 ミニマップ（Canvas 描画）
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
- `PtySession` に `Drop` 実装: セッション破棄時に `child.kill()` で子プロセスを確実に終了
- ウィンドウ破棄時（`WindowEvent::Destroyed`）に全 PTY セッション・Docker log stream を一括 cleanup（main ウィンドウのみ）

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
- Ctrl+S で保存、ダーティ表示（タブタイトルに `*`）。Ctrl+Z/Shift+Z で Undo/Redo
- エディタ内検索・置換: Ctrl+F / Ctrl+H でカスタム検索パネル（右上フローティング、アイコンボタン、マッチ数表示）
- Git diff ガター: 追加行（緑）・変更行（黄）・削除行（赤三角）をガターに表示。`git_diff_lines` コマンドで行単位の差分を取得
- ミニマップ: Canvas ベースの縮小表示、ビューポートインジケータ、クリック/ドラッグでスクロール、diff 色表示付き
- エディタコンテキストメニュー: Undo/Redo/Cut/Copy/Paste/Git History（Teleport パターン）
- ファイルツリーに git ステータス色表示（precomputed Map で O(1) ルックアップ）
- 画像プレビュータブ（base64 経由）、Markdown プレビュー（Edit/Split/Preview 3モード、スクロール同期、250ms デバウンス）
- 文字コード対応: `encoding_rs` で自動検出 + 指定エンコードでの開き直し/保存（StatusBar 2段階 UI）
- 改行コード LF/CRLF 切替（StatusBar クリック）、保存時に適用
- ファイルツリーコンテキストメニュー: リネーム（インライン入力）、削除（カスタム confirm ダイアログ）、Git History（専用タブ）
- ドラッグ&ドロップ移動 + Ctrl でコピー（`dragDropEnabled: false` で Tauri ネイティブ D&D を無効化）
- ダーティエディタタブの閉じ確認ダイアログ（カスタム confirm）
- WSL コマンドにパス引数前の `--` を付与（フラグ injection 防止）

### Git 統合
- `git` CLI 経由（WSL/Windows 両対応）。`git2` クレートは使わない
- Rust 側 `build_git_command` が ShellConfig に応じて `wsl.exe git` / `git` を組み立て
- ステータスバーにブランチ名+ダーティ表示、クリックでブランチ切替
- Git パネル: ステージング/アンステージ、コミット、push/pull/refresh、コミットツリー展開
- diff タブ: 左右分割表示、文字単位ハイライト（common prefix/suffix 方式）
- コミットログは `%B`（全文）取得、一覧は1行目のみ表示、ホバーで全文ツールチップ

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
- 子ウィンドウは `last_project.txt` を更新しない（main ウィンドウのみ）
- main ウィンドウ close → アプリ終了 + 全 PTY/Docker session cleanup
- 子ウィンドウ close → `beforeunload` で session 保存 + PTY kill（ベストエフォート）

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

### 設定画面
- サイドバー下部の歯車アイコンからシングルトンタブとして開く
- 設定は `localStorage` (`hearth:settings`) に永続化
- ダーク/ライトモード切替: `data-theme` 属性で CSS Variables を切り替え
- ターミナルフォント: `font-kit` クレートでシステムのモノスペースフォントを列挙（`spawn_blocking` で非同期実行）
- フォントスキャンは Settings タブを開いた時に遅延ロード（起動時には実行しない）
- カラースキーム: 6種（Default Dark, Solarized Dark/Light, Monokai, Dracula, Nord）
- フォント・サイズ変更は既存ターミナルにライブ反映、カラースキーム変更は `terminal.refresh()` + PTY resize nudge で TUI 再描画
- 設定タブにターミナルプレビュー表示（選択中のフォント・サイズ・カラースキームを即時反映）
- Editor セクション: ミニマップ ON/OFF、ワードラップ ON/OFF、タブサイズ（2/4/8）。CM6 Compartment でライブ反映
- settings タブはセッション永続化の対象外（`snapshotSession` は terminal/editor のみフィルタ）

---

@import .claude/rules/rust.md
@import .claude/rules/frontend.md
@import .claude/rules/testing.md
