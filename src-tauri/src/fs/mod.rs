use crate::types::{bash_quote, git_args, wait_with_timeout, ShellConfig};
use base64::Engine as _;
use encoding_rs::Encoding;
use serde::Serialize;
use std::io::Write as IoWrite;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    /// Directory in `IGNORED_DIRS`: shown dimmed with a gear icon. The watcher,
    /// task discovery and search all skip it; the tree can still list it on
    /// demand when the user expands the row (#303).
    pub ignored: bool,
    /// Matched by `.gitignore` (file or directory). Colored distinctly in the tree.
    pub gitignored: bool,
}

pub const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "__pycache__",
    ".next",
    ".nuxt",
    "target",
    "dist",
    "build",
    ".cache",
    ".venv",
    "venv",
];

/// Last path segment, for paths in either separator style.
pub fn file_name_of(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Everything before the last separator; empty for a bare file name.
pub fn parent_dir_of(path: &str) -> &str {
    path.rsplit_once(['/', '\\'])
        .map(|(dir, _)| dir)
        .unwrap_or("")
}

/// `path` relative to `root`, always with `/` separators so the frontend can
/// display and split it the same way on both platforms. (`diagnostics::rel_path`
/// is the sibling that keeps the native separator, because its output is fed
/// back to tools rather than shown.)
pub fn rel_path_of(path: &str, root: &str) -> String {
    let rel = path
        .strip_prefix(root)
        .map(|r| r.trim_start_matches(['/', '\\']))
        .unwrap_or(path);
    if rel.contains('\\') {
        rel.replace('\\', "/")
    } else {
        rel.to_owned()
    }
}

/// Read multiple files, missing or unreadable ones coming back as `None`. For
/// WSL, batches every read into a single wsl.exe invocation — the round trip
/// dominates, so reading files one at a time costs ~200ms each. Relative paths
/// are taken against `root`.
pub fn batch_read_files(
    shell: &ShellConfig,
    root: &str,
    sep: &str,
    paths: &[String],
) -> Vec<Option<String>> {
    if paths.is_empty() {
        return vec![];
    }
    let full_path = |p: &String| {
        if p.starts_with('/') || p.contains(':') {
            p.clone()
        } else {
            format!("{root}{sep}{p}")
        }
    };
    match shell {
        ShellConfig::Wsl { .. } => {
            // One bash script that cats every file, separated by record separator.
            let rs = "\x1e"; // ASCII record separator
            let parts: Vec<String> = paths
                .iter()
                .map(|p| {
                    format!(
                        "cat '{}' 2>/dev/null || echo",
                        full_path(p).replace('\'', "'\\''")
                    )
                })
                .collect();
            let script = parts.join(&format!("; printf '{rs}'; "));
            match shell.run_stdout("bash", &["-c", &script]) {
                Ok(output) => output
                    .split(rs)
                    .map(|s| {
                        let trimmed = s.trim();
                        (!trimmed.is_empty()).then(|| trimmed.to_owned())
                    })
                    .collect(),
                Err(_) => paths.iter().map(|_| None).collect(),
            }
        }
        _ => paths
            .iter()
            .map(|p| std::fs::read_to_string(full_path(p)).ok())
            .collect(),
    }
}

/// Recursively find files whose name matches any of `names` (case-insensitive),
/// up to `max_depth` levels, skipping `IGNORED_DIRS`. Returns absolute paths in
/// the shell's native form. Shared by task discovery and diagnostics.
///
/// WSL uses a single `find` invocation; native uses `walkdir`-style recursion.
/// Note: this does not consult `.gitignore` (callers that want that use `rg`
/// first and fall back to this).
pub fn walk_files_by_name(
    shell: &ShellConfig,
    root: &str,
    names: &[&str],
    max_depth: u32,
) -> Vec<String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            let prune: String = IGNORED_DIRS
                .iter()
                .map(|d| format!("-name '{d}'"))
                .collect::<Vec<_>>()
                .join(" -o ");
            let name_expr: String = names
                .iter()
                .map(|n| format!("-name '{n}'"))
                .collect::<Vec<_>>()
                .join(" -o ");
            let script = format!(
                "find '{}' -maxdepth {max_depth} \\( {prune} \\) -prune -o \\( {name_expr} \\) -print",
                root.replace('\'', "'\\''"),
            );
            shell
                .run_stdout("bash", &["-c", &script])
                .ok()
                .map(|s| s.lines().map(|l| l.to_owned()).collect())
                .unwrap_or_default()
        }
        _ => {
            let mut results = Vec::new();
            // 探す名前（`package.json` / `Makefile` / `Cargo.toml` …）はすべて ASCII なので、
            // 大小の畳み方を ASCII に閉じてよい。非 ASCII のファイル名は、どちらの畳み方でも
            // これらと一致しない。**小文字に揃えて渡す必要は無い**（#382）。
            let accept = |name: &str| names.iter().any(|n| n.eq_ignore_ascii_case(name));
            walk_native(
                std::path::Path::new(root),
                &Walk {
                    max_depth,
                    cap: usize::MAX,
                    accept: &accept,
                },
                0,
                &mut results,
            );
            results
        }
    }
}

