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
    let version = first
        .strip_prefix("ripgrep ")?
        .split_whitespace()
        .next()?
        .to_owned();
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
/// **非 WSL では 2 本叩く**（PATH のものと同梱のサイドカー）。`install_key(shell)` 単位で
/// キャッシュされ、起動時ではなく初回利用（検索、Ctrl+P のファイル一覧、タスク検出）まで
/// 遅れるが、**直列に待つ理由が無いので並べて走らせる**（#356）。答えは互いに依存せず、
/// 決めるのは `prefer_newer` の比較 1 回だけなので、待ちは和ではなく大きいほうになる
/// （最悪値も 60 秒から 30 秒へ）。実測で 1 本あたり 55〜60ms（Windows・ウォーム）で、
/// **macOS では初回の exec がさらに重い**（新しく入れたバイナリは Gatekeeper の評価を
/// 通るため）。**それを最初に踏むのが検索とは限らない**: Ctrl+P のファイル一覧も同じ検出を
/// 起こすので、先に押した側が払う。
///
/// **スコープのスレッドへ出すのは同梱のぶんだけ**（WSL では相手が居ないので 1 本も足さない）。
/// **「スレッドを使わない」という意味ではない**: `probe_rg` は `ShellConfig::run` 越しなので、
/// `wait_with_timeout` の見張りが 1 本につき 1 つ立つ。
fn detect_backend(shell: &ShellConfig, bundled_rg: &Option<String>) -> SearchBackend {
    // 同梱の rg はホストのバイナリなので、WSL の中では実行できない。
    let bundled_path = match shell {
        ShellConfig::Wsl { .. } => None,
        _ => bundled_rg.as_deref(),
    };
    let (system, bundled) = std::thread::scope(|scope| {
        let bundled = bundled_path.map(|path| {
            scope.spawn(move || probe_rg(shell, path).map(|caps| (path.to_owned(), caps)))
        });
        // macOS / Linux では `augment_process_path` が起動時に PATH を広げているので、
        // Homebrew 等に入った rg もここで見つかる。
        let system = probe_rg(shell, "rg").map(|caps| ("rg".to_owned(), caps));
        // panic したら「見つからなかった」に落とす。**明示的に join したハンドルの panic は
        // scope が拾い直さない**（実測で確認）ので、ここで握り潰せる。検出の失敗は grep へ
        // 落ちるという答えそのものなので、呼び出し側に返す口は要らない。
        (system, bundled.and_then(|h| h.join().ok().flatten()))
    });
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
        backend: backend.label().to_owned(),
        version: caps.map(|c| c.version.clone()),
        pcre2: caps.is_some_and(|c| c.pcre2),
    })
}

const MAX_MATCHES: usize = 500;
/// 結果をタブに書き出すときの上限（#376。`SearchOptions.extract`）。1 行 200 バイトとして
/// 2MB 程度で、エディタのタブが無理なく開ける量に収まる。
const EXTRACT_MAX_MATCHES: usize = 10_000;
/// パネルの検索での、ファイルごとの一致の上限（1 ファイルが結果を占めないため）。
const PER_FILE_MATCHES: &str = "20";
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
                &[
                    &root,
                    "-type",
                    "f",
                    "-not",
                    "-path",
                    "*/.git/*",
                    "-not",
                    "-path",
                    "*/node_modules/*",
                    "-not",
                    "-path",
                    "*/target/*",
                ],
            )
        } else {
            shell.command("cmd.exe", &["/C", &format!("dir /S /B /A:-D \"{root}\"")])
        };

        // 検索と同じく上限で打ち切る（#257）。大きなリポジトリでは `--files` の出力も
        // 数 MB になり、`MAX_FILES` を超えた分は作らせるだけ無駄になる。
        let run = spawn_capped_lines(cmd, "file list", MAX_FILES, |line| {
            (!line.is_empty()).then(|| line.to_owned())
        })?;
        Ok(run.items)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// rg の `--json` の 1 行から拾う形（#382）。
