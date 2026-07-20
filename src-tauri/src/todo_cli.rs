//! `pike todo` — a standalone CLI over the project's `.pike/todo.md`.
//!
//! This runs *before* the Tauri runtime (see `main.rs`) and operates directly
//! on the Markdown checklist file, printing to stdout and exiting. It never
//! launches or talks to the GUI: the file is a plain `.pike/todo.md`, and a
//! running Pike window picks up external edits through its file watcher and
//! reloads the TODO panel automatically. The format mirrors `src/stores/todo.ts`
//! exactly (`- [ ]` / `- [x]`; headings and free text are preserved verbatim).
//!
//! Designed for coding agents running inside a Pike terminal (#139): they can
//! read and update the shared TODO list synchronously via stdout.

use std::path::{Path, PathBuf};

/// One line of the backing `todo.md`.
#[derive(Debug, Clone, PartialEq)]
enum Line {
    /// A checklist item. `prefix` preserves the bullet indentation (`- `, `  * `).
    /// `detail` is the item's body, written as indented continuation lines and
    /// stored dedented to the block's own base indent (empty when absent).
    Task {
        prefix: String,
        done: bool,
        text: String,
        detail: Vec<String>,
    },
    /// Headings, blank lines, free text — round-tripped unchanged.
    Raw(String),
}

/// Split a checklist line into `(prefix, done, text)` borrows, matching
/// `TASK_RE` in `todo.ts`: `^(\s*[-*]\s+)\[([ xX])\]\s?(.*)$`.
fn scan_task(line: &str) -> Option<(&str, bool, &str)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    // leading whitespace
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    // bullet marker `-` or `*`
    if i >= bytes.len() || (bytes[i] != b'-' && bytes[i] != b'*') {
        return None;
    }
    i += 1;
    // at least one space after the bullet
    let after_bullet = i;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i == after_bullet {
        return None;
    }
    let prefix = &line[..i];
    // `[ ]` / `[x]` / `[X]`
    if i + 2 >= bytes.len() || bytes[i] != b'[' || bytes[i + 2] != b']' {
        return None;
    }
    let done = match bytes[i + 1] {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    i += 3;
    // optional single space before the text
    let mut text = &line[i..];
    if let Some(stripped) = text.strip_prefix(' ') {
        text = stripped;
    }
    Some((prefix, done, text))
}

/// Owned variant, for building a `Line::Task`.
fn parse_task(line: &str) -> Option<(String, bool, String)> {
    scan_task(line).map(|(p, d, t)| (p.to_string(), d, t.to_string()))
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

/// Strip the block's own base indent (taken from its first non-blank line) so
/// relative nesting inside the detail is kept while the outer indent is not.
fn dedent(lines: Vec<&str>) -> Vec<String> {
    let base = lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .map(|l| &l[..indent_of(l)])
        .unwrap_or("");
    lines
        .iter()
        .map(|l| {
            l.strip_prefix(base)
                .unwrap_or_else(|| l.trim_start_matches([' ', '\t']))
                .to_string()
        })
        .collect()
}

fn parse(text: &str) -> Vec<Line> {
    let raw: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l)) // tolerate CRLF
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let Some((prefix, done, text)) = parse_task(raw[i]) else {
            out.push(Line::Raw(raw[i].to_string()));
            i += 1;
            continue;
        };
        // Continuation lines: indented deeper than the bullet and not tasks
        // themselves (a nested `- [ ]` stays its own task). Blank lines are taken
        // greedily, then given back, so they only stay when the block resumes.
        let indent = indent_of(&prefix);
        let mut body: Vec<&str> = Vec::new();
        let mut j = i + 1;
        while j < raw.len() {
            let blank = raw[j].trim().is_empty();
            if !blank && (scan_task(raw[j]).is_some() || indent_of(raw[j]) <= indent) {
                break;
            }
            body.push(if blank { "" } else { raw[j] });
            j += 1;
        }
        while body.last().is_some_and(|l| l.is_empty()) {
            body.pop();
            j -= 1;
        }
        out.push(Line::Task {
            prefix,
            done,
            text,
            detail: dedent(body),
        });
        i = j;
    }
    out
}

