use std::process::Stdio;

use serde_json::json;
use tokio::process::{Child, Command};

use crate::types::ShellConfig;

// ---------------------------------------------------------------------------
// Windows process creation helpers
// ---------------------------------------------------------------------------

/// Set process creation flags on Windows for the Codex app-server.
///
/// With `externalSandbox`, Codex does NOT create its own Job Objects for command
/// execution, so `CREATE_NO_WINDOW` is safe — the crash only happened when Codex's
/// built-in sandbox tried to run `codex-command-runner.exe`.
#[cfg(windows)]
fn set_codex_creation_flags(cmd: &mut Command) {
    // CREATE_NO_WINDOW (0x08000000): no console window for node.exe
    // CREATE_NEW_PROCESS_GROUP (0x00000200): isolate from Pike's console group
    cmd.creation_flags(0x08000000 | 0x00000200);
}

#[cfg(not(windows))]
fn set_codex_creation_flags(_cmd: &mut Command) {}

/// Resolve how to launch `codex` on Windows.
///
/// npm global packages install as `.cmd` wrapper scripts. We parse the wrapper
/// to extract the underlying `node.exe` + script path and launch node directly.
#[cfg(windows)]
fn resolve_codex_windows() -> (String, Vec<String>) {
    use std::sync::OnceLock;
    static CACHED: OnceLock<(String, Vec<String>)> = OnceLock::new();
    CACHED.get_or_init(resolve_codex_windows_inner).clone()
}

#[cfg(windows)]
fn resolve_codex_windows_inner() -> (String, Vec<String>) {
    if let Ok(output) = crate::types::silent_command("where.exe")
        .arg("codex")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut cmd_path: Option<String> = None;

        for line in stdout.lines() {
            let path = line.trim();
            if path.is_empty() {
                continue;
            }
            let lower = path.to_lowercase();
            if lower.ends_with(".exe") {
                return (path.to_string(), vec![]);
            }
            if (lower.ends_with(".cmd") || lower.ends_with(".bat")) && cmd_path.is_none() {
                cmd_path = Some(path.to_string());
            }
        }

        if let Some(ref cmd) = cmd_path {
            if let Some((node, script)) = parse_npm_cmd_wrapper(cmd) {
                return (node, vec![script]);
            }
            return ("cmd.exe".to_string(), vec!["/C".to_string(), cmd.clone()]);
        }
    }
    ("codex.exe".to_string(), vec![])
}

