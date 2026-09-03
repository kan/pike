use crate::types::{spawn_capped_lines, ShellConfig};
use serde::{Deserialize, Serialize};
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

/// rg の版と、ビルドに入っている機能。**同梱のサイドカーと、その環境に入っている rg の
/// どちらを使うかで違う**ので、プログラムを決めたあとに毎回ここを通す。
///
/// Windows は同梱の rg（このリポジトリが版を決めている）だが、**WSL では distro に
/// 入っているものが使われる**ので、14 系や pcre2 無しのビルドが普通にありうる。だから
/// 「15 以降にしか無い機能」は、版で決め打ちにせずここで見る（#304）。
#[derive(Clone)]
pub struct RgCaps {
    /// `ripgrep 15.2.0 (rev …)` の版の部分。バッジに出す。
    pub version: String,
    /// 比較用に分解した版（major, minor, patch）。読めなかった桁は 0。
    pub semver: [u32; 3],
    /// `-P/--pcre2` が使えるか（`features:+pcre2`）。
    pub pcre2: bool,
}

/// `rg --version` の出力から版と機能を読む。想定する形は次の 2 行目まで:
///
/// ```text
/// ripgrep 15.2.0 (rev e89fff89ac)
///
/// features:+pcre2
/// ```
fn parse_rg_version(stdout: &str) -> Option<RgCaps> {
    let first = stdout.lines().next()?;
    let version = first.strip_prefix("ripgrep ")?.split_whitespace().next()?.to_string();
    let mut semver = [0u32; 3];
    // major だけは読めることを求める（読めなければ rg ではない何かとみなす）。
    // minor / patch は distro が付ける接尾辞で崩れうるので、読めなければ 0 のまま。
    let mut parts = version.split('.');
    semver[0] = parts.next()?.parse().ok()?;
    for slot in semver.iter_mut().skip(1) {
        *slot = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    }
    Some(RgCaps {
        version,
        semver,
        // 機能の行は `features:+pcre2,-simd-accel` のように並ぶ。無い版もあるので、
        // 行の位置ではなく `+pcre2` があるかだけを見る（`-pcre2` に当たらない）。
        pcre2: stdout.contains("+pcre2"),
    })
}

/// `program` を `--version` で叩いて、rg として使えるなら機能を返す。
///
/// **存在確認も兼ねる**（`which` / `where` を別に叩かない）。プログラムが無ければ
/// spawn 自体が失敗するか、シェル越しなら非 0 で返るので、どちらも `None` になる。
fn probe_rg(shell: &ShellConfig, program: &str) -> Option<RgCaps> {
    match shell.run(program, &["--version"]) {
        Ok((0, stdout, _)) => parse_rg_version(&stdout),
        _ => None,
    }
}

/// **新しいほうを使う**（#304）。同値なら利用者が入れたほうを残す。
///
/// 「入っているものを優先」だと、古い rg を入れっぱなしのマシンで、同梱の新しい版が
/// あるのに置換プレビューも PCRE2 も出ない。「同梱を優先」だと、`brew upgrade` で
/// 新しくした人の意思と、そこに入っている gitignore の修正を捨てることになる。
fn prefer_newer(
    system: Option<(String, RgCaps)>,
    bundled: Option<(String, RgCaps)>,
) -> Option<(String, RgCaps)> {
    match (system, bundled) {
        (Some(s), Some(b)) => Some(if b.1.semver > s.1.semver { b } else { s }),
        (found, None) | (None, found) => found,
    }
}

