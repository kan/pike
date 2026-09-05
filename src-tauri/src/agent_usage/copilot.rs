//! Copilot CLI の使用量（#263）。
//!
//! **単位は premium request（AI クレジット）で、トークンではない。** 実測（1.0.83）で
//! 分かったこと:
//!
//! - **残量を非対話で聞く口が無い。** `/usage` は対話中のスラッシュコマンド、
//!   `--usage-output-file` は**非対話実行の終了後**に JSON を書くもので、どちらも
//!   「今どれだけ残っているか」を聞く手段ではない。だから `meters`（利用率の帯）は返さない
//! - **記録はディスクに残る。** `~/.copilot/session-state/<uuid>/events.jsonl` に
//!   `session.start`（`data.context.cwd`）と `session.usage_checkpoint`
//!   （`data.totalPremiumRequests`）が入るので、Codex の rollout 解析と同じ形で読める
//! - **トークン数は events.jsonl に無い**（`--usage-output-file` と `session-store.db` の側）。
//!   SQLite を読むには依存が要るうえ、利用者に見える単位は premium request なので追わない
//!
//! 走査の打ち切りと窓の考え方は `codex_usage` と揃えてある（あちらの doc が正本）。

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use crate::types::{cwd_matches_root, wsl_home_subdir_cached, ShellConfig};

use super::{fact, now_secs, AgentUsage, ACTIVE_WINDOW_SECS, RECENT_WINDOW_SECS};

/// 1 回の走査で読むセッションの上限。**新しい順に見る**ので、超えたぶんは古いもの。
const MAX_SESSIONS: usize = 200;
/// 1 つの `events.jsonl` から読む量の上限。長いセッションでも先頭と末尾は要らない
/// （欲しい 2 種のイベントは行単位なので、途中で打ち切っても既に読んだぶんは効く）。
const MAX_EVENTS_BYTES: u64 = 4 * 1024 * 1024;

fn state_dir(shell: &ShellConfig) -> Option<PathBuf> {
    let home = match shell {
        ShellConfig::Wsl { distro } => wsl_home_subdir_cached(shell, distro, ".copilot")?,
        _ => PathBuf::from(crate::types::host_home()?).join(".copilot"),
    };
    let dir = home.join("session-state");
    dir.is_dir().then_some(dir)
}

/// 1 セッションから拾うもの。
#[derive(Clone, Default)]
struct Session {
    cwd: Option<String>,
    /// 最後の checkpoint の値。**累計なので足さない**（checkpoint はセッションの累計を出す）。
    premium_requests: f64,
}

/// `events.jsonl` を 1 回なめて、欲しい 2 種のイベントだけ拾う。
///
/// **大きすぎるファイルを捨てないこと。** 長く動いているセッションほどクレジットを使って
/// いるので、丸ごと落とすと**いま消費している最中のセッションが 0 と報告される**。行単位で
/// 読んで上限で打ち切り、そこまでに見つけたものを使う（`session.start` は先頭、
/// `usage_checkpoint` は書かれるたびに更新されるので、前から読んで打ち切って構わない）。
fn parse_events(path: &Path) -> Option<Session> {
    let file = fs::File::open(path).ok()?;
    let mut out = Session::default();
    let mut read = 0u64;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        read += line.len() as u64 + 1;
        if read > MAX_EVENTS_BYTES {
            break;
        }
        // 行の型を先に見て、要らない行は JSON にすら起こさない（1 行が数十 KB になる
        // ことがある。`session.usage_checkpoint` はツールの一覧まで抱えている）。
        let is_start = line.contains("\"session.start\"");
        let is_usage = line.contains("\"session.usage_checkpoint\"");
        if !is_start && !is_usage {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let data = &v["data"];
        if is_start {
            if let Some(cwd) = data["context"]["cwd"].as_str() {
                out.cwd = Some(cwd.to_string());
            }
        } else if let Some(n) = data["totalPremiumRequests"].as_f64() {
            out.premium_requests = n;
        }
    }
    Some(out)
}

/// mtime をキーにした解析結果のキャッシュ（`codex_usage` の `parse_session_cached` と同じ形）。
///
/// **無いと 30 秒ごとに 24 時間ぶんのセッションを読み直す。** WSL プロジェクトでは
/// `\\wsl.localhost` 越しの読みになるので、ウィンドウの数だけそれが並ぶ。終わった
/// セッションは変わらないので、読み直す理由が無い。
///
/// 掃除は**走査結果ではなく古さ**で行う（キャッシュはプロセス共有なので、片方の
/// プロジェクトの走査結果で retain すると、もう片方のエントリを毎回落としてしまう）。
type EventCache = Mutex<HashMap<PathBuf, (SystemTime, Session)>>;

fn parse_events_cached(path: &Path, modified: SystemTime) -> Option<Session> {
    static CACHE: OnceLock<EventCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Ok(map) = cache.lock() {
        if let Some((at, session)) = map.get(path) {
            if *at == modified {
                return Some(session.clone());
            }
        }
    }
    let session = parse_events(path)?;
    if let Ok(mut map) = cache.lock() {
        let cutoff = SystemTime::now() - Duration::from_secs(RECENT_WINDOW_SECS);
        map.retain(|_, (at, _)| *at >= cutoff);
        map.insert(path.to_path_buf(), (modified, session.clone()));
    }
    Some(session)
}