/// ホスト上のファイルを `cap` 件まで並べる（`IGNORED_DIRS` は飛ばす）。rg が無いときの
/// Ctrl+P のファイル一覧（`search::list_project_files`）が使う。
///
/// **cmd の `dir /S /B` に戻さないこと**（日本語のファイル名が化ける。理由は
/// `.claude/rules/platform.md` の「ダイアログ」）。
pub fn list_files_native(root: &str, cap: usize) -> Vec<String> {
    let mut results = Vec::new();
    walk_native(
        std::path::Path::new(root),
        &Walk {
            max_depth: u32::MAX,
            cap,
            accept: &|_| true,
        },
        0,
        &mut results,
    );
    results
}

/// `walk_native` の条件。
struct Walk<'a> {
    max_depth: u32,
    /// ここまで集めたら止める。
    cap: usize,
    /// ファイル名で拾うか決める。
    accept: &'a dyn Fn(&str) -> bool,
}

/// ホスト上を再帰でたどり、`accept` が通したファイルを集める（`IGNORED_DIRS` は飛ばす）。
fn walk_native(dir: &std::path::Path, walk: &Walk, depth: u32, results: &mut Vec<String>) {
    if depth >= walk.max_depth || results.len() >= walk.cap {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // **名前で `String` を作らない**（#382）。`to_string_lossy()` は正常な UTF-8 なら
        // `Cow::Borrowed` を返すので、`.to_string()` を付けた時点で写しが 1 本増える。
        // ここはタスク検出と compose 探索が深さ 5 まで歩く経路で、実リポジトリでは
        // 5,000〜50,000 エントリになる。
        // （`file_name()` が返す `OsString` だけは `DirEntry` の仕様で避けられない。）
        let raw = entry.file_name();
        let name = raw.to_string_lossy();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if !IGNORED_DIRS.contains(&name.as_ref()) {
                walk_native(&entry.path(), walk, depth + 1, results);
            }
        } else if (walk.accept)(&name)
            // ディレクトリを指す symlink / ジャンクションは飛ばす（`file_type` はリンクを
            // 辿らないので、そのままだとファイルとして拾う）。**辿りはしない**: 循環しうる。
            && !(kind.is_symlink() && std::fs::metadata(entry.path()).is_ok_and(|m| m.is_dir()))
        {
            if let Ok(p) = entry.path().into_os_string().into_string() {
                results.push(p);
            }
        }
        if results.len() >= walk.cap {
            return;
        }
    }
}

#[tauri::command]
pub async fn fs_list_dir(
    shell: ShellConfig,
    path: String,
    check_gitignore: bool,
) -> Result<Vec<FsEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let mut entries = match &shell {
            ShellConfig::Wsl { .. } => list_dir_wsl(&shell, &path)?,
            _ => list_dir_native(&path)?,
        };
        // Only consult git when the caller knows this tree is a git repo (avoids a
        // wasted git spawn per listing in non-git projects). The tree also passes
        // `false` inside `IGNORED_DIRS` (#303) — it knows the project root, so it
        // can tell `<root>/node_modules` from a project that merely lives under a
        // directory of that name.
        if check_gitignore {
            apply_gitignore(&shell, &path, &mut entries);
        }
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mark entries that git ignores (color only) — the tree just colors them
/// differently, nothing here affects whether a row can be expanded. Uses a
/// single `git check-ignore` for the whole listing.
fn apply_gitignore(shell: &ShellConfig, dir: &str, entries: &mut [FsEntry]) {
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    let ignored = check_ignored(shell, dir, &names);
    if ignored.is_empty() {
        return;
    }
    for e in entries.iter_mut() {
        if ignored.contains(e.name.as_str()) {
            e.gitignored = true;
        }
    }
}

/// Return the subset of `names` (entries directly under `dir`) that git ignores,
/// via `git check-ignore`. Empty on non-repo / git-unavailable / none-ignored
/// (git exits non-zero with empty stdout in those cases).
fn check_ignored(
    shell: &ShellConfig,
    dir: &str,
    names: &[&str],
) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    if names.is_empty() {
        return HashSet::new();
    }
    // `git_args` supplies `-C <dir>` and the quoting flag (non-ASCII names must
    // come back verbatim or the match below misses); `--` guards flag-like names. Output is one ignored name per line. (`-z` is rejected
    // without `--stdin`, so we split on newlines instead.)
    let mut args: Vec<&str> = git_args(dir, &["check-ignore", "--"]);
    args.extend_from_slice(names);
    match shell.run("git", &args) {
        Ok((_code, stdout, _stderr)) => stdout
            .lines()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_owned())
            .collect(),
        Err(_) => HashSet::new(),
    }
}

fn list_dir_wsl(shell: &ShellConfig, path: &str) -> Result<Vec<FsEntry>, String> {
    let script = format!(
        "find '{}' -maxdepth 1 -mindepth 1 -printf '%y\\t%f\\n' 2>/dev/null | sort -t'\t' -k2",
        path.replace('\'', "'\\''")
    );
    let (_, stdout, _) = shell.run("bash", &["-c", &script])?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, '\t');
        let kind = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").to_owned();
        if name.is_empty() || name.starts_with(".DS_Store") {
            continue;
        }
        let is_dir = kind == "d";
        let ignored = is_dir && IGNORED_DIRS.contains(&name.as_str());
        let entry = FsEntry {
            name,
            is_dir,
            ignored,
            gitignored: false,
        };
        if is_dir {
            dirs.push(entry);
        } else {
            files.push(entry);
        }
    }

    dirs.extend(files);
    Ok(dirs)
}

