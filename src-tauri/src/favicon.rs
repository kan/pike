//! ブラウザのタブに出すサイトのアイコン（#400）。
//!
//! **ページ自身からは取れない。** 子 webview は capability の対象外なので、差し込んだ
//! スクリプトから `invoke` で知らせる経路が無い（`browser.rs` のモジュール doc）。
//! WebView2 には `FaviconChanged` があるが Windows 専用で、WKWebView に相当物が無い。
//! そこで、ページの HTML を取り直して `<link rel="icon">` を読み、画像を取ってくる。
//!
//! - **行き先は、利用者がそのタブで既に開いているホスト**なので、`page_title` の
//!   ような事前の確認は挟まない。取得にはページの Cookie を載せないので、ログインが要る
//!   サイトではログイン画面の HTML を読むことになるが、アイコンは同じことが多い
//! - 候補の順は「`rel="icon"` → `apple-touch-icon` → `/favicon.ico`」。先頭から取れたもの
//!   を使う。apple-touch-icon は 180px ほどあるので、`icon` を持たないサイトの代わりにだけ使う
//! - 失敗は全部 `Ok(None)`（アイコンが無ければ種別の地球儀のままでよい）

use reqwest::Url;
use std::time::Duration;

use crate::http::{self, FetchPolicy, Partial, Redirects, Target};
use crate::page_title::{decode_entities, find_ascii_ci};
use crate::remote_image::RemoteImage;

/// `<link>` は `<head>` にある。`page_title` の `HEAD_SCAN_BYTES` と同じ理由で、読むのも
/// 先頭のここまでにする（`Partial::Keep` なので途中で切れてよい）。
const HEAD_SCAN_BYTES: usize = 64 * 1024;
/// 14px で描くものなので大きな画像は要らない。複数解像度を詰めた `.ico` でも収まる程度。
const ICON_MAX_BYTES: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
/// 宣言された候補を試す上限（`/favicon.ico` はこの外）。壊れたリンクを並べたページで
/// 取得が延々と続かないように。
const MAX_TRIES: usize = 4;

#[tauri::command]
pub async fn browser_favicon(url: String) -> Result<Option<RemoteImage>, String> {
    let Ok(page_url) = Url::parse(&url) else {
        return Ok(None);
    };
    if !matches!(page_url.scheme(), "http" | "https") {
        return Ok(None);
    }
    let mut candidates: Vec<Url> = Vec::new();
    let add = |list: &mut Vec<Url>, u: Url| {
        if !list.contains(&u) {
            list.push(u);
        }
    };
    if let Ok(page) = http::fetch(page_url.as_str(), &policy(HEAD_SCAN_BYTES, Partial::Keep)).await
    {
        let base = Url::parse(&page.url).unwrap_or_else(|_| page_url.clone());
        for href in icon_hrefs(&String::from_utf8_lossy(&page.body)) {
            if let Some(img) = parse_data_url(&href) {
                return Ok(Some(img));
            }
            if let Ok(u) = base.join(&href) {
                add(&mut candidates, u);
            }
        }
    }
    // 宣言されたものは先頭から `MAX_TRIES` 件まで。**`/favicon.ico` はその外に必ず足す**:
    // 16px・32px・apple-touch-icon の各サイズと宣言を並べるページは多く、上限の内側に
    // 置くと、宣言がどれも取れない（ログイン画面へ飛ばされる）ときの逃げ道が消える。
    candidates.truncate(MAX_TRIES);
    if let Ok(u) = page_url.join("/favicon.ico") {
        add(&mut candidates, u);
    }

    // 候補は順に試す（並べて撃つと、先頭が取れるふつうの場合にも残りを全部取りに行く）。
    let icon_policy = policy(ICON_MAX_BYTES, Partial::Fail);
    for u in candidates {
        let Ok(fetched) = http::fetch(u.as_str(), &icon_policy).await else {
            continue;
        };
        if fetched.body.is_empty() {
            continue;
        }
        let Some(mime) = icon_mime(&fetched.mime, u.path()) else {
            continue;
        };
        return Ok(Some(RemoteImage::from_bytes(mime, &fetched.body)));
    }
    Ok(None)
}

/// ページも画像も、行き先は利用者が開いているサイトなので http とリダイレクトを許す。
/// 違うのは読む量と、途中で切れたときの扱いだけ。
fn policy(max_bytes: usize, partial: Partial) -> FetchPolicy {
    FetchPolicy {
        allow_http: true,
        redirects: Redirects::Follow,
        target: Target::Public,
        timeout: TIMEOUT,
        max_bytes,
        partial,
    }
}

