use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Create a Command with CREATE_NO_WINDOW on Windows to prevent console window flashing.
pub fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// User-local binary paths to prepend to PATH when invoking WSL commands that
/// may need to find user-installed binaries (signing programs, hooks,
/// credential helpers). `bash -l` would pick these up via `.profile`, but we
/// use `bash -c` (non-login) to avoid tty-related hangs.
pub const WSL_EXTRA_PATH: &str = "$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin:$HOME/.local/share/fnm/aliases/default/bin:$HOME/.cargo/bin:$HOME/go/bin:/usr/local/bin";

/// Quote a string for safe interpolation into a `bash -c` command.
/// Bash-specific (single-quote wrapping); NOT safe for cmd.exe or PowerShell.
pub fn bash_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars().all(|c| c.is_alphanumeric() || "-_./=@:+".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ShellConfig {
    Wsl { distro: String },
    Cmd,
    Powershell,
    GitBash,
}

impl ShellConfig {
    /// Build a Command with WSL dispatch.
    /// WSL: `wsl.exe -d distro -e program args...` (bypasses bash, safe for special chars)
    /// Others: `program args...`
    pub fn command(&self, program: &str, args: &[&str]) -> Command {
        match self {
            ShellConfig::Wsl { distro } => {
                let mut cmd = silent_command("wsl.exe");
                cmd.arg("-d").arg(distro).arg("-e").arg(program);
                for a in args {
                    cmd.arg(a);
                }
                cmd
            }
            _ => {
                let mut cmd = silent_command(program);
                for a in args {
                    cmd.arg(a);
                }
                cmd
            }
        }
    }

    /// Execute with a 30 s timeout and return (exit_code, stdout, stderr).
    pub fn run(&self, program: &str, args: &[&str]) -> Result<(i32, String, String), String> {
        let output = self.run_with_timeout(program, args, Duration::from_secs(30))?;
        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }

    /// Execute with a 30 s timeout and return stdout on success, Err on failure.
    pub fn run_stdout(&self, program: &str, args: &[&str]) -> Result<String, String> {
        spawn_stdout(self.command(program, args), program)
    }

    /// WSL: route through `bash -c` with `WSL_EXTRA_PATH` prepended so user-installed
    /// binaries (signing programs, git hooks) resolve. Non-WSL shells run normally —
    /// their Pike-inherited PATH already covers most cases.
    pub fn run_stdout_with_user_path(&self, program: &str, args: &[&str]) -> Result<String, String> {
        let cmd = match self {
            ShellConfig::Wsl { distro } => {
                let mut parts = Vec::with_capacity(1 + args.len());
                parts.push(bash_quote(program));
                for a in args {
                    parts.push(bash_quote(a));
                }
                let script = format!("PATH=\"{WSL_EXTRA_PATH}:$PATH\" {}", parts.join(" "));
                let mut cmd = silent_command("wsl.exe");
                cmd.arg("-d").arg(distro).arg("-e").arg("bash").arg("-c").arg(script);
                cmd
            }
            _ => self.command(program, args),
        };
        spawn_stdout(cmd, program)
    }

    /// Execute with a 30 s timeout and return raw Output (for binary data).
    pub fn run_raw(&self, program: &str, args: &[&str]) -> Result<std::process::Output, String> {
        self.run_with_timeout(program, args, Duration::from_secs(30))
    }

    /// Run a shell command line inside `dir`, returning (exit_code, stdout, stderr)
    /// regardless of exit status (build/lint tools exit non-zero when they find
    /// problems). PATH is augmented so user toolchains (cargo, go, npx) resolve.
    ///
    /// WSL routes through `bash -c` (with `WSL_EXTRA_PATH` prepended). Every
    /// Windows shell routes through `cmd /C` — diagnostic tools live on the
    /// Windows PATH regardless of the project's interactive shell, and cmd honors
    /// PATHEXT so `npx`/`tsc` shims (.cmd) resolve.
    pub fn run_shell_line(
        &self,
        dir: &str,
        line: &str,
        timeout: Duration,
    ) -> Result<(i32, String, String), String> {
        let cmd = match self {
            ShellConfig::Wsl { distro } => {
                let script = format!(
                    "cd {} && PATH=\"{WSL_EXTRA_PATH}:$PATH\" {line}",
                    bash_quote(dir)
                );
                let mut c = silent_command("wsl.exe");
                c.arg("-d").arg(distro).arg("-e").arg("bash").arg("-c").arg(script);
                c
            }
            _ => {
                // `current_dir` + `raw_arg` avoids the cmd.exe/Rust quoting clash
                // that `cmd /C "cd /d ..."` triggers; cmd starts in `dir`, so
                // relative tools (node_modules/.bin, npx) resolve correctly.
                let mut c = silent_command("cmd.exe");
                c.current_dir(dir);
                c.arg("/C");
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    c.raw_arg(line);
                }
                #[cfg(not(windows))]
                {
                    c.arg(line);
                }
                c
            }
        };
        let output = spawn_with_timeout(cmd, "shell", timeout)?;
        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }

    /// Path to the null device for this shell environment.
    pub fn null_device(&self) -> &'static str {
        match self {
            ShellConfig::Wsl { .. } => "/dev/null",
            _ => "NUL",
        }
    }

    fn run_with_timeout(
        &self,
        program: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<std::process::Output, String> {
        spawn_with_timeout(self.command(program, args), program, timeout)
    }
}

