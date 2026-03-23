# DevTerm — マイルストーン

## 現在のマイルストーン

**→ M1: PTY スパイク**

---

## マイルストーン一覧

| # | 名称 | 目的 | 状態 |
|---|------|------|------|
| M1 | PTY スパイク | コア技術の動作検証 | ✅ 完了 |
| M2 | レイアウトシェル | UI 骨格の構築 | ⬜ 未着手 |
| M3 | プロジェクト管理 | プロジェクト切替の実装 | ⬜ 未着手 |
| M4 | Git パネル | git2 統合 | ⬜ 未着手 |
| M5 | ファイルツリー + エディタタブ | ファイル操作 | ⬜ 未着手 |
| M6 | Docker パネル | コンテナ管理 | ⬜ 未着手 |
| M7 | 検索パネル | rg/grep 統合 | ⬜ 未着手 |
| M8 | セッション永続化 | プロジェクト状態・resume 連携 | ⬜ 未着手 |
| M9 | Polish | UX 改善・キーバインド整備 | ⬜ 未着手 |

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
- [ ] 左アイコンナビ（5アイコン）でパネル切替ができる
- [ ] タブバーが表示され、タブの追加・切替・クローズができる
- [ ] 固定タブ（pinned）が Ctrl+W で閉じられない
- [ ] ターミナルタブが複数同時に動作する（各タブが独立した PTY を持つ）
- [ ] タブの種別（terminal / editor / docker-logs）を Union type で管理している
- [ ] ウィンドウ全体のリサイズでアクティブタブの PTY サイズが追従する

### スコープ外
- 各パネルの中身（ファイルツリー等）は仮実装で良い
- セッション永続化は M8 で実装

---

## M3: プロジェクト管理

### 目的
「プロジェクトを開く = 状態がすべて復元される」体験の実装。

### 完了条件
- [ ] プロジェクト一覧の登録・削除・切替ができる
- [ ] fzf 風のインクリメンタル検索スイッチャーが動く（Ctrl+Shift+P）
- [ ] プロジェクトごとに `~/.config/devterm/{project_id}/` にデータを保存する
- [ ] プロジェクト切替でファイルツリーのルートが変わる
- [ ] プロジェクト切替でタブ配置が復元される（固定タブ定義を読み込む）

### データ構造

```json
// ~/.config/devterm/{project_id}/project.json
{
  "id": "my-api",
  "name": "my-api",
  "root": "/home/user/projects/my-api",
  "wsl_distro": "Ubuntu",
  "pinned_tabs": [
    { "id": "cc", "kind": "terminal", "title": "Claude Code", "auto_start": "claude" },
    { "id": "codex", "kind": "terminal", "title": "Codex", "auto_start": "codex" }
  ],
  "last_opened": "2025-01-01T00:00:00Z"
}
```

---

## M4: Git パネル

### 完了条件
- [ ] 現在のブランチ名・ダーティ状態をサイドバーに表示
- [ ] ステージング/アンステージ操作ができる
- [ ] コミットログ一覧（50件）が表示される
- [ ] diff ビューア（読み取り専用）が動く
- [ ] ファイルツリーにgit ステータスアイコンが表示される

---

## M5: ファイルツリー + エディタタブ

### 完了条件
- [ ] プロジェクトルート以下のファイルツリーが表示される
- [ ] ファイルクリックでエディタタブが開く
- [ ] CodeMirror 6 でシンタックスハイライトが動く（Go/Rust/TS/Vue/YAML）
- [ ] Ctrl+S で保存できる
- [ ] ファイル変更（notify）でツリーが自動更新される
- [ ] 対象言語: Go, Rust, TypeScript, Vue, YAML, Shell, Markdown

---

## M6: Docker パネル

### 完了条件
- [ ] compose.yml を読み取ってサービス一覧を表示する
- [ ] bollard でコンテナの実行状態を取得・表示する
- [ ] start / stop / restart コマンドを UI から実行できる
- [ ] 「ログを開く」でDockerLogsタブが生成される
- [ ] ログストリームがリアルタイムで表示される

### スコープ外
- `docker exec` でコンテナ内シェルに入る機能（M9 以降）
- image pull / build

---

## M7: 検索パネル

### 完了条件
- [ ] 起動時に rg の存在を確認、なければ grep にフォールバック
- [ ] 使用バックエンドをパネル上部にバッジ表示
- [ ] 部分一致・正規表現・glob include/exclude が動く
- [ ] 結果を `ファイルパス:行番号  該当行の抜粋` でフラット表示
- [ ] 結果行クリックでエディタタブを開いて該当行にジャンプ

---

## M8: セッション永続化

### 完了条件
- [ ] 固定タブのプロセス再起動時に resume 引数（`claude --continue` 等）で復帰する
- [ ] タブの並び順・アクティブタブを project.json に保存・復元する
- [ ] アプリ再起動で固定タブが自動的に再接続される
- [ ] （オプション）tmux 経由のセッション保持も選択可能

---

## M9: Polish

### 完了条件
- [ ] キーバインド整備（Ctrl+Tab でタブ切替、Ctrl+Shift+P でプロジェクトスイッチャー等）
- [ ] ターミナルのフォント・カラースキームを設定から変えられる
- [ ] アプリ起動時間が 1 秒以内（計測・最適化）
- [ ] クラッシュ時の PTY プロセス孤立を防ぐ（cleanup 処理）
- [ ] IME インライン変換対応（xterm.js の制限調査・ワークアラウンド検討）
- [ ] rg のサイドカーバンドル検討

---

## 更新ルール

- マイルストーン完了条件を満たしたらチェックボックスを埋める
- 完了したマイルストーンの状態を ✅ に更新する
- 設計変更があれば CLAUDE.md と同時に更新する
