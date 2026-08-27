//! On-demand diagnostics harvesting.
//!
//! Pike does not run resident language servers (see CLAUDE.md "軽さ最優先").
//! Instead, for each detected toolchain we run its CLI checker once on demand,
//! parse the structured output, and normalize it into [`Diagnostic`]s:
//!
//! - Rust  — `cargo check --message-format=json` (JSON Lines on stdout)
//! - Go    — `go vet ./...` (text on stderr)
//! - Go    — `golangci-lint run ./...` (text on stdout), opt-in — see below
//! - TS/JS — `tsc --noEmit --pretty false` (text on stdout)
//!
//! Commands run in the directory of the manifest that triggered them, so the
//! file paths in their output resolve relative to that directory.
//!
//! golangci-lint is detected from the project (a `.golangci.*` config or a
//! go.mod that names it) but only runs when the caller asks for it: it type
//! checks the whole module on top of dozens of linters, which is too heavy for
//! the panel's automatic refresh.

use crate::types::ShellConfig;
use serde::Serialize;
use std::time::Duration;

/// How deep to search for manifest files (Cargo.toml / go.mod / tsconfig.json).
const MAX_DEPTH: u32 = 4;
/// Per-provider command timeout. Cold `cargo check` / `tsc` can be slow.
const TIMEOUT_SECS: u64 = 180;
/// Cap the payload so a pathological project can't flood the UI.
const MAX_DIAGNOSTICS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// Root-relative when inside the project, otherwise absolute.
    pub file: String,
    /// 1-based.
    pub line: u32,
    pub column: u32,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub severity: Severity,
    pub message: String,
    /// Tool that produced it: "rustc" | "go vet" | "golangci-lint" | "tsc"
    pub source: String,
    /// Diagnostic code when available ("E0382", "TS2304", the linter name, ...).
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRun {
    /// "rust" | "go" | "golangci" | "ts"
    pub name: String,
    /// Root-relative directory the checker ran in.
    pub dir: String,
    /// The command line that ran. Shown when a checker fails: with a
    /// project-configured override in play, "checker failed" alone doesn't say
    /// what was actually invoked.
    pub command: String,
    pub ok: bool,
    pub error: Option<String>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsResult {
    pub diagnostics: Vec<Diagnostic>,
    pub providers: Vec<ProviderRun>,
    pub truncated: bool,
    /// The project has at least one Go module set up for golangci-lint, so the
    /// UI can offer the toggle. Reported whether or not it actually ran.
    pub golangci_available: bool,
}

struct ProviderSpec {
    name: &'static str,
    manifest: &'static str,
    source: &'static str,
    /// The manifest doesn't imply the checker's binary is installed, so a
    /// nonzero exit with nothing parsed means it never ran — report that
    /// instead of "no problems". The manifest-implied checkers stay `false`:
    /// they share the blind spot, but flipping them would change what existing
    /// Rust and TS projects see.
    optional_binary: bool,
}

const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        name: "rust",
        manifest: "Cargo.toml",
        source: "rustc",
        optional_binary: false,
    },
    ProviderSpec {
        name: "go",
        manifest: "go.mod",
        source: "go vet",
        optional_binary: false,
    },
    ProviderSpec {
        name: "ts",
        manifest: "tsconfig.json",
        source: "tsc",
        optional_binary: false,
    },
];

/// Opt-in extra checker for Go modules. Not in [`PROVIDERS`] because its
/// directories are a subset of go's and it only runs on request.
static GOLANGCI: ProviderSpec = ProviderSpec {
    name: "golangci",
    manifest: "go.mod",
    source: "golangci-lint",
    optional_binary: true,
};

/// golangci-lint's own config file names, in its discovery order. Finding one
/// is the primary signal that a module is meant to be linted with it.
const GOLANGCI_CONFIGS: &[&str] = &[
    ".golangci.yml",
    ".golangci.yaml",
    ".golangci.toml",
    ".golangci.json",
];

