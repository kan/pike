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
    // Check pending actions for this specific window first
    let label = window.label().to_string();
    if let Some(action) = state.pending.lock().map_err(|e| e.to_string())?.remove(&label) {
        return Ok(action);
    }
    // Fall back to initial action (main window on first launch)
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
    // Skip binary name (first arg)
    let meaningful: Vec<&str> = args.iter().skip(1).map(|s| s.as_str()).collect();

    if meaningful.is_empty() {
        return CliAction::None;
    }

    // `pike open <path>` subcommand
    let raw_path = if meaningful[0] == "open" && meaningful.len() > 1 {
        meaningful[1]
    } else if meaningful[0].starts_with('-') {
        // Skip flags (e.g. --flag)
        return CliAction::None;
    } else {
        meaningful[0]
    };

    resolve_path_arg(raw_path, cwd)
}

fn resolve_path_arg(raw: &str, cwd: &str) -> CliAction {
    let (path_str, line) = parse_path_and_line(raw);

    let path = PathBuf::from(path_str);
    let abs_path = if path.is_absolute() {
        path
    } else {
        PathBuf::from(cwd).join(path)
    };

    let abs_path = abs_path.canonicalize().unwrap_or(abs_path);
    let mut path_string = abs_path.to_string_lossy().into_owned();
    // Strip \\?\ prefix added by canonicalize on Windows
    if path_string.starts_with(r"\\?\") {
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
}
