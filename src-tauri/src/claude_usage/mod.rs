use crate::types::{cwd_matches_root, wsl_home_subdir_cached, ShellConfig};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageResult {
    pub active: bool,
    pub session_id: Option<String>,
    pub started_at: Option<u64>,
    pub models: Vec<ModelUsage>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    pid: u64,
    session_id: String,
    cwd: String,
    started_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct JsonlLine {
    #[serde(rename = "type")]
    line_type: String,
    message: Option<MessagePart>,
}

#[derive(Debug, Deserialize)]
struct MessagePart {
    model: Option<String>,
    usage: Option<UsageData>,
}

#[derive(Debug, Deserialize)]
struct UsageData {
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

struct ModelPricing {
    input_per_m: f64,
    output_per_m: f64,
    cache_read_per_m: f64,
    cache_creation_per_m: f64,
}

fn get_pricing(model: &str) -> Option<ModelPricing> {
    let m = model.to_lowercase();
    let base = if m.contains("opus") {
        "opus"
    } else if m.contains("sonnet") {
        "sonnet"
    } else if m.contains("haiku") {
        "haiku"
    } else {
        return None;
    };

    Some(match base {
        "opus" => ModelPricing {
            input_per_m: 15.0,
            output_per_m: 75.0,
            cache_read_per_m: 1.875,
            cache_creation_per_m: 18.75,
        },
        "sonnet" => ModelPricing {
            input_per_m: 3.0,
            output_per_m: 15.0,
            cache_read_per_m: 0.375,
            cache_creation_per_m: 3.75,
        },
        "haiku" => ModelPricing {
            input_per_m: 0.80,
            output_per_m: 4.0,
            cache_read_per_m: 0.08,
            cache_creation_per_m: 1.0,
        },
        _ => return None,
    })
}

#[derive(Debug, Default, Clone)]
struct TokenCounts {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

fn calculate_cost(pricing: &ModelPricing, counts: &TokenCounts) -> f64 {
    (counts.input as f64 * pricing.input_per_m
        + counts.output as f64 * pricing.output_per_m
        + counts.cache_read as f64 * pricing.cache_read_per_m
        + counts.cache_creation as f64 * pricing.cache_creation_per_m)
        / 1_000_000.0
}

/// Resolve the `.claude` data directory for the given shell.
/// - Windows shells: `%USERPROFILE%\.claude`.
/// - WSL: the distro's home `.claude`, reached over the `\\wsl.localhost\…` (or
///   legacy `\\wsl$\…`) UNC share, since `claude` running inside WSL writes its
///   logs to the Linux home, not the Windows profile.
fn claude_home(shell: &ShellConfig) -> Option<PathBuf> {
    match shell {
        ShellConfig::Wsl { distro } => wsl_home_subdir_cached(shell, distro, ".claude"),
        _ => std::env::var("USERPROFILE")
            .ok()
            .map(|p| PathBuf::from(p).join(".claude")),
    }
}

/// Encode a project root the way Claude Code names its `~/.claude/projects/<dir>`:
/// every character that is not an ASCII letter or digit becomes `-`. This mirrors
/// Claude's `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, so dots/underscores/spaces/etc.
/// all collapse to `-` (not just the path separators we handled before).
///
/// NOTE: Claude additionally truncates encodings longer than 200 chars and
/// appends a hash of the original path. That (rare) case is not replicated here,
/// so usage will not resolve for project paths whose encoded form exceeds 200
/// chars.
fn encode_project_path(root: &str) -> String {
    root.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[cfg(windows)]
fn is_process_alive(pid: u64) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) {
            Ok(handle) => {
                let _ = CloseHandle(handle);
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(not(windows))]
fn is_process_alive(_pid: u64) -> bool {
    false
}

/// Set of still-running pids among `pids`. WSL goes through the distro (Linux
/// pids are meaningless to the Windows process APIs); other shells use the
/// Windows process API directly.
fn alive_pids(shell: &ShellConfig, pids: &[u64]) -> HashSet<u64> {
    match shell {
        ShellConfig::Wsl { .. } => alive_pids_wsl(shell, pids),
        _ => pids.iter().copied().filter(|&p| is_process_alive(p)).collect(),
    }
}

/// One `wsl.exe` call that echoes each still-running pid. The trailing `; true`
/// keeps the whole script's exit status 0 even when the last `kill -0` fails —
/// otherwise `run_stdout` would treat it as an error and discard the stdout that
/// already named the live pids.
fn alive_pids_wsl(shell: &ShellConfig, pids: &[u64]) -> HashSet<u64> {
    if pids.is_empty() {
        return HashSet::new();
    }
    let checks = pids
        .iter()
        .map(|p| format!("kill -0 {p} 2>/dev/null && echo {p}"))
        .collect::<Vec<_>>()
        .join("; ");
    let script = format!("{checks}; true");
    let out = shell.run_stdout("bash", &["-c", &script]).unwrap_or_default();
    out.lines().filter_map(|l| l.trim().parse::<u64>().ok()).collect()
}

fn find_active_sessions(shell: &ShellConfig, claude_dir: &Path, project_root: &str) -> Vec<SessionInfo> {
    let sessions_dir = claude_dir.join("sessions");
    let Ok(entries) = fs::read_dir(&sessions_dir) else {
        return Vec::new();
    };

    let mut candidates: Vec<SessionInfo> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(info) = serde_json::from_str::<SessionInfo>(&content) {
                    if cwd_matches_root(shell, &info.cwd, project_root) {
                        candidates.push(info);
                    }
                }
            }
        }
    }

    let pids: Vec<u64> = candidates.iter().map(|c| c.pid).collect();
    let alive = alive_pids(shell, &pids);
    candidates.into_iter().filter(|c| alive.contains(&c.pid)).collect()
}

fn aggregate_jsonl(jsonl_path: &PathBuf) -> HashMap<String, TokenCounts> {
    let mut by_model: HashMap<String, TokenCounts> = HashMap::new();

    let Ok(file) = fs::File::open(jsonl_path) else {
        return by_model;
    };
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        // Fast pre-filter: skip lines that can't be assistant records
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<JsonlLine>(&line) else {
            continue;
        };
        if parsed.line_type != "assistant" {
            continue;
        }
        if let Some(msg) = parsed.message {
            if let Some(usage) = msg.usage {
                let model = msg.model.unwrap_or_else(|| "unknown".to_string());
                let entry = by_model.entry(model).or_default();
                entry.input += usage.input_tokens;
                entry.output += usage.output_tokens;
                entry.cache_read += usage.cache_read_input_tokens;
                entry.cache_creation += usage.cache_creation_input_tokens;
            }
        }
    }

    by_model
}

