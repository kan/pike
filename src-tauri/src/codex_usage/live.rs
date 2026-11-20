//! 今動いている Codex のセッション（#633）。Claude の一覧（`claude_usage/live.rs`）と同じ
//! パネルとタブに並べる。
//!
//! **Codex には `sessions/<pid>.json` に当たるものが無い**（`mod.rs` の冒頭）。出所は
//! 再開の一覧と同じ rollout（`sessions/YYYY/MM/DD/rollout-*.jsonl`）で、生きているかは
//! 推すしかない。だから状態は Claude と同じ 3 つに写さず、2 つにする。
//!
//! | 状態 | 条件 |
//! |---|---|
//! | `Busy` | `ACTIVE_WINDOW_SECS` 以内に書かれ、かつ最後のターンが閉じていない |
//! | `Recent` | `RECENT_WINDOW_SECS` 以内に書かれた残り（新しい順に `MAX_RECENT` 件まで） |
//!
//! **ターンが閉じたかは rollout の末尾で見る**（[`turn_state`]）。Codex はターンの始まりに
//! `task_started`、終わりに `task_complete`（中断なら `turn_aborted`）を書く（手元の実物で確認）。
//! mtime だけだと、ターンを終えて入力を待っているセッションも 5 分のあいだ「稼働中」に出る。
//! 逆に長い推論のターンは `task_started` のあと書かないことがあるので、閉じていないあいだは
//! mtime の窓まで「稼働中」に倒す（窓を過ぎたら、kill されてターンが開いたままの記録と
//! 見分けが付かないので「最近」へ落とす）。
//!
//! **返答待ちは出さない。** Pike の入力待ちの知らせ（`agent_hook`）は Claude Code の hook と mod
//! にしか無く、Codex からは何も届かない。許可の確認を待っている状態も rollout からは確かに
//! 読めない（答えたことを書く行が無い）。
//!
//! **pid は無い。** rollout にも `~/.codex` のどこにも、セッションとプロセスを結ぶものが無い
//! （`thread-writer-locks/` は空の `.coordination.lock` が 1 つあるだけだった）。タブから引く
//! 手がかりは無いので、移動は登録済みのプロジェクト → ディレクトリへ落ちる。
//!
//! **題は `session_index.jsonl` の `thread_name` を先に見る**（Codex が付ける題。付け直すと
//! 同じ id の行が追記される）。無ければ再開の一覧と同じく最初のユーザー発話。
//!
//! **`CODEX_HOME` には対応しない。** 使用量と再開の一覧も `~/.codex` 固定で、WSL の値を
//! 引くには対話ログインシェルのプローブに相乗りさせる必要がある（`claude_usage/config.rs` の
//! 冒頭が共用の道筋を書いている）。要望が出てから 3 つを揃えて足す。

use super::{SessionHead, codex_home, read_account, read_session_head_cached, session_files};
use crate::agent_live::{LiveSession, LiveStatus};
use crate::agent_usage::{ACTIVE_WINDOW_SECS, RECENT_WINDOW_SECS};
use crate::cache::{Evict, MtimeCache};
use crate::types::{ShellConfig, validate_slug};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

/// 走査する日付ディレクトリの数。**ポーリングするので再開の一覧（14 日）より少ない。**
/// rollout は起動した日のディレクトリに書かれるので、3 日より前に起動して今も動いている
/// セッションは並ばない（日をまたぐ程度の長さは拾う）。
const LIVE_SCAN_DAY_DIRS: usize = 3;
/// 「最近」に並べる上限。動いていないものが一覧を埋めないように。
const MAX_RECENT: usize = 10;
/// 中身を覗く rollout の上限（新しい順）。`codex exec` の記録が多い環境の歯止め。**`codex exec` で
/// 落とすものも数える**ので、少なくすると、直近に `codex exec` を何十回も走らせたあいだ動いている
/// 対話のセッションが窓の外へ押し出される。先頭は記録の mtime で覚える（`read_session_head_cached`）ので、
/// 2 回目からは開かない。通常は「最近」が埋まった時点で打ち切る（`list` の `break`）。
const MAX_SCAN_FILES: usize = 300;
/// ターンの印を探すために末尾から最初に読む量。窓を倍にしながら [`MAX_TAIL_BYTES`] まで遡る
/// （最後のターンの出力が大きいと、末尾の窓に印が無い）。
const TAIL_FIRST_BYTES: u64 = 64 * 1024;
const MAX_TAIL_BYTES: u64 = 2 << 20;

