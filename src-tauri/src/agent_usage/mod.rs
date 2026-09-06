//! エージェントの使用量を**種別に依らない形**で返す（#275 / #263）。
//!
//! **UI は種別を知らない。** `agent_usage(id, …)` が id ごとのアダプタへ振り分け、どの
//! エージェントでも同じ `AgentUsage` を返す。StatusBar もエージェント状態タブも、返って
//! きたものを並べるだけにする。対応を増やすときに触るのはここのアダプタ 1 つと、フロントの
//! 表（`src/lib/agents.ts`）の 1 行だけ。
//!
//! **4 つで取れるものが揃わないのが前提。** 実測（2026-09-05）で分かった出所は次のとおりで、
//! 「利用率がある」と決め打ちできる形にはできない。
//!
//! | id | 出所 | 取れるもの |
//! |---|---|---|
//! | `claude` | `~/.claude` の JSONL ＋ `claude -p "/usage"` | トークン・費用・利用率 |
//! | `codex` | `~/.codex` の rollout JSONL | トークン・費用・利用率 |
//! | `copilot` | `~/.copilot/session-state/*/events.jsonl` | premium request 数（トークンは無い） |
//! | `opencode` | `opencode db "<SQL>" --format json` | トークン・費用（利用率は無い。BYOK） |
//!
//! だから `meters` も `tokens` も**空でありうる**。埋まっているものだけ描く、というのが
//! フロント側の契約。
//!
//! **文言は持たない。** `facts` が返すのは `AgentFactKey` の固定の集合（`config-dir` など）で、
//! 表示名はフロントが `Record<AgentFactKey, i18nKey>` で引く。Rust に i18n キーを置くと、
//! 語彙が 2 つのファイルに散る（`menus_refresh` がラベルをフロントから受け取っているのと
//! 同じ分担で、語彙を持つ側は 1 つ）。

// **`agent_sessions` からも読む**（#267）。エージェントの記録の置き場と読み方を知って
// いるのはこの 2 つなので、セッション一覧もここから出す。
pub(crate) mod copilot;
pub(crate) mod opencode;

use serde::{Deserialize, Serialize};

use crate::types::ShellConfig;

/// 「今動いているか」の窓。
///
/// **4 つのアダプタで同じ長さにする。** 並べて見比べる画面なので、片方だけ「実行中」の
/// 判定が違うと数字の意味が揃わない。`codex_usage` も同じものを使う（以前は各モジュールに
/// 同じ数字が写されていた）。
pub(crate) const ACTIVE_WINDOW_SECS: u64 = 300;

/// 集計に含める記録の新しさ。`ACTIVE_WINDOW_SECS` が「今動いているか」なのに対し、
/// こちらは「最近このプロジェクトでどれだけ使ったか」の範囲（#226）。分けないと、
/// 5 分前に終わった作業が状態画面から丸ごと消える。
pub(crate) const RECENT_WINDOW_SECS: u64 = 24 * 60 * 60;

/// Pike が知っているエージェント（`src/lib/agents.ts` の `AgentId` と同じ綴り）。
///
/// **フロントの `AGENTS` と同じ綴り。** ここを enum にしてあるのは、`agents.ts` の表が
/// 「使用量まで運ぶなら継ぎ目を `AgentId` に上げる」と約束しているため。生の文字列で
/// `match` していると、表に 5 つ目を足して綴りがずれても**黙って空のカードが出る**だけで、
/// コンパイルも実行も通ってしまう。
///
/// **`Unknown` は残す。** フロントの表に足した id を Rust のアダプタより先に出せるように
/// するため（そのときは「まだ集めない」が正しい振る舞いで、状態画面が丸ごとエラーになる
/// 理由が無い）。
/// **使用量以外の継ぎ目でも使う。** 入力待ちの通知（#265）が hook から受けた id を
/// これに通すので、`Serialize` も要る（フロントへ返す `AgentNotice` の欄）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
    Codex,
    Copilot,
    Opencode,
    #[serde(other)]
    Unknown,
}

impl AgentId {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Copilot => "copilot",
            AgentId::Opencode => "opencode",
            AgentId::Unknown => "",
        }
    }
}