/// Run the linter through `go tool` when go.mod pins it (Go 1.24 `tool`
/// directive), otherwise expect the binary on PATH.
const GOLANGCI_TOOL_CMD: &str = "go tool golangci-lint run ./...";
const GOLANGCI_PATH_CMD: &str = "golangci-lint run ./...";

/// The checker command line for a provider in `dir`. Most are fixed; `ts` is
/// resolved per-dir (vue-tsc vs tsc) — see [`ts_command`]. golangci's command
/// comes from [`golangci_tasks`], which already had to read go.mod.
fn command_for(name: &str, shell: &ShellConfig, dir: &str) -> &'static str {
    match name {
        "rust" => "cargo check --message-format=json -q",
        "go" => "go vet ./...",
        "ts" => ts_command(shell, dir),
        _ => "",
    }
}

/// TypeScript checker command for `dir`. Prefers `vue-tsc` when the project has
/// it installed (plain `tsc` floods Vue projects with bogus `.vue` import
/// errors), otherwise falls back to `tsc`. Both run through `npx --no-install`.
fn ts_command(shell: &ShellConfig, dir: &str) -> &'static str {
    let has_vue_tsc = match shell {
        ShellConfig::Wsl { .. } => shell
            .run_shell_line(dir, "test -e node_modules/.bin/vue-tsc", Duration::from_secs(10))
            .map(|(code, _, _)| code == 0)
            .unwrap_or(false),
        _ => {
            let sep = std::path::MAIN_SEPARATOR;
            // npm が置くシムの名前は OS で違う。Windows は `.cmd` のバッチ、
            // macOS / Linux は拡張子なしの shebang スクリプト。`.cmd` 決め打ちだと
            // macOS では**必ず見つからず**、Vue プロジェクトが黙って素の tsc で
            // 検査されて `.vue` の import が大量に誤検出される。
            let name = if cfg!(windows) { "vue-tsc.cmd" } else { "vue-tsc" };
            std::path::Path::new(&format!("{dir}{sep}node_modules{sep}.bin{sep}{name}")).exists()
        }
    };
    if has_vue_tsc {
        "npx --no-install vue-tsc --noEmit --pretty false"
    } else {
        "npx --no-install tsc --noEmit --pretty false"
    }
}

#[tauri::command]
pub async fn diagnostics_run(
    shell: ShellConfig,
    root: String,
    golangci: bool,
    golangci_command: Option<String>,
) -> Result<DiagnosticsResult, String> {
    tokio::task::spawn_blocking(move || run(&shell, &root, golangci, golangci_command.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// Max checkers to run at once. Each is a heavy subprocess (cargo/tsc are
/// themselves parallel), so a small cap avoids thrashing on big monorepos.
const MAX_CONCURRENCY: usize = 4;

/// One checker to run.
struct Task<'a> {
    spec: &'a ProviderSpec,
    dir: String,
    /// Set when the command was already settled (golangci, whose choice fell out
    /// of the go.mod read or the project's override). `None` resolves it in the
    /// worker instead: `ts` has to probe its directory for vue-tsc, and settling
    /// that here would serialize what is otherwise one probe per concurrent
    /// checker.
    command: Option<String>,
}

fn run(
    shell: &ShellConfig,
    root: &str,
    golangci: bool,
    golangci_command: Option<&str>,
) -> DiagnosticsResult {
    let sep = if root.contains('/') || matches!(shell, ShellConfig::Wsl { .. }) {
        '/'
    } else {
        '\\'
    };
    let names: Vec<&str> = PROVIDERS
        .iter()
        .map(|p| p.manifest)
        .chain(GOLANGCI_CONFIGS.iter().copied())
        .collect();
    let manifests = crate::fs::walk_files_by_name(shell, root, &names, MAX_DEPTH);

    // Flatten to independent tasks, then run them concurrently (bounded).
    // Checkers don't share state, so order doesn't matter.
    let mut tasks: Vec<Task> = PROVIDERS
        .iter()
        .flat_map(|spec| {
            dirs_for(&manifests, spec.manifest, root, sep)
                .into_iter()
                .map(move |dir| Task { spec, dir, command: None })
        })
        .collect();

    // Detect golangci-lint on every run so the UI can offer the toggle, but
    // only queue it when asked — it is far heavier than the other checkers.
    let golangci_dirs = golangci_tasks(shell, &manifests, root, sep, golangci_command);
    let golangci_available = !golangci_dirs.is_empty();
    if golangci {
        tasks.extend(golangci_dirs.into_iter().map(|(dir, command)| Task {
            spec: &GOLANGCI,
            dir,
            command: Some(command),
        }));
    }

    let mut diagnostics = Vec::new();
    let mut providers = Vec::new();
    let timeout = Duration::from_secs(TIMEOUT_SECS);

    for chunk in tasks.chunks(MAX_CONCURRENCY) {
        std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|task| s.spawn(move || run_one(shell, task, root, sep, timeout)))
                .collect();
            for handle in handles {
                if let Ok((provider, mut parsed)) = handle.join() {
                    providers.push(provider);
                    diagnostics.append(&mut parsed);
                }
            }
        });
    }

    dedup(&mut diagnostics);
    let truncated = diagnostics.len() > MAX_DIAGNOSTICS;
    if truncated {
        diagnostics.truncate(MAX_DIAGNOSTICS);
    }

    DiagnosticsResult {
        diagnostics,
        providers,
        truncated,
        golangci_available,
    }
}

