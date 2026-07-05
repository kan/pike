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
    /// Directory matches `IGNORED_DIRS`: shown dimmed in the tree, contents
    /// are never listed (watcher/tasks/search also skip it).
    pub ignored: bool,
}

pub const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "__pycache__", ".next", ".nuxt",
    "target", "dist", "build", ".cache", ".venv", "venv",
];

/// Recursively find files whose name matches any of `names` (case-insensitive),
/// up to `max_depth` levels, skipping `IGNORED_DIRS`. Returns absolute paths in
/// the shell's native form. Shared by task discovery and diagnostics.
///
/// WSL uses a single `find` invocation; native uses `walkdir`-style recursion.
/// Note: this does not consult `.gitignore` (callers that want that use `rg`
/// first and fall back to this).
pub fn walk_files_by_name(
    shell: &ShellConfig,
    root: &str,
    names: &[&str],
    max_depth: u32,
) -> Vec<String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            let prune: String = IGNORED_DIRS
                .iter()
                .map(|d| format!("-name '{d}'"))
                .collect::<Vec<_>>()
                .join(" -o ");
            let name_expr: String = names
                .iter()
                .map(|n| format!("-name '{n}'"))
                .collect::<Vec<_>>()
                .join(" -o ");
            let script = format!(
                "find '{}' -maxdepth {max_depth} \\( {prune} \\) -prune -o \\( {name_expr} \\) -print",
                root.replace('\'', "'\\''"),
            );
            shell
                .run_stdout("bash", &["-c", &script])
                .ok()
                .map(|s| s.lines().map(|l| l.to_string()).collect())
                .unwrap_or_default()
        }
        _ => {
            let lower: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
            let mut results = Vec::new();
            walk_native(std::path::Path::new(root), &lower, max_depth, 0, &mut results);
            results
        }
    }
}

fn walk_native(
    dir: &std::path::Path,
    lower_names: &[String],
    max_depth: u32,
    depth: u32,
    results: &mut Vec<String>,
) {
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_native(&entry.path(), lower_names, max_depth, depth + 1, results);
        } else if lower_names.contains(&name.to_lowercase()) {
            if let Some(p) = entry.path().to_str() {
                results.push(p.to_string());
            }
        }
    }
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
        if name.is_empty() || name.starts_with(".DS_Store") {
            continue;
        }
        let is_dir = kind == "d";
        let ignored = is_dir && IGNORED_DIRS.contains(&name.as_str());
        let entry = FsEntry { name, is_dir, ignored };
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
        if name.starts_with(".DS_Store") {
            continue;
        }
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false);
        let ignored = is_dir && IGNORED_DIRS.contains(&name.as_str());
        let e = FsEntry { name, is_dir, ignored };
        if is_dir {
            dirs.push(e);
        } else {
            files.push(e);
        }
    }

    dirs.sort_by_key(|e| e.name.to_lowercase());
    files.sort_by_key(|e| e.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub content: String,
    pub encoding: String,
    /// True when the file does not exist yet: the editor opens it as a blank
    /// "new file" (vim-like) and the first save creates it.
    pub is_new: bool,
}

