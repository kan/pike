use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum CliAction {
    OpenFile { path: String, line: Option<u32> },
    OpenDirectory { path: String },
    None,
}

pub struct CliState {
    /// Initial action for the main window (first launch)
    pub initial_action: Mutex<Option<CliAction>>,
    /// Pending actions for project windows (keyed by window label)
    pub pending: Mutex<HashMap<String, CliAction>>,
}

#[tauri::command]
pub async fn cli_get_initial_action(
    state: State<'_, CliState>,
    window: tauri::WebviewWindow,
) -> Result<CliAction, String> {
    let label = window.label().to_string();
    let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
    log::debug!("[cli] cli_get_initial_action: label={label}, pending_keys={:?}", pending.keys().collect::<Vec<_>>());
    if let Some(action) = pending.remove(&label) {
        log::debug!("[cli] found pending action for {label}: {action:?}");
        return Ok(action);
    }
    drop(pending);
    Ok(state
        .initial_action
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .unwrap_or(CliAction::None))
}

#[tauri::command]
pub async fn cli_set_pending_action(
    window_label: String,
    action: CliAction,
    state: State<'_, CliState>,
) -> Result<(), String> {
    state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window_label, action);
    Ok(())
}

/// Parse raw CLI args (from std::env::args or single-instance callback).
/// `cwd` is used to resolve relative paths.
pub fn parse_args(args: &[String], cwd: &str) -> CliAction {
    // Skip binary name and known flags (--wait, --wait-id=...)
    let meaningful: Vec<&str> = args
        .iter()
        .skip(1)
        .map(|s| s.as_str())
        .filter(|s| *s != "--wait" && !s.starts_with("--wait-id="))
        .collect();

    if meaningful.is_empty() {
        return CliAction::None;
    }

    // `pike open <path>` subcommand
    let raw_path = if meaningful[0] == "open" && meaningful.len() > 1 {
        meaningful[1]
    } else if meaningful[0].starts_with('-') {
        return CliAction::None;
    } else {
        meaningful[0]
    };

    resolve_path_arg(raw_path, cwd)
}

/// Extract WSL distro name from a UNC path like `\\wsl.localhost\Ubuntu\...` or `\\wsl$\Ubuntu\...`.
pub fn wsl_distro_from_path(path: &str) -> Option<String> {
    wsl_distro_from_unc(path)
}