/// そのシェルの環境（Windows / WSL の distro）の Codex の一覧。
pub(crate) struct CodexLive {
    /// 読んだ `~/.codex`（Pike から読める形）。
    pub dir: PathBuf,
    /// `auth.json` のメールアドレス。
    pub account: Option<String>,
    pub sessions: Vec<LiveSession>,
}

/// `~/.codex` が無ければ `None`。
pub(crate) fn list(shell: &ShellConfig) -> Option<CodexLive> {
    let dir = codex_home(shell)?;
    let window = Duration::from_secs(RECENT_WINDOW_SECS);
    let mut files = session_files(&dir.join("sessions"), LIVE_SCAN_DAY_DIRS, Some(window));
    files.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));

    let titles = thread_names(&dir.join("session_index.jsonl"));
    let now = SystemTime::now();
    let active = Duration::from_secs(ACTIVE_WINDOW_SECS);
    let mut sessions = Vec::new();
    let mut recent = 0usize;
    for (path, modified) in files.into_iter().take(MAX_SCAN_FILES) {
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        // 新しい順なので、稼働中の窓を過ぎて「最近」が埋まったら残りはどれも並ばない。
        if age > active && recent >= MAX_RECENT {
            break;
        }
        // 非対話（`codex exec`）は `None`（再開の一覧と同じ選別）。
        let Some(head) = read_session_head_cached(&path, modified) else {
            continue;
        };
        if validate_slug(&head.id, "session id").is_err() {
            continue;
        }
        let status = if age <= active && turn_state_cached(&path, modified) != Turn::Closed {
            LiveStatus::Busy
        } else {
            LiveStatus::Recent
        };
        if status == LiveStatus::Recent {
            if recent >= MAX_RECENT {
                continue;
            }
            recent += 1;
        }
        sessions.push(session_of(head, status, modified, &titles));
    }
    let account = read_account(&dir).and_then(|a| a.email);
    Some(CodexLive {
        dir,
        account,
        sessions,
    })
}

fn session_of(
    head: SessionHead,
    status: LiveStatus,
    modified: SystemTime,
    titles: &HashMap<String, String>,
) -> LiveSession {
    let title = titles
        .get(&head.id)
        .cloned()
        .or_else(|| (!head.title.is_empty()).then_some(head.title));
    LiveSession {
        pid: None,
        session_id: head.id,
        cwd: head.cwd,
        name: None,
        status,
        waiting_for: None,
        started_at: None,
        status_since: crate::agent_sessions::modified_ms(modified),
        version: head.version,
        title,
        git_branch: head.git_branch,
    }
}

/// rollout の最後のターンの状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Turn {
    /// `task_started` のあとに閉じる印が無い。
    Open,
    /// 最後の印が `task_complete` か `turn_aborted`。
    Closed,
    /// 遡れる範囲に印が無い（古い版、または最後のターンの出力が大きすぎる）。
    Unknown,
}

/// [`turn_state`] を mtime で覚える。動いているセッションは書かれるたびに読み直すが、
/// 読むのは末尾だけ。
fn turn_state_cached(path: &Path, modified: SystemTime) -> Turn {
    static CACHE: OnceLock<MtimeCache<Turn>> = OnceLock::new();
    CACHE
        .get_or_init(|| MtimeCache::new(Evict::OlderThan(Duration::from_secs(RECENT_WINDOW_SECS))))
        .get_or_read(path, modified, || {
            fs::File::open(path).map_or(Turn::Unknown, |mut f| turn_state(&mut f))
        })
}

const OPEN_MARK: &[u8] = b"\"type\":\"task_started\"";
const CLOSE_MARKS: [&[u8]; 2] = [b"\"type\":\"task_complete\"", b"\"type\":\"turn_aborted\""];
/// 窓の境目にまたがる印を取りこぼさないよう、次の窓を重ねる長さ（いちばん長い印より長ければよい）。
const OVERLAP: u64 = 32;

/// 末尾から窓を倍にしながら遡り、いちばん後ろのターンの印で決める。
fn turn_state<R: Read + Seek>(file: &mut R) -> Turn {
    let Ok(len) = file.seek(SeekFrom::End(0)) else {
        return Turn::Unknown;
    };
    let mut end = len;
    let mut window = TAIL_FIRST_BYTES;
    loop {
        let start = end.saturating_sub(window);
        let mut buf = vec![0u8; (end - start) as usize];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
            return Turn::Unknown;
        }
        if let Some(turn) = last_turn_mark(&buf) {
            return turn;
        }
        if start == 0 || len - start >= MAX_TAIL_BYTES {
            return Turn::Unknown;
        }
        end = start + OVERLAP.min(end - start);
        window *= 2;
    }
}

