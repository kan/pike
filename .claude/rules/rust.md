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
  - **ただしウィンドウを「作る」ものは必ず `async`**（同期コマンドから `build_window` を呼ぶと Windows でデッドロックする）。ウィンドウと webview を触るときの規則は `rust-window.md`
- エラーは `map_err(|e| e.to_string())` で文字列化してフロントに返す
- **グローバル状態は 1 つの `AppState` にまとめず、モジュールごとの型を個別に `manage` する**（`CliState` / `WaitState` / `PtyState` / `WatcherState` / `DockerState` / `ProjectState` / `TransientState` / `SearchState` / `PreviewState` / `IssuesState`。一覧の正本は `lib.rs` の `manage` の並び）。コマンドは `State<'_, PtyState>` のように要るものだけを受け取るので、引数の型がそのまま「このコマンドが触る状態」の宣言になる。共有する中身は `Arc<Mutex<>>` で包む

## 非同期
- `tokio::runtime` は Tauri が管理するため、コマンド内で別途ランタイムを作らない
- ブロッキング処理は `tokio::task::spawn_blocking` に逃がす

## 命名規約
- Tauri コマンド: `{module}_{action}` 例: `pty_spawn`, `pty_write`, `git_log`
- イベント名: `{module}_{event}` 例: `pty_output`, `pty_exit`, `fs_changed`