///
/// **`serde_json::Value` の木を組まない。** あれはマッチ 1 件につき Map と `String` を
/// 15〜25 本作り、使うのは 2 本だけ。パネルは 500 件で止まるが、**書き出し（#376）は
/// `EXTRACT_MAX_MATCHES` = 10,000 件**なので 20 万本規模になる。要る欄だけを宣言すれば、
/// 残りは値を組まずに読み飛ばされる。
///
/// **`&str` ではなく `Cow` で受ける。** serde_json が借用できるのはエスケープを含まない
/// 文字列だけで、ソースの行には `\"` も `\\` も普通に入る。`&str` にすると、そういう行が
/// まるごと「壊れた行」になって検索結果から消える。`Cow` なら、エスケープのある行だけ
/// その場で組み立てる。
#[derive(Deserialize)]
struct RgLine<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(borrow)]
    data: RgData<'a>,
}

#[derive(Deserialize)]
struct RgData<'a> {
    #[serde(borrow, default)]
    path: Option<RgText<'a>>,
    #[serde(borrow, default)]
    lines: Option<RgText<'a>>,
    /// **`Option` で受ける。** rg は行番号が無いとき、キーを省くのではなく
    /// `"line_number":null` を出す（同梱の 15.2.0 で実測）。`#[serde(default)]` が効くのは
    /// キーが「無い」ときだけなので、`u64` のままだと `null` で行ごとパースに失敗し、
    /// **すべてのマッチが黙って捨てられて検索結果が 0 件になる**。
    ///
    /// Pike は `-N` を渡さないが、rg は `RIPGREP_CONFIG_PATH` の設定ファイルを自分で読み、
    /// 子プロセスはその環境変数を継ぐ。設定に `--no-line-number` を書いている利用者で起きる。
    #[serde(default)]
    line_number: Option<u64>,
}

/// rg は UTF-8 でない中身を `{"bytes": "<base64>"}` で返すので、`text` は欠けうる。
#[derive(Deserialize)]
struct RgText<'a> {
    #[serde(borrow, default)]
    text: Option<std::borrow::Cow<'a, str>>,
}

impl<'a> RgText<'a> {
    /// 欄ごと無い（`path` / `lines` が来ない）のと、中の `text` が無い（`bytes` で
    /// 返った）のを、同じ「空」に畳む。呼ぶ側がどちらも区別しないので 2 段で持たない。
    fn str(field: Option<Self>) -> std::borrow::Cow<'a, str> {
        field.and_then(|t| t.text).unwrap_or_default()
    }
}

