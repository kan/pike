# Changelog

All notable changes to this project will be documented in this file.

## [0.5.4] - 2026-04-18

### Features

- トークン使用量表示を StatusBar に移動・統合（Claude Code はモデル別内訳ドロップダウン、Codex は active agent-chat タブのセッション usage を表示）

### Fixed

- Rust 1.95 の clippy 警告（`unnecessary_sort_by` / `collapsible_match`）に対応

## [0.5.3] - 2026-04-16

### Fixed

- WSL で claude-agent-acp の検出が `--version` ハングで失敗する問題を修正（`which` による存在確認に変更）

## [0.5.2] - 2026-04-16

### Fixed

- リリース版で WSL プロジェクトの Claude タブが起動しない問題を修正 (`bash -l` が非 tty 環境でハング)
- `bash -lc` → `bash -c` + 明示的 PATH prepend に変更
- WSL_EXTRA_PATH 定数で PATH 管理を統一、install コマンドの `$HOME/.local/bin` 欠落を修正

## [0.5.1] - 2026-04-16

### Features

- **スラッシュコマンドメニュー動的拡張**: ACP の `availableCommands` から `/commit`, `/simplify` 等のスキルをメニューに自動追加

### Fixed

- WSL での claude-agent-acp インストール権限エラー (`EACCES`) を修正 — `--prefix "$HOME/.local"` でユーザーローカルにインストール
- WSL での ACP バイナリ検出を `bash -lc` 経由に変更 (nvm/fnm の PATH 対応)

## [0.5.0] - 2026-04-16

### Features

- **統一エージェント API**: AgentRuntime trait による Codex / Claude Code (ACP) の統一抽象化。UI は runtime を意識せず動作
- **Claude Code (ACP) 対応**: Agent Client Protocol (JSON-RPC over stdio) で `claude-agent-acp` と通信。自動インストール対応
- **マルチエージェントタブ**: 1ウィンドウ内で複数のエージェントタブを独立運用可能。Claude と Codex の同時利用、同じ Claude の複数セッションに対応
- **セッション名表示**: ACP の `session_info_update` からセッションタイトルを取得し info-bar とタブタイトルに反映
- **初期固定タブ変更**: デフォルト固定タブを Claude Code autoStart ターミナルからネイティブ Agent タブに変更
- **QuickOpen にエージェントコマンド**: `> Claude` / `> Codex` で新規エージェントタブを作成

### Fixed

- ターミナル貼り付けの途切れを修正（capture フェーズで xterm.js 二重書き込み防止 + bracket paste mode 対応）

### Improved

- トークン使用量表示を StatusBar から AgentTab の info-bar に移動・統一
- UI 表記を Claude Code → Claude に統一

## [0.4.5] - 2026-04-15

### Features

- **Claude Code トークン使用量表示**: StatusBar にアクティブセッションの入力/出力トークン数と推定コストをリアルタイム表示。クリックでモデル別内訳ドロップダウン
- **Codex トークンコスト推定**: Codex タブの info-bar にモデル別推定コスト (~$X.XX) を追加

### Fixed

- タスクランナーが Windows プロジェクトでも WSL ターミナルを開いていた問題を修正（プロジェクトのデフォルトシェルを使用するよう変更）
- ターミナルへの長文ペーストが途切れる問題を修正（ConPTY パイプバッファ溢れ対策のチャンク書き込み + 明示的ペーストハンドリング）
- 右クリックペーストで Unix 改行 (bare LF) が正規化されていなかったバグを修正

### Improved

- `formatTokens` / `formatCost` を共有ユーティリティ (`src/lib/format.ts`) に抽出
- ターミナルペースト処理を共有ヘルパーに統合（右クリック / Ctrl+V の重複排除）

## [0.4.4] - 2026-04-14

### Features

- **タスクランナー**: package.json / Makefile / deno.json を再帰検出し、サイドバーパネルで一覧表示・実行。.gitignore を尊重、サブディレクトリのタスクは正しい CWD で実行
- **QuickOpen コマンドパレット化**: Ctrl+P で複数モードに対応
  - `>` タスク実行、`@` タブ切替、`:` 行ジャンプ、`!` Git ブランチ切替、`?` ヘルプ

