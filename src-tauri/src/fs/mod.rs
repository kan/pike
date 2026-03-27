use base64::Engine as _;
use crate::types::{ShellConfig, wait_with_timeout};
use encoding_rs::Encoding;
use serde::Serialize;
use std::io::Write as IoWrite;

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
        ShellConfig::Wsl { .. } => list_dir_wsl(&shell, &path),
        _ => list_dir_native(&path),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_dir_wsl(shell: &ShellConfig, path: &str) -> Result<Vec<FsEntry>, String> {
    let script = format!(
        "find '{}' -maxdepth 1 -mindepth 1 -printf '%y\\t%f\\n' 2>/dev/null | sort -t'\t' -k2",
        path.replace('\'', "'\\''")
    );
    let (_, stdout, _) = shell.run("bash", &["-c", &script])?;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub content: String,
    pub encoding: String,
}

fn read_raw_bytes(shell: &ShellConfig, path: &str) -> Result<Vec<u8>, String> {
    const MAX_SIZE: u64 = 2_000_000;
    match shell {
        ShellConfig::Wsl { .. } => {
            let size_str = shell.run_stdout("stat", &["-c", "%s", "--", path])?;
            if let Ok(size) = size_str.trim().parse::<u64>() {
                if size > MAX_SIZE {
                    return Err("File too large (>2MB)".into());
                }
            }
            let output = shell.run_raw("cat", &["--", path])?;
            if !output.status.success() {
                return Err(format!(
                    "Failed to read file: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Ok(output.stdout)
        }
        _ => {
            let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
            if meta.len() > MAX_SIZE {
                return Err("File too large (>2MB)".into());
            }
            std::fs::read(path).map_err(|e| e.to_string())
        }
    }
}

fn decode_bytes(bytes: &[u8], encoding_name: Option<&str>) -> FileReadResult {
    if let Some(name) = encoding_name {
        if let Some(enc) = Encoding::for_label(name.as_bytes()) {
            let (content, actual_enc, _) = enc.decode(bytes);
            return FileReadResult {
                content: content.into_owned(),
                encoding: actual_enc.name().to_string(),
            };
        }
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => FileReadResult {
            content: s.to_string(),
            encoding: "UTF-8".to_string(),
        },
        Err(_) => {
            let (content, enc, _) = encoding_rs::SHIFT_JIS.decode(bytes);
            FileReadResult {
                content: content.into_owned(),
                encoding: enc.name().to_string(),
            }
        }
    }
}

#[tauri::command]
pub async fn fs_read_file(
    shell: ShellConfig,
    path: String,
    encoding: Option<String>,
) -> Result<FileReadResult, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = read_raw_bytes(&shell, &path)?;
        Ok(decode_bytes(&bytes, encoding.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn encode_content(content: &str, encoding_name: Option<&str>) -> Vec<u8> {
    if let Some(name) = encoding_name {
        if name != "UTF-8" {
            if let Some(enc) = Encoding::for_label(name.as_bytes()) {
                let (bytes, _, _) = enc.encode(content);
                return bytes.into_owned();
            }
        }
    }
    content.as_bytes().to_vec()
}

fn write_bytes(shell: &ShellConfig, path: &str, bytes: &[u8]) -> Result<(), String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            let script = format!("cat > '{}'", path.replace('\'', "'\\''"));
            let mut child = shell
                .command("bash", &["-c", &script])
                .stdin(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;

            let pid = child.id();
            let stdin = child.stdin.take();
            let bytes_owned = bytes.to_vec();

            let status = wait_with_timeout(
                pid,
                std::time::Duration::from_secs(30),
                "write",
                move || {
                    if let Some(mut w) = stdin {
                        let _ = w.write_all(&bytes_owned);
                    }
                    child.wait()
                },
            )?;
            if status.success() {
                Ok(())
            } else {
                Err("Failed to write file".into())
            }
        }
        _ => std::fs::write(path, bytes).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn fs_write_file(
    shell: ShellConfig,
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let bytes = encode_content(&content, encoding.as_deref());
        write_bytes(&shell, &path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_read_file_base64(
    shell: ShellConfig,
    path: String,
) -> Result<String, String> {
    const MAX_SIZE: u64 = 10_000_000;
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            let size_str = shell.run_stdout("stat", &["-c", "%s", "--", &path])?;
            if let Ok(size) = size_str.trim().parse::<u64>() {
                if size > MAX_SIZE {
                    return Err("File too large (>10MB)".into());
                }
            }
            let stdout = shell.run_stdout("base64", &["-w0", "--", &path])?;
            Ok(stdout.trim().to_string())
        }
        _ => {
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.len() > MAX_SIZE {
                return Err("File too large (>10MB)".into());
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_rename(
    shell: ShellConfig,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("mv", &["--", &old_path, &new_path])?;
            Ok(())
        }
        _ => std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_delete(
    shell: ShellConfig,
    path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("rm", &["-rf", "--", &path])?;
            Ok(())
        }
        _ => {
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
            } else {
                std::fs::remove_file(&path).map_err(|e| e.to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_copy(
    shell: ShellConfig,
    source: String,
    dest: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("cp", &["-r", "--", &source, &dest])?;
            Ok(())
        }
        _ => {
            let meta = std::fs::metadata(&source).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                copy_dir_recursive(&source, &dest)
            } else {
                std::fs::copy(&source, &dest)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &str, dst: &str) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = std::path::Path::new(dst).join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(
                src_path.to_str().unwrap_or(""),
                dst_path.to_str().unwrap_or(""),
            )?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
