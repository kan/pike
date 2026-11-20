//! 大きなファイルビューア（#630）。エディタの上限（`editorMaxFileSizeMb`）を超えたファイルを、
//! 中身を持たずに読み取り専用で表示するための読み取り経路。
//!
//! **持つのは行位置の疎な索引だけ**（`LineIndex`。`STRIDE` 行ごとに行頭のバイト位置を 1 つ）。
//! 本文はフロントが見えている範囲の行を頼んだときにだけ、その場でファイルから読む。開いた直後に
//! 返して、索引は別のスレッドが末尾まで作る（そのあいだも、作り終えた範囲はスクロールできる）。
//! 1GB・1,000 万行のログで索引は約 1.2MB（15.6 万個の `u64`）。
//!
//! 「Rust はステートレスに」の例外として状態（`LargeFileState`）を持つ。索引はファイルを先頭から
//! 1 回なめて作るもので、要求のたびに作り直すと 1 行読むたびに数百 MB を読むことになるため。
//! 持つのは索引とパスだけで、本文のキャッシュはフロント（`lib/largeFile.ts`）が持つ。
//!
//! 文字コードは開いたときに先頭の `SNIFF_LEN` バイトで 1 回だけ決める（UTF-8 として読めれば
//! UTF-8、読めなければ Shift_JIS）。全体を見て決める丸ごとの読み込み（`decode_bytes`）とは
//! 違い、先頭が ASCII だけで後ろに Shift_JIS が出てくるファイルは後ろが化ける。改行（`0x0A`）で
//! 行を割るのは UTF-8 でも Shift_JIS でも文字の途中にならない（`chunk_end` と同じ理由）ので、
//! UTF-16 は開かない。

use super::{BINARY_FILE_ERROR, BINARY_SNIFF_LEN, host_visible_path, utf16_bom};
use crate::types::ShellConfig;
use encoding_rs::Encoding;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;
use tauri::State;

/// 索引の間隔（行）。行頭を探すときは、手前のチェックポイントから最大でこの行数ぶんを読み飛ばす。
const STRIDE: u64 = 64;
/// 索引を作るときに 1 回で読む大きさ。
const INDEX_BUF: usize = 1 << 20;
/// 行を読むときのバッファ。1 回に読むのは 256 行（フロントの `BLOCK_LINES`）で、ふつうのログなら
/// 数十 KB に収まる。
const LINE_BUF: usize = 64 * 1024;
/// 文字コードを決めるときに見る先頭の大きさ。
const SNIFF_LEN: usize = 64 * 1024;
/// 1 行のうちフロントへ渡す最大のバイト数。これより長い行は切って `cut` に載せる（数百 MB の
/// 1 行を DOM に入れない）。
const MAX_LINE_BYTES: usize = 64 * 1024;
/// `large_file_lines` で 1 回に返す最大の行数。
const MAX_LINES_PER_CALL: u64 = 4096;
/// 検索で 1 回に読む大きさ。前後の窓とは `overlap` だけ重ねる。
const SEARCH_BUF: usize = 4 << 20;
/// 件数を数えるのをやめる一致の数。
const MAX_COUNT: u64 = 100_000;
/// 追記かどうかを確かめるために覚えておく末尾の大きさ。
const TAIL_LEN: u64 = 4096;

/// 行位置の疎な索引。ファイルの先頭から `feed` で流し込んで作る。
#[derive(Debug, Clone)]
struct LineIndex {
    /// 行 `k * STRIDE` の先頭のバイト位置。`[0]` は常に 0。
    checkpoints: Vec<u64>,
    /// これまでに見た改行の数。
    newlines: u64,
    /// 索引を作り終えたバイト数。
    scanned: u64,
}

impl LineIndex {
    fn new() -> Self {
        Self {
            checkpoints: vec![0],
            newlines: 0,
            scanned: 0,
        }
    }

    /// 次のバイト列を流し込む（`scanned` の続き）。
    fn feed(&mut self, buf: &[u8]) {
        for i in memchr::memchr_iter(b'\n', buf) {
            self.newlines += 1;
            if self.newlines.is_multiple_of(STRIDE) {
                self.checkpoints.push(self.scanned + i as u64 + 1);
            }
        }
        self.scanned += buf.len() as u64;
    }

    /// 索引を作り終えた範囲の行数。CodeMirror と同じく「改行の数 + 1」（末尾が改行なら最後は空行）。
    fn lines(&self) -> u64 {
        self.newlines + 1
    }

    /// 行 `line`（0 始まり）を探す起点。手前のチェックポイントのバイト位置と、そこから読み飛ばす
    /// 行数を返す。索引の範囲の外なら `None`。
    fn locate(&self, line: u64) -> Option<(u64, u64)> {
        if line > self.newlines {
            return None;
        }
        let k = (line / STRIDE) as usize;
        Some((self.checkpoints[k], line % STRIDE))
    }

    /// バイト位置 `offset` を含む行より手前のチェックポイント（行番号, バイト位置）。
    fn checkpoint_before(&self, offset: u64) -> (u64, u64) {
        let k = self.checkpoints.partition_point(|&c| c <= offset).max(1) - 1;
        (k as u64 * STRIDE, self.checkpoints[k])
    }
}

/// 索引を作っている状態。`LineIndex` と一緒に 1 つの `RwLock` で守る。
#[derive(Debug)]
struct IndexState {
    index: LineIndex,
    /// 索引の対象の大きさ（開いた・追記を拾ったときのファイルサイズ）。
    size: u64,
    done: bool,
    error: Option<String>,
    /// 索引を作り終えたときの更新時刻（同じ大きさのまま書き換えられたかを見る）。
    mtime: Option<SystemTime>,
    /// `size` の直前 `TAIL_LEN` バイト。大きくなったときに、追記か書き換えかを見分ける。
    tail: Vec<u8>,
}

