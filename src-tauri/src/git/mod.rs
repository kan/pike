use crate::types::{ShellConfig, bash_quote};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: String,
    /// Current HEAD commit oid (from `# branch.oid`), or "(initial)" before the
    /// first commit. Used by the frontend to detect when the commit log changed.
    pub head: String,
    pub is_dirty: bool,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    /// Unmerged paths (merge/rebase conflicts), from porcelain v2 `u ` lines.
    /// `status` holds the two-letter XY code (e.g. "UU", "AA", "DD").
    pub conflicted: Vec<GitFileChange>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    /// Absolute path of the worktree (native form for the project's shell).
    pub path: String,
    /// Short branch name (refs/heads/ stripped), or None when detached/bare.
    pub branch: Option<String>,
    /// Commit the worktree's HEAD points at.
    pub head: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    /// The first entry reported by git is the repository's main working tree.
    pub is_main: bool,
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
    let mut head = String::from("(initial)");
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut conflicted = Vec::new();
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;

    for line in output.lines() {
        if let Some(oid) = line.strip_prefix("# branch.oid ") {
            head = oid.to_string();
        } else if let Some(head) = line.strip_prefix("# branch.head ") {
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
        } else if line.starts_with("u ") {
            // Unmerged entry: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
            // (no rename, so the path is the final field and contains no \t).
            let parts: Vec<&str> = line.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                conflicted.push(GitFileChange {
                    path: parts[10].to_string(),
                    status: parts[1].to_string(),
                });
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            // Untracked: "? path"
            unstaged.push(GitFileChange {
                path: path.to_string(),
                status: "?".to_string(),
            });
        }
    }

    let is_dirty = !staged.is_empty() || !unstaged.is_empty() || !conflicted.is_empty();
    GitStatusResult {
        branch,
        head,
        is_dirty,
        staged,
        unstaged,
        conflicted,
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

/// Whether `root` is inside a git working tree. Returns `Ok(false)` (never an
/// error) when the directory is not a repository, so the frontend can show a
/// dedicated "initialize repository" view instead of a raw git error.
#[tauri::command]
pub async fn git_is_repo(root: String, shell: ShellConfig) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&shell, &root, &["rev-parse", "--is-inside-work-tree"]);
        // `git rev-parse --is-inside-work-tree` prints "true" and exits 0 inside a
        // work tree; outside a repo it exits non-zero (run_git returns Err).
        matches!(output, Ok(s) if s.trim() == "true")
    })
    .await
    .map_err(|e| e.to_string())
}

/// Initialize a git repository at `root` (`git init`).
#[tauri::command]
pub async fn git_init(root: String, shell: ShellConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["init"])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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

#[derive(Default)]
struct WorktreeRecord {
    path: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    is_bare: bool,
    is_detached: bool,
    is_prunable: bool,
}

fn parse_worktrees(output: &str) -> Vec<GitWorktree> {
    let mut worktrees = Vec::new();
    let mut rec = WorktreeRecord::default();

    // `git worktree list --porcelain` emits blank-line-separated records.
    // Prunable worktrees (directory gone / pruneable) are skipped: selecting one
    // would point the panels at a missing path. `is_main` is assigned later to
    // the first non-bare entry, since a bare-clone layout lists `bare` first.
    let flush = |rec: &mut WorktreeRecord, worktrees: &mut Vec<GitWorktree>| {
        if let Some(p) = rec.path.take() {
            if !rec.is_prunable {
                worktrees.push(GitWorktree {
                    path: p,
                    branch: rec.branch.take(),
                    head: rec.head.take(),
                    is_bare: rec.is_bare,
                    is_detached: rec.is_detached,
                    is_main: false,
                });
            }
        }
        *rec = WorktreeRecord::default();
    };

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut rec, &mut worktrees);
        } else if let Some(p) = line.strip_prefix("worktree ") {
            rec.path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            rec.head = Some(h.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            rec.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "bare" {
            rec.is_bare = true;
        } else if line == "detached" {
            rec.is_detached = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            rec.is_prunable = true;
        }
        // `locked` annotations are ignored (a locked worktree is still valid).
    }
    // Final record may not be followed by a trailing blank line.
    flush(&mut rec, &mut worktrees);

    // The repository's main working tree is the first non-bare entry.
    if let Some(w) = worktrees.iter_mut().find(|w| !w.is_bare) {
        w.is_main = true;
    }
    worktrees
}

#[tauri::command]
pub async fn git_worktree_list(
    root: String,
    shell: ShellConfig,
) -> Result<Vec<GitWorktree>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["worktree", "list", "--porcelain"])
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_worktrees(&output))
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