/// `buf` のいちばん後ろの印。無ければ `None`。
fn last_turn_mark(buf: &[u8]) -> Option<Turn> {
    let last = |mark: &[u8]| buf.windows(mark.len()).rposition(|w| w == mark);
    let open = last(OPEN_MARK);
    let close = CLOSE_MARKS.iter().filter_map(|m| last(m)).max();
    match (open, close) {
        (Some(o), Some(c)) => Some(if o > c { Turn::Open } else { Turn::Closed }),
        (Some(_), None) => Some(Turn::Open),
        (None, Some(_)) => Some(Turn::Closed),
        (None, None) => None,
    }
}

/// `session_index.jsonl` の id → `thread_name`（同じ id は後の行が勝つ）。ファイルの mtime で
/// 覚える（題を付け直したときにしか書かれない）。
fn thread_names(path: &Path) -> Arc<HashMap<String, String>> {
    // 鍵は環境ごとに 1 つ（`~/.codex` の数）なので、件数で丸ごと捨てる掃除で足りる。
    static CACHE: OnceLock<MtimeCache<Arc<HashMap<String, String>>>> = OnceLock::new();
    let Some(modified) = fs::metadata(path).ok().and_then(|m| m.modified().ok()) else {
        return Arc::default();
    };
    CACHE
        .get_or_init(|| MtimeCache::new(Evict::ClearOver(16)))
        .get_or_read(path, modified, || {
            Arc::new(
                fs::read_to_string(path)
                    .map(|text| parse_thread_names(&text))
                    .unwrap_or_default(),
            )
        })
}

fn parse_thread_names(text: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (v["id"].as_str(), v["thread_name"].as_str())
            && !name.trim().is_empty()
        {
            names.insert(id.to_owned(), crate::agent_sessions::shorten(name));
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::{Turn, last_turn_mark, parse_thread_names, turn_state};
    use std::io::Cursor;

    fn event(kind: &str) -> String {
        format!(r#"{{"type":"event_msg","payload":{{"type":"{kind}","turn_id":"t"}}}}"#)
    }

    #[test]
    fn the_last_turn_mark_wins() {
        let open = [event("task_started"), event("token_count")].join("\n");
        assert_eq!(last_turn_mark(open.as_bytes()), Some(Turn::Open));
        let closed = [event("task_started"), event("task_complete")].join("\n");
        assert_eq!(last_turn_mark(closed.as_bytes()), Some(Turn::Closed));
        let aborted = [event("task_started"), event("turn_aborted")].join("\n");
        assert_eq!(last_turn_mark(aborted.as_bytes()), Some(Turn::Closed));
        let again = [event("task_complete"), event("task_started")].join("\n");
        assert_eq!(last_turn_mark(again.as_bytes()), Some(Turn::Open));
        assert_eq!(last_turn_mark(event("token_count").as_bytes()), None);
    }

    /// 最後のターンの出力が末尾の窓より大きくても、窓を広げて印を見つける。
    #[test]
    fn walks_back_past_a_large_turn() {
        let filler = format!("{}\n", "x".repeat(1000)).repeat(200); // 約 200KB
        let text = format!("{}\n{filler}", event("task_started"));
        assert_eq!(turn_state(&mut Cursor::new(text.into_bytes())), Turn::Open);
        let none = filler.clone().into_bytes();
        assert_eq!(turn_state(&mut Cursor::new(none)), Turn::Unknown);
    }

    #[test]
    fn later_thread_names_win() {
        let text = [
            r#"{"id":"a","thread_name":"最初の題","updated_at":"x"}"#,
            r#"{"id":"b","thread_name":"別の題","updated_at":"x"}"#,
            r#"{"id":"a","thread_name":"付け直した題\n2 行目","updated_at":"y"}"#,
            "壊れた行",
        ]
        .join("\n");
        let names = parse_thread_names(&text);
        assert_eq!(names.get("a").map(String::as_str), Some("付け直した題"));
        assert_eq!(names.get("b").map(String::as_str), Some("別の題"));
    }
}