/// Run one checker in one directory and parse its output. Always returns a
/// `ProviderRun` (ok or error) plus any diagnostics found.
fn run_one(
    shell: &ShellConfig,
    task: &Task,
    root: &str,
    sep: char,
    timeout: Duration,
) -> (ProviderRun, Vec<Diagnostic>) {
    let Task { spec, dir, command } = task;
    let dir_rel = rel_path(dir, root, sep);
    let command = command
        .as_deref()
        .unwrap_or_else(|| command_for(spec.name, shell, dir));
    match shell.run_shell_line(dir, command, timeout) {
        Ok((code, stdout, stderr)) => {
            let parsed = parse(spec.name, &stdout, &stderr, dir, root, sep, spec.source);
            // A checker whose binary isn't implied by the manifest exits nonzero
            // both when it finds issues and when it never ran; only the latter
            // leaves nothing parsed. Without this, a missing install would show
            // up as "no problems".
            let error = if spec.optional_binary && code != 0 && parsed.is_empty() {
                first_line(&stderr)
            } else {
                None
            };
            let run = ProviderRun {
                name: spec.name.to_string(),
                dir: dir_rel,
                command: command.to_string(),
                ok: error.is_none(),
                error,
                count: parsed.len(),
            };
            (run, parsed)
        }
        Err(e) => (
            ProviderRun {
                name: spec.name.to_string(),
                dir: dir_rel,
                command: command.to_string(),
                ok: false,
                error: Some(e),
                count: 0,
            },
            vec![],
        ),
    }
}

/// First non-empty line of `text`, clipped so a runaway error can't bloat the
/// payload. `None` when there is nothing to report.
fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(200).collect())
}

/// Case-insensitive basename match, for paths in either separator style.
fn file_name_eq(path: &str, name: &str) -> bool {
    path.rsplit(['/', '\\'])
        .next()
        .map(|f| f.eq_ignore_ascii_case(name))
        .unwrap_or(false)
}

