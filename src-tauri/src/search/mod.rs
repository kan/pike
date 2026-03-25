use crate::types::ShellConfig;
use serde::Serialize;
use std::process::Command;
use tauri::State;

pub struct SearchState {
    pub bundled_rg: Option<String>,
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

fn run_command(shell: &ShellConfig, program: &str, args: &[&str]) -> Result<(i32, String, String), String> {
    let output = match shell {
        ShellConfig::Wsl { distro } => {
            let mut cmd = Command::new("wsl.exe");
            cmd.arg("-d").arg(distro).arg("--").arg(program);
            for a in args {
                cmd.arg(a);
            }
            cmd.output().map_err(|e| e.to_string())?
        }
        _ => {
            let mut cmd = Command::new(program);
            for a in args {
                cmd.arg(a);
            }
            cmd.output().map_err(|e| e.to_string())?
        }
    };
    let code = output.status.code().unwrap_or(-1);
    Ok((
        code,
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

#[tauri::command]
pub async fn search_detect_backend(
    shell: ShellConfig,
    state: State<'_, SearchState>,
) -> Result<String, String> {
    let bundled = state.bundled_rg.clone();
    tokio::task::spawn_blocking(move || {
        // Try system rg first
        let check_cmd = match &shell {
            ShellConfig::Wsl { .. } => "which",
            _ => "where",
        };
        if let Ok((0, _, _)) = run_command(&shell, check_cmd, &["rg"]) {
            return Ok("rg".to_string());
        }
        // For non-WSL: try bundled rg sidecar (existence checked at startup)
        if !matches!(shell, ShellConfig::Wsl { .. }) {
            if let Some(ref path) = bundled {
                return Ok(format!("rg:{path}"));
            }
        }
        if let Ok((0, _, _)) = run_command(&shell, check_cmd, &["grep"]) {
            return Ok("grep".to_string());
        }
        Ok("grep".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

const MAX_MATCHES: usize = 500;

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
        // Format: filepath:linenum:content
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
pub async fn search_execute(
    shell: ShellConfig,
    root: String,
    query: String,
    backend: String,
    is_regex: bool,
    glob_include: Option<String>,
    glob_exclude: Option<String>,
    max_results: Option<u32>,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
        });
    }

    let max = max_results.unwrap_or(MAX_MATCHES as u32) as usize;

    // Auto-wrap bare patterns into glob: "ts" → "*.ts", "test" → "*test*"
    let inc_glob = glob_include.map(|g| {
        if g.contains('*') || g.contains('?') { g } else if g.contains('.') { format!("*.{}", g.trim_start_matches('.')) } else { format!("*{g}*") }
    });
    let exc_glob = glob_exclude.map(|g| {
        if g.contains('*') || g.contains('?') { g } else { format!("*{g}*") }
    });

    tokio::task::spawn_blocking(move || {
        // backend is "rg", "rg:/path/to/rg.exe", or "grep"
        let (is_rg, rg_program) = if backend == "rg" {
            (true, "rg".to_string())
        } else if let Some(path) = backend.strip_prefix("rg:") {
            (true, path.to_string())
        } else {
            (false, String::new())
        };

        let output = if is_rg {
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
            run_command(&shell, &rg_program, &arg_refs)
        } else {
            // grep
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
            run_command(&shell, "grep", &arg_refs)
        };

        match output {
            Ok((code, stdout, stderr)) => {
                if code == 2 {
                    return Err(stderr);
                }
                let (mut matches, truncated) = if is_rg {
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