struct LargeDoc {
    path: PathBuf,
    encoding: &'static Encoding,
    state: RwLock<IndexState>,
    /// 索引のスレッドの世代。閉じた・作り直したら進め、古いスレッドはそれを見て止まる。
    generation: AtomicU64,
    /// 次の一致を探す検索の世代。新しい検索が始まったら進め、走っている検索はそれを見て止まる。
    find_generation: AtomicU64,
    /// 件数を数える検索の世代。**探す検索とは分ける**: 数えている途中で Enter を押して次へ
    /// 進むと、同じ世代では数えるほうが止まり、件数が出なくなる。
    count_generation: AtomicU64,
    /// 行を読むときに使い回すハンドル。WSL の UNC（9P）では開くだけで数 ms かかり、スクロールの
    /// たびに払うことになる。書き換えを拾ったら（`large_file_refresh` の `Reset`）捨てて開き直す。
    lines_file: Mutex<Option<File>>,
}

/// 開いている大きなファイル。キーは `large_file_open` が返す id。
#[derive(Default)]
pub struct LargeFileState {
    docs: Mutex<HashMap<String, Arc<LargeDoc>>>,
}

impl LargeFileState {
    fn get(&self, id: &str) -> Result<Arc<LargeDoc>, String> {
        self.docs
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "Large file is not open".to_owned())
    }
}

fn read_tail(file: &mut File, size: u64) -> std::io::Result<Vec<u8>> {
    let start = size.saturating_sub(TAIL_LEN);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.take(size - start).read_to_end(&mut buf)?;
    Ok(buf)
}

/// 先頭のバイト列から文字コードを決める。UTF-16 とバイナリは開かない。
fn sniff_encoding(head: &[u8]) -> Result<&'static Encoding, String> {
    if utf16_bom(head).is_some() {
        return Err("UTF-16 files cannot be opened in the large file viewer".into());
    }
    if head.iter().take(BINARY_SNIFF_LEN).any(|&b| b == 0) {
        return Err(BINARY_FILE_ERROR.into());
    }
    Ok(match std::str::from_utf8(head) {
        Ok(_) => encoding_rs::UTF_8,
        // 末尾で文字が切れているだけなら UTF-8。
        Err(e) if e.error_len().is_none() => encoding_rs::UTF_8,
        Err(_) => encoding_rs::SHIFT_JIS,
    })
}

fn poisoned<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// `scanned` から `size` まで索引を作る。世代が変わったら途中で止める。
///
/// **世代は書き込みのロックの中で見てから書く。** 世代を進めるのも同じロックの中
/// （`large_file_refresh`）なので、作り直しの後に古いスレッドが 1 回ぶん流し込むことが無い。
fn run_indexer(doc: Arc<LargeDoc>, generation: u64) {
    let stale = || doc.generation.load(Ordering::Relaxed) != generation;
    let result = (|| -> std::io::Result<()> {
        let mut file = File::open(&doc.path)?;
        let (from, size) = {
            let s = doc.state.read().map_err(poisoned)?;
            (s.index.scanned, s.size)
        };
        file.seek(SeekFrom::Start(from))?;
        let mut reader = file.take(size - from);
        let mut buf = vec![0u8; INDEX_BUF];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let mut s = doc.state.write().map_err(poisoned)?;
            if stale() {
                return Ok(());
            }
            s.index.feed(&buf[..n]);
        }
        // 読み終えたら、追記を見分けるための末尾と更新時刻を控える。
        let mut file = reader.into_inner();
        let tail = read_tail(&mut file, size)?;
        let mtime = file.metadata().ok().and_then(|m| m.modified().ok());
        let mut s = doc.state.write().map_err(poisoned)?;
        if stale() {
            return Ok(());
        }
        // 途中でファイルが縮むと読めたぶんが `size` に届かない。届いたぶんを大きさにする。
        s.size = s.index.scanned;
        s.tail = tail;
        s.mtime = mtime;
        Ok(())
    })();
    if let Ok(mut s) = doc.state.write()
        && !stale()
    {
        s.done = true;
        if let Err(e) = result {
            s.error = Some(e.to_string());
        }
    }
}

/// 索引のスレッドを立てる。`generation` は呼び出し側が状態を書き換えたロックの中で進めた値。
fn spawn_indexer(doc: &Arc<LargeDoc>, generation: u64) {
    let doc = Arc::clone(doc);
    std::thread::spawn(move || run_indexer(doc, generation));
}

/// 1 行を読む。`keep` なら `out` に最大 `MAX_LINE_BYTES` バイトを足す（行末の改行は入れない）。
/// 戻り値は（改行で終わったか, 切ったか）。改行の前に EOF に着いたら `false`（その行が最後）。
fn read_line_capped<R: BufRead>(
    reader: &mut R,
    out: &mut Vec<u8>,
    keep: bool,
) -> std::io::Result<(bool, bool)> {
    let mut cut = false;
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            return Ok((false, cut));
        }
        let (take, found) = match memchr::memchr(b'\n', buf) {
            Some(i) => (i, true),
            None => (buf.len(), false),
        };
        if keep {
            let room = MAX_LINE_BYTES.saturating_sub(out.len());
            if take > room {
                cut = true;
            }
            out.extend_from_slice(&buf[..take.min(room)]);
        }
        reader.consume(if found { take + 1 } else { take });
        if found {
            return Ok((true, cut));
        }
    }
}

