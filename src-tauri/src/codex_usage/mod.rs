use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use crate::types::{cwd_matches_root, wsl_home_subdir_cached, ShellConfig};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

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

/// 集計に含めるロールアウトの新しさ。`ACTIVE_WINDOW_SECS` は「今動いているか」の
/// 判定用で、こちらは「最近このプロジェクトでどれだけ使ったか」の範囲（#226）。
/// 分けないと、5 分前に終わった作業が状態画面から丸ごと消える（Claude の plugin
/// 経由で使った直後でも「記録はありません」になっていた）。
const RECENT_WINDOW_SECS: u64 = 24 * 60 * 60;

/// アカウント情報の読み直し間隔。ログインし直したときしか変わらない。
const ACCOUNT_TTL: Duration = Duration::from_secs(300);

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
    /// 一番新しいセッションの書き込み時刻（epoch 秒）。`active` が false のときに
    /// 「いつ使ったか」を出すためのもの。
    pub last_activity_at: Option<u64>,
    /// `~/.codex/auth.json` にログインしているアカウント。
    pub account: Option<CodexAccount>,
}

/// Codex にログインしているアカウント（#226）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    pub email: Option<String>,
    /// ChatGPT のプラン（`plus` 等）。API キー運用では入らない。
    pub plan: Option<String>,
    /// `chatgpt` / `apikey` など、Codex 自身が記録している認証方式。
    pub auth_mode: Option<String>,
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