/// Go module dirs set up for golangci-lint, each paired with its command line.
/// A module qualifies when a `.golangci.*` config sits at or above it
/// (golangci-lint's own discovery walks up) or when its go.mod names the linter.
///
/// Without an override this costs one extra batched read per run for Go
/// projects, since the answer can depend on go.mod even when the linter is
/// switched off. That's one wsl.exe round trip next to checkers taking seconds.
fn golangci_tasks(
    shell: &ShellConfig,
    manifests: &[String],
    root: &str,
    sep: char,
    override_command: Option<&str>,
) -> Vec<(String, String)> {
    let go_dirs = dirs_for(manifests, GOLANGCI.manifest, root, sep);
    if go_dirs.is_empty() {
        return vec![];
    }
    // A configured command is its own opt-in: the project has said how it lints,
    // so there is nothing to detect and no reason to read go.mod.
    //
    // It also names ONE entry point, unlike the per-module detection below. Run
    // it once, in the shallowest module dir: fanning it out over sibling modules
    // would run the same (often containerized) command N times and resolve each
    // copy of a finding against a different base, which `dedup` cannot collapse.
    // `min_by_key` keeps the first minimum and `dirs_for` sorted the list, so a
    // tie goes to the lexically first module.
    if let Some(command) = override_command.map(str::trim).filter(|c| !c.is_empty()) {
        return go_dirs
            .into_iter()
            .min_by_key(|d| d.matches(sep).count())
            .map(|dir| (dir, command.to_string()))
            .into_iter()
            .collect();
    }
    let config_dirs: Vec<String> = manifests
        .iter()
        .filter(|p| GOLANGCI_CONFIGS.iter().any(|n| file_name_eq(p, n)))
        .map(|p| parent_dir(p, root, sep))
        .collect();
    // One batched read for all modules. go.mod answers both questions at once:
    // is the linter wired up, and how to run it.
    let paths: Vec<String> = go_dirs
        .iter()
        .map(|d| format!("{d}{sep}{}", GOLANGCI.manifest))
        .collect();
    let contents = crate::fs::batch_read_files(shell, root, &sep.to_string(), &paths);

    go_dirs
        .iter()
        .zip(contents)
        .filter_map(|(dir, src)| {
            let from_go_mod = src.as_deref().and_then(go_mod_golangci);
            let has_config = config_dirs.iter().any(|c| is_at_or_under(dir, c, sep));
            let command = from_go_mod.or_else(|| has_config.then_some(GOLANGCI_PATH_CMD))?;
            Some((dir.clone(), command.to_string()))
        })
        .collect()
}

/// The golangci-lint command a go.mod calls for, or `None` when it doesn't
/// mention the linter at all. Understands both the bare `tool` directive and
/// the parenthesised block form; anything else naming the linter is a
/// tools.go-style `require`, which expects the binary on PATH.
fn go_mod_golangci(src: &str) -> Option<&'static str> {
    const NEEDLE: &str = "github.com/golangci/golangci-lint";
    let mut in_tool_block = false;
    let mut found = None;
    for raw in src.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if line == ")" {
            in_tool_block = false;
        } else if let Some(rest) = tool_directive(line) {
            if rest == "(" {
                in_tool_block = true;
            } else if rest.contains(NEEDLE) {
                return Some(GOLANGCI_TOOL_CMD);
            }
        } else if line.contains(NEEDLE) {
            if in_tool_block {
                return Some(GOLANGCI_TOOL_CMD);
            }
            found = Some(GOLANGCI_PATH_CMD);
        }
    }
    found
}

/// `line` minus a leading `tool` keyword, but only when the keyword stands
/// alone (so a module path like `toolbox/x` isn't read as a directive).
fn tool_directive(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("tool")?;
    (rest.is_empty() || rest.starts_with([' ', '\t', '('])).then(|| rest.trim())
}

/// Is `dir` the same directory as `ancestor`, or nested under it?
fn is_at_or_under(dir: &str, ancestor: &str, sep: char) -> bool {
    dir == ancestor
        || dir
            .strip_prefix(ancestor)
            .is_some_and(|rest| rest.starts_with(sep))
}

/// Directories (absolute) where `manifest` was found, collapsing nested
/// occurrences (a workspace/monorepo runs its checker once at the top).
fn dirs_for(manifests: &[String], manifest: &str, root: &str, sep: char) -> Vec<String> {
    let mut dirs: Vec<String> = manifests
        .iter()
        .filter(|p| file_name_eq(p, manifest))
        .map(|p| parent_dir(p, root, sep))
        .collect();
    dirs.sort();
    dirs.dedup();
    // Drop any dir whose ancestor is also present.
    let kept: Vec<String> = dirs
        .iter()
        .filter(|d| {
            !dirs
                .iter()
                .any(|other| other.len() < d.len() && is_at_or_under(d, other, sep))
        })
        .cloned()
        .collect();
    kept
}

