//! 今動いている Claude Code のセッション（#625）。
//!
//! **出所は設定ディレクトリの `sessions/<pid>.json`。** Claude Code は対話のセッションごとに
//! このファイルを置き、状態が変わるたびに書き直す（`status` は `busy` / `idle` / `waiting`、
//! `waitingFor` は待っている理由の文言）。Pike のターミナルの外で起動した claude も、別の
//! Pike のウィンドウのものも、同じ場所に並ぶ。**読むのは今のプロジェクトで解決した設定
//! ディレクトリ 1 つ**（`config::resolve`）＝そのプロジェクトで使っているアカウントのぶん。
//!
//! **このディレクトリを読む口はここの [`live_records`] 1 つ。** 一覧（[`agent_live_sessions`]）と
//! 使用量の集計（`find_active_sessions`。動いているセッションの記録を集計する）が共有する。
//! 「生きているセッションとは何か」の答えを 2 つ持たない。
//!
//! **ファイルは終わったセッションのぶんも残る**（kill されたプロセスは後始末をしない。手元で
//! 数か月前のものが残っていた）。だから載っている pid が今も同じプロセスかを確かめる。
//! pid は使い回されるので、生きているかだけでは足りない。Claude Code 自身と同じく、記録の
//! `procStart`（プロセスの開始時刻）と突き合わせる。
//!
//! | 記録を書いた OS | `procStart` の中身 | 照合の相手 |
//! |---|---|---|
//! | Windows | 作成時刻の FILETIME（100ns 単位） | `GetProcessTimes` の作成時刻 |
//! | Linux（WSL を含む） | `/proc/<pid>/stat` の 22 番目（starttime） | 同じ欄 |
//! | macOS | 未確認 | 照合しない（pid が生きているかだけ） |
//!
//! **死んでいると分かった記録は、ファイルの mtime で覚えて読み直さない**（[`DeadRecords`]）。
//! 一覧はポーリングするので、古い記録の数だけ読み取りと照合を毎回払わないため。同じ pid の
//! 新しいプロセスは同じ名前のファイルを書き直すので、mtime が変わって照合し直される。
//!
//! **WSL の `/proc` は UNC 越しに読む**（`\\wsl.localhost\<distro>\proc\<pid>\stat`）。`wsl.exe` を
//! 起こさずに済ませる。UNC で `/proc` が見えない環境では、distro に `kill -0` を問い合わせる
//! （[`alive_pids_wsl`]。開始時刻は照合しない）。
//!
//! **題とブランチはセッションの記録（`projects/<slug>/<id>.jsonl`）から読む**（再開のメニューと
//! 同じ `read_session`）。記録の場所は `cwd` の slug で決める。途中で worktree へ移った
//! セッションは移動先に書かれていて見つからないので、題が無いまま並ぶ（名前は `name` がある）。
//! ポーリングのたびに読み直さないよう、記録の mtime で覚える。

use super::{config, encode_project_path, sessions};
use crate::types::{ShellConfig, validate_slug};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// `sessions/<pid>.json` の 1 件。Claude Code の版によって欠ける欄があるので、要るもの以外は
/// どれも省略可能にしてある（古い版は `status` を持たない）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionRecord {
    pub(super) pid: u64,
    pub(super) session_id: Option<String>,
    pub(super) cwd: String,
    pub(super) started_at: Option<u64>,
    proc_start: Option<String>,
    #[cfg_attr(not(windows), allow(dead_code))]
    proc_start_ft: Option<String>,
    version: Option<String>,
    name: Option<String>,
    status: Option<String>,
    waiting_for: Option<String>,
    updated_at: Option<u64>,
    status_updated_at: Option<u64>,
    /// 先に起こしておく予備のプロセス（まだ誰も使っていない）。一覧には出さない。
    #[serde(default)]
    spare: bool,
}

/// セッションの状態。Claude Code の `status` をそのまま 3 つに写す。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveStatus {
    /// 許可の確認や質問への答えを待っている（Claude Code の `waiting`）。
    Waiting,
    /// ターンが動いている（`busy`）。
    Busy,
    /// 入力を待っている（`idle`）。**知らない値もここへ倒す**: 新しい状態が増えても、
    /// 一覧から消すより「動いていない」に並べるほうが見つけやすい。
    Idle,
}

