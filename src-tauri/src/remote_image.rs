//! Fetching images from approved hosts for the Markdown preview (#239).
//!
//! The webview's CSP allows `img-src 'self' data: blob:` and nothing else, so a
//! README badge cannot be loaded by the page itself — and that is deliberate:
//! the CSP is what keeps every other surface (agent chat, the SVG preview, the
//! manual) from silently reaching third-party hosts. Widening it would weaken
//! all of them to serve one. Instead the preview asks for the bytes here and
//! inlines them as a `data:` URL, the same shape it already uses for images
//! read off disk.
//!
//! Which host is allowed is the front end's decision (it owns the approval list
//! and the dialog); this command only enforces what has to hold regardless:
//! https, no redirects, an image, and bounded in time and size. Refusing to
//! follow redirects is what keeps the front end's check meaningful — the host
//! that answers is the host the user approved.
//!
//! What this deliberately does not do is filter the address the host resolves
//! to (loopback, RFC1918, link-local). A README that points at an intranet
//! image server is a real case, and the user has to approve that host in a
//! dialog naming it before anything is fetched, so the choice is theirs to
//! make. Filtering would also only be worth the machinery with the resolved
//! address pinned into the connection; short of that it stops the literal-IP
//! case and not a rebinding one.

use base64::Engine as _;
use std::time::Duration;

use crate::http::{self, FetchPolicy, Partial, Redirects};

/// Badges are a few KB; this only exists so a mistyped URL pointing at a huge
/// file cannot pin the data URL (and the string built from it) in memory.
const MAX_BYTES: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImage {
    /// Content type as reported by the server, e.g. `image/svg+xml`.
    pub mime: String,
    pub base64: String,
}

#[tauri::command]
pub async fn remote_image_fetch(url: String) -> Result<RemoteImage, String> {
    // Redirects are not followed: the user approved *this* host, and a 302 would
    // take the request somewhere they never saw. A 3xx reads as a failed fetch.
    let policy = FetchPolicy {
        allow_http: false,
        redirects: Redirects::Never,
        timeout: TIMEOUT,
        max_bytes: MAX_BYTES,
        // 途中まで読んだ画像は使えない。上限でも通信断でも失敗にする。
        partial: Partial::Fail,
    };
    let fetched = http::fetch(&url, &policy).await?;
    if !fetched.mime.starts_with("image/") {
        return Err(format!("Not an image ({})", fetched.mime));
    }
    Ok(RemoteImage {
        mime: fetched.mime,
        base64: base64::engine::general_purpose::STANDARD.encode(&fetched.body),
    })
}