fn parent_dir(path: &str, root: &str, sep: char) -> String {
    match path.rsplit_once(['/', '\\']) {
        Some((dir, _)) if !dir.is_empty() => dir.to_string(),
        _ => root.trim_end_matches([sep]).to_string(),
    }
}

fn rel_path(path: &str, root: &str, sep: char) -> String {
    if path == root {
        return String::new();
    }
    let prefix = format!("{root}{sep}");
    path.strip_prefix(&prefix).unwrap_or(path).to_string()
}

fn dedup(diags: &mut Vec<Diagnostic>) {
    let mut seen = std::collections::HashSet::new();
    diags.retain(|d| {
        seen.insert((d.file.clone(), d.line, d.column, d.severity, d.message.clone()))
    });
}

fn parse(
    provider: &str,
    stdout: &str,
    stderr: &str,
    dir: &str,
    root: &str,
    sep: char,
    source: &str,
) -> Vec<Diagnostic> {
    match provider {
        "rust" => parse_cargo(stdout, dir, root, sep, source),
        "go" => parse_go(stderr, dir, root, sep, source),
        "golangci" => parse_golangci(stdout, dir, root, sep, source),
        "ts" => parse_tsc(stdout, dir, root, sep, source),
        _ => vec![],
    }
}

/// Rewrite every `/` or `\` in `s` to `sep` (no per-call separator allocation).
fn normalize_sep(s: &str, sep: char) -> String {
    s.chars().map(|c| if c == '/' || c == '\\' { sep } else { c }).collect()
}

/// Resolve a checker-relative path to root-relative (or absolute when outside).
fn resolve(file: &str, dir: &str, root: &str, sep: char) -> String {
    let normalized = normalize_sep(file, sep);
    let full = if file.starts_with('/') || file.chars().nth(1) == Some(':') {
        normalized
    } else {
        format!("{dir}{sep}{normalized}")
    };
    rel_path(&full, root, sep)
}

fn parse_cargo(stdout: &str, dir: &str, root: &str, sep: char, source: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
            continue;
        }
        let Some(msg) = v.get("message") else { continue };
        let level = msg.get("level").and_then(|l| l.as_str()).unwrap_or("");
        let severity = match level {
            "error" | "error: internal compiler error" => Severity::Error,
            "warning" => Severity::Warning,
            _ => continue,
        };
        let text = msg.get("message").and_then(|m| m.as_str()).unwrap_or("");
        let code = msg
            .get("code")
            .and_then(|c| c.get("code"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());
        let Some(spans) = msg.get("spans").and_then(|s| s.as_array()) else {
            continue;
        };
        let span = spans
            .iter()
            .find(|s| s.get("is_primary").and_then(|p| p.as_bool()) == Some(true))
            .or_else(|| spans.first());
        let Some(span) = span else { continue };
        let file = span.get("file_name").and_then(|f| f.as_str()).unwrap_or("");
        if file.is_empty() {
            continue;
        }
        out.push(Diagnostic {
            file: resolve(file, dir, root, sep),
            line: span.get("line_start").and_then(|l| l.as_u64()).unwrap_or(1) as u32,
            column: span.get("column_start").and_then(|c| c.as_u64()).unwrap_or(1) as u32,
            end_line: span.get("line_end").and_then(|l| l.as_u64()).map(|n| n as u32),
            end_column: span.get("column_end").and_then(|c| c.as_u64()).map(|n| n as u32),
            severity,
            message: text.to_string(),
            source: source.to_string(),
            code,
        });
    }
    out
}

