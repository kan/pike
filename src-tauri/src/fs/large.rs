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

use super::pieces::{History, Piece, PieceTable};
use super::{BINARY_FILE_ERROR, BINARY_SNIFF_LEN, host_visible_path, utf16_bom};
use crate::types::ShellConfig;
use encoding_rs::Encoding;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// Rust の `std::fs` で開くパス（WSL は UNC）。
    path: PathBuf,
    /// シェルの側のパスとシェル。WSL の保存は distro の中でリンクを辿って置き換える（`save_doc`）。
    native: String,
    shell: ShellConfig,
    encoding: &'static Encoding,
    state: RwLock<IndexState>,
    /// 索引のスレッドの世代。閉じた・作り直したら進め、古いスレッドはそれを見て止まる。
    generation: AtomicU64,
    /// 次の一致を探す検索の世代。新しい検索が始まったら進め、走っている検索はそれを見て止まる。
    find_generation: AtomicU64,
    /// 件数を数える検索の世代。**探す検索とは分ける**: 数えている途中で Enter を押して次へ
    /// 進むと、同じ世代では数えるほうが止まり、件数が出なくなる。
    count_generation: AtomicU64,
    /// 検索結果の一覧（`large_file_search_start`）。裏のスレッドが見つけた分から積み、フロントが
    /// 間隔を置いて続きを取りに来る。世代は `hits_generation`（新しい検索で進め、古い検索は止まる）。
    hits: Mutex<HitList>,
    hits_generation: AtomicU64,
    /// 行を読むときに使い回すハンドル。WSL の UNC（9P）では開くだけで数 ms かかり、スクロールの
    /// たびに払うことになる。書き換えを拾ったら（`large_file_refresh` の `Reset`）捨てて開き直す。
    lines_file: Mutex<Option<File>>,
    /// 編集の履歴（`pieces.rs`）。**編集していないあいだは `None`**: 文書は索引を作り終えた
    /// 範囲そのもので、行数は索引とともに伸びる（`doc_table`）。編集は索引を作り終えてから
    /// 受け付け、最初の編集のときに今の行数で作る（`with_history`）。読み直しと保存で `None` に戻す。
    history: Mutex<Option<History>>,
    /// 編集で入れた行を書くときの改行（開いたときの先頭の行に合わせる）。
    eol: &'static [u8],
    /// 保存している途中か。保存のあいだは編集を受け付けない。
    saving: AtomicBool,
    /// 保存の進み具合（書いたバイト数 / 書く見込みのバイト数）。
    save_written: AtomicU64,
    save_total: AtomicU64,
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
        // **更新時刻と末尾は読み始める前に控える。** 読み終えた時点のものを控えると、読んでいる
        // あいだに書き換えられたファイル（索引の前半が古い中身、後半が新しい中身）が、次の
        // `large_file_refresh` で「変わっていない」に見えて直らない。
        let mtime = file.metadata()?.modified().ok();
        let tail_before = read_tail(&mut file, size)?;
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
        let mut file = reader.into_inner();
        let tail = read_tail(&mut file, size)?;
        let mut s = doc.state.write().map_err(poisoned)?;
        if stale() {
            return Ok(());
        }
        // 途中でファイルが縮むと読めたぶんが `size` に届かない。届いたぶんを大きさにする。
        s.size = s.index.scanned;
        if tail == tail_before {
            s.tail = tail;
            s.mtime = mtime;
        } else {
            // 読んでいるあいだに書き換えられた。何も控えず、次の `large_file_refresh` で作り直す
            // （空の末尾は追記の判定に一致しない）。末尾への追記はこの範囲の外なので、ここに来ない。
            s.tail = Vec::new();
            s.mtime = None;
        }
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
    /// 編集で入れた行（`String`）に当てる照合器。こちらは常に Unicode の文字で照合する。
    text: regex::Regex,
    encoding: &'static Encoding,
    /// 窓どうしを重ねる幅（`overlap_of`）。
    overlap: usize,
}

impl Matcher {
    /// 窓の `from` から後ろの一致（重ならないもの）。**窓の先頭は文字の境目であること**
    /// （`aligned_end` / `aligned_start` で揃える）。`from` は境目でなくてよい。
    fn matches<'a>(&'a self, window: &'a [u8], from: usize) -> Matches<'a> {
        Matches {
            matcher: self,
            window,
            at: from,
            cursor: 0,
        }
    }

    fn is_utf8(&self) -> bool {
        self.encoding == encoding_rs::UTF_8
    }
}

/// `Matcher::matches` の中身。
///
/// **Shift_JIS は文字の途中から始まる候補を捨て、捨てた候補の 1 バイト後ろから照合し直す。**
/// 2 バイト目に ASCII の範囲（0x40〜0x7E）を使うので、`\` や英字の問い合わせが漢字の 2 バイト目に
/// 当たる。`find_iter` の結果を後から捨てる形だと、捨てた候補と重なる本物の一致（「アAA」の `AA`）
/// を見落とす。境目かどうかは `cursor`（直前に確かめた境目）から先行バイトを数えて前へ進めるので、
/// 窓 1 つにつき線形で済む。UTF-8 の照合器は文字の途中からは当たらないので数えない。
struct Matches<'a> {
    matcher: &'a Matcher,
    window: &'a [u8],
    /// 次に照合を始める位置。
    at: usize,
    /// 文字の境目と分かっている位置（`at` 以下）。
    cursor: usize,
}

impl<'a> Iterator for Matches<'a> {
    type Item = regex::bytes::Match<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.at > self.window.len() {
                return None;
            }
            let found = self.matcher.re.find_at(self.window, self.at)?;
            // 空の一致は起こらない（問い合わせが空なら探さない）が、念のため前へ進める。
            let next_at = found.end().max(found.start() + 1);
            if self.matcher.is_utf8() {
                self.at = next_at;
                return Some(found);
            }
            let start = found.start();
            if self.cursor > start {
                // 前の候補で境目の先まで数えた（2 バイト文字の 2 バイト目から始まる候補）。
                self.at = start + 1;
                continue;
            }
            // 改行の直後は必ず境目。数える範囲を短くする。
            if let Some(n) = memchr::memrchr(b'\n', &self.window[self.cursor..start]) {
                self.cursor += n + 1;
            }
            while self.cursor < start {
                self.cursor += sjis_char_len(self.window[self.cursor]);
            }
            if self.cursor == start {
                self.at = next_at;
                return Some(found);
            }
            self.at = start + 1;
        }
    }
}

/// Shift_JIS の 1 文字のバイト数（先行バイトなら 2）。
fn sjis_char_len(b: u8) -> usize {
    if (0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b) {
        2
    } else {
        1
    }
}

/// 窓の先頭（境目）から数えて、`pos` 以後で最初の文字の境目。次の窓の先頭に使う。
fn aligned_end(window: &[u8], pos: usize, matcher: &Matcher) -> usize {
    if matcher.is_utf8() {
        return pos;
    }
    let mut i = memchr::memrchr(b'\n', &window[..pos.min(window.len())]).map_or(0, |n| n + 1);
    while i < pos {
        i += sjis_char_len(window[i]);
    }
    i
}

/// 窓の中で、最初の文字の境目と分かる位置（`limit` より手前）。後ろへ探す窓は先頭が境目とは
/// 限らないので、最初の改行の直後から照合する（その手前は次の窓が受け持つ）。窓の中に改行が
/// 無い（窓より長い行）ときは先頭を境目とみなす。
fn aligned_start(window: &[u8], limit: usize, matcher: &Matcher) -> usize {
    if matcher.is_utf8() {
        return 0;
    }
    match memchr::memchr(b'\n', &window[..limit.min(window.len())]) {
        Some(n) if n + 1 < limit => n + 1,
        _ => 0,
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
    let text = regex::RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Matcher {
        re,
        text,
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

/// `[lo, hi)` から始まる最初の一致（バイトの範囲）。止められたら `None`。`lo` は文字の境目
/// （0・行頭・前の一致の末尾）であること。次の窓の先頭も境目に揃える（`aligned_end`）。
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
        if let Some(m) = matcher
            .matches(&window, 0)
            .take_while(|m| (m.start() as u64) < step)
            .next()
        {
            return Ok(Some((pos + m.start() as u64, pos + m.end() as u64)));
        }
        pos += aligned_end(&window, step as usize, matcher) as u64;
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
        let limit = (end - start) as usize;
        // `lo` は境目（0・行頭・前の一致の始まり）。それ以外の窓の先頭は文字の途中でありうる。
        let base = if start == lo {
            0
        } else {
            aligned_start(&window, limit, matcher)
        };
        if let Some(m) = matcher
            .matches(&window[base..], 0)
            .take_while(|m| m.start() + base < limit)
            .last()
        {
            let s = start + (base + m.start()) as u64;
            return Ok(Some((s, s + m.len() as u64)));
        }
        end = start + base as u64;
    }
    Ok(None)
}

/// `[lo, hi)` から始まる一致の数（`limit` で頭打ち）。止められたら `None`。`lo` は文字の境目
/// （0 か行頭）であること。
fn count_matches<R: Read + Seek>(
    source: &mut R,
    matcher: &Matcher,
    lo: u64,
    hi: u64,
    limit: u64,
    cancelled: Cancelled,
) -> std::io::Result<Option<u64>> {
    let mut count = 0;
    let finished = scan_windows(source, matcher, (lo, hi), cancelled, |w| {
        count += w.matches.len() as u64;
        count < limit
    })?;
    Ok(if count >= limit {
        Some(limit)
    } else if finished {
        Some(count)
    } else {
        None
    })
}

/// `scan_windows` が渡す窓 1 枚。
struct ScanWindow<'a> {
    /// 窓の先頭（ファイルのバイト位置）。
    pos: u64,
    /// 窓の中身（次の窓と重なる `overlap` を含む）。
    bytes: &'a [u8],
    /// 次の窓の先頭（文字の境目）。
    next: u64,
    /// この窓から始まる一致（窓の中のバイトの範囲）。
    matches: &'a [(usize, usize)],
}

