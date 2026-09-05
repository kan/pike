//! opencode の使用量（#263）。
//!
//! **出所は `opencode db "<SQL>" --format json`。** opencode 自身が SQLite を引く口を
//! 持っているので、Pike に SQLite の依存を足さずに済む（`gh` や `claude -p "/usage"` と
//! 同じく、コマンドを 1 本走らせて JSON を読む）。`opencode stats` もあるが、あちらは
//! 罫線付きの表で JSON を出せないので採らない。
//!
//! **利用率は返さない。** opencode は BYOK（利用者が自分のキーで各プロバイダに繋ぐ）なので、
//! 「枠の何 %」という概念がそもそも無い。出せるのはトークンと費用。
//!
//! **SQL に外から来た値を埋めない。** プロジェクトの root で絞れば速いが、そのために
//! 文字列を組み立てると、この 1 箇所のためにエスケープの正しさを抱えることになる。
//! 新しい順に上限つきで取り、突き合わせは Rust 側の `cwd_matches_root` で行う
//! （件数はセッション数ぶんで、`codex_usage` が JSONL を舐めるより軽い）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::types::{cwd_matches_root, install_key, ShellConfig, LOGIN_PROBE_TIMEOUT};

use super::{fact, now_secs, AgentUsage, TokenRow, ACTIVE_WINDOW_SECS, RECENT_WINDOW_SECS};

/// `time_*` はミリ秒なので、共有の窓を ms に直して使う。
const ACTIVE_WINDOW_MS: i64 = ACTIVE_WINDOW_SECS as i64 * 1000;
const RECENT_WINDOW_MS: i64 = RECENT_WINDOW_SECS as i64 * 1000;
/// 1 回に取る行数の上限。
const MAX_ROWS: usize = 200;

/// 同じ問い合わせを繰り返すまでの間隔。
///
/// **4 つのアダプタのうち、外部プロセスを起こすのはここだけ。** 30 秒のポーリングに
/// 素直に乗せると `opencode`（node）の起動が 30 秒ごと、WSL プロジェクトではそこに
/// `wsl.exe` の起動が乗る。出す数字は 24 時間の集計なので、2 分の遅れは意味を持たない。
/// 更新ボタン（`force`）は素通しする。
const QUERY_TTL: Duration = Duration::from_secs(120);
/// `opencode db` に待てる時間。ローカルの SQLite を引くだけなので短くてよい。
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// JSON の始まりを示す目印。
///
/// **「先頭の `[` から読む」では足りない。** rc がバナーを stdout に出すことがあり、この
/// 開発機の `.bashrc` は `[dotfiles] 未コミットの変更があります: …` と**`[` で始まる行**を
/// 出す（実測。それを JSON の頭と誤認して、常に空を返していた）。行の位置でも選べないので、
/// `shell_probe` の `PIKEENV` / `PIKEAGENT` と同じく目印を出させて、その後ろを読む。
const JSON_MARKER: &str = "PIKEJSON";

/// **`time_*` はミリ秒**（実測でカラムの型は INTEGER、opencode は TypeScript 実装）。
const QUERY: &str =
    "select directory, model, cost, tokens_input, tokens_output, tokens_reasoning, \
     tokens_cache_read, tokens_cache_write, time_updated from session \
     order by time_updated desc limit 200";

#[derive(Debug, Clone, Deserialize)]
struct Row {
    directory: Option<String>,
    model: Option<String>,
    cost: Option<f64>,
    tokens_input: Option<i64>,
    tokens_output: Option<i64>,
    tokens_reasoning: Option<i64>,
    tokens_cache_read: Option<i64>,
    tokens_cache_write: Option<i64>,
    time_updated: Option<i64>,
}

fn non_negative(v: Option<i64>) -> u64 {
    v.unwrap_or(0).max(0) as u64
}

/// 目印の**後ろ**を JSON として読む。目印が無ければ（コマンドが落ちた等）空。
fn parse_rows(stdout: &str) -> Vec<Row> {
    stdout
        .split_once(JSON_MARKER)
        .and_then(|(_, rest)| serde_json::from_str(rest.trim_start()).ok())
        .unwrap_or_default()
}

/// モデル名。**`model` 列は JSON の文字列**（実測で
/// `{"id":"big-pickle","providerID":"opencode"}`）なので、そのまま出すと表のモデル欄に
/// JSON が並ぶ。`providerID/id` に畳み、解けなければ字面のまま返す（列の中身は opencode の
/// もので、こちらは追随するだけ）。
fn model_label(raw: Option<String>) -> Option<String> {
    let raw = raw.filter(|s| !s.trim().is_empty())?;
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Some(raw);
    };
    let id = v["id"].as_str();
    let provider = v["providerID"].as_str();
    match (provider, id) {
        (Some(p), Some(i)) => Some(format!("{p}/{i}")),
        (None, Some(i)) => Some(i.to_string()),
        _ => Some(raw),
    }
}