/// 切った行の末尾で UTF-8 の文字が割れていたら、割れた手前まで戻す。
fn trim_partial_utf8(bytes: &mut Vec<u8>, encoding: &'static Encoding) {
    if encoding != encoding_rs::UTF_8 {
        return;
    }
    if let Err(e) = std::str::from_utf8(bytes)
        && e.error_len().is_none()
    {
        bytes.truncate(e.valid_up_to());
    }
}

fn decode_line(bytes: &[u8], encoding: &'static Encoding) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    encoding.decode_without_bom_handling(bytes).0.into_owned()
}

/// フロントへ返す行の並び。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeLines {
    pub lines: Vec<String>,
    /// `MAX_LINE_BYTES` で切った行（`lines` の中の位置）。
    pub cut: Vec<u32>,
}

/// `start_byte` から `skip` 行を読み飛ばした位置の reader。読み飛ばす途中でファイルが終わったら
/// `None`（その行は無い）。
fn reader_at_line<R: Read + Seek>(
    source: R,
    start_byte: u64,
    skip: u64,
) -> std::io::Result<Option<BufReader<R>>> {
    let mut reader = BufReader::with_capacity(LINE_BUF, source);
    reader.seek(SeekFrom::Start(start_byte))?;
    let mut scratch = Vec::new();
    for _ in 0..skip {
        let (terminated, _) = read_line_capped(&mut reader, &mut scratch, false)?;
        if !terminated {
            return Ok(None);
        }
    }
    Ok(Some(reader))
}

/// `start_byte` から `skip` 行を読み飛ばし、`count` 行を読む。ファイルの末尾は最後の行（空でも）を
/// 1 つ返して止まる。
fn read_lines<R: Read + Seek>(
    source: R,
    encoding: &'static Encoding,
    start_byte: u64,
    skip: u64,
    count: u64,
) -> std::io::Result<(Vec<String>, Vec<u32>)> {
    let Some(mut reader) = reader_at_line(source, start_byte, skip)? else {
        return Ok((Vec::new(), Vec::new()));
    };
    let mut scratch = Vec::new();
    let mut lines = Vec::new();
    let mut cut = Vec::new();
    while (lines.len() as u64) < count {
        scratch.clear();
        let (terminated, was_cut) = read_line_capped(&mut reader, &mut scratch, true)?;
        if was_cut {
            trim_partial_utf8(&mut scratch, encoding);
            cut.push(lines.len() as u32);
        }
        lines.push(decode_line(&scratch, encoding));
        // 改行で終わらなかった行が最後。改行で終わったファイルは、次の周で最後の空行を返す
        // （`LineIndex::lines` と揃える）。
        if !terminated {
            break;
        }
    }
    Ok((lines, cut))
}

/// 検索に使う照合器と、窓の読み方に要るもの。
struct Matcher {
    re: regex::bytes::Regex,
    encoding: &'static Encoding,
    /// 窓どうしを重ねる幅（`overlap_of`）。
    overlap: usize,
}

impl Matcher {
    /// 窓の中の一致。文字の途中から始まるもの（`is_char_start`）は除く。
    fn matches<'a>(&'a self, window: &'a [u8]) -> impl Iterator<Item = regex::bytes::Match<'a>> {
        self.re
            .find_iter(window)
            .filter(move |m| is_char_start(window, m.start(), self.encoding))
    }
}

/// 検索に使う照合器。UTF-8 は Unicode の大文字小文字を畳み、それ以外のエンコードは問い合わせを
/// そのエンコードのバイト列にして照合する（大文字小文字を畳むのは ASCII だけ）。
fn build_matcher(
    query: &str,
    case_sensitive: bool,
    encoding: &'static Encoding,
) -> Result<Matcher, String> {
    let re = build_regex(query, case_sensitive, encoding)?;
    Ok(Matcher {
        re,
        encoding,
        overlap: overlap_of(query),
    })
}

fn build_regex(
    query: &str,
    case_sensitive: bool,
    encoding: &'static Encoding,
) -> Result<regex::bytes::Regex, String> {
    if encoding == encoding_rs::UTF_8 {
        return regex::bytes::RegexBuilder::new(&regex::escape(query))
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| e.to_string());
    }
    // **大文字小文字は問い合わせの ASCII の文字だけで畳む**（`[aA]`）。照合器の
    // `case_insensitive` に任せると、2 バイト文字の 2 バイト目（Shift_JIS は 0x40〜0xFC）まで畳み、
    // 「ア」（0x83 0x41）が別のカタカナ（0x83 0x61）にも当たる。
    use std::fmt::Write as _;
    let mut pattern = String::new();
    for c in query.chars() {
        if !case_sensitive && c.is_ascii_alphabetic() {
            let (l, u) = (c.to_ascii_lowercase(), c.to_ascii_uppercase());
            let _ = write!(pattern, "[{l}{u}]");
            continue;
        }
        let mut utf8 = [0; 4];
        let (bytes, _, _) = encoding.encode(c.encode_utf8(&mut utf8));
        for b in bytes.iter() {
            let _ = write!(pattern, "\\x{b:02x}");
        }
    }
    regex::bytes::RegexBuilder::new(&pattern)
        .unicode(false)
        .build()
        .map_err(|e| e.to_string())
}

/// `pos` が文字の境目か。UTF-8 の照合器は文字単位で当てるので常に真。Shift_JIS は 2 バイト目に
/// ASCII の範囲（0x40〜0x7E）を使うので、`\` や英字の問い合わせが漢字の 2 バイト目に当たる。行頭
/// （改行の直後）は必ず境目なので、そこから先行バイトを数えて確かめる。窓の中に行頭が無い（窓より
/// 長い行）ときは窓の先頭から数える。
fn is_char_start(window: &[u8], pos: usize, encoding: &'static Encoding) -> bool {
    if encoding == encoding_rs::UTF_8 {
        return true;
    }
    let mut i = memchr::memrchr(b'\n', &window[..pos]).map_or(0, |n| n + 1);
    while i < pos {
        let b = window[i];
        // Shift_JIS の先行バイト。後ろに 1 バイト続く。
        i += if (0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b) {
            2
        } else {
            1
        };
    }
    i == pos
}

