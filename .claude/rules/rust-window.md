---
paths:
  - "src-tauri/src/lib.rs"
  - "src-tauri/src/window_geom.rs"
  - "src-tauri/src/vdesk/**"
  - "src-tauri/src/browser.rs"
  - "src-tauri/src/browser_nav.rs"
  - "src-tauri/src/html_preview.rs"
  - "src-tauri/src/drop_paths.rs"
  - "src-tauri/src/cli.rs"
  - "src-tauri/src/appmenu/**"
  - "src-tauri/src/project/**"
  - "src-tauri/src/pty/mod.rs"
---

# Rust からウィンドウと webview を触るときのルール

Tauri のウィンドウ・webview を Rust から扱うときの規則。ウィンドウの生成と対応づけ、
状態の永続化は `window.md`。

- **ウィンドウを触るコマンドは同期の `fn`** にしてある（`focus_project_window` / `window_restore` / `window_close_quits_app` / `save_all_window_state` など。一覧は `rust.md` の基本方針）
  - **ただしウィンドウを「作る」ものは例外で、必ず `async`**（`open_project_window` / `open_global_window`）。同期コマンドから `build_window` を呼ぶと Windows でデッドロックする（制約は**コマンドハンドラ**に対してで、イベントループ側のコールバックからは呼べる。判断の実体は `build_window` の doc が正本）
- **ウィンドウ操作は ack を待たない（#340）。** `show()` / `set_focus()` は `tauri-runtime-wry` の `send_user_message` を通り、**メインスレッド以外から呼ばれるとイベントを積むだけ**で返る（メインスレッドからならその場で処理する）。結果が要る `build()` や getter だけが待つ、という非対称がある
  - だから「コマンドが解決した＝ウィンドウが出ている」は**成り立たない**。成り立たせている箇所と、その待ち方は `wait_for_window_queue` / `build_window` の doc が正本
- **ウィンドウは `Window` で扱い、`WebviewWindow` を使わない（#368）。** ブラウザのタブは
  ウィンドウに子 webview を足すので、そのウィンドウは Tauri から見て「webview が 1 つだけの
  ウィンドウ」ではなくなる。すると `WebviewWindow` を取るものが全部そのウィンドウを見失う:
  - コマンドの引数の `WebviewWindow` … `current webview is not a WebviewWindow` で失敗する
  - `app.get_webview_window(label)` / `app.webview_windows()` … 黙って `None` / 除外になる
    （CLI のルーティング、トレイからの復帰、ウィンドウ位置の保存が、そのウィンドウだけ効かない）
  - 代わりに `Window` / `app.get_window` / `app.windows()` を使う。表示・フォーカス・位置・
    `hwnd`・イベントの送信は同じものがある。**例外は webview そのもの（WebView2 の COM）を
    触る `drop_paths::attach`** だけで、ウィンドウを作った直後（子がまだ無い）に呼ぶ
  - **子 webview の COM は `Webview` から触る**（`browser_nav::attach`、#416）。`add_child` が
    返す `Webview` の `with_webview` で `ICoreWebView2` に届くので、`WebviewWindow` は要らない。
    イベントの送り先は、その時点の親ウィンドウを `app.get_webview(label)` から引く（子 webview は
    別のタブへ譲られる、#402）
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
