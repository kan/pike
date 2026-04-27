use crate::types::ShellConfig;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: String,
    pub is_dirty: bool,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    pub ahead: u32,
    pub behind: u32,
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
    pub parents: Vec<String>,
    pub refs: String,
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

fn run_git(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<String, String> {
    let mut full_args = vec!["-C", root];
    full_args.extend(args);
    shell.run_stdout("git", &full_args)
}

/// Like `run_git` but returns stdout regardless of exit code. Used for
/// commands like `git diff --no-index` that exit with code 1 when files differ.
fn run_git_raw_stdout(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<String, String> {
    let mut full_args = vec!["-C", root];
    full_args.extend(args);
    let output = shell.run_raw("git", &full_args)?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_status(output: &str) -> GitStatusResult {
    let mut branch = String::from("HEAD");
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;

    for line in output.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = head.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: "# branch.ab +N -M"
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
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
        } else if let Some(path) = line.strip_prefix("? ") {
            // Untracked: "? path"
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
        ahead,
        behind,
    }
}

/// Field separator (ASCII Unit Separator) and record separator (ASCII Record Separator).
/// Using these instead of NUL avoids collision when %D (refs) is empty — an empty
/// field between two NUL bytes would be indistinguishable from a double-NUL record separator.
const FS: char = '\x1f';
const RS: &str = "\x1e";

fn parse_log(output: &str) -> Vec<GitLogEntry> {
    output
        .split(RS)
        .filter_map(|record| {
            let record = record.trim_matches('\n');
            if record.is_empty() { return None; }
            let parts: Vec<&str> = record.splitn(6, FS).collect();
            if parts.len() == 6 {
                let parents = parts[1]
                    .split_whitespace()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                Some(GitLogEntry {
                    hash: parts[0].to_string(),
                    parents,
                    refs: parts[2].trim().to_string(),
                    author: parts[3].to_string(),
                    date: parts[4].to_string(),
                    message: parts[5].trim().to_string(),
                })
            } else if parts.len() == 4 {
                // Backward compat: git_log_file uses 4-field format
                Some(GitLogEntry {
                    hash: parts[0].to_string(),
                    parents: vec![],
                    refs: String::new(),
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
        run_git(&shell, &root, &["status", "--porcelain=v2", "--branch", "--untracked-files=all"])
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
    all: Option<bool>,
) -> Result<Vec<GitLogEntry>, String> {
    let n = count.unwrap_or(50).to_string();
    let output = tokio::task::spawn_blocking(move || {
        let mut args = vec!["log", "--format=%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%B%x1e", "-n", &n];
        if all.unwrap_or(false) {
            args.push("--all");
        }
        run_git(&shell, &root, &args)
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
    untracked: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Untracked files have no diff against HEAD; synthesize a "new file"
        // diff via --no-index against the null device.
        if untracked {
            let args = ["diff", "--no-index", "--", shell.null_device(), &path];
            let output = run_git_raw_stdout(&shell, &root, &args)?;
            return Ok(truncate_diff(output));
        }
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

/// Get the full working tree diff (all unstaged changes).
#[tauri::command]
pub async fn git_diff_working(root: String, shell: ShellConfig) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&shell, &root, &["diff"])?;
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
pub async fn git_discard_changes(
    root: String,
    shell: ShellConfig,
    paths: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["checkout", "HEAD", "--"];
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
        // Route through user-PATH variant so commit hooks, gpg.ssh.program,
        // and other user-installed binaries resolve (Pike's default WSL spawn
        // bypasses bash and misses ~/.local/bin, ~/bin, etc.).
        shell.run_stdout_with_user_path("git", &["-C", &root, "commit", "-m", &message])?;
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
pub async fn git_fetch(root: String, shell: ShellConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["fetch", "--prune"])?;
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
            let path = path.split('\t').next_back().unwrap_or(&path).to_string();
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

#[tauri::command]
pub async fn git_show_file(
    root: String,
    shell: ShellConfig,
    hash: String,
    path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["show", &format!("{hash}:{path}")])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_log_file(
    root: String,
    shell: ShellConfig,
    path: String,
    count: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let n = count.unwrap_or(20).to_string();
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &["log", "--format=%H%x1f%an%x1f%aI%x1f%s%x1e", "-n", &n, "--", &path],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_log(&output))
}

/// Get commits that modified a specific line range of a file using `git log -L`.
/// Note: `git log -L` ignores `-n`, so we truncate the parsed result instead.
#[tauri::command]
pub async fn git_log_file_lines(
    root: String,
    shell: ShellConfig,
    path: String,
    start_line: u32,
    end_line: u32,
    count: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    if start_line == 0 || end_line < start_line {
        return Err("invalid line range".to_string());
    }
    let range = format!("{},{}:{}", start_line, end_line, path);
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &[
                "log",
                "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
                "-s",
                "-L",
                &range,
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut entries = parse_log(&output);
    if let Some(n) = count {
        entries.truncate(n as usize);
    }
    Ok(entries)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLines {
    pub added: Vec<[u32; 2]>,
    pub modified: Vec<[u32; 2]>,
    pub deleted: Vec<u32>,
}

fn parse_diff_lines(diff_output: &str) -> GitDiffLines {
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();

    let mut new_line: u32 = 0;
    let mut pending_del = false;
    let mut add_start: Option<u32> = None;
    let mut mod_start: Option<u32> = None;

    fn flush_range(start: &mut Option<u32>, end: u32, out: &mut Vec<[u32; 2]>) {
        if let Some(s) = start.take() {
            out.push([s, end]);
        }
    }

    for line in diff_output.lines() {
        if line.starts_with("@@") {
            flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
            flush_range(&mut mod_start, new_line.saturating_sub(1), &mut modified);
            if pending_del {
                deleted.push(new_line);
                pending_del = false;
            }
            // Parse @@ -old,count +new,count @@
            if let Some(plus) = line.find('+') {
                let rest = &line[plus + 1..];
                let num_end = rest.find([',', ' ']).unwrap_or(rest.len());
                if let Ok(n) = rest[..num_end].parse::<u32>() {
                    new_line = n;
                }
            }
            continue;
        }
        if line.starts_with("diff ") || line.starts_with("index ") || line.starts_with("---") || line.starts_with("+++") {
            continue;
        }
        if line.starts_with('-') {
            flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
            if !pending_del {
                pending_del = true;
            }
        } else if line.starts_with('+') {
            if pending_del {
                pending_del = false;
                if mod_start.is_none() {
                    mod_start = Some(new_line);
                }
            } else if mod_start.is_none()
                && add_start.is_none() {
                    add_start = Some(new_line);
                }
            new_line += 1;
        } else {
            flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
            flush_range(&mut mod_start, new_line.saturating_sub(1), &mut modified);
            if pending_del {
                deleted.push(new_line);
                pending_del = false;
            }
            new_line += 1;
        }
    }
    flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
    flush_range(&mut mod_start, new_line.saturating_sub(1), &mut modified);
    if pending_del {
        deleted.push(new_line);
    }

    GitDiffLines { added, modified, deleted }
}

#[tauri::command]
pub async fn git_diff_lines(
    root: String,
    shell: ShellConfig,
    path: String,
) -> Result<GitDiffLines, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&shell, &root, &["diff", "HEAD", "--", &path]);
        match output {
            Ok(diff) => Ok(parse_diff_lines(&diff)),
            Err(_) => Ok(GitDiffLines { added: vec![], modified: vec![], deleted: vec![] }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