/// Probe for the best available search backend for `shell` (blocking: spawns
/// `rg --version`). WSL never uses the bundled Windows rg.
///
/// **非 WSL では両方を叩く**ので spawn が 2 回になるが、`install_key(shell)` 単位で
/// キャッシュされるうえ、起動時ではなく最初の検索（かタスク検出）まで遅延する。
fn detect_backend(shell: &ShellConfig, bundled_rg: &Option<String>) -> SearchBackend {
    // macOS / Linux では `augment_process_path` が起動時に PATH を広げているので、
    // Homebrew 等に入った rg もここで見つかる。
    let system = probe_rg(shell, "rg").map(|caps| ("rg".to_string(), caps));
    // 同梱の rg はホストのバイナリなので、WSL の中では実行できない。
    let bundled = match shell {
        ShellConfig::Wsl { .. } => None,
        _ => bundled_rg
            .as_ref()
            .and_then(|path| probe_rg(shell, path).map(|caps| (path.clone(), caps))),
    };
    match prefer_newer(system, bundled) {
        Some((program, caps)) => SearchBackend::Rg { program, caps },
        None => SearchBackend::Grep,
    }
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

/// 同梱の rg と、その環境に入っている rg は**同じ腕**にまとめてある（`program` が違うだけ）。
/// 分けていたころは、機能を持たせるたびに 2 つの variant を同じように扱う `match` が増えた。
#[derive(Clone)]
pub(crate) enum SearchBackend {
    Rg { program: String, caps: RgCaps },
    Grep,
}

impl SearchBackend {
    /// rg なら、起動するプログラムとその機能。**呼び出し側はこれ 1 つで分解する。**
    /// 「rg か」と「プログラム名」と「機能」を別々に聞ける形にしていたころは、Grep の腕が
    /// `"rg"` という嘘のプログラム名を返し、`is_rg()` で守られた枝の中で機能を `Option`
    /// として開き直していた（None になり得ないのに）。
    pub(crate) fn as_rg(&self) -> Option<(&str, &RgCaps)> {
        match self {
            SearchBackend::Rg { program, caps } => Some((program, caps)),
            SearchBackend::Grep => None,
        }
    }

    fn label(&self) -> &str {
        match self {
            SearchBackend::Rg { .. } => "rg",
            SearchBackend::Grep => "grep",
        }
    }
}

/// パネルが「どのトグルを出せるか」を決めるための情報（#304）。**機能ごとに真偽値で返す**:
/// フロントに版を配って `major >= 15` を判定させると、同じ知識が 2 箇所に散る。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBackendInfo {
    /// `rg` または `grep`。バッジに出す。
    pub backend: String,
    /// rg のときだけ。バッジのツールチップに出す。
    pub version: Option<String>,
    /// `-P/--pcre2` のトグルを出してよいか。
    pub pcre2: bool,
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
) -> Result<SearchBackendInfo, String> {
    let bundled = state.bundled_rg.clone();
    let cache = state.detected.clone();
    let backend = tokio::task::spawn_blocking(move || resolve_backend(&shell, &bundled, &cache))
        .await
        .map_err(|e| e.to_string())?;

    let caps = backend.as_rg().map(|(_, caps)| caps);
    Ok(SearchBackendInfo {
        backend: backend.label().to_string(),
        version: caps.map(|c| c.version.clone()),
        pcre2: caps.is_some_and(|c| c.pcre2),
    })
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
        let cmd = if let Some((program, _)) = backend.as_rg() {
            shell.command(program, &["--files", "--", &root])
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
    let raw = data
        .get("lines")
        .and_then(|l| l.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
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
        content: raw.trim_end().to_string(),
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

/// 検索の指定（#304）。引数で並べていたころは 7 つあり、トグルを足すたびに
/// `search_execute` / IPC ラッパー / ストア / パネルの 4 箇所で位置を合わせることになった。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    #[serde(default)]
    pub is_regex: bool,
    /// 既定は**区別しない**（`-i`）。VS Code の検索と同じで、`Aa` を押したときだけ区別する。
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// `-P/--pcre2`（先読み・後方参照）。使えるかは `search_detect_backend` が返す。
    #[serde(default)]
    pub use_pcre2: bool,
    #[serde(default)]
    pub glob_include: Option<String>,
    #[serde(default)]
    pub glob_exclude: Option<String>,
}

#[tauri::command]
pub async fn search_execute(
    shell: ShellConfig,
    root: String,
    options: SearchOptions,
    state: State<'_, SearchState>,
) -> Result<SearchResult, String> {
    let SearchOptions {
        query,
        is_regex,
        case_sensitive,
        whole_word,
        use_pcre2,
        glob_include,
        glob_exclude,
    } = options;
    if query.is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
        });
    }

    let bundled = state.bundled_rg.clone();
    let cache = state.detected.clone();

    let inc_glob = glob_include.map(|g| {
        if g.contains('*') || g.contains('?') { g } else if g.contains('.') { format!("*.{}", g.trim_start_matches('.')) } else { format!("*{g}*") }
    });
    let exc_glob = glob_exclude.map(|g| {
        if g.contains('*') || g.contains('?') { g } else { format!("*{g}*") }
    });
    tokio::task::spawn_blocking(move || {
        let backend = resolve_backend(&shell, &bundled, &cache);
        let run = if let Some((program, caps)) = backend.as_rg() {
            let mut args: Vec<String> = vec!["--json".to_string()];
            if !is_regex {
                args.push("-F".to_string());
            }
            if !case_sensitive {
                args.push("-i".to_string());
            }
            if whole_word {
                args.push("-w".to_string());
            }
            // `-P` は正規表現のときだけ意味を持つ（`-F` と併せてもエラーにはならないが、
            // メタ文字を持たない検索に別のエンジンを使わせるだけになる。実測で確認）。
            // 持っていないビルドに渡すと rg が落ちるので、機能を確かめてから足す。
            if is_regex && use_pcre2 && caps.pcre2 {
                args.push("-P".to_string());
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
                shell.command(program, &arg_refs),
                "rg",
                MAX_MATCHES,
                parse_rg_line,
            )
        } else {
            let mut args: Vec<String> = vec!["-rn".to_string()];
            if !is_regex {
                args.push("-F".to_string());
            } else {
                args.push("-E".to_string());
            }
            // 大文字小文字と単語単位は grep にも同じフラグがある。PCRE2 と置換は無い
            // （`-P` は GNU grep 限定で macOS の BSD grep に無く、`-r` は再帰の意味）。
            if !case_sensitive {
                args.push("-i".to_string());
            }
            if whole_word {
                args.push("-w".to_string());
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
            spawn_capped_lines(shell.command("grep", &arg_refs), "grep", MAX_MATCHES, parse_grep_line)
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
            truncated: run.items.len() >= MAX_MATCHES,
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
    fn rg_version_is_parsed() {
        let caps = parse_rg_version("ripgrep 15.2.0 (rev e89fff89ac)\n\nfeatures:+pcre2\n").expect("version");
        assert_eq!(caps.version, "15.2.0");
        assert_eq!(caps.semver, [15, 2, 0]);
        assert!(caps.pcre2);

        let old = parse_rg_version("ripgrep 14.1.1\n\nfeatures:+pcre2,+simd-accel\n").expect("version");
        assert_eq!(old.semver, [14, 1, 1]);

        // 桁が欠けていても major さえ読めればよい（distro の付ける接尾辞で崩れうる）。
        assert_eq!(parse_rg_version("ripgrep 15").expect("version").semver, [15, 0, 0]);
        assert_eq!(parse_rg_version("ripgrep 14.1").expect("version").semver, [14, 1, 0]);

        // pcre2 無しのビルド。`-pcre2` を `+pcre2` と読み違えない。
        let no_pcre = parse_rg_version("ripgrep 15.2.0\n\nfeatures:-pcre2\n").expect("version");
        assert!(!no_pcre.pcre2);

        // rg ではない何か（`which rg` の代わりに存在確認も兼ねているので、ここで弾く）。
        assert!(parse_rg_version("git version 2.51.0").is_none());
        assert!(parse_rg_version("").is_none());
    }

    #[test]
    fn the_newer_rg_wins() {
        let caps = |v: &str| parse_rg_version(&format!("ripgrep {v}\n\nfeatures:+pcre2\n")).expect("version");
        let pick = |a: Option<&str>, b: Option<&str>| {
            prefer_newer(
                a.map(|v| ("rg".to_string(), caps(v))),
                b.map(|v| ("/bundled/rg".to_string(), caps(v))),
            )
            .map(|(program, c)| (program, c.version))
        };

        // 入っているのが古ければ同梱版、新しければそちらを使う。
        assert_eq!(pick(Some("14.1.1"), Some("15.2.0")), Some(("/bundled/rg".into(), "15.2.0".into())));
        assert_eq!(pick(Some("16.0.0"), Some("15.2.0")), Some(("rg".into(), "16.0.0".into())));
        // patch まで見る。
        assert_eq!(pick(Some("15.2.0"), Some("15.2.1")), Some(("/bundled/rg".into(), "15.2.1".into())));
        // 同値なら利用者が入れたほうを残す（同じものなので、名前で迷わせない）。
        assert_eq!(pick(Some("15.2.0"), Some("15.2.0")), Some(("rg".into(), "15.2.0".into())));
        // 片方しか無い場合（WSL は同梱版を渡さないのでこの形になる）。
        assert_eq!(pick(Some("13.0.0"), None), Some(("rg".into(), "13.0.0".into())));
        assert_eq!(pick(None, Some("15.2.0")), Some(("/bundled/rg".into(), "15.2.0".into())));
        assert_eq!(pick(None, None), None);
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
