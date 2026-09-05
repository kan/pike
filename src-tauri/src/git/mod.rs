use crate::types::{git_args, git_bash_prefix, ShellConfig};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

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
    /// A rebase/merge/… that git stopped in the middle of (#222). `None` when
    /// the tree is not in the middle of one.
    pub operation: Option<GitOperation>,
}

/// A git operation left half-finished in the working tree, as recorded by the
/// state files in the gitdir. Detected on every status so the panel can offer
/// continue/abort instead of leaving the user to work it out (#222).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperation {
    /// `rebase` | `merge` | `cherry-pick` | `revert` | `am` | `bisect`. Also the
    /// git subcommand the frontend appends `--continue`/`--abort` to.
    pub kind: String,
    /// Branch being rebased. porcelain v2 reports `(detached)` during a rebase,
    /// so this is the only place the real name survives.
    pub branch: Option<String>,
    /// Progress, when both numbers are known — never a half-read `0/0`.
    pub step: Option<u32>,
    pub total: Option<u32>,
    /// `conflict` | `commit-failed` | `stopped`.
    pub stop: String,
    /// The commit a `commit-failed` rebase could not write, for `git commit -C`.
    pub stopped_sha: Option<String>,
    /// Its subject, so the confirm dialog can name what is about to be committed.
    pub stopped_subject: Option<String>,
    /// Whether `--continue` / `--abort` apply. Decided here rather than in the
    /// panel so the guard sits next to the classification it depends on.
    pub can_continue: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    /// リネーム / コピーの元の名前（#306）。それ以外は `None`。
    /// diff とアンステージで要る理由は `.claude/rules/git.md`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
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
    shell.run_stdout("git", &git_args(root, args))
}

/// Like `run_git` but hands back the exit code and both streams, for the
/// callers that need to say more than "it failed".
fn run_git_full(
    shell: &ShellConfig,
    root: &str,
    args: &[&str],
) -> Result<(i32, String, String), String> {
    shell.run("git", &git_args(root, args))
}

