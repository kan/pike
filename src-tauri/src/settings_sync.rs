//! External settings-sync file I/O.
//!
//! Pike does not implement settings *syncing* itself (see issue #105). Instead
//! it can mirror the environment-independent UI settings (`pike:settings`) to a
//! plain JSON file at a user-chosen host path. Point that path at a Dropbox /
//! OneDrive / git folder and the file syncs across PCs by existing means.
//!
//! These commands are shell-independent: the sync file always lives on the
//! Windows host (the Tauri process), so they use `std::fs` directly rather than
//! going through `ShellConfig` like the project-aware `fs` module.

use std::path::Path;

/// Read the external settings JSON (host absolute path) as a UTF-8 string.
/// Errors if the file does not exist or cannot be read.
#[tauri::command]
pub async fn settings_sync_read(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || std::fs::read_to_string(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Write the external settings JSON (host absolute path), creating parent
/// directories as needed.
#[tauri::command]
pub async fn settings_sync_write(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = Path::new(&path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