/// Split a `path:line[:col]: message` line — the shape go vet and golangci-lint
/// both emit — into its parts.
fn split_location(line: &str) -> Option<(&str, u32, u32, &str)> {
    // Location ends at the first ": " after the position.
    let (loc, message) = line.split_once(": ")?;
    // loc = path:line[:col] — take the last two colon-separated numeric parts.
    // Anything else (a Windows drive letter, colons in the path) stays in `file`.
    let parts: Vec<&str> = loc.rsplitn(3, ':').collect();
    match parts.as_slice() {
        [col, lineno, file] => Some((file, lineno.parse().ok()?, col.parse().ok()?, message)),
        [lineno, file] => Some((file, lineno.parse().ok()?, 1, message)),
        _ => None,
    }
}

/// go vet: `path:line:col: message` (col optional). Header lines start with `#`.
fn parse_go(stderr: &str, dir: &str, root: &str, sep: char, source: &str) -> Vec<Diagnostic> {
    stderr
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|line| {
            let (file, lineno, col, message) = split_location(line.trim_end())?;
            Some(Diagnostic {
                file: resolve(file, dir, root, sep),
                line: lineno,
                column: col,
                end_line: None,
                end_column: None,
                severity: Severity::Warning,
                message: message.trim().to_string(),
                source: source.to_string(),
                code: None,
            })
        })
        .collect()
}

/// golangci-lint: `path:line:col: message (linter)` on stdout.
///
/// We parse the default text format because the JSON flag was renamed between
/// v1 and v2 and an unknown flag aborts the whole run. Colors are off since our
/// stdout is a pipe.
///
/// v1 also echoes the offending source line and a caret under it. Those are
/// indented while a finding always starts with its path, so the leading-space
/// test drops them — needed because a source line holding something like
/// `"a:1:2: x"` would otherwise parse as a location.
fn parse_golangci(stdout: &str, dir: &str, root: &str, sep: char, source: &str) -> Vec<Diagnostic> {
    stdout
        .lines()
        .filter(|l| !l.starts_with([' ', '\t']))
        .filter_map(|line| {
            let (file, lineno, col, message) = split_location(line.trim_end())?;
            let (message, linter) = split_linter(message.trim());
            Some(Diagnostic {
                file: resolve(file, dir, root, sep),
                line: lineno,
                column: col,
                end_line: None,
                end_column: None,
                // typecheck findings are compile errors, not style nits.
                severity: if linter.as_deref() == Some("typecheck") {
                    Severity::Error
                } else {
                    Severity::Warning
                },
                message,
                source: source.to_string(),
                code: linter,
            })
        })
        .collect()
}

/// Peel the trailing `(linter)` marker off a golangci-lint message.
fn split_linter(message: &str) -> (String, Option<String>) {
    let name = message
        .strip_suffix(')')
        .and_then(|rest| rest.rsplit_once('(').filter(|(_, name)| is_linter_name(name)));
    match name {
        Some((head, name)) => (head.trim_end().to_string(), Some(name.to_string())),
        None => (message.to_string(), None),
    }
}