/// Serialize back to Markdown (without a trailing newline; the writer adds one).
fn serialize(lines: &[Line]) -> String {
    let mut out: Vec<String> = Vec::new();
    for l in lines {
        match l {
            Line::Task {
                prefix,
                done,
                text,
                detail,
            } => {
                out.push(format!("{prefix}[{}] {text}", if *done { 'x' } else { ' ' }));
                let pad = " ".repeat(indent_of(prefix) + 2);
                for d in detail {
                    out.push(if d.is_empty() {
                        String::new()
                    } else {
                        format!("{pad}{d}")
                    });
                }
            }
            Line::Raw(text) => out.push(text.clone()),
        }
    }
    out.join("\n")
}

/// Line indices (into `lines`) of the task rows, in order. The 1-based position
/// in this vector is the number shown by `list` and accepted by other commands.
fn task_line_indices(lines: &[Line]) -> Vec<usize> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| matches!(l, Line::Task { .. }).then_some(i))
        .collect()
}

/// Locate the project's `todo.md`. Prefers the nearest ancestor that already has
/// a `.pike/` directory (matches the GUI, which keeps it at the project root);
/// otherwise falls back to the git repository root, then the cwd. The GUI opens
/// terminals at the project root, so in practice cwd is the root.
fn resolve_todo_file() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut git_root: Option<PathBuf> = None;
    let mut dir: Option<&Path> = Some(cwd.as_path());
    while let Some(d) = dir {
        if d.join(".pike").is_dir() {
            return d.join(".pike").join("todo.md");
        }
        if git_root.is_none() && d.join(".git").exists() {
            git_root = Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    git_root.unwrap_or(cwd).join(".pike").join("todo.md")
}

fn load(path: &Path) -> Vec<Line> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(), // not created yet
    };
    let mut lines = parse(&content);
    // Drop the single trailing empty line produced by the file's final newline.
    if matches!(lines.last(), Some(Line::Raw(t)) if t.is_empty()) {
        lines.pop();
    }
    lines
}

fn save(path: &Path, lines: &[Line]) -> Result<(), String> {
    let dir = path.parent().ok_or("invalid todo path")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    // Keep .pike out of the repo, but never clobber a hand-edited .gitignore.
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        let _ = std::fs::write(&gi, "*\n");
    }
    std::fs::write(path, format!("{}\n", serialize(lines)))
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Parse the numeric arguments for done/undone/rm/show/detail. All must be valid
/// 1-based task numbers within range; returns `(number, line index)` pairs
/// (deduped) or an error so a bad number aborts the whole command rather than
/// applying it partially.
fn resolve_numbers(args: &[String], task_lines: &[usize]) -> Result<Vec<(usize, usize)>, String> {
    if args.is_empty() {
        return Err("expected one or more task numbers".to_string());
    }
    let mut out: Vec<(usize, usize)> = Vec::new();
    for a in args {
        let n: usize = a
            .parse()
            .map_err(|_| format!("not a task number: {a}"))?;
        if n == 0 || n > task_lines.len() {
            return Err(format!(
                "task number out of range: {n} (have {})",
                task_lines.len()
            ));
        }
        if !out.iter().any(|&(m, _)| m == n) {
            out.push((n, task_lines[n - 1]));
        }
    }
    Ok(out)
}

fn task_text(line: &Line) -> &str {
    match line {
        Line::Task { text, .. } => text,
        Line::Raw(_) => "",
    }
}

/// Flags shared by `add` and `detail`. Each `-d/--detail <text>` contributes the
/// body lines in order (a value of `-` is read from stdin, embedded newlines are
/// split); everything else is positional. `--append` / `--clear` are only
/// meaningful for `detail`.
struct DetailArgs {
    positional: Vec<String>,
    detail: Vec<String>,
    append: bool,
    clear: bool,
}