/// Read a file's raw bytes. `Ok(None)` means the file does not exist.
fn read_raw_bytes(shell: &ShellConfig, path: &str) -> Result<Option<Vec<u8>>, String> {
    const MAX_SIZE: u64 = 2_000_000;
    match shell {
        ShellConfig::Wsl { .. } => {
            match shell.run_stdout("stat", &["-c", "%s", "--", path]) {
                Ok(size_str) => {
                    if let Ok(size) = size_str.trim().parse::<u64>() {
                        if size > MAX_SIZE {
                            return Err("File too large (>2MB)".into());
                        }
                    }
                }
                Err(stat_err) => {
                    // Distinguish "missing file" (new-file editor) from other
                    // stat failures (permission, distro down, ...).
                    let script = format!("[ -e {} ]", crate::types::bash_quote(path));
                    if let Ok((code, _, _)) = shell.run("bash", &["-c", &script]) {
                        if code != 0 {
                            return Ok(None);
                        }
                    }
                    return Err(stat_err);
                }
            }
            let output = shell.run_raw("cat", &["--", path])?;
            if !output.status.success() {
                return Err(format!(
                    "Failed to read file: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Ok(Some(output.stdout))
        }
        _ => {
            let meta = match std::fs::metadata(path) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.to_string()),
            };
            if meta.len() > MAX_SIZE {
                return Err("File too large (>2MB)".into());
            }
            Ok(Some(std::fs::read(path).map_err(|e| e.to_string())?))
        }
    }
}

/// Bytes inspected for the binary-content guard.
const BINARY_SNIFF_LEN: usize = 8192;

fn decode_bytes(bytes: &[u8], encoding_name: Option<&str>) -> Result<FileReadResult, String> {
    if let Some(name) = encoding_name {
        // Explicit encoding (re-open via StatusBar) is an escape hatch: no
        // binary guard, the user asked for this interpretation.
        if let Some(enc) = Encoding::for_label(name.as_bytes()) {
            let (content, actual_enc, _) = enc.decode(bytes);
            return Ok(FileReadResult {
                content: content.into_owned(),
                encoding: actual_enc.name().to_string(),
                is_new: false,
            });
        }
    }
    // UTF-16 text legitimately contains NUL bytes — detect by BOM before the
    // binary guard. (UTF-8 BOM falls through: from_utf8 keeps the BOM char,
    // preserving the existing save round-trip.)
    if let Some((enc, _)) = Encoding::for_bom(bytes) {
        if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
            let (content, actual_enc, _) = enc.decode(bytes);
            return Ok(FileReadResult {
                content: content.into_owned(),
                encoding: actual_enc.name().to_string(),
                is_new: false,
            });
        }
    }
    // Safety net for unsupported binary formats (exe, zip, images opened via
    // CLI/"Open with", ...): refuse instead of rendering mojibake.
    if bytes.iter().take(BINARY_SNIFF_LEN).any(|&b| b == 0) {
        return Err("Binary file — cannot open in the editor".into());
    }
    Ok(match std::str::from_utf8(bytes) {
        Ok(s) => FileReadResult {
            content: s.to_string(),
            encoding: "UTF-8".to_string(),
            is_new: false,
        },
        Err(_) => {
            let (content, enc, _) = encoding_rs::SHIFT_JIS.decode(bytes);
            FileReadResult {
                content: content.into_owned(),
                encoding: enc.name().to_string(),
                is_new: false,
            }
        }
    })
}