/// `opencode db` を走らせて JSON の行を返す。**失敗は「記録なし」**（未導入・未ログイン・
/// スキーマ変更のどれでも、状態画面に空を出せばよい）。
///
/// **入っていなければ走らせない。** 4 つのアダプタのうち外部プロセスを起こすのはここだけで、
/// 30 秒ごとのポーリングに素直に乗せると、**opencode を入れていないマシンでも**ウィンドウの
/// 数だけ `wsl.exe` が 30 秒ごとに上がる（`command not found` でも冷えた WSL の起動は
/// 丸ごと払う）。起動ボタンの検出と同じ答え（`shell_probe::agent_bins`。導入単位で 5 分
/// キャッシュされ、対話ログインシェルの probe に相乗りする）を先に見る。
fn query(shell: &ShellConfig, root: &str, force: bool) -> Vec<Row> {
    if !crate::shell_probe::agent_bins(shell, root, &["opencode".to_string()]).contains("opencode")
    {
        return Vec::new();
    }

    // キーは**導入単位**（DB はインストールに 1 つで、プロジェクトでは変わらない）。
    // ウィンドウを何枚開いても、間隔のあいだに走るのは 1 回。
    type QueryCache = Mutex<HashMap<String, (Instant, Vec<Row>)>>;
    static CACHE: OnceLock<QueryCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = install_key(shell);
    if !force {
        if let Ok(map) = cache.lock() {
            if let Some((at, rows)) = map.get(&key) {
                if at.elapsed() < QUERY_TTL {
                    return rows.clone();
                }
            }
        }
    }
    // **二重引用符で囲む。** POSIX では bash、Windows では `cmd.exe /C` を通るので、
    // どちらでも同じ意味を持つ囲み方はこれだけ。囲みが効くためには中身に引用符やメタ文字が
    // 無いことが要る（`the_query_is_safe_in_both_shells`）。
    let query = format!("opencode db \"{QUERY}\" --format json");

    // **検出と同じ起こし方で走らせる**（POSIX は対話ログインシェル）。ここを非対話の
    // `run_shell_line` にすると、**検出とは別の実体を掴む**: `~/.opencode/bin` を PATH へ
    // 足すのは rc なので、非対話では WSL が継いだ Windows 側の PATH から
    // `/mnt/c/…/npm/opencode` が先に見つかり、**Windows のデータベース**を読んで常に空を
    // 返す（実測）。`gh` の「探し方と走らせ方を揃える」（`editor.md`）と同じ話の裏返し。
    //
    // **cwd は要らない**。`opencode db` が読むのはインストールに 1 つのデータベースで、
    // どのディレクトリで走らせても同じ答えになる（プロジェクトの突き合わせは
    // `directory` 列で行う）。
    let stdout = if shell.is_posix() {
        let script = format!("printf '{JSON_MARKER}\\n'\n{query}");
        let Some(out) = shell.run_login_script(&script, LOGIN_PROBE_TIMEOUT) else {
            return Vec::new();
        };
        out
    } else {
        // Windows シェルは Pike のプロセス環境を継ぐので、起動ボタンが走らせるものと同じ。
        let dir = if root.trim().is_empty() { "." } else { root };
        match shell.run_shell_line(dir, &format!("echo {JSON_MARKER}& {query}"), TIMEOUT) {
            Ok((0, stdout, _)) => stdout,
            _ => return Vec::new(),
        }
    };
    let rows: Vec<Row> = parse_rows(&stdout);
    if let Ok(mut map) = cache.lock() {
        map.insert(key, (Instant::now(), rows.clone()));
    }
    rows
}

