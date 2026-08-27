//! Pike が外部ホストへ出ていく取得を 1 箇所に集める。
//!
//! 呼び出し元は 2 つ（Markdown プレビューの画像 #239、貼り付けた URL のタイトル #241）で、
//! **方針は本当に違う**: 画像は承認済みホストだけを相手にするのでリダイレクトを追わず
//! https に限るが、タイトルは承認の仕組みが無いぶん短縮 URL を追う必要があり http も来る。
//! その違いは `FetchPolicy` の引数として残す。
//!
//! **同じなのは仕組みのほう**で、そちらをここに置く: TLS プロバイダの用意、クライアントの
//! 生成と使い回し、`Content-Type` の分解、上限付きのチャンク読み。以前は 2 ファイルに
//! 同じ手順が書き写されていて、実際に読みループの挙動が食い違っていた（片方は上限超過で
//! エラー、もう片方は切り詰め）。上限やタイムアウトを見直すときに 1 箇所で済むようにする。

use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

/// リダイレクトを追う場合のホップ数。短縮 URL とログインのリダイレクトはこれで足りる。
/// これ以上続く連鎖はページよりループの可能性が高い。
///
/// **モジュール全体で 1 つの値**。クライアントを方針ごとに使い回すので、呼び出し元ごとに
/// 別の上限を持たせると「最初に生成した側の値が全員に効く」という分かりにくい状態になる。
const MAX_REDIRECTS: usize = 5;

/// リダイレクトを追うか。追わないことが**承認したホストと応答するホストを一致させる**唯一の
/// 手段になる経路（#239）があるので、既定を作らず呼び出し元に選ばせる。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Redirects {
    /// 追わない。3xx はそのまま失敗として扱われる。
    Never,
    /// `MAX_REDIRECTS` まで追う。
    Follow,
}

/// 上限に達したときの扱い。画像は途中まで読んでも意味が無いので失敗、HTML は
/// `<title>` が先頭にあるので切り詰めで足りる。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Overflow {
    Fail,
    Truncate,
}

pub struct FetchPolicy {
    /// http を許すか。https は常に許す。
    pub allow_http: bool,
    pub redirects: Redirects,
    pub timeout: Duration,
    pub max_bytes: usize,
    pub overflow: Overflow,
}

pub struct Fetched {
    /// `Content-Type` の本体（`image/svg+xml` など）。ヘッダが無ければ空。
    pub mime: String,
    /// `Content-Type` の `charset` パラメータ。
    pub charset: Option<String>,
    pub body: Vec<u8>,
}

/// reqwest は tauri-plugin-updater 経由で入っている。あちらは TLS バックエンドを選ぶが、
/// crypto provider を入れるのは自分でクライアントを組むときだけなので、更新確認より先に
/// ここへ来ると provider 未設定で落ちる。
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// リダイレクト方針ごとに 1 つだけ作って使い回す。
///
/// **毎回組み直さないこと。** `Client::builder().build()` は rustls の設定を作り、
/// webpki のトラストアンカーを全部読み、接続プールと DNS リゾルバを確保する。呼び出しごとに
/// 捨てると同じホストへの 2 回目も TLS ハンドシェイクからやり直しになる（`docker/mod.rs` が
/// `OnceCell` でクライアントを持つのと同じ理由）。タイムアウトはリクエスト単位で指定できるので、
/// 方針の違いはリダイレクトだけに畳める。
fn client(redirects: Redirects) -> Result<Client, String> {
    static NEVER: OnceLock<Option<Client>> = OnceLock::new();
    static FOLLOW: OnceLock<Option<Client>> = OnceLock::new();
    let slot = match redirects {
        Redirects::Never => &NEVER,
        Redirects::Follow => &FOLLOW,
    };
    slot.get_or_init(|| {
        ensure_crypto_provider();
        let policy = match redirects {
            Redirects::Never => reqwest::redirect::Policy::none(),
            Redirects::Follow => reqwest::redirect::Policy::limited(MAX_REDIRECTS),
        };
        Client::builder().redirect(policy).build().ok()
    })
    .clone()
    .ok_or_else(|| "Failed to build the HTTP client".to_string())
}

/// `Content-Type` を本体と charset に分ける。
///
/// パラメータ（`; charset=utf-8`）は mime の一部ではないので落とす。data URL に
/// `image/svg+xml; charset=utf-8` をそのまま書くと壊れる、というのが元の動機。
pub fn parse_content_type(raw: &str) -> (String, Option<String>) {
    let lower = raw.to_ascii_lowercase();
    let mut parts = lower.split(';');
    let mime = parts.next().unwrap_or("").trim().to_string();
    let charset = parts
        .filter_map(|p| p.trim().strip_prefix("charset="))
        .map(|c| c.trim_matches('"').trim().to_string())
        .find(|c| !c.is_empty());
    (mime, charset)
}

/// 取得して、上限までの本文と `Content-Type` を返す。
///
/// **本文はチャンクで読む。** サーバーは `Content-Length` を偽れる（省略もできる）ので、
/// 上限は本文が届いているあいだ効き続けなければならない。
pub async fn fetch(url: &str, policy: &FetchPolicy) -> Result<Fetched, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let ok_scheme = parsed.scheme() == "https" || (policy.allow_http && parsed.scheme() == "http");
    if !ok_scheme {
        return Err(if policy.allow_http {
            "Only http/https URLs are allowed".to_string()
        } else {
            "Only https URLs are allowed".to_string()
        });
    }

    let mut resp = client(policy.redirects)?
        .get(parsed)
        .timeout(policy.timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let (mime, charset) = parse_content_type(
        resp.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );

    let mut body: Vec<u8> = Vec::with_capacity(policy.max_bytes.min(64 * 1024));
    loop {
        // 途中で切れた本文でも、先頭は届いていることがある（HTML の `<head>` など）。
        // 打ち切って手元のぶんを返すかどうかは呼び出し元が決める。
        let Ok(chunk) = resp.chunk().await else { break };
        let Some(chunk) = chunk else { break };
        body.extend_from_slice(&chunk);
        if body.len() >= policy.max_bytes {
            if policy.overflow == Overflow::Fail {
                return Err(format!("Larger than {} MB", policy.max_bytes / 1024 / 1024));
            }
            body.truncate(policy.max_bytes);
            break;
        }
    }
    Ok(Fetched { mime, charset, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_content_type_into_mime_and_charset() {
        assert_eq!(parse_content_type("text/html; charset=utf-8"), ("text/html".into(), Some("utf-8".into())));
        // 空白なしと引用符付き。どちらも実際に来る。
        assert_eq!(parse_content_type("text/html;charset=\"Shift_JIS\""), ("text/html".into(), Some("shift_jis".into())));
        assert_eq!(parse_content_type("image/svg+xml"), ("image/svg+xml".into(), None));
        assert_eq!(parse_content_type(""), (String::new(), None));
    }
}