fn parse_detail_args(args: &[String]) -> Result<DetailArgs, String> {
    let mut out = DetailArgs {
        positional: Vec::new(),
        detail: Vec::new(),
        append: false,
        clear: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-d" | "--detail" => {
                let v = it.next().ok_or("expected text after -d")?;
                let text = if v == "-" {
                    std::io::read_to_string(std::io::stdin())
                        .map_err(|e| format!("failed to read stdin: {e}"))?
                } else {
                    v.clone()
                };
                out.detail
                    .extend(text.split('\n').map(|s| s.trim_end().to_string()));
            }
            "-a" | "--append" => out.append = true,
            "--clear" => out.clear = true,
            // A typo'd flag must not silently fall through to a destructive
            // default (`--appned` would replace the body instead of appending).
            other if other.starts_with('-') && other.len() > 1 => {
                return Err(format!("unknown flag: {other}"))
            }
            other => out.positional.push(other.to_string()),
        }
    }
    // Trim surrounding blank lines; interior ones are kept.
    let first = out.detail.iter().position(|l| !l.is_empty());
    match first {
        Some(s) => {
            let e = out.detail.iter().rposition(|l| !l.is_empty()).unwrap();
            out.detail = out.detail[s..=e].to_vec();
        }
        None => out.detail.clear(),
    }
    Ok(out)
}

/// Print a task's body, indented under whatever header the caller printed.
fn print_detail(detail: &[String]) {
    for d in detail {
        println!("   {d}");
    }
}

/// Print one task the way `show` and `detail` report it.
fn print_task(n: usize, done: bool, text: &str, detail: &[String]) {
    println!("{n}. [{}] {text}", if done { 'x' } else { ' ' });
    print_detail(detail);
}

/// Run a subcommand. Returns the process exit code. Output goes to stdout;
/// errors go to stderr.
fn run(sub: Option<&str>, rest: &[String]) -> i32 {
    let path = resolve_todo_file();
    match sub.unwrap_or("list") {
        "list" | "ls" => {
            let json = rest.iter().any(|a| a == "--json");
            let lines = load(&path);
            cmd_list(&lines, json);
            0
        }
        "add" => {
            let args = match parse_detail_args(rest) {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("todo add: {e}");
                    return 2;
                }
            };
            let text = args.positional.join(" ");
            let text = text.trim();
            if text.is_empty() {
                eprintln!("todo add: empty task text");
                return 2;
            }
            let mut lines = load(&path);
            lines.push(Line::Task {
                prefix: "- ".to_string(),
                done: false,
                text: text.to_string(),
                detail: args.detail.clone(),
            });
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            let n = task_line_indices(&lines).len();
            println!("added #{n}: {text}");
            print_detail(&args.detail);
            0
        }
        "show" | "cat" => {
            let lines = load(&path);
            let task_lines = task_line_indices(&lines);
            let targets = match resolve_numbers(rest, &task_lines) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("todo show: {e}");
                    return 2;
                }
            };
            for (n, idx) in targets {
                if let Line::Task {
                    done, text, detail, ..
                } = &lines[idx]
                {
                    print_task(n, *done, text, detail);
                }
            }
            0
        }
        "detail" | "note" => {
            let args = match parse_detail_args(rest) {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("todo detail: {e}");
                    return 2;
                }
            };
            // First positional is the task number, the rest is one body line.
            let (num, words) = match args.positional.split_first() {
                Some((n, w)) => (std::slice::from_ref(n), w),
                None => {
                    eprintln!("todo detail: expected a task number");
                    return 2;
                }
            };
            let mut lines = load(&path);
            let task_lines = task_line_indices(&lines);
            let (n, idx) = match resolve_numbers(num, &task_lines) {
                Ok(t) => t[0],
                Err(e) => {
                    eprintln!("todo detail: {e}");
                    return 2;
                }
            };
            let mut body = args.detail;
            if body.is_empty() && !words.is_empty() {
                body.push(words.join(" "));
            }
            if !args.clear && body.is_empty() {
                eprintln!("todo detail: expected body text (or --clear)");
                return 2;
            }
            let Line::Task { detail, .. } = &mut lines[idx] else {
                return 1;
            };
            if !args.append {
                detail.clear(); // --clear alone leaves `body` empty
            }
            detail.extend(body);
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            if let Line::Task {
                done, text, detail, ..
            } = &lines[idx]
            {
                print_task(n, *done, text, detail);
            }
            0
        }
        "done" | "undone" => {
            let done = sub == Some("done");
            let mut lines = load(&path);
            let task_lines = task_line_indices(&lines);
            let targets = match resolve_numbers(rest, &task_lines) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("todo {}: {e}", sub.unwrap_or(""));
                    return 2;
                }
            };
            for &(_, idx) in &targets {
                if let Line::Task { done: d, .. } = &mut lines[idx] {
                    *d = done;
                }
            }
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            let verb = if done { "done" } else { "reopened" };
            for &(n, idx) in &targets {
                println!("{verb} #{n}: {}", task_text(&lines[idx]));
            }
            0
        }
        "rm" | "remove" => {
            let mut lines = load(&path);
            let task_lines = task_line_indices(&lines);
            let mut targets = match resolve_numbers(rest, &task_lines) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("todo rm: {e}");
                    return 2;
                }
            };
            // Report before removal, then splice from the end to keep indices valid.
            let removed: Vec<(usize, String)> = targets
                .iter()
                .map(|&(n, idx)| (n, task_text(&lines[idx]).to_string()))
                .collect();
            targets.sort_unstable_by(|a, b| b.cmp(a));
            for (_, idx) in targets {
                lines.remove(idx);
            }
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            for (n, text) in removed {
                println!("removed #{n}: {text}");
            }
            0
        }
        "clear" => {
            // Only `--done` is accepted: silently ignoring a typo here would
            // wipe every task instead of just the checked ones.
            let done_only = match rest {
                [] => false,
                [flag] if flag == "--done" => true,
                _ => {
                    eprintln!("todo clear: unknown argument (only --done is accepted)");
                    return 2;
                }
            };
            let mut lines = load(&path);
            let doomed = |l: &Line| matches!(l, Line::Task { done, .. } if !done_only || *done);
            let before = lines.iter().filter(|l| doomed(l)).count();
            if before == 0 {
                println!("no {}todos to clear", if done_only { "completed " } else { "" });
                return 0;
            }
            lines.retain(|l| !doomed(l));
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            println!(
                "cleared {before} {}todo{}",
                if done_only { "completed " } else { "" },
                if before == 1 { "" } else { "s" }
            );
            0
        }
        "help" | "--help" | "-h" => {
            print_usage();
            0
        }
        other => {
            eprintln!("todo: unknown subcommand '{other}'\n");
            print_usage();
            2
        }
    }
}

