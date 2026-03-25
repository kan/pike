use serde::{Deserialize, Serialize};
use std::process::Command;

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

    /// Execute and return (exit_code, stdout, stderr).
    pub fn run(&self, program: &str, args: &[&str]) -> Result<(i32, String, String), String> {
        let output = self
            .command(program, args)
            .output()
            .map_err(|e| format!("Failed to run {program}: {e}"))?;
        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }

    /// Execute and return stdout on success, Err on failure.
    pub fn run_stdout(&self, program: &str, args: &[&str]) -> Result<String, String> {
        let output = self
            .command(program, args)
            .output()
            .map_err(|e| format!("Failed to run {program}: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("{program} error: {stderr}"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
