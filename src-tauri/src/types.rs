use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::time::Duration;

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
    /// WSL: `wsl.exe -d distro -- program args...`
    /// Others: `program args...`
    pub fn command(&self, program: &str, args: &[&str]) -> Command {
        match self {
            ShellConfig::Wsl { distro } => {
                let mut cmd = Command::new("wsl.exe");
                cmd.arg("-d").arg(distro).arg("--").arg(program);
                for a in args {
                    cmd.arg(a);
                }
                cmd
            }
            _ => {
                let mut cmd = Command::new(program);
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
        let output = self.run_with_timeout(program, args, Duration::from_secs(30))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("{program} error: {stderr}"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn run_with_timeout(
        &self,
        program: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<std::process::Output, String> {
        let child = self
            .command(program, args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run {program}: {e}"))?;

        let pid = child.id();
        let (tx, rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });

        match rx.recv_timeout(timeout) {
            Ok(result) => result.map_err(|e| format!("Failed to run {program}: {e}")),
            Err(_) => {
                // Timeout — kill the process tree to prevent wsl.exe accumulation
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                Err(format!("{program} timed out after {}s", timeout.as_secs()))
            }
        }
    }
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