fn cmd_list(lines: &[Line], json: bool) {
    let tasks: Vec<(bool, &str, &[String])> = lines
        .iter()
        .filter_map(|l| match l {
            Line::Task {
                done, text, detail, ..
            } => Some((*done, text.as_str(), detail.as_slice())),
            Line::Raw(_) => None,
        })
        .collect();

    if json {
        let items: Vec<String> = tasks
            .iter()
            .enumerate()
            .map(|(i, (done, text, detail))| {
                format!(
                    r#"{{"n":{},"done":{done},"text":{},"detail":{}}}"#,
                    i + 1,
                    json_string(text),
                    json_string(&detail.join("\n"))
                )
            })
            .collect();
        println!("[{}]", items.join(","));
        return;
    }

    if tasks.is_empty() {
        println!("No todos.");
        return;
    }
    for (i, (done, text, detail)) in tasks.into_iter().enumerate() {
        let n = i + 1;
        // Bodies stay collapsed so the list reads at a glance; `show` prints them.
        let more = match detail.len() {
            0 => String::new(),
            k => format!("  (+{k} line{})", if k == 1 { "" } else { "s" }),
        };
        println!("{n}. [{}] {text}{more}", if done { 'x' } else { ' ' });
    }
}

/// Minimal JSON string escaping (control chars, quotes, backslashes).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn print_usage() {
    println!(
        "pike todo — manage the project's .pike/todo.md checklist\n\
         \n\
         USAGE:\n\
         \x20 pike todo [list] [--json]     show tasks (numbered, 1-based)\n\
         \x20 pike todo add <text...>       append a task\n\
         \x20 pike todo show <n...>         show task(s) with their detail\n\
         \x20 pike todo detail <n> <text>   set a task's detail body\n\
         \x20 pike todo done <n...>         mark task(s) done\n\
         \x20 pike todo undone <n...>       mark task(s) not done\n\
         \x20 pike todo rm <n...>           remove task(s)\n\
         \x20 pike todo clear [--done]      remove all tasks, or just completed ones\n\
         \n\
         DETAIL:\n\
         \x20 A task may carry a multi-line body, stored as indented lines under it.\n\
         \x20 -d, --detail <text>  one body line (repeatable; `-` reads stdin)\n\
         \x20 -a, --append         append to the existing body instead of replacing\n\
         \x20 --clear              drop the existing body\n\
         \x20 `add` accepts -d too: pike todo add \"fix login\" -d \"repro: ...\"\n\
         \n\
         Numbers refer to the positions shown by `pike todo list`."
    );
}