pub fn collect(shell: &ShellConfig, root: &str, force: bool) -> AgentUsage {
    let mut usage = AgentUsage::for_id("opencode");
    usage.fetched_at = now_secs();

    let now_ms = now_secs().map(|s| s as i64 * 1000).unwrap_or(0);
    let mut total = TokenRow::default();
    let mut cost = 0.0;
    let mut has_cost = false;
    let mut sessions = 0u32;
    let mut last_activity: Option<i64> = None;
    let mut model: Option<String> = None;

    for row in query(shell, root, force).into_iter().take(MAX_ROWS) {
        let Some(dir) = row.directory.as_deref() else {
            continue;
        };
        if !cwd_matches_root(shell, dir, root) {
            continue;
        }
        let updated = row.time_updated.unwrap_or(0);
        // 未来の時刻は「今」として扱う（時計のずれ。`codex_usage` と同じ）。
        let age = (now_ms - updated).max(0);
        if age > RECENT_WINDOW_MS {
            continue;
        }
        sessions += 1;
        total.input += non_negative(row.tokens_input);
        total.output += non_negative(row.tokens_output);
        total.reasoning += non_negative(row.tokens_reasoning);
        total.cache_read += non_negative(row.tokens_cache_read);
        total.cache_write += non_negative(row.tokens_cache_write);
        if let Some(c) = row.cost {
            cost += c;
            has_cost = true;
        }
        if age <= ACTIVE_WINDOW_MS {
            usage.active = true;
        }
        if last_activity.is_none() || last_activity.is_some_and(|prev| updated > prev) {
            last_activity = Some(updated);
            model = row.model.clone();
        }
    }

    if sessions == 0 {
        return usage;
    }
    total.label = model_label(model);
    total.cost_usd = has_cost.then_some(cost);
    usage.total = Some(total);
    usage
        .facts
        .push(fact("session-count", sessions.to_string()));
    if let Some(ms) = last_activity {
        usage
            .facts
            .push(fact("last-activity", (ms / 1000).to_string()));
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **SQL に外から来た値を埋めない**という不変条件（モジュールの doc）と、二重引用符で
    /// 囲むだけで bash と `cmd.exe /C` の両方に同じ意味で渡せること。
    #[test]
    fn the_query_is_safe_in_both_shells() {
        assert!(QUERY.contains("from session"));
        assert!(QUERY.contains("limit 200"));
        // 囲みを破る文字と、cmd が囲みの中でも解釈する `%`。
        for c in ['"', '\'', '%', '&', '|', '<', '>', '^', '\n'] {
            assert!(!QUERY.contains(c), "QUERY に {c:?} が入っている");
        }
    }

    #[test]
    fn parses_the_rows_opencode_prints() {
        let json = r#"[{"directory":"/home/kan/pike","model":"anthropic/claude","cost":0.5,
          "tokens_input":10,"tokens_output":20,"tokens_reasoning":1,
          "tokens_cache_read":2,"tokens_cache_write":3,"time_updated":1788600000000}]"#;
        let rows: Vec<Row> = serde_json::from_str(json).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].directory.as_deref(), Some("/home/kan/pike"));
        assert_eq!(non_negative(rows[0].tokens_input), 10);
    }

    /// `model` 列は JSON の文字列で来る（実測）。表のモデル欄に JSON を出さない。
    #[test]
    fn folds_the_model_json_into_a_name() {
        assert_eq!(
            model_label(Some(
                r#"{"id":"big-pickle","providerID":"opencode"}"#.to_string()
            )),
            Some("opencode/big-pickle".to_string())
        );
        // 解けない値は字面のまま（列の形が変わっても、名前が消えるより読める）。
        assert_eq!(
            model_label(Some("claude-sonnet-5".to_string())),
            Some("claude-sonnet-5".to_string())
        );
        assert_eq!(model_label(Some(String::new())), None);
        assert_eq!(model_label(None), None);
    }

    /// **`[` で始まるバナーに引っかからない。** この開発機の `.bashrc` は
    /// `[dotfiles] 未コミットの変更があります: …` を stdout に出していて、「先頭の `[` から
    /// 読む」形だとそれを JSON の頭と誤認し、opencode のカードが**常に出なかった**（実測）。
    #[test]
    fn skips_a_banner_that_starts_with_a_bracket() {
        let stdout = "[dotfiles] 未コミットの変更があります: cd /home/kan/dotfiles\n\
                      PIKEJSON\n[{\"directory\":\"/home/kan/dotfiles\",\"tokens_input\":10}]\n";
        let rows = parse_rows(stdout);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].directory.as_deref(), Some("/home/kan/dotfiles"));
    }

    /// 目印が無い（コマンドが落ちた・シェルが起動できなかった）なら空。
    #[test]
    fn no_marker_means_no_rows() {
        assert!(parse_rows("bash: opencode: command not found\n").is_empty());
        assert!(parse_rows("").is_empty());
    }

    /// 欄が欠けていても落ちない（スキーマは opencode のもので、こちらは追随するだけ）。
    #[test]
    fn tolerates_missing_columns() {
        let rows: Vec<Row> = serde_json::from_str(r#"[{"directory":"/x"}]"#).unwrap();
        assert_eq!(non_negative(rows[0].tokens_output), 0);
        assert!(rows[0].cost.is_none());
    }
}
