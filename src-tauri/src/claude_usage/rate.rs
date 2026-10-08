//! Claude Code rate-limit usage (`claude -p "/usage"`).
//!
//! The subscription rate-limit state (5h session / weekly windows) lives on
//! Anthropic's servers; the local JSONL logs (`super`) can only count tokens.
//! The official CLI is the only source, so this shells out to
//! `claude -p "/usage"`, parses the `Current …: N% used · resets …` lines and
//! caches the result — the CLI call takes 10s+ (it boots the full agent
//! runtime) and must never run on every status-bar poll.

use crate::types::{ShellConfig, install_key};
use serde::{Deserialize, Serialize};
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
    /// CLI がログインを求めて終わった（#381）。**取得の失敗と区別する**: 以前はどちらも
    /// 「帯が空」に畳まれていたので、ログインが切れても StatusBar は前回の値を出し続け、
    /// 2 時間後に黙って消えるだけだった。
    pub login_required: bool,
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
            .map(|(_, when)| when.trim().to_owned())
            .filter(|s| !s.is_empty());
        let label = label.trim().to_owned();
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

/// **ログアウトが分かっているのに帯を出している答えは、TTL を待たずに捨てる**（#381）。
/// `/logout` した直後のキャッシュは「ログイン済みで残量あり」なので、待つと最長 1 時間
/// 古い残量を出し続ける。1 回取り直せば `login_required` が立って `active` が false に
/// なるので、この枝は自動的に閉じる（叩き続けにならない）。
fn needs_fetch(entry: &CacheEntry, session_active: bool, logged_out: bool) -> bool {
    if logged_out && entry.data.active {
        return true;
    }
    let age = now_epoch().saturating_sub(entry.last_attempt);
    // Failed fetches and active sessions retry on the short TTL; idle windows
    // still refresh eventually (other projects / time-based resets move quota).
    if !entry.data.active || session_active {
        age >= TTL_ACTIVE.as_secs()
    } else {
        age >= TTL_IDLE.as_secs()
    }
}

/// `claude auth status --json` の返り（#381）。読むのは 1 つだけ。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    logged_in: bool,
}

/// CLI に「ログインしているか」を直接聞く（#381）。
///
/// **これが一番確かな印。** `/usage` の文言で見る形は、CLI が未ログインでも `/login` に
/// 触れなくなった版（2.1.278）で丸ごと効かなくなった（`asks_for_login` の doc）。
///
/// **`/usage` より桁違いに軽い**ので、取得のたびに一緒に起こしてよい（この開発機で
/// Windows 0.28 秒 / WSL 0.71 秒、`claude -p "/usage"` は 3.8 秒）。あちらはエージェントの
/// ランタイムを起こすが、こちらは手元の資格情報を読むだけ。
///
/// **`--json` は既定だが明示する**（`--text` もあるので、既定が変わったときに黙って
/// パースが外れないように）。
///
/// **読めなかったら `None`**（＝何も言えない）。`claude` が入っていないシェルでは
/// 毎回ここに来るが、その場合は使用量そのものも取れないので表示は元から空になる。
fn run_auth_status(
    shell: &ShellConfig,
    project_root: &str,
    config_dir: Option<&str>,
) -> Option<bool> {
    let env: Vec<(&str, &str)> = config_dir
        .map(|d| ("CLAUDE_CONFIG_DIR", d))
        .into_iter()
        .collect();
    let (_code, stdout, _stderr) = shell
        .run_shell_line_env(project_root, &env, "claude auth status --json", CLI_TIMEOUT)
        .ok()?;
    // `.bashrc` がバナーを出すことがあるので、JSON の始まりから読む。
    let start = stdout.find('{')?;
    Some(
        serde_json::from_str::<AuthStatus>(&stdout[start..])
            .ok()?
            .logged_in,
    )
}

