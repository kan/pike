# Pike — マイルストーン

## 現在のマイルストーン

**→ M14: Codex IDE 統合強化**

---

## マイルストーン一覧

| # | 名称 | 目的 | 状態 |
|---|------|------|------|
| M1 | PTY スパイク | コア技術の動作検証 | ✅ 完了 |
| M2 | レイアウトシェル | UI 骨格の構築 | ✅ 完了 |
| M3 | プロジェクト管理 | プロジェクト切替の実装 | ✅ 完了 |
| M4 | Git パネル | git CLI 統合・diff タブ・コミットツリー | ✅ 完了 |
| M5 | ファイルツリー + エディタ | ファイル操作・プレビュー・文字コード・D&D | ✅ 完了 |
| M6 | Docker パネル | コンテナ管理・ログ・exec | ✅ 完了 |
| M7 | 検索パネル | rg/grep 統合 | ✅ 完了 |
| M8 | セッション永続化 | プロジェクト状態・resume 連携 | ✅ 完了 |
| M9 | Polish | UX 改善・キーバインド・i18n・CLI・マルチウィンドウ | ✅ 完了 |
| M10 | Release | CI/CD・配布・自動更新・セキュリティ | 🔧 ほぼ完了 |
| M11 | File Watcher | ファイル変更検知・自動リフレッシュ | ✅ 完了 |
| M12 | Developer UX | クイックオープン・ターミナル通知・Git改善・検索修正 | ✅ 完了 |
| M13 | Codex Delegation | Codex App Server 統合・チャットUI・マルチウィンドウ | ✅ 完了 |
| M14 | Codex IDE 統合強化 | Diff連携・スラッシュコマンド・通知・コンテキスト注入 | ⏳ 未着手 |

---

## 完了済みマイルストーン（M1–M10）

<details>
<summary>M1: PTY スパイク</summary>

Windows Tauri → WSL2 → Claude Code の構造が動くことを最小コードで確認。
PTY 接続、tmux 経由接続、Claude Code TUI 描画、Docker socket 接続を検証。
</details>

<details>
<summary>M2: レイアウトシェル</summary>

左アイコンナビ、タブバー（追加・切替・クローズ・固定）、複数ターミナル同時動作、リサイズ追従。
</details>

<details>
<summary>M3: プロジェクト管理</summary>

プロジェクト一覧 CRUD、fzf 風スイッチャー（Ctrl+Shift+P）、プロジェクトごとのデータ保存、切替時のファイルツリー・タブ復元。
</details>

<details>
<summary>M4: Git パネル + 拡張</summary>

ブランチ表示・ステージング・コミット・push/pull、diff タブ（左右分割・文字単位ハイライト）、コミットツリー展開、ファイルツリー git ステータスアイコン。
</details>

<details>
<summary>M5: ファイルツリー + エディタ + 拡張</summary>

CodeMirror 6（29言語）、Ctrl+S 保存、画像プレビュー、Markdown プレビュー（3モード・スクロール同期）、文字コード・改行コード対応、コンテキストメニュー（リネーム・削除・Git History）、D&D 移動/コピー。
</details>

<details>
<summary>M6: Docker パネル</summary>

compose.yml パース、コンテナ状態表示、start/stop/restart、ログストリーミング、docker exec シェル。
</details>

<details>
<summary>M7: 検索パネル</summary>

rg/grep 自動検出、部分一致・正規表現・glob、結果クリックでエディタジャンプ、500件 truncate。
</details>

<details>
<summary>M8: セッション永続化</summary>

タブ並び順・アクティブタブの保存・復元、固定タブ resume 引数（claude --continue 等）、アプリ再起動で自動再接続。
</details>

<details>
<summary>M9: Polish</summary>

キーバインド整備、フォント・カラースキーム設定、起動高速化（~145ms）、タブ D&D 入れ替え、タブコンテキストメニュー、PTY 孤立防止、rg サイドカーバンドル、Lucide + material-file-icons、ミニマップ、エディタ内検索・置換、git diff ガター、ターミナルコピペ、ダーク/ライトモード、i18n、マルチウィンドウ、pike CLI、独自アイコン、リポジトリ公開。
</details>

<details>
<summary>M10: Release</summary>

GitHub Actions（Windows ビルド・リリース自動アップロード）、Dependabot、Security Check（cargo audit + npm audit）、tauri-plugin-updater（署名・latest.json・Settings UI・通知ドット）、v0.1.0/v0.1.1 リリース、CSP 有効化、DOMPurify 導入、SECURITY.md。

残タスク:
- [ ] MSIX パッケージ生成（Microsoft Store 配布用）
- [ ] Microsoft Store への初回申請・公開
</details>

---

## M11: File Watcher ✅

<details>
<summary>完了条件</summary>

- [x] プロジェクトルート以下のファイル変更を監視（notify / inotifywait）
- [x] ファイルツリー自動更新（デバウンス・バッチ処理）
- [x] エディタ外部変更検知（クリーン→自動リロード、ダーティ→警告ダイアログ）
- [x] ファイルツリー新規作成（インライン入力）
- [x] プレビュー拡張（Mermaid / PDF / CSV・TSV）
</details>

---

## M12: Developer UX ✅

<details>
<summary>完了条件</summary>