/// Like `run_git` but returns stdout regardless of exit code. Used for
/// commands like `git diff --no-index` that exit with code 1 when files differ.
fn run_git_raw_stdout(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<String, String> {
    let output = shell.run_raw("git", &git_args(root, args))?;
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
            // Changed entry. **リネーム / コピーの `2 ` 行はフィールドが 1 つ多い**（#306）:
            //
            //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><TAB><origPath>
            //
            // どちらも `splitn(9)` で分けていたころは、`2 ` 行の 9 個目に
            // 「スコア + 空白 + パス」がまるごと残り、タブで切っても `R100 new.md` が
            // ファイル名になっていた（実際の出力で確認）。
            let is_rename = line.starts_with("2 ");
            let fields = if is_rename { 10 } else { 9 };
            let parts: Vec<&str> = line.splitn(fields, ' ').collect();
            if parts.len() >= fields {
                let xy = parts[1];
                let x = &xy[..1];
                let y = &xy[1..2];
                // 並びは `<path><TAB><origPath>`（新しい名前が先）。パスに空白が入っていても
                // `splitn` の最後の要素なので、そのまま残る。
                let last = parts[fields - 1];
                let (path, orig_path) = match last.split_once('\t') {
                    Some((new, orig)) if is_rename => (new, Some(orig.to_string())),
                    _ => (last, None),
                };
                if x != "." {
                    staged.push(GitFileChange {
                        path: path.to_string(),
                        status: x.to_string(),
                        orig_path: orig_path.clone(),
                    });
                }
                if y != "." {
                    unstaged.push(GitFileChange {
                        path: path.to_string(),
                        status: y.to_string(),
                        orig_path,
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
                    orig_path: None,
                });
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            // Untracked: "? path"
            unstaged.push(GitFileChange {
                path: path.to_string(),
                status: "?".to_string(),
                orig_path: None,
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
        operation: None,
    }
}

/// Field separator (ASCII Unit Separator) and record separator (ASCII Record Separator).
/// Using these instead of NUL avoids collision when %D (refs) is empty — an empty
/// field between two NUL bytes would be indistinguishable from a double-NUL record separator.
/// **`git log` には必ず付ける。** `log.showSignature=true` を設定していると、`git log` は
/// 署名の検証結果を**標準出力の、`--format` より前**に出す。位置で読む側（`parse_log` /
/// `parse_log_simple` / `commit_patch`）が丸ごと外れるので、その設定のマシンでは履歴も
/// コミットの差分も空になる。`git diff` は影響を受けないぶん気付きにくい。
const NO_SHOW_SIGNATURE: &str = "--no-show-signature";

const FS: char = '\x1f';
const RS: &str = "\x1e";

fn parse_log(output: &str) -> Vec<GitLogEntry> {
    output
        .split(RS)
        .filter_map(|record| {
            let record = record.trim_matches('\n');
            if record.is_empty() {
                return None;
            }
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

/// State files that tell us which operation is half-finished, relative to the
/// gitdir. Every one lives in the *per-worktree* gitdir, so a single
/// `rev-parse --absolute-git-dir` resolves them all — including when `.git` is
/// a file because the root is a linked worktree.
///
/// `rebase-merge/head-name` (and its `rebase-apply` twin) doubles as the
/// "a rebase exists" marker. Note `rebase-merge/interactive` is written for a
/// plain `git rebase` too, so it cannot be used to spot `-i` (measured).
/// `(path, read contents)`. Most entries are pure markers — whether git wrote
/// them is the whole signal — and `BISECT_LOG` in particular grows a block per
/// bisect step, so only the files whose text is actually used get read.
const OP_STATE_FILES: &[(&str, bool)] = &[
    ("rebase-merge/head-name", true),
    ("rebase-merge/msgnum", true),
    ("rebase-merge/end", true),
    ("rebase-merge/message", false),
    ("rebase-merge/stopped-sha", false),
    ("rebase-merge/done", true),
    ("rebase-apply/head-name", true),
    ("rebase-apply/next", true),
    ("rebase-apply/last", true),
    ("rebase-apply/applying", false),
    ("MERGE_HEAD", false),
    ("CHERRY_PICK_HEAD", false),
    ("REVERT_HEAD", false),
    ("BISECT_LOG", false),
];

/// Probed state: a key is present exactly when the file is. An *empty* file
/// therefore maps to `""` — the distinction the `commit-failed` classification
/// rests on, and the reason this is not `fs::batch_read_files` (that one trims
/// contents and folds empty into "missing").
type StateFiles = std::collections::HashMap<&'static str, String>;

/// Read the status and the operation state in **one** `wsl.exe` spawn — the
/// same trick `remote_urls_wsl` uses. A second round trip per 10 s poll is the
/// one cost worth avoiding here; everything else about the probe is cheap.
fn status_and_state_wsl(shell: &ShellConfig, root: &str) -> Result<(String, StateFiles), String> {
    let git = git_bash_prefix(root);
    let mut script = format!(
        "{git} status --porcelain=v2 --branch --untracked-files=all || exit 1\n\
         printf '{RS}'\n\
         d=$({git} rev-parse --absolute-git-dir 2>/dev/null)\n"
    );
    for (name, read) in OP_STATE_FILES {
        // One record per entry, in table order: `exists FS contents`. Positional
        // like `remote_urls_wsl`, so the name never travels through the stream.
        let cat = if *read {
            format!("cat \"$d/{name}\" 2>/dev/null; ")
        } else {
            String::new()
        };
        script.push_str(&format!(
            "if [ -e \"$d/{name}\" ]; then printf '1{FS}'; {cat}else printf '0{FS}'; fi; printf '{RS}'\n"
        ));
    }
    let (code, mut stdout, stderr) = shell.run("bash", &["-c", &script])?;
    if code != 0 {
        return Err(format!("git error: {stderr}"));
    }
    let files = match stdout.find(RS) {
        Some(at) => {
            let files = parse_state_records(&stdout[at + RS.len()..]);
            stdout.truncate(at);
            files
        }
        None => StateFiles::new(),
    };
    Ok((stdout, files))
}

/// Windows: `git status`, then plain file reads. `.git` is a directory at the
/// root for an ordinary repo, so ask git for the gitdir only when it is not —
/// a linked worktree, a submodule, or a root below the top level. That keeps
/// the common case at the one process spawn it has always been.
fn status_and_state_native(
    shell: &ShellConfig,
    root: &str,
) -> Result<(String, StateFiles), String> {
    let status = run_git(
        shell,
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let plain = std::path::Path::new(root).join(".git");
    let dir = if plain.is_dir() {
        Some(plain)
    } else {
        run_git(shell, root, &["rev-parse", "--absolute-git-dir"])
            .ok()
            .map(|d| std::path::PathBuf::from(d.trim()))
    };

    let mut files = StateFiles::new();
    if let Some(dir) = dir {
        for (name, read) in OP_STATE_FILES {
            let path = dir.join(name);
            if *read {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    files.insert(name, text);
                }
            } else if path.try_exists().unwrap_or(false) {
                files.insert(name, String::new());
            }
        }
    }
    Ok((status, files))
}

fn parse_state_records(rest: &str) -> StateFiles {
    let mut files = StateFiles::new();
    for ((name, _), record) in OP_STATE_FILES.iter().zip(rest.split(RS)) {
        if let Some((exists, content)) = record.split_once(FS) {
            if exists == "1" {
                files.insert(name, content.to_string());
            }
        }
    }
    files
}

/// The `pick`-like rebase todo commands: those that produce a commit, and so
/// the only ones a "the commit could not be written" recovery may target.
/// `exec` and `break` stop *after* a successful commit — re-committing there
/// would fabricate a commit carrying another one's author, date and message.
fn is_commit_producing(command: &str) -> bool {
    matches!(
        command,
        "pick" | "p" | "reword" | "r" | "edit" | "e" | "squash" | "s" | "fixup" | "f"
    )
}

/// The commit a stopped rebase was working on, from the last line of
/// `rebase-merge/done` (`pick <sha> # <subject>`). Measured against both stop
/// kinds: when a conflict stops the rebase the todo is already empty, so `done`
/// is the source that holds in every case. The trailing line may be a partial
/// write (`done` is appended, not rewritten), hence the shape check.
fn stopped_commit(done: &str) -> Option<(String, String)> {
    let line = done.lines().rev().find(|l| !l.trim().is_empty())?;
    let mut parts = line.trim().splitn(3, ' ');
    let command = parts.next()?;
    let sha = parts.next()?;
    if !is_commit_producing(command) || !is_sha(sha) {
        return None;
    }
    let subject = parts
        .next()
        .map(|rest| rest.trim_start_matches('#').trim().to_string())
        .unwrap_or_default();
    Some((sha.to_string(), subject))
}

/// The id goes into a shell command line, and it comes out of a file git wrote
/// rather than from a command we ran — hold it to the hex alphabet.
fn is_sha(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_operation(files: &StateFiles, has_conflicts: bool) -> Option<GitOperation> {
    let content = |key: &str| files.get(key).map(String::as_str);
    let exists = |key: &str| files.contains_key(key);
    let number = |key: &str| content(key).and_then(|v| v.trim().parse::<u32>().ok());
    let branch_of = |key: &str| {
        content(key).map(|v| {
            let v = v.trim();
            v.strip_prefix("refs/heads/").unwrap_or(v).to_string()
        })
    };

    let (kind, branch, step, total) = if exists("rebase-merge/head-name") {
        (
            "rebase",
            branch_of("rebase-merge/head-name"),
            number("rebase-merge/msgnum"),
            number("rebase-merge/end"),
        )
    } else if exists("rebase-apply/head-name") {
        // The old apply backend backs both `rebase` and `am`; `applying` is
        // what tells them apart.
        let kind = if exists("rebase-apply/applying") {
            "am"
        } else {
            "rebase"
        };
        (
            kind,
            branch_of("rebase-apply/head-name"),
            number("rebase-apply/next"),
            number("rebase-apply/last"),
        )
    } else if exists("MERGE_HEAD") {
        ("merge", None, None, None)
    } else if exists("CHERRY_PICK_HEAD") {
        ("cherry-pick", None, None, None)
    } else if exists("REVERT_HEAD") {
        ("revert", None, None, None)
    } else if exists("BISECT_LOG") {
        ("bisect", None, None, None)
    } else {
        return None;
    };

    // A rebase that stopped without conflicts and without writing `message` /
    // `stopped-sha` did not stop *at* a commit — it failed to create one
    // (signing, a hook). `git rebase --continue` refuses that state with "you
    // have staged changes in your working tree", so the way out is to write the
    // commit first. Measured against a forced signing failure.
    let stopped = (kind == "rebase"
        && !has_conflicts
        && !exists("rebase-merge/message")
        && !exists("rebase-merge/stopped-sha"))
    .then(|| content("rebase-merge/done").and_then(stopped_commit))
    .flatten();

    let stop = if has_conflicts {
        "conflict"
    } else if stopped.is_some() {
        "commit-failed"
    } else {
        "stopped"
    };
    let (stopped_sha, stopped_subject) = stopped.map_or((None, None), |(s, t)| (Some(s), Some(t)));
    // Both halves of the progress, or neither: a half-written "0/0" is worse
    // than showing nothing.
    let (step, total) = step
        .zip(total)
        .map_or((None, None), |(s, t)| (Some(s), Some(t)));

    Some(GitOperation {
        kind: kind.to_string(),
        branch,
        step,
        total,
        stop: stop.to_string(),
        stopped_sha,
        stopped_subject,
        // `am` wants the mailbox and `bisect` wants good/bad; neither belongs
        // behind a two-button banner, so the panel only labels those.
        can_continue: matches!(kind, "rebase" | "merge" | "cherry-pick" | "revert"),
    })
}

#[tauri::command]
pub async fn git_status(root: String, shell: ShellConfig) -> Result<GitStatusResult, String> {
    let (output, files) = tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => status_and_state_wsl(&shell, &root),
        _ => status_and_state_native(&shell, &root),
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut status = parse_status(&output);
    // Never let the probe break the status the panel depends on.
    status.operation = parse_operation(&files, !status.conflicted.is_empty());
    Ok(status)
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
        let mut args = vec![
            "log",
            NO_SHOW_SIGNATURE,
            "--format=%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%B%x1e",
            "-n",
            &n,
        ];
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
    // リネーム / コピーの元の名前（`GitFileChange.origPath`、#306）。
    orig_path: Option<String>,
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
        // **元の名前も渡す（#306、理由は `.claude/rules/git.md`）。** 作業ツリー側に元の名前は
        // もう無いが、一致しない pathspec は無視されるだけなので staged かどうかで分けない。
        if let Some(orig) = orig_path.as_deref() {
            args.push(orig);
        }
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
pub async fn git_stage(root: String, shell: ShellConfig, paths: Vec<String>) -> Result<(), String> {
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
pub async fn git_commit(root: String, shell: ShellConfig, message: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Route through user-PATH variant so commit hooks, gpg.ssh.program,
        // and other user-installed binaries resolve (Pike's default WSL spawn
        // bypasses bash and misses ~/.local/bin, ~/bin, etc.).
        shell.run_stdout_with_user_path("git", &git_args(&root, &["commit", "-m", &message]))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Branches offered by the switcher (#197): local ones, plus remote-tracking
/// ones so a branch that exists only on the remote can be checked out directly.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct GitBranches {
    pub local: Vec<String>,
    /// `<remote>/<branch>` form, e.g. `origin/main`.
    pub remote: Vec<String>,
}

fn parse_branch_refs(output: &str) -> GitBranches {
    let mut branches = GitBranches::default();
    for line in output.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("refs/heads/") {
            branches.local.push(name.to_string());
        } else if let Some(name) = line.strip_prefix("refs/remotes/") {
            // `<remote>/HEAD` is a symbolic ref mirroring the remote's default
            // branch, not a branch of its own.
            if name.ends_with("/HEAD") {
                continue;
            }
            branches.remote.push(name.to_string());
        }
    }
    branches
}

#[tauri::command]
pub async fn git_branch_list(root: String, shell: ShellConfig) -> Result<GitBranches, String> {
    // `for-each-ref` over both namespaces keeps local and remote separable
    // without the `remotes/` prefix guesswork that parsing `branch -a` needs.
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads",
                "refs/remotes",
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_branch_refs(&output))
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
pub async fn git_checkout(root: String, shell: ShellConfig, branch: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["checkout", &branch])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Check out a remote-tracking branch by creating the local branch that tracks
/// it (`origin/foo` → local `foo`, #197). Git derives the local name from its own
/// remote list, so a slash in either the remote or the branch stays correct.
/// Fails when the local branch already exists — the caller switches to it
/// instead.
#[tauri::command]
pub async fn git_checkout_track(
    root: String,
    shell: ShellConfig,
    remote_branch: String,
) -> Result<(), String> {
    validate_ref_name(&remote_branch)?;
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["checkout", "--track", &remote_branch])?;
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
pub async fn git_remote_url(root: String, shell: ShellConfig) -> Result<Option<String>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["remote", "get-url", "origin"])
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(output
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
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
                "{} remote get-url origin 2>/dev/null | head -n1 | tr -d '\\r\\n'; echo",
                git_bash_prefix(root)
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

/// Options offered by the pull/push button context menus (#179).
///
/// Modelled as enums rather than free-form strings so the frontend can never
/// hand arbitrary arguments to the git CLI; adding an option means adding a
/// variant here.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PullOption {
    Rebase,
    Autostash,
    FfOnly,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PushOption {
    ForceWithLease,
    Tags,
    SetUpstream,
}

#[tauri::command]
pub async fn git_push(
    root: String,
    shell: ShellConfig,
    options: Option<Vec<PushOption>>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["push"];
        // `--set-upstream` needs an explicit destination, and it has to come
        // after the flags. `origin` matches what the rest of the module assumes
        // (see `git_remote_url`); HEAD resolves to the current branch.
        let mut destination: &[&str] = &[];
        for opt in options.unwrap_or_default() {
            match opt {
                PushOption::ForceWithLease => args.push("--force-with-lease"),
                PushOption::Tags => args.push("--tags"),
                PushOption::SetUpstream => {
                    args.push("--set-upstream");
                    destination = &["origin", "HEAD"];
                }
            }
        }
        args.extend_from_slice(destination);
        run_git(&shell, &root, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(
    root: String,
    shell: ShellConfig,
    options: Option<Vec<PullOption>>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["pull"];
        for opt in options.unwrap_or_default() {
            args.push(match opt {
                PullOption::Rebase => "--rebase",
                PullOption::Autostash => "--autostash",
                PullOption::FfOnly => "--ff-only",
            });
        }
        // Unlike every other git call, keep stdout when pull fails: a stopped
        // merge/rebase writes `CONFLICT (content): Merge conflict in …` there,
        // and `run_git` would hand back only the terse stderr half (#222).
        let (code, stdout, stderr) = run_git_full(&shell, &root, &args)?;
        if code == 0 {
            return Ok(stdout);
        }
        Err(format!("git error: {}", format!("{stdout}{stderr}").trim()))
    })
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
        run_git(
            &shell,
            &root,
            &["show", "--pretty=", "--name-status", &hash],
        )
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
            let rest = parts.next()?;
            // リネーム / コピーは `R100\t<orig>\t<new>` の形。**こちらは元の名前が先**
            // （porcelain v2 の `2 ` 行とは逆）。**コミットの差分は `--follow` 側で解決する**
            // ので、ここで埋めた元の名前を diff に渡す消費者は今のところ無い。
            let (path, orig_path) = match rest.split_once('\t') {
                Some((orig, new)) => (new.to_string(), Some(orig.to_string())),
                None => (rest.to_string(), None),
            };
            Some(GitFileChange {
                path,
                status,
                orig_path,
            })
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
        // **`--follow` でリネームを追う（#306、理由は `.claude/rules/git.md`）。** 呼び出し元の
        // 2 つ（履歴タブ・アウトラインの履歴）が元の名前を知らないので、`git_diff` と違って
        // pathspec を足す手が使えない。親を持たない最初のコミットもそのまま扱える。
        let output = run_git(
            &shell,
            &root,
            &[
                "log",
                NO_SHOW_SIGNATURE,
                "--follow",
                "-p",
                "--format=%H",
                "--max-count=1",
                &hash,
                "--",
                &path,
            ],
        )?;
        let patch = commit_patch(&output, &hash);
        if !patch.is_empty() {
            return Ok(truncate_diff(patch.to_string()));
        }

        // **マージコミットは `--follow` で出せない。** パスを絞った `git log` はマージを
        // 素通りして祖先へ遡るので（上の確認で弾かれる）、そこだけ従来どおり第 1 親との
        // 差分を出す。リネーム検出は効かないが、置き換える前と同じ見え方になる。
        //
        // **失敗を空に潰さないこと。** 「変更なし」と出して終わると、#306 が直したのと同じ
        // 「静かに壊れる」形になる。`~1` が無い最初のコミットだけを `--root` で拾い、
        // それ以外のエラーは git の言い分をそのまま返す。
        let output = match run_git(
            &shell,
            &root,
            &["diff", &format!("{hash}~1"), &hash, "--", &path],
        ) {
            Ok(o) => o,
            Err(_) => run_git(&shell, &root, &["diff", "--root", &hash, "--", &path])?,
        };
        Ok(truncate_diff(output))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `git log --format=%H -p` の出力（`<hash>\n\n<patch>`）から、**要求したコミットのもので
/// あれば**パッチを取り出す。
///
/// **確かめるのが要点。** `git log` は pathspec に一致しない commit を飛ばして遡るので、
/// 「そのコミットはこのパスを触っていない」場合に**祖先のコミットの差分**が返る（実測）。
/// 置き換える前の `git diff <hash>~1 <hash>` は空を返していたので、確認せずに使うと
/// 別のコミットの中身を黙って見せることになる。
fn commit_patch<'a>(output: &'a str, hash: &str) -> &'a str {
    let Some((first, rest)) = output.split_once('\n') else {
        return "";
    };
    // 呼び出し側は短縮ハッシュを渡すこともある。
    let found = first.trim();
    if found.is_empty() || !found.starts_with(hash) {
        return "";
    }
    rest.strip_prefix('\n').unwrap_or(rest)
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

/// Raw bytes of a file at a commit, base64-encoded.
///
/// `git_show_file` decodes stdout as text, which destroys binary content. The
/// "open file" action needs the actual bytes so an image at a commit can go to
/// the image viewer instead of being rendered as mojibake in the editor (#178
/// の確認中に判明した不具合).
#[tauri::command]
pub async fn git_show_file_base64(
    root: String,
    shell: ShellConfig,
    hash: String,
    path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let spec = format!("{hash}:{path}");
        let output = shell.run_raw("git", &git_args(&root, &["show", &spec]))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(&output.stdout))
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
            &[
                "log",
                NO_SHOW_SIGNATURE,
                "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
                "-n",
                &n,
                "--",
                &path,
            ],
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
                NO_SHOW_SIGNATURE,
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
        if line.starts_with("diff ")
            || line.starts_with("index ")
            || line.starts_with("---")
            || line.starts_with("+++")
        {
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
            } else if mod_start.is_none() && add_start.is_none() {
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

    GitDiffLines {
        added,
        modified,
        deleted,
    }
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
            Err(_) => Ok(GitDiffLines {
                added: vec![],
                modified: vec![],
                deleted: vec![],
            }),
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
        assert!(
            !wts[0].is_main,
            "the bare entry must not be treated as main"
        );
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
    fn parses_renamed_entries() {
        // Porcelain v2 の `2 ` 行はスコア（`R100`）のぶんフィールドが 1 つ多い（#306）。
        // 実際の `git status --porcelain=v2` の出力から。
        let out = "# branch.oid abc123
# branch.head main
2 RM N... 100644 100644 100644 94954ab 94954ab R100 new.md\told.md
2 R. N... 100644 100644 100644 3774da6 3774da6 R100 renamed space.txt\twith space.txt
2 C75 N... 100644 100644 100644 aaa bbb C75 copy.txt\tsource.txt
1 M. N... 100644 100644 100644 hhh iii plain.txt
";
        let st = parse_status(out);

        // `RM` は staged（R）と unstaged（M）の両方に出る。どちらも新しい名前。
        assert_eq!(st.staged[0].path, "new.md");
        assert_eq!(st.staged[0].status, "R");
        assert_eq!(st.unstaged[0].path, "new.md");
        assert_eq!(st.unstaged[0].status, "M");

        // 名前に空白があっても、スコアだけが落ちる。
        assert_eq!(st.staged[1].path, "renamed space.txt");
        // コピー（`C<score>`）も同じ形。
        assert_eq!(st.staged[2].path, "copy.txt");
        // 通常の `1 ` 行は 9 フィールドのまま。
        assert_eq!(st.staged[3].path, "plain.txt");
    }

    #[test]
    fn commit_patch_needs_the_requested_commit() {
        let out =
            "abc123def\n\ndiff --git a/old.md b/new.md\nrename from old.md\nrename to new.md\n";
        assert!(commit_patch(out, "abc123def").starts_with("diff --git"));
        // 短縮ハッシュで引いても同じ。
        assert!(commit_patch(out, "abc123").starts_with("diff --git"));

        // **そのコミットが触っていないパスを渡すと、`git log` は祖先まで遡る。**
        // 別のコミットの差分を黙って見せないよう、ここで落とす。
        assert_eq!(commit_patch(out, "999999"), "");
        // 該当が無ければ出力そのものが空。
        assert_eq!(commit_patch("", "abc123def"), "");
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

    #[test]
    fn splits_local_and_remote_branch_refs() {
        let out = "refs/heads/feature/nested
refs/heads/main
refs/remotes/origin/HEAD
refs/remotes/origin/feature/nested
refs/remotes/origin/main
refs/remotes/upstream/main
refs/tags/v1.0.0
";
        let branches = parse_branch_refs(out);
        assert_eq!(branches.local, vec!["feature/nested", "main"]);
        assert_eq!(
            branches.remote,
            vec!["origin/feature/nested", "origin/main", "upstream/main"]
        );
    }

    #[test]
    fn branch_refs_of_empty_repo_are_empty() {
        assert_eq!(parse_branch_refs(""), GitBranches::default());
    }
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    /// Build the probe map. `(name, Some(content))` is a file git wrote (empty
    /// contents included); `(name, None)` spells out an absent one, which the
    /// map represents by having no key at all.
    fn files(entries: &[(&str, Option<&str>)]) -> StateFiles {
        entries
            .iter()
            .filter_map(|(name, content)| {
                let key = OP_STATE_FILES.iter().find(|(n, _)| n == name)?.0;
                Some((key, (*content)?.to_string()))
            })
            .collect()
    }

    #[test]
    fn no_state_files_means_no_operation() {
        assert_eq!(parse_operation(&files(&[]), false), None);
        // A plain detached HEAD (a checked-out tag) must not raise a banner.
        assert_eq!(
            parse_operation(&files(&[("MERGE_HEAD", None)]), false),
            None
        );
    }

    #[test]
    fn rebase_conflict_carries_progress_and_branch() {
        // Measured layout of a conflict stop: message and stopped-sha written.
        let op = parse_operation(
            &files(&[
                ("rebase-merge/head-name", Some("refs/heads/topic\n")),
                ("rebase-merge/msgnum", Some("2\n")),
                ("rebase-merge/end", Some("5\n")),
                ("rebase-merge/message", Some("topic side\n")),
                ("rebase-merge/stopped-sha", Some("3eb7a26\n")),
            ]),
            true,
        )
        .expect("an operation");
        assert_eq!(op.kind, "rebase");
        assert_eq!(op.branch.as_deref(), Some("topic"));
        assert_eq!((op.step, op.total), (Some(2), Some(5)));
        assert_eq!(op.stop, "conflict");
        assert_eq!(op.stopped_sha, None);
    }

    #[test]
    fn merge_is_detected_without_conflicts() {
        // A plain `git pull` whose commit failed to sign: MERGE_HEAD is the only
        // trace — HEAD is not detached and nothing is unmerged (measured).
        let op = parse_operation(&files(&[("MERGE_HEAD", Some("abc\n"))]), false).unwrap();
        assert_eq!(op.kind, "merge");
        assert_eq!(op.stop, "stopped");
        assert_eq!((op.step, op.total), (None, None));
    }

    #[test]
    fn rebase_that_could_not_commit_offers_the_stopped_commit() {
        let done = "pick 9a8060c672571cc0c1c6eeae67e99e2f516bcbbb # feat one\n";
        let op = parse_operation(
            &files(&[
                ("rebase-merge/head-name", Some("refs/heads/feat\n")),
                ("rebase-merge/msgnum", Some("1\n")),
                ("rebase-merge/end", Some("3\n")),
                ("rebase-merge/message", None),
                ("rebase-merge/stopped-sha", None),
                ("rebase-merge/done", Some(done)),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(op.stop, "commit-failed");
        assert_eq!(
            op.stopped_sha.as_deref(),
            Some("9a8060c672571cc0c1c6eeae67e99e2f516bcbbb")
        );
        assert_eq!(op.stopped_subject.as_deref(), Some("feat one"));
    }

    #[test]
    fn exec_and_break_stops_offer_no_recommit() {
        // The commit already succeeded here, so re-committing would fabricate one
        // carrying the next pick's author and message.
        for done in ["exec make test\n", "break\n"] {
            let op = parse_operation(
                &files(&[
                    ("rebase-merge/head-name", Some("refs/heads/feat\n")),
                    ("rebase-merge/message", None),
                    ("rebase-merge/stopped-sha", None),
                    ("rebase-merge/done", Some(done)),
                ]),
                false,
            )
            .unwrap();
            assert_eq!(op.stop, "stopped");
            assert_eq!(op.stopped_sha, None);
        }
    }

    #[test]
    fn partial_done_line_is_rejected() {
        // `done` is appended, so the last line can be caught mid-write.
        assert_eq!(stopped_commit("pick 9a8060c6 # ok\npick 9a80"), None);
        assert_eq!(stopped_commit(""), None);
        assert_eq!(stopped_commit("pick zzzz # not hex"), None);
    }

    #[test]
    fn apply_backend_splits_rebase_from_am() {
        let am = parse_operation(
            &files(&[
                ("rebase-apply/head-name", Some("refs/heads/main\n")),
                ("rebase-apply/applying", Some("")),
                ("rebase-apply/next", Some("1\n")),
                ("rebase-apply/last", Some("4\n")),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(am.kind, "am");
        assert_eq!((am.step, am.total), (Some(1), Some(4)));

        let rebase = parse_operation(
            &files(&[("rebase-apply/head-name", Some("refs/heads/main\n"))]),
            false,
        )
        .unwrap();
        assert_eq!(rebase.kind, "rebase");
    }

    #[test]
    fn half_read_progress_is_dropped() {
        let op = parse_operation(
            &files(&[
                ("rebase-merge/head-name", Some("refs/heads/feat\n")),
                ("rebase-merge/msgnum", Some("2\n")),
            ]),
            true,
        )
        .unwrap();
        assert_eq!((op.step, op.total), (None, None));
    }

    #[test]
    fn state_records_keep_empty_files_distinct_from_missing() {
        // Records are positional, in OP_STATE_FILES order: `exists FS contents`.
        // An empty file present (`1` with nothing after it) must not read as
        // absent — the whole commit-failed classification turns on that.
        let raw: String = OP_STATE_FILES
            .iter()
            .map(|(name, _)| match *name {
                "rebase-merge/head-name" => format!("1{FS}refs/heads/feat\n{RS}"),
                "rebase-merge/message" => format!("1{FS}{RS}"),
                _ => format!("0{FS}{RS}"),
            })
            .collect();
        let parsed = parse_state_records(&raw);
        assert_eq!(parsed.get("rebase-merge/message"), Some(&String::new()));
        assert_eq!(
            parsed.get("rebase-merge/head-name").unwrap(),
            "refs/heads/feat\n"
        );
        assert_eq!(parsed.get("rebase-merge/done"), None);
    }
}
