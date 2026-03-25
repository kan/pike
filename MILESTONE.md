# DevTerm — マイルストーン

## 現在のマイルストーン

**→ M9: Polish（進行中）**

---

## マイルストーン一覧

| # | 名称 | 目的 | 状態 |
|---|------|------|------|
| M1 | PTY スパイク | コア技術の動作検証 | ✅ 完了 |
| M2 | レイアウトシェル | UI 骨格の構築 | ✅ 完了 |
| M3 | プロジェクト管理 | プロジェクト切替の実装 | ✅ 完了 |
| M4 | Git パネル | git CLI 統合 | ✅ 完了 |
| M4.5 | Git パネル拡張 | diff タブ・コミットツリー | ✅ 完了 |
| M5 | ファイルツリー + エディタタブ | ファイル操作 | ✅ 完了 |
| M5.5 | ファイル操作拡張 | プレビュー・文字コード・D&D | ✅ 完了 |
| M6 | Docker パネル | コンテナ管理 | ✅ 完了 |
| M7 | 検索パネル | rg/grep 統合 | ✅ 完了 |
| M8 | セッション永続化 | プロジェクト状態・resume 連携 | ✅ 完了 |
| M9 | Polish | UX 改善・キーバインド整備 | 🔧 進行中 |

---

## M1: PTY スパイク

### 目的
「Windows Tauri → WSL2 → Claude Code」の構造が動くことを最小コードで確認する。
この検証が通らない場合、アーキテクチャの根本見直しが必要になる。

### 完了条件（すべて満たすこと）

**Step 1-A: 基本 PTY 接続**
- [x] Tauri アプリウィンドウに xterm.js が表示される
- [x] `wsl.exe bash` を PTY で spawn できる
- [x] キーボード入力が WSL2 の bash に届く
- [x] bash の出力が xterm.js に表示される
- [x] ウィンドウリサイズで xterm.js と PTY のサイズが追従する

**Step 1-B: tmux 経由接続（オプション — 検証済み、必須パスではない）**
- [x] `wsl.exe tmux new-session -s test` で tmux セッションを起動できる
- [x] セッションが既存なら `tmux attach-session -t test` でアタッチできる
- [x] アプリを閉じて再起動しても tmux セッションが生きていれば再接続できる

> **設計判断**: AI エージェント (claude/codex) のセッション復帰は各ツール自身の
> resume 機能（`claude --continue` 等）に委譲する。tmux はオプション機能として
> コードを残すが、必須依存にはしない。

**Step 1-C: Claude Code の TUI 描画**
- [x] PTY 上で `claude` コマンドを起動できる
- [x] Claude Code の TUI（色・Unicode・カーソル移動）が崩れない
- [x] ターミナルリサイズ後も表示が正しく再描画される
- [x] Ctrl+C 等の特殊キーが正しく伝達される

> **既知制限**: IME（CorvusSKK）のインライン変換がターミナル内に表示されない
> （アプリ外の候補ウィンドウには出る）。xterm.js の制限。M9 で対応検討。

**Step 1-D: Docker socket 接続（別途 cargo run で検証）**
- [x] Windows 側 Rust から bollard で Docker に接続できる（TCP フォールバック対応）
- [x] `docker ps` 相当（コンテナ一覧取得）が動く
- [x] コンテナのログストリームを取得できる

### スコープ外（M1 では実装しない）
- UI の見た目・レイアウト（最小限の HTML で十分）
- タブ管理
- プロジェクト管理
- エラーハンドリングの作り込み

### 主要な依存クレート

