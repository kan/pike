use crate::types::ShellConfig;
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

pub struct SearchState {
    pub bundled_rg: Option<String>,
    pub detected: Mutex<Option<SearchBackend>>,
}

#[derive(Clone)]
pub(crate) enum SearchBackend {
    Rg,
    BundledRg { path: String },
    Grep,
}

impl SearchBackend {
    pub(crate) fn is_rg(&self) -> bool {
        matches!(self, SearchBackend::Rg | SearchBackend::BundledRg { .. })
    }

    pub(crate) fn rg_program(&self) -> &str {
        match self {
            SearchBackend::BundledRg { path } => path,
            _ => "rg",
        }
    }

    fn label(&self) -> &str {
        match self {
            SearchBackend::Rg | SearchBackend::BundledRg { .. } => "rg",
            SearchBackend::Grep => "grep",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn search_detect_backend(
    shell: ShellConfig,
    state: State<'_, SearchState>,
) -> Result<String, String> {
    let bundled = state.bundled_rg.clone();
    let backend = tokio::task::spawn_blocking(move || {
        let check_cmd = match &shell {
            ShellConfig::Wsl { .. } => "which",
            _ => "where",
        };
        if let Ok((0, _, _)) = shell.run(check_cmd, &["rg"]) {
            return SearchBackend::Rg;
        }
        if !matches!(shell, ShellConfig::Wsl { .. }) {
            if let Some(path) = bundled {
                return SearchBackend::BundledRg { path };
            }
        }
        SearchBackend::Grep
    })
    .await
    .map_err(|e| e.to_string())?;

    let label = backend.label().to_string();
    if let Ok(mut detected) = state.detected.lock() {
        *detected = Some(backend);
    }
    Ok(label)
}

const MAX_MATCHES: usize = 500;
const MAX_FILES: usize = 10000;

#[tauri::command]
pub async fn list_project_files(
    shell: ShellConfig,
    root: String,
    state: State<'_, SearchState>,
) -> Result<Vec<String>, String> {
    let backend = state
        .detected
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(SearchBackend::Grep);

    tokio::task::spawn_blocking(move || {
        let output = if backend.is_rg() {
            shell.run(backend.rg_program(), &["--files", "--", &root])
        } else {
            // Fallback to find (WSL) or dir (Windows)
            match &shell {
                ShellConfig::Wsl { .. } => shell.run(
                    "find",
                    &[&root, "-type", "f", "-not", "-path", "*/.git/*", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/target/*"],
                ),
                _ => shell.run(
                    "cmd.exe",
                    &["/C", &format!("dir /S /B /A:-D \"{}\"", root)],
                ),
            }
        };

        match output {
            Ok((_, stdout, _)) => {
                let files: Vec<String> = stdout
                    .lines()
                    .take(MAX_FILES)
                    .map(|l| l.to_string())
                    .collect();
                Ok(files)
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_rg_json(output: &str) -> (Vec<SearchMatch>, bool) {
    let mut matches = Vec::new();
    let mut truncated = false;

    for line in output.lines() {
        if matches.len() >= MAX_MATCHES {
            truncated = true;
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let Some(data) = v.get("data") else { continue };
        let path = data
            .get("path")
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let line_num = data
            .get("line_number")
            .and_then(|n| n.as_u64())
            .unwrap_or(0) as u32;
        let content = data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim_end()
            .to_string();
        matches.push(SearchMatch {
            path,
            line: line_num,
            content,
        });
    }
    (matches, truncated)
}

fn parse_grep_output(output: &str) -> (Vec<SearchMatch>, bool) {
    let mut matches = Vec::new();
    let mut truncated = false;

    for line in output.lines() {
        if matches.len() >= MAX_MATCHES {
            truncated = true;
            break;
        }
        let mut parts = line.splitn(3, ':');
        let path = parts.next().unwrap_or("").to_string();
        let line_num: u32 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let content = parts.next().unwrap_or("").trim_end().to_string();
        if line_num > 0 && !path.is_empty() {
            matches.push(SearchMatch {
                path,
                line: line_num,
                content,
            });
        }
    }
    (matches, truncated)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_execute(
    shell: ShellConfig,
    root: String,
    query: String,
    is_regex: bool,
    glob_include: Option<String>,
    glob_exclude: Option<String>,
    max_results: Option<u32>,
    state: State<'_, SearchState>,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
        });
    }

    let backend = state
        .detected
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(SearchBackend::Grep);

    let max = max_results.unwrap_or(MAX_MATCHES as u32) as usize;

    let inc_glob = glob_include.map(|g| {
        if g.contains('*') || g.contains('?') { g } else if g.contains('.') { format!("*.{}", g.trim_start_matches('.')) } else { format!("*{g}*") }
    });
    let exc_glob = glob_exclude.map(|g| {
        if g.contains('*') || g.contains('?') { g } else { format!("*{g}*") }
    });

    tokio::task::spawn_blocking(move || {
        let output = if backend.is_rg() {
            let mut args: Vec<String> = vec!["--json".to_string()];
            if !is_regex {
                args.push("-F".to_string());
            }
            if let Some(ref inc) = inc_glob {
                args.push("--glob".to_string());
                args.push(inc.clone());
            }
            if let Some(ref exc) = exc_glob {
                args.push("--glob".to_string());
                args.push(format!("!{exc}"));
            }
            args.push("--max-count".to_string());
            args.push("20".to_string());
            args.push("-e".to_string());
            args.push(query);
            args.push("--".to_string());
            args.push(root);

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            shell.run(backend.rg_program(), &arg_refs)
        } else {
            let mut args: Vec<String> = vec!["-rn".to_string()];
            if !is_regex {
                args.push("-F".to_string());
            } else {
                args.push("-E".to_string());
            }
            if let Some(ref inc) = inc_glob {
                args.push(format!("--include={inc}"));
            }
            args.push("-m".to_string());
            args.push("20".to_string());
            args.push("--exclude-dir=.git".to_string());
            args.push("--exclude-dir=node_modules".to_string());
            args.push("--exclude-dir=target".to_string());
            if let Some(ref exc) = exc_glob {
                args.push(format!("--exclude={exc}"));
                args.push(format!("--exclude-dir={exc}"));
            }
            args.push("-e".to_string());
            args.push(query);
            args.push("--".to_string());
            args.push(root);

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            shell.run("grep", &arg_refs)
        };

        match output {
            Ok((code, stdout, stderr)) => {
                if code == 2 {
                    if !is_regex {
                        // literal (-F) mode should never cause regex parse errors;
                        // treat as "no results" rather than propagating a confusing error
                        return Ok(SearchResult { matches: vec![], truncated: false });
                    }
                    return Err(stderr);
                }
                let (mut matches, truncated) = if backend.is_rg() {
                    parse_rg_json(&stdout)
                } else {
                    parse_grep_output(&stdout)
                };
                matches.truncate(max);
                Ok(SearchResult {
                    truncated: truncated || matches.len() >= max,
                    matches,
                })
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