fn run_usage_cli(
    shell: &ShellConfig,
    project_root: &str,
    config_dir: Option<&str>,
    logged_out: bool,
) -> ClaudeRateLimits {
    // stdin を閉じるのは `types::spawn_piped` の担当になった（#384 で `run` 系の全員へ
    // 引き上げた）。ここが自分で `< /dev/null` を付けていたころの理由（headless claude が
    // piped input を 3 秒待つ）はそのまま生きているが、シェルを起こす側で閉じている。
    let line = "claude -p \"/usage\"".to_owned();
    // `CLAUDE_CONFIG_DIR` はここで明示的に渡す（#225）。この経路は WSL では
    // `bash -c`（非対話・非ログイン）なので、ユーザーが `.bashrc` や `.envrc` で
    // 設定していても、渡さない限り既定の `~/.claude` のアカウントを見てしまう。
    let env: Vec<(&str, &str)> = config_dir
        .map(|d| ("CLAUDE_CONFIG_DIR", d))
        .into_iter()
        .collect();
    let (windows, asked_login) =
        match shell.run_shell_line_env(project_root, &env, &line, CLI_TIMEOUT) {
            Ok((_code, stdout, stderr)) => {
                let windows = parse_usage_output(&stdout);
                let asked = windows.is_empty() && asks_for_login(&stdout, &stderr);
                (windows, asked)
            }
            Err(_) => (Vec::new(), false),
        };
    // **帯が取れたなら聞くまでもない**（ログインしていなければ取れない）。取れなかった
    // ときだけ CLI に直接聞き、それも読めなければ `.claude.json` の印に落ちる。
    let login_required = windows.is_empty()
        && run_auth_status(shell, project_root, config_dir)
            .map_or(logged_out || asked_login, |logged_in| !logged_in);
    ClaudeRateLimits {
        active: !windows.is_empty(),
        fetched_at: now_epoch(),
        windows,
        login_required,
    }
}

/// CLI がログインを求めているか（#381）。文言の前半は版で変わりうるので、**案内している
/// コマンドのほうで見る**。
///
/// **これは最後の手段。** 実装時（CLI 2.0 系）は未ログインが
/// `Not logged in · Please run /login`（終了コード 1）だったが、**2.1.278 では終了コード 0 で
/// `Total cost: $0.00…` の要約だけを出し、`/login` に触れない**（Windows と WSL の両方で実測）。
/// 印の優先順は `run_auth_status`（CLI に直接聞く）→ `config::ClaudeConfig::logged_out`
/// （`.claude.json` から `oauthAccount` が消えている）→ この関数。
fn asks_for_login(stdout: &str, stderr: &str) -> bool {
    stdout.contains("/login") || stderr.contains("/login")
}