/// 窓どうしを重ねる幅。大文字小文字を畳むと一致の長さが問い合わせと変わりうる（`K` と
/// KELVIN SIGN）ので、1 文字 4 バイトで見積もる。
fn overlap_of(query: &str) -> usize {
    query.chars().count() * 4 + 4
}

/// 検索を止める合図。新しい検索が始まったか。
type Cancelled<'a> = &'a dyn Fn() -> bool;

/// 後から始めた検索に止められたときのエラー（`large_file_find`）。フロントは捨てるだけで表示しない。
const CANCELLED: &str = "cancelled";

/// `start` から最大 `len` バイトを `buf` へ読む（`buf` は窓ごとに使い回す）。
fn read_window<R: Read + Seek>(
    source: &mut R,
    start: u64,
    len: u64,
    buf: &mut Vec<u8>,
) -> std::io::Result<()> {
    source.seek(SeekFrom::Start(start))?;
    buf.clear();
    source.take(len).read_to_end(buf)?;
    Ok(())
}

/// 一致を探す関数の形（`find_forward` / `find_backward`）。
type FindFn<R> =
    fn(&mut R, &Matcher, u64, u64, u64, Cancelled) -> std::io::Result<Option<(u64, u64)>>;

/// `[lo, hi)` から始まる最初の一致（バイトの範囲）。止められたら `None`。
fn find_forward<R: Read + Seek>(
    source: &mut R,
    matcher: &Matcher,
    lo: u64,
    hi: u64,
    size: u64,
    cancelled: Cancelled,
) -> std::io::Result<Option<(u64, u64)>> {
    let mut pos = lo;
    let mut window = Vec::new();
    while pos < hi {
        if cancelled() {
            return Ok(None);
        }
        let step = (SEARCH_BUF as u64).min(hi - pos);
        let len = (step + matcher.overlap as u64).min(size.saturating_sub(pos));
        read_window(source, pos, len, &mut window)?;
        if let Some(m) = matcher.matches(&window).find(|m| (m.start() as u64) < step) {
            return Ok(Some((pos + m.start() as u64, pos + m.end() as u64)));
        }
        pos += step;
    }
    Ok(None)
}

/// `[lo, hi)` から始まる最後の一致（バイトの範囲）。止められたら `None`。
fn find_backward<R: Read + Seek>(
    source: &mut R,
    matcher: &Matcher,
    lo: u64,
    hi: u64,
    size: u64,
    cancelled: Cancelled,
) -> std::io::Result<Option<(u64, u64)>> {
    let mut end = hi;
    let mut window = Vec::new();
    while end > lo {
        if cancelled() {
            return Ok(None);
        }
        let start = end.saturating_sub(SEARCH_BUF as u64).max(lo);
        let len = (end - start + matcher.overlap as u64).min(size.saturating_sub(start));
        read_window(source, start, len, &mut window)?;
        let limit = end - start;
        if let Some(m) = matcher
            .matches(&window)
            .filter(|m| (m.start() as u64) < limit)
            .last()
        {
            return Ok(Some((start + m.start() as u64, start + m.end() as u64)));
        }
        end = start;
    }
    Ok(None)
}

/// ファイル全体の一致の数（`MAX_COUNT` で打ち切る）。止められたら `None`。
fn count_matches<R: Read + Seek>(
    source: &mut R,
    matcher: &Matcher,
    size: u64,
    cancelled: Cancelled,
) -> std::io::Result<Option<(u64, bool)>> {
    let mut pos = 0;
    let mut count = 0;
    let mut window = Vec::new();
    while pos < size {
        if cancelled() {
            return Ok(None);
        }
        let step = (SEARCH_BUF as u64).min(size - pos);
        let len = (step + matcher.overlap as u64).min(size - pos);
        read_window(source, pos, len, &mut window)?;
        // 重ねた部分から始まる一致は次の窓で数える。窓の中の一致は重ならないので、前の一致の
        // 途中から始まる一致を二重に数えることもない（`find_iter` が左から重ねずに拾う）。
        count += matcher
            .matches(&window)
            .take_while(|m| (m.start() as u64) < step)
            .count() as u64;
        if count >= MAX_COUNT {
            return Ok(Some((MAX_COUNT, true)));
        }
        pos += step;
    }
    Ok(Some((count, false)))
}

/// 一致の位置。行と列はフロントの文字列（UTF-16）の単位。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeMatch {
    pub line: u64,
    /// 行頭からの位置（UTF-16 の単位）。
    pub col: u64,
    pub len: u64,
    /// 次の検索の起点に使うバイトの範囲。
    pub byte: u64,
    pub byte_end: u64,
}

fn utf16_len(bytes: &[u8], encoding: &'static Encoding) -> u64 {
    encoding
        .decode_without_bom_handling(bytes)
        .0
        .encode_utf16()
        .count() as u64
}

/// 表示の外の列。フロントの `splitAt` は行の長さ以上の列を「一致を塗らない」として扱う。
const COL_BEYOND_CUT: u64 = u32::MAX as u64;