/// `[lo, hi)` を窓に分けて読み、窓ごとにそこから始まる一致を `visit` へ渡す。`lo` は文字の境目
/// （0 か行頭）であること。最後まで読めば `true`、止められたか `visit` が `false` を返せば `false`。
///
/// 一致はどれも 1 度だけ、始まる窓で渡す。**次の窓は最後に渡した一致の末尾から照合する**: 窓ごとに
/// 照合をやり直すと、前の窓で渡した一致と重なる候補（境目の手前の `ababa` で `aba`）をもう一度渡す。
fn scan_windows<R: Read + Seek>(
    source: &mut R,
    matcher: &Matcher,
    (lo, hi): (u64, u64),
    cancelled: Cancelled,
    mut visit: impl FnMut(&ScanWindow) -> bool,
) -> std::io::Result<bool> {
    let mut pos = lo;
    let mut resume = lo;
    let mut window = Vec::new();
    let mut matches = Vec::new();
    while pos < hi {
        if cancelled() {
            return Ok(false);
        }
        let step = (SEARCH_BUF as u64).min(hi - pos);
        read_window(source, pos, step + matcher.overlap as u64, &mut window)?;
        let from = resume.saturating_sub(pos) as usize;
        matches.clear();
        // 重ねた部分から始まる一致は次の窓で渡す。
        matches.extend(
            matcher
                .matches(&window, from)
                .take_while(|m| (m.start() as u64) < step)
                .map(|m| (m.start(), m.end())),
        );
        if let Some(&(_, end)) = matches.last() {
            resume = pos + end as u64;
        }
        let next = pos + aligned_end(&window, step as usize, matcher) as u64;
        let w = ScanWindow {
            pos,
            bytes: &window,
            next,
            matches: &matches,
        };
        if !visit(&w) {
            return Ok(false);
        }
        pos = next;
    }
    Ok(true)
}

/// 一致の位置。行と列はフロントの文字列（UTF-16）の単位。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LargeMatch {
    /// 文書の行（編集のあとの行番号）。
    pub line: u64,
    /// 行頭からの位置（UTF-16 の単位）。
    pub col: u64,
    pub len: u64,
    /// 次の検索の起点に使う、行の中のバイトの範囲（その行の保存のされ方での位置。フロントは
    /// 解釈せずに返すだけ）。
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

/// バイトの範囲を元のファイルの行と列へ直す。手前のチェックポイント（最大 `STRIDE` 行前）から一致の始まりまでを
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
        // 元のファイルの行。文書の行へは呼び出し側が直す（`search_doc`）。
        line: cp_line + newlines,
        col,
        len: utf16_len(&bytes, encoding),
        byte: start - line_start,
        byte_end: end - line_start,
    })
}

/// 元のファイルの行 `line` の先頭のバイト位置。行数より後ろは `size`（索引を作り終えた範囲の末尾）。
fn src_line_byte<R: Read + Seek>(
    source: R,
    index: &LineIndex,
    size: u64,
    line: u64,
) -> std::io::Result<u64> {
    if line >= index.lines() {
        return Ok(size);
    }
    Ok(line_start_byte(source, index, line)?.unwrap_or(size))
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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileStatus {
    /// 文書の行数（編集していなければ、索引を作り終えた範囲の行数）。
    pub lines: u64,
    pub size: u64,
    pub scanned: u64,
    pub done: bool,
    pub error: Option<String>,
    /// 保存したときから変わっているか。
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub saving: bool,
    pub save_written: u64,
    pub save_total: u64,
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
    let doc = blocking(move || open_doc(shell, path)).await?;
    let info = LargeFileInfo {
        id: uuid::Uuid::new_v4().to_string(),
        size: doc.state.read().map_err(|e| e.to_string())?.size,
        encoding: doc.encoding.name().to_owned(),
    };
    state
        .docs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(info.id.clone(), doc);
    Ok(info)
}

/// ファイルを開いて文字コードを決め、索引のスレッドを立てる（`large_file_open` の中身）。
fn open_doc(shell: ShellConfig, native: String) -> Result<Arc<LargeDoc>, String> {
    // WSL のファイルは `\\wsl.localhost\` の UNC を `std::fs` で読む。他の `fs` のように
    // `wsl.exe` のコマンドで運ぶと、行を頼むたびにプロセスが立つ。
    let path = PathBuf::from(host_visible_path(&shell, native.clone()));
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut head = Vec::new();
    (&mut file)
        .take(SNIFF_LEN as u64)
        .read_to_end(&mut head)
        .map_err(|e| e.to_string())?;
    let doc = Arc::new(LargeDoc {
        path,
        native,
        shell,
        encoding: sniff_encoding(&head)?,
        eol: eol_of(&head),
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
        hits: Mutex::new(HitList::default()),
        hits_generation: AtomicU64::new(0),
        lines_file: Mutex::new(None),
        history: Mutex::new(None),
        saving: AtomicBool::new(false),
        save_written: AtomicU64::new(0),
        save_total: AtomicU64::new(0),
    });
    spawn_indexer(&doc, 1);
    Ok(doc)
}

/// 先頭の行の改行（CRLF か LF）。改行が無ければ LF。
fn eol_of(head: &[u8]) -> &'static [u8] {
    match memchr::memchr(b'\n', head) {
        Some(i) if i > 0 && head[i - 1] == b'\r' => b"\r\n",
        _ => b"\n",
    }
}

/// 今の文書のピースの並び。編集していなければ、索引を作り終えた範囲の行そのもの。
fn doc_table(doc: &LargeDoc) -> Result<PieceTable, String> {
    if let Some(h) = doc.history.lock().map_err(|e| e.to_string())?.as_ref() {
        return Ok(h.current().clone());
    }
    let lines = doc.state.read().map_err(|e| e.to_string())?.index.lines();
    Ok(PieceTable::pristine(lines))
}

/// 索引の進み具合と、編集・保存の状態。フロントは索引を作り終えるまで（保存のあいだも）間隔を
/// 置いて聞く。
#[tauri::command]
pub fn large_file_status(
    state: State<'_, LargeFileState>,
    id: String,
) -> Result<LargeFileStatus, String> {
    let doc = state.get(&id)?;
    doc_status(&doc)
}

fn doc_status(doc: &LargeDoc) -> Result<LargeFileStatus, String> {
    // 進み具合の問い合わせのたびに走るので、ピースの並びを写さない。
    let edited = doc
        .history
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|h| (h.current().len(), h.dirty(), h.can_undo(), h.can_redo()));
    let s = doc.state.read().map_err(|e| e.to_string())?;
    let (lines, dirty, can_undo, can_redo) =
        edited.unwrap_or((s.index.lines(), false, false, false));
    Ok(LargeFileStatus {
        lines,
        size: s.size,
        scanned: s.index.scanned,
        done: s.done,
        error: s.error.clone(),
        dirty,
        can_undo,
        can_redo,
        saving: doc.saving.load(Ordering::Relaxed),
        save_written: doc.save_written.load(Ordering::Relaxed),
        save_total: doc.save_total.load(Ordering::Relaxed),
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
    blocking(move || doc_lines(&doc, start, count)).await
}

/// `large_file_lines` の中身。文書の行を、ピースごとに元のファイルか編集で入れた行から集める。
fn doc_lines(doc: &LargeDoc, start: u64, count: u64) -> Result<LargeLines, String> {
    let table = doc_table(doc)?;
    let count = count.min(MAX_LINES_PER_CALL);
    let mut out = LargeLines {
        lines: Vec::new(),
        cut: Vec::new(),
    };
    let Some((mut i, mut off)) = table.locate(start) else {
        return Ok(out);
    };
    let pieces = table.pieces();
    while (out.lines.len() as u64) < count && i < pieces.len() {
        let want = (pieces[i].len() - off).min(count - out.lines.len() as u64);
        match &pieces[i] {
            Piece::Source { start: s, .. } => {
                let (lines, cut) = read_source_lines(doc, s + off, want)?;
                let read = lines.len() as u64;
                let base = out.lines.len() as u32;
                out.cut.extend(cut.into_iter().map(|c| base + c));
                out.lines.extend(lines);
                // 索引の外（作っている途中）か、ファイルが縮んだ。続きは無い。
                if read < want {
                    break;
                }
            }
            added @ Piece::Added { .. } => {
                let from = off as usize;
                out.lines
                    .extend_from_slice(&added.added()[from..from + want as usize]);
            }
        }
        i += 1;
        off = 0;
    }
    Ok(out)
}

/// 元のファイルの行 `start` から `count` 行。行を読むハンドルは使い回す（`lines_file`）。
fn read_source_lines(
    doc: &LargeDoc,
    start: u64,
    count: u64,
) -> Result<(Vec<String>, Vec<u32>), String> {
    let located = doc
        .state
        .read()
        .map_err(|e| e.to_string())?
        .index
        .locate(start);
    let Some((byte, skip)) = located else {
        return Ok((Vec::new(), Vec::new()));
    };
    let mut slot = doc.lines_file.lock().map_err(|e| e.to_string())?;
    let file = match &mut *slot {
        Some(file) => file,
        empty => empty.insert(File::open(&doc.path).map_err(|e| e.to_string())?),
    };
    let read = read_lines(file, doc.encoding, byte, skip, count);
    // 読めなかったハンドルは捨て、次は開き直す（ネットワーク越しの切断など）。
    if read.is_err() {
        *slot = None;
    }
    read.map_err(|e| e.to_string())
}

/// 次（`backward` なら前）の一致を探す。起点は文書の行 `from_line` の中の `from_byte`（前回の
/// 一致の `byte` / `byte_end`。無ければ行頭）。末尾（先頭）まで無ければ反対の端から起点まで
/// 回り込む。次の `large_file_find` に止められたら `CANCELLED` のエラーで返す。
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
        let matcher = build_matcher(&query, case_sensitive, doc.encoding)?;
        let cancelled = || doc.find_generation.load(Ordering::Relaxed) != generation;
        search_doc(
            &doc,
            &matcher,
            (from_line, from_byte.unwrap_or(0)),
            backward,
            &cancelled,
        )
    })
    .await
}