### Fixed

- セルフアップデート後にウィンドウ位置・サイズが復元されない問題を修正（Moved/Resized で trailing-edge デバウンス保存 + relaunch 前の明示保存）

## [0.4.3] - 2026-04-14

### Features

- **画像ペースト / ファイルドラッグ**: Codex チャット・ターミナルにクリップボード画像をペースト → `.pike/uploads/` に保存 → `@パス` メンション挿入。ファイルツリー / OS からのドラッグ&ドロップにも対応
- **Codex 承認モーダルにファイルパス表示**: ファイル変更承認リクエストで対象ファイルのパスを表示（`item/started` の `changes[]` からバックフィル）
- **Codex ステータスバー**: sandbox / approval モードをアイコン付きバッジで表示（クリックで補完付きコマンド入力）。CLAUDE.md / AGENTS.md バッジをクリックでエディタタブに開く
- **スラッシュコマンド UX 改善**: 引数なしコマンド（`/clear` 等）がメニュー選択で即実行。補完リストにオプション説明を表示（日英対応）。sandbox / approval 変更時に自動再接続

### Improved

- Rust `ensure_dir` ヘルパー抽出（`fs_create_dir` と `fs_write_file_base64` で共有）
- `isAbsolutePath()` ユーティリティを `paths.ts` に追加

## [0.4.2] - 2026-04-13

### Fixed

- ウィンドウ非アクティブ時・スリープ復帰時に git fetch / Docker ポーリングが走り続ける問題を修正（1Password SSH 鍵承認の頻発を解消）
- 外部ツールが作成した新規ディレクトリがファイルツリーに反映されない問題を修正（キャッシュ無効化 + 展開時の常時リロード）
- Codex 長時間コマンド実行後に応答がなくなる問題を修正（broadcast チャネルのメッセージドロップを mpsc::unbounded に変更して解消）
- git パネルで未追跡ディレクトリが file アイコン + 空 diff になる問題を修正

### Improved

- Codex client から不要な `#[allow(dead_code)]` と未使用フィールドを除去、チャネル sender を reader タスクに move して disconnect 検知を改善

## [0.4.1] - 2026-04-11

### Fixed

- メインウィンドウを閉じると他のプロジェクトウィンドウも一緒に終了する問題を修正（main ウィンドウは非表示にし、最後の project ウィンドウが閉じた時にアプリ終了）
- Codex 承認モーダルのオーバーレイクリックでキャンセルされる問題を修正
- Codex CLI 未インストール時に接続中スピナーで固まる問題を修正

## [0.4.0] - 2026-04-10

### Features

- **スラッシュコマンド**: `/clear`, `/compact`, `/read`, `/diff`, `/model`, `/rollback`, `/sandbox`, `/approval` — コマンドパレット風 UI 付き
- **@ メンション補完**: `@` でプロジェクト内ファイルパスをファジーマッチ補完、ファイル/ディレクトリ内容をコンテキストに自動注入
- **AGENTS.md / CLAUDE.md インジケータ**: 検出時に Codex タブに表示
- **Sandbox / Approval 設定**: プロジェクト単位で localStorage 保存、スラッシュコマンドで切替（Windows は externalSandbox 固定）
- **トークン使用量表示**: `thread/tokenUsage/updated` イベントから取得し info-bar に表示
- **Codex 自動再接続**: プロセス切断検知 + 再接続 UI
- **Reasoning/thinking 折りたたみ表示**: summary/text/content をフォールバック検索
- **チャット履歴検索**: ハイライト + 上下ナビゲーション + スクロール追従
- **ターン単位ロールバック**: `thread/rollback` RPC + `/rollback` コマンド
- **FileChange サマリー**: ファイルパス・変更行数を表示、クリックで diff タブを開く
- **Settings タブ セクションナビ**: 左サイドバーにセクション一覧、クリックでスムーススクロール
- **モデル切替**: `/model` で一覧表示・切替（`model/list` + `turn/start` model パラメータ）
- **`/read` ファイル補完**: `/read ` 入力時に @ メンションと同じファイル補完 UI を表示