/// Pipe stdout/stderr, spawn `cmd`, and wait up to `timeout`, returning the raw
/// Output regardless of exit status (the process tree is killed on timeout).
fn spawn_with_timeout(
    mut cmd: Command,
    label: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {label}: {e}"))?;
    let pid = child.id();
    wait_with_timeout(pid, timeout, label, move || child.wait_with_output())
}

/// Spawn a prepared Command, wait up to 30 s, and return stdout on success.
fn spawn_stdout(cmd: Command, label: &str) -> Result<String, String> {
    let output = spawn_with_timeout(cmd, label, Duration::from_secs(30))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{label} error: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Run a closure in a background thread with a timeout.
/// If the timeout expires, the process tree rooted at `pid` is killed via `taskkill`.
/// Used by both `ShellConfig::run_with_timeout` and `fs::write_bytes`.
pub fn wait_with_timeout<T: Send + 'static>(
    pid: u32,
    timeout: Duration,
    label: &str,
    f: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(timeout) {
        Ok(result) => result.map_err(|e| format!("Failed to run {label}: {e}")),
        Err(_) => {
            // Fire-and-forget so a slow taskkill doesn't block the caller
            let pid_str = pid.to_string();
            std::thread::spawn(move || {
                let _ = silent_command("taskkill")
                    .args(["/F", "/T", "/PID", &pid_str])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            });
            Err(format!("{label} timed out after {}s", timeout.as_secs()))
        }
    }
}

/// Canonicalize a Windows-style path for case-insensitive comparison: forward
/// slashes → backslashes, trailing separators stripped, lowercased.
fn normalize_win_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Match a session/agent cwd against a project root. Windows paths compare
/// case-insensitively; WSL paths are case-sensitive (trailing `/` ignored).
/// Shared by `claude_usage` and `codex_usage` (the single comparison that
/// decides whether a tool session belongs to the current project).
pub fn cwd_matches_root(shell: &ShellConfig, cwd: &str, root: &str) -> bool {
    match shell {
        ShellConfig::Wsl { .. } => cwd.trim_end_matches('/') == root.trim_end_matches('/'),
        _ => normalize_win_path(cwd) == normalize_win_path(root),
    }
}

/// Resolve (and cache per `(distro, subdir)`) a WSL home subdirectory — e.g.
/// `.claude`, `.codex` — as a Windows UNC path. Spawns `wsl.exe` for `$HOME` and
/// probes the modern `\\wsl.localhost\…` share (falling back to legacy `\\wsl$\…`)
/// once; later calls reuse the cached path. Not cached on failure, so it keeps
/// retrying until the tool has actually written into the distro.
pub fn wsl_home_subdir_cached(shell: &ShellConfig, distro: &str, subdir: &str) -> Option<PathBuf> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), PathBuf>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (distro.to_string(), subdir.to_string());
    if let Some(dir) = cache.lock().ok()?.get(&key) {
        return Some(dir.clone());
    }
    // `echo $HOME` → e.g. "/home/kan"; take the last line in case of any banner.
    let raw = shell.run_stdout("bash", &["-c", "echo $HOME"]).ok()?;
    let home = raw.lines().last().unwrap_or_default().trim().trim_end_matches('/');
    if home.is_empty() {
        return None;
    }
    let tail = format!("{}\\{}", home.replace('/', "\\"), subdir);
    let dir = ["wsl.localhost", "wsl$"]
        .into_iter()
        .map(|host| PathBuf::from(format!("\\\\{host}\\{distro}{tail}")))
        .find(|p| p.is_dir())?;
    cache.lock().ok()?.insert(key, dir.clone());
    Some(dir)
}

pub fn validate_slug(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 64 {
        return Err(format!("{label} must be 1-64 characters"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("{label} must contain only [a-zA-Z0-9_-]"));
    }
    Ok(())
}
