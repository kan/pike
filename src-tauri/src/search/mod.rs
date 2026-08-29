use crate::types::{spawn_capped_lines, ShellConfig};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct SearchState {
    pub bundled_rg: Option<String>,
    /// Detected backend keyed by shell identity (`wsl:<distro>` vs `windows`).
    /// A single global slot was wrong: a Windows project caching `BundledRg`
    /// (a Windows .exe) would leak into a WSL project running in another
    /// window, which then tried to exec that path inside WSL. Keying by shell
    /// keeps each environment's backend separate.
    pub detected: Arc<Mutex<HashMap<String, SearchBackend>>>,
}

/// Probe for the best available search backend for `shell` (blocking: spawns
/// `which`/`where`). WSL never uses the bundled Windows rg.
fn detect_backend(shell: &ShellConfig, bundled_rg: &Option<String>) -> SearchBackend {
    // macOS / Linux では `augment_process_path` が起動時に PATH を広げているので、
    // Homebrew 等に入った rg もここで見つかる。
    let check_cmd = if shell.is_posix() { "which" } else { "where" };
    if let Ok((0, _, _)) = shell.run(check_cmd, &["rg"]) {
        return SearchBackend::Rg;
    }
    // 同梱の rg はホストのバイナリなので、WSL の中では実行できない。
    if !matches!(shell, ShellConfig::Wsl { .. }) {
        if let Some(path) = bundled_rg {
            return SearchBackend::BundledRg { path: path.clone() };
        }
    }
    SearchBackend::Grep
}

/// Return the cached backend for `shell`, detecting and caching on first use.
/// Blocking — call inside `spawn_blocking`.
pub(crate) fn resolve_backend(
    shell: &ShellConfig,
    bundled_rg: &Option<String>,
    cache: &Mutex<HashMap<String, SearchBackend>>,
) -> SearchBackend {
    let key = crate::types::install_key(shell);
    if let Ok(map) = cache.lock() {
        if let Some(b) = map.get(&key) {
            return b.clone();
        }
    }
    let backend = detect_backend(shell, bundled_rg);
    if let Ok(mut map) = cache.lock() {
        map.insert(key, backend.clone());
    }
    backend
}

#[derive(Clone)]
pub(crate) enum SearchBackend {
    Rg,
    BundledRg { path: String },
    Grep,
}

impl SearchBackend {
    pub(crate) fn is_rg(&self) -> bool {
        matches!(self, SearchBackend::Rg | SearchBackend::BundledRg { .. })
    }

    pub(crate) fn rg_program(&self) -> &str {
        match self {
            SearchBackend::BundledRg { path } => path,
            _ => "rg",
        }
    }

