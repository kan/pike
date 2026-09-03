# Rust 実装ルール

## 基本方針
- Tauri コマンドは `async fn` を既定にし、戻り値は `Result<T, String>`。**ウィンドウを触るものと、状態を読むだけで即答できるものは同期の `fn`** にしてある（`project_for_window` / `focus_project_window` / `window_close_quits_app` / `save_all_window_state` / `wait_signal_by_path` / `is_elevated` / `open_elevated_terminal`）
- エラーは `map_err(|e| e.to_string())` で文字列化してフロントに返す
- **グローバル状態は 1 つの `AppState` にまとめず、モジュールごとの型を個別に `manage` する**（`CliState` / `WaitState` / `PtyState` / `WatcherState` / `DockerState` / `ProjectState` / `TransientState` / `SearchState`）。コマンドは `State<'_, PtyState>` のように要るものだけを受け取るので、引数の型がそのまま「このコマンドが触る状態」の宣言になる。共有する中身は `Arc<Mutex<>>` で包む
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