pub(crate) fn get_rate_limits(
    shell: &ShellConfig,
    project_root: &str,
    session_active: bool,
    force: bool,
) -> ClaudeRateLimits {
    let resolved = super::config::resolve(shell, project_root);
    let logged_out = resolved.logged_out;
    let config_dir = resolved.native_override;
    let key = cache_key(shell, config_dir.as_deref());

    let cached = cache().lock().unwrap().get(&key).cloned();
    if let Some(entry) = &cached
        && !force
        && !needs_fetch(entry, session_active, logged_out)
    {
        return entry.data.clone();
    }

    let _guard = fetch_lock().lock().unwrap();
    // Double-check: another caller may have fetched while we waited on the lock.
    if !force
        && let Some(entry) = cache().lock().unwrap().get(&key)
        && !needs_fetch(entry, session_active, logged_out)
    {
        return entry.data.clone();
    }

    let mut result = run_usage_cli(shell, project_root, config_dir.as_deref(), logged_out);
    // Keep the previous data when a refresh fails (CLI hiccup / timeout) —
    // stale rate info beats a flickering status item. Bounded by
    // STALE_KEEP_MAX so a permanently broken CLI (uninstalled, output format
    // changed) eventually makes the item disappear instead of showing
    // hours-old percentages. `last_attempt` advances either way, so retries
    // stay paced at TTL_ACTIVE.
    // **ログインを求められたときは古い値に戻さない**（#381）。その値はもう手に入らない
    // ことが確定していて、出し続けると「ログインが切れている」ことが見えなくなる。
    if !result.active
        && !result.login_required
        && let Some(prev) = cached.map(|c| c.data).filter(|d| d.active)
        && now_epoch().saturating_sub(prev.fetched_at) < STALE_KEEP_MAX.as_secs()
    {
        result = prev;
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
    // 同梱の mod が報告した値（#437）。**新しいあいだは CLI を idle の間隔へ落とす**:
    // 動いているセッションが毎分知らせてくるので、5 分ごとに `claude -p "/usage"`
    // （起動に 10 秒超、時々ハング）を起こす理由が無い。CLI を完全には止めないのは、
    // モデル別の枠が mod の報告に無いため。
    //
    // **設定ディレクトリは CLI のキャッシュと同じ解決結果で引く**（アカウントの取り違えを
    // 作らない）。既定の `~/.claude` で申告も無いプロジェクト（`native_override` が無い）は
    // 対象外で、これまでどおり CLI だけになる。mod が動けば申告が届くので、そこで拾える。
    let reported = super::config::resolve(shell, project_root)
        .native_override
        .and_then(|dir| crate::agent_hook::reported_usage(&install_key(shell), &dir))
        .filter(|r| now_epoch().saturating_sub(r.at) < REPORT_FRESH.as_secs());
    let cli = cli_rate_limits_soon(
        shell,
        project_root,
        session_active && reported.is_none(),
        force,
    );
    match reported {
        Some(report) => overlay_reported(cli, &report.windows, report.at),
        None => cli,
    }
}

/// mod の報告 1 件を CLI の `kind` と表示名へ写す。知らない枠（ゲートウェイの
/// `spend_limit` など）は載せない: 表示側が持っているのは 5h と週間の 2 つだけ。
fn reported_window(w: &crate::agent_hook::ReportedWindow) -> Option<ClaudeRateWindow> {
    // 表示名は CLI のものに合わせる（`kind` は CLI と同じ `window_kind` が決める）。
    let label = match w.kind.as_str() {
        "five_hour" => "session",
        "seven_day" => "week (all models)",
        _ => return None,
    };
    Some(ClaudeRateWindow {
        label: label.to_owned(),
        kind: window_kind(label),
        used_percent: w.percent_used,
        resets_at: w.resets_at.clone(),
    })
}

/// CLI の結果に mod の報告を重ねる（#437）。**同じ `kind` の枠だけ差し替え、残り
/// （モデル別の枠）は CLI のものを残す。** 報告に無い枠を消すと、mod が動いているあいだ
/// モデル別の残量が見えなくなる。
///
/// `resets_at` は ISO 8601 のまま渡る（CLI は `Jul 2, 2:39pm (Asia/Tokyo)` の形）。
/// 表示の整形はフロントの `lib/usageFormat.ts` が両方を受ける。
fn overlay_reported(
    mut data: ClaudeRateLimits,
    windows: &[crate::agent_hook::ReportedWindow],
    at: u64,
) -> ClaudeRateLimits {
    let reported: Vec<ClaudeRateWindow> = windows.iter().filter_map(reported_window).collect();
    if reported.is_empty() {
        return data;
    }
    data.windows
        .retain(|w| reported.iter().all(|r| r.kind != w.kind));
    // 5h → 週間 → モデル別、の並びを保つ（CLI の出力順）。
    data.windows.splice(0..0, reported);
    data.active = true;
    data.fetched_at = at;
    // 値が届いている以上、ログインはしている。
    data.login_required = false;
    data
}

/// mod の報告を「いまの値」として扱う幅。mod は動いているあいだ毎分送ってくるので、
/// これより古ければセッションが終わっている（＝他の場所で枠が動いても分からない）。
const REPORT_FRESH: Duration = TTL_ACTIVE;

fn cli_rate_limits_soon(
    shell: &ShellConfig,
    project_root: &str,
    session_active: bool,
    force: bool,
) -> ClaudeRateLimits {
    if force {
        return get_rate_limits(shell, project_root, session_active, true);
    }
    let resolved = super::config::resolve(shell, project_root);
    let logged_out = resolved.logged_out;
    let config_dir = resolved.native_override;
    let key = cache_key(shell, config_dir.as_deref());
    let cached = cache().lock().unwrap().get(&key).cloned();
    let stale = cached
        .as_ref()
        .is_none_or(|entry| needs_fetch(entry, session_active, logged_out));

    if stale {
        // 既に走っていれば足さない（`fetch_lock` でも直列化されるが、待つスレッドを
        // 積み上げない）。
        let started = refreshing()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone());
        if started {
            let (shell, root) = (shell.clone(), project_root.to_owned());
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
    use super::{
        CacheEntry, ClaudeRateLimits, asks_for_login, needs_fetch, now_epoch, parse_usage_output,
        window_kind,
    };

    fn entry(active: bool, age_secs: u64) -> CacheEntry {
        CacheEntry {
            last_attempt: now_epoch() - age_secs,
            data: ClaudeRateLimits {
                active,
                ..Default::default()
            },
        }
    }

    /// mod の報告は同じ種類の枠だけを差し替え、モデル別の枠は CLI のものを残す（#437）。
    #[test]
    fn overlay_replaces_matching_windows_and_keeps_the_rest() {
        use crate::agent_hook::ReportedWindow;
        let cli = ClaudeRateLimits {
            active: true,
            fetched_at: 100,
            windows: parse_usage_output(
                "Current session: 10% used · resets Jul 2, 2:39pm (Asia/Tokyo)\n\
                 Current week (all models): 20% used\n\
                 Current week (Fable): 30% used\n",
            ),
            login_required: false,
        };
        let reported = [
            ReportedWindow {
                kind: "five_hour".to_owned(),
                percent_used: 15.0,
                resets_at: Some("2026-10-05T17:50:00.000Z".to_owned()),
            },
            ReportedWindow {
                kind: "spend_limit".to_owned(),
                percent_used: 1.0,
                resets_at: None,
            },
        ];
        let merged = super::overlay_reported(cli, &reported, 200);
        let shape: Vec<(&str, f64)> = merged
            .windows
            .iter()
            .map(|w| (w.label.as_str(), w.used_percent))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("session", 15.0),
                ("week (all models)", 20.0),
                ("week (Fable)", 30.0)
            ]
        );
        assert_eq!(merged.fetched_at, 200);
        assert_eq!(
            merged.windows[0].resets_at.as_deref(),
            Some("2026-10-05T17:50:00.000Z")
        );
    }

    /// CLI がまだ何も持っていなくても、mod の報告だけで帯を出せる。知らない枠だけの
    /// 報告では何も変えない。
    #[test]
    fn overlay_alone_activates_and_unknown_kinds_change_nothing() {
        use crate::agent_hook::ReportedWindow;
        let window = |kind: &str| ReportedWindow {
            kind: kind.to_owned(),
            percent_used: 43.0,
            resets_at: None,
        };
        let merged = super::overlay_reported(
            ClaudeRateLimits {
                login_required: true,
                ..Default::default()
            },
            &[window("seven_day")],
            7,
        );
        assert!(merged.active && !merged.login_required);
        assert_eq!(merged.windows[0].kind, "weekAll");

        let untouched =
            super::overlay_reported(ClaudeRateLimits::default(), &[window("spend_limit")], 7);
        assert!(!untouched.active && untouched.windows.is_empty());
    }

    /// `claude auth status --json` の形（実ファイルから抜粋）。`.bashrc` のバナーが
    /// 先に出ても読めること、余分なキーがあっても落ちないことを見る。
    #[test]
    fn reads_logged_in_out_of_auth_status() {
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"k@example.com","subscriptionType":"max"}"#;
        let parsed: super::AuthStatus = serde_json::from_str(json).unwrap();
        assert!(parsed.logged_in);

        let out = format!(
            "On branch main
{}",
            r#"{"loggedIn":false,"authMethod":"none"}"#
        );
        let start = out.find('{').unwrap();
        let parsed: super::AuthStatus = serde_json::from_str(&out[start..]).unwrap();
        assert!(!parsed.logged_in);
    }

    /// ログアウトが分かっているのに残量を出している答えは、TTL を待たずに捨てる（#381）。
    #[test]
    fn logged_out_drops_a_stale_active_answer() {
        // 取ったばかりでも捨てる（普段なら 1 時間は使い回す）。
        assert!(needs_fetch(&entry(true, 5), false, true));
        // 取り直したあとは `active` が false になるので、叩き続けにならない。
        assert!(!needs_fetch(&entry(false, 5), false, true));
        // ログアウトが分かっていないときは従来どおり TTL で決める。
        assert!(!needs_fetch(&entry(true, 5), false, false));
        assert!(needs_fetch(&entry(true, 4000), false, false));
    }

    #[test]
    fn detects_the_login_prompt() {
        assert!(asks_for_login("Not logged in · Please run /login\n", ""));
        assert!(asks_for_login(
            "",
            "OAuth token has expired. Please run /login"
        ));
        assert!(!asks_for_login("Current session: 20% used", ""));
        assert!(!asks_for_login("", "timeout"));
    }

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
