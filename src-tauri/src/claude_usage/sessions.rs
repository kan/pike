//! Recent Claude Code sessions of a project — the data behind `claude -r`'s
//! picker, for the terminal's agent launch menu (#220).
//!
//! The CLI has no machine-readable session list, so the transcripts are read
//! directly from `~/.claude/projects/<encoded-root>/*.jsonl` (the directory
//! `claude_usage` already walks for token counts).

use super::{config, encode_project_path};
// 題の切り方は 4 つのアダプタで共有する（`shorten` の doc）。ここに写しを持たない。
use crate::agent_sessions::{AgentSession, shorten};
use crate::types::{ShellConfig, validate_slug};
use serde::Deserialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Transcripts inspected before giving up. Most files in the directory are
/// short `-p` runs (Pike's own `/usage` probe, hooks, review agents) that are
/// rejected after a line or two, so the scan budget outruns the result budget.
const MAX_SCAN_FILES: usize = 200;
/// 先頭から読む量の上限。普通は数行目の `entrypoint` と最初の題の行で止まるので、これは
/// 題を持たない記録の歯止め。WSL では `\\wsl.localhost` 越しに読む。
const MAX_HEAD_BYTES: u64 = 1 << 20;
/// 題を探すために末尾から最初に読む量（#476）。題になる行（`custom-title` / `last-prompt`）は
/// ターンごとに追記されるので、最新のものはたいてい末尾の近くにある。
const TAIL_FIRST_BYTES: u64 = 64 * 1024;
/// 末尾から遡る量の上限。最後のターンの出力が大きく、末尾の窓に題の行が無いときは、
/// 窓を倍にしながらここまで遡る。
const MAX_TAIL_BYTES: u64 = 2 << 20;
/// Lines above this are tool results and pasted files, never a title record.
const MAX_TITLE_LINE_BYTES: usize = 4096;
const ENTRYPOINT_PAT: &str = "\"entrypoint\":\"";
const GIT_BRANCH_PAT: &str = "\"gitBranch\":\"";

/// 題になる行（`custom-title` / `ai-title` / `last-prompt`）。どれも小さな独立した行で、
/// 値にエスケープや改行を含むので、[`raw_str_field`] で拾う欄と違って解析する価値がある。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleLine {
    custom_title: Option<String>,
    ai_title: Option<String>,
    last_prompt: Option<String>,
}

/// Read a `"key":"value"` pair straight out of a raw transcript line, given the
/// `"key":"` prefix to look for. Lines can be megabytes (tool results, pasted
/// files) while `entrypoint` / `gitBranch` are short unescaped tokens, so
/// scanning beats parsing the whole record.
fn raw_str_field<'a>(line: &'a str, pat: &str) -> Option<&'a str> {
    let rest = &line[line.find(pat)? + pat.len()..];
    Some(&rest[..rest.find('"')?])
}

/// What the picker shows, accumulated one line at a time so the reader can walk
/// a transcript on a single reused buffer instead of allocating per line.
///
/// **記録は 2 か所から読む**（#476。[`read_session`]）。対話のセッションか（`entrypoint`）と
/// ブランチは先頭の数行にあり、題になる行はターンごとに追記されるので末尾にある。
#[derive(Default)]
struct TranscriptScan {
    interactive: bool,
    git_branch: Option<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    last_prompt: Option<String>,
}

impl TranscriptScan {
    /// 題になる行なら覚える。**どれも後の行で上書きする**（`custom-title` は名前を付け直す
    /// たび、`last-prompt` はターンごとに書き足されるので、最新の行が今の名前）。
    ///
    /// **本文の無い行は空振りとして飛ばす。** 最近の Claude Code は `last-prompt` を
    /// `{"type":"last-prompt","leafUuid":…}` の形でも書き、`lastPrompt` を持たない。
    fn add_title_line(&mut self, line: &str) {
        // 長さで先に弾く: 周りの行はツールの結果や貼り付けたファイルで数 MB になる。
        if line.len() > MAX_TITLE_LINE_BYTES
            || !(line.contains("\"custom-title\"")
                || line.contains("\"ai-title\"")
                || line.contains("\"last-prompt\""))
        {
            return;
        }
        let Ok(t) = serde_json::from_str::<TitleLine>(line) else {
            return;
        };
        let keep = |slot: &mut Option<String>, value: Option<String>| {
            if let Some(v) = value.filter(|v| !v.trim().is_empty()) {
                *slot = Some(v);
            }
        };
        keep(&mut self.custom_title, t.custom_title);
        keep(&mut self.ai_title, t.ai_title);
        keep(&mut self.last_prompt, t.last_prompt);
    }