### Improved

- チャット上の @ メンションはファイル内容を非表示（displayText 分離）
- `fuzzyMatch` / `toRelativePath` を `src/lib/paths.ts` に共通化
- `persistHistory` にデバウンス追加（300ms）
- `loadProjectFiles` ガードを boolean フラグに修正
- AGENTS.md 検出を `fsReadFile` に変更（WSL 対応）
- `structuredClone` の DataCloneError を修正（JSON シリアライズに置換）
- チャット履歴復元の改善（disconnect/reconnect 時のメッセージ保護）

## [0.3.11] - 2026-04-09

### Fixed

- ターミナル activity dot がタブ切替後も消えない問題を修正（ResizeObserver が非表示タブで発火 → 偽の PTY 出力を防止）
- `cycleTab` / `closeTab` 経由のタブ切替で hasActivity がクリアされない問題を修正（watch による一元化）
- 設定変更（テーマ・フォント）時にバックグラウンドタブに偽の activity dot が出る問題を修正
- Git Bash タブのタイトルが Tauri プラグイン名（plugin-process 等）になる問題を修正（PROMPT_COMMAND を Git Bash にも適用）
- デスクトップ通知の ANSI エスケープ除去を改善（CSI ?パラメータ, DCS, APC/PM, DEL 対応）
- デスクトップ通知でプログレスバー残骸が表示される問題を修正（\\r キャリッジリターン処理追加）

## [0.3.10] - 2026-04-08

### Features

- Git パネルのコミットログで未 push コミットを可視化（アクセントカラー左ボーダー + ↑アイコン）
- ファイルツリーの展開状態・スクロール位置をパネル切替時に保持、展開パスを localStorage に永続化
- エディタタブフォーカス時にファイルツリー内の該当ファイルを自動選択・スクロール
- ウィンドウ非フォーカス時にアクティブターミナルの出力をデスクトップ通知（1.5s デバウンス、ANSI ストリップ）
- pike CLI で未登録ディレクトリを開いた際に ad-hoc プロジェクトを自動作成（WSL/Windows 対応）

### Fixed

- pike CLI で WSL 未登録ディレクトリを開くと既存ウィンドウに誤ルーティングされる問題を修正
- プロジェクトパネルの「検出」ボタンが初期 CWD を返す問題を修正（OSC 7 による CWD リアルタイム追跡）
- Git パネルで未追跡ファイルの discard が git checkout エラーになる問題を修正（fsDelete にフォールバック）
- ターミナルタブの activity dot が resize nudge の SIGWINCH 応答で常時点灯する問題を修正

## [0.3.9] - 2026-04-08

### Features

- ウィンドウ非表示時に Git / Docker のポーリングを自動停止し、復帰時に再開
- Settings タブに WSL 向け inotify-tools インストール案内バナーを表示
- 開発版ステータスバーにコミットハッシュを表示（v0.3.9-abc1234 形式）

### Fixed

- セルフアップデート後に閉じたプロジェクトのウィンドウが復元される問題を修正（Rust 側 WindowEvent::Destroyed で last_project.txt を確実に更新）
- セルフアップデート relaunch 前にセッションを明示的に保存するように修正

### Security

- vite 8.0.3 → 8.0.5（CVE: server.fs.deny bypass, WebSocket 経由のファイル読み取り, .map パストラバーサル）

### Dependencies

- windows 0.58 → 0.61, notify 7 → 8, tokio 1.50 → 1.51
- marked 17.0.5 → 17.0.6, mermaid 11.13 → 11.14, @codemirror/view 6.40 → 6.41
- tauri-plugin-updater 2.10.0 → 2.10.1, tauri-plugin-single-instance 2.4.0 → 2.4.1
- dependabot に cooldown 設定を追加（サプライチェーン攻撃対策）

