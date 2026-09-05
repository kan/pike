//! Fetching a web page's `<title>` so a pasted URL can become `[タイトル](url)` (#241).
//!
//! This is the one place in Pike that reaches an arbitrary host on the author's
//! behalf, so the policy differs from `remote_image` on purpose:
//!
//! - **Redirects are followed** (bounded). Short links and tracking wrappers are
//!   the normal case for a URL someone pastes, and there is no approved-host list
//!   here to keep meaningful — unlike the image fetch, where refusing to redirect
//!   is what makes the approval mean anything.
//! - **http is allowed as well as https.** The user pasted a link they could open
//!   in a browser from Pike already (`open_url` takes both), and intranet pages
//!   that are worth linking are often plain http.
//!
//! What guards this instead is the *trigger*: the front end only calls here when
//! the author pastes a URL into a Markdown document **and** has turned the
//! feature on, having been asked once with the network cost spelled out.
//!
//! Failure is not an error the author has to deal with — the URL is already in
//! the document, and a missing title just leaves it as it was. Every failure
//! path returns `Ok(None)`; `Err` is reserved for a URL that was never fetchable
//! (a bad scheme), which the caller treats the same way.
//!
//! 取得そのもの（プロバイダの用意・クライアントの使い回し・上限付き読み）は `http` に
//! ある。ここに残すのは HTML の読み方だけ。

use crate::http::{self, FetchPolicy, Partial, Redirects};
use std::time::Duration;

/// A title lives in `<head>`, so the first chunk of the document is enough. The
/// cap exists so a URL pointing at a huge file cannot stream into memory; a page
/// whose `<title>` is not in the first 512 KB is not worth waiting for.
const MAX_BYTES: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
/// Titles this long are not titles. Trimmed rather than rejected so a page with
/// a stuffed `<title>` still gives something usable.
const MAX_TITLE_CHARS: usize = 300;
/// `<title>` も `<meta charset>` も `<head>` にある。ページ全体を走査しても見つかるものは
/// 変わらないので、探す範囲をここで切る。
const HEAD_SCAN_BYTES: usize = 64 * 1024;

#[tauri::command]
pub async fn page_title_fetch(url: String) -> Result<Option<String>, String> {
    let policy = FetchPolicy {
        allow_http: true,
        redirects: Redirects::Follow,
        timeout: TIMEOUT,
        max_bytes: MAX_BYTES,
        // `<title>` は先頭にあるので、途中までしか読めなくても手元のぶんで足りる。
        partial: Partial::Keep,
    };
    // 取れないのは珍しくない（DNS、TLS、404、社内ホスト）。URL は既に文書へ入っているので、
    // どれも「タイトルが無かった」と同じ扱いでよい。
    let Ok(fetched) = http::fetch(&url, &policy).await else {
        return Ok(None);
    };
    // A PDF or an image has no `<title>` to find. An absent Content-Type is
    // treated as HTML: plenty of small servers omit it, and the parse below
    // simply finds nothing if it is not.
    if !fetched.mime.is_empty()
        && !fetched.mime.contains("text/html")
        && !fetched.mime.contains("application/xhtml")
    {
        return Ok(None);
    }
    Ok(extract_title(&fetched.body, fetched.charset.as_deref()))
}

/// Decode `bytes` and pull the `<title>` out of it.
///
/// **The charset matters here, not just for tidiness.** A Japanese page served as
/// Shift_JIS or EUC-JP decodes to mojibake under UTF-8, and that mojibake would
/// be written into the author's document as the link text.
///
/// 解決の順は BOM → ヘッダ → `<meta>` → UTF-8。BOM を最初に見るのは `fs/mod.rs` の
/// `decode_bytes` と同じ理由で、UTF-16 で配信されるページは `<meta>` すら ASCII として
/// 読めず、この段が無いと後ろの 2 つがどちらも効かない。
fn extract_title(bytes: &[u8], header_charset: Option<&str>) -> Option<String> {
    let encoding = encoding_rs::Encoding::for_bom(bytes)
        .map(|(enc, _)| enc)
        .or_else(|| header_charset.and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes())))
        .or_else(|| {
            meta_charset(bytes).and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes()))
        })
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    let cleaned = collapse_whitespace(&decode_entities(&title_text(&text)?));
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned.chars().take(MAX_TITLE_CHARS).collect())
}