/// バイトの範囲を行と列へ直す。手前のチェックポイント（最大 `STRIDE` 行前）から一致の始まりまでを
/// 流し読みして改行を数える。**まとめて読まない**: 1 行が数百 MB のファイル（1 行の JSON）では、
/// チェックポイントから一致までがファイルの大半になる。
fn locate_match<R: Read + Seek>(
    source: &mut R,
    index: &LineIndex,
    encoding: &'static Encoding,
    start: u64,
    end: u64,
) -> std::io::Result<LargeMatch> {
    let (cp_line, cp_byte) = index.checkpoint_before(start);
    source.seek(SeekFrom::Start(cp_byte))?;
    let mut reader = source.by_ref().take(start - cp_byte);
    let mut buf = vec![0u8; INDEX_BUF];
    let (mut newlines, mut line_start, mut pos) = (0u64, cp_byte, cp_byte);
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for i in memchr::memchr_iter(b'\n', &buf[..n]) {
            newlines += 1;
            line_start = pos + i as u64 + 1;
        }
        pos += n as u64;
    }
    // 列は行頭から一致までを数える。表示は `MAX_LINE_BYTES` で切るので、その後ろの一致は数えない。
    let mut bytes = Vec::new();
    let col = if start - line_start <= MAX_LINE_BYTES as u64 {
        read_window(source, line_start, start - line_start, &mut bytes)?;
        utf16_len(&bytes, encoding)
    } else {
        COL_BEYOND_CUT
    };
    read_window(source, start, end - start, &mut bytes)?;
    Ok(LargeMatch {
        line: cp_line + newlines,
        col,
        len: utf16_len(&bytes, encoding),
        byte: start,
        byte_end: end,
    })
}

/// 行の先頭のバイト位置。
fn line_start_byte<R: Read + Seek>(
    source: R,
    index: &LineIndex,
    line: u64,
) -> std::io::Result<Option<u64>> {
    let Some((byte, skip)) = index.locate(line) else {
        return Ok(None);
    };
    match reader_at_line(source, byte, skip)? {
        Some(mut reader) => Ok(Some(reader.stream_position()?)),
        None => Ok(None),
    }
}

// ── コマンド ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileInfo {
    pub id: String,
    pub size: u64,
    pub encoding: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileStatus {
    /// 索引を作り終えた範囲の行数。
    pub lines: u64,
    pub size: u64,
    pub scanned: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// ブロッキングの処理を `spawn_blocking` に逃がす（`rust.md` の非同期）。
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// 開いて id を返す。索引は別のスレッドで作り始める（終わるのを待たない）。
#[tauri::command]
pub async fn large_file_open(
    state: State<'_, LargeFileState>,
    shell: ShellConfig,
    path: String,
) -> Result<LargeFileInfo, String> {
    // WSL のファイルは `\\wsl.localhost\` の UNC を `std::fs` で読む。他の `fs` のように
    // `wsl.exe` のコマンドで運ぶと、行を頼むたびにプロセスが立つ。
    let path = PathBuf::from(host_visible_path(&shell, path));
    let (encoding, size, path) = blocking(move || {
        let mut file = File::open(&path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let mut head = Vec::new();
        (&mut file)
            .take(SNIFF_LEN as u64)
            .read_to_end(&mut head)
            .map_err(|e| e.to_string())?;
        Ok((sniff_encoding(&head)?, size, path))
    })
    .await?;
    let doc = Arc::new(LargeDoc {
        path,
        encoding,
        state: RwLock::new(IndexState {
            index: LineIndex::new(),
            size,
            done: false,
            error: None,
            mtime: None,
            tail: Vec::new(),
        }),
        generation: AtomicU64::new(1),
        find_generation: AtomicU64::new(0),
        count_generation: AtomicU64::new(0),
        lines_file: Mutex::new(None),
    });
    spawn_indexer(&doc, 1);
    let id = uuid::Uuid::new_v4().to_string();
    state
        .docs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), doc);
    Ok(LargeFileInfo {
        id,
        size,
        encoding: encoding.name().to_owned(),
    })
}

/// 索引の進み具合。フロントは作り終えるまで間隔を置いて聞く。
#[tauri::command]
pub fn large_file_status(
    state: State<'_, LargeFileState>,
    id: String,
) -> Result<LargeFileStatus, String> {
    let doc = state.get(&id)?;
    let s = doc.state.read().map_err(|e| e.to_string())?;
    Ok(LargeFileStatus {
        lines: s.index.lines(),
        size: s.size,
        scanned: s.index.scanned,
        done: s.done,
        error: s.error.clone(),
    })
}

/// 行 `start` から最大 `count` 行を読む。索引を作り終えた範囲の外なら空で返す。
#[tauri::command]
pub async fn large_file_lines(
    state: State<'_, LargeFileState>,
    id: String,
    start: u64,
    count: u64,
) -> Result<LargeLines, String> {
    let doc = state.get(&id)?;
    blocking(move || {
        let located = doc
            .state
            .read()
            .map_err(|e| e.to_string())?
            .index
            .locate(start);
        let Some((byte, skip)) = located else {
            return Ok(LargeLines {
                lines: Vec::new(),
                cut: Vec::new(),
            });
        };
        let mut slot = doc.lines_file.lock().map_err(|e| e.to_string())?;
        let file = match &mut *slot {
            Some(file) => file,
            empty => empty.insert(File::open(&doc.path).map_err(|e| e.to_string())?),
        };
        let read = read_lines(
            file,
            doc.encoding,
            byte,
            skip,
            count.min(MAX_LINES_PER_CALL),
        );
        // 読めなかったハンドルは捨て、次は開き直す（ネットワーク越しの切断など）。
        if read.is_err() {
            *slot = None;
        }
        let (lines, cut) = read.map_err(|e| e.to_string())?;
        Ok(LargeLines { lines, cut })
    })
    .await
}

