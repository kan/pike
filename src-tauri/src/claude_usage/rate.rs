//! Claude Code rate-limit usage (`claude -p "/usage"`).
//!
//! The subscription rate-limit state (5h session / weekly windows) lives on
//! Anthropic's servers; the local JSONL logs (`super`) can only count tokens.
//! The official CLI is the only source, so this shells out to
//! `claude -p "/usage"`, parses the `Current …: N% used · resets …` lines and
//! caches the result — the CLI call takes 10s+ (it boots the full agent
//! runtime) and must never run on every status-bar poll.

use crate::types::{install_key, ShellConfig};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

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

use crate::types::epoch_secs as now_epoch;

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
/// claude installation (WSL distro vs Windows host). ただし `CLAUDE_CONFIG_DIR`
/// が違えばアカウントも違うので、それも鍵に混ぜる（#225。混ぜないと、別アカウントの
/// プロジェクトを開いた瞬間に前のアカウントの残量が出る）。
fn cache_key(shell: &ShellConfig, config_dir: Option<&str>) -> String {
    let install = install_key(shell);
    match config_dir {
        Some(dir) => format!("{install}\u{1f}{dir}"),
        None => install,
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

fn run_usage_cli(
    shell: &ShellConfig,
    project_root: &str,
    config_dir: Option<&str>,
) -> ClaudeRateLimits {
    // stdin must be closed explicitly — headless claude waits 3s for piped input.
    let line = format!("claude -p \"/usage\" < {}", shell.null_device());
    // `CLAUDE_CONFIG_DIR` はここで明示的に渡す（#225）。この経路は WSL では
    // `bash -c`（非対話・非ログイン）なので、ユーザーが `.bashrc` や `.envrc` で
    // 設定していても、渡さない限り既定の `~/.claude` のアカウントを見てしまう。
    let env: Vec<(&str, &str)> = config_dir
        .map(|d| ("CLAUDE_CONFIG_DIR", d))
        .into_iter()
        .collect();
    let windows = match shell.run_shell_line_env(project_root, &env, &line, CLI_TIMEOUT) {
        Ok((_code, stdout, _stderr)) => parse_usage_output(&stdout),
        Err(_) => Vec::new(),
    };
    ClaudeRateLimits {
        active: !windows.is_empty(),
        fetched_at: now_epoch(),
        windows,
    }
}

pub(crate) fn get_rate_limits(
    shell: &ShellConfig,
    project_root: &str,
    session_active: bool,
    force: bool,
) -> ClaudeRateLimits {
    let config_dir = super::config::resolve(shell, project_root).native_override;
    let key = cache_key(shell, config_dir.as_deref());

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

    let mut result = run_usage_cli(shell, project_root, config_dir.as_deref());
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

// レートを IPC で出す口は `agent_usage` に一本化した（#263）。**`session_active` を
// 呼び出し側から渡す配線も消えた**: あちらは同じ 1 回で usage も集めるので、自分で分かる。

/// 走っている取得（`get_rate_limits_soon` が起こしたもの）のキー。二重に起こさない印。
///
/// **キャッシュと同じキーで持つ。** 1 つの真偽値だと、あるアカウントの取得が走っている
/// あいだ別アカウントの背景更新が一度も始まらない（別 distro のプロジェクトを並べて
/// 開いているときに起きる）。
fn refreshing() -> &'static Mutex<std::collections::HashSet<String>> {
    static KEYS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    KEYS.get_or_init(Default::default)
}

/// 印を必ず下ろすための番人。**素の `store(false)` に戻さないこと**: 取得の途中で
/// パニックすると印が立ったまま残り、以後そのキーの背景更新が二度と走らない。
struct RefreshGuard(String);

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        refreshing()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// **待たずに**今の値を返し、古ければ裏で取り直す（#263）。
///
/// `agent_usage` は usage とレートを 1 回で返すので、ここで待つと**ディスクを読むだけの
/// トークン集計まで CLI の 90 秒に付き合わされる**。しかも `createUsageStore` は取得中の
/// tick を捨てるので、その間ステータスバーの数字と「実行中」の表示が丸ごと止まる
/// （2 つのストアに分けていたころは、安いほうが動き続けていた）。
///
/// 取りこぼしは無い: 裏の取得が終われば次の 30 秒の tick が新しい値を拾う。**最初の 1 回は
/// 空**になるが、それはストアを分けていたころのレートの初期状態と同じ。
///
/// `force`（更新ボタン）だけは待つ。押した人は結果を見に来ているし、そこで空を返すと
/// 「押しても何も起きない」になる。
pub(crate) fn get_rate_limits_soon(
    shell: &ShellConfig,
    project_root: &str,
    session_active: bool,
    force: bool,
) -> ClaudeRateLimits {
    if force {
        return get_rate_limits(shell, project_root, session_active, true);
    }
    let config_dir = super::config::resolve(shell, project_root).native_override;
    let key = cache_key(shell, config_dir.as_deref());
    let cached = cache().lock().unwrap().get(&key).cloned();
    let stale = cached
        .as_ref()
        .map_or(true, |entry| needs_fetch(entry, session_active));

    if stale {
        // 既に走っていれば足さない（`fetch_lock` でも直列化されるが、待つスレッドを
        // 積み上げない）。
        let started = refreshing()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone());
        if started {
            let (shell, root) = (shell.clone(), project_root.to_string());
            std::thread::spawn(move || {
                let _guard = RefreshGuard(key);
                get_rate_limits(&shell, &root, session_active, false);
            });
        }
    }
    cached.map(|c| c.data).unwrap_or_default()
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
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("Jul 2, 2:39pm (Asia/Tokyo)")
        );
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
