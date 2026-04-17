use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

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

fn claude_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|p| PathBuf::from(p).join(".claude"))
}

fn encode_project_path(root: &str) -> String {
    root.replace([':', '\\', '/'], "-")
}

fn normalize_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
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

fn find_active_sessions(project_root: &str) -> Vec<SessionInfo> {
    let Some(claude_dir) = claude_home() else {
        return Vec::new();
    };
    let sessions_dir = claude_dir.join("sessions");
    let Ok(entries) = fs::read_dir(&sessions_dir) else {
        return Vec::new();
    };

    let normalized_root = normalize_path(project_root);
    let mut result = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(info) = serde_json::from_str::<SessionInfo>(&content) {
                    if normalize_path(&info.cwd) == normalized_root && is_process_alive(info.pid) {
                        result.push(info);
                    }
                }
            }
        }
    }

    result
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

fn get_usage_for_project(project_root: &str) -> Result<ClaudeUsageResult, String> {
    let sessions = find_active_sessions(project_root);
    if sessions.is_empty() {
        return Ok(ClaudeUsageResult::default());
    }

    let Some(claude_dir) = claude_home() else {
        return Ok(ClaudeUsageResult::default());
    };

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
pub async fn claude_usage_get(project_root: String) -> Result<ClaudeUsageResult, String> {
    tokio::task::spawn_blocking(move || get_usage_for_project(&project_root))
        .await
        .map_err(|e| e.to_string())?
}