fn list_dir_native(path: &str) -> Result<Vec<FsEntry>, String> {
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".DS_Store") {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let ignored = is_dir && IGNORED_DIRS.contains(&name.as_str());
        let e = FsEntry {
            name,
            is_dir,
            ignored,
            gitignored: false,
        };
        if is_dir {
            dirs.push(e);
        } else {
            files.push(e);
        }
    }

    // `sort_by_key` はキーを O(n log n) 回作り直す（#382）。小文字化は確保を伴うので、
    // 1 要素 1 回で済む `sort_by_cached_key` を使う。`node_modules` を展開すると
    // 数千件のディレクトリが来る（#303）。
    dirs.sort_by_cached_key(|e| e.name.to_lowercase());
    files.sort_by_cached_key(|e| e.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub content: String,
    pub encoding: String,
    /// True when the file does not exist yet: the editor opens it as a blank
    /// "new file" (vim-like) and the first save creates it.
    pub is_new: bool,
    /// 上限を超えていたときのファイルのバイト数（#362）。**`max_bytes` を渡した呼び出しにだけ
    /// 返る**（`is_new` が `allow_missing` を渡したときだけ立つのと同じ形）。本文は空。渡さない
    /// 呼び出し元には、従来どおりエラーで返す。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub too_large: Option<u64>,
}

impl FileReadResult {
    fn text(content: String, encoding: &str) -> Self {
        Self {
            content,
            encoding: encoding.to_owned(),
            is_new: false,
            too_large: None,
        }
    }
}

/// `read_raw_bytes` の結果。
#[derive(Debug, PartialEq)]
pub(crate) enum RawRead {
    Missing,
    TooLarge(u64),
    Bytes(Vec<u8>),
}

/// 呼び出し側が上限を渡さないときの値。エディタ以外（定義ジャンプの設定ファイル読み、diff の
/// 省略行の取り寄せ等）は従来どおり 2MB で止める。エディタは設定の値を渡す（#362）。
const DEFAULT_MAX_SIZE: u64 = 2_000_000;

/// エディタの上限として受け付ける最大値。設定の選択肢の最大（50MB）に余裕を持たせた値で、
/// IPC の引数は誰でも投げられるので Rust 側でも抑える。HTML のプレビュー（#399）の
/// 1 ファイルの上限も兼ねる。
pub(crate) const MAX_SIZE_CEILING: u64 = 64 * 1024 * 1024;

/// Read a file's raw bytes, refusing (without reading) files over `max_size`.
pub(crate) fn read_raw_bytes(
    shell: &ShellConfig,
    path: &str,
    max_size: u64,
) -> Result<RawRead, String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            match shell.run_stdout("stat", &["-c", "%s", "--", path]) {
                Ok(size_str) => {
                    if let Ok(size) = size_str.trim().parse::<u64>() {
                        if size > max_size {
                            return Ok(RawRead::TooLarge(size));
                        }
                    }
                }
                Err(stat_err) => {
                    // Distinguish "missing file" (new-file editor) from other
                    // stat failures (permission, distro down, ...).
                    let script = format!("[ -e {} ]", crate::types::bash_quote(path));
                    if let Ok((code, _, _)) = shell.run("bash", &["-c", &script]) {
                        if code != 0 {
                            return Ok(RawRead::Missing);
                        }
                    }
                    return Err(stat_err);
                }
            }
            let output = shell.run_raw("cat", &["--", path])?;
            if !output.status.success() {
                return Err(format!(
                    "Failed to read file: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Ok(RawRead::Bytes(output.stdout))
        }
        _ => {
            let meta = match std::fs::metadata(path) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(RawRead::Missing),
                Err(e) => return Err(e.to_string()),
            };
            if meta.len() > max_size {
                return Ok(RawRead::TooLarge(meta.len()));
            }
            Ok(RawRead::Bytes(
                std::fs::read(path).map_err(|e| e.to_string())?,
            ))
        }
    }
}

/// Bytes inspected for the binary-content guard.
const BINARY_SNIFF_LEN: usize = 8192;

/// バイナリと判定したときのエラー。丸ごと読む経路と部分読み込みの断片の両方が返す。
const BINARY_FILE_ERROR: &str = "Binary file — cannot open in the editor";

fn decode_bytes(bytes: &[u8], encoding_name: Option<&str>) -> Result<FileReadResult, String> {
    if let Some(name) = encoding_name {
        // Explicit encoding (re-open via StatusBar) is an escape hatch: no
        // binary guard, the user asked for this interpretation.
        if let Some(enc) = Encoding::for_label(name.as_bytes()) {
            let (content, actual_enc, _) = enc.decode(bytes);
            return Ok(FileReadResult::text(
                content.into_owned(),
                actual_enc.name(),
            ));
        }
    }
    // UTF-16 text legitimately contains NUL bytes — detect by BOM before the
    // binary guard. (UTF-8 BOM falls through: from_utf8 keeps the BOM char,
    // preserving the existing save round-trip.)
    if let Some(enc) = utf16_bom(bytes) {
        let (content, actual_enc, _) = enc.decode(bytes);
        return Ok(FileReadResult::text(
            content.into_owned(),
            actual_enc.name(),
        ));
    }
    // Safety net for unsupported binary formats (exe, zip, images opened via
    // CLI/"Open with", ...): refuse instead of rendering mojibake.
    if bytes.iter().take(BINARY_SNIFF_LEN).any(|&b| b == 0) {
        return Err(BINARY_FILE_ERROR.into());
    }
    Ok(match std::str::from_utf8(bytes) {
        Ok(s) => FileReadResult::text(s.to_owned(), "UTF-8"),
        Err(_) => {
            let (content, enc, _) = encoding_rs::SHIFT_JIS.decode(bytes);
            FileReadResult::text(content.into_owned(), enc.name())
        }
    })
}