    fn has_title(&self) -> bool {
        self.custom_title.is_some() || self.ai_title.is_some() || self.last_prompt.is_some()
    }

    /// 末尾から読んだ窓の題で上書きする（あちらのほうが新しい）。
    fn take_titles_from(&mut self, newer: TranscriptScan) {
        self.custom_title = newer.custom_title.or(self.custom_title.take());
        self.ai_title = newer.ai_title.or(self.ai_title.take());
        self.last_prompt = newer.last_prompt.or(self.last_prompt.take());
    }

    /// 先頭から読む 1 行。`false` を返したら先頭はもう読まなくてよい: 対話のセッションでは
    /// ないと分かったか、対話のセッションで題も 1 つ取れた。
    ///
    /// **題が取れるまで読み続ける**（#476 の前と同じ止め方）。`ai-title` は最初の利用者の行の
    /// 数行あとに 1 度だけ書かれるので、末尾の窓には入らないことが多い。
    fn add_head_line(&mut self, line: &str) -> bool {
        self.add_title_line(line);
        if self.git_branch.is_none() {
            self.git_branch = raw_str_field(line, GIT_BRANCH_PAT).map(str::to_owned);
        }
        if !self.interactive
            && let Some(entrypoint) = raw_str_field(line, ENTRYPOINT_PAT)
        {
            // `-p` / SDK runs share the directory but resuming them in a
            // terminal is not what the user is after.
            if entrypoint != "cli" {
                return false;
            }
            self.interactive = true;
        }
        !(self.interactive && self.has_title())
    }

    /// `None` means the session is not offered in the picker: either it is not
    /// an interactive run, or there is nothing to label it with.
    ///
    /// **題の優先は `custom-title` → `ai-title` → `last-prompt`**（#476）。`custom-title` は
    /// 利用者やスキルが付けた名前で、`claude --resume` のピッカーもこれを出す。
    fn finish(self) -> Option<(String, Option<String>)> {
        if !self.interactive {
            return None;
        }
        let title = self.custom_title.or(self.ai_title).or(self.last_prompt)?;
        let title = shorten(&title);
        if title.is_empty() {
            return None;
        }
        Some((title, self.git_branch))
    }
}

/// `[start, end)` の範囲にある題の行を読む。
///
/// **1 バイト手前から読み、最初の 1 行を捨てる。** `start` が行の頭なら捨てるのは直前の
/// 改行だけで、行の途中なら切れた残りを捨てる。先頭の読み取りが数えた位置（`head`）は
/// CRLF や読めないバイトで実際の位置とずれうるので、行の頭だと決めつけない。
///
/// **`end` をまたぐ行は最後まで読む**（題の行の長さぶんだけ余分に読む）。切ると、後ろの
/// 窓では途中から始まるので捨てられ、前の窓では壊れた JSON になって、どちらでも拾えない。
fn scan_titles(file: &mut fs::File, start: u64, end: u64) -> TranscriptScan {
    let mut scan = TranscriptScan::default();
    let from = start.saturating_sub(1);
    if file.seek(SeekFrom::Start(from)).is_err() {
        return scan;
    }
    let limit = end - from + MAX_TITLE_LINE_BYTES as u64 + 1;
    let mut first = start > 0;
    crate::types::for_each_line(Read::take(file, limit), |line| {
        if first {
            first = false;
        } else {
            scan.add_title_line(line);
        }
        true
    });
    scan
}