#[derive(Clone)]
struct SessionAgg {
    /// このセッションを開いたディレクトリ。プロジェクトとの突き合わせは呼び出し側で行う
    /// （キャッシュをプロジェクト非依存にするため）。
    cwd: String,
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

/// Rollout `*.jsonl` files modified within `RECENT_WINDOW_SECS`, each paired with
/// its modified time (used to pick the newest session for account-wide fields and
/// to decide whether anything is running right now).
fn recent_session_files(sessions_dir: &Path) -> Vec<(PathBuf, SystemTime)> {
    let now = SystemTime::now();
    let window = Duration::from_secs(RECENT_WINDOW_SECS);
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
/// キー＝`.codex` のパス、値＝(読んだ時刻, アカウント)。
type AccountCache = Mutex<HashMap<PathBuf, (Instant, Option<CodexAccount>)>>;

/// キー＝ロールアウトのパス、値＝(そのときの mtime, 集計結果)。
type SessionCache = Mutex<HashMap<PathBuf, (SystemTime, Option<SessionAgg>)>>;

fn session_cache() -> &'static SessionCache {
    static CACHE: OnceLock<SessionCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `parse_session` の結果を mtime でキャッシュする。
///
/// 走査窓を 24 時間に広げた以上、これが無いと 30 秒ごとに数十本のロールアウトを
/// 全文読み直すことになる（WSL では UNC 越し）。終わったセッションのファイルは
/// もう変わらないので、mtime が同じなら読み直す必要がない。パースできなかったもの
/// （`None`）もキャッシュする。
///
/// **キーはプロジェクトを含めない**。読むコスト（JSONL 全行の `serde_json`）は
/// プロジェクトに依らず同じで、違うのは最後の `cwd` の突き合わせだけ。含めると
/// ウィンドウを N 枚開いたときに同じファイルを N 回読むことになる。
/// 集計の窓より古いエントリを落とす。
fn prune_session_cache() {
    let cutoff = SystemTime::now() - Duration::from_secs(RECENT_WINDOW_SECS);
    if let Ok(mut map) = session_cache().lock() {
        map.retain(|_, (modified, _)| *modified >= cutoff);
    }
}

fn parse_session_cached(path: &Path, modified: SystemTime) -> Option<SessionAgg> {
    let cache = session_cache();
    if let Ok(map) = cache.lock() {
        if let Some((at, agg)) = map.get(path) {
            if *at == modified {
                return agg.clone();
            }
        }
    }
    let agg = parse_session(path);
    if let Ok(mut map) = cache.lock() {
        map.insert(path.to_path_buf(), (modified, agg.clone()));
    }
    agg
}

/// `~/.codex/auth.json` からログイン中のアカウントを読む（#226）。
///
/// メールアドレスとプランは `tokens.id_token`（JWT）のペイロードにしか入っていない。
/// **署名は検証しない**: ここは自分のマシンにある自分の認証情報を表示するだけで、
/// 認証の判断には使わない。取り出すのも 2 つのクレームだけで、トークン自体は
/// どこにも出さない。
fn read_account(codex_dir: &Path) -> Option<CodexAccount> {
    // Claude 側（`claude_usage::config`）と同じ理由で TTL に載せる。ログインし直した
    // ときしか変わらない値のために、30 秒ごとに（WSL なら UNC 越しに）読み直さない。
    static CACHE: OnceLock<AccountCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = codex_dir.to_path_buf();
    // ロックが壊れていてもキャッシュを諦めて読むだけ。`?` で返すと、以降ずっと
    // アカウント欄が空のままになる。
    let Ok(mut map) = cache.lock() else {
        return read_account_uncached(codex_dir);
    };
    if let Some((at, account)) = map.get(&key) {
        if at.elapsed() < ACCOUNT_TTL {
            return account.clone();
        }
    }
    let account = read_account_uncached(codex_dir);
    map.insert(key, (Instant::now(), account.clone()));
    account
}

fn read_account_uncached(codex_dir: &Path) -> Option<CodexAccount> {
    let text = fs::read_to_string(codex_dir.join("auth.json")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let auth_mode = json["auth_mode"].as_str().map(str::to_string);
    let claims = json["tokens"]["id_token"]
        .as_str()
        .and_then(jwt_claims)
        .unwrap_or(Value::Null);
    let account = CodexAccount {
        email: claims["email"].as_str().map(str::to_string),
        // プランは OpenAI 独自クレーム（URL がキー名）の中。
        plan: claims["https://api.openai.com/auth"]["chatgpt_plan_type"]
            .as_str()
            .map(str::to_string),
        auth_mode,
    };
    (account.email.is_some() || account.auth_mode.is_some()).then_some(account)
}

/// JWT のペイロードを取り出す。`header.payload.signature` の真ん中だけを
/// base64url としてデコードする。
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn parse_session(path: &Path) -> Option<SessionAgg> {
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

    Some(SessionAgg {
        cwd: cwd?,
        session_id,
        model,
        usage: usage?,
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

    let account = read_account(&codex_dir);
    let mut files = recent_session_files(&sessions_dir);
    if files.is_empty() {
        return Ok(CodexUsageResult { account, ..Default::default() });
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

    // 集計の窓から出たロールアウトはもう使わないので落とす。Pike はトレイに常駐して
    // 何日も動くので、入れっぱなしだと単調に増える。
    //
    // **走査結果（`files`）で retain してはいけない**。キャッシュはプロセス共有で、
    // `codex_home` はシェルごとに違う。WSL と Windows のプロジェクトを同時に開いて
    // いると、片方のポーリングがもう片方のエントリを毎回全部落とし、キャッシュが
    // 効かなくなる。
    prune_session_cache();

    let mut last_activity: Option<SystemTime> = None;
    for (path, modified) in &files {
        let Some(agg) = parse_session_cached(path, *modified) else {
            continue;
        };
        if !cwd_matches_root(shell, &agg.cwd, project_root) {
            continue;
        }
        session_count += 1;
        last_activity = Some(last_activity.map_or(*modified, |t: SystemTime| t.max(*modified)));
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
        return Ok(CodexUsageResult { account, ..Default::default() });
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

    // `active` は「今動いているか」。集計の窓（24h）とは別に、いちばん新しい書き込みが
    // `ACTIVE_WINDOW_SECS` 以内かで決める。
    let now = SystemTime::now();
    let active = last_activity.is_some_and(|t| {
        now.duration_since(t).unwrap_or(Duration::ZERO) <= Duration::from_secs(ACTIVE_WINDOW_SECS)
    });
    let last_activity_at = last_activity.and_then(|t| {
        t.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
    });

    Ok(CodexUsageResult {
        active,
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
        last_activity_at,
        account,
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