/// 文書の上の位置。行と、その行の中のバイト（`LargeMatch::byte` と同じ単位）。
type Pos = (u64, u64);

/// 検索に使う文書の写し。
///
/// **索引は写しを持つ**（1GB のログで約 1MB）。読み取りのロックを検索のあいだ握ると、外部変更の
/// `large_file_refresh` が書き込みのロックを待ち、その後ろで行の読み込みまで止まる。**探すのは
/// 索引を作り終えた範囲**（`scanned`）。その外の一致は行に直せない。書き足され続けるログでは
/// 追記のたびに索引の続きを作るので、作り終えるのを待つと検索が効かない。
///
/// 一致はピースをまたがない（問い合わせは改行を含まず、ピースは行の単位）ので、ピースごとに探す。
struct SearchView<'a> {
    index: LineIndex,
    size: u64,
    table: PieceTable,
    starts: Vec<u64>,
    file: File,
    matcher: &'a Matcher,
    encoding: &'static Encoding,
}

impl<'a> SearchView<'a> {
    fn open(doc: &LargeDoc, matcher: &'a Matcher) -> Result<Self, String> {
        let table = doc_table(doc)?;
        let (index, size) = {
            let s = doc.state.read().map_err(|e| e.to_string())?;
            (s.index.clone(), s.index.scanned)
        };
        Ok(Self {
            starts: table.starts(),
            table,
            index,
            size,
            file: File::open(&doc.path).map_err(|e| e.to_string())?,
            matcher,
            encoding: doc.encoding,
        })
    }

    fn src_byte(&mut self, line: u64) -> std::io::Result<u64> {
        src_line_byte(&mut self.file, &self.index, self.size, line)
    }

    /// ピース `i` の中の `[lo, hi)`（ピースの中の行とバイト）から始まる、最初（`backward` なら
    /// 最後）の一致。
    fn find_in_piece(
        &mut self,
        i: usize,
        lo: Pos,
        hi: Pos,
        backward: bool,
        cancelled: Cancelled,
    ) -> std::io::Result<Option<LargeMatch>> {
        let piece = self.table.pieces()[i].clone();
        let doc_start = self.starts[i];
        match piece {
            Piece::Source { start, count } => {
                let lo_abs = self.src_byte(start + lo.0)? + lo.1;
                let hi_abs = if hi.0 >= count {
                    self.src_byte(start + count)?
                } else {
                    self.src_byte(start + hi.0)? + hi.1
                };
                if lo_abs >= hi_abs {
                    return Ok(None);
                }
                let search: FindFn<File> = if backward {
                    find_backward
                } else {
                    find_forward
                };
                let found = search(
                    &mut self.file,
                    self.matcher,
                    lo_abs,
                    hi_abs,
                    self.size,
                    cancelled,
                )?;
                let Some((a, b)) = found else {
                    return Ok(None);
                };
                let mut m = locate_match(&mut self.file, &self.index, self.encoding, a, b)?;
                m.line = doc_start + (m.line - start);
                Ok(Some(m))
            }
            added @ Piece::Added { .. } => Ok(find_in_added(
                added.added(),
                &self.matcher.text,
                doc_start,
                lo,
                hi,
                backward,
            )),
        }
    }

    /// ピース `i` の一致の数（`limit` で打ち切る）。止められたら `None`。
    fn count_in_piece(
        &mut self,
        i: usize,
        limit: u64,
        cancelled: Cancelled,
    ) -> std::io::Result<Option<u64>> {
        match self.table.pieces()[i].clone() {
            Piece::Source { start, count } => {
                let lo = self.src_byte(start)?;
                let hi = self.src_byte(start + count)?;
                count_matches(&mut self.file, self.matcher, lo, hi, limit, cancelled)
            }
            added @ Piece::Added { .. } => Ok(Some(
                added
                    .added()
                    .iter()
                    .map(|l| self.matcher.text.find_iter(l).count() as u64)
                    .sum::<u64>()
                    .min(limit),
            )),
        }
    }
}

/// 編集で入れた行 `text`（文書の行 `line`）の中の一致の位置。
fn added_match(text: &str, line: u64, m: regex::Match) -> LargeMatch {
    LargeMatch {
        line,
        col: text[..m.start()].encode_utf16().count() as u64,
        len: m.as_str().encode_utf16().count() as u64,
        byte: m.start() as u64,
        byte_end: m.end() as u64,
    }
}

/// 編集で入れた行の中の一致。範囲はピースの中の `[lo, hi)`（行と、その行の UTF-8 のバイト）。
fn find_in_added(
    lines: &[String],
    re: &regex::Regex,
    doc_start: u64,
    lo: Pos,
    hi: Pos,
    backward: bool,
) -> Option<LargeMatch> {
    // 入れた行のピースは空にしない（`Piece::Added`）。
    let last = (hi.0 as usize).min(lines.len() - 1);
    let region = |k: usize| -> (usize, usize) {
        let text = &lines[k];
        let from = if k as u64 == lo.0 { lo.1 as usize } else { 0 };
        let to = if k as u64 == hi.0 {
            hi.1 as usize
        } else {
            text.len()
        };
        (from.min(text.len()), to.min(text.len()))
    };
    let to_match = |k: usize, m: regex::Match| added_match(&lines[k], doc_start + k as u64, m);
    let ks: Box<dyn Iterator<Item = usize>> = if backward {
        Box::new((lo.0 as usize..=last).rev())
    } else {
        Box::new(lo.0 as usize..=last)
    };
    for k in ks {
        let (from, to) = region(k);
        let text = &lines[k];
        let m = if backward {
            re.find_iter(text)
                .filter(|m| m.start() >= from && m.start() < to)
                .last()
        } else {
            // 起点が文字の途中なら、次の文字の境目から探す。
            let from = (from..=text.len())
                .find(|&i| text.is_char_boundary(i))
                .unwrap_or(text.len());
            re.find_at(text, from).filter(|m| m.start() < to)
        };
        if let Some(m) = m {
            return Some(to_match(k, m));
        }
    }
    None
}

/// 起点から文書の端まで探し、無ければ反対の端から起点まで回り込む（`large_file_find` の中身）。
/// 止められた検索は「見つからない」と区別して `CANCELLED` のエラーで返す（後から届いた古い結果で、
/// 新しい一致を消さないように）。
fn search_doc(
    doc: &LargeDoc,
    matcher: &Matcher,
    from: Pos,
    backward: bool,
    cancelled: Cancelled,
) -> Result<Option<LargeMatch>, String> {
    let mut view = SearchView::open(doc, matcher)?;
    let n = view.table.pieces().len();
    let (si, start) = match view.table.locate(from.0) {
        Some((i, off)) => (i, (off, from.1)),
        None => (0, (0, 0)),
    };
    let end_of = |view: &SearchView, i: usize| (view.table.pieces()[i].len(), 0);
    let mut passes = Vec::new();
    if backward {
        for i in (0..=si).rev() {
            let hi = if i == si { start } else { end_of(&view, i) };
            passes.push((i, (0, 0), hi));
        }
        for i in (si..n).rev() {
            let lo = if i == si { start } else { (0, 0) };
            passes.push((i, lo, end_of(&view, i)));
        }
    } else {
        for i in si..n {
            let lo = if i == si { start } else { (0, 0) };
            passes.push((i, lo, end_of(&view, i)));
        }
        for i in 0..=si {
            let hi = if i == si { start } else { end_of(&view, i) };
            passes.push((i, (0, 0), hi));
        }
    }
    for (i, lo, hi) in passes {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        let found = view
            .find_in_piece(i, lo, hi, backward, cancelled)
            .map_err(|e| e.to_string())?;
        if found.is_some() {
            return Ok(found);
        }
    }
    if cancelled() {
        return Err(CANCELLED.into());
    }
    Ok(None)
}

/// 文書の一致の数（`MAX_COUNT` で打ち切る）。止められたら `None`（`large_file_count` の中身）。
fn count_doc(
    doc: &LargeDoc,
    matcher: &Matcher,
    cancelled: Cancelled,
) -> Result<Option<(u64, bool)>, String> {
    let mut view = SearchView::open(doc, matcher)?;
    let mut total = 0;
    for i in 0..view.table.pieces().len() {
        let Some(n) = view
            .count_in_piece(i, MAX_COUNT - total, cancelled)
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        total += n;
        if total >= MAX_COUNT {
            return Ok(Some((MAX_COUNT, true)));
        }
    }
    Ok(Some((total, false)))
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
        // 数えるのも索引を作り終えた範囲（`SearchView`）。作っている途中なら途中までの数で、
        // フロントは作り終えてから数え直す。
        let matcher = build_matcher(&query, case_sensitive, doc.encoding)?;
        let cancelled = || doc.count_generation.load(Ordering::Relaxed) != generation;
        let counted = count_doc(&doc, &matcher, &cancelled)?;
        Ok(counted.map(|(count, truncated)| LargeCount { count, truncated }))
    })
    .await
}

