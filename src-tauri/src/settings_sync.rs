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
///
/// **同期ファイルは symlink でありうる**（置き場は上の doc のとおり git フォルダ等で、
/// dotfiles から配る構成がある）。`crate::fs::write_host_atomic` を通すのは、素朴な
/// 「一時ファイル ＋ `rename`」がリンクそのものを置き換えるため（#320 で hook の登録が
/// 実際にそれをやった）。モードの引き継ぎと後始末もあちらが持つ。
#[tauri::command]
pub async fn settings_sync_write(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let target = Path::new(&path);
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        crate::fs::write_host_atomic(target, content.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}