/// UTF-16 の BOM で始まるか。UTF-16 は NUL を含むのでバイナリ判定より先に見る（`decode_bytes`）。
/// 部分読み込みの対象外でもある（`fs_read_file_chunk`）。
fn utf16_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    Encoding::for_bom(bytes)
        .map(|(enc, _)| enc)
        .filter(|&enc| enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE)
}

/// OS のファイラーやアプリから見えるパスにする。WSL は `\\wsl.localhost\` の UNC で見える。
fn host_visible_path(shell: &ShellConfig, path: String) -> String {
    match shell {
        ShellConfig::Wsl { distro } => {
            format!(r"\\wsl.localhost\{distro}{}", path.replace('/', "\\"))
        }
        _ => path,
    }
}

/// パスを OS に開かせる。**ディレクトリならファイラー、ファイルなら関連付けられたアプリ**で
/// 開く（`explorer.exe <file>` / `open <file>` / `xdg-open <file>` がどれもそう振る舞う）。
/// ファイルツリーの「エクスプローラーで開く」と、大きすぎるファイルの「関連付けられたアプリで
/// 開く」（#362）の両方がこれを呼ぶ。
#[tauri::command]
pub async fn fs_open_in_explorer(shell: ShellConfig, path: String) -> Result<(), String> {
    let target = host_visible_path(&shell, path);
    tokio::task::spawn_blocking(move || crate::types::os_open(&target))
        .await
        .map_err(|e| e.to_string())?
}

/// ファイルを選んだ状態でファイラーを開く（#362）。
#[tauri::command]
pub async fn fs_reveal_in_explorer(shell: ShellConfig, path: String) -> Result<(), String> {
    let target = host_visible_path(&shell, path);
    tokio::task::spawn_blocking(move || crate::types::os_reveal(&target))
        .await
        .map_err(|e| e.to_string())?
}

/// 部分読み込みの 1 回ぶん（#362）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub content: String,
    pub encoding: String,
    /// 次に読む位置（バイト）。`total_size` 以上なら末尾まで読んだ。
    pub next_offset: u64,
    pub total_size: u64,
}

/// `offset` から最大 `len` バイトを読む。戻り値の 2 つ目はファイル全体のバイト数。
fn read_byte_range(
    shell: &ShellConfig,
    path: &str,
    offset: u64,
    len: u64,
) -> Result<(Vec<u8>, u64), String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            // サイズと中身を 1 回の起動で取る。先頭行がサイズで、その後ろが生のバイト列。
            let p = bash_quote(path);
            let script = format!(
                "stat -c %s -- {p} && tail -c +{} -- {p} | head -c {len}",
                offset + 1
            );
            let output = shell.run_raw("bash", &["-c", &script])?;
            if !output.status.success() {
                return Err(format!(
                    "Failed to read file: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            let mut stdout = output.stdout;
            let nl = stdout
                .iter()
                .position(|&b| b == b'\n')
                .ok_or("Failed to read file size")?;
            let total = std::str::from_utf8(&stdout[..nl])
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .ok_or("Failed to read file size")?;
            // 本文は最大で数十 MB あるので、コピーせずに先頭のサイズ行だけを取り除く。
            stdout.drain(..=nl);
            Ok((stdout, total))
        }
        _ => {
            use std::io::{Read, Seek, SeekFrom};
            let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let total = file.metadata().map_err(|e| e.to_string())?.len();
            file.seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            file.take(len)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            Ok((bytes, total))
        }
    }
}

/// 読んだバイト列のどこで切るか。**末尾でなければ最後の改行の直後**で切り、行を途中で割らない
/// （続きを読んだとき、切れ目で 1 行が 2 行に割れない）。改行を 1 つも含まない（`len` より長い
/// 1 行）ときだけ、UTF-8 の文字の途中を避けて切る。
///
/// 改行（`0x0A`）で切るのは UTF-8 でも Shift_JIS でも文字の途中にならない（どちらも 2 バイト目に
/// `0x0A` を使わない）。UTF-16 は `0x0A` が文字の途中に現れるので、部分読み込みの対象外にしてある。
fn chunk_end(bytes: &[u8], eof: bool) -> usize {
    if eof {
        return bytes.len();
    }
    if let Some(i) = bytes.iter().rposition(|&b| b == b'\n') {
        return i + 1;
    }
    match std::str::from_utf8(bytes) {
        Err(e) if e.error_len().is_none() && e.valid_up_to() > 0 => e.valid_up_to(),
        _ => bytes.len(),
    }
}

