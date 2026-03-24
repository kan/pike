mod fs;
mod git;
mod project;
mod pty;
mod types;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(config_dir.join("projects"))
                .map_err(|e| e.to_string())?;
            app.manage(project::ProjectState { config_dir });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_spawn_tmux,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            project::detect_wsl_distros,
            project::project_get_last,
            project::project_set_last,
            project::project_list,
            project::project_get,
            project::project_create,
            project::project_update,
            project::project_delete,
            fs::fs_list_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            git::git_status,
            git::git_log,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branch_list,
            git::git_checkout,
            git::git_push,
            git::git_pull,
            git::git_show_files,
            git::git_diff_commit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