// ── 検索結果の一覧（#630） ──────────────────────────────────────────

/// 一覧に積む一致の上限。**一覧は一致へ移るためのもの**で、これを超える一致は検索語を
/// 絞ってもらう（件数そのものは `large_file_count` が `MAX_COUNT` まで数える）。1 件は文脈込みで
/// 数百バイトなので、上限まで積んでも Rust とフロントでそれぞれ数 MB に収まる。
const MAX_HITS: usize = 10_000;
/// `large_file_search_poll` が 1 回に返す最大の件数（IPC の 1 回を大きくしない）。
const HITS_PER_POLL: usize = 2_000;
/// 一致の前後に添える文脈（文字数）。
const CONTEXT_BEFORE: usize = 40;
const CONTEXT_AFTER: usize = 80;
/// 文脈を切り出すときに一致の前後で見るバイト数（文字数の 4 倍。UTF-8 の 1 文字は最大 4 バイト）。
const CONTEXT_BYTES: usize = CONTEXT_AFTER * 4;

/// 一覧の 1 件。位置は `LargeMatch` と同じで、文脈は一致の前・一致・後ろ。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LargeHit {
    #[serde(flatten)]
    pub at: LargeMatch,
    pub before: String,
    pub text: String,
    pub after: String,
}

#[derive(Default)]
struct HitList {
    generation: u64,
    /// 見つけて、まだフロントへ渡していない分（渡した分は持ち続けない）。
    hits: Vec<LargeHit>,
    /// これまでに見つけた数（渡した分を含む）。
    found: usize,
    done: bool,
    truncated: bool,
    error: Option<String>,
}

/// 一覧の続き。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LargeHits {
    /// 前の問い合わせから後に見つけた一致（最大 `HITS_PER_POLL` 件）。
    pub hits: Vec<LargeHit>,
    /// これまでに見つけた数。
    pub total: usize,
    pub done: bool,
    /// `MAX_HITS` で打ち切った。
    pub truncated: bool,
    pub error: Option<String>,
}

/// 検索を裏で始め、世代を返す。前の検索は止まる。見つけた分は `large_file_search_poll` で取る。
#[tauri::command]
pub fn large_file_search_start(
    state: State<'_, LargeFileState>,
    id: String,
    query: String,
    case_sensitive: bool,
) -> Result<u64, String> {
    let doc = state.get(&id)?;
    let matcher = build_matcher(&query, case_sensitive, doc.encoding)?;
    let generation = doc.hits_generation.fetch_add(1, Ordering::Relaxed) + 1;
    *doc.hits.lock().map_err(|e| e.to_string())? = HitList {
        generation,
        done: query.is_empty(),
        ..HitList::default()
    };
    if !query.is_empty() {
        std::thread::spawn(move || run_hit_search(&doc, &matcher, generation));
    }
    Ok(generation)
}

/// 見つけた分のうち、まだ渡していないものを返す（渡した分は手放す）。世代が違えば（新しい検索に
/// 置き換わった）空で返す。
#[tauri::command]
pub fn large_file_search_poll(
    state: State<'_, LargeFileState>,
    id: String,
    generation: u64,
) -> Result<LargeHits, String> {
    let doc = state.get(&id)?;
    let mut list = doc.hits.lock().map_err(|e| e.to_string())?;
    if list.generation != generation {
        return Ok(LargeHits {
            done: true,
            ..LargeHits::default()
        });
    }
    let n = list.hits.len().min(HITS_PER_POLL);
    Ok(LargeHits {
        hits: list.hits.drain(..n).collect(),
        total: list.found,
        done: list.done,
        truncated: list.truncated,
        error: list.error.clone(),
    })
}

/// 世代 `generation` の検索がまだ今の検索なら止める（一覧を閉じた・問い合わせを消した）。世代を
/// 指定するのは、始めるのを待っているあいだに止められた検索を、後から始まった別の検索を巻き込まずに
/// 止めるため。
#[tauri::command]
pub fn large_file_search_stop(
    state: State<'_, LargeFileState>,
    id: String,
    generation: u64,
) -> Result<(), String> {
    let _ = state.get(&id)?.hits_generation.compare_exchange(
        generation,
        generation + 1,
        Ordering::Relaxed,
        Ordering::Relaxed,
    );
    Ok(())
}

/// 裏のスレッドの中身。ピースを先頭から順に探し、見つけた分を `hits` へ積む。
fn run_hit_search(doc: &LargeDoc, matcher: &Matcher, generation: u64) {
    let cancelled = || doc.hits_generation.load(Ordering::Relaxed) != generation;
    // 見つけた分を積む。世代が変わっていたら積まない。上限に届いたら `false`（止める）。
    let push = |batch: Vec<LargeHit>| -> bool {
        let Ok(mut list) = doc.hits.lock() else {
            return false;
        };
        if list.generation != generation {
            return false;
        }
        let take = batch.len().min(MAX_HITS - list.found);
        list.hits.extend(batch.into_iter().take(take));
        list.found += take;
        if list.found >= MAX_HITS {
            list.truncated = true;
            return false;
        }
        true
    };
    let result = collect_doc_hits(doc, matcher, &cancelled, &push);
    if let Ok(mut list) = doc.hits.lock()
        && list.generation == generation
    {
        list.done = true;
        if let Err(e) = result {
            list.error = Some(e);
        }
    }
}

/// 文書の一致を先頭から順に集め、窓 1 つ（入れた行のピースなら 1 つ）ごとに `push` へ渡す。
/// `push` が `false` を返すか、止められたら終わる。
fn collect_doc_hits(
    doc: &LargeDoc,
    matcher: &Matcher,
    cancelled: Cancelled,
    push: &dyn Fn(Vec<LargeHit>) -> bool,
) -> Result<(), String> {
    let mut view = SearchView::open(doc, matcher)?;
    let pieces = view.table.pieces().to_vec();
    for (i, piece) in pieces.iter().enumerate() {
        if cancelled() {
            return Ok(());
        }
        let doc_start = view.starts[i];
        let go_on = match piece {
            Piece::Source { start, count } => {
                let lo = view.src_byte(*start).map_err(|e| e.to_string())?;
                let hi = view.src_byte(start + count).map_err(|e| e.to_string())?;
                collect_source_hits(
                    &mut view.file,
                    matcher,
                    (lo, hi),
                    doc_start,
                    cancelled,
                    push,
                )
                .map_err(|e| e.to_string())?
            }
            added @ Piece::Added { .. } => {
                push(added_hits(added.added(), &matcher.text, doc_start))
            }
        };
        if !go_on {
            return Ok(());
        }
    }
    Ok(())
}

/// 元のファイルの `[lo, hi)`（`lo` は行頭で、文書の行 `first_line`）の一致を、行と文脈を付けて
/// 集める。行は窓を前から読みながら改行を数えて求める（一致ごとに索引から引き直さない）。列も
/// 同じ行の中では前の一致からの差分を足していく（一致ごとに行頭から数え直すと、長い 1 行に一致が
/// 並んだとき、一致の数 × 行の長さを読む）。
fn collect_source_hits<R: Read + Seek>(
    source: &mut R,
    matcher: &Matcher,
    range: (u64, u64),
    first_line: u64,
    cancelled: Cancelled,
    push: &dyn Fn(Vec<LargeHit>) -> bool,
) -> std::io::Result<bool> {
    let enc = matcher.encoding;
    let mut at = LineCursor {
        line: first_line,
        line_start: range.0,
        counted: range.0,
        col_from: range.0,
        col: 0,
    };
    scan_windows(source, matcher, range, cancelled, |w| {
        let window = w.bytes;
        let mut batch = Vec::with_capacity(w.matches.len());
        // 窓の中で文字の境目と分かっている最後の位置（窓の先頭・一致の末尾）。
        let mut boundary = (at.counted - w.pos) as usize;
        for &(ms, me) in w.matches {
            let abs = w.pos + ms as u64;
            at.advance(w, abs);
            let col = at.col_at(w, abs, enc);
            let line_start = at.line_start;
            // 文脈は窓の中から切り出す。前の文脈は窓の先頭で切れることがある（4MB に 1 回で、
            // そのために前の窓を持ち越すほどではない）。
            let line_rel = line_start.saturating_sub(w.pos) as usize;
            let mut ctx_from = ms.saturating_sub(CONTEXT_BYTES).max(line_rel);
            if !matcher.is_utf8() {
                // 2 バイトの文字の後ろのバイトから読むと、以降の文字が 1 バイトずれて化ける。
                // 境目と分かっている位置から歩いて、文字の境目に合わせる（歩くのは一致と一致の
                // あいだだけなので、窓 1 枚で合わせて窓の長さまで）。
                let mut i = boundary.max(line_rel);
                while i < ctx_from {
                    i += sjis_char_len(window[i]);
                }
                ctx_from = i.min(ms);
            }
            boundary = me;
            let line_end = memchr::memchr(b'\n', &window[me..]).map_or(window.len(), |n| me + n);
            let ctx_to = line_end.min(me + CONTEXT_BYTES);
            batch.push(hit_from_parts(
                LargeMatch {
                    line: at.line,
                    col,
                    len: utf16_len(&window[ms..me], enc),
                    byte: abs - line_start,
                    byte_end: w.pos + me as u64 - line_start,
                },
                &window[ctx_from..ms],
                &window[ms..me],
                &window[me..ctx_to],
                enc,
            ));
        }
        if !batch.is_empty() && !push(batch) {
            return false;
        }
        // 次の窓の先頭まで改行と列を進めておく。UTF-8 の窓の境目は文字の途中に来るので、列は
        // その文字の終わり（重ねて読んだ部分の中）まで進める。割れた文字を両側でデコードすると、
        // U+FFFD として 2 度数える。
        let mut carry = (w.next - w.pos) as usize;
        if matcher.is_utf8() {
            while carry < window.len() && window[carry] & 0xC0 == 0x80 {
                carry += 1;
            }
        }
        let carry = w.pos + carry as u64;
        at.advance(w, carry);
        at.col_at(w, carry, enc);
        true
    })
}

