use crate::types::ShellConfig;
use serde::Serialize;
use std::io::Write as IoWrite;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
}

const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "__pycache__", ".next", ".nuxt",
    "target", "dist", "build", ".cache", ".venv", "venv",
];

fn should_ignore(name: &str) -> bool {
    name.starts_with(".DS_Store") || IGNORED_DIRS.contains(&name)
}

#[tauri::command]
pub async fn fs_list_dir(
    shell: ShellConfig,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { distro } => list_dir_wsl(distro, &path),
        _ => list_dir_native(&path),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_dir_wsl(distro: &str, path: &str) -> Result<Vec<FsEntry>, String> {
    let script = format!(
        "find '{}' -maxdepth 1 -mindepth 1 -printf '%y\\t%f\\n' 2>/dev/null | sort -t'\t' -k2",
        path.replace('\'', "'\\''")
    );
    let output = Command::new("wsl.exe")
        .args(["-d", distro, "bash", "-c", &script])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, '\t');
        let kind = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").to_string();
        if name.is_empty() || should_ignore(&name) {
            continue;
        }
        let is_dir = kind == "d";
        let entry = FsEntry { name, is_dir };
        if is_dir {
            dirs.push(entry);
        } else {
            files.push(entry);
        }
    }

    dirs.extend(files);
    Ok(dirs)
}

fn list_dir_native(path: &str) -> Result<Vec<FsEntry>, String> {
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_ignore(&name) {
            continue;
        }
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false);
        let e = FsEntry { name, is_dir };
        if is_dir {
            dirs.push(e);
        } else {
            files.push(e);
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub async fn fs_read_file(
    shell: ShellConfig,
    path: String,
) -> Result<String, String> {
    const MAX_SIZE: u64 = 2_000_000;
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { distro } => {
            // Check size first to avoid reading huge files
            let size_out = Command::new("wsl.exe")
                .args(["-d", distro, "stat", "-c", "%s", &path])
                .output()
                .map_err(|e| e.to_string())?;
            if let Ok(size_str) = String::from_utf8(size_out.stdout) {
                if let Ok(size) = size_str.trim().parse::<u64>() {
                    if size > MAX_SIZE {
                        return Err("File too large (>2MB)".into());
                    }
                }
            }
            let output = Command::new("wsl.exe")
                .args(["-d", distro, "cat", &path])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "Failed to read file: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        _ => {
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.len() > MAX_SIZE {
                return Err("File too large (>2MB)".into());
            }
            std::fs::read_to_string(&path).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_write_file(
    shell: ShellConfig,
    path: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { distro } => {
            let mut child = Command::new("wsl.exe")
                .args([
                    "-d",
                    distro,
                    "bash",
                    "-c",
                    &format!("cat > '{}'", path.replace('\'', "'\\''")),
                ])
                .stdin(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;

            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(content.as_bytes())
                    .map_err(|e| e.to_string())?;
            }

            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Failed to write file".into());
            }
            Ok(())
        }
        _ => {
            std::fs::write(&path, &content).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
