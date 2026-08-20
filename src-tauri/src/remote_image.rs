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

/// reqwest reaches us through tauri-plugin-updater, which picks the TLS backend
/// but installs the crypto provider only when it builds its own client. Fetching
/// an image before the first update check would otherwise fail on a missing
/// default provider.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

#[tauri::command]
pub async fn remote_image_fetch(url: String) -> Result<RemoteImage, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only https image URLs are allowed".to_string());
    }
    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // Redirects are not followed: the user approved *this* host, and a
        // 302 would take the request somewhere they never saw. A 3xx falls
        // through to the status check below and reads as a failed fetch.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        // `image/svg+xml; charset=utf-8` — the parameters do not belong in a data URL.
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !mime.starts_with("image/") {
        return Err(format!("Not an image ({mime})"));
    }
    // Read in chunks rather than `bytes()`: a server is free to lie about (or
    // omit) Content-Length, so the cap has to hold while the body arrives.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > MAX_BYTES {
            return Err(format!("Image is larger than {} MB", MAX_BYTES / 1024 / 1024));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(RemoteImage {
        mime,
        base64: base64::engine::general_purpose::STANDARD.encode(&buf),
    })
}
