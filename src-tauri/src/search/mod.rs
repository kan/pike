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

impl RgCaps {
    /// `--json` と `-r` を併せたとき、置換後の文字列を `submatches[].replacement` に
    /// 載せるか（#401）。15 より前の rg は `-r` を `--json` で黙って無視する（ripgrep #1872）
    /// ので、`-o -r` をもう 1 本走らせて突き合わせる（`attach_replacements`）。WSL の distro
    /// に apt で入る rg は 14 系が普通なので、こちらを落とすと WSL では置換が使えない。
    fn json_replacement(&self) -> bool {
        self.semver[0] >= 15
    }
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
    /// 置換（#401）を出してよいか。rg なら版を問わず出す（grep では出さない）。
    pub replace: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub content: String,
    /// 置換を頼んだ検索のときだけ（#401）。この行を置換するとどうなるか。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace: Option<LineReplace>,
}

/// 1 行ぶんの置換（#401）。**置換後の行は rg に作らせる**: `$1` の展開もエスケープも
/// rg の規則で決まるので、フロントで JS の正規表現を使って組み立てると、プレビューと
/// 実際に一致したものがずれる。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineReplace {
    /// プレビュー用。`content` の中の一致の位置（**UTF-16 の位置**。JS の文字列の添字と
    /// 同じ数え方にしてある）と、そこへ入る文字列。
    pub spans: Vec<ReplaceSpan>,
    /// 置換後の行（改行は含まない）。適用（`search_replace_apply`）にそのまま渡す。
    pub line: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSpan {
    pub start: u32,
    pub end: u32,
    pub text: String,
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
        replace: caps.is_some(),
    })
}

const MAX_MATCHES: usize = 500;
/// 結果をタブに書き出すときの上限（#376。`SearchOptions.extract`）。1 行 200 バイトとして
/// 2MB 程度で、エディタのタブが無理なく開ける量に収まる。
const EXTRACT_MAX_MATCHES: usize = 10_000;
/// rg 14 以前の置換（`attach_replacements`）で、`-o -r` の出力を読む上限の倍率。あちらは
/// 1 行に一致の数だけ出るので、`--json` の行数と同じ上限では足りない。
const PLAIN_REPLACE_FACTOR: usize = 8;
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
            // Fallback to find (POSIX). macOS のローカルシェルも find 側。
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
            // Windows のシェルはホストのファイルシステムなので、プロセスを起こさずに歩く
            // （cmd の `dir` は日本語のファイル名を化かす。`fs::list_files_native` の doc）。
            return Ok(crate::fs::list_files_native(&root, MAX_FILES));
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
    /// 一致の位置（`lines.text` の中のバイト位置）。`-r` を渡したときだけ
    /// `replacement` が付く（#401）。
    #[serde(borrow, default)]
    submatches: Vec<RgSubmatch<'a>>,
}

#[derive(Deserialize)]
struct RgSubmatch<'a> {
    start: usize,
    end: usize,
    #[serde(borrow, default)]
    replacement: Option<RgText<'a>>,
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

/// `--json` の 1 行を読んだもの。`deferred` は置換を後から組むとき（rg 14 以前。
/// `attach_replacements`）だけ持つ: rg が返した行そのもの（改行を含む）と一致の位置。
struct RgHit {
    m: SearchMatch,
    deferred: Option<(String, Vec<(usize, usize)>)>,
}

/// rg の `--json` の 1 行。マッチ以外（`begin` / `end` / `summary`）と壊れた行は `None`。
///
/// `defer_replace` は、置換を頼んだが rg が `--json` で置換を返せないとき（14 以前）。
/// そのときは行と位置を残しておき、`-o -r` の出力と突き合わせてから組む。
fn parse_rg_line(line: &str, defer_replace: bool) -> Option<RgHit> {
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
    let subs = &v.data.submatches;
    let (replace, deferred) = if defer_replace {
        let spans = subs.iter().map(|s| (s.start, s.end)).collect();
        (None, Some((content.clone(), spans)))
    } else {
        (
            json_subs(subs).and_then(|s| build_replace(&content, &s)),
            None,
        )
    };
    content.truncate(content.trim_end().len());
    Some(RgHit {
        m: SearchMatch {
            path: RgText::str(v.data.path).into_owned(),
            line: v.data.line_number.unwrap_or(0) as u32,
            content,
            replace,
        },
        deferred,
    })
}