#[cfg(windows)]
fn parse_npm_cmd_wrapper(cmd_path: &str) -> Option<(String, String)> {
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let dir = std::path::Path::new(cmd_path).parent()?;

    for line in content.lines() {
        let line = line.trim();
        if let Some(js_start) = line.find("%dp0%\\") {
            let rest = &line[js_start + 6..];
            let js_rel = rest
                .trim_end_matches("%*")
                .trim_end_matches('"')
                .trim();
            if js_rel.ends_with(".js") {
                let script = dir.join(js_rel);
                if script.exists() {
                    let node = resolve_node_binary(dir);
                    return Some((node, script.to_string_lossy().into_owned()));
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn resolve_node_binary(cmd_dir: &std::path::Path) -> String {
    let local_node = cmd_dir.join("node.exe");
    if local_node.exists() {
        return local_node.to_string_lossy().into_owned();
    }
    "node.exe".to_string()
}

// ---------------------------------------------------------------------------
// Windows Job Object management
// ---------------------------------------------------------------------------

/// Wraps a child process in a Windows Job Object so that when Pike exits,
/// the codex process and all its descendants are automatically killed.
///
/// The returned HANDLE must be stored and kept alive — closing it triggers
/// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE which terminates all processes in the job.
/// We store it in a static to keep it alive for the lifetime of the process.
#[cfg(windows)]
fn assign_to_job_object(child: &Child) -> Result<(), String> {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::*;

    // Keep the Job handle alive for the lifetime of the process.
    // OnceLock ensures we create only one Job Object and reuse it.
    static JOB: OnceLock<isize> = OnceLock::new();

    unsafe {
        let job_raw = JOB.get_or_init(|| {
            let job = match CreateJobObjectW(None, None) {
                Ok(h) => h,
                Err(e) => {
                    log::error!("[codex] CreateJobObject failed: {e}");
                    return 0;
                }
            };

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;

            if let Err(e) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                log::error!("[codex] SetInformationJobObject failed: {e}");
                return 0;
            }

            job.0 as isize
        });

        if *job_raw == 0 {
            return Err("Job Object not available".to_string());
        }

        let job = HANDLE(*job_raw as *mut std::ffi::c_void);
        let raw = child.raw_handle().ok_or("Failed to get child raw handle")?;
        AssignProcessToJobObject(job, HANDLE(raw))
            .map_err(|e| format!("AssignProcessToJobObject failed: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// CodexRuntime trait
// ---------------------------------------------------------------------------

/// Abstraction over the environment where Codex runs (Windows native vs WSL).
#[allow(dead_code)]
pub trait CodexRuntime: Send + Sync {
    /// Spawn `codex app-server` as a child process with piped stdin/stdout/stderr.
    fn spawn_app_server(&self, working_dir: &str) -> Result<Child, String>;

    /// Convert a path returned by Codex to a host path Pike can use.
    fn translate_path_from_codex(&self, codex_path: &str) -> String;

    /// Convert a host path to a path Codex understands.
    fn translate_path_to_codex(&self, host_path: &str) -> String;

    /// Human-readable environment name (e.g. "Windows" or "Ubuntu-22.04 (WSL)").
    fn display_environment_name(&self) -> String;

    /// Get the Codex CLI version string.
    fn codex_version(&self) -> Result<String, String>;

    /// Runtime-specific default sandbox policy for thread/start.
    fn default_sandbox_policy(&self) -> serde_json::Value;

    /// Whether Codex's built-in sandbox is trustworthy on this runtime.
    /// Returns false on Windows (sandbox is experimental and unstable).
    fn codex_sandbox_trusted(&self) -> bool;
}

// ---------------------------------------------------------------------------
// Windows Native Runtime
// ---------------------------------------------------------------------------

pub struct WindowsNativeRuntime;

impl CodexRuntime for WindowsNativeRuntime {
    fn spawn_app_server(&self, working_dir: &str) -> Result<Child, String> {
        #[cfg(windows)]
        let (program, prefix_args) = resolve_codex_windows();
        #[cfg(not(windows))]
        let (program, prefix_args) = ("codex".to_string(), vec![]);

        let mut cmd = Command::new(&program);
        for arg in &prefix_args {
            cmd.arg(arg);
        }
        cmd.arg("app-server");
        cmd.current_dir(working_dir);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        set_codex_creation_flags(&mut cmd);

        let child = cmd.spawn().map_err(|e| format!("Failed to spawn codex app-server: {e}"))?;

        // Wrap in Job Object for cleanup on Pike exit
        #[cfg(windows)]
        if let Err(e) = assign_to_job_object(&child) {
            log::warn!("[codex] Failed to assign to Job Object (non-fatal): {e}");
        }

        Ok(child)
    }

    fn translate_path_from_codex(&self, codex_path: &str) -> String {
        codex_path.to_string()
    }

    fn translate_path_to_codex(&self, host_path: &str) -> String {
        host_path.to_string()
    }

    fn display_environment_name(&self) -> String {
        "Windows".to_string()
    }

    fn codex_version(&self) -> Result<String, String> {
        #[cfg(windows)]
        let (program, prefix_args) = resolve_codex_windows();
        #[cfg(not(windows))]
        let (program, prefix_args) = ("codex".to_string(), vec![]);

        let mut cmd = crate::types::silent_command(&program);
        for arg in &prefix_args {
            cmd.arg(arg);
        }
        cmd.arg("--version");
        let output = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Failed to run codex --version: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("codex --version failed: {stderr}"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn default_sandbox_policy(&self) -> serde_json::Value {
        // Codex's Windows sandbox is experimental and causes Pike to crash
        // (Job Object KILL_ON_JOB_CLOSE cascades to parent process).
        // Use externalSandbox to disable Codex's built-in sandbox.
        // Safety is handled by Pike's approval mechanism.
        json!({ "type": "externalSandbox" })
    }

    fn codex_sandbox_trusted(&self) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------
// WSL Runtime
// ---------------------------------------------------------------------------

pub struct WslRuntime {
    pub distro: String,
}

impl CodexRuntime for WslRuntime {
    fn spawn_app_server(&self, working_dir: &str) -> Result<Child, String> {
        let linux_dir = self.translate_path_to_codex(working_dir);

        let mut cmd = Command::new("wsl.exe");
        cmd.args(["--cd", &linux_dir, "-d", &self.distro, "--", "codex", "app-server"]);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        set_codex_creation_flags(&mut cmd);
        cmd.spawn().map_err(|e| format!("Failed to spawn codex app-server via WSL ({}): {e}", self.distro))
    }

    fn translate_path_from_codex(&self, codex_path: &str) -> String {
        if let Some(rest) = codex_path.strip_prefix('/') {
            format!(
                "\\\\wsl.localhost\\{}\\{}",
                self.distro,
                rest.replace('/', "\\")
            )
        } else {
            codex_path.to_string()
        }
    }

    fn translate_path_to_codex(&self, host_path: &str) -> String {
        let norm = host_path.replace('\\', "/");
        let prefix_localhost = format!("//wsl.localhost/{}/", self.distro);
        let prefix_dollar = format!("//wsl$/{}/", self.distro);

        if let Some(rest) = norm.strip_prefix(&prefix_localhost) {
            format!("/{rest}")
        } else if let Some(rest) = norm.strip_prefix(&prefix_dollar) {
            format!("/{rest}")
        } else {
            // Already a Linux path or unrecognized — return as-is
            host_path.to_string()
        }
    }

    fn display_environment_name(&self) -> String {
        format!("{} (WSL)", self.distro)
    }

    fn codex_version(&self) -> Result<String, String> {
        let shell = ShellConfig::Wsl { distro: self.distro.clone() };
        let output = shell.run_stdout("codex", &["--version"])?;
        Ok(output.trim().to_string())
    }

    fn default_sandbox_policy(&self) -> serde_json::Value {
        // WSL uses Linux sandbox (Landlock/Bubblewrap) which is stable.
        json!({ "type": "workspaceWrite" })
    }

    fn codex_sandbox_trusted(&self) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

pub fn runtime_for_shell(shell: &ShellConfig) -> Box<dyn CodexRuntime> {
    match shell {
        ShellConfig::Wsl { distro } => Box::new(WslRuntime { distro: distro.clone() }),
        _ => Box::new(WindowsNativeRuntime),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_runtime_path_translation_roundtrip() {
        let rt = WslRuntime { distro: "Ubuntu-22.04".to_string() };
        let linux_path = "/home/kan/projects/pike/src/main.rs";
        let host_path = rt.translate_path_from_codex(linux_path);
        assert_eq!(host_path, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\kan\\projects\\pike\\src\\main.rs");
        assert_eq!(rt.translate_path_to_codex(&host_path), linux_path);
    }

    #[test]
    fn wsl_runtime_translate_wsl_dollar_path() {
        let rt = WslRuntime { distro: "Ubuntu".to_string() };
        assert_eq!(rt.translate_path_to_codex("\\\\wsl$\\Ubuntu\\home\\user\\file.txt"), "/home/user/file.txt");
    }

    #[test]
    fn wsl_runtime_translate_already_linux_path() {
        let rt = WslRuntime { distro: "Ubuntu".to_string() };
        assert_eq!(rt.translate_path_to_codex("/home/user"), "/home/user");
    }

    #[test]
    fn windows_runtime_identity_paths() {
        let rt = WindowsNativeRuntime;
        assert_eq!(rt.translate_path_from_codex("C:\\Users\\test"), "C:\\Users\\test");
        assert_eq!(rt.translate_path_to_codex("C:\\Users\\test"), "C:\\Users\\test");
    }

    #[test]
    fn windows_sandbox_policy_is_external() {
        let rt = WindowsNativeRuntime;
        assert_eq!(rt.default_sandbox_policy(), json!({ "type": "externalSandbox" }));
        assert!(!rt.codex_sandbox_trusted());
    }

    #[test]
    fn wsl_sandbox_policy_is_workspace_write() {
        let rt = WslRuntime { distro: "Ubuntu".to_string() };
        assert_eq!(rt.default_sandbox_policy(), json!({ "type": "workspaceWrite" }));
        assert!(rt.codex_sandbox_trusted());
    }
}