/// 次（`backward` なら前）の一致を探す。起点は `from_byte`（前回の一致）か、無ければ `from_line`
/// の行頭。末尾（先頭）まで無ければ反対の端から起点まで回り込む。次の `large_file_find` に
/// 止められたら `CANCELLED` のエラーで返す。
#[tauri::command]
pub async fn large_file_find(
    state: State<'_, LargeFileState>,
    id: String,
    query: String,
    case_sensitive: bool,
    from_line: u64,
    from_byte: Option<u64>,
    backward: bool,
) -> Result<Option<LargeMatch>, String> {
    let doc = state.get(&id)?;
    if query.is_empty() {
        return Ok(None);
    }
    let generation = doc.find_generation.fetch_add(1, Ordering::Relaxed) + 1;
    blocking(move || {
        // 索引は写しを持つ（1GB のログで約 1MB）。読み取りのロックを検索のあいだ握ると、外部変更の
        // `large_file_refresh` が書き込みのロックを待ち、その後ろで行の読み込みまで止まる。
        // **探すのは索引を作り終えた範囲**（`scanned`）。その外の一致は行に直せない。書き足され
        // 続けるログでは追記のたびに索引の続きを作るので、作り終えるのを待つと検索が効かない。
        let (index, size) = {
            let s = doc.state.read().map_err(|e| e.to_string())?;
            (s.index.clone(), s.index.scanned)
        };
        let matcher = build_matcher(&query, case_sensitive, doc.encoding)?;
        let mut file = File::open(&doc.path).map_err(|e| e.to_string())?;
        let from = match from_byte {
            Some(b) => b.min(size),
            None => line_start_byte(&mut file, &index, from_line)
                .map_err(|e| e.to_string())?
                .unwrap_or(0),
        };
        let cancelled = || doc.find_generation.load(Ordering::Relaxed) != generation;
        // 起点から端まで探し、無ければ反対の端から起点まで回り込む。
        let (search, first, wrap): (FindFn<File>, _, _) = if backward {
            (find_backward, (0, from), (from, size))
        } else {
            (find_forward, (from, size), (0, from))
        };
        let found = match search(&mut file, &matcher, first.0, first.1, size, &cancelled) {
            Ok(None) if !cancelled() => {
                search(&mut file, &matcher, wrap.0, wrap.1, size, &cancelled)
            }
            other => other,
        }
        .map_err(|e| e.to_string())?;
        // 止められた検索は「見つからない」と区別して返す（後から届いた古い結果で、新しい一致を
        // 消さないように）。
        if found.is_none() && cancelled() {
            return Err(CANCELLED.into());
        }
        match found {
            Some((start, end)) => locate_match(&mut file, &index, doc.encoding, start, end)
                .map(Some)
                .map_err(|e| e.to_string()),
            None => Ok(None),
        }
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeCount {
    pub count: u64,
    pub truncated: bool,
}

/// 一致の数。次の `large_file_count` が始まったら止め、`None` を返す。
#[tauri::command]
pub async fn large_file_count(
    state: State<'_, LargeFileState>,
    id: String,
    query: String,
    case_sensitive: bool,
) -> Result<Option<LargeCount>, String> {
    let doc = state.get(&id)?;
    if query.is_empty() {
        return Ok(Some(LargeCount {
            count: 0,
            truncated: false,
        }));
    }
    let generation = doc.count_generation.fetch_add(1, Ordering::Relaxed) + 1;
    blocking(move || {
        // 数えるのも索引を作り終えた範囲（`large_file_find` と同じ）。作っている途中なら途中までの
        // 数で、フロントは作り終えてから数え直す。
        let size = doc.state.read().map_err(|e| e.to_string())?.index.scanned;
        let matcher = build_matcher(&query, case_sensitive, doc.encoding)?;
        let mut file = File::open(&doc.path).map_err(|e| e.to_string())?;
        let cancelled = || doc.count_generation.load(Ordering::Relaxed) != generation;
        let counted =
            count_matches(&mut file, &matcher, size, &cancelled).map_err(|e| e.to_string())?;
        Ok(counted.map(|(count, truncated)| LargeCount { count, truncated }))
    })
    .await
}

/// ファイルが変わったときの扱い。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RefreshKind {
    /// 変わっていない（または索引を作っている途中で、終わってから見直す）。
    Unchanged,
    /// 末尾に足された。索引は続きから作る。
    Appended,
    /// 書き換えられた。索引を作り直す。
    Reset,
}

/// 外部の変更を拾う。末尾への追記なら索引を続きから作り、それ以外は作り直す。索引を作っている
/// 途中なら何もせず `Unchanged` を返すので、呼び出し側は作り終えてから呼び直す。
#[tauri::command]
pub async fn large_file_refresh(
    state: State<'_, LargeFileState>,
    id: String,
) -> Result<RefreshKind, String> {
    let doc = state.get(&id)?;
    blocking(move || {
        let mut file = File::open(&doc.path).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        let new_size = meta.len();
        let mtime = meta.modified().ok();
        // **見極めから書き換えまでを 1 つの書き込みのロックで行う。** 読み取りのロックで見極めると、
        // 外部変更の知らせと「再読み込み」が重なったときに両方が `done` を見て索引のスレッドを
        // 2 本立て、同じ追記を 2 回流し込む。
        let (kind, generation) = {
            let mut s = doc.state.write().map_err(|e| e.to_string())?;
            if !s.done {
                return Ok(RefreshKind::Unchanged);
            }
            let kind = if new_size == s.size && mtime == s.mtime {
                RefreshKind::Unchanged
            } else if new_size > s.size
                && s.error.is_none()
                && read_tail(&mut file, s.size).map_err(|e| e.to_string())? == s.tail
            {
                RefreshKind::Appended
            } else {
                RefreshKind::Reset
            };
            if kind == RefreshKind::Unchanged {
                return Ok(kind);
            }
            if kind == RefreshKind::Reset {
                s.index = LineIndex::new();
                // 別のファイルに置き換えられた（rename で差し替える書き方）なら、持っている
                // ハンドルは古い中身を指している。
                if let Ok(mut slot) = doc.lines_file.lock() {
                    *slot = None;
                }
            }
            s.size = new_size;
            s.done = false;
            s.error = None;
            (kind, doc.generation.fetch_add(1, Ordering::Relaxed) + 1)
        };
        spawn_indexer(&doc, generation);
        Ok(kind)
    })
    .await
}

/// 閉じる。索引のスレッドと検索も止める。
#[tauri::command]
pub fn large_file_close(state: State<'_, LargeFileState>, id: String) -> Result<(), String> {
    if let Some(doc) = state.docs.lock().map_err(|e| e.to_string())?.remove(&id) {
        doc.generation.fetch_add(1, Ordering::Relaxed);
        doc.find_generation.fetch_add(1, Ordering::Relaxed);
        doc.count_generation.fetch_add(1, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn index_of(bytes: &[u8], chunk: usize) -> LineIndex {
        let mut index = LineIndex::new();
        for c in bytes.chunks(chunk) {
            index.feed(c);
        }
        index
    }

    fn numbered(n: usize) -> String {
        (0..n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn index_counts_lines_like_an_editor() {
        assert_eq!(index_of(b"", 4).lines(), 1);
        assert_eq!(index_of(b"a", 4).lines(), 1);
        assert_eq!(index_of(b"a\n", 4).lines(), 2);
        assert_eq!(index_of(b"a\nb", 4).lines(), 2);
    }

    #[test]
    fn checkpoints_do_not_depend_on_how_the_bytes_were_fed() {
        let text = numbered(1000);
        let a = index_of(text.as_bytes(), 7);
        let b = index_of(text.as_bytes(), 1 << 20);
        assert_eq!(a.checkpoints, b.checkpoints);
        assert_eq!(a.checkpoints.len(), 1000 / STRIDE as usize + 1);
        // 行 64 の先頭は "line 64" の位置。
        let pos = text.find("line 64\n").unwrap() as u64;
        assert_eq!(a.locate(64), Some((pos, 0)));
        assert_eq!(a.locate(70), Some((pos, 6)));
        assert_eq!(
            a.locate(1000),
            Some((a.checkpoints[15], 1000 - 15 * STRIDE))
        );
        assert_eq!(a.locate(1001), None);
    }

    #[test]
    fn read_lines_from_any_line() {
        let text = numbered(300);
        let index = index_of(text.as_bytes(), 1 << 20);
        let (byte, skip) = index.locate(130).unwrap();
        let (lines, cut) = read_lines(
            Cursor::new(text.as_bytes()),
            encoding_rs::UTF_8,
            byte,
            skip,
            3,
        )
        .unwrap();
        assert_eq!(lines, vec!["line 130", "line 131", "line 132"]);
        assert!(cut.is_empty());
    }

    #[test]
    fn read_lines_returns_the_trailing_empty_line() {
        let text = b"a\nb\n";
        let (lines, _) = read_lines(Cursor::new(&text[..]), encoding_rs::UTF_8, 0, 1, 10).unwrap();
        assert_eq!(lines, vec!["b", ""]);
        let (lines, _) =
            read_lines(Cursor::new(&b"a\nb"[..]), encoding_rs::UTF_8, 0, 0, 10).unwrap();
        assert_eq!(lines, vec!["a", "b"]);
        let (lines, _) = read_lines(Cursor::new(&b""[..]), encoding_rs::UTF_8, 0, 0, 10).unwrap();
        assert_eq!(lines, vec![""]);
    }

    #[test]
    fn read_lines_strips_cr_and_decodes_shift_jis() {
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("日本語\r\nabc\r\n");
        let (lines, _) =
            read_lines(Cursor::new(bytes.as_ref()), encoding_rs::SHIFT_JIS, 0, 0, 2).unwrap();
        assert_eq!(lines, vec!["日本語", "abc"]);
    }

    #[test]
    fn long_lines_are_cut_on_a_char_boundary() {
        let mut text = "あ".repeat(MAX_LINE_BYTES); // 3 バイトずつ
        text.push_str("\nnext\n");
        let (lines, cut) =
            read_lines(Cursor::new(text.as_bytes()), encoding_rs::UTF_8, 0, 0, 2).unwrap();
        assert_eq!(cut, vec![0]);
        assert_eq!(lines[0].chars().count(), MAX_LINE_BYTES / 3);
        assert!(lines[0].chars().all(|c| c == 'あ'));
        assert_eq!(lines[1], "next");
    }

    #[test]
    fn sniff_rejects_binary_and_utf16() {
        assert!(sniff_encoding(b"ab\0cd").is_err());
        assert!(sniff_encoding(&[0xFF, 0xFE, b'a', 0]).is_err());
        assert_eq!(sniff_encoding(b"plain").unwrap(), encoding_rs::UTF_8);
        // 先頭の断片の末尾で切れた UTF-8 は UTF-8 のまま。
        assert_eq!(
            sniff_encoding(&"あ".as_bytes()[..2]).unwrap(),
            encoding_rs::UTF_8
        );
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("日本語");
        assert_eq!(sniff_encoding(&sjis).unwrap(), encoding_rs::SHIFT_JIS);
    }

    fn never() -> bool {
        false
    }

    #[test]
    fn find_wraps_and_maps_to_line_and_utf16_column() {
        let text = format!("{}xx 😀 Needle\n{}", numbered(200), numbered(10));
        let bytes = text.as_bytes();
        let index = index_of(bytes, 1 << 20);
        let size = bytes.len() as u64;
        let re = build_matcher("needle", false, encoding_rs::UTF_8).unwrap();
        let mut cur = Cursor::new(bytes);
        let (s, e) = find_forward(&mut cur, &re, 0, size, size, &never)
            .unwrap()
            .unwrap();
        let m = locate_match(&mut cur, &index, encoding_rs::UTF_8, s, e).unwrap();
        assert_eq!(m.line, 200);
        // "xx 😀 " は UTF-16 で 6 単位（絵文字はサロゲートの 2 つ）。
        assert_eq!(m.col, 6);
        assert_eq!(m.len, 6);
        // 一致の後ろからは見つからない。回り込みは呼び出し側（先頭から起点まで）。
        assert!(
            find_forward(&mut cur, &re, e, size, size, &never)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            find_forward(&mut cur, &re, 0, e, size, &never).unwrap(),
            Some((s, e))
        );
        assert_eq!(
            find_backward(&mut cur, &re, 0, size, size, &never).unwrap(),
            Some((s, e))
        );
        assert!(
            find_backward(&mut cur, &re, 0, s, size, &never)
                .unwrap()
                .is_none()
        );
        let cs = build_matcher("needle", true, encoding_rs::UTF_8).unwrap();
        assert!(
            find_forward(&mut cur, &cs, 0, size, size, &never)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn matches_across_window_boundaries_are_found_once() {
        // 窓の境目（`SEARCH_BUF`）をまたぐ位置に一致を置く。
        let mut bytes = vec![b'.'; SEARCH_BUF - 3];
        bytes.extend_from_slice(b"needle");
        bytes.extend(vec![b'.'; 100]);
        bytes.extend_from_slice(b"needle");
        let size = bytes.len() as u64;
        let re = build_matcher("needle", true, encoding_rs::UTF_8).unwrap();
        let mut cur = Cursor::new(&bytes[..]);
        assert_eq!(
            count_matches(&mut cur, &re, size, &never).unwrap(),
            Some((2, false))
        );
        let first = (SEARCH_BUF as u64 - 3, SEARCH_BUF as u64 + 3);
        assert_eq!(
            find_forward(&mut cur, &re, 0, size, size, &never).unwrap(),
            Some(first)
        );
        assert_eq!(
            find_backward(&mut cur, &re, 0, first.1, size, &never).unwrap(),
            Some(first)
        );
    }

    #[test]
    fn shift_jis_queries_match_encoded_bytes() {
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("abc\nエラー発生\n");
        let re = build_matcher("エラー", false, encoding_rs::SHIFT_JIS).unwrap();
        let size = bytes.len() as u64;
        let mut cur = Cursor::new(bytes.as_ref());
        let (s, e) = find_forward(&mut cur, &re, 0, size, size, &never)
            .unwrap()
            .unwrap();
        let index = index_of(&bytes, 1 << 20);
        let m = locate_match(&mut cur, &index, encoding_rs::SHIFT_JIS, s, e).unwrap();
        assert_eq!((m.line, m.col, m.len), (1, 0, 3));
    }

    #[test]
    fn shift_jis_ascii_queries_skip_trail_bytes() {
        // 「ソ」は 0x83 0x5C で、2 バイト目が `\`。「ア」（0x83 0x41）の 2 バイト目は `A`。
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("ソア\n\\ a\n");
        let size = bytes.len() as u64;
        let mut cur = Cursor::new(bytes.as_ref());
        let backslash = build_matcher("\\", true, encoding_rs::SHIFT_JIS).unwrap();
        assert_eq!(
            count_matches(&mut cur, &backslash, size, &never).unwrap(),
            Some((1, false))
        );
        let a = build_matcher("a", false, encoding_rs::SHIFT_JIS).unwrap();
        assert_eq!(
            count_matches(&mut cur, &a, size, &never).unwrap(),
            Some((1, false))
        );
        // 大文字小文字を畳んでも、「ア」が別のカタカナ（0x83 0x61）に当たらない。
        let (other, _, _) = encoding_rs::SHIFT_JIS.encode("ア");
        let mut swapped = other.to_vec();
        swapped[1] = 0x61;
        let ka = build_matcher("ア", false, encoding_rs::SHIFT_JIS).unwrap();
        let n = swapped.len() as u64;
        assert_eq!(
            count_matches(&mut Cursor::new(&swapped[..]), &ka, n, &never).unwrap(),
            Some((0, false))
        );
    }

    #[test]
    fn matches_far_into_a_long_line_are_not_given_a_column() {
        let mut text = "x".repeat(MAX_LINE_BYTES * 2);
        text.push_str("needle\n");
        let bytes = text.as_bytes();
        let index = index_of(bytes, 1 << 20);
        let size = bytes.len() as u64;
        let re = build_matcher("needle", true, encoding_rs::UTF_8).unwrap();
        let mut cur = Cursor::new(bytes);
        let (s, e) = find_forward(&mut cur, &re, 0, size, size, &never)
            .unwrap()
            .unwrap();
        let m = locate_match(&mut cur, &index, encoding_rs::UTF_8, s, e).unwrap();
        assert_eq!((m.line, m.col, m.len), (0, COL_BEYOND_CUT, 6));
    }

    #[test]
    fn cancelled_search_stops() {
        let bytes = b"needle";
        let re = build_matcher("needle", true, encoding_rs::UTF_8).unwrap();
        let mut cur = Cursor::new(&bytes[..]);
        assert_eq!(count_matches(&mut cur, &re, 6, &|| true).unwrap(), None);
    }
}