impl LiveStatus {
    fn of(raw: &str) -> Self {
        match raw {
            "waiting" => Self::Waiting,
            "busy" => Self::Busy,
            _ => Self::Idle,
        }
    }
}

/// 一覧の 1 件。**並べ替えはフロント**（`lib/liveSessions.ts` の `groupLiveSessions`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub pid: u64,
    pub session_id: String,
    /// 起動したディレクトリ（そのシェルから見た形）。
    pub cwd: String,
    /// Claude Code が付けた名前（`pike-47` のような、ディレクトリ名＋短い id）。
    pub name: Option<String>,
    pub status: LiveStatus,
    /// 待っている理由（`waiting` のときだけ。Claude Code の英語の文言のまま）。
    pub waiting_for: Option<String>,
    /// 起動した時刻（epoch ms）。
    pub started_at: Option<u64>,
    /// 状態が最後に変わった時刻（epoch ms）。無ければ記録の更新時刻。
    pub status_since: Option<u64>,
    pub version: Option<String>,
    /// 記録から読んだ題（再開のメニューと同じ規則）。記録が見つからなければ無い。
    pub title: Option<String>,
    pub git_branch: Option<String>,
}

/// 一覧と、どのアカウントのものか。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionList {
    pub sessions: Vec<LiveSession>,
    /// 読んだ設定ディレクトリ（Pike から読める形）。解決できなければ無い。
    pub config_dir: Option<String>,
    /// そのアカウントのメールアドレス（`.claude.json` から読めたとき）。
    pub account: Option<String>,
}