#[tauri::command]
pub async fn fs_open_in_explorer(shell: ShellConfig, path: String) -> Result<(), String> {
    // WSL paths are reachable from Explorer through the \\wsl.localhost\ UNC view.
    let win_path = match &shell {
        ShellConfig::Wsl { distro } => {
            format!(r"\\wsl.localhost\{distro}{}", path.replace('/', "\\"))
        }
        _ => path,
    };
    tokio::task::spawn_blocking(move || {
        // explorer.exe delegates to ShellExecuteW internally — no cmd.exe
        // shell-metacharacter risk (same pattern as open_url).
        crate::types::silent_command("explorer.exe")
            .arg(&win_path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_read_file(
    shell: ShellConfig,
    path: String,
    encoding: Option<String>,
    allow_missing: Option<bool>,
) -> Result<FileReadResult, String> {
    tokio::task::spawn_blocking(move || {
        match read_raw_bytes(&shell, &path)? {
            Some(bytes) => decode_bytes(&bytes, encoding.as_deref()),
            // Editor opt-in: open a missing file as a blank new file (vim-like).
            // Other callers (existence probes, config reads) keep the error.
            None if allow_missing.unwrap_or(false) => Ok(FileReadResult {
                content: String::new(),
                encoding: "UTF-8".to_string(),
                is_new: true,
            }),
            None => Err("File not found".to_string()),
        }
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

#[tauri::command]
pub async fn fs_create_file(
    shell: ShellConfig,
    path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("touch", &["--", &path])?;
            Ok(())
        }
        _ => {
            std::fs::File::create(&path).map_err(|e| e.to_string())?;
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ensure_dir(shell: &ShellConfig, dir: &str) -> Result<(), String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("mkdir", &["-p", "--", dir])?;
            Ok(())
        }
        _ => std::fs::create_dir_all(dir).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn fs_create_dir(
    shell: ShellConfig,
    path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || ensure_dir(&shell, &path))
        .await
        .map_err(|e| e.to_string())?
}

// Upload cap for pasted/dropped files. Keep in sync with `MAX_UPLOAD_SIZE` in
// src/composables/useImagePaste.ts.
const MAX_UPLOAD_SIZE: usize = 50 * 1024 * 1024; // 50 MB

#[tauri::command]
pub async fn fs_write_file_base64(
    shell: ShellConfig,
    path: String,
    data: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data)
            .map_err(|e| format!("base64 decode error: {e}"))?;
        if bytes.len() > MAX_UPLOAD_SIZE {
            return Err(format!(
                "File too large ({} bytes, max {})",
                bytes.len(),
                MAX_UPLOAD_SIZE
            ));
        }
        // Ensure parent directory exists
        let parent = match &shell {
            ShellConfig::Wsl { .. } => path.rsplit_once('/').map(|(p, _)| p.to_string()),
            _ => std::path::Path::new(&path)
                .parent()
                .and_then(|p| p.to_str())
                .map(|s| s.to_string()),
        };
        if let Some(dir) = parent {
            let _ = ensure_dir(&shell, &dir);
        }
        write_bytes(&shell, &path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the first candidate path that exists as a regular file (not dir).
/// Used by import resolution to probe extension/index variants in one round-trip.
#[tauri::command]
pub async fn fs_resolve_first_existing(
    shell: ShellConfig,
    candidates: Vec<String>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => resolve_first_existing_wsl(&shell, &candidates),
        _ => Ok(resolve_first_existing_native(&candidates)),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn resolve_first_existing_native(candidates: &[String]) -> Option<String> {
    for path in candidates {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.is_file() {
                return Some(path.clone());
            }
        }
    }
    None
}

fn resolve_first_existing_wsl(
    shell: &ShellConfig,
    candidates: &[String],
) -> Result<Option<String>, String> {
    if candidates.is_empty() {
        return Ok(None);
    }
    // Single bash call: print first candidate that is a regular file.
    let mut script = String::new();
    for path in candidates {
        let escaped = path.replace('\'', "'\\''");
        script.push_str(&format!(
            "if [ -f '{escaped}' ]; then printf '%s' '{escaped}'; exit 0; fi\n"
        ));
    }
    let (_, stdout, _) = shell.run("bash", &["-c", &script])?;
    let trimmed = stdout.trim_end_matches(['\n', '\r']);
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_bytes_utf8() {
        let r = decode_bytes("hello\nこんにちは".as_bytes(), None).unwrap();
        assert_eq!(r.encoding, "UTF-8");
        assert!(r.content.contains("こんにちは"));
    }

    #[test]
    fn decode_bytes_binary_rejected() {
        // PNG header contains NUL-adjacent binary content; NUL byte triggers the guard
        let bytes = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D];
        assert!(decode_bytes(&bytes, None).is_err());
    }

    #[test]
    fn decode_bytes_utf16_bom_is_text() {
        // "hi" in UTF-16LE with BOM — NUL bytes present but must decode as text
        let bytes = [0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        let r = decode_bytes(&bytes, None).unwrap();
        assert_eq!(r.content, "hi");
        assert_eq!(r.encoding, "UTF-16LE");
    }

    #[test]
    fn decode_bytes_explicit_encoding_skips_guard() {
        // Explicit encoding is an escape hatch: no binary rejection
        let bytes = [b'a', 0x00, b'b'];
        assert!(decode_bytes(&bytes, Some("windows-1252")).is_ok());
    }

    #[test]
    fn read_missing_native_file_is_new() {
        // Missing file (even under a missing directory) → Ok(None), not Err —
        // the editor opens it as a blank new file.
        let r = read_raw_bytes(
            &ShellConfig::Powershell,
            r"C:\pike-test-definitely-missing\nope.txt",
        );
        assert_eq!(r, Ok(None));
    }
}