pub fn collect(shell: &ShellConfig, root: &str) -> AgentUsage {
    let mut usage = AgentUsage::for_id("copilot");
    usage.fetched_at = now_secs();
    let Some(dir) = state_dir(shell) else {
        return usage;
    };

    let now = SystemTime::now();
    let recent = Duration::from_secs(RECENT_WINDOW_SECS);

    // **ディレクトリ自身の mtime で先に絞る。** セッションのフォルダは消えずに溜まるので、
    // 全部について `events.jsonl` を stat すると、Copilot を長く使っているほど 30 秒ごとの
    // 走査が重くなる（WSL プロジェクトでは 1 件ごとに `\\wsl.localhost` の往復）。
    // `DirEntry::metadata` は Windows では列挙のときに返ってきた値をそのまま使うので
    // 往復が増えず、しかも Copilot はセッション中フォルダの中へ書き続ける
    // （`checkpoints` / `rewind-file-snapshots` / `files`）ので、24 時間の窓では十分に効く。
    // 絞ったあとで `events.jsonl` の mtime を見る（そちらがキャッシュの鍵）。
    let mut dirs: Vec<(PathBuf, SystemTime)> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_dir()
                || now
                    .duration_since(meta.modified().ok()?)
                    .unwrap_or_default()
                    > recent
            {
                return None;
            }
            let path = e.path();
            let modified = fs::metadata(path.join("events.jsonl"))
                .ok()?
                .modified()
                .ok()?;
            Some((path, modified))
        })
        .collect();
    // 新しい順に並べてから打ち切る（古いセッションで枠を潰さない）。
    dirs.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));

    let active_window = Duration::from_secs(ACTIVE_WINDOW_SECS);
    let mut premium = 0.0;
    let mut sessions = 0u32;
    let mut last_activity: Option<u64> = None;

    for (path, modified) in dirs.into_iter().take(MAX_SESSIONS) {
        // **未来の mtime は「今」として扱う**（WSL と Windows の時計のずれ。
        // `codex_usage` と同じ扱い）。
        let age = now.duration_since(modified).unwrap_or_default();
        if age > recent {
            break;
        }
        let Some(session) = parse_events_cached(&path.join("events.jsonl"), modified) else {
            continue;
        };
        let Some(cwd) = session.cwd.as_deref() else {
            continue;
        };
        if !cwd_matches_root(shell, cwd, root) {
            continue;
        }
        sessions += 1;
        premium += session.premium_requests;
        if age <= active_window {
            usage.active = true;
        }
        if let Ok(secs) = modified.duration_since(std::time::UNIX_EPOCH) {
            let secs = secs.as_secs();
            last_activity = Some(last_activity.map_or(secs, |prev: u64| prev.max(secs)));
        }
    }

    if sessions == 0 {
        return usage;
    }
    usage
        .facts
        .push(fact("session-count", sessions.to_string()));
    // **premium request は小数で出る**（実測で 1 リクエストが 0.33）。丸めない。
    usage
        .facts
        .push(fact("premium-requests", format!("{premium:.2}")));
    if let Some(at) = last_activity {
        usage.facts.push(fact("last-activity", at.to_string()));
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_events(dir: &std::path::Path, lines: &[&str]) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join("events.jsonl");
        let mut f = fs::File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path
    }

    #[test]
    fn reads_cwd_and_the_last_checkpoint() {
        let tmp = std::env::temp_dir().join(format!("pike-copilot-{}", std::process::id()));
        let path = write_events(
            &tmp,
            &[
                r#"{"type":"session.start","data":{"context":{"cwd":"/home/kan/pike"}}}"#,
                r#"{"type":"assistant.turn_start","data":{"turnId":"0"}}"#,
                r#"{"type":"session.usage_checkpoint","data":{"totalPremiumRequests":0.33}}"#,
                r#"{"type":"session.usage_checkpoint","data":{"totalPremiumRequests":0.66}}"#,
            ],
        );
        let s = parse_events(&path).unwrap();
        assert_eq!(s.cwd.as_deref(), Some("/home/kan/pike"));
        // 累計なので**足さず**、最後の値を採る。
        assert!((s.premium_requests - 0.66).abs() < f64::EPSILON);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_session_without_turns_reports_nothing() {
        let tmp = std::env::temp_dir().join(format!("pike-copilot-empty-{}", std::process::id()));
        let path = write_events(
            &tmp,
            &[r#"{"type":"session.start","data":{"context":{"cwd":"/tmp"}}}"#],
        );
        let s = parse_events(&path).unwrap();
        assert_eq!(s.cwd.as_deref(), Some("/tmp"));
        assert_eq!(s.premium_requests, 0.0);
        fs::remove_dir_all(&tmp).ok();
    }
}