/// `collect_source_hits` が窓を進みながら持つ位置。`counted` までの改行を数え終えていて、その時点の
/// 行が `line`、行頭が `line_start`。`col_from` の列が `col`（同じ行の中でだけ意味を持つ）。
struct LineCursor {
    line: u64,
    line_start: u64,
    counted: u64,
    col_from: u64,
    col: u64,
}

impl LineCursor {
    /// 窓の中の `to`（`counted` 以後）まで改行を数える。
    fn advance(&mut self, w: &ScanWindow, to: u64) {
        if to <= self.counted {
            return;
        }
        let rel = (self.counted - w.pos) as usize;
        let seg = &w.bytes[rel..((to - w.pos) as usize).min(w.bytes.len())];
        self.line += memchr::memchr_iter(b'\n', seg).count() as u64;
        if let Some(n) = memchr::memrchr(b'\n', seg) {
            self.line_start = w.pos + (rel + n + 1) as u64;
            self.col_from = self.line_start;
            self.col = 0;
        }
        self.counted = to;
    }

    /// 窓の中の `to`（今の行の中）の列。表示は `MAX_LINE_BYTES` で切るので、その後ろは
    /// `COL_BEYOND_CUT`（`locate_match` と同じ）。そこから先は列を追わない。
    fn col_at(&mut self, w: &ScanWindow, to: u64, encoding: &'static Encoding) -> u64 {
        if to - self.line_start > MAX_LINE_BYTES as u64 {
            return COL_BEYOND_CUT;
        }
        if to <= self.col_from {
            return self.col;
        }
        // 切る位置より手前なら、`col_from` は前の窓の末尾まで進めてあるので窓の中にある。
        let from = (self.col_from - w.pos) as usize;
        let to_rel = ((to - w.pos) as usize).min(w.bytes.len());
        // 表示と同じデコード（`utf16_len`）で数える。不正なバイトも画面と同じ数になる。
        self.col += utf16_len(&w.bytes[from..to_rel], encoding);
        self.col_from = to;
        self.col
    }
}

/// 編集で入れた行の一致。
fn added_hits(lines: &[String], re: &regex::Regex, doc_start: u64) -> Vec<LargeHit> {
    let mut out = Vec::new();
    for (k, text) in lines.iter().enumerate() {
        for m in re.find_iter(text) {
            out.push(LargeHit {
                at: added_match(text, doc_start + k as u64, m),
                before: tail_chars(&text[..m.start()], CONTEXT_BEFORE),
                text: m.as_str().to_owned(),
                after: text[m.end()..].chars().take(CONTEXT_AFTER).collect(),
            });
        }
    }
    out
}

/// 位置とバイト列の文脈から 1 件を作る。切り出した端で割れた文字（U+FFFD）は落とす。
fn hit_from_parts(
    at: LargeMatch,
    before: &[u8],
    text: &[u8],
    after: &[u8],
    encoding: &'static Encoding,
) -> LargeHit {
    let decode = |b: &[u8]| decode_line(b, encoding);
    let before = decode(before);
    let after = decode(after);
    LargeHit {
        at,
        before: tail_chars(before.trim_start_matches('\u{FFFD}'), CONTEXT_BEFORE),
        text: decode(text),
        after: after
            .trim_end_matches('\u{FFFD}')
            .trim_end_matches('\r')
            .chars()
            .take(CONTEXT_AFTER)
            .collect(),
    }
}

/// 末尾の `n` 文字。
fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
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
    blocking(move || refresh_doc(&doc)).await
}

/// `large_file_refresh` の中身。**編集は捨てる**: フロントがこれを呼ぶのは、未保存の変更が無い
/// とき（外部変更の自動の読み直し）か、変更を捨てると確かめたあと（「再読み込み」）だけ
/// （`EditorTab` の外部変更の扱い。`editor.md` の「保存の責任」）。**編集を捨てたら、ファイルの
/// 変わり方に関わらず `Reset` を返す**（フロントは読んだ行を全部捨てて読み直す。追記の
/// `Appended` では末尾のブロックしか捨てないので、編集した行が画面に残る）。
fn refresh_doc(doc: &Arc<LargeDoc>) -> Result<RefreshKind, String> {
    let discarded = {
        let mut history = doc.history.lock().map_err(|e| e.to_string())?;
        // 保存と重ならないよう、`saving` は履歴のロックの中で見る（`save_doc`）。
        if doc.saving.load(Ordering::Relaxed) {
            return Ok(RefreshKind::Unchanged);
        }
        history.take().is_some()
    };
    let kind = reindex_if_changed(doc)?;
    Ok(if discarded { RefreshKind::Reset } else { kind })
}

fn reindex_if_changed(doc: &Arc<LargeDoc>) -> Result<RefreshKind, String> {
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
            s.reset(new_size);
        } else {
            s.size = new_size;
            s.done = false;
            s.error = None;
        }
        (kind, doc.generation.fetch_add(1, Ordering::Relaxed) + 1)
    };
    restart_indexer(doc, generation);
    Ok(kind)
}

impl IndexState {
    /// 索引を最初から作り直す状態にする（書き換えを拾ったときと、保存のあと）。
    fn reset(&mut self, size: u64) {
        *self = IndexState {
            index: LineIndex::new(),
            size,
            done: false,
            error: None,
            mtime: None,
            tail: Vec::new(),
        };
    }
}

/// 状態を書き換えたロック（`generation` はその中で進めた値）を放したあと、索引のスレッドを立てる。
///
/// **行を読むハンドルは毎回開き直す**（追記でも）。古い中身に書き足した一時ファイルを rename で
/// 差し替える書き方は、末尾が同じなので追記に見える。索引と検索はパスで開き直すので新しい
/// ファイルを読むが、持っているハンドルは古いファイルを指したままになる。状態のロックを
/// 放してから捨てる（行を読んでいるあいだ `lines_file` は握られていて、待つと進み具合の
/// 問い合わせまで止まる）。
fn restart_indexer(doc: &Arc<LargeDoc>, generation: u64) {
    if let Ok(mut slot) = doc.lines_file.lock() {
        *slot = None;
    }
    spawn_indexer(doc, generation);
}

/// 索引を作り終えるまでと、保存のあいだは編集できない。
const NOT_EDITABLE: &str = "The file cannot be edited until indexing finishes";
const SAVING: &str = "The file is being saved";

/// 編集の履歴を触る（編集・取り消し・やり直し）。編集できる状態かを確かめ、最初の編集の前に
/// 今の行数で履歴を作り直す（`LargeDoc::history` の doc）。
///
/// **`saving` は履歴のロックを握ったまま見る。** `save_doc` も同じロックの中で `saving` を立てて
/// 文書を写すので、保存が写したあとに編集が入って、ファイルにも履歴にも残らないことが無い。
fn with_history(doc: &LargeDoc, f: impl FnOnce(&mut History)) -> Result<LargeFileStatus, String> {
    {
        let mut history = doc.history.lock().map_err(|e| e.to_string())?;
        if doc.saving.load(Ordering::SeqCst) {
            return Err(SAVING.into());
        }
        let lines = {
            let s = doc.state.read().map_err(|e| e.to_string())?;
            if !s.done {
                return Err(NOT_EDITABLE.into());
            }
            s.index.lines()
        };
        f(history.get_or_insert_with(|| History::new(lines)));
    }
    doc_status(doc)
}

/// 文書の行 `start` から `delete` 行を `insert` の行で置き換える。
#[tauri::command]
pub async fn large_file_edit(
    state: State<'_, LargeFileState>,
    id: String,
    start: u64,
    delete: u64,
    insert: Vec<String>,
) -> Result<LargeFileStatus, String> {
    let doc = state.get(&id)?;
    // 貼り付けた行の大きさに上限は無いので、メインスレッドで動かさない（`rust.md` の基本方針）。
    blocking(move || with_history(&doc, |h| h.edit(start, delete, insert))).await
}

#[tauri::command]
pub async fn large_file_undo(
    state: State<'_, LargeFileState>,
    id: String,
) -> Result<LargeFileStatus, String> {
    let doc = state.get(&id)?;
    blocking(move || with_history(&doc, History::undo)).await
}

#[tauri::command]
pub async fn large_file_redo(
    state: State<'_, LargeFileState>,
    id: String,
) -> Result<LargeFileStatus, String> {
    let doc = state.get(&id)?;
    blocking(move || with_history(&doc, History::redo)).await
}

/// 保存できないときのエラー。開いたあとにファイルが（末尾への追記ではなく）書き換えられた。
/// 元の行はファイルから読むので、書き換えられたあとに書き出すと、別の中身が混ざる。
const SOURCE_CHANGED: &str =
    "The file was changed outside Pike after it was opened. Reload it before saving.";

/// 保存できないときのエラー。書き換えた行に、ファイルの文字コードで表せない文字がある。
const UNMAPPABLE: &str =
    "An edited line has characters that cannot be written in the file's encoding.";

/// 保存する。一時ファイルへ書き出してから置き換える。置き換えたファイルの索引は書きながら作る。
#[tauri::command]
pub async fn large_file_save(state: State<'_, LargeFileState>, id: String) -> Result<(), String> {
    let doc = state.get(&id)?;
    blocking(move || save_doc(&doc)).await
}