/// `needle`（小文字で渡すこと）が現れる位置。ASCII の大小を無視する。
///
/// **`to_ascii_lowercase()` でコピーを作らないため**にある。素朴に書くと、タグ 1 つを
/// 探すために最大 512 KB の複製と全走査が発生する。
fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    h.windows(n.len()).position(|w| w.eq_ignore_ascii_case(n))
}

/// `<title>` の中身。開きタグは属性を持ちうる。
fn title_text(text: &str) -> Option<String> {
    // char 境界で切る（マルチバイトの途中で切ると panic する）。
    let limit = (0..=text.len().min(HEAD_SCAN_BYTES))
        .rev()
        .find(|i| text.is_char_boundary(*i))?;
    let head = &text[..limit];
    let start = find_ascii_ci(head, "<title")?;
    // Skip past the rest of the opening tag, attributes and all.
    let after_open = start + head[start..].find('>')? + 1;
    let end = find_ascii_ci(&head[after_open..], "</title>")? + after_open;
    Some(head[after_open..end].to_string())
}

/// The charset from `<meta charset=...>` or `<meta http-equiv="content-type" ...>`.
///
/// **最初に見つかった `charset` で打ち切らないこと。** HTML コメント・`data-charset`
/// 属性・`link rel=preload` のヒント・インライン JS の中の単語が先に来ることがあり、
/// そこで諦めると宣言を見落とす。見落とすと Shift_JIS / EUC-JP のページが UTF-8 として
/// 読まれ、この関数が防ぐはずの文字化けがそのまま起きる。
fn meta_charset(bytes: &[u8]) -> Option<String> {
    // The markup is ASCII in every encoding this has to handle, so a lossy pass
    // is enough to find the declaration.
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let mut at = 0;
    while let Some(found) = find_ascii_ci(&head[at..], "charset") {
        at += found + "charset".len();
        let Some(rest) = head[at..].trim_start().strip_prefix('=') else {
            continue;
        };
        let value: String = rest
            .trim_start()
            .trim_start_matches(['"', '\''])
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// タイトルに出てくる実体参照を戻す。
///
/// **数値参照（`&#8211;` / `&#x2019;`）は必ず扱う。** CMS が出す `<title>` には普通に
/// 入っていて（WordPress の `&#8211;`、PHP の `htmlspecialchars` が出す `&#039;`）、
/// 残すと `[Post Title &#8211; Site]` がそのまま文書に書き込まれる。ブラウザはこれを
/// 文字として描くので、「作者が書いたまま」にはならない。
///
/// **`&` を 1 回走査して片付ける。** 実体ごとに `replace` を重ねると、そのたびに文字列を
/// 作り直すうえ、`&amp;lt;` が `<` にならないよう「`&amp;` を最後に」という順序の縛りが
/// 生まれる。1 パスなら、戻した文字が次の判定に混ざらないので縛り自体が消える。
///
/// 名前付きは全表を持たない。タイトルに出るものだけを並べ、知らないものはそのまま残す。
fn decode_entities(s: &str) -> String {
    const NAMED: [(&str, char); 8] = [
        ("amp;", '&'),
        ("lt;", '<'),
        ("gt;", '>'),
        ("quot;", '"'),
        ("apos;", '\''),
        ("nbsp;", ' '),
        ("mdash;", '—'),
        ("ndash;", '–'),
    ];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let body = &rest[at + 1..];
        if let Some((c, tail)) = numeric_entity(body).or_else(|| named_entity(body, &NAMED)) {
            out.push(c);
            rest = tail;
        } else {
            // 実体参照ではなかった。`&` を残して次へ進む。
            out.push('&');
            rest = body;
        }
    }
    out.push_str(rest);
    out
}

/// `#8217;…` / `#x2019;…` → その文字と、後ろに続く残り。
fn numeric_entity(body: &str) -> Option<(char, &str)> {
    let digits = body.strip_prefix('#')?;
    let (radix, digits) = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => (16, hex),
        None => (10, digits),
    };
    let end = digits.find(';')?;
    let n = u32::from_str_radix(&digits[..end], radix).ok()?;
    Some((char::from_u32(n)?, &digits[end + 1..]))
}

/// `lt;…` → その文字と、後ろに続く残り。
fn named_entity<'a>(body: &'a str, table: &[(&str, char)]) -> Option<(char, &'a str)> {
    table
        .iter()
        .find_map(|(name, c)| body.strip_prefix(name).map(|tail| (*c, tail)))
}