/// 大きすぎるファイルを先頭から少しずつ読む（#362）。`encoding` を省けば断片ごとに判定する
/// （UTF-8 として読めなければ Shift_JIS）。UTF-8 以外に決まったあとの固定はフロントの
/// `partialEncoding` が受け持つ。
#[tauri::command]
pub async fn fs_read_file_chunk(
    shell: ShellConfig,
    path: String,
    offset: u64,
    len: u64,
    encoding: Option<String>,
) -> Result<FileChunk, String> {
    let len = len.clamp(1, MAX_SIZE_CEILING);
    tokio::task::spawn_blocking(move || {
        let (bytes, total_size) = read_byte_range(&shell, &path, offset, len)?;
        let eof = offset + bytes.len() as u64 >= total_size;
        let end = chunk_end(&bytes, eof);
        let chunk = &bytes[..end];
        // BOM は先頭の断片にしか無い。
        if offset == 0 && utf16_bom(chunk).is_some() {
            return Err("UTF-16 files cannot be opened partially".into());
        }
        // **断片の全体で NUL を見る。** `decode_bytes` の判定は先頭の 8KB だけで、続きの断片は
        // テキストの行で始まることが多い（テキストの後ろにバイナリが続くファイルで、化けた本文が
        // 足されていた）。断片は最大でも数十 MB で、`contains` は memchr なので安い。
        if chunk.contains(&0) {
            return Err(BINARY_FILE_ERROR.into());
        }
        let decoded = decode_bytes(chunk, encoding.as_deref())?;
        Ok(FileChunk {
            content: decoded.content,
            encoding: decoded.encoding,
            next_offset: offset + end as u64,
            total_size,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_read_file(
    shell: ShellConfig,
    path: String,
    encoding: Option<String>,
    allow_missing: Option<bool>,
    max_bytes: Option<u64>,
) -> Result<FileReadResult, String> {
    let max_size = max_bytes.unwrap_or(DEFAULT_MAX_SIZE).min(MAX_SIZE_CEILING);
    tokio::task::spawn_blocking(move || {
        match read_raw_bytes(&shell, &path, max_size)? {
            RawRead::Bytes(bytes) => decode_bytes(&bytes, encoding.as_deref()),
            // Editor opt-in: open a missing file as a blank new file (vim-like).
            // Other callers (existence probes, config reads) keep the error.
            RawRead::Missing if allow_missing.unwrap_or(false) => Ok(FileReadResult {
                is_new: true,
                ..FileReadResult::text(String::new(), "UTF-8")
            }),
            RawRead::Missing => Err("File not found".to_owned()),
            // 上限を頼んだ呼び出し（エディタ）には結果として返し、開き方を選ばせる（#362）。
            RawRead::TooLarge(size) if max_bytes.is_some() => Ok(FileReadResult {
                too_large: Some(size),
                ..FileReadResult::text(String::new(), "UTF-8")
            }),
            RawRead::TooLarge(size) => Err(format!("File too large ({size} bytes)")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn encode_content(content: &str, encoding_name: Option<&str>) -> Vec<u8> {
    if let Some(name) = encoding_name {
        if name != "UTF-8" {
            if let Some(enc) = Encoding::for_label(name.as_bytes()) {
                let (bytes, _, _) = enc.encode(content);
                return bytes.into_owned();
            }
        }
    }
    content.as_bytes().to_vec()
}

/// そのシェルの中でテキストを読む。**無ければ `None`、読めなければ `Err`。**
///
/// この 2 つを混ぜないのが要点（#320）。「読めなかった」を空として扱うと、次の書き込みが
/// 利用者のファイルを丸ごと置き換える。`write_bytes_atomic` と対で、**書く前に読む**もの
/// （設定ファイルのように、読めないなら書いてはいけないもの）が呼ぶ。
///
/// `read_raw_bytes` とは契約が違うので畳んでいない。あちらはエディタが開く経路で、サイズの
/// 上限とバイナリの判定を持ち、WSL では `stat` と `cat` で 2 回起動する。こちらは 1 回で、
/// **リンク先がまだ無い symlink を「無い」と言わない**（`-e` はリンクを辿るので `-L` も見る。
/// 非 WSL 側は `symlink_metadata`）。そこを混同すると、dotfiles を展開していないマシンで
/// リンク先に中身の無いファイルを作る。
pub fn read_text(shell: &ShellConfig, path: &str) -> Result<Option<String>, String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            let p = bash_quote(path);
            // 無ければ 9 で抜ける。`cat` が失敗したときの非 0 と区別するための番号。
            let script = format!("if [ -e {p} ] || [ -L {p} ]; then cat -- {p}; else exit 9; fi");
            let (code, stdout, stderr) = shell.run("bash", &["-c", &script])?;
            match code {
                0 => Ok(Some(stdout)),
                9 => Ok(None),
                _ => Err(format!("{path}: {}", stderr.trim())),
            }
        }
        _ => match std::fs::read_to_string(path) {
            Ok(text) => Ok(Some(text)),
            // `NotFound` でも、そこに symlink がある（＝辿れないだけ）なら「無い」ではない。
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && std::fs::symlink_metadata(path).is_err() =>
            {
                Ok(None)
            }
            Err(e) => Err(format!("{path}: {e}")),
        },
    }
}

/// Feed `bytes` to a bash script's stdin inside the distro (WSL only).
fn pipe_to_bash(shell: &ShellConfig, script: &str, bytes: &[u8]) -> Result<(), String> {
    let mut child = shell
        .command("bash", &["-c", script])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.id();
    let stdin = child.stdin.take();
    let bytes_owned = bytes.to_vec();

    let status = wait_with_timeout(
        pid,
        std::time::Duration::from_secs(30),
        "write",
        move || {
            if let Some(mut w) = stdin {
                let _ = w.write_all(&bytes_owned);
            }
            child.wait()
        },
    )?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to write file".into())
    }
}

fn write_bytes(shell: &ShellConfig, path: &str, bytes: &[u8]) -> Result<(), String> {
    match shell {
        // リダイレクトは `open(O_TRUNC)` なので symlink の先へ書く（リンクは残る）。
        ShellConfig::Wsl { .. } => {
            pipe_to_bash(shell, &format!("cat > {}", bash_quote(path)), bytes)
        }
        _ => std::fs::write(path, bytes).map_err(|e| e.to_string()),
    }
}

/// 書きかけを読み手に見せず、しかも **symlink を置き換えない**書き込み。
///
/// 素朴な「一時ファイル ＋ `rename`」は宛先が symlink のときにリンクそのものを消す。
/// 他人（Claude Code 等）も書き戻すファイルにはどちらの性質も要るので、**先にリンクを
/// 辿ってから、その実体に対して置き換える**（#320。dotfiles から `settings.json` を
/// symlink で配る構成で、Pike が hook を足すたびにリンクを壊していた）。
///
/// **WSL は distro の中で解決する。** `\\wsl.localhost` 越しの Windows API は WSL の
/// symlink を追従できない（リパースポイントとして見えて `NotFound` になる）ので、
/// UNC のパスで書くと必ずリンクを壊す側に倒れる。
///
/// **元のモードを引き継ぐ。** 新しい inode を被せるので、そのままだと 0600 の
/// `settings.json` が umask 次第で 0644 に緩む（鍵を `env` に置く人がいる）うえ、
/// リンク先が dotfiles なら登録のたびに mode の差分が出る。
pub fn write_bytes_atomic(shell: &ShellConfig, path: &str, bytes: &[u8]) -> Result<(), String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            let p = bash_quote(path);
            // `readlink -f` は最後の要素が無くても解決するので、新規作成でも使える。
            // 解決できないときだけ元のパスへ落とす。`trap` は、`cat` が途中で失敗した
            // ときに一時ファイルを（リンク先＝利用者のディレクトリに）残さないため。
            let script = format!(
                "set -e; t=$(readlink -f -- {p} 2>/dev/null) || t={p}; \
                 tmp=\"$t.pike-$$.tmp\"; trap 'rm -f -- \"$tmp\"' EXIT; \
                 cat > \"$tmp\"; \
                 [ -e \"$t\" ] && chmod --reference=\"$t\" -- \"$tmp\" 2>/dev/null || :; \
                 mv -f -- \"$tmp\" \"$t\"; trap - EXIT"
            );
            pipe_to_bash(shell, &script, bytes)
        }
        _ => write_host_atomic(std::path::Path::new(path), bytes),
    }
}

/// ホスト上のファイルへの、symlink を置き換えない atomic な書き込み。
///
/// `write_bytes_atomic` のホスト側の実体で、**シェルを持たない書き手も呼ぶ**
/// （`settings_sync`）。判断は `write_bytes_atomic` の doc が正本。
///
/// `rename` の宛先が既にあっても構わない（Windows でも `MOVEFILE_REPLACE_EXISTING`
/// なので置き換わる）。**消してから改名する形にしないこと**: 失敗したときに宛先が
/// 消えたまま残るうえ、読み手に「無い」瞬間を見せる。
pub fn write_host_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    // `canonicalize` はリンクを辿る（存在しないファイルでは失敗するので、そのときは
    // 元のパス＝新規作成）。
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let tmp = target.with_extension(format!("pike-{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, bytes).and_then(|()| {
        if let Ok(meta) = std::fs::metadata(&target) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, &target)
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_write_file(
    shell: ShellConfig,
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let bytes = encode_content(&content, encoding.as_deref());
        write_bytes(&shell, &path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_read_file_base64(shell: ShellConfig, path: String) -> Result<String, String> {
    const MAX_SIZE: u64 = 10_000_000;
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            let size_str = shell.run_stdout("stat", &["-c", "%s", "--", &path])?;
            if let Ok(size) = size_str.trim().parse::<u64>() {
                if size > MAX_SIZE {
                    return Err("File too large (>10MB)".into());
                }
            }
            let stdout = shell.run_stdout("base64", &["-w0", "--", &path])?;
            Ok(stdout.trim().to_owned())
        }
        _ => {
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.len() > MAX_SIZE {
                return Err("File too large (>10MB)".into());
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_rename(
    shell: ShellConfig,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("mv", &["--", &old_path, &new_path])?;
            Ok(())
        }
        _ => std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_delete(shell: ShellConfig, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("rm", &["-rf", "--", &path])?;
            Ok(())
        }
        _ => {
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
            } else {
                std::fs::remove_file(&path).map_err(|e| e.to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_copy(shell: ShellConfig, source: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("cp", &["-r", "--", &source, &dest])?;
            Ok(())
        }
        _ => {
            let meta = std::fs::metadata(&source).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                copy_dir_recursive(&source, &dest)
            } else {
                std::fs::copy(&source, &dest)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy one file's contents into `dest`, and only its contents.
///
/// `fs_copy` goes through `std::fs::copy`, which is `CopyFileExW` on Windows
/// and carries a file's NTFS alternate data streams along with its bytes. That
/// is right for copying inside a Windows tree, where those streams stay
/// invisible — but a downloaded file carries a `Zone.Identifier` stream, and
/// copying one into a WSL project that way leaves a second, visible file next
/// to it (`name.png:Zone.Identifier`), because the 9p filesystem has nowhere
/// else to put a stream. Opening the file by name reads the unnamed stream and
/// nothing else, which is what "import this picture" means (#241).
#[tauri::command]
pub async fn fs_import_file(
    shell: ShellConfig,
    source: String,
    dest: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        // A WSL path has no streams to leave behind.
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("cp", &["--", &source, &dest])?;
            Ok(())
        }
        _ => {
            let mut src = std::fs::File::open(&source).map_err(|e| e.to_string())?;
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut out)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_create_file(shell: ShellConfig, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("touch", &["--", &path])?;
            Ok(())
        }
        _ => {
            std::fs::File::create(&path).map_err(|e| e.to_string())?;
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ensure_dir(shell: &ShellConfig, dir: &str) -> Result<(), String> {
    match shell {
        ShellConfig::Wsl { .. } => {
            shell.run_stdout("mkdir", &["-p", "--", dir])?;
            Ok(())
        }
        _ => std::fs::create_dir_all(dir).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn fs_create_dir(shell: ShellConfig, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || ensure_dir(&shell, &path))
        .await
        .map_err(|e| e.to_string())?
}

// Upload cap for pasted/dropped files. Keep in sync with `MAX_UPLOAD_SIZE` in
// src/composables/useImagePaste.ts.
const MAX_UPLOAD_SIZE: usize = 50 * 1024 * 1024; // 50 MB

#[tauri::command]
pub async fn fs_write_file_base64(
    shell: ShellConfig,
    path: String,
    data: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data)
            .map_err(|e| format!("base64 decode error: {e}"))?;
        if bytes.len() > MAX_UPLOAD_SIZE {
            return Err(format!(
                "File too large ({} bytes, max {})",
                bytes.len(),
                MAX_UPLOAD_SIZE
            ));
        }
        // Ensure parent directory exists
        let parent = match &shell {
            ShellConfig::Wsl { .. } => path.rsplit_once('/').map(|(p, _)| p.to_owned()),
            _ => std::path::Path::new(&path)
                .parent()
                .and_then(|p| p.to_str())
                .map(|s| s.to_owned()),
        };
        if let Some(dir) = parent {
            let _ = ensure_dir(&shell, &dir);
        }
        write_bytes(&shell, &path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the first candidate path that exists as a regular file (not dir).
/// Used by import resolution to probe extension/index variants in one round-trip.
#[tauri::command]
pub async fn fs_resolve_first_existing(
    shell: ShellConfig,
    candidates: Vec<String>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || Ok(existing_paths(&shell, candidates)?.into_iter().next()))
        .await
        .map_err(|e| e.to_string())?
}

/// Return every candidate that exists as a regular file, in the given order.
/// The alias lookup of the definition jump (#398) needs all of them: a
/// `tsconfig.json` without `paths` must not hide the `vite.config.ts` next to
/// it, and `fs_resolve_first_existing` stops at the first hit.
#[tauri::command]
pub async fn fs_existing_paths(
    shell: ShellConfig,
    candidates: Vec<String>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || existing_paths(&shell, candidates))
        .await
        .map_err(|e| e.to_string())?
}

fn existing_paths(shell: &ShellConfig, candidates: Vec<String>) -> Result<Vec<String>, String> {
    let flags = match shell {
        // A distro that fails to start yields no output; `zip` then drops the
        // unanswered candidates, i.e. treats them as missing.
        ShellConfig::Wsl { .. } => test_paths_wsl(shell, &candidates, "-f")?,
        _ => candidates
            .iter()
            .map(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file()))
            .collect(),
    };
    Ok(candidates
        .into_iter()
        .zip(flags)
        .filter_map(|(p, ok)| ok.then_some(p))
        .collect())
}

/// Run `[ <test> path ]` for every path in one bash call (a WSL probe costs a
/// `wsl.exe` launch). One flag per line, in order; shorter than `paths` when
/// the distro fails to start, so each caller decides what "unknown" means.
fn test_paths_wsl(shell: &ShellConfig, paths: &[String], test: &str) -> Result<Vec<bool>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let script = paths
        .iter()
        .map(|p| {
            format!(
                "if [ {test} {} ]; then echo 1; else echo 0; fi",
                bash_quote(p)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let (_, stdout, _) = shell.run("bash", &["-c", &script])?;
    Ok(stdout.lines().map(|l| l.trim() == "1").collect())
}

/// Report, for each path, whether it exists as a directory. Batched so the
/// project panel can check every root of one shell in a single round-trip
/// (a WSL probe costs a `wsl.exe` launch, so per-path calls would be slow).
#[tauri::command]
pub async fn fs_dirs_exist(shell: ShellConfig, paths: Vec<String>) -> Result<Vec<bool>, String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => dirs_exist_wsl(&shell, &paths),
        _ => Ok(paths
            .iter()
            .map(|p| std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false))
            .collect()),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn dirs_exist_wsl(shell: &ShellConfig, paths: &[String]) -> Result<Vec<bool>, String> {
    let mut flags = test_paths_wsl(shell, paths, "-d")?;
    // A distro that fails to start yields no output; treat the roots as unknown
    // (= present) rather than reporting every WSL project as missing.
    flags.resize(paths.len(), true);
    Ok(flags)
}

fn copy_dir_recursive(src: &str, dst: &str) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = std::path::Path::new(dst).join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(
                src_path.to_str().unwrap_or(""),
                dst_path.to_str().unwrap_or(""),
            )?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 日本語の名前をそのまま返し、除外ディレクトリの中は並べない。上限で止まる。
    #[test]
    fn list_files_native_keeps_multibyte_names() {
        let dir = std::env::temp_dir().join(format!("pike-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("日本語").join("node_modules")).unwrap();
        std::fs::write(dir.join("日本語").join("ファイル.txt"), "").unwrap();
        std::fs::write(dir.join("日本語").join("node_modules").join("x.js"), "").unwrap();

        let files = list_files_native(dir.to_str().unwrap(), 100);
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("ファイル.txt"), "{files:?}");
        assert!(files[0].contains("日本語"));

        std::fs::write(dir.join("b.txt"), "").unwrap();
        assert_eq!(list_files_native(dir.to_str().unwrap(), 1).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ホストのシェル（`Unix` の腕）。symlink を作れる OS でしか意味が無いので、
    /// この 2 本は `cfg(unix)`＝**CI の macOS ジョブでだけ走る**（`platform.md`）。
    #[cfg(unix)]
    fn host_shell() -> ShellConfig {
        ShellConfig::Unix {
            program: String::new(),
        }
    }

    /// **読めないファイルを空として扱わない**（#320）。ここを混ぜると、次の書き込みが
    /// 利用者の設定を丸ごと置き換える。dangling symlink で作るのは、UNC 越しの WSL の
    /// リンクが `NotFound` として届く（＝辿れないのに「無い」に見える）のと同じ形。
    #[cfg(unix)]
    #[test]
    fn read_text_tells_a_missing_file_from_one_it_cannot_read() {
        let dir = std::env::temp_dir().join(format!("pike-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.json");
        let dangling = dir.join("dangling.json");
        let _ = std::fs::remove_file(&dangling);
        std::os::unix::fs::symlink(dir.join("nowhere.json"), &dangling).unwrap();

        assert_eq!(
            read_text(&host_shell(), missing.to_str().unwrap()),
            Ok(None)
        );
        assert!(read_text(&host_shell(), dangling.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 書き込みは symlink を置き換えず、その先を書き換える（#320）。**モードも引き継ぐ**:
    /// 新しい inode を被せるので、そのままだと 0600 の設定が umask 次第で緩む。
    #[cfg(unix)]
    #[test]
    fn write_bytes_atomic_keeps_the_symlink_and_the_mode() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("pike-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.json");
        let link = dir.join("settings.json");
        std::fs::write(&real, b"{\"a\":1}\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_bytes_atomic(&host_shell(), link.to_str().unwrap(), b"{\"a\":2}\n").unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "{\"a\":2}\n");
        assert_eq!(
            std::fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decode_bytes_utf8() {
        let r = decode_bytes("hello\nこんにちは".as_bytes(), None).unwrap();
        assert_eq!(r.encoding, "UTF-8");
        assert!(r.content.contains("こんにちは"));
    }

    #[test]
    fn decode_bytes_binary_rejected() {
        // PNG header contains NUL-adjacent binary content; NUL byte triggers the guard
        let bytes = [
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        ];
        assert!(decode_bytes(&bytes, None).is_err());
    }

    #[test]
    fn decode_bytes_utf16_bom_is_text() {
        // "hi" in UTF-16LE with BOM — NUL bytes present but must decode as text
        let bytes = [0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        let r = decode_bytes(&bytes, None).unwrap();
        assert_eq!(r.content, "hi");
        assert_eq!(r.encoding, "UTF-16LE");
    }

    #[test]
    fn decode_bytes_explicit_encoding_skips_guard() {
        // Explicit encoding is an escape hatch: no binary rejection
        let bytes = [b'a', 0x00, b'b'];
        assert!(decode_bytes(&bytes, Some("windows-1252")).is_ok());
    }

    #[test]
    fn chunk_end_cuts_after_last_newline() {
        assert_eq!(chunk_end(b"a\nbc\nde", false), 5);
        // 末尾まで読んだなら切らない
        assert_eq!(chunk_end(b"a\nbc\nde", true), 7);
    }

    #[test]
    fn chunk_end_without_newline_avoids_splitting_utf8() {
        // "あい" の 2 文字目の途中（3 + 2 バイト）で終わっている
        let bytes = "あい".as_bytes();
        assert_eq!(chunk_end(&bytes[..5], false), 3);
        assert_eq!(chunk_end(b"abc", false), 3);
    }

    #[test]
    fn read_missing_native_file_is_new() {
        // Missing file (even under a missing directory) → Ok(None), not Err —
        // the editor opens it as a blank new file.
        let r = read_raw_bytes(
            &ShellConfig::Powershell,
            r"C:\pike-test-definitely-missing\nope.txt",
            DEFAULT_MAX_SIZE,
        );
        assert_eq!(r, Ok(RawRead::Missing));
    }
}
