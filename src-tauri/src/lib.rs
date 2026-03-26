mod docker;
mod font;
mod fs;
mod git;
mod search;
mod project;
mod pty;
mod types;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Prefix for project window labels. Must match PROJECT_WINDOW_PREFIX in src/lib/window.ts
const PROJECT_WINDOW_PREFIX: &str = "project-";

#[tauri::command]
async fn open_project_window(project_id: String, app: AppHandle) -> Result<(), String> {
    let label = format!("{}{}", PROJECT_WINDOW_PREFIX, project_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    match WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Hearth")
        .inner_size(800.0, 600.0)
        .resizable(true)
        .disable_drag_drop_handler()
        .build()
    {
        Ok(_) => Ok(()),
        Err(_) => {
            // Window was likely created by a concurrent call; focus it
            if let Some(w) = app.get_webview_window(&label) {
                w.set_focus().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty::PtyState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
        .manage(docker::DockerState {
            log_streams: Arc::new(Mutex::new(HashMap::new())),
            client: tokio::sync::OnceCell::new(),
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(config_dir.join("projects"))
                .map_err(|e| e.to_string())?;
            app.manage(project::ProjectState { config_dir });

            // Resolve bundled rg sidecar path (externalBin places it next to the executable)
            let rg_path = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
                .and_then(|dir| {
                    let p = dir.join("rg.exe");
                    p.exists().then(|| p.to_string_lossy().into_owned())
                });
            app.manage(search::SearchState {
                bundled_rg: rg_path,
                detected: std::sync::Mutex::new(None),
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if window.label() != "main" {
                    return;
                }
                if let Some(state) = window.try_state::<pty::PtyState>() {
                    if let Ok(mut sessions) = state.sessions.lock() {
                        sessions.clear();
                    }
                }
                if let Some(state) = window.try_state::<docker::DockerState>() {
                    if let Ok(mut streams) = state.log_streams.lock() {
                        for (_, handle) in streams.drain() {
                            handle.abort();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_project_window,
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
            fs::fs_read_file_base64,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_copy,
            docker::docker_ping,
            docker::docker_compose_services,
            docker::docker_list_containers,
            docker::docker_start,
            docker::docker_stop,
            docker::docker_restart,
            docker::docker_logs_start,
            docker::docker_logs_stop,
            docker::docker_detect_shell,
            search::search_detect_backend,
            search::search_execute,
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
            git::git_show_file,
            git::git_log_file,
            git::git_diff_commit,
            git::git_diff_lines,
            font::font_list_monospace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
