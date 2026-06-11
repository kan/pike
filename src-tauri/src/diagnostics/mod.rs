//! On-demand diagnostics harvesting.
//!
//! Pike does not run resident language servers (see CLAUDE.md "軽さ最優先").
//! Instead, for each detected toolchain we run its CLI checker once on demand,
//! parse the structured output, and normalize it into [`Diagnostic`]s:
//!
//! - Rust  — `cargo check --message-format=json` (JSON Lines on stdout)
//! - Go    — `go vet ./...` (text on stderr)
//! - TS/JS — `tsc --noEmit --pretty false` (text on stdout)
//!
//! Commands run in the directory of the manifest that triggered them, so the
//! file paths in their output resolve relative to that directory.

use crate::fs::IGNORED_DIRS;
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
    /// Tool that produced it: "rustc" | "go vet" | "tsc"
    pub source: String,
    /// Diagnostic code when available ("E0382", "TS2304", ...).
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRun {
    /// "rust" | "go" | "ts"
    pub name: String,
    /// Root-relative directory the checker ran in.
    pub dir: String,
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
}

struct ProviderSpec {
    name: &'static str,
    manifest: &'static str,
    source: &'static str,
}

const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        name: "rust",
        manifest: "Cargo.toml",
        source: "rustc",
    },
    ProviderSpec {
        name: "go",
        manifest: "go.mod",
        source: "go vet",
    },
    ProviderSpec {
        name: "ts",
        manifest: "tsconfig.json",
        source: "tsc",
    },
];

/// The checker command line for a provider in `dir`. Most are fixed; `ts` is
/// resolved per-dir (vue-tsc vs tsc) — see [`ts_command`].
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
            std::path::Path::new(&format!("{dir}{sep}node_modules{sep}.bin{sep}vue-tsc.cmd")).exists()
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
) -> Result<DiagnosticsResult, String> {
    tokio::task::spawn_blocking(move || run(&shell, &root))
        .await
        .map_err(|e| e.to_string())
}

fn run(shell: &ShellConfig, root: &str) -> DiagnosticsResult {
    let sep = if root.contains('/') || matches!(shell, ShellConfig::Wsl { .. }) {
        '/'
    } else {
        '\\'
    };
    let manifests = find_manifests(shell, root);

    let mut diagnostics = Vec::new();
    let mut providers = Vec::new();
    let timeout = Duration::from_secs(TIMEOUT_SECS);

    for spec in PROVIDERS {
        let dirs = dirs_for(&manifests, spec.manifest, root, sep);
        for dir in dirs {
            let dir_rel = rel_path(&dir, root, sep);
            let command = command_for(spec.name, shell, &dir);
            match shell.run_shell_line(&dir, command, timeout) {
                Ok((_code, stdout, stderr)) => {
                    let parsed = parse(spec.name, &stdout, &stderr, &dir, root, sep, spec.source);
                    providers.push(ProviderRun {
                        name: spec.name.to_string(),
                        dir: dir_rel,
                        ok: true,
                        error: None,
                        count: parsed.len(),
                    });
                    diagnostics.extend(parsed);
                }
                Err(e) => providers.push(ProviderRun {
                    name: spec.name.to_string(),
                    dir: dir_rel,
                    ok: false,
                    error: Some(e),
                    count: 0,
                }),
            }
        }
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
    }
}

/// Directories (absolute) where `manifest` was found, collapsing nested
/// occurrences (a workspace/monorepo runs its checker once at the top).
fn dirs_for(manifests: &[String], manifest: &str, root: &str, sep: char) -> Vec<String> {
    let mut dirs: Vec<String> = manifests
        .iter()
        .filter(|p| {
            p.rsplit(['/', '\\'])
                .next()
                .map(|f| f.eq_ignore_ascii_case(manifest))
                .unwrap_or(false)
        })
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
                .any(|other| other.len() < d.len() && d.starts_with(&format!("{other}{sep}")))
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

/// go vet: `path:line:col: message` (col optional). Header lines start with `#`.
fn parse_go(stderr: &str, dir: &str, root: &str, sep: char, source: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Split location from message at the first ": " after the position.
        let Some((loc, message)) = line.split_once(": ") else {
            continue;
        };
        // loc = path:line[:col]  — take the last two colon-separated numeric parts.
        let parts: Vec<&str> = loc.rsplitn(3, ':').collect();
        let (file, lineno, col) = match parts.as_slice() {
            [col, lineno, file] if col.parse::<u32>().is_ok() && lineno.parse::<u32>().is_ok() => {
                (*file, lineno.parse().unwrap(), col.parse().unwrap())
            }
            [lineno, file] if lineno.parse::<u32>().is_ok() => {
                (*file, lineno.parse().unwrap(), 1u32)
            }
            _ => continue,
        };
        out.push(Diagnostic {
            file: resolve(file, dir, root, sep),
            line: lineno,
            column: col,
            end_line: None,
            end_column: None,
            severity: Severity::Warning,
            message: message.trim().to_string(),
            source: source.to_string(),
            code: None,
        });
    }
    out
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

/// Find all manifest files up to MAX_DEPTH, skipping IGNORED_DIRS.
fn find_manifests(shell: &ShellConfig, root: &str) -> Vec<String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            let prune: String = IGNORED_DIRS
                .iter()
                .map(|d| format!("-name '{d}'"))
                .collect::<Vec<_>>()
                .join(" -o ");
            let names: String = PROVIDERS
                .iter()
                .map(|p| format!("-name '{}'", p.manifest))
                .collect::<Vec<_>>()
                .join(" -o ");
            let script = format!(
                "find '{}' -maxdepth {MAX_DEPTH} \\( {prune} \\) -prune -o \\( {names} \\) -print",
                root.replace('\'', "'\\''"),
            );
            shell
                .run_stdout("bash", &["-c", &script])
                .ok()
                .map(|s| s.lines().map(|l| l.to_string()).collect())
                .unwrap_or_default()
        }
        _ => {
            let mut results = Vec::new();
            walk(std::path::Path::new(root), &mut results, 0);
            results
        }
    }
}

fn walk(dir: &std::path::Path, results: &mut Vec<String>, depth: u32) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&entry.path(), results, depth + 1);
        } else if PROVIDERS.iter().any(|p| p.manifest == name) {
            if let Some(path) = entry.path().to_str() {
                results.push(path.to_string());
            }
        }
    }
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
    fn dirs_for_collapses_nested() {
        let manifests = vec![
            "/proj/Cargo.toml".to_string(),
            "/proj/crates/a/Cargo.toml".to_string(),
        ];
        let dirs = dirs_for(&manifests, "Cargo.toml", "/proj", '/');
        assert_eq!(dirs, vec!["/proj".to_string()]);
    }
}