/// 画像として扱える `Content-Type` か。`favicon.ico` を `application/octet-stream` や
/// 空で返すサーバーがあるので、そのときだけ拡張子で補う。
fn icon_mime(mime: &str, path: &str) -> Option<String> {
    if mime.starts_with("image/") {
        return Some(mime.to_owned());
    }
    let lenient = mime.is_empty() || mime == "application/octet-stream";
    (lenient && path.to_ascii_lowercase().ends_with(".ico")).then(|| "image/x-icon".to_owned())
}

/// `data:image/png;base64,...` をそのまま使う（取得が要らない）。base64 でないものは見送る。
fn parse_data_url(href: &str) -> Option<RemoteImage> {
    let rest = href.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    if !mime.starts_with("image/") {
        return None;
    }
    Some(RemoteImage {
        mime: mime.to_owned(),
        base64: data.trim().to_owned(),
    })
}

/// `<link>` のうちアイコンを指すものの `href`。`rel="icon"`（`shortcut icon` を含む）を
/// 文書の順に並べ、その後ろに `apple-touch-icon` を足す。
fn icon_hrefs(html: &str) -> Vec<String> {
    let mut icons = Vec::new();
    let mut apple = Vec::new();
    let mut from = 0;
    while let Some(at) = find_ascii_ci(&html[from..], "<link") {
        let start = from + at + "<link".len();
        let Some(len) = html[start..].find('>') else {
            break;
        };
        let attrs = parse_attrs(&html[start..start + len]);
        from = start + len;
        let (Some(rel), Some(href)) = (attr(&attrs, "rel"), attr(&attrs, "href")) else {
            continue;
        };
        let href = decode_entities(href.trim());
        if href.is_empty() {
            continue;
        }
        let rel = rel.to_ascii_lowercase();
        let has = |name: &str| rel.split_ascii_whitespace().any(|t| t == name);
        if has("icon") {
            icons.push(href);
        } else if has("apple-touch-icon") || has("apple-touch-icon-precomposed") {
            apple.push(href);
        }
    }
    icons.extend(apple);
    icons
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// タグの中身（`<link` の後ろから `>` の手前まで）を `(小文字の名前, 値)` に分ける。
/// 値は引用符（`"` / `'`）でも裸でもよい。
fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = s;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == '/');
        if rest.is_empty() {
            break;
        }
        let name_end = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '=')
            .unwrap_or(rest.len());
        let name = rest[..name_end].to_ascii_lowercase();
        rest = rest[name_end..].trim_start();
        let Some(after_eq) = rest.strip_prefix('=') else {
            out.push((name, String::new()));
            continue;
        };
        let after_eq = after_eq.trim_start();
        let (value, tail) = match after_eq.chars().next() {
            Some(q @ ('"' | '\'')) => {
                let body = &after_eq[1..];
                match body.find(q) {
                    Some(end) => (&body[..end], &body[end + 1..]),
                    None => (body, ""),
                }
            }
            _ => {
                let end = after_eq
                    .find(|c: char| c.is_ascii_whitespace())
                    .unwrap_or(after_eq.len());
                (&after_eq[..end], &after_eq[end..])
            }
        };
        out.push((name, value.to_owned()));
        rest = tail;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_icon_over_apple_touch_icon() {
        let html = r#"<head>
            <link rel="apple-touch-icon" href="/apple.png">
            <link rel="stylesheet" href="/a.css">
            <LINK REL="Shortcut Icon" HREF='/fav.ico'>
            <link href=/icon.svg rel=icon type="image/svg+xml" />
        </head>"#;
        assert_eq!(icon_hrefs(html), ["/fav.ico", "/icon.svg", "/apple.png"]);
    }

    #[test]
    fn skips_mask_icon_and_empty_href() {
        let html = r#"<link rel="mask-icon" href="/mask.svg"><link rel="icon" href="">"#;
        assert!(icon_hrefs(html).is_empty());
    }

    #[test]
    fn decodes_entities_in_href() {
        let html = r#"<link rel="icon" href="/i.png?a=1&amp;b=2">"#;
        assert_eq!(icon_hrefs(html), ["/i.png?a=1&b=2"]);
    }

    #[test]
    fn reads_base64_data_urls() {
        let img = parse_data_url("data:image/png;base64,AAAA").unwrap();
        assert_eq!(img.mime, "image/png");
        assert_eq!(img.base64, "AAAA");
        assert!(parse_data_url("data:image/svg+xml,<svg/>").is_none());
        assert!(parse_data_url("data:text/html;base64,AAAA").is_none());
    }

    #[test]
    fn accepts_ico_served_without_an_image_type() {
        assert_eq!(
            icon_mime("image/png", "/a.png").as_deref(),
            Some("image/png")
        );
        assert_eq!(
            icon_mime("", "/favicon.ico").as_deref(),
            Some("image/x-icon")
        );
        assert_eq!(icon_mime("text/html", "/favicon.ico"), None);
        assert_eq!(icon_mime("application/octet-stream", "/a.png"), None);
    }
}