/// Attach to the parent process's console so a GUI-subsystem build
/// (`windows_subsystem = "windows"` in release) can print to the terminal it was
/// launched from. A GUI-subsystem process gets no standard handles when a shell
/// starts it without redirection, so without this `pike todo` would print
/// nowhere.
///
/// Skip it when stdout is already usable (a pipe or a redirect — i.e. every
/// call from an agent or a script): `AttachConsole` **replaces** the standard
/// handles with the console's, so attaching there steals the output from the
/// caller's pipe and paints it on the terminal screen, corrupting the TUI the
/// caller is drawing (Claude Code in a Pike terminal pane).
///
/// Only stdout is probed. `AttachConsole` is all-or-nothing, so a redirect of
/// stdout alone (stderr left unattached) loses the error output; keeping the
/// caller's pipe intact matters more.
#[cfg(windows)]
fn attach_parent_console() {
    use windows::Win32::System::Console::{
        AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE,
    };
    unsafe {
        // ハンドル無しは Err か、NULL / INVALID_HANDLE_VALUE（is_invalid が両方見る）。
        if GetStdHandle(STD_OUTPUT_HANDLE).is_ok_and(|h| !h.is_invalid()) {
            return;
        }
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

/// Entry point called from `main()` before the Tauri runtime. If argv is
/// `pike todo ...`, handle it here and exit; otherwise return so normal startup
/// proceeds. Intercepting before the single-instance forwarding (see `wait.rs`)
/// is essential — otherwise `todo` would be routed to the GUI as a file path.
pub fn try_todo_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("todo") {
        return;
    }
    #[cfg(windows)]
    attach_parent_console();
    let sub = args.get(2).map(String::as_str);
    let rest: Vec<String> = args.iter().skip(3).cloned().collect();
    std::process::exit(run(sub, &rest));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_serialize_roundtrip() {
        let src = "# Heading\n\n- [ ] alpha\n  * [x] nested done\nfree text\n- [x] gamma";
        let lines = parse(src);
        assert_eq!(serialize(&lines), src);
        // `[X]` is accepted on read but normalized to lowercase `[x]` on write.
        assert_eq!(serialize(&parse("- [X] up")), "- [x] up");
    }

    #[test]
    fn clear_done_keeps_open_tasks_and_notes() {
        let lines = parse("# Heading\n- [ ] open\n- [x] closed\n  detail of closed\nfree text");
        let kept: Vec<Line> = lines
            .into_iter()
            .filter(|l| !matches!(l, Line::Task { done: true, .. }))
            .collect();
        assert_eq!(serialize(&kept), "# Heading\n- [ ] open\nfree text");
    }

    #[test]
    fn parse_task_variants() {
        assert_eq!(
            parse_task("- [ ] hello"),
            Some(("- ".to_string(), false, "hello".to_string()))
        );
        assert_eq!(
            parse_task("  - [x] done"),
            Some(("  - ".to_string(), true, "done".to_string()))
        );
        assert_eq!(
            parse_task("* [X] star"),
            Some(("* ".to_string(), true, "star".to_string()))
        );
        // no space after bullet, wrong marker, plain text → not a task
        assert_eq!(parse_task("-[ ] x"), None);
        assert_eq!(parse_task("+ [ ] x"), None);
        assert_eq!(parse_task("just text"), None);
        assert_eq!(parse_task("- [z] x"), None);
    }

    #[test]
    fn parse_task_empty_text() {
        assert_eq!(
            parse_task("- [ ]"),
            Some(("- ".to_string(), false, "".to_string()))
        );
    }

    #[test]
    fn task_indices_skip_raw() {
        let lines = parse("# h\n- [ ] a\ntext\n- [x] b");
        assert_eq!(task_line_indices(&lines), vec![1, 3]);
    }

    #[test]
    fn resolve_numbers_validates() {
        let lines = parse("- [ ] a\n- [ ] b\n- [ ] c");
        let tl = task_line_indices(&lines);
        // 1-based → line indices, deduped
        assert_eq!(
            resolve_numbers(&["1".into(), "3".into(), "1".into()], &tl),
            Ok(vec![(1, 0), (3, 2)])
        );
        assert!(resolve_numbers(&["0".into()], &tl).is_err());
        assert!(resolve_numbers(&["4".into()], &tl).is_err());
        assert!(resolve_numbers(&["x".into()], &tl).is_err());
        assert!(resolve_numbers(&[], &tl).is_err());
    }

    #[test]
    fn detail_block_parses_and_round_trips() {
        let src = "- [ ] title\n  body one\n  body two\n- [x] next";
        let lines = parse(src);
        assert_eq!(
            lines[0],
            Line::Task {
                prefix: "- ".into(),
                done: false,
                text: "title".into(),
                detail: vec!["body one".into(), "body two".into()],
            }
        );
        assert_eq!(task_line_indices(&lines), vec![0, 1]); // detail is not a task
        assert_eq!(serialize(&lines), src);
    }

    #[test]
    fn detail_boundaries() {
        // A nested checklist line stays its own task, not a body line.
        let lines = parse("- [ ] a\n  - [ ] nested\n");
        assert_eq!(task_line_indices(&lines).len(), 2);
        assert!(matches!(&lines[0], Line::Task { detail, .. } if detail.is_empty()));
        // Unindented text after the task ends the body.
        let lines = parse("- [ ] a\n  body\nplain");
        assert!(matches!(&lines[0], Line::Task { detail, .. } if detail == &["body".to_string()]));
        assert_eq!(lines[1], Line::Raw("plain".into()));
        // A blank line is absorbed only when the indented block resumes.
        let lines = parse("- [ ] a\n  one\n\n  two\n\n# end");
        assert!(
            matches!(&lines[0], Line::Task { detail, .. } if detail == &["one".to_string(), String::new(), "two".to_string()])
        );
        assert_eq!(lines[1], Line::Raw(String::new()));
        assert_eq!(lines[2], Line::Raw("# end".into()));
    }

    #[test]
    fn detail_dedents_to_base_indent() {
        // Relative nesting inside the body survives; the outer indent does not.
        let lines = parse("- [ ] a\n    one\n      deeper");
        assert!(
            matches!(&lines[0], Line::Task { detail, .. } if detail == &["one".to_string(), "  deeper".to_string()])
        );
        assert_eq!(serialize(&lines), "- [ ] a\n  one\n    deeper");
    }

    #[test]
    fn detail_args_flags() {
        let args: Vec<String> = ["2", "--append", "-d", "x\ny", "-d", "z"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let p = parse_detail_args(&args).unwrap();
        assert_eq!(p.positional, vec!["2".to_string()]);
        assert_eq!(p.detail, vec!["x", "y", "z"]);
        assert!(p.append && !p.clear);
        // `-d` with no value is an error, not a silent drop.
        assert!(parse_detail_args(&["-d".to_string()]).is_err());
    }

    #[test]
    fn crlf_tolerated_and_normalized() {
        let lines = parse("- [ ] a\r\n- [x] b\r");
        assert_eq!(
            lines,
            vec![
                Line::Task {
                    prefix: "- ".into(),
                    done: false,
                    text: "a".into(),
                    detail: vec![],
                },
                Line::Task {
                    prefix: "- ".into(),
                    done: true,
                    text: "b".into(),
                    detail: vec![],
                },
            ]
        );
        // serialize emits LF only
        assert_eq!(serialize(&lines), "- [ ] a\n- [x] b");
    }

    #[test]
    fn json_string_escapes() {
        assert_eq!(json_string("a\"b\\c\n"), r#""a\"b\\c\n""#);
    }
}
