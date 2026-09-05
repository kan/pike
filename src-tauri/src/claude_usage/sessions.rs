//! Recent Claude Code sessions of a project — the data behind `claude -r`'s
//! picker, for the terminal's agent launch menu (#220).
//!
//! The CLI has no machine-readable session list, so the transcripts are read
//! directly from `~/.claude/projects/<encoded-root>/*.jsonl` (the directory
//! `claude_usage` already walks for token counts).

use super::{config, encode_project_path};
use crate::types::{validate_slug, ShellConfig};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Sessions handed to the menu.
const MAX_SESSIONS: usize = 12;
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
/// A title occupies one menu line. The cap is about the IPC payload — a
/// fallback prompt can be a whole pasted document; the menu itself elides.
const MAX_TITLE_CHARS: usize = 120;

const ENTRYPOINT_PAT: &str = "\"entrypoint\":\"";
const GIT_BRANCH_PAT: &str = "\"gitBranch\":\"";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    /// Session id (the transcript's file stem) — the argument of `--resume`.
    pub id: String,
    /// Claude's generated title when it has one, else the session's last prompt.
    pub title: String,
    /// Transcript mtime in epoch ms = the picker's "modified" column.
    pub modified_at: u64,
    pub git_branch: Option<String>,
}

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

/// One menu line: the text's first line, capped at [`MAX_TITLE_CHARS`].
fn shorten(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= MAX_TITLE_CHARS {
        return line.to_string();
    }
    line.chars().take(MAX_TITLE_CHARS).collect::<String>() + "…"
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
            self.git_branch = raw_str_field(line, GIT_BRANCH_PAT).map(str::to_string);
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

fn read_session(path: &Path, modified_at: u64) -> Option<ClaudeSession> {
    // The id is interpolated into a shell command line, and it comes from a
    // file name rather than from Claude itself — keep it to the id alphabet.
    let id = path.file_stem()?.to_str()?;
    validate_slug(id, "session id").ok()?;

    let mut reader = BufReader::new(fs::File::open(path).ok()?);
    let mut scan = TranscriptScan::default();
    let mut line = String::new();
    let mut read = 0;
    while read < MAX_TRANSCRIPT_BYTES {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => read += n,
        }
        if !scan.add_line(&line) {
            break;
        }
    }

    let (title, git_branch) = scan.finish()?;
    Some(ClaudeSession {
        id: id.to_string(),
        title,
        modified_at,
        git_branch,
    })
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

fn list_sessions(shell: &ShellConfig, project_root: &str) -> Vec<ClaudeSession> {
    let Some(claude_dir) = config::resolve(shell, project_root).read_path else {
        return Vec::new();
    };
    let dir = claude_dir
        .join("projects")
        .join(encode_project_path(project_root));
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut files: Vec<(PathBuf, u64)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| Some((e.path(), modified_ms(&e.metadata().ok()?)?)))
        .collect();
    files.sort_unstable_by_key(|(_, modified)| std::cmp::Reverse(*modified));

    let mut sessions = Vec::new();
    for (path, modified_at) in files.into_iter().take(MAX_SCAN_FILES) {
        if sessions.len() >= MAX_SESSIONS {
            break;
        }
        if let Some(session) = read_session(&path, modified_at) {
            sessions.push(session);
        }
    }
    sessions
}

#[tauri::command]
pub async fn claude_sessions_list(
    shell: ShellConfig,
    project_root: String,
) -> Result<Vec<ClaudeSession>, String> {
    tokio::task::spawn_blocking(move || list_sessions(&shell, &project_root))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        raw_str_field, shorten, TranscriptScan, ENTRYPOINT_PAT, GIT_BRANCH_PAT, MAX_TITLE_CHARS,
    };

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
            Some(("Nice title".to_string(), Some("main".to_string())))
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