/// `resume_dir` は置き場で決まる（[`session_dirs`]）ので、どこから読んだかを知っている
/// 呼び出し側が渡す。
fn read_session(path: &Path, modified_at: u64, resume_dir: Option<&str>) -> Option<AgentSession> {
    // The id is interpolated into a shell command line, and it comes from a
    // file name rather than from Claude itself — keep it to the id alphabet.
    let id = path.file_stem()?.to_str()?;
    validate_slug(id, "session id").ok()?;

    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut scan = TranscriptScan::default();

    // 1. 先頭: 対話のセッションか、ブランチ、最初の題。バッファを使い回す読み方は
    //    `types::for_each_line`（#382）。
    let mut head = 0u64;
    crate::types::for_each_line(&mut file, |line| {
        // 上限は**読む前**に見る。上限をまたいだ 1 行はそのまま処理して、次の行で止まる。
        if head >= MAX_HEAD_BYTES {
            return false;
        }
        head += line.len() as u64 + 1;
        scan.add_head_line(line)
    });
    if !scan.interactive {
        return None;
    }

    // 2. 末尾: 新しい題（#476）。**先頭から読むだけでは届かない**: 作業が長く続くセッション
    //    （worktree へ移るものが典型）は、`custom-title` や本文付きの `last-prompt` が数 MB 先に
    //    しか無い。末尾の窓に題の行が無ければ（最後のターンの出力が大きい）、窓を倍にして
    //    遡る。先頭で読んだところまでは遡らない。
    let mut end = len;
    let mut window = TAIL_FIRST_BYTES;
    while end > head && len - end < MAX_TAIL_BYTES {
        let start = end.saturating_sub(window).max(head);
        let newer = scan_titles(&mut file, start, end);
        if newer.has_title() {
            scan.take_titles_from(newer);
            break;
        }
        end = start;
        window *= 2;
    }

    let (title, git_branch) = scan.finish()?;
    Some(AgentSession {
        id: id.to_owned(),
        title,
        modified_at,
        git_branch,
        resume_dir: resume_dir.map(str::to_owned),
    })
}

/// 記録を探すディレクトリ 1 つ（`projects/<slug>/`）。
#[derive(Debug, PartialEq)]
struct SessionDir {
    slug: String,
    /// そこの記録を再開する前に移るディレクトリ。一覧を引いた場所そのものなら `None`。
    resume_dir: Option<String>,
}

