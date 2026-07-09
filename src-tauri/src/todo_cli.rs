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
    Task {
        prefix: String,
        done: bool,
        text: String,
    },
    /// Headings, blank lines, free text — round-tripped unchanged.
    Raw(String),
}

/// Parse a checklist line into (prefix, done, text), matching `TASK_RE` in
/// `todo.ts`: `^(\s*[-*]\s+)\[([ xX])\]\s?(.*)$`.
fn parse_task(line: &str) -> Option<(String, bool, String)> {
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
    Some((prefix.to_string(), done, text.to_string()))
}

fn parse(text: &str) -> Vec<Line> {
    text.split('\n')
        .map(|raw| {
            let line = raw.strip_suffix('\r').unwrap_or(raw); // tolerate CRLF
            match parse_task(line) {
                Some((prefix, done, text)) => Line::Task { prefix, done, text },
                None => Line::Raw(line.to_string()),
            }
        })
        .collect()
}

/// Serialize back to Markdown (without a trailing newline; the writer adds one).
fn serialize(lines: &[Line]) -> String {
    lines
        .iter()
        .map(|l| match l {
            Line::Task { prefix, done, text } => {
                format!("{prefix}[{}] {text}", if *done { 'x' } else { ' ' })
            }
            Line::Raw(text) => text.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n")
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

/// Parse the numeric arguments for done/undone/rm. All must be valid 1-based
/// task numbers within range; returns their line indices (deduped) or an error
/// so a bad number aborts the whole command rather than applying it partially.
fn resolve_numbers(args: &[String], task_lines: &[usize]) -> Result<Vec<usize>, String> {
    if args.is_empty() {
        return Err("expected one or more task numbers".to_string());
    }
    let mut out = Vec::new();
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
        let idx = task_lines[n - 1];
        if !out.contains(&idx) {
            out.push(idx);
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
            let text = rest
                .iter()
                .filter(|a| !a.starts_with("--"))
                .cloned()
                .collect::<Vec<_>>()
                .join(" ");
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
            });
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            let n = task_line_indices(&lines).len();
            println!("added #{n}: {text}");
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
            for &idx in &targets {
                if let Line::Task { done: d, .. } = &mut lines[idx] {
                    *d = done;
                }
            }
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            let verb = if done { "done" } else { "reopened" };
            for &idx in &targets {
                let n = task_lines.iter().position(|&x| x == idx).unwrap() + 1;
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
                .map(|&idx| {
                    let n = task_lines.iter().position(|&x| x == idx).unwrap() + 1;
                    (n, task_text(&lines[idx]).to_string())
                })
                .collect();
            targets.sort_unstable_by(|a, b| b.cmp(a));
            for idx in targets {
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
            let mut lines = load(&path);
            let before = task_line_indices(&lines).len();
            if before == 0 {
                println!("no todos to clear");
                return 0;
            }
            lines.retain(|l| !matches!(l, Line::Task { .. }));
            if let Err(e) = save(&path, &lines) {
                eprintln!("{e}");
                return 1;
            }
            println!("cleared {before} todo{}", if before == 1 { "" } else { "s" });
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
    let tasks: Vec<(usize, &bool, &str)> = lines
        .iter()
        .filter_map(|l| match l {
            Line::Task { done, text, .. } => Some((0, done, text.as_str())),
            Line::Raw(_) => None,
        })
        .enumerate()
        .map(|(i, (_, d, t))| (i + 1, d, t))
        .collect();

    if json {
        let items: Vec<String> = tasks
            .iter()
            .map(|(n, done, text)| {
                format!(
                    r#"{{"n":{n},"done":{},"text":{}}}"#,
                    done,
                    json_string(text)
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
    for (n, done, text) in tasks {
        println!("{n}. [{}] {text}", if *done { 'x' } else { ' ' });
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
         \x20 pike todo done <n...>         mark task(s) done\n\
         \x20 pike todo undone <n...>       mark task(s) not done\n\
         \x20 pike todo rm <n...>           remove task(s)\n\
         \x20 pike todo clear               remove all tasks (keep headings/notes)\n\
         \n\
         Numbers refer to the positions shown by `pike todo list`."
    );
}

/// Attach to the parent process's console so a GUI-subsystem build
/// (`windows_subsystem = \"windows\"` in release) can print to the terminal it
/// was launched from. Fails harmlessly when already attached (inherited handles
/// from a ConPTY, or the debug console build).
#[cfg(windows)]
fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
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
            Ok(vec![0, 2])
        );
        assert!(resolve_numbers(&["0".into()], &tl).is_err());
        assert!(resolve_numbers(&["4".into()], &tl).is_err());
        assert!(resolve_numbers(&["x".into()], &tl).is_err());
        assert!(resolve_numbers(&[], &tl).is_err());
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
                    text: "a".into()
                },
                Line::Task {
                    prefix: "- ".into(),
                    done: true,
                    text: "b".into()
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
