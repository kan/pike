use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliFileTarget {
    pub path: String,
    pub line: Option<u32>,
    /// WSL distro hint when the path was originally a WSL UNC path. Lets the
    /// frontend rebuild a `\\wsl.localhost\...` path for project-less (global)
    /// windows whose file I/O runs on the Windows side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum CliAction {
    OpenFiles {
        files: Vec<CliFileTarget>,
    },
    OpenDirectory {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        distro: Option<String>,
    },
    /// Open a project-independent terminal tab (global terminal window).
    OpenTerminal {
        cwd: Option<String>,
        /// Only set when the shell is derived from the cwd (WSL UNC → that
        /// distro). None means "no preference" — the frontend applies the
        /// user's globalShell setting (#125).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<crate::types::ShellConfig>,
    },
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

/// Extract `--from-window=<label>` from args (set by pike CLI when invoked
/// from inside a Pike terminal — see PIKE_WINDOW_LABEL forwarding in wait.rs).
pub fn extract_from_window(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|a| a.strip_prefix("--from-window=").map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
}

/// Parse raw CLI args (from std::env::args or single-instance callback).
/// `cwd` is used to resolve relative paths.
pub fn parse_args(args: &[String], cwd: &str) -> CliAction {
    // Skip binary name and known flags (--wait, --wait-id=..., --from-window=...)
    let mut meaningful: Vec<&str> = args
        .iter()
        .skip(1)
        .map(|s| s.as_str())
        .filter(|s| {
            *s != "--wait" && !s.starts_with("--wait-id=") && !s.starts_with("--from-window=")
        })
        .collect();

    // `--terminal`: force global-mode terminal launch. On cold start the main
    // window becomes a global terminal (App.vue enters global mode for an
    // OpenTerminal initial action); while already running it opens a new global
    // terminal window. Carries the invocation cwd like a plain `pike` terminal.
    if meaningful.contains(&"--terminal") {
        return terminal_action_for_cwd(cwd);
    }

    // `pike open <path>...` subcommand — same as passing the paths directly
    if meaningful.first() == Some(&"open") {
        meaningful.remove(0);
    }

    match meaningful.first() {
        None => return CliAction::None,
        Some(s) if s.starts_with('-') => return CliAction::None,
        _ => {}
    }

    // Multiple real-file args (drag & drop onto pike.exe, Explorer "Open with"
    // multi-select) open one editor tab each. A directory is only meaningful
    // as the first argument (project switch); later args that resolve to
    // directories are ignored.
    let mut files: Vec<CliFileTarget> = Vec::new();
    for (i, raw) in meaningful.iter().enumerate() {
        match resolve_path_arg(raw, cwd) {
            ResolvedArg::Dir { path, distro } => {
                if i == 0 {
                    return CliAction::OpenDirectory { path, distro };
                }
            }
            ResolvedArg::File(target) => files.push(target),
        }
    }

    if files.is_empty() {
        CliAction::None
    } else {
        CliAction::OpenFiles { files }
    }
}

/// Build the OpenTerminal action for a plain `pike` invocation: WSL shell when
/// the invocation cwd is a WSL UNC path, otherwise no shell preference (the
/// frontend falls back to the globalShell setting). The cwd is carried over
/// so the terminal starts where the command was run.
pub fn terminal_action_for_cwd(cwd: &str) -> CliAction {
    if let Some((distro, native)) = split_wsl_unc(cwd) {
        CliAction::OpenTerminal {
            cwd: Some(native),
            shell: Some(crate::types::ShellConfig::Wsl { distro }),
        }
    } else {
        CliAction::OpenTerminal {
            cwd: (!cwd.is_empty()).then(|| cwd.to_string()),
            shell: None,
        }
    }
}

/// Extract WSL distro name from a UNC path like `\\wsl.localhost\Ubuntu\...` or `\\wsl$\Ubuntu\...`.
pub fn wsl_distro_from_path(path: &str) -> Option<String> {
    split_wsl_unc(path).map(|(distro, _)| distro)
}

/// Parse a WSL UNC path into `(distro, native_path)`. Accepts both
/// `\\wsl.localhost\<distro>\<rest>` and `\\wsl$\<distro>\<rest>`.
///
/// WSL projects in Pike store native paths (e.g. `/home/kan/foo`), and
/// `fs_read_file` runs the path verbatim inside `wsl.exe bash -c "cat ..."`,
/// where UNC paths are unreachable. We always emit native paths from the CLI
/// for WSL targets so both project-root matching and file I/O work — and we
/// preserve the distro alongside so ad-hoc projects can be created as WSL.
fn split_wsl_unc(path: &str) -> Option<(String, String)> {
    let norm = path.replace('\\', "/");
    let rest = norm
        .strip_prefix("//wsl.localhost/")
        .or_else(|| norm.strip_prefix("//wsl$/"))?;
    let mut parts = rest.splitn(2, '/');
    let distro = parts.next().filter(|s| !s.is_empty())?.to_string();
    let tail = parts.next().unwrap_or("");
    Some((distro, format!("/{tail}")))
}

enum ResolvedArg {
    Dir { path: String, distro: Option<String> },
    File(CliFileTarget),
}

fn resolve_path_arg(raw: &str, cwd: &str) -> ResolvedArg {
    let (path_str, line) = parse_path_and_line(raw);

    let path = PathBuf::from(path_str);
    let abs_path = if path_str.starts_with('/') {
        // Unix-style absolute path (e.g. /home/user/file).
        // On Windows this is NOT absolute (just root-relative to current drive).
        // If CWD is a WSL UNC path, convert to \\wsl.localhost\{distro}\...
        if let Some(distro) = wsl_distro_from_path(cwd) {
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
    let is_dir = abs_path.is_dir();
    let mut path_string = abs_path.to_string_lossy().into_owned();
    // Strip \\?\ prefix added by canonicalize on Windows
    // Also handle UNC: \\?\UNC\wsl.localhost\... → \\wsl.localhost\...
    if path_string.starts_with(r"\\?\UNC\") {
        path_string = format!(r"\\{}", &path_string[8..]);
    } else if path_string.starts_with(r"\\?\") {
        path_string = path_string[4..].to_string();
    }

    // For WSL UNC paths, swap in the native form and keep the distro so
    // ad-hoc project creation can build a WSL project (native path alone
    // is ambiguous with a Windows root-relative path).
    let distro = split_wsl_unc(&path_string).map(|(d, native)| {
        path_string = native;
        d
    });

    if is_dir {
        ResolvedArg::Dir {
            path: path_string,
            distro,
        }
    } else {
        ResolvedArg::File(CliFileTarget {
            path: path_string,
            line,
            distro,
        })
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

    /// Unwrap a single-file OpenFiles action.
    fn expect_single_file(action: CliAction) -> CliFileTarget {
        match action {
            CliAction::OpenFiles { files } => {
                assert_eq!(files.len(), 1, "expected exactly 1 file, got: {files:?}");
                files.into_iter().next().unwrap()
            }
            other => panic!("expected OpenFiles, got: {other:?}"),
        }
    }

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
        let f = expect_single_file(parse_args(&args, "C:\\project"));
        assert!(f.path.contains("file.rs"));
        assert_eq!(f.line, None);
    }

    #[test]
    fn test_parse_args_multiple_files() {
        // Drag & drop onto pike.exe / Explorer "Open with" pass multiple paths
        let args = vec![
            "pike.exe".to_string(),
            "a-nonexistent.rs".to_string(),
            "b-nonexistent.md:12".to_string(),
        ];
        match parse_args(&args, "C:\\project") {
            CliAction::OpenFiles { files } => {
                assert_eq!(files.len(), 2);
                assert!(files[0].path.contains("a-nonexistent.rs"));
                assert_eq!(files[0].line, None);
                assert!(files[1].path.contains("b-nonexistent.md"));
                assert_eq!(files[1].line, Some(12));
            }
            other => panic!("expected OpenFiles, got: {other:?}"),
        }
    }

    #[test]
    fn test_terminal_action_for_cwd() {
        match terminal_action_for_cwd(r"\\wsl.localhost\Ubuntu\home\user") {
            CliAction::OpenTerminal { cwd, shell } => {
                assert_eq!(cwd.as_deref(), Some("/home/user"));
                assert!(matches!(shell, Some(crate::types::ShellConfig::Wsl { ref distro }) if distro == "Ubuntu"));
            }
            other => panic!("expected OpenTerminal, got: {other:?}"),
        }
        // Non-WSL cwd: no shell preference — the frontend applies globalShell (#125)
        match terminal_action_for_cwd(r"C:\Users\foo") {
            CliAction::OpenTerminal { cwd, shell } => {
                assert_eq!(cwd.as_deref(), Some(r"C:\Users\foo"));
                assert!(shell.is_none());
            }
            other => panic!("expected OpenTerminal, got: {other:?}"),
        }
    }

    #[test]
    fn test_parse_args_flags_ignored() {
        let args = vec!["pike.exe".to_string(), "--help".to_string()];
        assert!(matches!(parse_args(&args, "."), CliAction::None));
    }

    #[test]
    fn test_parse_args_terminal_flag() {
        // --terminal forces a global terminal launch, carrying the cwd.
        let args = vec!["pike.exe".to_string(), "--terminal".to_string()];
        match parse_args(&args, r"C:\Users\foo") {
            CliAction::OpenTerminal { cwd, shell } => {
                assert_eq!(cwd.as_deref(), Some(r"C:\Users\foo"));
                assert!(shell.is_none());
            }
            other => panic!("expected OpenTerminal, got: {other:?}"),
        }
        // WSL UNC cwd → WSL shell for that distro
        match parse_args(&args, r"\\wsl.localhost\Ubuntu\home\user") {
            CliAction::OpenTerminal { cwd, shell } => {
                assert_eq!(cwd.as_deref(), Some("/home/user"));
                assert!(matches!(shell, Some(crate::types::ShellConfig::Wsl { ref distro }) if distro == "Ubuntu"));
            }
            other => panic!("expected OpenTerminal, got: {other:?}"),
        }
    }

    #[test]
    fn test_wsl_distro_from_path() {
        assert_eq!(
            wsl_distro_from_path(r"\\wsl.localhost\Ubuntu\home\user"),
            Some("Ubuntu".to_string())
        );
        assert_eq!(
            wsl_distro_from_path(r"\\wsl$\Debian\tmp"),
            Some("Debian".to_string())
        );
        assert_eq!(wsl_distro_from_path(r"C:\Users\foo"), None);
    }

    #[test]
    fn test_wsl_absolute_path_conversion() {
        // /home/user/file.rs from a WSL UNC cwd should resolve to a native
        // WSL path (not UNC), so it matches WSL project roots and is readable
        // inside `wsl.exe bash -c "cat ..."`.
        let args = vec!["pike.exe".to_string(), "/home/user/file.rs".to_string()];
        let f = expect_single_file(parse_args(&args, r"\\wsl.localhost\Ubuntu\home\user"));
        assert_eq!(f.path, "/home/user/file.rs");
        assert_eq!(f.distro.as_deref(), Some("Ubuntu"));
    }

    #[test]
    fn test_split_wsl_unc() {
        assert_eq!(
            split_wsl_unc(r"\\wsl.localhost\Ubuntu\home\user\file.rs"),
            Some(("Ubuntu".to_string(), "/home/user/file.rs".to_string()))
        );
        assert_eq!(
            split_wsl_unc(r"\\wsl$\Debian\tmp\foo"),
            Some(("Debian".to_string(), "/tmp/foo".to_string()))
        );
        // Distro root (no tail)
        assert_eq!(
            split_wsl_unc(r"\\wsl.localhost\Ubuntu"),
            Some(("Ubuntu".to_string(), "/".to_string()))
        );
        // Non-WSL paths pass through
        assert_eq!(split_wsl_unc(r"C:\Users\foo"), None);
        assert_eq!(split_wsl_unc(r"\\server\share\foo"), None);
    }

    #[test]
    fn test_wsl_relative_path_from_unc_cwd() {
        // Relative path resolved against a WSL UNC cwd should also become
        // native WSL — this is the common case (`pike file.md` from inside
        // a WSL terminal where cwd is reported as the UNC view).
        // Use a guaranteed-nonexistent path so canonicalize can't rewrite it.
        let args = vec![
            "pike.exe".to_string(),
            "pike-test-nonexistent.md".to_string(),
        ];
        let f = expect_single_file(parse_args(
            &args,
            r"\\wsl.localhost\Ubuntu\home\pike-test-user\does-not-exist",
        ));
        assert_eq!(
            f.path,
            "/home/pike-test-user/does-not-exist/pike-test-nonexistent.md"
        );
        assert_eq!(f.distro.as_deref(), Some("Ubuntu"));
    }

    #[test]
    fn test_from_window_flag_stripped_and_extracted() {
        let args = vec![
            "pike.exe".to_string(),
            "--from-window=project-abc".to_string(),
            "file.rs".to_string(),
        ];
        let f = expect_single_file(parse_args(&args, "C:\\project"));
        assert!(f.path.contains("file.rs"), "got: {}", f.path);
        assert_eq!(extract_from_window(&args), Some("project-abc".to_string()));

        // Empty value yields None
        let empty = vec!["pike.exe".to_string(), "--from-window=".to_string()];
        assert_eq!(extract_from_window(&empty), None);

        // Missing flag yields None
        let none = vec!["pike.exe".to_string(), "file.rs".to_string()];
        assert_eq!(extract_from_window(&none), None);
    }

    #[test]
    fn test_wait_flag_stripped() {
        // --wait should be stripped; file.rs should still be parsed
        let args = vec!["pike.exe".to_string(), "--wait".to_string(), "file.rs".to_string()];
        let f = expect_single_file(parse_args(&args, "C:\\project"));
        assert!(f.path.contains("file.rs"), "expected file.rs in path, got: {}", f.path);

        // --wait-id=xxx should also be stripped
        let args2 = vec![
            "pike.exe".to_string(),
            "--wait-id=abc123".to_string(),
            "file.rs".to_string(),
        ];
        let f2 = expect_single_file(parse_args(&args2, "C:\\project"));
        assert!(f2.path.contains("file.rs"), "expected file.rs in path, got: {}", f2.path);
    }
}