/// 今のプロジェクトのアカウントで動いているセッション。
///
/// **失敗は空の一覧**（`Err` にしない）。設定ディレクトリが無いのと、セッションが 1 つも
/// 動いていないのは、パネルの上では同じ見え方でよい。
#[tauri::command]
pub async fn agent_live_sessions(
    shell: ShellConfig,
    project_root: String,
) -> Result<LiveSessionList, String> {
    tokio::task::spawn_blocking(move || {
        let config = config::resolve(&shell, &project_root);
        let account = config.account.as_ref().and_then(|a| a.email.clone());
        let Some(dir) = config.read_path else {
            return LiveSessionList {
                sessions: Vec::new(),
                config_dir: None,
                account,
            };
        };
        LiveSessionList {
            sessions: list(&shell, &dir),
            config_dir: Some(dir.to_string_lossy().into_owned()),
            account,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn list(shell: &ShellConfig, claude_dir: &Path) -> Vec<LiveSession> {
    let projects = claude_dir.join("projects");
    live_records(shell, claude_dir)
        .into_iter()
        // `status` を持たないのは古い版の記録（手元の実測）。一覧には出さない。
        .filter_map(|r| {
            let status = LiveStatus::of(r.status.as_deref()?);
            let session_id = r.session_id?;
            validate_slug(&session_id, "session id").ok()?;
            let (title, git_branch) = transcript_title(&projects, &r.cwd, &session_id)
                .map_or((None, None), |(t, b)| (Some(t), b));
            Some(LiveSession {
                pid: r.pid,
                cwd: r.cwd,
                name: r.name,
                status,
                waiting_for: r.waiting_for,
                started_at: r.started_at,
                status_since: r.status_updated_at.or(r.updated_at),
                version: r.version,
                title,
                git_branch,
                session_id,
            })
        })
        .collect()
}

/// `sessions/<pid>.json` のうち、今も同じプロセスが動いているもの。**このディレクトリを読む
/// 唯一の口**（モジュールの doc）。状態の有無では絞らない（使用量の集計は古い版の記録も数える）。
pub(super) fn live_records(shell: &ShellConfig, claude_dir: &Path) -> Vec<SessionRecord> {
    let Ok(entries) = fs::read_dir(claude_dir.join("sessions")) else {
        return Vec::new();
    };
    let dead = DeadRecords::get();
    let mut candidates: Vec<(PathBuf, SystemTime, SessionRecord)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Some(mtime) = entry.metadata().ok().and_then(|m| m.modified().ok()) else {
            continue;
        };
        if dead.contains(&path, mtime) {
            continue;
        }
        // 読めない・解析できないものは覚えない（Claude Code が書き直している途中を読んだだけかも
        // しれない。覚えると、そのあと書き直されないアイドルのセッションが消えたままになる）。
        if let Some(record) = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<SessionRecord>(&s).ok())
            // 予備のプロセス（まだ誰も使っていない）はセッションに数えない。
            .filter(|r| !r.spare)
        {
            candidates.push((path, mtime, record));
        }
    }

    let live = Liveness::new(shell, candidates.iter().map(|(_, _, r)| r.pid));
    candidates
        .into_iter()
        .filter_map(|(path, mtime, record)| match live.verdict(&record) {
            Verdict::Live => Some(record),
            Verdict::Dead => {
                dead.insert(path, mtime);
                None
            }
            Verdict::Unknown => None,
        })
        .collect()
}

/// 記録のプロセスについての答え。**覚えてよいのは `Dead` だけ**: 問い合わせに失敗した
/// （`Unknown`）ものまで覚えると、一時的な失敗で動いているセッションが、そのファイルが
/// 書き直されるまで一覧から消える（アイドルのセッションは何時間も書き直さない）。
enum Verdict {
    Live,
    Dead,
    Unknown,
}

/// 死んでいると分かった記録（パスと、そのときの mtime）。プロセスで共有する。
///
/// **掃除は件数で行う**（増えすぎたら丸ごと捨てる）。走査の結果で retain すると、別の
/// アカウントの一覧を引いたウィンドウのぶんを毎回落とす（`transcript_title` と同じ理由）。
struct DeadRecords(Mutex<HashMap<PathBuf, SystemTime>>);

impl DeadRecords {
    const MAX_ENTRIES: usize = 4096;

    fn get() -> &'static Self {
        static DEAD: OnceLock<DeadRecords> = OnceLock::new();
        DEAD.get_or_init(|| Self(Mutex::new(HashMap::new())))
    }

    fn contains(&self, path: &Path, mtime: SystemTime) -> bool {
        self.0
            .lock()
            .is_ok_and(|map| map.get(path).is_some_and(|t| *t == mtime))
    }

    fn insert(&self, path: PathBuf, mtime: SystemTime) {
        if let Ok(mut map) = self.0.lock() {
            if map.len() >= Self::MAX_ENTRIES {
                map.clear();
            }
            map.insert(path, mtime);
        }
    }
}

/// 記録から題とブランチを読む。記録の mtime で覚え、変わっていなければ読み直さない。
///
/// **覚えるのは引いたものだけで、走査の結果では掃除しない**（キャッシュはプロセスで共有なので、
/// あるプロジェクトの一覧で retain すると、アカウントの違う別のウィンドウのぶんを毎回落とす）。
/// 増えすぎたら丸ごと捨てる（読み直しは記録の先頭と末尾だけ）。
fn transcript_title(
    projects: &Path,
    cwd: &str,
    session_id: &str,
) -> Option<(String, Option<String>)> {
    type Cache = HashMap<PathBuf, (u64, Option<(String, Option<String>)>)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    const MAX_ENTRIES: usize = 256;

    let path = projects
        .join(encode_project_path(cwd))
        .join(format!("{session_id}.jsonl"));
    let modified = crate::agent_sessions::modified_ms(fs::metadata(&path).ok()?.modified().ok()?)?;
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock()
        && let Some((at, found)) = map.get(&path)
        && *at == modified
    {
        return found.clone();
    }
    let found = sessions::read_session(&path, modified, None).map(|s| (s.title, s.git_branch));
    if let Ok(mut map) = cache.lock() {
        if map.len() >= MAX_ENTRIES {
            map.clear();
        }
        map.insert(path, (modified, found.clone()));
    }
    found
}

/// 記録の pid が今も同じプロセスかを答える。問い合わせが要る方式（`kill -0`）は、
/// 全件を 1 回で聞いておく。
enum Liveness {
    /// `procStart` を `/proc/<pid>/stat` と突き合わせる（WSL は UNC、Linux はそのまま）。
    Proc(PathBuf),
    /// pid が生きているかだけを、問い合わせ済みの集合で答える。問い合わせに失敗したら `None`。
    Pids(Option<HashSet<u64>>),
    /// Windows のプロセス。作成時刻と突き合わせる。
    #[cfg(windows)]
    Windows,
    /// ホストの pid（macOS）。生きているかだけを見る。
    #[cfg(not(windows))]
    Host,
}

impl Liveness {
    fn new(shell: &ShellConfig, pids: impl Iterator<Item = u64>) -> Self {
        match shell {
            ShellConfig::Wsl { distro } => match wsl_proc_root(distro) {
                Some(root) => Self::Proc(root),
                None => Self::Pids(alive_pids_wsl(shell, &pids.collect::<Vec<_>>())),
            },
            #[cfg(windows)]
            _ => Self::Windows,
            #[cfg(not(windows))]
            _ => {
                let root = PathBuf::from("/proc");
                if proc_is_readable(&root) {
                    Self::Proc(root)
                } else {
                    Self::Host
                }
            }
        }
    }

    fn verdict(&self, r: &SessionRecord) -> Verdict {
        let live = |b: bool| if b { Verdict::Live } else { Verdict::Dead };
        match self {
            Self::Proc(root) => {
                let stat = match fs::read_to_string(root.join(r.pid.to_string()).join("stat")) {
                    Ok(stat) => stat,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Verdict::Dead,
                    Err(_) => return Verdict::Unknown,
                };
                match (proc_start_time(&stat), r.proc_start.as_deref()) {
                    (Some(now), Some(recorded)) => live(now == recorded.trim()),
                    // 記録に開始時刻が無い版では、pid が生きていることだけで認める。
                    (Some(_), None) => Verdict::Live,
                    (None, _) => Verdict::Unknown,
                }
            }
            Self::Pids(Some(alive)) => live(alive.contains(&r.pid)),
            Self::Pids(None) => Verdict::Unknown,
            #[cfg(windows)]
            Self::Windows => {
                let recorded = r
                    .proc_start_ft
                    .as_deref()
                    .or(r.proc_start.as_deref())
                    .and_then(|s| s.trim().parse::<u64>().ok());
                match windows_creation_time(r.pid) {
                    Ok(created) => live(recorded.is_none_or(|t| t == created)),
                    Err(verdict) => verdict,
                }
            }
            #[cfg(not(windows))]
            Self::Host => live(is_process_alive(r.pid)),
        }
    }
}

/// `/proc` の中が読めるか（`/proc/1/stat` が見えるか）。
fn proc_is_readable(root: &Path) -> bool {
    root.join("1").join("stat").is_file()
}

/// その distro の `/proc` の UNC。**読めると分かったものだけ覚える**（読めない答えを覚えると、
/// 冷えた distro で 1 回失敗しただけで以後ずっと `wsl.exe` に落ちる）。
fn wsl_proc_root(distro: &str) -> Option<PathBuf> {
    static READABLE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    let cache = READABLE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(root) = cache.lock().ok()?.get(distro) {
        return Some(root.clone());
    }
    let root = crate::types::wsl_native_to_unc(distro, "/proc")?;
    if !proc_is_readable(&root) {
        return None;
    }
    cache.lock().ok()?.insert(distro.to_owned(), root.clone());
    Some(root)
}

/// One `wsl.exe` call that echoes each still-running pid. The trailing `; true`
/// keeps the whole script's exit status 0 even when the last `kill -0` fails —
/// otherwise `run_stdout` would treat it as an error and discard the stdout that
/// already named the live pids. `None` when the distro could not be asked.
fn alive_pids_wsl(shell: &ShellConfig, pids: &[u64]) -> Option<HashSet<u64>> {
    if pids.is_empty() {
        return Some(HashSet::new());
    }
    let checks = pids
        .iter()
        .map(|p| format!("kill -0 {p} 2>/dev/null && echo {p}"))
        .collect::<Vec<_>>()
        .join("; ");
    let script = format!("{checks}; true");
    let out = shell.run_stdout("bash", &["-c", &script]).ok()?;
    Some(
        out.lines()
            .filter_map(|l| l.trim().parse::<u64>().ok())
            .collect(),
    )
}

/// `/proc/<pid>/stat` の starttime（22 番目の欄）。2 番目の欄（コマンド名）は括弧で囲まれ、
/// 空白や括弧を含みうるので、**最後の `)` から後ろ**を数える（その直後が 3 番目の欄）。
fn proc_start_time(stat: &str) -> Option<&str> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(22 - 3)
}