fn wsl_distro_from_unc(cwd: &str) -> Option<String> {
    let norm = cwd.replace('\\', "/");
    let rest = norm
        .strip_prefix("//wsl.localhost/")
        .or_else(|| norm.strip_prefix("//wsl$/"))?;
    rest.split('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn resolve_path_arg(raw: &str, cwd: &str) -> CliAction {
    let (path_str, line) = parse_path_and_line(raw);

    let path = PathBuf::from(path_str);
    let abs_path = if path_str.starts_with('/') {
        // Unix-style absolute path (e.g. /home/user/file).
        // On Windows this is NOT absolute (just root-relative to current drive).
        // If CWD is a WSL UNC path, convert to \\wsl.localhost\{distro}\...
        if let Some(ref distro) = wsl_distro_from_unc(cwd) {
            PathBuf::from(format!(
                r"\\wsl.localhost\{distro}{}",
                path_str.replace('/', "\\")
            ))
        } else {
            PathBuf::from(cwd).join(path)
        }
    } else if path.is_absolute() {
        path
    } else {
        PathBuf::from(cwd).join(path)
    };

    let abs_path = abs_path.canonicalize().unwrap_or(abs_path);
    let mut path_string = abs_path.to_string_lossy().into_owned();
    // Strip \\?\ prefix added by canonicalize on Windows
    // Also handle UNC: \\?\UNC\wsl.localhost\... → \\wsl.localhost\...
    if path_string.starts_with(r"\\?\UNC\") {
        path_string = format!(r"\\{}", &path_string[8..]);
    } else if path_string.starts_with(r"\\?\") {
        path_string = path_string[4..].to_string();
    }

    if abs_path.is_dir() {
        CliAction::OpenDirectory { path: path_string }
    } else {
        CliAction::OpenFile {
            path: path_string,
            line,
        }
    }
}

/// Split "file.rs:42" into ("file.rs", Some(42)).
/// Careful not to split on Windows drive letter (e.g. "C:\foo").
fn parse_path_and_line(raw: &str) -> (&str, Option<u32>) {
    if let Some(last_colon) = raw.rfind(':') {
        let after = &raw[last_colon + 1..];
        if let Ok(line) = after.parse::<u32>() {
            // Avoid splitting "C:" — drive letter is a single alpha char at position 0
            if last_colon > 1 || !raw.as_bytes()[0].is_ascii_alphabetic() {
                return (&raw[..last_colon], Some(line));
            }
        }
    }
    (raw, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_path_and_line() {
        assert_eq!(parse_path_and_line("file.rs:42"), ("file.rs", Some(42)));
        assert_eq!(parse_path_and_line("file.rs"), ("file.rs", None));
        assert_eq!(parse_path_and_line("C:\\foo\\bar.rs:10"), ("C:\\foo\\bar.rs", Some(10)));
        assert_eq!(parse_path_and_line("C:"), ("C:", None));
        assert_eq!(parse_path_and_line("src/main.ts:1"), ("src/main.ts", Some(1)));
    }

    #[test]
    fn test_parse_args_empty() {
        let args = vec!["pike.exe".to_string()];
        assert!(matches!(parse_args(&args, "."), CliAction::None));
    }

    #[test]
    fn test_parse_args_open_subcommand() {
        let args = vec!["pike.exe".to_string(), "open".to_string(), "file.rs".to_string()];
        match parse_args(&args, "C:\\project") {
            CliAction::OpenFile { path, line } => {
                assert!(path.contains("file.rs"));
                assert_eq!(line, None);
            }
            _ => panic!("expected OpenFile"),
        }
    }

    #[test]
    fn test_parse_args_flags_ignored() {
        let args = vec!["pike.exe".to_string(), "--help".to_string()];
        assert!(matches!(parse_args(&args, "."), CliAction::None));
    }

    #[test]
    fn test_wsl_distro_from_unc() {
        assert_eq!(
            wsl_distro_from_unc(r"\\wsl.localhost\Ubuntu\home\user"),
            Some("Ubuntu".to_string())
        );
        assert_eq!(
            wsl_distro_from_unc(r"\\wsl$\Debian\tmp"),
            Some("Debian".to_string())
        );
        assert_eq!(wsl_distro_from_unc(r"C:\Users\foo"), None);
    }

    #[test]
    fn test_wsl_absolute_path_conversion() {
        let args = vec!["pike.exe".to_string(), "/home/user/file.rs".to_string()];
        match parse_args(&args, r"\\wsl.localhost\Ubuntu\home\user") {
            CliAction::OpenFile { path, .. } => {
                assert!(
                    path.starts_with(r"\\wsl.localhost\Ubuntu\home\user\file.rs"),
                    "expected UNC path, got: {path}"
                );
            }
            other => panic!("expected OpenFile, got: {other:?}"),
        }
    }

    #[test]
    fn test_wait_flag_stripped() {
        // --wait should be stripped; file.rs should still be parsed
        let args = vec!["pike.exe".to_string(), "--wait".to_string(), "file.rs".to_string()];
        match parse_args(&args, "C:\\project") {
            CliAction::OpenFile { path, .. } => {
                assert!(path.contains("file.rs"), "expected file.rs in path, got: {path}");
            }
            other => panic!("expected OpenFile, got: {other:?}"),
        }

        // --wait-id=xxx should also be stripped
        let args2 = vec![
            "pike.exe".to_string(),
            "--wait-id=abc123".to_string(),
            "file.rs".to_string(),
        ];
        match parse_args(&args2, "C:\\project") {
            CliAction::OpenFile { path, .. } => {
                assert!(path.contains("file.rs"), "expected file.rs in path, got: {path}");
            }
            other => panic!("expected OpenFile, got: {other:?}"),
        }
    }
}