/// 置換 1 か所。`start` / `end` は rg が返した行の中のバイト位置。
struct Sub<'a> {
    start: usize,
    end: usize,
    text: &'a str,
}

/// `--json -r`（rg 15 以降）の `submatches` から置換を取り出す。1 つでも欠ければ `None`。
fn json_subs<'a>(subs: &'a [RgSubmatch<'a>]) -> Option<Vec<Sub<'a>>> {
    // `-r` を渡していない検索（ほとんどの検索）では、何も確保せずに戻る。
    subs.first()?.replacement.as_ref()?;
    subs.iter()
        .map(|s| {
            Some(Sub {
                start: s.start,
                end: s.end,
                text: s.replacement.as_ref()?.text.as_deref()?,
            })
        })
        .collect()
}

/// rg 14 以前の `-o --column -n -H --null -r` の 1 行（`パス\0行:列:置換後`）。
/// **列は置換後の行での位置**（前の置換で後ろがずれる。rg 14.1.0 で実測）。
struct PlainReplacement {
    path: String,
    line: u32,
    column: usize,
    text: String,
}

fn parse_plain_replacement(line: &str) -> Option<PlainReplacement> {
    let (path, rest) = line.split_once('\0')?;
    let mut parts = rest.splitn(3, ':');
    let line_no = parts.next()?.parse().ok()?;
    let column = parts.next()?.parse().ok()?;
    // `--crlf` を付けると出力の改行も CRLF になる。
    let text = parts.next()?;
    let text = text.strip_suffix('\r').unwrap_or(text);
    Some(PlainReplacement {
        path: path.to_owned(),
        line: line_no,
        column,
        text: text.to_owned(),
    })
}

/// `-o -r` の出力を、同じ行の一致へ**出てきた順に**対応付ける（#401、rg 14 以前）。
///
/// 数が合わない行と、列番号の検算（`位置 + それまでのずれ + 1`）が合わない行は置換を
/// 組まない（置換の対象から外れるだけで、検索結果には残る）。2 本の rg は並べて走るので
/// ファイルの順は揃わないが、行の中の順は揃う。
fn attach_replacements(hits: Vec<RgHit>, plain: Vec<PlainReplacement>) -> Vec<SearchMatch> {
    let mut by_line: HashMap<(String, u32), Vec<(usize, String)>> = HashMap::new();
    for p in plain {
        by_line
            .entry((p.path, p.line))
            .or_default()
            .push((p.column, p.text));
    }
    hits.into_iter()
        .map(|RgHit { mut m, deferred }| {
            if let Some((raw, spans)) = deferred {
                m.replace = by_line
                    .get(&(m.path.clone(), m.line))
                    .and_then(|found| deferred_replace(&raw, &spans, found));
            }
            m
        })
        .collect()
}

fn deferred_replace(
    raw: &str,
    spans: &[(usize, usize)],
    found: &[(usize, String)],
) -> Option<LineReplace> {
    if spans.len() != found.len() {
        return None;
    }
    let mut shift: isize = 0;
    let mut subs = Vec::with_capacity(spans.len());
    for (&(start, end), (column, text)) in spans.iter().zip(found) {
        if (start as isize + shift + 1) != *column as isize {
            return None;
        }
        shift += text.len() as isize - (end as isize - start as isize);
        subs.push(Sub { start, end, text });
    }
    build_replace(raw, &subs)
}

/// rg の一致と置換文字列から、1 行ぶんの置換を組み立てる（#401）。`raw` は rg が返した
/// 行そのもの（改行を含む）。
///
/// **組み立てられないときは `None`**（`-r` を渡していない、UTF-8 でない行、位置が文字の
/// 途中を指す）。`None` の行は置換の対象から外れるだけで、検索結果には残る。
fn build_replace(raw: &str, subs: &[Sub]) -> Option<LineReplace> {
    if subs.is_empty() {
        return None;
    }
    let (body, _) = split_eol(raw);
    // プレビューの位置は、表示する `content`（末尾の空白を落としたもの）に収める。
    let shown = body.trim_end().len();
    let utf16 = |s: &str| s.encode_utf16().count() as u32;

    let mut line = String::with_capacity(body.len());
    let mut spans = Vec::with_capacity(subs.len());
    let (mut pos, mut pos16) = (0usize, 0u32);
    for sub in subs {
        let text = sub.text;
        // **本文の長さで切る。** `--crlf` で `.` と `$` は `\r` を越えなくなったが、`\s` や
        // 否定の文字クラスはまだ `\r` に当たる。切らないと行を組めずに黙って置換の対象から
        // 外れる。`\r` は適用のときにファイルの改行として戻る（`apply_line_edits`）。
        let (start, end) = (sub.start.min(body.len()), sub.end.min(body.len()));
        if start < pos || end < start {
            return None;
        }
        line.push_str(body.get(pos..start)?);
        line.push_str(text);
        let start16 = pos16 + utf16(body.get(pos..start.min(shown).max(pos))?);
        let end16 = start16 + utf16(body.get(start.min(shown)..end.min(shown))?);
        spans.push(ReplaceSpan {
            start: start16,
            end: end16,
            text: text.to_owned(),
        });
        pos = end;
        pos16 = end16;
    }
    line.push_str(body.get(pos..)?);
    Some(LineReplace { spans, line })
}

/// 行を本文と改行（`\n` / `\r\n` / 無し）に分ける。プレビュー（`build_replace`）と適用
/// （`apply_line_edits`）が同じ分け方をしないと、見せた行と書く行がずれる。
fn split_eol(raw: &str) -> (&str, &str) {
    let body = raw.strip_suffix('\n').unwrap_or(raw);
    let body = body.strip_suffix('\r').unwrap_or(body);
    (body, &raw[body.len()..])
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
        // grep に置換は無い（`search_detect_backend` が置換を出さない）。
        replace: None,
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
    /// 置換後の文字列（#401）。あれば一致ごとに置換後の行を返す（`SearchMatch.replace`）。
    /// 正規表現のときは `$1` / `${name}` を rg の規則で展開し、そうでなければ字面のまま
    /// 使う。grep では無視する（置換は rg にしか無い）。
    #[serde(default)]
    pub replacement: Option<String>,
}

/// `-r` に渡す文字列。rg は `-F` でも `$` を展開するので、正規表現でない検索では
/// `$$` にして字面のまま入れる（VS Code の置換と同じ扱い）。
fn rg_replacement(text: &str, is_regex: bool) -> String {
    if is_regex {
        text.to_owned()
    } else {
        text.replace('$', "$$")
    }
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
        replacement,
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
            // `--crlf`: CRLF のファイルでも `$` を行末に当て、`.` に `\r` を含めない（#401）。
            // 無いと `foo$` が CRLF の行に 1 件も当たらず、`(bar.*)` の置換はキャプチャに
            // `\r` を持ち込んで行の途中に書き込む。LF のファイルでは何も変わらない。
            let mut args: Vec<String> = vec!["--crlf".to_owned()];
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
            let replace_arg = replacement.map(|text| rg_replacement(&text, is_regex));
            let tail = ["-e".to_owned(), query, "--".to_owned(), root];
            let command = |head: &[&str], replace: bool| {
                let mut all: Vec<&str> = head.to_vec();
                all.extend(args.iter().map(String::as_str));
                if let (true, Some(r)) = (replace, replace_arg.as_deref()) {
                    all.extend(["-r", r]);
                }
                all.extend(tail.iter().map(String::as_str));
                shell.command(program, &all)
            };

            if replace_arg.is_none() || caps.json_replacement() {
                spawn_capped_lines(command(&["--json"], true), "rg", cap, |l| {
                    parse_rg_line(l, false)
                })
                .map(|run| run.map_items(|items| items.into_iter().map(|hit| hit.m).collect()))
            } else {
                // **rg 14 以前は `--json` で置換を返さない**（ripgrep #1872）。置換後の文字列は
                // `-o -r` の素の出力から取り、`--json` の一致の位置と突き合わせる
                // （`attach_replacements`）。置換の組み立てを rg に任せるのは 15 と同じ。
                // 2 本は互いに依存しないので並べて走らせる。素の出力は 1 行に一致の数だけ
                // 出るので、上限を広げておく（足りなかった行は置換の対象から外れるだけ）。
                let json = command(&["--json"], false);
                let plain = command(
                    &[
                        "-o",
                        "--column",
                        "-n",
                        "-H",
                        "--null",
                        "--no-heading",
                        "--color=never",
                    ],
                    true,
                );
                std::thread::scope(|scope| {
                    let plain = scope.spawn(move || {
                        spawn_capped_lines(
                            plain,
                            "rg",
                            cap * PLAIN_REPLACE_FACTOR,
                            parse_plain_replacement,
                        )
                    });
                    let hits = spawn_capped_lines(json, "rg", cap, |l| parse_rg_line(l, true))?;
                    let plain = plain
                        .join()
                        .map_err(|_| "rg: replacement pass panicked".to_owned())??;
                    Ok(hits.map_items(|items| attach_replacements(items, plain.items)))
                })
            }
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

/// 1 行の書き換え（#401）。`from` は検索したときの行（`SearchMatch.content`＝末尾の空白を
/// 落としたもの）、`to` は置換後の行（`LineReplace.line`）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEdit {
    pub line: u32,
    pub from: String,
    pub to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    pub path: String,
    pub lines: Vec<LineEdit>,
}

/// 書けなかったファイルの理由。文言はフロントが i18n で当てる。
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ReplaceFailReason {
    Missing,
    TooLarge,
    /// UTF-8 として読めない。バイトのまま書き戻す手段を持たないので触らない。
    NotUtf8,
    Io,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFailure {
    pub path: String,
    pub reason: ReplaceFailReason,
    pub detail: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    /// 書き換えたファイルの数。
    pub files: u32,
    /// 書き換えた行の数。
    pub lines: u32,
    /// 検索したあとに中身が変わっていて、書き換えなかった行の数。
    pub stale: u32,
    pub failed: Vec<ReplaceFailure>,
}

/// 置換で読むファイルの上限。エディタの既定（10MB）と揃える。
const REPLACE_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// 同時に書き換えるファイルの数。WSL は 1 ファイルにつき `wsl.exe` を 3 本（stat・cat・
/// 書き込み）起こすので、直列だと 100 ファイルで数十秒かかる。
const REPLACE_WORKERS: usize = 4;

/// `text` の行を `edits` のとおりに書き換える。戻り値は（新しい本文、書き換えた行、
/// 中身が変わっていて飛ばした行）。
///
/// **行が検索したときのままのときだけ書き換える**（`from` と比べる）。検索から適用まで
/// のあいだにエージェントや別のエディタが書いていれば、その行は飛ばす。rg の位置
/// （バイトのオフセット）で直に書かないのはこのため。改行（LF / CRLF）と行末の空白は
/// ファイルのものを残す。
fn apply_line_edits(text: &str, edits: &[LineEdit]) -> (String, u32, u32) {
    let by_line: HashMap<u32, &LineEdit> = edits.iter().map(|e| (e.line, e)).collect();
    let mut out = String::with_capacity(text.len());
    let mut applied = 0u32;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        let Some(edit) = by_line.get(&(i as u32 + 1)) else {
            out.push_str(raw);
            continue;
        };
        let (body, terminator) = split_eol(raw);
        // rg は UTF-8 の BOM を落として読むので、1 行目は BOM を外して比べ、書くときに戻す。
        let (bom, cmp) = match body.strip_prefix('\u{feff}') {
            Some(rest) if i == 0 => ("\u{feff}", rest),
            _ => ("", body),
        };
        if cmp.trim_end() == edit.from {
            out.push_str(bom);
            out.push_str(&edit.to);
            out.push_str(terminator);
            applied += 1;
        } else {
            out.push_str(raw);
        }
    }
    // 書き換えなかった行は全部「変わっていた」に数える（ファイルが縮んでいて届かなかった
    // 行も含む）。
    (out, applied, by_line.len() as u32 - applied)
}

fn replace_in_file(shell: &ShellConfig, edit: &FileEdit) -> Result<(u32, u32), ReplaceFailure> {
    let fail = |reason, detail: Option<String>| ReplaceFailure {
        path: edit.path.clone(),
        reason,
        detail,
    };
    let bytes = match crate::fs::read_raw_bytes(shell, &edit.path, REPLACE_MAX_BYTES) {
        Ok(crate::fs::RawRead::Bytes(b)) => b,
        Ok(crate::fs::RawRead::Missing) => return Err(fail(ReplaceFailReason::Missing, None)),
        Ok(crate::fs::RawRead::TooLarge(_)) => return Err(fail(ReplaceFailReason::TooLarge, None)),
        Err(e) => return Err(fail(ReplaceFailReason::Io, Some(e))),
    };
    let text = String::from_utf8(bytes).map_err(|_| fail(ReplaceFailReason::NotUtf8, None))?;
    let (new_text, applied, stale) = apply_line_edits(&text, &edit.lines);
    if applied > 0 {
        crate::fs::write_bytes_atomic(shell, &edit.path, new_text.as_bytes())
            .map_err(|e| fail(ReplaceFailReason::Io, Some(e)))?;
    }
    Ok((applied, stale))
}

/// 検索結果の置換を書き込む（#401）。行の組み立ては検索のとき（rg の `-r`）に済んでいて、
/// ここは「行がまだ検索したときのままか」を確かめて差し替えるだけ。
///
/// **エディタで未保存のファイルは渡さないこと**（フロントが除く）。ここで書くと、エディタ
/// には外部変更の警告が出て、そのまま保存すれば置換が消える。
#[tauri::command]
pub async fn search_replace_apply(
    shell: ShellConfig,
    edits: Vec<FileEdit>,
) -> Result<ReplaceOutcome, String> {
    tokio::task::spawn_blocking(move || {
        let next = std::sync::atomic::AtomicUsize::new(0);
        let results = Mutex::new(Vec::with_capacity(edits.len()));
        std::thread::scope(|scope| {
            for _ in 0..REPLACE_WORKERS.min(edits.len()) {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(edit) = edits.get(i) else { break };
                    let r = replace_in_file(&shell, edit);
                    if let Ok(mut all) = results.lock() {
                        all.push(r);
                    }
                });
            }
        });
        let mut outcome = ReplaceOutcome::default();
        for r in results.into_inner().map_err(|e| e.to_string())? {
            match r {
                Ok((applied, stale)) => {
                    outcome.files += u32::from(applied > 0);
                    outcome.lines += applied;
                    outcome.stale += stale;
                }
                Err(f) => outcome.failed.push(f),
            }
        }
        Ok(outcome)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 置換を後回しにしない読み方（ほとんどのテストはこれで足りる）。
    fn parse_rg_line(line: &str) -> Option<SearchMatch> {
        super::parse_rg_line(line, false).map(|hit| hit.m)
    }

    /// rg 14 の `-o -r` と `--json` を突き合わせる（#401。rg 14.1.0 の実際の出力。
    /// 列番号は置換後の行での位置なので、2 つ目の一致は 9 ではなく 11 になる）。
    #[test]
    fn rg14_replacements_are_matched_by_order_and_column() {
        let json = r#"{"type":"match","data":{"path":{"text":"/t/a.txt"},"lines":{"text":"foo bar foo\r\n"},"line_number":1,"submatches":[{"match":{"text":"foo"},"start":0,"end":3},{"match":{"text":"foo"},"start":8,"end":11}]}}"#;
        let hit = super::parse_rg_line(json, true).expect("match line");
        let plain = ["/t/a.txt\u{0}1:1:[foo]\r", "/t/a.txt\u{0}1:11:[foo]\r"]
            .iter()
            .map(|l| parse_plain_replacement(l).expect("plain line"))
            .collect();
        let m = attach_replacements(vec![hit], plain).remove(0);
        let r = m.replace.expect("replace");
        assert_eq!(r.line, "[foo] bar [foo]");
        assert_eq!((r.spans[1].start, r.spans[1].end), (8, 11));
    }

    /// 数か列番号が合わない行は置換を組まない（対象から外すだけで、結果には残す）。
    #[test]
    fn rg14_mismatched_replacements_are_dropped() {
        let json = r#"{"type":"match","data":{"path":{"text":"a"},"lines":{"text":"foo foo\n"},"line_number":1,"submatches":[{"match":{"text":"foo"},"start":0,"end":3},{"match":{"text":"foo"},"start":4,"end":7}]}}"#;
        let one = |col: &str| {
            let hit = super::parse_rg_line(json, true).expect("match line");
            let plain = ["a\u{0}1:1:X".to_owned(), format!("a\u{0}1:{col}:X")]
                .iter()
                .map(|l| parse_plain_replacement(l).expect("plain line"))
                .collect();
            attach_replacements(vec![hit], plain).remove(0)
        };
        // 1 つ目で 2 バイト縮むので、2 つ目は 5 - 2 = 3。
        assert_eq!(one("3").replace.expect("replace").line, "X X");
        assert!(one("5").replace.is_none());
        assert_eq!(one("5").content, "foo foo");
    }

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

    /// `-r` を渡したときの行（#401。同梱の 15.2.0 の実際の出力の形）。位置は UTF-16 で返す。
    #[test]
    fn rg_replacement_builds_the_new_line() {
        let line = r#"{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"あいう foo foo  \r\n"},"line_number":2,"submatches":[{"match":{"text":"foo"},"replacement":{"text":"Xfoo"},"start":10,"end":13},{"match":{"text":"foo"},"replacement":{"text":"Xfoo"},"start":14,"end":17}]}}"#;
        let m = parse_rg_line(line).expect("match line");
        assert_eq!(m.content, "あいう foo foo");
        let r = m.replace.expect("replace");
        // 改行は落とし、行末の空白は残す（適用のときにファイルの改行を足す）。
        assert_eq!(r.line, "あいう Xfoo Xfoo  ");
        assert_eq!(
            r.spans,
            vec![
                ReplaceSpan {
                    start: 4,
                    end: 7,
                    text: "Xfoo".into()
                },
                ReplaceSpan {
                    start: 8,
                    end: 11,
                    text: "Xfoo".into()
                },
            ]
        );
    }

    /// `-r` を渡していない検索では、一致の位置があっても置換は組まない。
    #[test]
    fn rg_without_replacement_has_no_replace() {
        let line = r#"{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"foo\n"},"line_number":1,"submatches":[{"match":{"text":"foo"},"start":0,"end":3}]}}"#;
        assert!(parse_rg_line(line).expect("match line").replace.is_none());
    }

    /// 行末の空白の中の一致は、表示する本文の外なので長さ 0 の位置に畳む。
    #[test]
    fn replacement_spans_are_clamped_to_the_shown_content() {
        let subs = [Sub {
            start: 1,
            end: 3,
            text: "",
        }];
        let r = build_replace("a  \n", &subs).expect("replace");
        assert_eq!(r.line, "a");
        assert_eq!(r.spans[0].start, 1);
        assert_eq!(r.spans[0].end, 1);
    }

    /// CRLF の行で一致が `\r` まで伸びても置換を組む（`-e 'bar.*'` の実際の位置）。
    #[test]
    fn replacement_reaching_into_cr_is_clamped() {
        let subs = [Sub {
            start: 4,
            end: 12,
            text: "Z",
        }];
        let r = build_replace("foo bar foo\r\n", &subs).expect("replace");
        assert_eq!(r.line, "foo Z");
        assert_eq!((r.spans[0].start, r.spans[0].end), (4, 11));
    }

    #[test]
    fn literal_replacement_escapes_dollars() {
        assert_eq!(rg_replacement("$1 $x", false), "$$1 $$x");
        assert_eq!(rg_replacement("$1", true), "$1");
    }

    fn edit(line: u32, from: &str, to: &str) -> LineEdit {
        LineEdit {
            line,
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn line_edits_keep_line_endings() {
        // `from` は末尾の空白を落とした本文で比べ、`to`（rg が組んだ行）はそのまま書く。
        let text = "one\r\ntwo  \r\nthree";
        let (out, applied, stale) =
            apply_line_edits(text, &[edit(2, "two", "TWO  "), edit(3, "three", "3")]);
        assert_eq!(out, "one\r\nTWO  \r\n3");
        assert_eq!((applied, stale), (2, 0));
    }

    /// 検索のあとに変わった行と、ファイルが縮んで無くなった行は書かない。
    #[test]
    fn line_edits_skip_changed_lines() {
        let text = "a\nb\n";
        let (out, applied, stale) = apply_line_edits(
            text,
            &[edit(1, "x", "y"), edit(2, "b", "B"), edit(9, "z", "Z")],
        );
        assert_eq!(out, "a\nB\n");
        assert_eq!((applied, stale), (1, 2));
    }

    #[test]
    fn line_edits_keep_the_bom() {
        let (out, applied, _) = apply_line_edits("\u{feff}foo\n", &[edit(1, "foo", "bar")]);
        assert_eq!(out, "\u{feff}bar\n");
        assert_eq!(applied, 1);
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