- [x] クイックオープン（Ctrl+P、rg --files、ファジーマッチ、:行番号ジャンプ）
- [x] ターミナルアクティビティ通知（バッジ・プロセス終了検知・デスクトップ通知）
- [x] 検索パネル修正（-F フラグ）
- [x] Git ahead/behind 表示・unstage ボタン
- [x] プロジェクトパネル改善（フォルダ選択・ソート・別ウィンドウバグ修正）
- [x] SVG プレビュー（Edit/Split/Preview トグル）
- [x] ターミナルタブ切替時の表示崩れ修正
</details>

---

## M13: Codex Delegation ✅

<details>
<summary>完了条件</summary>

- [x] CodexRuntime trait（Windows native / WSL 切替）+ npm .cmd パーサー
- [x] JSON-RPC over stdio クライアント（双方向通信・initialize handshake）
- [x] ChatGPT OAuth 認証フロー（自動ログイン）
- [x] Thread/Turn ライフサイクル管理・ストリーミング応答表示
- [x] Approval ダイアログ（コマンド実行・ファイル変更の承認）
- [x] エディタコンテキスト自動注入（ファイルパス・カーソル位置）
- [x] Codex バージョン互換性チェック
- [x] Windows: externalSandbox + Job Object でクラッシュ回避
- [x] WSL: workspace-write sandbox（Linux sandbox は安定）
- [x] マルチウィンドウ対応（HashMap\<window_label, CodexSession\>、emit_to ルーティング）
- [x] セッション永続化（threadId + チャット履歴 IndexedDB 最大200件）
- [x] Codex タブのセッション復元
</details>

---

## M14: Codex IDE 統合強化

### 目的
Codex を Pike の IDE 機能と深く統合し、diff プレビュー・スラッシュコマンド・通知・コンテキスト注入により実用的な coding agent 体験を実現する。

### 完了条件

**Diff 連携**
- [ ] `turn/diff/updated` 通知で受け取った unified diff を Pike の DiffTab で表示
- [ ] Codex チャットタイムライン上の FileChange アイテムをクリックで diff タブを開く
- [ ] diff タブから Accept / Reject 操作で `item/fileChange/requestApproval` に応答
- [ ] diff 適用後にファイルツリーとエディタを自動リフレッシュ

**スラッシュコマンド**
- [ ] `/compact` — `thread/compact/start` で会話コンテキストを圧縮
- [ ] `/clear` — チャット履歴クリア + 新規スレッド開始
- [ ] `/model` — `model/list` でモデル一覧取得 + `turn/start` の `model` パラメータで切替
- [ ] `/read <path>` — 指定ファイルの内容をコンテキストに注入（`input` に `type: "text"` で追加）
- [ ] `/diff` — 現在の作業ツリーの git diff を取得してコンテキストに注入
- [ ] コマンドパレット風 UI（`/` 入力でドロップダウン補完）

**@ メンション補完**
- [ ] チャット入力欄で `@` を入力するとプロジェクト内ファイルパスの補完候補を表示
- [ ] `rg --files` の結果をキャッシュし、ファジーマッチで絞り込み
- [ ] 選択されたファイルの内容を turn の `input` にコンテキストとして追加
- [ ] `@` + ディレクトリパスでディレクトリ内のファイル一覧も注入可能に

**デスクトップ通知**
- [x] Codex の turn 完了時、Codex タブが非アクティブ（ウィンドウがアクティブでも別タブ表示中なら対象）ならトースト通知 + タブに青ドット表示
- [x] Approval リクエスト到着時に同条件で通知（ユーザー操作が必要な旨を伝える）
- [x] 通知クリックで Pike をフォーカスし Codex タブに切替、青ドットをクリア
- [x] Settings に Codex 通知 ON/OFF トグル追加
- [x] 既存のターミナル通知が仮想デスクトップ切替時に発火しない不具合を修正（`document.visibilityState` チェック追加）

**AGENTS.md / CLAUDE.md 連携**
- [x] プロジェクトルートの `AGENTS.md` を検出し、`thread/start` の `developerInstructions` に自動注入
- [x] `AGENTS.md` が存在しない場合は `CLAUDE.md` にフォールバック
- [x] いずれも存在しない場合はスキップ（エラーにしない）
- [x] `thread/resume` 時にも `developerInstructions` を再注入
- [ ] Codex タブの UI に「AGENTS.md detected」/「CLAUDE.md detected」インジケータ表示

**Sandbox 設定 UI**
- [ ] Settings タブに Codex セクション追加
- [ ] sandbox モード選択（workspace-write / danger-full-access / externalSandbox）
- [ ] approval ポリシー選択（untrusted / on-failure / on-request / never）
- [ ] Windows で workspace-write 選択時は警告を表示（クラッシュリスクの説明）

**チャット UX 改善**
- [ ] コマンド実行結果の stdout/stderr をチャット内に折りたたみ表示
- [ ] FileChange アイテムに変更ファイルパスと変更行数のサマリーを表示
- [ ] エージェントの reasoning/thinking サマリーを折りたたみ表示
- [ ] チャット履歴の検索機能
- [ ] ターン単位のロールバック（`thread/rollback`）

**その他**
- [ ] Codex プロセス異常終了時の自動再接続とエラー表示
- [ ] トークン使用量の表示（`thread/tokenUsage/updated` から取得）
- [ ] 複数スレッド管理（`thread/list` で一覧取得、切替 UI）

---

## 更新ルール

- マイルストーン完了条件を満たしたらチェックボックスを埋める
- 完了したマイルストーンの状態を ✅ に更新する
- 設計変更があれば CLAUDE.md と同時に更新する