/// rg の `--json` の 1 行。マッチ以外（`begin` / `end` / `summary`）と壊れた行は `None`。
fn parse_rg_line(line: &str) -> Option<SearchMatch> {
    // 捨てる行に DOM を組まない。rg はマッチするファイルごとに `begin` と `end` を出すので、
    // 500 件が 200 ファイルに散っていれば 400 行が作った端から捨てられる。文字列を含むかの
    // 判定だけ先にやる（本文に "match" を含む行は素通りして、下の本パースが弾く）。
    if !line.contains("\"match\"") {
        return None;
    }
    let v = serde_json::from_str::<RgLine>(line).ok()?;
    if v.kind != "match" {
        return None;
    }
    // 末尾を切るのは `into_owned()` の**あと**。先に `trim_end().to_owned()` と書くと、
    // エスケープを含む行では serde が作った `Cow::Owned` の隣にもう 1 本作ることになる。
    let mut content = RgText::str(v.data.lines).into_owned();
    content.truncate(content.trim_end().len());
    Some(SearchMatch {
        path: RgText::str(v.data.path).into_owned(),
        line: v.data.line_number.unwrap_or(0) as u32,
        content,
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
        path: path.to_owned(),
        line: line_num,
        content: content.to_owned(),
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
    /// 結果をタブに書き出すための検索（#376）。パネルの上限（全体 `MAX_MATCHES`・ファイル
    /// ごと 20 件）を外し、`EXTRACT_MAX_MATCHES` まで取る。パネルに出すのは目で追える量に
    /// 絞るのが目的で、書き出しは grep の代わりなので、1 ファイルの全一致が要る。
    #[serde(default)]
    pub extract: bool,
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
        extract,
    } = options;
    let cap = if extract {
        EXTRACT_MAX_MATCHES
    } else {
        MAX_MATCHES
    };
    if query.is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
        });
    }

    let bundled = state.bundled_rg.clone();
    let cache = state.detected.clone();

    let inc_glob = glob_include.map(|g| {
        if g.contains('*') || g.contains('?') {
            g
        } else if g.contains('.') {
            format!("*.{}", g.trim_start_matches('.'))
        } else {
            format!("*{g}*")
        }
    });
    let exc_glob = glob_exclude.map(|g| {
        if g.contains('*') || g.contains('?') {
            g
        } else {
            format!("*{g}*")
        }
    });
    tokio::task::spawn_blocking(move || {
        let backend = resolve_backend(&shell, &bundled, &cache);
        let run = if let Some((program, caps)) = backend.as_rg() {
            let mut args: Vec<String> = vec!["--json".to_owned()];
            if !is_regex {
                args.push("-F".to_owned());
            }
            if !case_sensitive {
                args.push("-i".to_owned());
            }
            if whole_word {
                args.push("-w".to_owned());
            }
            // `-P` は正規表現のときだけ意味を持つ（`-F` と併せてもエラーにはならないが、
            // メタ文字を持たない検索に別のエンジンを使わせるだけになる。実測で確認）。
            // 持っていないビルドに渡すと rg が落ちるので、機能を確かめてから足す。
            if is_regex && use_pcre2 && caps.pcre2 {
                args.push("-P".to_owned());
            }
            if let Some(ref inc) = inc_glob {
                args.push("--glob".to_owned());
                args.push(inc.clone());
            }
            if let Some(ref exc) = exc_glob {
                args.push("--glob".to_owned());
                args.push(format!("!{exc}"));
            }
            if !extract {
                args.push("--max-count".to_owned());
                args.push(PER_FILE_MATCHES.to_owned());
            }
            args.push("-e".to_owned());
            args.push(query);
            args.push("--".to_owned());
            args.push(root);

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            spawn_capped_lines(shell.command(program, &arg_refs), "rg", cap, parse_rg_line)
        } else {
            let mut args: Vec<String> = vec!["-rn".to_owned()];
            if !is_regex {
                args.push("-F".to_owned());
            } else {
                args.push("-E".to_owned());
            }
            // 大文字小文字と単語単位は grep にも同じフラグがある。PCRE2 と置換は無い
            // （`-P` は GNU grep 限定で macOS の BSD grep に無く、`-r` は再帰の意味）。
            if !case_sensitive {
                args.push("-i".to_owned());
            }
            if whole_word {
                args.push("-w".to_owned());
            }
            if let Some(ref inc) = inc_glob {
                args.push(format!("--include={inc}"));
            }
            if !extract {
                args.push("-m".to_owned());
                args.push(PER_FILE_MATCHES.to_owned());
            }
            args.push("--exclude-dir=.git".to_owned());
            args.push("--exclude-dir=node_modules".to_owned());
            args.push("--exclude-dir=target".to_owned());
            if let Some(ref exc) = exc_glob {
                args.push(format!("--exclude={exc}"));
                args.push(format!("--exclude-dir={exc}"));
            }
            args.push("-e".to_owned());
            args.push(query);
            args.push("--".to_owned());
            args.push(root);

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            spawn_capped_lines(
                shell.command("grep", &arg_refs),
                "grep",
                cap,
                parse_grep_line,
            )
        };

        let run = run?;
        if run.code == 2 {
            if !is_regex {
                // literal (-F) mode should never cause regex parse errors;
                // treat as "no results" rather than propagating a confusing error
                return Ok(SearchResult {
                    matches: vec![],
                    truncated: false,
                });
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

    /// **エスケープを含む本文が消えないこと**（#382）。ソースの行には `\"` も `\\` も
    /// 普通に入る。借用しか受けない形（`&str`）にすると、そういう行がまるごと
    /// 「壊れた行」になって検索結果から落ちる。
    #[test]
    fn rg_keeps_lines_that_contain_escapes() {
        let line = r#"{"type":"match","data":{"path":{"text":"a\\b.rs"},"lines":{"text":"let s = \"x\\ny\";"},"line_number":3}}"#;
        let m = parse_rg_line(line).expect("match line");
        assert_eq!(m.path, r"a\b.rs");
        assert_eq!(m.content, "let s = \"x\\ny\";");
        assert_eq!(m.line, 3);
    }

    /// **行番号が `null` でもマッチを落とさない**（#382）。rg は `--no-line-number` の
    /// とき、キーを省くのではなく `"line_number":null` を出す。`u64` で受けると行ごと
    /// パースに失敗し、検索結果が丸ごと 0 件になる。
    #[test]
    fn rg_match_with_null_line_number_is_kept() {
        let line = r#"{"type":"match","data":{"path":{"text":"a.rs"},"lines":{"text":"x"},"line_number":null}}"#;
        let m = parse_rg_line(line).expect("match line");
        assert_eq!(m.path, "a.rs");
        assert_eq!(m.line, 0);
    }

    /// UTF-8 でない中身を rg は `{"bytes": …}` で返す（`text` が無い）。落とさず空で通す。
    #[test]
    fn rg_match_without_text_is_empty() {
        let line = r#"{"type":"match","data":{"path":{"bytes":"eA=="},"lines":{"bytes":"eA=="},"line_number":1}}"#;
        let m = parse_rg_line(line).expect("match line");
        assert_eq!(m.path, "");
        assert_eq!(m.content, "");
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
        let caps = parse_rg_version("ripgrep 15.2.0 (rev e89fff89ac)\n\nfeatures:+pcre2\n")
            .expect("version");
        assert_eq!(caps.version, "15.2.0");
        assert_eq!(caps.semver, [15, 2, 0]);
        assert!(caps.pcre2);

        let old =
            parse_rg_version("ripgrep 14.1.1\n\nfeatures:+pcre2,+simd-accel\n").expect("version");
        assert_eq!(old.semver, [14, 1, 1]);

        // 桁が欠けていても major さえ読めればよい（distro の付ける接尾辞で崩れうる）。
        assert_eq!(
            parse_rg_version("ripgrep 15").expect("version").semver,
            [15, 0, 0]
        );
        assert_eq!(
            parse_rg_version("ripgrep 14.1").expect("version").semver,
            [14, 1, 0]
        );

        // pcre2 無しのビルド。`-pcre2` を `+pcre2` と読み違えない。
        let no_pcre = parse_rg_version("ripgrep 15.2.0\n\nfeatures:-pcre2\n").expect("version");
        assert!(!no_pcre.pcre2);

        // rg ではない何か（`which rg` の代わりに存在確認も兼ねているので、ここで弾く）。
        assert!(parse_rg_version("git version 2.51.0").is_none());
        assert!(parse_rg_version("").is_none());
    }

    #[test]
    fn the_newer_rg_wins() {
        let caps = |v: &str| {
            parse_rg_version(&format!("ripgrep {v}\n\nfeatures:+pcre2\n")).expect("version")
        };
        let pick = |a: Option<&str>, b: Option<&str>| {
            prefer_newer(
                a.map(|v| ("rg".to_owned(), caps(v))),
                b.map(|v| ("/bundled/rg".to_owned(), caps(v))),
            )
            .map(|(program, c)| (program, c.version))
        };

        // 入っているのが古ければ同梱版、新しければそちらを使う。
        assert_eq!(
            pick(Some("14.1.1"), Some("15.2.0")),
            Some(("/bundled/rg".into(), "15.2.0".into()))
        );
        assert_eq!(
            pick(Some("16.0.0"), Some("15.2.0")),
            Some(("rg".into(), "16.0.0".into()))
        );
        // patch まで見る。
        assert_eq!(
            pick(Some("15.2.0"), Some("15.2.1")),
            Some(("/bundled/rg".into(), "15.2.1".into()))
        );
        // 同値なら利用者が入れたほうを残す（同じものなので、名前で迷わせない）。
        assert_eq!(
            pick(Some("15.2.0"), Some("15.2.0")),
            Some(("rg".into(), "15.2.0".into()))
        );
        // 片方しか無い場合（WSL は同梱版を渡さないのでこの形になる）。
        assert_eq!(
            pick(Some("13.0.0"), None),
            Some(("rg".into(), "13.0.0".into()))
        );
        assert_eq!(
            pick(None, Some("15.2.0")),
            Some(("/bundled/rg".into(), "15.2.0".into()))
        );
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