/// Titles are often written across several lines in the source. Markdown link
/// text has to be one line, so runs of whitespace collapse to a single space.
///
/// **一行であることはこちらの保証**。フロント側で畳み直さずに済むよう、ここで済ませる。
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for word in s.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_plain_title() {
        let html = b"<html><head><title>Hello world</title></head>";
        assert_eq!(extract_title(html, None).as_deref(), Some("Hello world"));
    }

    /// 属性付きの開きタグと、複数行に散った本文。
    #[test]
    fn handles_attributes_and_line_breaks() {
        let html = b"<TITLE lang=\"en\">\n  Multi\n  line\n</TITLE>";
        assert_eq!(extract_title(html, None).as_deref(), Some("Multi line"));
    }

    #[test]
    fn decodes_the_entities_that_show_up_in_titles() {
        let html = b"<title>A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;</title>";
        assert_eq!(
            extract_title(html, None).as_deref(),
            Some("A & B <C> \"D\" 'E'")
        );
    }

    /// CMS の `<title>` に普通に入っている数値参照。残すと文書に生で書き込まれる。
    #[test]
    fn decodes_numeric_entities() {
        let html = "<title>Post &#8211; Site &#x2019;s &#039;quoted&#039;</title>".as_bytes();
        assert_eq!(
            extract_title(html, None).as_deref(),
            Some("Post – Site ’s 'quoted'")
        );
    }

    /// `&amp;lt;` は `&lt;` のまま。1 パスなので、戻した `&` が次の判定に混ざらない。
    #[test]
    fn does_not_double_decode() {
        let html = b"<title>&amp;lt;</title>";
        assert_eq!(extract_title(html, None).as_deref(), Some("&lt;"));
    }

    /// 実体参照に見えて違うもの。壊さずそのまま残す。
    #[test]
    fn leaves_non_entities_alone() {
        let html = "<title>C&#Sharp; and &#; and &#99 and A&B</title>".as_bytes();
        assert_eq!(
            extract_title(html, None).as_deref(),
            Some("C&#Sharp; and &#; and &#99 and A&B")
        );
    }

    /// ヘッダが charset を名乗るとき。UTF-8 として読むと化ける。
    #[test]
    fn uses_the_header_charset() {
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("日本語のページ");
        let mut html = b"<title>".to_vec();
        html.extend_from_slice(&bytes);
        html.extend_from_slice(b"</title>");
        assert_eq!(
            extract_title(&html, Some("shift_jis")).as_deref(),
            Some("日本語のページ")
        );
    }

    /// ヘッダに無ければ `<meta charset>` を見る。
    #[test]
    fn falls_back_to_the_meta_charset() {
        let (bytes, _, _) = encoding_rs::EUC_JP.encode("日本語");
        let mut html = b"<html><head><meta charset=\"euc-jp\"><title>".to_vec();
        html.extend_from_slice(&bytes);
        html.extend_from_slice(b"</title>");
        assert_eq!(extract_title(&html, None).as_deref(), Some("日本語"));
    }

    /// 先に別の `charset` という語があっても、本物の宣言まで走査を続ける。
    #[test]
    fn meta_charset_skips_decoys() {
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("日本語");
        let mut html =
            "<!-- charset note --><link rel=preload data-charset><meta charset=shift_jis><title>"
                .to_string()
                .into_bytes();
        html.extend_from_slice(&bytes);
        html.extend_from_slice(b"</title>");
        assert_eq!(extract_title(&html, None).as_deref(), Some("日本語"));
    }

    /// BOM が最優先。UTF-16 のページは `<meta>` すら ASCII として読めない。
    ///
    /// バイト列を手で組むのは、`encoding_rs` が **UTF-16 へエンコードできない**ため
    /// （Encoding Standard がエンコード先として認めていないので、`UTF_16LE.encode` は
    /// UTF-8 を返す）。デコード側は普通に扱える。
    #[test]
    fn bom_wins_over_the_header() {
        let mut html = vec![0xFF, 0xFE];
        for unit in "<title>日本語</title>".encode_utf16() {
            html.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(
            extract_title(&html, Some("shift_jis")).as_deref(),
            Some("日本語")
        );
    }

    #[test]
    fn no_title_is_not_an_error() {
        assert_eq!(
            extract_title(b"<html><body>no head</body></html>", None),
            None
        );
        assert_eq!(extract_title(b"<title>   </title>", None), None);
    }
}