fn get_usage_for_project(shell: &ShellConfig, project_root: &str) -> Result<ClaudeUsageResult, String> {
    let Some(claude_dir) = claude_home(shell) else {
        return Ok(ClaudeUsageResult::default());
    };

    let sessions = find_active_sessions(shell, &claude_dir, project_root);
    if sessions.is_empty() {
        return Ok(ClaudeUsageResult::default());
    }

    let encoded = encode_project_path(project_root);
    let projects_dir = claude_dir.join("projects").join(&encoded);

    let mut all_by_model: HashMap<String, TokenCounts> = HashMap::new();
    let mut first_session_id: Option<String> = None;
    let mut earliest_start: Option<u64> = None;

    for session in &sessions {
        if first_session_id.is_none() {
            first_session_id = Some(session.session_id.clone());
        }
        if let Some(started) = session.started_at {
            earliest_start = Some(earliest_start.map_or(started, |e: u64| e.min(started)));
        }

        let jsonl_path = projects_dir.join(format!("{}.jsonl", session.session_id));
        let by_model = aggregate_jsonl(&jsonl_path);
        for (model, counts) in by_model {
            let entry = all_by_model.entry(model).or_default();
            entry.input += counts.input;
            entry.output += counts.output;
            entry.cache_read += counts.cache_read;
            entry.cache_creation += counts.cache_creation;
        }
    }

    let mut totals = TokenCounts::default();
    let mut total_cost = 0.0f64;
    let mut has_pricing = false;

    let mut models: Vec<ModelUsage> = Vec::new();
    for (model, counts) in &all_by_model {
        totals.input += counts.input;
        totals.output += counts.output;
        totals.cache_read += counts.cache_read;
        totals.cache_creation += counts.cache_creation;

        let cost = get_pricing(model).map(|p| {
            has_pricing = true;
            let c = calculate_cost(&p, counts);
            total_cost += c;
            c
        });

        models.push(ModelUsage {
            model: model.clone(),
            input_tokens: counts.input,
            output_tokens: counts.output,
            cache_read_tokens: counts.cache_read,
            cache_creation_tokens: counts.cache_creation,
            cost_usd: cost,
        });
    }

    models.sort_by_key(|m| std::cmp::Reverse(m.output_tokens));

    Ok(ClaudeUsageResult {
        active: true,
        session_id: first_session_id,
        started_at: earliest_start,
        models,
        total_input_tokens: totals.input,
        total_output_tokens: totals.output,
        total_cache_read_tokens: totals.cache_read,
        total_cache_creation_tokens: totals.cache_creation,
        estimated_cost_usd: if has_pricing { Some(total_cost) } else { None },
    })
}

#[tauri::command]
pub async fn claude_usage_get(
    shell: ShellConfig,
    project_root: String,
) -> Result<ClaudeUsageResult, String> {
    tokio::task::spawn_blocking(move || get_usage_for_project(&shell, &project_root))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::encode_project_path;

    #[test]
    fn encode_matches_claude_scheme() {
        // Path separators / drive colon (the cases that already worked).
        assert_eq!(encode_project_path("C:\\Users\\kanfu"), "C--Users-kanfu");
        assert_eq!(
            encode_project_path("/home/kan/d-project-media"),
            "-home-kan-d-project-media"
        );
        // Regression for #108: dots, underscores, spaces and non-ASCII all
        // collapse to '-', matching Claude's /[^a-zA-Z0-9]/g.
        assert_eq!(encode_project_path("/home/kan/my.project"), "-home-kan-my-project");
        assert_eq!(encode_project_path("C:\\Users\\foo\\app.v2"), "C--Users-foo-app-v2");
        assert_eq!(encode_project_path("/home/kan/a_b c"), "-home-kan-a-b-c");
        // Non-ASCII (each scalar → '-'): "/x/é.z" → '-' x '-' '-' '-' z.
        assert_eq!(encode_project_path("/x/é.z"), "-x---z");
    }
}
