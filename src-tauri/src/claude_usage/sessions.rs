//! Recent Claude Code sessions of a project — the data behind `claude -r`'s
//! picker, for the terminal's agent launch menu (#220).
//!
//! The CLI has no machine-readable session list, so the transcripts are read
//! directly from `~/.claude/projects/<encoded-root>/*.jsonl` (the directory
//! `claude_usage` already walks for token counts).

use super::{config, encode_project_path};
// 題の切り方は 4 つのアダプタで共有する（`shorten` の doc）。ここに写しを持たない。
use crate::agent_sessions::{shorten, AgentSession};
use crate::types::{validate_slug, ShellConfig};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Transcripts inspected before giving up. Most files in the directory are
/// short `-p` runs (Pike's own `/usage` probe, hooks, review agents) that are
/// rejected after a line or two, so the scan budget outruns the result budget.
const MAX_SCAN_FILES: usize = 200;
/// Bytes read from one transcript. The scan normally stops after a handful of
/// lines; this bounds the exception (a session Claude never titled), which
/// matters most for WSL, where the files come over the `\\wsl.localhost` share.
const MAX_TRANSCRIPT_BYTES: usize = 1 << 20;
/// Lines above this are tool results and pasted files, never a title record.
const MAX_TITLE_LINE_BYTES: usize = 4096;
const ENTRYPOINT_PAT: &str = "\"entrypoint\":\"";
const GIT_BRANCH_PAT: &str = "\"gitBranch\":\"";

/// `{"type":"ai-title","aiTitle":…}` / `{"type":"last-prompt","lastPrompt":…}`.
/// Both are small standalone records whose values carry escapes and newlines,
/// so — unlike the fields read by [`raw_str_field`] — they are worth parsing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleLine {
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
#[derive(Default)]
struct TranscriptScan {
    interactive: bool,
    git_branch: Option<String>,
    ai_title: Option<String>,
    last_prompt: Option<String>,
}

impl TranscriptScan {
    /// Returns `false` once there is nothing left to learn from the transcript.
    fn add_line(&mut self, line: &str) -> bool {
        // ai-title / last-prompt are small standalone records whose values carry
        // escapes and newlines, so they are worth a real parse — behind a length
        // gate that keeps the search off the huge lines around them.
        if line.len() <= MAX_TITLE_LINE_BYTES
            && (line.contains("\"ai-title\"") || line.contains("\"last-prompt\""))
        {
            if let Ok(t) = serde_json::from_str::<TitleLine>(line) {
                // The title is written once and never revised; the prompt is
                // rewritten every turn, so the latest one is the interesting one.
                if self.ai_title.is_none() {
                    self.ai_title = t.ai_title;
                }
                if t.last_prompt.is_some() {
                    self.last_prompt = t.last_prompt;
                }
            }
        }
        if !self.interactive {
            if let Some(entrypoint) = raw_str_field(line, ENTRYPOINT_PAT) {
                // `-p` / SDK runs share the directory but resuming them in a
                // terminal is not what the user is after.
                if entrypoint != "cli" {
                    return false;
                }
                self.interactive = true;
            }
        }
        if self.git_branch.is_none() {
            self.git_branch = raw_str_field(line, GIT_BRANCH_PAT).map(str::to_owned);
        }
        // Claude writes its title a handful of lines in, so stopping there keeps
        // a multi-MB session as cheap as a short one. Untitled sessions fall
        // through to the byte budget in `read_session`.
        !(self.interactive && self.ai_title.is_some())
    }

    /// `None` means the session is not offered in the picker: either it is not
    /// an interactive run, or there is nothing to label it with.
    fn finish(self) -> Option<(String, Option<String>)> {
        if !self.interactive {
            return None;
        }
        let title = shorten(&self.ai_title.or(self.last_prompt)?);
        if title.is_empty() {
            return None;
        }
        Some((title, self.git_branch))
    }
}

/// `resume_dir` は置き場で決まる（[`session_dirs`]）ので、どこから読んだかを知っている
/// 呼び出し側が渡す。
fn read_session(path: &Path, modified_at: u64, resume_dir: Option<&str>) -> Option<AgentSession> {
    // The id is interpolated into a shell command line, and it comes from a
    // file name rather than from Claude itself — keep it to the id alphabet.
    let id = path.file_stem()?.to_str()?;
    validate_slug(id, "session id").ok()?;

    // バッファを使い回す読み方は `types::for_each_line`（#382 でここから切り出した。
    // 同じ形を 4 つの利用者が手書きしていた）。
    let mut scan = TranscriptScan::default();
    let mut read = 0;
    crate::types::for_each_line(fs::File::open(path).ok()?, |line| {
        // 上限は**読む前**に見る（元の `while read < MAX` と同じ順）。上限をまたいだ
        // 1 行はそのまま処理して、次の行で止まる。
        if read >= MAX_TRANSCRIPT_BYTES {
            return false;
        }
        read += line.len() + 1;
        scan.add_line(line)
    });

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
        raw_str_field, session_dirs, shorten, SessionDir, TranscriptScan, ENTRYPOINT_PAT,
        GIT_BRANCH_PAT,
    };
    use crate::agent_sessions::MAX_TITLE_CHARS;

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

    fn scan(lines: &[&str]) -> Option<(String, Option<String>)> {
        let mut scan = TranscriptScan::default();
        for line in lines {
            if !scan.add_line(line) {
                break;
            }
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
    fn shorten_caps_long_text() {
        let long = "あ".repeat(MAX_TITLE_CHARS + 10);
        let out = shorten(&long);
        assert_eq!(out.chars().count(), MAX_TITLE_CHARS + 1);
        assert!(out.ends_with('…'));
        assert_eq!(shorten("  spaced  \nrest"), "spaced");
    }
}