fn validate_ref_name(name: &str) -> Result<(), String> {
    // 最低限のフラグ injection 対策と git のリファレンス命名規約に沿った検証
    if name.is_empty() {
        return Err("branch name is empty".to_string());
    }
    if name.starts_with('-') {
        return Err("branch name cannot start with '-'".to_string());
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err("branch name contains invalid characters".to_string());
    }
    if name.contains("..") || name.contains("@{") {
        return Err("branch name contains invalid sequence".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    root: String,
    shell: ShellConfig,
    name: String,
    start_point: String,
) -> Result<(), String> {
    validate_ref_name(&name)?;
    validate_ref_name(&start_point)?;
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["branch", &name, &start_point])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_remote_url(
    root: String,
    shell: ShellConfig,
) -> Result<Option<String>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["remote", "get-url", "origin"])
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(output.ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

/// `git_remote_url` for many roots at once, in the same order. Used to backfill
/// the origin of projects registered before Pike stored it (#164): a WSL probe
/// costs a `wsl.exe` launch, so all of one distro's roots share a single call.
/// A root that is not a repository, or has no origin, yields `None`.
#[tauri::command]
pub async fn git_remote_urls(
    shell: ShellConfig,
    roots: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => remote_urls_wsl(&shell, &roots),
        _ => Ok(roots
            .iter()
            .map(|root| {
                run_git(&shell, root, &["remote", "get-url", "origin"])
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
            .collect()),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn remote_urls_wsl(shell: &ShellConfig, roots: &[String]) -> Result<Vec<Option<String>>, String> {
    if roots.is_empty() {
        return Ok(vec![]);
    }
    // One line of output per root, in order: the URL, or empty when there is
    // none. `head -n1` keeps a multi-URL remote from shifting later rows.
    let script = roots
        .iter()
        .map(|root| {
            format!(
                "git -C {} remote get-url origin 2>/dev/null | head -n1 | tr -d '\\r\\n'; echo",
                bash_quote(root)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let (_, stdout, _) = shell.run("bash", &["-c", &script])?;
    let mut urls: Vec<Option<String>> = stdout
        .lines()
        .map(|l| {
            let trimmed = l.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .collect();
    // A distro that fails to start prints nothing: report "no origin" rather
    // than mis-assigning one root's URL to another.
    urls.resize(roots.len(), None);
    Ok(urls)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_worktrees() {
        let out = "worktree /home/user/repo
HEAD aaa111
branch refs/heads/main

worktree /home/user/repo-feat
HEAD bbb222
branch refs/heads/feat

worktree /home/user/repo-det
HEAD ccc333
detached
";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 3);

        assert_eq!(wts[0].path, "/home/user/repo");
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert_eq!(wts[0].head.as_deref(), Some("aaa111"));
        assert!(wts[0].is_main);
        assert!(!wts[0].is_detached);

        assert_eq!(wts[1].path, "/home/user/repo-feat");
        assert_eq!(wts[1].branch.as_deref(), Some("feat"));
        assert!(!wts[1].is_main);

        assert_eq!(wts[2].path, "/home/user/repo-det");
        assert!(wts[2].branch.is_none());
        assert!(wts[2].is_detached);
    }

    #[test]
    fn parses_final_record_without_trailing_blank_line() {
        let out = "worktree /repo
HEAD aaa
branch refs/heads/main";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(wts[0].is_main);
    }

    #[test]
    fn bare_entry_is_not_main_first_working_tree_is() {
        let out = "worktree /repo/.bare
bare

worktree /repo/main
HEAD aaa
branch refs/heads/main
";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_bare);
        assert!(!wts[0].is_main, "the bare entry must not be treated as main");
        assert!(wts[1].is_main, "the first working tree is main");
        assert_eq!(wts[1].branch.as_deref(), Some("main"));
    }

    #[test]
    fn parses_unmerged_conflict_entries() {
        // Porcelain v2: `u` lines for conflicts, `1` for a staged change, `?` for untracked.
        let out = "# branch.oid abc123
# branch.head main
1 M. N... 100644 100644 100644 hhh iii staged.txt
u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt
u AA N... 000000 100644 100644 100644 h1 h2 h3 both added.txt
? untracked.txt
";
        let st = parse_status(out);
        assert_eq!(st.conflicted.len(), 2);
        assert_eq!(st.conflicted[0].path, "conflict.txt");
        assert_eq!(st.conflicted[0].status, "UU");
        // Path with a space must survive (splitn(11) keeps the remainder intact).
        assert_eq!(st.conflicted[1].path, "both added.txt");
        assert_eq!(st.conflicted[1].status, "AA");
        // Conflicts must not leak into staged/unstaged.
        assert_eq!(st.staged.len(), 1);
        assert_eq!(st.unstaged.len(), 1);
        assert!(st.is_dirty);
    }

    #[test]
    fn prunable_worktrees_are_skipped() {
        let out = "worktree /repo
HEAD aaa
branch refs/heads/main

worktree /repo-gone
HEAD bbb
branch refs/heads/gone
prunable gitdir file points to non-existent location
";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/repo");
        assert!(wts[0].is_main);
    }
}
