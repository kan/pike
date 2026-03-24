use crate::types::ShellConfig;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: String,
    pub is_dirty: bool,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

fn truncate_diff(output: String) -> String {
    const MAX: usize = 100_000;
    if output.len() > MAX {
        let mut end = MAX;
        while end > 0 && !output.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...\n\n[Diff truncated at 100KB]", &output[..end])
    } else {
        output
    }
}

fn build_git_command(shell: &ShellConfig, root: &str, args: &[&str]) -> Command {
    match shell {
        ShellConfig::Wsl { distro } => {
            let mut cmd = Command::new("wsl.exe");
            cmd.arg("-d").arg(distro);
            cmd.arg("git").arg("-C").arg(root);
            for a in args {
                cmd.arg(a);
            }
            cmd
        }
        _ => {
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(root);
            for a in args {
                cmd.arg(a);
            }
            cmd
        }
    }
}

fn run_git(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<String, String> {
    let output = build_git_command(shell, root, args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_status(output: &str) -> GitStatusResult {
    let mut branch = String::from("HEAD");
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for line in output.lines() {
        if line.starts_with("# branch.head ") {
            branch = line["# branch.head ".len()..].to_string();
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // Changed entry: "1 XY sub mH mI mW hH hI path" or "2 XY ... path\torig"
            let parts: Vec<&str> = line.splitn(9, ' ').collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                let x = &xy[..1];
                let y = &xy[1..2];
                let path = if line.starts_with("2 ") {
                    // Rename: path contains \t, take the part after
                    parts[8].split('\t').next().unwrap_or(parts[8])
                } else {
                    parts[8]
                };
                if x != "." {
                    staged.push(GitFileChange {
                        path: path.to_string(),
                        status: x.to_string(),
                    });
                }
                if y != "." {
                    unstaged.push(GitFileChange {
                        path: path.to_string(),
                        status: y.to_string(),
                    });
                }
            }
        } else if line.starts_with("? ") {
            // Untracked: "? path"
            let path = &line[2..];
            unstaged.push(GitFileChange {
                path: path.to_string(),
                status: "?".to_string(),
            });
        }
    }

    let is_dirty = !staged.is_empty() || !unstaged.is_empty();
    GitStatusResult {
        branch,
        is_dirty,
        staged,
        unstaged,
    }
}

fn parse_log(output: &str) -> Vec<GitLogEntry> {
    // Records separated by NUL NUL, fields by NUL
    output
        .split("\0\0")
        .filter_map(|record| {
            let record = record.trim_matches('\n');
            let parts: Vec<&str> = record.splitn(4, '\0').collect();
            if parts.len() == 4 {
                Some(GitLogEntry {
                    hash: parts[0].to_string(),
                    author: parts[1].to_string(),
                    date: parts[2].to_string(),
                    message: parts[3].trim().to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub async fn git_status(
    root: String,
    shell: ShellConfig,
) -> Result<GitStatusResult, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["status", "--porcelain=v2", "--branch"])
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_status(&output))
}

#[tauri::command]
pub async fn git_log(
    root: String,
    shell: ShellConfig,
    count: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let n = count.unwrap_or(50).to_string();
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &["log", "--format=%H%x00%an%x00%aI%x00%B%x00%x00", "-n", &n],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_log(&output))
}

#[tauri::command]
pub async fn git_diff(
    root: String,
    shell: ShellConfig,
    path: String,
    staged: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(&path);
        let output = run_git(&shell, &root, &args)?;
        Ok(truncate_diff(output))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(
    root: String,
    shell: ShellConfig,
    paths: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["add", "--"];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(path_refs);
        run_git(&shell, &root, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage(
    root: String,
    shell: ShellConfig,
    paths: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["reset", "HEAD", "--"];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(path_refs);
        run_git(&shell, &root, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(
    root: String,
    shell: ShellConfig,
    message: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["commit", "-m", &message])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_branch_list(
    root: String,
    shell: ShellConfig,
) -> Result<Vec<String>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["branch"])
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(output
        .lines()
        .map(|l| l.trim_start_matches('*').trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

#[tauri::command]
pub async fn git_checkout(
    root: String,
    shell: ShellConfig,
    branch: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["checkout", &branch])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(
    root: String,
    shell: ShellConfig,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git(&shell, &root, &["push"]))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(
    root: String,
    shell: ShellConfig,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git(&shell, &root, &["pull"]))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_show_files(
    root: String,
    shell: ShellConfig,
    hash: String,
) -> Result<Vec<GitFileChange>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["show", "--pretty=", "--name-status", &hash])
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(2, '\t');
            let status = parts.next()?.chars().next()?.to_string();
            let path = parts.next()?.to_string();
            // For renames (R100\told\tnew), take the new path
            let path = path.split('\t').last().unwrap_or(&path).to_string();
            Some(GitFileChange { path, status })
        })
        .collect())
}

#[tauri::command]
pub async fn git_diff_commit(
    root: String,
    shell: ShellConfig,
    hash: String,
    path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Try parent diff first, fall back to --root for initial commit
        let result = run_git(
            &shell,
            &root,
            &["diff", &format!("{hash}~1"), &hash, "--", &path],
        );
        let output = match result {
            Ok(o) => o,
            Err(_) => run_git(&shell, &root, &["diff", "--root", &hash, "--", &path])?,
        };
        Ok(truncate_diff(output))
    })
    .await
    .map_err(|e| e.to_string())?
}