/// `large_file_save` の中身。
///
/// - **書き出す前に、元のファイルが開いたとき（索引を作ったとき）のままかを確かめる**。元の行は
///   保存のときにファイルから写すので、書き換えられていたら別の中身が混ざる。末尾への追記なら
///   元の行はそのままなので保存できる（追記された部分は文書に入っていないので、書き出すと消える。
///   外部変更の警告の「上書き」と同じ意味になる）
/// - **一時ファイルに書いてから rename で置き換える**（途中で落ちても書きかけのファイルが残らない）。
///   symlink はリンク先へ書き、元の権限を写す。ホストのファイルは `replace_host_atomic`、WSL の
///   ファイルは `replace_in_wsl`（UNC 越しの `std::fs` では WSL の symlink を辿れず、mode も写せない）
/// - 元のファイルの行は改行ごとバイトのまま写す（改行コードも文字コードも変えない）。編集で入れた
///   行は開いたときの文字コードと改行（`eol`）で書く。その文字コードで表せない文字があれば断る
///   （`UNMAPPABLE`。encoding_rs は `&#NNNN;` に置き換えて書く）
/// - **置き換えたファイルの索引は、書きながら作る**（`IndexingWriter`）。読み直すと、1GB を書いた
///   あとに同じ 1GB をもう一度読むことになり、そのあいだ編集もできない
/// - **`saving` は履歴のロックの中で立て、同じロックの中で文書を写す**（`with_history` の doc）
fn save_doc(doc: &Arc<LargeDoc>) -> Result<(), String> {
    let table = {
        let history = doc.history.lock().map_err(|e| e.to_string())?;
        if doc.saving.swap(true, Ordering::SeqCst) {
            return Err(SAVING.into());
        }
        history.as_ref().map(|h| h.current().clone())
    };
    let result = write_doc(doc, table);
    if let Ok(written) = &result {
        // 置き換えたファイルが新しい文書。元のファイルの行の位置と編集の履歴はもう使えない。
        if let Ok(mut history) = doc.history.lock() {
            *history = None;
        }
        let mtime = std::fs::metadata(&doc.path)
            .ok()
            .and_then(|m| m.modified().ok());
        if let Ok(mut s) = doc.state.write() {
            // 走っている索引のスレッドは無い（索引を作り終えてから保存する）が、念のため止める。
            doc.generation.fetch_add(1, Ordering::Relaxed);
            *s = IndexState {
                index: written.index.clone(),
                size: written.index.scanned,
                done: true,
                error: None,
                mtime,
                tail: written.tail.clone(),
            };
        }
        if let Ok(mut slot) = doc.lines_file.lock() {
            *slot = None;
        }
    }
    doc.saving.store(false, Ordering::SeqCst);
    result.map(|_| ())
}

/// 書き出したファイルの索引と末尾（`IndexingWriter` が書きながら作る）。
struct Written {
    index: LineIndex,
    tail: Vec<u8>,
}

/// 書き出す。`table` は保存を始めたときの文書（`None` なら編集していない＝元のファイルそのもの）。
fn write_doc(doc: &LargeDoc, table: Option<PieceTable>) -> Result<Written, String> {
    let (index, size, tail) = {
        let s = doc.state.read().map_err(|e| e.to_string())?;
        if !s.done {
            return Err(NOT_EDITABLE.into());
        }
        (s.index.clone(), s.size, s.tail.clone())
    };
    let table = table.unwrap_or_else(|| PieceTable::pristine(index.lines()));
    let mut src = File::open(&doc.path).map_err(|e| e.to_string())?;
    let now = src.metadata().map_err(|e| e.to_string())?.len();
    if now < size || read_tail(&mut src, size).map_err(|e| e.to_string())? != tail {
        return Err(SOURCE_CHANGED.into());
    }
    let write = |tmp: &std::path::Path| write_pieces(doc, &table, &index, size, &mut src, tmp);
    match doc.shell {
        ShellConfig::Wsl { .. } => replace_in_wsl(doc, write),
        _ => super::replace_host_atomic(&doc.path, write),
    }
}

/// WSL のファイルを置き換える。一時ファイルは UNC 越しに隣へ書き、置き換えは distro の中で行う
/// （`readlink -f` でリンク先を求め、`chmod --reference` で mode を写してから `mv`）。手順は
/// `write_bytes_atomic` の WSL の腕と同じ。
fn replace_in_wsl<T>(
    doc: &LargeDoc,
    write: impl FnOnce(&std::path::Path) -> std::io::Result<T>,
) -> Result<T, String> {
    let tmp_native = format!("{}.pike-{}.tmp", doc.native, std::process::id());
    let tmp_host = PathBuf::from(host_visible_path(&doc.shell, tmp_native.clone()));
    let written = write(&tmp_host).map_err(|e| e.to_string());
    let moved = written.and_then(|value| {
        let p = crate::types::bash_quote(&doc.native);
        let t = crate::types::bash_quote(&tmp_native);
        let script = format!(
            "set -e; d=$(readlink -f -- {p} 2>/dev/null) || d={p}; \
             [ -e \"$d\" ] && chmod --reference=\"$d\" -- {t} 2>/dev/null || :; \
             mv -f -- {t} \"$d\""
        );
        match doc.shell.run("bash", &["-c", &script])? {
            (0, _, _) => Ok(value),
            (_, _, stderr) => Err(format!("Failed to replace the file: {stderr}")),
        }
    });
    if moved.is_err() {
        let _ = std::fs::remove_file(&tmp_host);
    }
    moved
}

/// 書いたバイトから、新しいファイルの索引と末尾を作りながら書く。
struct IndexingWriter {
    out: std::io::BufWriter<File>,
    index: LineIndex,
    tail: Vec<u8>,
}

impl IndexingWriter {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        self.out.write_all(bytes)?;
        self.index.feed(bytes);
        self.tail.extend_from_slice(bytes);
        let keep = TAIL_LEN as usize;
        if self.tail.len() > keep * 2 {
            self.tail.drain(..self.tail.len() - keep);
        }
        Ok(())
    }

    /// 書き切ってディスクへ流し、索引と末尾を返す。
    fn finish(self) -> std::io::Result<Written> {
        let IndexingWriter {
            out,
            index,
            mut tail,
        } = self;
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        let keep = TAIL_LEN as usize;
        if tail.len() > keep {
            tail.drain(..tail.len() - keep);
        }
        Ok(Written { index, tail })
    }
}

/// ピースの並びを `tmp` へ書き出す。行と行のあいだにだけ改行を置く（文書の最後の行の後ろには
/// 置かない。元のファイルが改行で終わっていれば、最後の行は空の行として文書に入っている）。
fn write_pieces(
    doc: &LargeDoc,
    table: &PieceTable,
    index: &LineIndex,
    size: u64,
    src: &mut File,
    tmp: &std::path::Path,
) -> std::io::Result<Written> {
    let src_lines = index.lines();
    // 元の行の範囲（バイト）を先に求める。進み具合の分母にも書き出しにも使う。編集で入れた行は
    // 文字数で見積もる。
    let mut ranges = Vec::with_capacity(table.pieces().len());
    let mut total = 0u64;
    for p in table.pieces() {
        let range = match p {
            Piece::Source { start, count } => {
                let a = src_line_byte(&mut *src, index, size, *start)?;
                let b = src_line_byte(&mut *src, index, size, start + count)?;
                total += b - a;
                (a, b)
            }
            added @ Piece::Added { .. } => {
                total += added
                    .added()
                    .iter()
                    .map(|l| l.len() as u64 + 2)
                    .sum::<u64>();
                (0, 0)
            }
        };
        ranges.push(range);
    }
    doc.save_total.store(total, Ordering::Relaxed);
    doc.save_written.store(0, Ordering::Relaxed);
    let mut out = IndexingWriter {
        out: std::io::BufWriter::with_capacity(INDEX_BUF, File::create(tmp)?),
        index: LineIndex::new(),
        tail: Vec::new(),
    };
    let mut buf = vec![0u8; INDEX_BUF];
    let last = table.pieces().len().saturating_sub(1);
    // 直前に書いたものが改行で終わっていないか（次の行の前に改行が要るか）。
    let mut need_eol = false;
    for (i, (p, &(a, mut b))) in table.pieces().iter().zip(&ranges).enumerate() {
        if need_eol {
            out.write_all(doc.eol)?;
        }
        match p {
            Piece::Source { start, count } => {
                // 元のファイルの最後の行を含まない範囲は、最後の行の改行まで含む。
                let ends_with_eol = start + count < src_lines;
                if ends_with_eol && i == last {
                    b -= eol_len_before(src, b)?;
                }
                src.seek(SeekFrom::Start(a))?;
                let mut reader = Read::by_ref(src).take(b - a);
                loop {
                    let n = reader.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n])?;
                    doc.save_written.fetch_add(n as u64, Ordering::Relaxed);
                }
                need_eol = !ends_with_eol;
            }
            added @ Piece::Added { .. } => {
                for (k, line) in added.added().iter().enumerate() {
                    if k > 0 {
                        out.write_all(doc.eol)?;
                    }
                    let (bytes, _, unmappable) = doc.encoding.encode(line);
                    if unmappable {
                        return Err(std::io::Error::other(UNMAPPABLE));
                    }
                    out.write_all(&bytes)?;
                    doc.save_written
                        .fetch_add(line.len() as u64 + 2, Ordering::Relaxed);
                }
                need_eol = true;
            }
        }
    }
    out.finish()
}