    fn label(&self) -> &str {
        match self {
            SearchBackend::Rg | SearchBackend::BundledRg { .. } => "rg",
            SearchBackend::Grep => "grep",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn search_detect_backend(
    shell: ShellConfig,
    state: State<'_, SearchState>,
) -> Result<String, String> {
    let bundled = state.bundled_rg.clone();
    let cache = state.detected.clone();
    let backend = tokio::task::spawn_blocking(move || resolve_backend(&shell, &bundled, &cache))
        .await
        .map_err(|e| e.to_string())?;

    Ok(backend.label().to_string())
}

const MAX_MATCHES: usize = 500;
const MAX_FILES: usize = 10000;
#[tauri::command]
pub async fn list_project_files(
    shell: ShellConfig,
    root: String,
    state: State<'_, SearchState>,
) -> Result<Vec<String>, String> {
    let bundled = state.bundled_rg.clone();
    let cache = state.detected.clone();

    tokio::task::spawn_blocking(move || {
        let backend = resolve_backend(&shell, &bundled, &cache);
        let cmd = if backend.is_rg() {
            shell.command(backend.rg_program(), &["--files", "--", &root])
        } else if shell.is_posix() {
            // Fallback to find (POSIX) or dir (Windows). macOS のローカルシェルも
            // find 側（`cmd.exe` に落とすと Ctrl+P の一覧が丸ごと空になる）。
            shell.command(
                "find",
                &[&root, "-type", "f", "-not", "-path", "*/.git/*", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/target/*"],
            )
        } else {
            shell.command("cmd.exe", &["/C", &format!("dir /S /B /A:-D \"{root}\"")])
        };

        // 検索と同じく上限で打ち切る（#257）。大きなリポジトリでは `--files` の出力も
        // 数 MB になり、`MAX_FILES` を超えた分は作らせるだけ無駄になる。
        let run = spawn_capped_lines(cmd, "file list", MAX_FILES, |line| {
            (!line.is_empty()).then(|| line.to_string())
        })?;
        Ok(run.items)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// rg の `--json` の 1 行。マッチ以外（`begin` / `end` / `summary`）と壊れた行は `None`。
fn parse_rg_line(line: &str) -> Option<SearchMatch> {
    // 捨てる行に DOM を組まない。rg はマッチするファイルごとに `begin` と `end` を出すので、
    // 500 件が 200 ファイルに散っていれば 400 行が作った端から捨てられる。文字列を含むかの
    // 判定だけ先にやる（本文に "match" を含む行は素通りして、下の本パースが弾く）。
    if !line.contains("\"match\"") {
        return None;
    }
    let v = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("match") {
        return None;
    }
    let data = v.get("data")?;
    Some(SearchMatch {
        path: data
            .get("path")
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        line: data
            .get("line_number")
            .and_then(|n| n.as_u64())
            .unwrap_or(0) as u32,
        content: data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim_end()
            .to_string(),
    })
}

/// grep の `-rn` の 1 行（`パス:行:本文`）。行番号を持たない行は `None`。
fn parse_grep_line(line: &str) -> Option<SearchMatch> {
    let mut parts = line.splitn(3, ':');
    let path = parts.next().unwrap_or("");
    let line_num: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let content = parts.next().unwrap_or("").trim_end();
    if line_num == 0 || path.is_empty() {
        return None;
    }
    Some(SearchMatch {
        path: path.to_string(),
        line: line_num,
        content: content.to_string(),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_execute(
    shell: ShellConfig,
    root: String,
    query: String,
    is_regex: bool,
    glob_include: Option<String>,
    glob_exclude: Option<String>,
    max_results: Option<u32>,
    state: State<'_, SearchState>,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
        });
    }

    let bundled = state.bundled_rg.clone();
    let cache = state.detected.clone();

    // 打ち切りの上限。呼び出し側が大きい値を渡しても `MAX_MATCHES` を超えない
    // （パネルは全件を描けないし、超えた分は結局捨てることになる）。
    let cap = (max_results.unwrap_or(MAX_MATCHES as u32) as usize).min(MAX_MATCHES);

    let inc_glob = glob_include.map(|g| {
        if g.contains('*') || g.contains('?') { g } else if g.contains('.') { format!("*.{}", g.trim_start_matches('.')) } else { format!("*{g}*") }
    });
    let exc_glob = glob_exclude.map(|g| {
        if g.contains('*') || g.contains('?') { g } else { format!("*{g}*") }
    });

    tokio::task::spawn_blocking(move || {
        let backend = resolve_backend(&shell, &bundled, &cache);
        let run = if backend.is_rg() {
            let mut args: Vec<String> = vec!["--json".to_string()];
            if !is_regex {
                args.push("-F".to_string());
            }
            if let Some(ref inc) = inc_glob {
                args.push("--glob".to_string());
                args.push(inc.clone());
            }
            if let Some(ref exc) = exc_glob {
                args.push("--glob".to_string());
                args.push(format!("!{exc}"));
            }
            args.push("--max-count".to_string());
            args.push("20".to_string());
            args.push("-e".to_string());
            args.push(query);
            args.push("--".to_string());
            args.push(root);

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            spawn_capped_lines(
                shell.command(backend.rg_program(), &arg_refs),
                "rg",
                cap,
                parse_rg_line,
            )
        } else {
            let mut args: Vec<String> = vec!["-rn".to_string()];
            if !is_regex {
                args.push("-F".to_string());
            } else {
                args.push("-E".to_string());
            }
            if let Some(ref inc) = inc_glob {
                args.push(format!("--include={inc}"));
            }
            args.push("-m".to_string());
            args.push("20".to_string());
            args.push("--exclude-dir=.git".to_string());
            args.push("--exclude-dir=node_modules".to_string());
            args.push("--exclude-dir=target".to_string());
            if let Some(ref exc) = exc_glob {
                args.push(format!("--exclude={exc}"));
                args.push(format!("--exclude-dir={exc}"));
            }
            args.push("-e".to_string());
            args.push(query);
            args.push("--".to_string());
            args.push(root);

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            spawn_capped_lines(shell.command("grep", &arg_refs), "grep", cap, parse_grep_line)
        };

        let run = run?;
        if run.code == 2 {
            if !is_regex {
                // literal (-F) mode should never cause regex parse errors;
                // treat as "no results" rather than propagating a confusing error
                return Ok(SearchResult { matches: vec![], truncated: false });
            }
            return Err(run.stderr);
        }
        Ok(SearchResult {
            // 打ち切ったかは件数から分かる（`spawn_capped_lines` は上限で止まる）。
            truncated: run.items.len() >= cap,
            matches: run.items,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rg_match_line_is_parsed() {
        // 本文の末尾は落とす（rg は行末の改行を含めて返す。ここでは同じ扱いになる
        // 末尾の空白で見ている）。
        let line = r#"{"type":"match","data":{"path":{"text":"src/main.rs"},"lines":{"text":"fn main() {  "},"line_number":12}}"#;
        let m = parse_rg_line(line).expect("match line");
        assert_eq!(m.path, "src/main.rs");
        assert_eq!(m.line, 12);
        assert_eq!(m.content, "fn main() {");
    }

    #[test]
    fn rg_non_match_lines_are_skipped() {
        // `--json` はマッチ以外の行も流す。数えるのはマッチだけ（上限の意味が変わる）。
        assert!(parse_rg_line(r#"{"type":"begin","data":{"path":{"text":"a.rs"}}}"#).is_none());
        assert!(parse_rg_line(r#"{"type":"summary","data":{}}"#).is_none());
        assert!(parse_rg_line("not json").is_none());
        assert!(parse_rg_line("").is_none());
    }

    #[test]
    fn grep_line_is_parsed() {
        let m = parse_grep_line("src/lib.rs:7:    let x = 1;  ").expect("match line");
        assert_eq!(m.path, "src/lib.rs");
        assert_eq!(m.line, 7);
        assert_eq!(m.content, "    let x = 1;");
    }

    #[test]
    fn grep_lines_without_a_number_are_skipped() {
        // `--` の区切りや、バイナリを飛ばした旨の通知が混ざる。
        assert!(parse_grep_line("--").is_none());
        assert!(parse_grep_line("grep: a.bin: binary file matches").is_none());
        assert!(parse_grep_line("").is_none());
    }

    #[test]
    fn grep_keeps_colons_in_the_matched_text() {
        let m = parse_grep_line("a.ts:3:const url = 'https://example.com'").expect("match line");
        assert_eq!(m.content, "const url = 'https://example.com'");
    }
}