/// Windows のプロセスの作成時刻（FILETIME を 1 つの整数にしたもの）。取れなければその理由の
/// 答え: **その pid のプロセスが無い（`ERROR_INVALID_PARAMETER`）ときだけ `Dead`**、ほか
/// （権限・一時的な失敗）は `Unknown`。
#[cfg(windows)]
fn windows_creation_time(pid: u64) -> Result<u64, Verdict> {
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let pid = u32::try_from(pid).map_err(|_| Verdict::Dead)?;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|e| {
            if e.code() == ERROR_INVALID_PARAMETER.to_hresult() {
                Verdict::Dead
            } else {
                Verdict::Unknown
            }
        })?;
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(handle);
        if ok {
            Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
        } else {
            Err(Verdict::Unknown)
        }
    }
}

/// macOS / Linux 版。`kill(pid, 0)` はシグナルを送らずに「その pid へ送れるか」だけを
/// 見る、この問いの標準的な書き方。
///
/// **`false` を返すスタブに戻さないこと。** ここが常に false だと動いているセッションが
/// 1 つも見つからず、Claude usage の `active` が永久に false になる。その結果
/// `claudeRate` の再取得が `TTL_ACTIVE`（5 分）ではなく `TTL_IDLE`（1 時間）で回り、
/// セッション中でもレート表示が古いままになる。エラーも出ないので気付けない。
#[cfg(not(windows))]
fn is_process_alive(pid: u64) -> bool {
    let Ok(p) = i32::try_from(pid) else {
        return false;
    };
    if p <= 0 {
        return false;
    }
    if unsafe { libc::kill(p, 0) } == 0 {
        return true;
    }
    // 別ユーザーのプロセスは EPERM になるが、それは「生きている」ということ。
    // 死んでいるときだけ ESRCH が返る。
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::{LiveStatus, SessionRecord, proc_start_time};

    #[test]
    fn reads_the_start_time_after_the_command_name() {
        // コマンド名に空白と括弧が入っても、最後の `)` から数える。
        let stat =
            "1198953 (claude (x) y) S 2372 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 2372690 9";
        assert_eq!(proc_start_time(stat), Some("2372690"));
        assert_eq!(proc_start_time("garbage"), None);
    }

    #[test]
    fn maps_unknown_states_to_idle() {
        assert_eq!(LiveStatus::of("waiting"), LiveStatus::Waiting);
        assert_eq!(LiveStatus::of("busy"), LiveStatus::Busy);
        assert_eq!(LiveStatus::of("idle"), LiveStatus::Idle);
        assert_eq!(LiveStatus::of("something-new"), LiveStatus::Idle);
    }

    #[test]
    fn parses_a_record_written_by_claude_code() {
        // 2.1.327 が Windows で書いた形（手元の実物から、要らない欄を削ったもの）。
        let json = r#"{"pid":12984,"sessionId":"affe1d77-5d0f-484e-970d-721954a845cc","cwd":"C:\\Users\\me\\pike","startedAt":1795016512851,"procStart":"134394901114631386","version":"2.1.327","kind":"interactive","entrypoint":"cli","name":"pike-47","status":"busy","updatedAt":1795016607370,"statusUpdatedAt":1795016607370}"#;
        let r: SessionRecord = serde_json::from_str(json).unwrap();
        assert_eq!(r.pid, 12984);
        assert_eq!(r.cwd, r"C:\Users\me\pike");
        assert_eq!(r.status.as_deref(), Some("busy"));
        assert_eq!(r.proc_start.as_deref(), Some("134394901114631386"));
        assert!(!r.spare);
        // 古い版の記録（状態を持たない）も読めはする。一覧からは外す。
        let old =
            r#"{"pid":10676,"sessionId":"6193e06a","cwd":"/home/me/x","startedAt":1774514586837}"#;
        let r: SessionRecord = serde_json::from_str(old).unwrap();
        assert!(r.status.is_none());
    }
}