/// `end` の直前の改行のバイト数（CRLF なら 2）。
fn eol_len_before(src: &mut File, end: u64) -> std::io::Result<u64> {
    if end < 2 {
        return Ok(end.min(1));
    }
    src.seek(SeekFrom::Start(end - 2))?;
    let mut two = [0u8; 2];
    src.read_exact(&mut two)?;
    Ok(if &two == b"\r\n" { 2 } else { 1 })
}

/// 閉じる。索引のスレッドと検索も止める。
#[tauri::command]
pub fn large_file_close(state: State<'_, LargeFileState>, id: String) -> Result<(), String> {
    if let Some(doc) = state.docs.lock().map_err(|e| e.to_string())?.remove(&id) {
        doc.generation.fetch_add(1, Ordering::Relaxed);
        doc.find_generation.fetch_add(1, Ordering::Relaxed);
        doc.count_generation.fetch_add(1, Ordering::Relaxed);
        doc.hits_generation.fetch_add(1, Ordering::Relaxed);
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

    /// ファイル全体の一致の数。
    fn count_all<R: Read + Seek>(
        source: &mut R,
        matcher: &Matcher,
        size: u64,
        cancelled: Cancelled,
    ) -> std::io::Result<Option<(u64, bool)>> {
        Ok(
            count_matches(source, matcher, 0, size, MAX_COUNT, cancelled)?
                .map(|n| (n, n >= MAX_COUNT)),
        )
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
            count_all(&mut cur, &re, size, &never).unwrap(),
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
            count_all(&mut cur, &backslash, size, &never).unwrap(),
            Some((1, false))
        );
        let a = build_matcher("a", false, encoding_rs::SHIFT_JIS).unwrap();
        assert_eq!(
            count_all(&mut cur, &a, size, &never).unwrap(),
            Some((1, false))
        );
        // 大文字小文字を畳んでも、「ア」が別のカタカナ（0x83 0x61）に当たらない。
        let (other, _, _) = encoding_rs::SHIFT_JIS.encode("ア");
        let mut swapped = other.to_vec();
        swapped[1] = 0x61;
        let ka = build_matcher("ア", false, encoding_rs::SHIFT_JIS).unwrap();
        let n = swapped.len() as u64;
        assert_eq!(
            count_all(&mut Cursor::new(&swapped[..]), &ka, n, &never).unwrap(),
            Some((0, false))
        );
    }

    #[test]
    fn shift_jis_rejected_candidates_do_not_hide_an_overlapping_match() {
        // 「ア」(83 41) + "AA"。1 バイト目からの "AA" は「ア」の 2 バイト目から始まる偽物で、
        // 本物は 2 バイト目から。
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("アAA");
        let size = bytes.len() as u64;
        let mut cur = Cursor::new(bytes.as_ref());
        let aa = build_matcher("AA", true, encoding_rs::SHIFT_JIS).unwrap();
        assert_eq!(
            count_all(&mut cur, &aa, size, &never).unwrap(),
            Some((1, false))
        );
        assert_eq!(
            find_forward(&mut cur, &aa, 0, size, size, &never).unwrap(),
            Some((2, 4))
        );
    }

    #[test]
    fn shift_jis_windows_start_on_a_char_boundary() {
        // "a" のあとに「ア」(83 41) を並べると、偶数の位置が 2 バイト目の `A` になる。窓の区切り
        // （`SEARCH_BUF`、偶数）も 2 バイト目に当たるが、そこを `A` と読まない。
        let mut bytes = vec![b'a'];
        while bytes.len() < SEARCH_BUF + 64 {
            bytes.extend_from_slice(&[0x83, 0x41]);
        }
        let size = bytes.len() as u64;
        let a = build_matcher("A", true, encoding_rs::SHIFT_JIS).unwrap();
        let mut cur = Cursor::new(&bytes[..]);
        assert_eq!(
            count_all(&mut cur, &a, size, &never).unwrap(),
            Some((0, false))
        );
        assert_eq!(
            find_forward(&mut cur, &a, 0, size, size, &never).unwrap(),
            None
        );
        assert_eq!(
            find_backward(&mut cur, &a, 0, size, size, &never).unwrap(),
            None
        );
    }

    #[test]
    fn count_does_not_recount_an_overlap_across_windows() {
        // 窓の区切りの 2 バイト手前から "ababa"。重ならずに数えると "aba" は 1 件。
        let mut bytes = vec![b'.'; SEARCH_BUF - 2];
        bytes.extend_from_slice(b"ababa");
        let size = bytes.len() as u64;
        let aba = build_matcher("aba", true, encoding_rs::UTF_8).unwrap();
        assert_eq!(
            count_all(&mut Cursor::new(&bytes[..]), &aba, size, &never).unwrap(),
            Some((1, false))
        );
    }

    fn wait_indexed(doc: &LargeDoc) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !doc.state.read().unwrap().done {
            assert!(std::time::Instant::now() < deadline, "indexing timed out");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// 一時ディレクトリに `bytes` のファイルを作って開き、索引を作り終えるまで待つ。
    fn open_temp(bytes: &[u8]) -> (Arc<LargeDoc>, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pike-large-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log.txt");
        std::fs::write(&path, bytes).unwrap();
        let doc = open_doc(
            ShellConfig::host_default(),
            path.to_string_lossy().into_owned(),
        )
        .unwrap();
        wait_indexed(&doc);
        (doc, path, dir)
    }

    fn strings(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| (*s).to_owned()).collect()
    }

    fn find(doc: &LargeDoc, q: &str, from: Pos, backward: bool) -> Option<(u64, u64, u64)> {
        let m = build_matcher(q, true, doc.encoding).unwrap();
        search_doc(doc, &m, from, backward, &never)
            .unwrap()
            .map(|m| (m.line, m.col, m.byte_end))
    }

    #[test]
    fn edits_read_search_and_save_through_the_piece_table() {
        let (doc, path, dir) = open_temp(b"l0\nl1\nl2\nl3\n");
        let status = with_history(&doc, |h| h.edit(1, 1, strings(&["X", "Y"]))).unwrap();
        assert!(status.dirty && status.can_undo);
        assert_eq!(status.lines, 6);
        assert_eq!(
            doc_lines(&doc, 0, 10).unwrap().lines,
            vec!["l0", "X", "Y", "l2", "l3", ""]
        );
        // 行番号は編集のあとの文書の行。元の行と入れた行の両方を探す。
        assert_eq!(find(&doc, "l3", (0, 0), false), Some((4, 0, 2)));
        assert_eq!(find(&doc, "Y", (0, 0), false), Some((2, 0, 1)));
        // 回り込み。
        assert_eq!(find(&doc, "X", (3, 0), false), Some((1, 0, 1)));
        assert_eq!(find(&doc, "l2", (2, 0), true), Some((3, 0, 2)));
        let m = build_matcher("l", true, doc.encoding).unwrap();
        assert_eq!(count_doc(&doc, &m, &never).unwrap(), Some((3, false)));

        save_doc(&doc).unwrap();
        let saved = std::fs::read(&path).unwrap();
        assert_eq!(saved, b"l0\nX\nY\nl2\nl3\n");
        // 書きながら作った索引は、書いたファイルを読み直して作る索引と同じ。
        {
            let s = doc.state.read().unwrap();
            assert!(s.done);
            let fresh = index_of(&saved, 3);
            assert_eq!(s.index.checkpoints, fresh.checkpoints);
            assert_eq!(s.index.lines(), fresh.lines());
            assert_eq!(s.size, saved.len() as u64);
            assert_eq!(s.tail, saved);
        }
        // 保存したあとの外部変更の見極めも効く（変わっていなければ何もしない）。
        assert_eq!(refresh_doc(&doc).unwrap(), RefreshKind::Unchanged);
        let status = doc_status(&doc).unwrap();
        assert!(!status.dirty && !status.can_undo);
        assert_eq!(
            doc_lines(&doc, 0, 10).unwrap().lines,
            vec!["l0", "X", "Y", "l2", "l3", ""]
        );
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_keeps_crlf_and_the_missing_final_newline() {
        let (doc, path, dir) = open_temp(b"a\r\nb\r\nc");
        with_history(&doc, |h| h.edit(1, 1, strings(&["B"]))).unwrap();
        save_doc(&doc).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a\r\nB\r\nc");
        wait_indexed(&doc);
        // 最後の行を消すと、手前の行の改行も残らない。
        with_history(&doc, |h| h.edit(2, 1, Vec::new())).unwrap();
        save_doc(&doc).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a\r\nB");
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn added_lines_are_written_in_the_file_encoding() {
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("日本\n語\n");
        let (doc, path, dir) = open_temp(&sjis);
        assert_eq!(doc.encoding, encoding_rs::SHIFT_JIS);
        with_history(&doc, |h| h.edit(1, 1, strings(&["エラー"]))).unwrap();
        assert_eq!(find(&doc, "エラー", (0, 0), false), Some((1, 0, 9)));
        save_doc(&doc).unwrap();
        let (expected, _, _) = encoding_rs::SHIFT_JIS.encode("日本\nエラー\n");
        assert_eq!(std::fs::read(&path).unwrap(), expected.as_ref());
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn undo_back_to_the_saved_version_is_not_dirty() {
        let (doc, _, dir) = open_temp(b"a\nb\n");
        with_history(&doc, |h| h.edit(0, 1, strings(&["A"]))).unwrap();
        let status = with_history(&doc, |h| {
            h.undo();
        })
        .unwrap();
        assert!(!status.dirty && status.can_redo);
        assert_eq!(doc_lines(&doc, 0, 10).unwrap().lines, vec!["a", "b", ""]);
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_refuses_a_file_rewritten_outside() {
        let (doc, path, dir) = open_temp(b"one\ntwo\n");
        with_history(&doc, |h| h.edit(0, 1, strings(&["ONE"]))).unwrap();
        std::fs::write(&path, b"uno\ndos\n").unwrap();
        assert_eq!(save_doc(&doc).unwrap_err(), SOURCE_CHANGED);
        // 書き換えは残り、編集もまだ持っている。
        assert_eq!(std::fs::read(&path).unwrap(), b"uno\ndos\n");
        assert!(doc_status(&doc).unwrap().dirty);
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_discards_edits_even_when_the_file_is_unchanged() {
        let (doc, _, dir) = open_temp(b"a\nb\n");
        with_history(&doc, |h| h.edit(0, 1, strings(&["A"]))).unwrap();
        assert_eq!(refresh_doc(&doc).unwrap(), RefreshKind::Reset);
        assert!(!doc_status(&doc).unwrap().dirty);
        assert_eq!(doc_lines(&doc, 0, 10).unwrap().lines, vec!["a", "b", ""]);
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discarding_edits_resets_even_when_the_file_was_appended() {
        let (doc, path, dir) = open_temp(b"a\nb\n");
        with_history(&doc, |h| h.edit(0, 1, strings(&["A"]))).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut f, b"c\n").unwrap();
        drop(f);
        assert_eq!(refresh_doc(&doc).unwrap(), RefreshKind::Reset);
        wait_indexed(&doc);
        assert_eq!(
            doc_lines(&doc, 0, 10).unwrap().lines,
            vec!["a", "b", "c", ""]
        );
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_refuses_characters_the_encoding_cannot_write() {
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("日本\n");
        let (doc, path, dir) = open_temp(&sjis);
        with_history(&doc, |h| h.edit(0, 1, strings(&["😀"]))).unwrap();
        assert_eq!(save_doc(&doc).unwrap_err(), UNMAPPABLE);
        assert_eq!(std::fs::read(&path).unwrap(), sjis.as_ref());
        assert!(doc_status(&doc).unwrap().dirty);
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edits_are_refused_while_saving() {
        let (doc, _, dir) = open_temp(b"a\n");
        doc.saving.store(true, Ordering::SeqCst);
        assert_eq!(
            with_history(&doc, |h| h.edit(0, 1, Vec::new())).unwrap_err(),
            SAVING
        );
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 一覧の検索を同じスレッドで最後まで回し、積んだ一覧を返す。
    fn hits_of(doc: &LargeDoc, q: &str) -> (Vec<LargeHit>, bool) {
        let m = build_matcher(q, true, doc.encoding).unwrap();
        let generation = doc.hits_generation.fetch_add(1, Ordering::Relaxed) + 1;
        *doc.hits.lock().unwrap() = HitList {
            generation,
            ..HitList::default()
        };
        run_hit_search(doc, &m, generation);
        let list = doc.hits.lock().unwrap();
        assert!(list.done && list.error.is_none());
        (list.hits.clone(), list.truncated)
    }

    fn lines_of(hits: &[LargeHit]) -> Vec<u64> {
        hits.iter().map(|h| h.at.line).collect()
    }

    #[test]
    fn hit_list_numbers_lines_across_windows() {
        // 窓（4MB）を何枚もまたぐファイル。`needle` の行番号が数え違わない。
        let mut text = String::new();
        let mut expected = Vec::new();
        for i in 0..200_000u64 {
            if i % 37_000 == 5 {
                text.push_str("before needle after\n");
                expected.push(i);
            } else {
                text.push_str("..........................\n");
            }
        }
        assert!(text.len() > SEARCH_BUF);
        let (doc, _, dir) = open_temp(text.as_bytes());
        let (hits, truncated) = hits_of(&doc, "needle");
        assert!(!truncated);
        assert_eq!(lines_of(&hits), expected);
        let h = &hits[0];
        assert_eq!((h.at.col, h.at.len), (7, 6));
        assert_eq!(
            (h.before.as_str(), h.text.as_str(), h.after.as_str()),
            ("before ", "needle", " after")
        );
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hit_list_columns_carry_across_windows() {
        // 窓の境目（`SEARCH_BUF`）の手前で始まる行の中に一致が 2 つ。列は境目をまたいで足していく。
        let filler = "........\n";
        let mut text = filler.repeat((SEARCH_BUF - 100) / filler.len());
        let first = text.len();
        text.push_str(&"あ".repeat(50));
        text.push_str("needle");
        text.push_str(&"b".repeat(30));
        text.push_str("needle\n");
        // 表示で切る長さより後ろの一致は、列を数えない。
        text.push_str(&"c".repeat(MAX_LINE_BYTES + 10));
        text.push_str("needle\n");
        assert!(first < SEARCH_BUF && first + 150 > SEARCH_BUF);
        let (doc, _, dir) = open_temp(text.as_bytes());
        let (hits, _) = hits_of(&doc, "needle");
        let line = (first / filler.len()) as u64;
        let at: Vec<_> = hits.iter().map(|h| (h.at.line, h.at.col)).collect();
        assert_eq!(at, vec![(line, 50), (line, 86), (line + 1, COL_BEYOND_CUT)]);
        assert_eq!(hits[1].at.byte, 150 + 6 + 30);
        // 前の文脈は窓の先頭で切れる（割れた文字は落とす）。
        assert!(hits[0].before.chars().all(|c| c == 'あ'));
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hit_list_context_of_shift_jis_starts_on_a_character() {
        // 一致の `CONTEXT_BYTES` 前が 2 バイトの文字の後ろのバイトに当たる並び。
        let line = format!("a{}bneedle\n", "あ".repeat(200));
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode(&line);
        let m = build_matcher("needle", true, encoding_rs::SHIFT_JIS).unwrap();
        let got = std::cell::RefCell::new(Vec::new());
        let push = |b: Vec<LargeHit>| {
            got.borrow_mut().extend(b);
            true
        };
        let mut cur = Cursor::new(bytes.as_ref());
        collect_source_hits(&mut cur, &m, (0, bytes.len() as u64), 0, &never, &push).unwrap();
        let hits = got.into_inner();
        assert_eq!(
            hits[0].before,
            format!("{}b", "あ".repeat(CONTEXT_BEFORE - 1))
        );
        assert_eq!(hits[0].at.col, 202);
    }

    #[test]
    fn hit_list_follows_the_edited_document() {
        let (doc, _, dir) = open_temp(b"a x\nb\nc x\n");
        with_history(&doc, |h| h.edit(1, 1, strings(&["new x", "y"]))).unwrap();
        let (hits, _) = hits_of(&doc, "x");
        // 文書は a x / new x / y / c x / ""。
        assert_eq!(lines_of(&hits), vec![0, 1, 3]);
        assert_eq!(hits[1].before, "new ");
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hit_list_stops_at_the_limit() {
        let (doc, _, dir) = open_temp("x\n".repeat(MAX_HITS + 5).as_bytes());
        let (hits, truncated) = hits_of(&doc, "x");
        assert!(truncated);
        assert_eq!(hits.len(), MAX_HITS);
        assert_eq!(hits.last().unwrap().at.line, MAX_HITS as u64 - 1);
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hit_list_of_a_replaced_search_is_not_written() {
        let (doc, _, dir) = open_temp(b"x\n");
        let m = build_matcher("x", true, doc.encoding).unwrap();
        // 世代 1 で始めた検索が、走り出す前に世代 2 に置き換わった。
        *doc.hits.lock().unwrap() = HitList {
            generation: 2,
            ..HitList::default()
        };
        doc.hits_generation.store(2, Ordering::Relaxed);
        run_hit_search(&doc, &m, 1);
        let list = doc.hits.lock().unwrap();
        assert!(list.hits.is_empty() && !list.done);
        drop(list);
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn context_is_cut_to_whole_characters() {
        let line = format!("{}needle{}", "あ".repeat(100), "い".repeat(200));
        let (doc, _, dir) = open_temp(line.as_bytes());
        let (hits, _) = hits_of(&doc, "needle");
        assert_eq!(hits[0].before, "あ".repeat(CONTEXT_BEFORE));
        assert_eq!(hits[0].after, "い".repeat(CONTEXT_AFTER));
        assert_eq!(hits[0].at.col, 100);
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edits_wait_for_the_index() {
        let (doc, _, dir) = open_temp(b"a\n");
        doc.state.write().unwrap().done = false;
        assert_eq!(
            with_history(&doc, |h| h.edit(0, 1, Vec::new())).unwrap_err(),
            NOT_EDITABLE
        );
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_reopens_the_line_handle_when_the_file_is_replaced_by_rename() {
        let dir = std::env::temp_dir().join(format!("pike-large-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log.txt");
        std::fs::write(&path, "a\nb\n").unwrap();
        let doc = open_doc(
            ShellConfig::host_default(),
            path.to_string_lossy().into_owned(),
        )
        .unwrap();
        wait_indexed(&doc);
        assert_eq!(doc_lines(&doc, 0, 10).unwrap().lines, vec!["a", "b", ""]);
        // 古い中身に書き足した一時ファイルで差し替える（末尾が同じなので追記に見える）。
        let tmp = dir.join("log.txt.tmp");
        std::fs::write(&tmp, "a\nb\nc\n").unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        assert_eq!(refresh_doc(&doc).unwrap(), RefreshKind::Appended);
        wait_indexed(&doc);
        assert_eq!(
            doc_lines(&doc, 0, 10).unwrap().lines,
            vec!["a", "b", "c", ""]
        );
        drop(doc);
        let _ = std::fs::remove_dir_all(&dir);
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
        assert_eq!(count_all(&mut cur, &re, 6, &|| true).unwrap(), None);
    }
}