## [0.3.8] - 2026-04-06

### Features

- Git パネル表示時にバックグラウンドで `git fetch --prune` を実行し、ahead/behind 表示をリモートの最新状態に更新（60秒クールダウン付き）

### Fixed

- タブ切替時に xterm.js の textarea を再フォーカスし、IME インライン入力が正常に動作しない問題を修正

## [0.3.7] - 2026-04-06

### Fixed

- ウィンドウを閉じた際に last_project.txt からプロジェクトが削除されず、次回起動時に閉じたプロジェクトも復元される問題を修正

## [0.3.6] - 2026-04-05

### Features

- ブランクエディタタブ: Ctrl+N またはタブバー空き領域ダブルクリックで新規作成
- Save As: 未タイトルタブの Ctrl+S でファイル保存先を選択（Windows: ファイルダイアログ、WSL: パス入力モーダル）
- 未タイトルタブのセッション永続化（アプリ再起動で内容を復元）
- タブバー空き領域の右クリックメニュー（新規エディタ/ターミナル/保存済みを閉じる/すべて閉じる）
- プロンプトダイアログ（テキスト入力付き確認ダイアログ）をダイアログシステムに追加

### Fixed

- ターミナル貼り付け時の改行多重化を修正（Ctrl+V / 右クリック両方で CRLF → CR 正規化）

## [0.3.5] - 2026-04-05

### Features

- 仮想デスクトップ対応: 別デスクトップで pike.exe を実行すると新規ウィンドウを開く（既存ウィンドウへの強制フォーカス移動を防止）
- CLI 引数ルーティング: ディレクトリ→プロジェクトマッチ/ターミナル、ファイル→エディタを適切なウィンドウに振り分け
- `--wait` フラグ: `GIT_EDITOR="pike.exe --wait"` でコミットメッセージ編集に対応。エディタタブを閉じると待機中のプロセスが解放されウィンドウも自動で閉じる
- WSL から pike.exe 実行時の絶対パスを UNC パスに自動変換
- プロジェクト未設定でもエディタタブでファイルを開ける（PowerShell フォールバック）

### Fixed

- 右クリック貼り付け（複数行）後にターミナルのフォーカスが戻らない問題を修正

## [0.3.4] - 2026-04-03

### Features

- 更新メニューから直接セルフアップデートを実行（Settings タブを開かず confirm → 更新 → 再起動）

### Fixed

- Docker パネルが異なるプロジェクトの同名コンテナを表示する問題を修正（composeProject でフィルタ）
- 再起動時に子ウィンドウが復元されない問題を修正（全ウィンドウが last_project.txt に登録）
- pike CLI でディレクトリ指定時にプロジェクトが開かれない問題を修正（アドホックプロジェクト自動作成）
- pike CLI の WSL UNC パス対応（既存 WSL プロジェクトとのマッチング + WSL プロジェクトとして作成）
- 外部ウィンドウからフォーカス復帰時に IME 入力が二重になる問題を修正（xterm textarea 再フォーカス）

## [0.3.3] - 2026-04-03

### Features

- Git パネルの unstaged ファイルに変更破棄（discard）ボタンを追加（確認ダイアログ付き）
- Docker logs タブでも「選択時にコピー」設定を反映

### Fixed

- ターミナルからのコピーで改行が二重になる問題を修正（CRLF → LF 正規化）
- 一部 IME（CorvusSKK 等）で日本語確定テキストが二重入力される問題を修正

## [0.3.2] - 2026-04-02

### Features

- 再起動時に前回開いていた全プロジェクトを復元（複数ウィンドウ対応）

## [0.3.1] - 2026-04-02

### Fixed

- WSL コマンド実行を `wsl.exe --` から `wsl.exe -e` に変更。コミットメッセージ等に括弧やクォートが含まれるとシェル構文エラーになる問題を解消
- インストーラーが pike CLI を PATH に自動追加するよう NSIS フックを追加（アンインストール時に削除）

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