/// 利用率の帯 1 本。
///
/// **`kind` で引く。** CLI が印字した `label` を表示に使うのは `other` のときだけで、
/// フロントは文言を文字列一致しない（`claude_usage/rate.rs` の `window_kind` と同じ規約）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMeter {
    /// `session` / `weekAll` / `other`。
    pub kind: String,
    /// CLI が印字したままのラベル（`other` のときだけ表示に使う）。
    pub label: Option<String>,
    pub used_percent: f64,
    /// リセット時刻の説明。CLI の文言をそのまま持つ（無いエージェントは `None`）。
    pub resets_at: Option<String>,
}

/// トークンの内訳 1 行（合計、またはモデル別）。
///
/// **持たない欄は 0**（`Option` にしない）。4 つのうち 3 つは cache や reasoning を
/// 持つので、欄ごとに有無を持たせると読む側の分岐が増える。「全部 0 なら出さない」は
/// 描く側が決める。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRow {
    /// 行の名前（モデル名など）。合計の行では `None`。
    pub label: Option<String>,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
    /// 費用の見積もり（USD）。単価を持たないモデルでは `None`。
    pub cost_usd: Option<f64>,
}

/// 種別固有の値。**キーは閉じた集合**で、表示名はフロントが引く（モジュールの doc）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFact {
    /// `config-dir` / `session-count` / `last-activity` / `premium-requests` / `auth-mode`。
    pub key: String,
    pub value: String,
}

/// ログインしている人。**3 つの欄しか持たない**（4 つのエージェントで共通に取れるもの）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub email: Option<String>,
    /// メールアドレスを持たないアカウントの表示名。**落とさないこと**: `.claude.json` の
    /// `oauthAccount` は `emailAddress` を持たずに名前だけ載っていることがあり、落とすと
    /// 「アカウントが取れていない」ように見える。
    pub name: Option<String>,
    pub plan: Option<String>,
    pub organization: Option<String>,
}

/// UI が読む唯一の形。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// フロントの表と同じ id。**返ってきたものが誰のものか**を、呼んだ側でなく値が持つ。
    pub id: String,
    /// いま動いているか。**`createUsageStore` の契約**（`{ active: boolean }`）に合わせた名前。
    pub active: bool,
    pub account: Option<AgentAccount>,
    /// 利用率の帯。持たないエージェントでは空。
    pub meters: Vec<UsageMeter>,
    /// 期間内の合計。トークンを持たないエージェント（copilot）では `None`。
    pub total: Option<TokenRow>,
    /// モデル別などの内訳。持たないエージェントでは空。
    pub rows: Vec<TokenRow>,
    /// 種別固有の値。
    pub facts: Vec<UsageFact>,
    /// データを取った時刻（epoch 秒）。表示の鮮度に使う。
    pub fetched_at: Option<u64>,
}

impl AgentUsage {
    fn for_id(id: &str) -> Self {
        Self {
            id: id.to_string(),
            ..Default::default()
        }
    }
}

fn fact(key: &str, value: impl Into<String>) -> UsageFact {
    UsageFact {
        key: key.to_string(),
        value: value.into(),
    }
}

