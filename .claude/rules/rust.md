# Rust 実装ルール

## 基本方針
- Tauri コマンドは `async fn` で統一し、戻り値は `Result<T, String>`
- エラーは `map_err(|e| e.to_string())` で文字列化してフロントに返す
- グローバル状態は `tauri::State<AppState>` で管理、`Arc<Mutex<>>` で包む
- PTY プロセスのライフタイムは AppState が所有し、ウィンドウ破棄時に cleanup

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