```toml
[dependencies]
tauri = { version = "2", features = [] }
portable-pty = "0.8"
bollard = "0.17"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### 主要な npm パッケージ

```json
{
  "@xterm/xterm": "^5",
  "@xterm/addon-fit": "^0.10",
  "@xterm/addon-web-links": "^6"
}
```

### 検証時の注意点

- `TERM=xterm-256color` を PTY spawn 時の環境変数に必ず含める
- tmux 起動時は `tmux -2 new-session ...` で 256 色を強制する
- xterm.js の `FitAddon` で初期サイズを設定してから PTY を spawn すること
  （サイズ不明のまま spawn すると後のリサイズが効かないことがある）
- WSLInterop 関連の問題が出た場合は `/proc/sys/fs/binfmt_misc/WSLInterop` を確認

---

## M2: レイアウトシェル

### 目的
M1 の PTY をベースに、アプリとして使えるレイアウトを構築する。

### 完了条件
- [x] 左アイコンナビ（5アイコン）でパネル切替ができる
- [x] タブバーが表示され、タブの追加・切替・クローズができる
- [x] 固定タブ（pinned）が Ctrl+W で閉じられない
- [x] ターミナルタブが複数同時に動作する（各タブが独立した PTY を持つ）
- [x] タブの種別（terminal / editor / docker-logs）を Union type で管理している
- [x] ウィンドウ全体のリサイズでアクティブタブの PTY サイズが追従する

### スコープ外
- 各パネルの中身（ファイルツリー等）は仮実装で良い
- セッション永続化は M8 で実装

---

## M3: プロジェクト管理

### 目的
「プロジェクトを開く = 状態がすべて復元される」体験の実装。

### 完了条件
- [x] プロジェクト一覧の登録・削除・切替ができる
- [x] fzf 風のインクリメンタル検索スイッチャーが動く（Ctrl+Shift+P）
- [x] プロジェクトごとに `~/.config/devterm/{project_id}/` にデータを保存する
- [x] プロジェクト切替でファイルツリーのルートが変わる
- [x] プロジェクト切替でタブ配置が復元される（固定タブ定義を読み込む）

### データ構造

```json
// %APPDATA%/com.tauri.dev/projects/{project_id}/project.json
{
  "id": "my-api",
  "name": "my-api",
  "root": "/home/user/projects/my-api",
  "shell": { "kind": "wsl", "distro": "Ubuntu" },
  "pinnedTabs": [
    { "id": "cc", "kind": "terminal", "title": "Claude Code", "autoStart": "claude" }
  ],
  "lastOpened": "2025-01-01T00:00:00Z"
}
```

> **shell** は `{ "kind": "wsl", "distro": "..." }` / `{ "kind": "cmd" }` /
> `{ "kind": "powershell" }` / `{ "kind": "git-bash" }` のいずれか。
> **pinnedTabs** が空の場合、プロジェクト切替時に Claude Code の固定タブが自動作成される。

---

## M4: Git パネル

### 完了条件
- [x] 現在のブランチ名・ダーティ状態をサイドバーに表示
- [x] ステージング/アンステージ操作ができる
- [x] コミットログ一覧（50件）が表示される
- [x] diff ビューア（読み取り専用）が動く
- [x] ファイルツリーにgit ステータスアイコンが表示される

---

## M4.5: Git パネル拡張

### 目的
Git パネルの UX を改善し、diff をタブで表示できるようにする。

### 完了条件
- [x] CHANGES のファイルに拡張子ベースのアイコンを付ける
- [x] CHANGES のファイルクリックで左右分割 diff タブを開く
- [x] RECENT COMMITS の各行はコミットメッセージを最大幅で表示（ハッシュは省略）
- [x] COMMITS の各行ホバーでコミットメッセージ全文・ハッシュ等をツールチップ表示
- [x] COMMITS をツリー表示にし、クリックで変更ファイル一覧を展開
- [x] COMMITS の変更ファイルクリックで diff タブを開く（CHANGES と同様）

---

## M5: ファイルツリー + エディタタブ

### 完了条件
- [x] プロジェクトルート以下のファイルツリーが表示される
- [x] ファイルクリックでエディタタブが開く
- [x] CodeMirror 6 でシンタックスハイライトが動く（29言語対応）
- [x] Ctrl+S で保存できる
- [x] ファイルツリーにリフレッシュボタン（手動更新）
- [x] 対象言語: TS/JS, Rust, Go, Python, Ruby, Perl, Java, Kotlin, Swift, C/C++/C#, PHP, HTML/Vue, CSS/SCSS, Markdown, YAML, JSON, SQL, Shell, Dockerfile, TOML, Lua, diff, PowerShell, nginx, Protobuf

---

## M5.5: ファイル操作拡張

### 目的
エディタとファイルツリーの UX を実用レベルに引き上げる。

### 完了条件

**プレビュー**
- [x] 画像ファイル（png/jpg/gif/svg/webp）を開いたらプレビュータブを表示
- [x] Markdown ファイルのプレビュー表示（Edit/Split/Preview 3モード + スクロール同期）

**エディタ情報表示**
- [x] フッターにカーソル位置（行:列）、文字コード、改行コード、ファイルタイプを表示
- [x] 文字コード指定での開き直し・保存をサポート（encoding_rs + StatusBar 2段階UI）
- [x] 改行コードの変更をサポート（LF/CRLF）

**ファイルツリー操作**
- [x] コンテキストメニュー: 名前の変更、ファイル削除
- [x] コンテキストメニュー: Git History 表示
- [x] ドラッグ&ドロップによるファイル/フォルダ移動
- [x] Ctrl+ドラッグでコピー

**Git パネル連携**
- [x] COMMITS/CHANGES のファイルにコンテキストメニュー追加（「変更を開く」「ファイルを開く」）

---

## M6: Docker パネル

### 完了条件
- [x] compose.yml を読み取ってサービス一覧を表示する
- [x] bollard でコンテナの実行状態を取得・表示する
- [x] start / stop / restart コマンドを UI から実行できる
- [x] 「ログを開く」でDockerLogsタブが生成される
- [x] ログストリームがリアルタイムで表示される

### スコープ外
- `docker exec`（M9 に移動済み）

---

## M7: 検索パネル

### 完了条件
- [x] 起動時に rg の存在を確認、なければ grep にフォールバック
- [x] 使用バックエンドをパネル上部にバッジ表示
- [x] 部分一致・正規表現・glob include/exclude が動く
- [x] 結果を `ファイルパス:行番号  該当行の抜粋` でフラット表示
- [x] 結果行クリックでエディタタブを開いて該当行にジャンプ

---

## M8: セッション永続化

### 完了条件
- [x] 固定タブのプロセス再起動時に resume 引数（`claude --continue` 等）で復帰する
- [x] タブの並び順・アクティブタブを project.json に保存・復元する
- [x] アプリ再起動で固定タブが自動的に再接続される
- [ ] （オプション）tmux 経由のセッション保持も選択可能

---

## M9: Polish

### 完了条件
- [ ] キーバインド整備（Ctrl+Tab でタブ切替、Ctrl+Shift+P でプロジェクトスイッチャー等）
- [x] ターミナルのフォント・カラースキームを設定から変えられる
- [ ] アプリ起動時間が 1 秒以内（計測・最適化）
- [ ] タブをドラッグで入れ替え
- [ ] タブのコンテキストメニューを拡充(全て閉じる等)
- [x] クラッシュ時の PTY プロセス孤立を防ぐ（PtySession Drop + WindowEvent::Destroyed で cleanup）
- [x] IME インライン変換対応（環境依存で再現せず保留。xterm.js v7 リリース時に取り込み検討）
- [x] rg のサイドカーバンドル（externalBin でアプリ同梱、Windows プロジェクトで自動フォールバック）
- [x] アイコンライブラリ導入（Lucide + material-file-icons）とアプリ全体のアイコン見直し
- [x] `docker exec` でコンテナ内シェルに入る機能（bollard でシェル検出、autoStart で実行）
- [x] エディタ ミニマップ（Canvas 描画、設定で ON/OFF、diff 色表示付き）
- [x] エディタ内検索・置換（Ctrl+F / Ctrl+H、カスタムパネル、アイコンボタン、マッチ数表示）
- [x] エディタ git diff 変更行強調（追加/変更行をガター表示、ミニマップにも反映）
- [x] ダーク/ライトモード切替（設定タブから変更可能）
- [ ] i18n 対応（UI テキストの多言語化）
- [x] Git が参照する SSH プロセスの切り替え対応（1Password SSH Agent 等 → gitconfig の core.sshCommand で対応）
- [ ] プロジェクトを別ウィンドウで開く機能（マルチウィンドウ対応）
- [ ] セルフアップデート機能（tauri-plugin-updater によるアプリ内自動更新）
- [x] SearchBackend を stringly-typed から tagged enum に移行（Rust: serde tagged enum, TS: discriminated union）
- [x] WSL コマンド実行の共通化（ShellConfig::command/run/run_stdout に統合、search/git/fs/docker で使用）

---

## 更新ルール

- マイルストーン完了条件を満たしたらチェックボックスを埋める
- 完了したマイルストーンの状態を ✅ に更新する
- 設計変更があれば CLAUDE.md と同時に更新する
