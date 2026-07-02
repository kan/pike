//! Claude Code rate-limit usage (`claude -p "/usage"`).
//!
//! The subscription rate-limit state (5h session / weekly windows) lives on
//! Anthropic's servers; the local JSONL logs (`super`) can only count tokens.
//! The official CLI is the only source, so this shells out to
//! `claude -p "/usage"`, parses the `Current …: N% used · resets …` lines and
//! caches the result — the CLI call takes 10s+ (it boots the full agent
//! runtime) and must never run on every status-bar poll.

use crate::types::ShellConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Attempt pacing while a session is active — and the retry pacing after a
/// failed fetch, so a cold-start hiccup can't latch an empty result for long.
const TTL_ACTIVE: Duration = Duration::from_secs(300);
/// Attempt pacing with no active session in this project. Quota can still move
/// (sessions in other projects, 5h/weekly windows resetting), so idle windows
/// refresh too — just rarely.
const TTL_IDLE: Duration = Duration::from_secs(3600);
/// How long a previously-fetched result may keep being shown after fetches
/// start failing. Beyond this the item disappears rather than lie.
const STALE_KEEP_MAX: Duration = Duration::from_secs(7200);
/// Generous: headless `claude -p` occasionally stalls; the caller shows the
/// previous cached value meanwhile.
const CLI_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateLimits {
    /// True when rate-limit data is available. Named `active` to satisfy the
    /// frontend usage-store factory contract (`{ active: boolean }`).
    pub active: bool,
    /// Epoch seconds of the CLI run that produced `windows` (data age, shown
    /// in the UI; retry pacing is tracked separately in the cache entry).
    pub fetched_at: u64,
    pub windows: Vec<ClaudeRateWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateWindow {
    /// Label as printed by the CLI: "session", "week (all models)", "week (Fable)", …
    pub label: String,
    /// Classification of `label` ("session" | "weekAll" | "other"), done here
    /// next to the parser so the frontend never string-matches CLI wording.
    pub kind: &'static str,
    pub used_percent: f64,
    /// Reset description as printed by the CLI, e.g. "Jul 2, 2:39pm (Asia/Tokyo)".
    pub resets_at: Option<String>,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn window_kind(label: &str) -> &'static str {
    if label == "session" {
        "session"
    } else if label.starts_with("week (all models)") {
        "weekAll"
    } else {
        "other"
    }
}

/// Parse `Current <label>: <pct>% used · resets <when>` lines. Everything else
/// in the output (usage breakdowns, tips) is ignored.
fn parse_usage_output(out: &str) -> Vec<ClaudeRateWindow> {
    let mut windows = Vec::new();
    for line in out.lines() {
        let Some(rest) = line.trim().strip_prefix("Current ") else {
            continue;
        };
        let Some((label, tail)) = rest.split_once(':') else {
            continue;
        };
        let tail = tail.trim();
        let Some((pct_str, after)) = tail.split_once('%') else {
            continue;
        };
        if !after.trim_start().starts_with("used") {
            continue;
        }
        let Ok(pct) = pct_str.trim().parse::<f64>() else {
            continue;
        };
        let resets_at = after
            .split_once("resets")
            .map(|(_, when)| when.trim().to_string())
            .filter(|s| !s.is_empty());
        let label = label.trim().to_string();
        windows.push(ClaudeRateWindow {
            kind: window_kind(&label),
            label,
            used_percent: pct,
            resets_at,
        });
    }
    windows
}

/// Cached result plus attempt pacing. `last_attempt` advances on every CLI
/// run (even failed ones); `data.fetched_at` only when a run produced data.
#[derive(Clone)]
struct CacheEntry {
    last_attempt: u64,
    data: ClaudeRateLimits,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serializes CLI fetches so parallel polls (multiple windows) spawn one CLI.
fn fetch_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Rate limits are account-scoped, not project-scoped — key the cache by the
/// claude installation (WSL distro vs Windows host).
fn cache_key(shell: &ShellConfig) -> String {
    match shell {
        ShellConfig::Wsl { distro } => format!("wsl:{distro}"),
        _ => "windows".to_string(),
    }
}

fn needs_fetch(entry: &CacheEntry, session_active: bool) -> bool {
    let age = now_epoch().saturating_sub(entry.last_attempt);
    // Failed fetches and active sessions retry on the short TTL; idle windows
    // still refresh eventually (other projects / time-based resets move quota).
    if !entry.data.active || session_active {
        age >= TTL_ACTIVE.as_secs()
    } else {
        age >= TTL_IDLE.as_secs()
    }
}

fn run_usage_cli(shell: &ShellConfig, project_root: &str) -> ClaudeRateLimits {
    // stdin must be closed explicitly — headless claude waits 3s for piped input.
    let line = format!("claude -p \"/usage\" < {}", shell.null_device());
    let windows = match shell.run_shell_line(project_root, &line, CLI_TIMEOUT) {
        Ok((_code, stdout, _stderr)) => parse_usage_output(&stdout),
        Err(_) => Vec::new(),
    };
    ClaudeRateLimits {
        active: !windows.is_empty(),
        fetched_at: now_epoch(),
        windows,
    }
}

fn get_rate_limits(
    shell: &ShellConfig,
    project_root: &str,
    session_active: bool,
    force: bool,
) -> ClaudeRateLimits {
    let key = cache_key(shell);

    let cached = cache().lock().unwrap().get(&key).cloned();
    if let Some(entry) = &cached {
        if !force && !needs_fetch(entry, session_active) {
            return entry.data.clone();
        }
    }

    let _guard = fetch_lock().lock().unwrap();
    // Double-check: another caller may have fetched while we waited on the lock.
    if !force {
        if let Some(entry) = cache().lock().unwrap().get(&key) {
            if !needs_fetch(entry, session_active) {
                return entry.data.clone();
            }
        }
    }

    let mut result = run_usage_cli(shell, project_root);
    // Keep the previous data when a refresh fails (CLI hiccup / timeout) —
    // stale rate info beats a flickering status item. Bounded by
    // STALE_KEEP_MAX so a permanently broken CLI (uninstalled, output format
    // changed) eventually makes the item disappear instead of showing
    // hours-old percentages. `last_attempt` advances either way, so retries
    // stay paced at TTL_ACTIVE.
    if !result.active {
        if let Some(prev) = cached.map(|c| c.data).filter(|d| d.active) {
            if now_epoch().saturating_sub(prev.fetched_at) < STALE_KEEP_MAX.as_secs() {
                result = prev;
            }
        }
    }
    cache().lock().unwrap().insert(
        key,
        CacheEntry {
            last_attempt: now_epoch(),
            data: result.clone(),
        },
    );
    result
}

#[tauri::command]
pub async fn claude_usage_rate_get(
    shell: ShellConfig,
    project_root: String,
    session_active: bool,
    force: bool,
) -> Result<ClaudeRateLimits, String> {
    tokio::task::spawn_blocking(move || {
        Ok(get_rate_limits(&shell, &project_root, session_active, force))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{parse_usage_output, window_kind};

    #[test]
    fn parses_current_usage_lines() {
        let out = "\
You are currently using your subscription to power your Claude Code usage

Current session: 20% used · resets Jul 2, 2:39pm (Asia/Tokyo)
Current week (all models): 4% used · resets Jul 2, 5:59pm (Asia/Tokyo)
Current week (Fable): 7% used · resets Jul 2, 5:59pm (Asia/Tokyo)

What's contributing to your limits usage?
Last 24h · 171 requests · 3 sessions
  75% of your usage came from subagent-heavy sessions
";
        let windows = parse_usage_output(out);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "session");
        assert_eq!(windows[0].kind, "session");
        assert_eq!(windows[0].used_percent, 20.0);
        assert_eq!(windows[0].resets_at.as_deref(), Some("Jul 2, 2:39pm (Asia/Tokyo)"));
        assert_eq!(windows[1].label, "week (all models)");
        assert_eq!(windows[1].kind, "weekAll");
        assert_eq!(windows[1].used_percent, 4.0);
        assert_eq!(windows[2].label, "week (Fable)");
        assert_eq!(windows[2].kind, "other");
        // Breakdown lines ("75% of your usage …") must not be picked up.
    }

    #[test]
    fn parses_without_resets_and_ignores_noise() {
        let out = "Current week (Sonnet only): 0% used\nCurrent nonsense line\n50% of usage\n";
        let windows = parse_usage_output(out);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label, "week (Sonnet only)");
        assert_eq!(windows[0].kind, "other");
        assert_eq!(windows[0].used_percent, 0.0);
        assert_eq!(windows[0].resets_at, None);
    }

    #[test]
    fn classifies_window_kinds() {
        assert_eq!(window_kind("session"), "session");
        assert_eq!(window_kind("week (all models)"), "weekAll");
        assert_eq!(window_kind("week (Fable)"), "other");
        // A renamed session label must NOT silently classify as the 5h window.
        assert_eq!(window_kind("5-hour session"), "other");
    }
}
