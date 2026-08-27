// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `pike todo ...` operates directly on the project's .pike/todo.md and exits,
  // never launching the GUI. Handle it before the single-instance forwarding
  // (try_forward_pty_origin_and_exit) — otherwise "todo" is routed as a file path.
  //
  // **PATH 補正より前に置く。** この経路は `std::fs` しか使わず外部プロセスを 1 つも
  // 起動しないので、補正は丸ごと無駄になる（`UNIX_EXTRA_PATH` の分だけ `is_dir` を叩き、
  // PATH を組み直し、プロセス全体の環境を書き換える）。エージェントのスキルはこの CLI を
  // 繰り返し呼ぶため、1 回きりではなく呼び出しのたびに乗る。
  app_lib::todo_cli::try_todo_and_exit();

  // macOS / Linux の GUI 起動は launchd の最小 PATH しか継がない。以降のあらゆる
  // spawn が前提にするので、実際に spawn する経路（wait::* と run()）より前に広げる。
  // スレッドが立つ前でなければならない（set_var はプロセス全体を触る）。
  app_lib::augment_process_path();

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
