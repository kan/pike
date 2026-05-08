// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
