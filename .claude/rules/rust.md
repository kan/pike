---
paths:
  - "src-tauri/**/*.rs"
  - "src-tauri/Cargo.toml"
  - "src-tauri/rustfmt.toml"
---

# Rust 実装ルール

## 整形（rustfmt、#313）
- 整形は `just fmt`（= `cargo fmt`）。設定は `src-tauri/rustfmt.toml` の `max_width = 100` だけで、選んだ理由はそのファイルのコメントが正本
- `just check` が `just fmt-check`（= `cargo fmt --check`）を回すので、**整形されていないコードはコミット前に落ちる**
- **中身の変更と整形を混ぜない。** 手で狭く折った行が rustfmt に広げられる（またはその逆）ので、整形されていないコードを部分的に `cargo fmt` すると無関係な行が大量に動く

## 文字列（#382）

**どれも正本はコード側の doc**。ここは規範と行き先だけ置く。

- 追加の lint と、常時当てないものの理由 … `src-tauri/Cargo.toml` の `[lints.clippy]`。棚卸しは `just clippy-deep`
- **`&str` → `String` は `to_owned()`**（`to_string()` と混ぜない。`str_to_string` が CI で落とす）
- **ストリームの emit payload は借りる** … `pty/mod.rs` の `PtyOutputPayload` と `docker/mod.rs` の `DockerLogPayload` の doc。イベント単位の payload は対象外（借りても作る回数が減らない）
- **子プロセスの出力は `types.rs` の `into_lossy_string`** に通す（`from_utf8_lossy(&bytes).into_owned()` を書かない）
- **「配下か」の判定は `types.rs` の `starts_with_segment`**（前置を `format!` で組まない）
- **clippy に従ってはいけない場所が 1 つある** … `pty/busy.rs` の `collect`（並列化のためのもの。`needless_collect` に従うと直列になる）

## 基本方針
- Tauri コマンドは `async fn` を既定にし、戻り値は `Result<T, String>`。**ウィンドウを触るものと、状態を読むだけで即答できるものは同期の `fn`** にしてある（`project_for_window` / `focus_project_window` / `window_restore` / `window_close_quits_app` / `save_all_window_state` / `wait_signal_by_path` / `is_elevated` / `open_elevated_terminal`）
  - **ただしウィンドウを「作る」ものは例外で、必ず `async`**（`open_project_window` / `open_global_window`）。同期コマンドから `build_window` を呼ぶと Windows でデッドロックする（制約は**コマンドハンドラ**に対してで、イベントループ側のコールバックからは従来どおり呼べる。判断の実体は `build_window` の doc が正本）
- **ウィンドウ操作は ack を待たない（#340）。** `show()` / `set_focus()` は `tauri-runtime-wry` の `send_user_message` を通り、**メインスレッド以外から呼ばれるとイベントを積むだけ**で返る（メインスレッドからならその場で処理する）。結果が要る `build()` や getter だけが待つ、という非対称がある
  - だから「コマンドが解決した＝ウィンドウが出ている」は**成り立たない**。成り立たせている箇所と、その待ち方は `wait_for_window_queue` / `build_window` の doc が正本
- エラーは `map_err(|e| e.to_string())` で文字列化してフロントに返す
- **ウィンドウは `Window` で扱い、`WebviewWindow` を使わない（#368）。** ブラウザのタブは
  ウィンドウに子 webview を足すので、そのウィンドウは Tauri から見て「webview が 1 つだけの
  ウィンドウ」ではなくなる。すると `WebviewWindow` を取るものが全部そのウィンドウを見失う:
  - コマンドの引数の `WebviewWindow` … `current webview is not a WebviewWindow` で失敗する
  - `app.get_webview_window(label)` / `app.webview_windows()` … 黙って `None` / 除外になる
    （CLI のルーティング、トレイからの復帰、ウィンドウ位置の保存が、そのウィンドウだけ効かない）
  - 代わりに `Window` / `app.get_window` / `app.windows()` を使う。表示・フォーカス・位置・
    `hwnd`・イベントの送信は同じものがある。**例外は webview そのもの（WebView2 の COM）を
    触る `drop_paths::attach`** だけで、ウィンドウを作った直後（子がまだ無い）に呼ぶ
  - **プラグインの中は直せない。** `tauri-plugin-window-state` の `save_window_state` は
    `webview_windows()` で引くので、ブラウザのタブを開いている main ウィンドウは明示的な
    保存（トレイの「終了」、更新の前）のときに最大化の状態を読み直さない。位置と大きさは
    移動・リサイズのたびにプラグインが記録しているので、そちらは失われない
- **webview を作るときは `disable_drag_drop_handler()` を必ず付ける（#396）。** Windows では
  wry がウィンドウに OLE のドロップ先を張るので、有効なままだとページ上のドラッグが
  横取りされ、HTML5 の drag & drop が「禁止」のカーソルで止まる。今付けているのは Pike 本体
  （`build_window` と `tauri.conf.json` の `dragDropEnabled`）と、子 webview の 2 つ
  （ブラウザのタブの `browser_open`、HTML のプレビューの `html_preview.rs`）。**子 webview を
  作る箇所を足すときに付け忘れやすい**
- **グローバル状態は 1 つの `AppState` にまとめず、モジュールごとの型を個別に `manage` する**（`CliState` / `WaitState` / `PtyState` / `WatcherState` / `DockerState` / `ProjectState` / `TransientState` / `SearchState` / `PreviewState` / `IssuesState`。一覧の正本は `lib.rs` の `manage` の並び）。コマンドは `State<'_, PtyState>` のように要るものだけを受け取るので、引数の型がそのまま「このコマンドが触る状態」の宣言になる。共有する中身は `Arc<Mutex<>>` で包む
- PTY プロセスのライフタイムは `PtyState` が所有し、ウィンドウ破棄時に `pty::cleanup_for_window` で cleanup

## PTY
- `portable-pty` の `PtySize` でリサイズイベントを処理する
- PTY の stdout 読み取りは専用スレッド（`std::thread::spawn`）で行い、`app_handle.emit` でフロントに送る
- セッション ID（UUID）でタブと PTY インスタンスを 1:1 で紐付ける

## 非同期
- `tokio::runtime` は Tauri が管理するため、コマンド内で別途ランタイムを作らない
- ブロッキング処理は `tokio::task::spawn_blocking` に逃がす

## 命名規約
- Tauri コマンド: `{module}_{action}` 例: `pty_spawn`, `pty_write`, `git_log`
- イベント名: `{module}_{event}` 例: `pty_output`, `pty_exit`, `fs_changed`
