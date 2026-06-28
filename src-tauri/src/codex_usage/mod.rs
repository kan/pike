use crate::types::{cwd_matches_root, wsl_home_subdir_cached, ShellConfig};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A rollout file is treated as an "active" Codex session only if it was written
/// within this window. Codex CLI has no pidfile (unlike Claude's `sessions/*.json`),
/// so recent file mtime is the only practical liveness signal. Sized to span a
/// single long reasoning turn (Codex only writes a token_count at turn
/// boundaries), so the display doesn't flicker off mid-turn.
const ACTIVE_WINDOW_SECS: u64 = 300;

/// How many of the most recent day-directories (`sessions/YYYY/MM/DD`) to scan.
/// A rollout lives in the day-dir of the session's *start* date, so a session
/// left running for several days keeps appending to an older folder; scanning a
/// generous window keeps such long-lived sessions visible while still bounding
/// the walk (each file is only `stat`-ed, then mtime-filtered).
const SCAN_DAY_DIRS: usize = 14;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageResult {
    pub active: bool,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub session_count: u32,
    pub total_input_tokens: u64,
    pub total_cached_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_reasoning_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
    pub rate_limit_primary: Option<RateLimitWindow>,
    pub rate_limit_secondary: Option<RateLimitWindow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<u64>,
}

#[derive(Debug, Default, Clone)]
struct TokenUsage {
    input: u64,
    cached_input: u64,
    output: u64,
    reasoning: u64,
}

impl TokenUsage {
    fn add(&mut self, other: &TokenUsage) {
        self.input += other.input;
        self.cached_input += other.cached_input;
        self.output += other.output;
        self.reasoning += other.reasoning;
    }
}

struct SessionAgg {
    session_id: Option<String>,
    model: Option<String>,
    usage: TokenUsage,
    primary: Option<RateLimitWindow>,
    secondary: Option<RateLimitWindow>,
}

struct ModelPricing {
    input_per_m: f64,
    cached_per_m: f64,
    output_per_m: f64,
}

/// Per-token pricing for OpenAI models invoked via Codex. `cached_per_m` is the
/// discounted rate for cached input tokens (Codex's `total_token_usage.input_tokens`
/// *includes* `cached_input_tokens`, so the two are billed separately). The
/// subscription-billed `gpt-5*-codex` models have no public per-token rate and
/// intentionally return `None` (usage is surfaced as rate-limit % instead).
fn get_pricing(model: &str) -> Option<ModelPricing> {
    let m = model.to_lowercase();
    // (prefix, input, cached, output) — longest/most-specific prefixes first.
    let table = [
        ("o4-mini", (1.1, 0.275, 4.4)),
        ("o3", (10.0, 2.5, 40.0)),
        ("gpt-4o-mini", (0.15, 0.075, 0.6)),
        ("gpt-4o", (2.5, 1.25, 10.0)),
        ("gpt-4.1-nano", (0.1, 0.025, 0.4)),
        ("gpt-4.1-mini", (0.4, 0.1, 1.6)),
        ("gpt-4.1", (2.0, 0.5, 8.0)),
    ];
    table
        .iter()
        .find(|(prefix, _)| m.starts_with(prefix))
        .map(|(_, (input_per_m, cached_per_m, output_per_m))| ModelPricing {
            input_per_m: *input_per_m,
            cached_per_m: *cached_per_m,
            output_per_m: *output_per_m,
        })
}

/// Cost of a model's usage, discounting cached input tokens. `input` includes the
/// cached portion, so non-cached = input - cached.
fn model_cost(p: &ModelPricing, u: &TokenUsage) -> f64 {
    let non_cached = u.input.saturating_sub(u.cached_input);
    (non_cached as f64 * p.input_per_m
        + u.cached_input as f64 * p.cached_per_m
        + u.output as f64 * p.output_per_m)
        / 1_000_000.0
}

/// Resolve the `.codex` data directory for the given shell, mirroring
/// `claude_usage::claude_home`: Windows shells use `%USERPROFILE%\.codex`; WSL
/// resolves the distro home over the `\\wsl.localhost\…` UNC share (Codex running
/// inside WSL writes its rollouts to the Linux home).
fn codex_home(shell: &ShellConfig) -> Option<PathBuf> {
    match shell {
        ShellConfig::Wsl { distro } => wsl_home_subdir_cached(shell, distro, ".codex"),
        _ => std::env::var("USERPROFILE")
            .ok()
            .map(|p| PathBuf::from(p).join(".codex")),
    }
}

/// Date subdirectories (`YYYY`/`MM`/`DD`), sorted newest-first. Only all-ASCII-digit
/// names are kept so a stray non-date folder (e.g. `.Trash`, `archive`) — which
/// would sort *above* digits in descending order — can't consume a scan slot.
fn sorted_date_subdirs_desc(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .collect();
    v.sort();
    v.reverse();
    v
}

/// The latest `n` `sessions/YYYY/MM/DD` directories, newest first.
fn latest_day_dirs(sessions_dir: &Path, n: usize) -> Vec<PathBuf> {
    let mut days = Vec::new();
    for y in sorted_date_subdirs_desc(sessions_dir) {
        for m in sorted_date_subdirs_desc(&y) {
            for d in sorted_date_subdirs_desc(&m) {
                days.push(d);
                if days.len() >= n {
                    return days;
                }
            }
        }
    }
    days
}