/// 一覧を引いた場所と、そのリポジトリの worktree から、記録を探すディレクトリを決める（#432）。
///
/// **Claude は記録を「書いた時点の作業ディレクトリ」の slug に置く。** セッションの途中で
/// worktree へ移ると、以降の記録は移動先の slug の下に書かれ、起動した場所の slug からは
/// 見えない。再開も同じで、`claude --resume` は今居るディレクトリの slug しか探さない。
///
/// **slug からパスへは戻せない**（`/`・`.`・`-` がどれも `-` になる）ので、逆向きに
/// 「分かっているパスを slug にする」。こうすると再開先のディレクトリは slug と一緒に
/// 決まり、記録の中身から `cwd` を探す必要が無い（あちらは Bash で `cd` したサブ
/// ディレクトリも混ざるので、最後の行をそのまま使えない）。
///
/// **slug の前方一致で探さないこと。** `repo` の slug は `repo-old` という別のディレクトリの
/// slug の前置でもある。
///
/// 先頭は必ず `root`。同じ slug になるものは先のものを残す（`root` 自身も worktree の
/// 一覧に出てくる。Windows では区切りが `\` と `/` で違うが、slug は同じになる）。
///
/// **`fold_case` は Windows 側のシェルで真にする。** ターミナルの現在地は打った綴りの
/// まま（`cd c:\users\x`）で、git は実際の綴りで返す。大文字小文字を区別しない
/// ファイルシステムではどちらの slug も同じディレクトリを指すので、畳まないと同じ記録を
/// 2 回読み、移らなくてよいセッションに移る先が付く。
fn session_dirs(root: &str, worktrees: &[String], fold_case: bool) -> Vec<SessionDir> {
    let same = |a: &str, b: &str| {
        if fold_case {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut dirs = vec![SessionDir {
        slug: encode_project_path(root),
        resume_dir: None,
    }];
    for path in worktrees {
        let slug = encode_project_path(path);
        if dirs.iter().all(|d| !same(&d.slug, &slug)) {
            dirs.push(SessionDir {
                slug,
                resume_dir: Some(path.clone()),
            });
        }
    }
    dirs
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    let ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(ms as u64)
}

/// **件数は呼び出し側が決める**（#267）。メニューの階層によって並べたい数が違い、
/// ここで固定すると増やすたびにこのモジュールを触ることになる。
pub(crate) fn list_sessions(
    shell: &ShellConfig,
    project_root: &str,
    limit: usize,
) -> Vec<AgentSession> {
    let Some(claude_dir) = config::resolve(shell, project_root).read_path else {
        return Vec::new();
    };
    // worktree の記録も読む（#432。理由は `session_dirs` の doc）。**git を 1 回起こす**が、
    // ここが走るのはメニューを開いたときだけ（`agent_sessions` の doc）。
    let projects = claude_dir.join("projects");
    let dirs = session_dirs(
        project_root,
        &crate::git::worktree_paths(shell, project_root),
        shell.is_windows(),
    );

    let mut files: Vec<(PathBuf, u64, Option<&str>)> = Vec::new();
    for dir in &dirs {
        let Ok(entries) = fs::read_dir(projects.join(&dir.slug)) else {
            continue;
        };
        let resume_dir = dir.resume_dir.as_deref();
        files.extend(
            entries
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
                .filter_map(|e| Some((e.path(), modified_ms(&e.metadata().ok()?)?, resume_dir))),
        );
    }
    files.sort_unstable_by_key(|(_, modified, _)| std::cmp::Reverse(*modified));

    let mut sessions: Vec<AgentSession> = Vec::new();
    for (path, modified_at, resume_dir) in files.into_iter().take(MAX_SCAN_FILES) {
        if sessions.len() >= limit {
            break;
        }
        // **同じ id は新しいほうだけ出す。** 途中で worktree へ移ったセッションは、起動した
        // 場所と移動先の両方に同じ名前の記録を残しうる。続きが書かれているのは新しいほうで、
        // 再開先もそちら。id はファイル名なので、開く前に分かる。
        if sessions
            .iter()
            .any(|s| path.file_stem().is_some_and(|stem| stem == s.id.as_str()))
        {
            continue;
        }
        if let Some(session) = read_session(&path, modified_at, resume_dir) {
            sessions.push(session);
        }
    }
    sessions
}

// 一覧を IPC で出す口は `agent_sessions` に一本化した（#267）。ここが持つのは収集だけ。

#[cfg(test)]
mod tests {
    use super::{
        AgentSession, ENTRYPOINT_PAT, GIT_BRANCH_PAT, MAX_HEAD_BYTES, SessionDir, TranscriptScan,
        raw_str_field, read_session, session_dirs, shorten,
    };
    use crate::agent_sessions::MAX_TITLE_CHARS;
    use std::fs;

    fn dir(slug: &str, resume_dir: Option<&str>) -> SessionDir {
        SessionDir {
            slug: slug.to_owned(),
            resume_dir: resume_dir.map(str::to_owned),
        }
    }

    #[test]
    fn session_dirs_adds_worktrees_after_the_root() {
        let worktrees = [
            "/home/kan/sitter".to_owned(),
            "/home/kan/sitter/.worktree/com-531".to_owned(),
        ];
        assert_eq!(
            session_dirs("/home/kan/sitter", &worktrees, false),
            [
                // 一覧を引いた場所は移らずに再開できる。worktree の一覧に出てきた同じ場所は畳む。
                dir("-home-kan-sitter", None),
                dir(
                    "-home-kan-sitter--worktree-com-531",
                    Some("/home/kan/sitter/.worktree/com-531")
                ),
            ]
        );
    }

    #[test]
    fn session_dirs_folds_separators_that_encode_alike() {
        // git は Windows でも `/` で返す。slug は同じなので、`root` の側（移らない）を残す。
        let worktrees = [
            "C:/Users/k/pike".to_owned(),
            "C:/Users/k/pike-wt".to_owned(),
        ];
        assert_eq!(
            session_dirs(r"C:\Users\k\pike", &worktrees, true),
            [
                dir("C--Users-k-pike", None),
                dir("C--Users-k-pike-wt", Some("C:/Users/k/pike-wt")),
            ]
        );
    }

    #[test]
    fn session_dirs_folds_case_only_where_the_filesystem_does() {
        // 打った綴り（`cd c:\users\k\PIKE`）と git が返す実際の綴りは、Windows では同じ場所。
        let worktrees = ["C:/Users/k/pike".to_owned()];
        assert_eq!(
            session_dirs(r"c:\users\k\PIKE", &worktrees, true),
            [dir("c--users-k-PIKE", None)]
        );
        // POSIX では別のディレクトリなので畳まない。
        let worktrees = ["/r/Wt".to_owned()];
        assert_eq!(
            session_dirs("/r/wt", &worktrees, false),
            [dir("-r-wt", None), dir("-r-Wt", Some("/r/Wt"))]
        );
    }

    #[test]
    fn session_dirs_from_inside_a_worktree_offers_the_main_tree() {
        // worktree のターミナルで開いたときは、main の記録が「移ってから再開」になる。
        let worktrees = ["/r".to_owned(), "/r/.wt/a".to_owned()];
        assert_eq!(
            session_dirs("/r/.wt/a", &worktrees, false),
            [dir("-r--wt-a", None), dir("-r", Some("/r"))]
        );
    }

    #[test]
    fn session_dirs_without_worktrees_is_just_the_root() {
        assert_eq!(session_dirs("/r", &[], false), [dir("-r", None)]);
    }

    /// `read_session` と同じ読み方: 先頭の行を `entrypoint` が出るまで読み、残りを題として読む。
    fn scan(lines: &[&str]) -> Option<(String, Option<String>)> {
        let mut scan = TranscriptScan::default();
        let mut rest = lines.iter();
        for line in rest.by_ref() {
            if !scan.add_head_line(line) {
                break;
            }
        }
        for line in rest {
            scan.add_title_line(line);
        }
        scan.finish()
    }

    const USER_LINE: &str = r#"{"type":"user","message":{"role":"user","content":"hi"},"entrypoint":"cli","cwd":"C:\\p","gitBranch":"main"}"#;

    #[test]
    fn raw_field_reads_short_tokens() {
        assert_eq!(raw_str_field(USER_LINE, ENTRYPOINT_PAT), Some("cli"));
        assert_eq!(raw_str_field(USER_LINE, GIT_BRANCH_PAT), Some("main"));
        assert_eq!(raw_str_field(USER_LINE, "\"missing\":\""), None);
    }

    #[test]
    fn prefers_ai_title_over_last_prompt() {
        let got = scan(&[
            USER_LINE,
            r#"{"type":"last-prompt","lastPrompt":"first ask"}"#,
            r#"{"type":"ai-title","aiTitle":"Nice title"}"#,
        ]);
        assert_eq!(
            got,
            Some(("Nice title".to_owned(), Some("main".to_owned())))
        );
    }

    #[test]
    fn falls_back_to_the_latest_prompt() {
        let got = scan(&[
            USER_LINE,
            r#"{"type":"last-prompt","lastPrompt":"first ask"}"#,
            r#"{"type":"last-prompt","lastPrompt":"later ask\nsecond line"}"#,
        ]);
        // Multi-line prompts collapse to their first line.
        assert_eq!(got.unwrap().0, "later ask");
    }

    #[test]
    fn skips_non_interactive_runs() {
        let sdk = r#"{"type":"user","entrypoint":"sdk-cli","gitBranch":"main"}"#;
        assert_eq!(scan(&[sdk, r#"{"type":"ai-title","aiTitle":"x"}"#]), None);
    }

    #[test]
    fn skips_transcripts_without_a_title() {
        assert_eq!(scan(&[USER_LINE]), None);
        assert_eq!(scan(&[]), None);
    }

    #[test]
    fn prefers_the_latest_custom_title() {
        // `claude --resume` のピッカーと同じ名前（#476）。付け直したら新しいほう。
        let got = scan(&[
            USER_LINE,
            r#"{"type":"ai-title","aiTitle":"Generated"}"#,
            r#"{"type":"last-prompt","lastPrompt":"ask"}"#,
            r#"{"type":"custom-title","customTitle":"COM-565 first"}"#,
            r#"{"type":"agent-name","agentName":"COM-565 first"}"#,
            r#"{"type":"custom-title","customTitle":"COM-565 renamed"}"#,
        ]);
        assert_eq!(got.unwrap().0, "COM-565 renamed");
    }

    #[test]
    fn skips_last_prompt_lines_without_text() {
        // 最近の記録は本文の無い `last-prompt` も書く（#476）。空振りとして前の値を残す。
        let got = scan(&[
            USER_LINE,
            r#"{"type":"last-prompt","lastPrompt":"real ask"}"#,
            r#"{"type":"last-prompt","leafUuid":"u1","sessionId":"s1"}"#,
            r#"{"type":"last-prompt","lastPrompt":"  "}"#,
        ]);
        assert_eq!(got.unwrap().0, "real ask");
        let none = scan(&[USER_LINE, r#"{"type":"last-prompt","leafUuid":"u1"}"#]);
        assert_eq!(none, None);
    }

    /// 書いた記録を `read_session` で読む（テストごとに別のディレクトリを作って消す）。
    fn read_file(name: &str, content: &str) -> Option<AgentSession> {
        let dir = std::env::temp_dir().join(format!("pike-sessions-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.jsonl"));
        fs::write(&path, content).unwrap();
        let got = read_session(&path, 0, None);
        let _ = fs::remove_dir_all(&dir);
        got
    }

    /// 題の行を持たない、1KB ほどの行を `bytes` ぶん。
    fn filler(bytes: usize) -> String {
        let line = format!(r#"{{"type":"assistant","text":"{}"}}"#, "x".repeat(1000));
        format!("{line}\n").repeat(bytes / line.len() + 1)
    }

    #[test]
    fn reads_the_title_from_the_end_of_a_long_transcript() {
        // 題の行が先頭の上限より後ろにしか無い記録（#476 の worktree へ移ったセッション）。
        let content = format!(
            "{USER_LINE}\n{}{}\n",
            filler(MAX_HEAD_BYTES as usize + 10_000),
            r#"{"type":"custom-title","customTitle":"COM-565 work"}"#
        );
        let got = read_file("long-session", &content).unwrap();
        assert_eq!(got.title, "COM-565 work");
        assert_eq!(got.git_branch.as_deref(), Some("main"));
    }

    #[test]
    fn keeps_an_early_ai_title_of_a_long_transcript() {
        // `ai-title` は最初に 1 度だけ書かれる。末尾に題の行が無くても、先頭で拾える。
        let content = format!(
            "{USER_LINE}\n{}\n{}",
            r#"{"type":"ai-title","aiTitle":"Generated"}"#,
            filler(3 << 20)
        );
        assert_eq!(
            read_file("early-title", &content).unwrap().title,
            "Generated"
        );
    }

    #[test]
    fn walks_back_past_a_large_last_turn() {
        // 最後のターンの出力が末尾の最初の窓より大きい。題の行はその手前にある。
        let content = format!(
            "{USER_LINE}\n{}{}\n{}",
            filler(MAX_HEAD_BYTES as usize + 10_000),
            r#"{"type":"last-prompt","lastPrompt":"before the big output"}"#,
            filler(300_000)
        );
        assert_eq!(
            read_file("large-last-turn", &content).unwrap().title,
            "before the big output"
        );
    }

    #[test]
    fn reads_titles_between_the_head_and_the_tail_of_a_short_transcript() {
        let content = format!(
            "{USER_LINE}\n{}\n{}\n",
            r#"{"type":"assistant","text":"hello"}"#,
            r#"{"type":"last-prompt","lastPrompt":"short ask"}"#
        );
        assert_eq!(
            read_file("short-session", &content).unwrap().title,
            "short ask"
        );
    }

    #[test]
    fn shorten_caps_long_text() {
        let long = "あ".repeat(MAX_TITLE_CHARS + 10);
        let out = shorten(&long);
        assert_eq!(out.chars().count(), MAX_TITLE_CHARS + 1);
        assert!(out.ends_with('…'));
        assert_eq!(shorten("  spaced  \nrest"), "spaced");
    }
}