/// Linter names are plain identifiers; anything else is part of the message.
fn is_linter_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// tsc --pretty false: `path(line,col): severity TScode: message`.
fn parse_tsc(stdout: &str, dir: &str, root: &str, sep: char, source: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let Some(paren) = line.find('(') else { continue };
        let Some(close) = line[paren..].find(')').map(|i| i + paren) else {
            continue;
        };
        let file = &line[..paren];
        let pos = &line[paren + 1..close];
        let Some((lineno, col)) = pos.split_once(',') else {
            continue;
        };
        let (Ok(lineno), Ok(col)) = (lineno.trim().parse::<u32>(), col.trim().parse::<u32>())
        else {
            continue;
        };
        // remainder: "): error TS2304: message"
        let rest = line[close + 1..].trim_start_matches(':').trim();
        let (severity, after) = if let Some(r) = rest.strip_prefix("error") {
            (Severity::Error, r.trim())
        } else if let Some(r) = rest.strip_prefix("warning") {
            (Severity::Warning, r.trim())
        } else {
            continue;
        };
        // after: "TS2304: message"
        let (code, message) = match after.split_once(": ") {
            Some((c, m)) => (Some(c.trim().to_string()), m.to_string()),
            None => (None, after.to_string()),
        };
        out.push(Diagnostic {
            file: resolve(file, dir, root, sep),
            line: lineno,
            column: col,
            end_line: None,
            end_column: None,
            severity,
            message,
            source: source.to_string(),
            code,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_warning_with_code_and_span() {
        let line = r#"{"reason":"compiler-message","message":{"message":"unused variable: `x`","code":{"code":"unused_variables"},"level":"warning","spans":[{"file_name":"src/main.rs","line_start":2,"line_end":2,"column_start":9,"column_end":10,"is_primary":true}]}}"#;
        let d = parse_cargo(line, "/proj/crate", "/proj", '/', "rustc");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].file, "crate/src/main.rs");
        assert_eq!(d[0].line, 2);
        assert_eq!(d[0].column, 9);
        assert_eq!(d[0].severity, Severity::Warning);
        assert_eq!(d[0].code.as_deref(), Some("unused_variables"));
    }

    #[test]
    fn cargo_skips_non_compiler_and_notes() {
        let stdout = concat!(
            r#"{"reason":"build-finished","success":true}"#,
            "\n",
            r#"{"reason":"compiler-message","message":{"message":"note text","level":"note","spans":[]}}"#,
        );
        assert!(parse_cargo(stdout, "/p", "/p", '/', "rustc").is_empty());
    }

    #[test]
    fn go_vet_line_with_column() {
        let stderr = "# example.com/m\nmain.go:10:2: result of fmt.Sprintf call not used\n";
        let d = parse_go(stderr, "/proj", "/proj", '/', "go vet");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].file, "main.go");
        assert_eq!(d[0].line, 10);
        assert_eq!(d[0].column, 2);
        assert_eq!(d[0].severity, Severity::Warning);
        assert_eq!(d[0].message, "result of fmt.Sprintf call not used");
    }

    #[test]
    fn go_vet_line_without_column() {
        let d = parse_go("sub/x.go:42: bad\n", "/proj", "/proj", '/', "go vet");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].file, "sub/x.go");
        assert_eq!(d[0].line, 42);
        assert_eq!(d[0].column, 1);
    }

    #[test]
    fn golangci_line_carries_linter_as_code() {
        let stdout = "internal/a.go:5:1: exported func Foo should have comment (revive)\n";
        let d = parse_golangci(stdout, "/proj", "/proj", '/', "golangci-lint");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].file, "internal/a.go");
        assert_eq!(d[0].line, 5);
        assert_eq!(d[0].column, 1);
        assert_eq!(d[0].code.as_deref(), Some("revive"));
        assert_eq!(d[0].message, "exported func Foo should have comment");
        assert_eq!(d[0].severity, Severity::Warning);
    }

    #[test]
    fn golangci_typecheck_is_an_error() {
        let d = parse_golangci(
            "main.go:3:2: declared and not used: x (typecheck)\n",
            "/proj",
            "/proj",
            '/',
            "golangci-lint",
        );
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].severity, Severity::Error);
    }

    #[test]
    fn golangci_skips_echoed_source_lines() {
        // v1 prints the offending line plus a caret under each issue.
        let stdout = "main.go:3:2: bad (govet)\n\tx := fmt.Sprintf(\"a:1:2: hi\")\n\t^\n";
        let d = parse_golangci(stdout, "/proj", "/proj", '/', "golangci-lint");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].message, "bad");
    }

    #[test]
    fn golangci_message_ending_in_parens_keeps_its_text() {
        let d = parse_golangci(
            "main.go:1:1: unused parameter (or is it?) (revive)\n",
            "/p",
            "/p",
            '/',
            "golangci-lint",
        );
        assert_eq!(d[0].message, "unused parameter (or is it?)");
        assert_eq!(d[0].code.as_deref(), Some("revive"));
    }

    #[test]
    fn go_mod_tool_directive_wins_over_require() {
        let src = concat!(
            "module example.com/m\n\n",
            "require (\n\tgithub.com/golangci/golangci-lint/v2 v2.1.0 // indirect\n)\n\n",
            "tool (\n\tgithub.com/golangci/golangci-lint/v2/cmd/golangci-lint\n)\n",
        );
        assert_eq!(go_mod_golangci(src), Some(GOLANGCI_TOOL_CMD));
    }

    #[test]
    fn go_mod_bare_tool_directive() {
        let src = "module m\ntool github.com/golangci/golangci-lint/v2/cmd/golangci-lint\n";
        assert_eq!(go_mod_golangci(src), Some(GOLANGCI_TOOL_CMD));
    }

    #[test]
    fn go_mod_require_only() {
        let src = "module m\n\nrequire (\n\tgithub.com/golangci/golangci-lint v1.64.5\n)\n";
        assert_eq!(go_mod_golangci(src), Some(GOLANGCI_PATH_CMD));
    }

    #[test]
    fn go_mod_without_golangci() {
        let src = "module m\n\ngo 1.24\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n";
        assert_eq!(go_mod_golangci(src), None);
    }

    #[test]
    fn go_mod_ignores_lookalike_module_names() {
        // `toolbox/...` must not be read as a `tool` directive.
        let src = "module m\n\nrequire (\n\ttoolbox/github.com/golangci/golangci-lint v1.0.0\n)\n";
        assert_eq!(go_mod_golangci(src), Some(GOLANGCI_PATH_CMD));
    }

    #[test]
    fn tsc_error_line() {
        let stdout = "src/app.ts(12,5): error TS2304: Cannot find name 'foo'.\n";
        let d = parse_tsc(stdout, "/proj", "/proj", '/', "tsc");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].file, "src/app.ts");
        assert_eq!(d[0].line, 12);
        assert_eq!(d[0].column, 5);
        assert_eq!(d[0].severity, Severity::Error);
        assert_eq!(d[0].code.as_deref(), Some("TS2304"));
        assert_eq!(d[0].message, "Cannot find name 'foo'.");
    }

    #[test]
    fn tsc_ignores_non_location_lines() {
        assert!(parse_tsc("Found 1 error.\n", "/p", "/p", '/', "tsc").is_empty());
    }

    #[test]
    fn dedup_collapses_identical() {
        let mut v = vec![
            Diagnostic {
                file: "a.rs".into(),
                line: 1,
                column: 1,
                end_line: None,
                end_column: None,
                severity: Severity::Warning,
                message: "m".into(),
                source: "rustc".into(),
                code: None,
            },
            Diagnostic {
                file: "a.rs".into(),
                line: 1,
                column: 1,
                end_line: None,
                end_column: None,
                severity: Severity::Warning,
                message: "m".into(),
                source: "rustc".into(),
                code: None,
            },
        ];
        dedup(&mut v);
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn golangci_override_runs_once_at_the_shallowest_module() {
        // Sibling modules survive `dirs_for`, but one configured command means
        // one entry point — running it per module would duplicate every finding
        // under a different base path.
        let manifests = vec![
            "/proj/services/b/go.mod".to_string(),
            "/proj/services/a/go.mod".to_string(),
            "/proj/tools/go.mod".to_string(),
        ];
        let shell = ShellConfig::Powershell;
        let tasks = golangci_tasks(&shell, &manifests, "/proj", '/', Some("  make lint  "));
        assert_eq!(
            tasks,
            vec![("/proj/tools".to_string(), "make lint".to_string())]
        );
    }

    #[test]
    fn golangci_blank_override_falls_back_to_detection() {
        let manifests = vec!["/proj/go.mod".to_string()];
        let shell = ShellConfig::Powershell;
        // No config and an unreadable go.mod: nothing qualifies, so a blank
        // override must not stand in as an opt-in.
        assert!(golangci_tasks(&shell, &manifests, "/proj", '/', Some("   ")).is_empty());
    }

    #[test]
    fn dirs_for_collapses_nested() {
        let manifests = vec![
            "/proj/Cargo.toml".to_string(),
            "/proj/crates/a/Cargo.toml".to_string(),
        ];
        let dirs = dirs_for(&manifests, "Cargo.toml", "/proj", '/');
        assert_eq!(dirs, vec!["/proj".to_string()]);
    }
}