fn now_secs() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// そのエージェントの使用量。
///
/// **知らない id は空で返す**（`Err` にしない。理由は `AgentId` の doc）。
#[tauri::command]
pub async fn agent_usage(
    id: AgentId,
    shell: ShellConfig,
    project_root: String,
    force: bool,
) -> Result<AgentUsage, String> {
    tokio::task::spawn_blocking(move || match id {
        AgentId::Claude => Ok(claude(&shell, &project_root, force)),
        AgentId::Codex => Ok(codex(&shell, &project_root)),
        AgentId::Copilot => Ok(copilot::collect(&shell, &project_root)),
        AgentId::Opencode => Ok(opencode::collect(&shell, &project_root, force)),
        AgentId::Unknown => Ok(AgentUsage::for_id(id.as_str())),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Claude。**usage と rate を 1 回で返す**（フロントに 2 つのストアを持たせない）。
/// `session_active` は自分で求められるので、呼び出し側から渡す必要も無くなった。
fn claude(shell: &ShellConfig, root: &str, force: bool) -> AgentUsage {
    let usage = crate::claude_usage::get_usage_for_project(shell, root).unwrap_or_default();
    // **待たない版を使う**（理由はあちらの doc）。ディスクを読むだけの `usage` が、
    // CLI の 90 秒に付き合わされないようにするため。
    let rate = crate::claude_usage::rate::get_rate_limits_soon(shell, root, usage.active, force);

    let mut facts = Vec::new();
    if let Some(dir) = usage.config_dir.clone() {
        facts.push(fact("config-dir", dir));
    }

    AgentUsage {
        id: "claude".to_string(),
        active: usage.active,
        account: usage.account.as_ref().map(|a| AgentAccount {
            email: a.email.clone(),
            name: a.display_name.clone(),
            plan: a.plan.clone(),
            organization: a.organization.clone(),
        }),
        // **`active` でないときは帯を出さない**（`useAgentUsage` が今までやっていた判定を
        // ここへ寄せた）。CLI から一度も取れていないときの `windows` は空だが、期限切れの
        // 古い値を持っていることもある。
        meters: if rate.active {
            rate.windows
                .iter()
                .map(|w| UsageMeter {
                    kind: w.kind.to_string(),
                    label: Some(w.label.clone()),
                    used_percent: w.used_percent,
                    resets_at: w.resets_at.clone(),
                })
                .collect()
        } else {
            Vec::new()
        },
        total: Some(TokenRow {
            label: None,
            input: usage.total_input_tokens,
            output: usage.total_output_tokens,
            cache_read: usage.total_cache_read_tokens,
            cache_write: usage.total_cache_creation_tokens,
            reasoning: 0,
            cost_usd: usage.estimated_cost_usd,
        }),
        rows: usage
            .models
            .iter()
            .map(|m| TokenRow {
                label: Some(m.model.clone()),
                input: m.input_tokens,
                output: m.output_tokens,
                cache_read: m.cache_read_tokens,
                cache_write: m.cache_creation_tokens,
                reasoning: 0,
                cost_usd: m.cost_usd,
            })
            .collect(),
        facts,
        // **レートを取った時刻**（トークンの集計はディスクを読むだけで常に最新）。
        // 表示の「いつ時点か」はこちらが持つ。
        fetched_at: rate.active.then_some(rate.fetched_at),
    }
}

/// Codex。**集計の窓（24 時間）と `active`（5 分）は向こうが分けている**ので、そのまま運ぶ。
fn codex(shell: &ShellConfig, root: &str) -> AgentUsage {
    let usage = crate::codex_usage::get_usage_for_project(shell, root).unwrap_or_default();

    // **記録が無ければ何も付けない。** `session-count: 0` を返すと、`hasData` が
    // 「facts がある」で真になり、`~/.codex` を持たないマシンでも状態タブに Codex の
    // カードが出続ける（StatusBar のエージェント項目も消えなくなる）。他の 2 つの
    // アダプタと同じく、使っていないエージェントは id だけ返す。
    if usage.session_count == 0 && usage.account.is_none() {
        return AgentUsage {
            fetched_at: now_secs(),
            ..AgentUsage::for_id("codex")
        };
    }

    let mut meters = Vec::new();
    if let Some(w) = &usage.rate_limit_primary {
        meters.push(UsageMeter {
            kind: "session".to_string(),
            label: None,
            used_percent: w.used_percent,
            resets_at: None,
        });
    }
    if let Some(w) = &usage.rate_limit_secondary {
        meters.push(UsageMeter {
            kind: "weekAll".to_string(),
            label: None,
            used_percent: w.used_percent,
            resets_at: None,
        });
    }

    let mut facts = vec![fact("session-count", usage.session_count.to_string())];
    if let Some(at) = usage.last_activity_at {
        facts.push(fact("last-activity", at.to_string()));
    }
    if let Some(mode) = usage.account.as_ref().and_then(|a| a.auth_mode.clone()) {
        facts.push(fact("auth-mode", mode));
    }

    AgentUsage {
        id: "codex".to_string(),
        active: usage.active,
        account: usage.account.as_ref().map(|a| AgentAccount {
            email: a.email.clone(),
            name: None,
            plan: a.plan.clone(),
            organization: None,
        }),
        meters,
        total: Some(TokenRow {
            label: usage.model.clone(),
            input: usage.total_input_tokens,
            output: usage.total_output_tokens,
            cache_read: usage.total_cached_input_tokens,
            cache_write: 0,
            reasoning: usage.total_reasoning_tokens,
            cost_usd: usage.estimated_cost_usd,
        }),
        rows: Vec::new(),
        facts,
        fetched_at: now_secs(),
    }
}