/// Rollout `*.jsonl` files modified within `ACTIVE_WINDOW_SECS`, each paired with
/// its modified time (used to pick the newest session for account-wide fields).
fn recent_session_files(sessions_dir: &Path) -> Vec<(PathBuf, SystemTime)> {
    let now = SystemTime::now();
    let window = Duration::from_secs(ACTIVE_WINDOW_SECS);
    let mut out = Vec::new();
    for day in latest_day_dirs(sessions_dir, SCAN_DAY_DIRS) {
        let Ok(entries) = fs::read_dir(&day) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.extension().is_some_and(|e| e == "jsonl") {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            // A file mtime slightly in the future (common when reading WSL files
            // over the UNC share — the WSL VM and Windows host clocks differ)
            // makes `duration_since` error; treat that as age 0 (= fresh) so a
            // genuinely-active session isn't dropped.
            let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
            if age <= window {
                out.push((path, modified));
            }
        }
    }
    out
}

fn parse_rate_window(v: &Value) -> Option<RateLimitWindow> {
    if !v.is_object() {
        return None;
    }
    let used_percent = v["used_percent"].as_f64()?;
    Some(RateLimitWindow {
        used_percent,
        window_minutes: v["window_minutes"].as_u64(),
        resets_at: v["resets_at"].as_u64(),
    })
}

/// Parse one rollout file, returning its aggregated usage if the session's cwd
/// matches `project_root` and it has at least one token_count event.
fn parse_session(path: &Path, shell: &ShellConfig, project_root: &str) -> Option<SessionAgg> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut usage: Option<TokenUsage> = None;
    let mut primary: Option<RateLimitWindow> = None;
    let mut secondary: Option<RateLimitWindow> = None;

    for line in reader.lines() {
        let Ok(line) = line else { continue };

        if cwd.is_none() && line.contains("\"session_meta\"") {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let p = &v["payload"];
                cwd = p["cwd"].as_str().map(str::to_string);
                session_id = p["id"].as_str().map(str::to_string);
            }
            continue;
        }

        // `turn_context.payload.model` — keep the last one seen (model can be
        // switched mid-session).
        if line.contains("\"turn_context\"") && line.contains("\"model\"") {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(m) = v["payload"]["model"].as_str() {
                    model = Some(m.to_string());
                }
            }
            continue;
        }

        // token_count carries the cumulative `total_token_usage` plus account-wide
        // rate limits; keep the last occurrence.
        if line.contains("\"token_count\"") {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let tu = &v["payload"]["info"]["total_token_usage"];
                if tu.is_object() {
                    usage = Some(TokenUsage {
                        input: tu["input_tokens"].as_u64().unwrap_or(0),
                        cached_input: tu["cached_input_tokens"].as_u64().unwrap_or(0),
                        output: tu["output_tokens"].as_u64().unwrap_or(0),
                        reasoning: tu["reasoning_output_tokens"].as_u64().unwrap_or(0),
                    });
                }
                let rl = &v["payload"]["rate_limits"];
                if rl.is_object() {
                    primary = parse_rate_window(&rl["primary"]);
                    secondary = parse_rate_window(&rl["secondary"]);
                }
            }
            continue;
        }
    }

    let cwd = cwd?;
    if !cwd_matches_root(shell, &cwd, project_root) {
        return None;
    }
    let usage = usage?;
    Some(SessionAgg {
        session_id,
        model,
        usage,
        primary,
        secondary,
    })
}

fn get_usage_for_project(
    shell: &ShellConfig,
    project_root: &str,
) -> Result<CodexUsageResult, String> {
    let Some(codex_dir) = codex_home(shell) else {
        return Ok(CodexUsageResult::default());
    };
    let sessions_dir = codex_dir.join("sessions");

    let mut files = recent_session_files(&sessions_dir);
    if files.is_empty() {
        return Ok(CodexUsageResult::default());
    }
    // Newest first: account-wide fields (model, rate limits, session id) come from
    // the most recently written session.
    files.sort_by_key(|f| std::cmp::Reverse(f.1));

    let mut totals = TokenUsage::default();
    // Per-model totals drive cost: each session may run a different model, so
    // pricing the summed totals against a single model would be wrong.
    let mut by_model: HashMap<String, TokenUsage> = HashMap::new();
    let mut session_count = 0u32;
    let mut session_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut primary: Option<RateLimitWindow> = None;
    let mut secondary: Option<RateLimitWindow> = None;

    for (path, _) in &files {
        let Some(agg) = parse_session(path, shell, project_root) else {
            continue;
        };
        session_count += 1;
        totals.add(&agg.usage);
        by_model
            .entry(agg.model.clone().unwrap_or_else(|| "unknown".to_string()))
            .or_default()
            .add(&agg.usage);
        // First matching session is the newest (files sorted desc).
        if session_count == 1 {
            session_id = agg.session_id;
            model = agg.model;
            primary = agg.primary;
            secondary = agg.secondary;
        }
    }

    if session_count == 0 {
        return Ok(CodexUsageResult::default());
    }

    // Sum cost per model; `None` only if no matching session used a priced model.
    let mut total_cost = 0.0f64;
    let mut has_priced = false;
    for (m, u) in &by_model {
        if let Some(p) = get_pricing(m) {
            has_priced = true;
            total_cost += model_cost(&p, u);
        }
    }
    let estimated_cost_usd = if has_priced { Some(total_cost) } else { None };

    Ok(CodexUsageResult {
        active: true,
        session_id,
        model,
        session_count,
        total_input_tokens: totals.input,
        total_cached_input_tokens: totals.cached_input,
        total_output_tokens: totals.output,
        total_reasoning_tokens: totals.reasoning,
        estimated_cost_usd,
        rate_limit_primary: primary,
        rate_limit_secondary: secondary,
    })
}

#[tauri::command]
pub async fn codex_usage_get(
    shell: ShellConfig,
    project_root: String,
) -> Result<CodexUsageResult, String> {
    tokio::task::spawn_blocking(move || get_usage_for_project(&shell, &project_root))
        .await
        .map_err(|e| e.to_string())?
}
