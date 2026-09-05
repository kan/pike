// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // macOS / Linux の GUI 起動は launchd の最小 PATH しか継がない。以降のあらゆる
    // spawn が前提にするので、実際に spawn する経路（wait::* と run()）より前に広げる。
    // スレッドが立つ前でなければならない（set_var はプロセス全体を触る）。
    app_lib::augment_process_path();

    // エージェントの hook からの申告（#299）。**--wait の 2 つより先**に見る:
    // hook は Pike のターミナルの中で走るので PIKE_WINDOW_LABEL を持っており、
    // 下の転送が先に走ると `agent-hook` という名前のファイルを開こうとする。
    // Tauri は起動せず、申告を書いて終わる。
    app_lib::agent_hook::try_agent_hook_and_exit();

    // If --wait is present and another Pike instance is running,
    // send the args and block until editing completes (for GIT_EDITOR support).
    // This must run before the Tauri runtime to avoid the single-instance
    // plugin's immediate std::process::exit(0).
    app_lib::wait::try_wait_and_exit();

    // If pike CLI was invoked from inside a Pike terminal (PIKE_WINDOW_LABEL is
    // set by pty_spawn), forward args with --from-window so the file opens in
    // that window's editor. Bypasses the plugin to inject the extra flag.
    app_lib::wait::try_forward_pty_origin_and_exit();

    app_lib::run();
}
