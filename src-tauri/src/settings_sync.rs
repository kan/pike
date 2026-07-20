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
/// `None` means "no file yet" — every other failure is an error, so a caller
/// doing a read-modify-write can tell "nothing here" (safe to write a fresh
/// file) from "could not read" (writing would drop whatever is in there).
#[tauri::command]
pub async fn settings_sync_read(path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write the external settings JSON (host absolute path), creating parent
/// directories as needed. Writes a sibling temp file and renames it over the
/// target, so a reader (this app on another window, or the sync client) never
/// observes a half-written file.
#[tauri::command]
pub async fn settings_sync_write(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let target = Path::new(&path);
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        let temp = target.with_extension("tmp");
        std::fs::write(&temp, content).map_err(|e| e.to_string())?;
        // Windows rename fails when the destination exists, so replace it.
        std::fs::rename(&temp, target).or_else(|_| {
            let result = std::fs::remove_file(target)
                .map_err(|e| e.to_string())
                .and_then(|_| std::fs::rename(&temp, target).map_err(|e| e.to_string()));
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
