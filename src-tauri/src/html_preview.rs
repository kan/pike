//! HTML ファイルのプレビュー（#399）。ブラウザのタブ（#368）と同じ子 webview に、
//! 独自スキーム `pike-preview` で配信したファイルを描かせる。
//!
//! **なぜ独自スキームか。** `file://` は opaque origin なので `type="module"` と
//! `fetch()` が CORS で通らず、WSL のファイルは UNC 越しになる。asset protocol は
//! origin の問題を解くが、WSL のファイルを UNC 越しの `std::fs` で読むことになり、
//! `fs` モジュールの WSL 向けの経路を素通りする。ここのハンドラは WSL では distro の中で
//! 読む（`read_served`。1 ファイルにつき `wsl.exe` 1 本）。
//!
//! **プレビューするページは任意の JS を動かす**ので、ルートの下でも返さないものがある:
//! `.` で始まる名前（`.git` / `.env`）と、実体がルートの外にあるもの（symlink）。CSP は
//! 付けていないので、読めたものを外へ送ることは止めていない（外の CDN を読むページを
//! 壊さないため）。守りは「読めるものを絞る」側に置いてある。
//!
//! **どのファイルを返してよいかは、要求した webview のラベルで決める。** ハンドラは
//! アプリ全体に登録されるので、ブラウザのタブで開いた外部のページも
//! `http://pike-preview.localhost/…` を要求できる。URL にルートやプロジェクト id を
//! 載せる形だと、それを当てれば任意のプロジェクトを読めてしまう。ここでは
//! `preview_open` が登録したラベルからの要求にだけ、そのラベルのルートの下を返す。
//!
//! **Vue SFC のプレビュー（#397）も同じ子 webview に描くが、配信はしない。** コンパイルは
//! プロジェクトの Vite 開発サーバーに任せ（Pike はコンパイラを抱えない）、子 webview は
//! その URL を直接開く（`preview_dev_open`）。こちらの登録は配信のルートを持たないので、
//! `pike-preview` のスキームからは何も返らない。共有するのはリンクをブラウザのタブへ
//! 逃がす部分と、ラベルの約束と、後始末。
//!
//! ラベルは `browser-preview-{uuid}`。`browser.rs` の `check_label` を通るので、位置
//! 合わせ・再読み込み・閉じる（`browser_place` / `browser_history` / `browser_close`）は
//! ブラウザのタブのコマンドをそのまま使う。capability の対象外であることも同じ
//! （`browser.rs` のモジュール doc）。**登録の後始末はブラウザのタブの側に持ち込まない**:
//! 次の `preview_open` / `preview_dev_open` が、もう無い webview のぶんを落とす（`prune`）。

use crate::browser::{self, Bounds};
use crate::fs::MAX_SIZE_CEILING;
use crate::http::{self, FetchPolicy, Partial, Redirects, Target};
use crate::types::{into_lossy_string, ShellConfig};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::http::{header, response::Builder, Request, Response, StatusCode};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, Runtime, UriSchemeContext, UriSchemeResponder, Url,
    WebviewUrl, Window,
};

/// スキーム名。Windows（WebView2）では `http://pike-preview.localhost/` に載る。
pub const SCHEME: &str = "pike-preview";

/// ラベルの接頭辞。`browser-` の下に置くのは、ブラウザのタブのコマンドを通すため。
const LABEL_PREFIX: &str = "browser-preview-";

/// ページのリンクをブラウザのタブへ逃がす最短の間隔。**押されたかどうかは分からない**
/// （`location = …` も同じ経路で来る）ので、スクリプトが連打してもタブが溢れないようにする。
const LINK_INTERVAL: Duration = Duration::from_secs(1);

/// `pike-preview` で配信するルート。
struct ServedRoot {
    /// WSL ならそのままのパス、それ以外は実体を解決したパス（`canonical_root`）。
    root: String,
    shell: ShellConfig,
}

struct Entry {
    /// 開発サーバーを描くプレビュー（#397）は持たない。
    served: Option<ServedRoot>,
    /// 最後にブラウザのタブへ逃がした時刻（`LINK_INTERVAL`）。
    last_link: Option<Instant>,
}

/// ラベル → 配信してよいルート。
#[derive(Default)]
pub struct PreviewState {
    entries: Mutex<HashMap<String, Entry>>,
}

impl PreviewState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// この環境で子 webview に渡すオリジン。WebView2 は独自スキームを
/// `http://<scheme>.localhost` に載せ、他（WKWebView / WebKitGTK）はそのまま使う。
/// 解くのは 1 度だけ（遷移のたびに照合する）。
fn origin() -> &'static Url {
    static ORIGIN: OnceLock<Url> = OnceLock::new();
    ORIGIN.get_or_init(|| {
        let s = if cfg!(windows) {
            "http://pike-preview.localhost/"
        } else {
            "pike-preview://localhost/"
        };
        Url::parse(s).expect("valid preview origin")
    })
}

fn is_preview_url(url: &Url) -> bool {
    let o = origin();
    o.scheme() == url.scheme() && o.host_str() == url.host_str() && o.port() == url.port()
}

/// ブラウザのタブのコマンドを通る形（`browser-`）で、かつプレビューのラベルか。
fn check_label(label: &str) -> Result<(), String> {
    browser::check_label(label)?;
    if label.starts_with(LABEL_PREFIX) {
        Ok(())
    } else {
        Err("invalid preview label".into())
    }
}

/// URL のパスを、ルートからの相対パスのセグメントに直す。**ルートの外へ出るものは
/// `None`**: `..`、区切りを含むセグメント（`%2F` / `\`）、ドライブや ADS の `:`、NUL。
fn relative_segments(url_path: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for raw in url_path.split('/') {
        let seg = percent_decode_str(raw).decode_utf8().ok()?;
        match seg.as_ref() {
            "" | "." => continue,
            ".." => return None,
            s if s.contains(['/', '\\', ':', '\0']) => return None,
            s => out.push(s.to_owned()),
        }
    }
    Some(out)
}

fn mime_of(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        // charset は付けない。HTML の `<meta charset>` を効かせる（Shift_JIS のページがある）。
        "html" | "htm" => "text/html",
        "css" => "text/css",
        // module script は MIME を厳密に見る（`application/octet-stream` だと読み込まない）。
        "js" | "mjs" | "cjs" => "text/javascript",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "xml" => "application/xml",
        "txt" | "md" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// 応答の土台。保存したら描き直す（`location.reload()`）ので、キャッシュに残さない。
fn response(status: StatusCode) -> Builder {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
}

fn finish(builder: Builder, body: Vec<u8>) -> Response<Vec<u8>> {
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    finish(response(status).header(header::CONTENT_TYPE, mime), body)
}

fn text(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    respond(status, "text/plain; charset=utf-8", msg.as_bytes().to_vec())
}

/// ディレクトリへの URL に `/` を足して来直させる（相対パスの基準をディレクトリにするため）。
fn redirect_to_dir(url: &Url) -> Response<Vec<u8>> {
    let mut to = url.clone();
    to.set_path(&format!("{}/", url.path()));
    finish(
        response(StatusCode::MOVED_PERMANENTLY).header(header::LOCATION, to.as_str()),
        Vec::new(),
    )
}

/// `.` で始まる名前（`.git` / `.env` / `.ssh`）か。**プレビューするページは任意の JS を
/// 動かす**ので、ルートの下でも秘密を置きがちな場所は返さない。
fn is_hidden(segments: &[String]) -> bool {
    segments.iter().any(|s| s.starts_with('.'))
}

/// ディスクから読んだ結果。
#[derive(Debug, PartialEq)]
enum Served {
    Bytes(Vec<u8>),
    Missing,
    /// ディレクトリだった（末尾に `/` を付けて来直させる）。
    Dir,
    /// 実体がルートの外にある（ルートの外を指す symlink）。
    Outside,
    TooLarge,
}

/// `read_served` の WSL の腕が使う終了コード。**1 回の `wsl.exe` で済ませる**:
/// `fs::read_raw_bytes` は stat と cat で 2 本起こすので、資源の多いページで遅い。
const WSL_MISSING: i32 = 3;
const WSL_OUTSIDE: i32 = 4;
const WSL_DIR: i32 = 5;
const WSL_TOO_LARGE: i32 = 6;

fn wsl_read_script(root: &str, path: &str) -> String {
    let q = crate::types::bash_quote;
    format!(
        "r=$(realpath -e -- {root}) || exit {WSL_MISSING}; \
         p=$(realpath -e -- {path}) || exit {WSL_MISSING}; \
         case \"$p\" in \"$r\"/*) ;; *) exit {WSL_OUTSIDE};; esac; \
         [ -d \"$p\" ] && exit {WSL_DIR}; \
         s=$(stat -c %s -- \"$p\") || exit 1; \
         [ \"$s\" -gt {MAX_SIZE_CEILING} ] && exit {WSL_TOO_LARGE}; \
         exec cat -- \"$p\"",
        root = q(root),
        path = q(path),
    )
}

/// 配信のルートを、比べられる形にしておく（**要求のたびに解決しない**）。WSL は distro の
/// 中で `realpath` するので、そのまま持つ。
fn canonical_root(shell: &ShellConfig, root: String) -> Result<String, String> {
    if let ShellConfig::Wsl { .. } = shell {
        return Ok(root);
    }
    std::fs::canonicalize(&root)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// ルートの下のファイルを読む。**symlink は解決してからルートの中か確かめる**（ルートの
/// 外を指すリンクを辿って `~/.ssh` などを返さないため）。`root` は `canonical_root` の結果。
fn read_served(shell: &ShellConfig, root: &str, segments: &[String]) -> Result<Served, String> {
    if let ShellConfig::Wsl { .. } = shell {
        let path = format!("{}/{}", root.trim_end_matches('/'), segments.join("/"));
        let out = shell.run_raw("bash", &["-c", &wsl_read_script(root, &path)])?;
        return Ok(match out.status.code() {
            Some(0) => Served::Bytes(out.stdout),
            Some(WSL_MISSING) => Served::Missing,
            Some(WSL_OUTSIDE) => Served::Outside,
            Some(WSL_DIR) => Served::Dir,
            Some(WSL_TOO_LARGE) => Served::TooLarge,
            _ => return Err(into_lossy_string(out.stderr).trim().to_owned()),
        });
    }
    // **`PathBuf` でつなぐ。** 解決済みのルートは Windows では `\\?\` 付きで、その形は `/` を
    // 区切りとして受けない。
    let root = Path::new(root);
    let path: PathBuf = segments.iter().fold(root.to_path_buf(), |p, s| p.join(s));
    let real = match std::fs::canonicalize(&path) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Served::Missing),
        Err(e) => return Err(e.to_string()),
    };
    if !real.starts_with(root) {
        return Ok(Served::Outside);
    }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Ok(Served::Dir);
    }
    if meta.len() > MAX_SIZE_CEILING {
        return Ok(Served::TooLarge);
    }
    std::fs::read(&real)
        .map(Served::Bytes)
        .map_err(|e| e.to_string())
}

fn serve(state: &PreviewState, label: &str, uri: &str) -> Response<Vec<u8>> {
    let Ok(url) = Url::parse(uri) else {
        return text(StatusCode::BAD_REQUEST, "bad request");
    };
    let Some(mut segments) = relative_segments(url.path()) else {
        return text(StatusCode::FORBIDDEN, "outside the project");
    };
    // 末尾が `/` ならディレクトリの index.html。
    if url.path().ends_with('/') {
        segments.push("index.html".to_owned());
    }
    let rel = segments.join("/");
    // 読むあいだロックを握らない（WSL では wsl.exe を起こす）。
    let (root, shell) = {
        let entries = state.lock();
        let Some(served) = entries.get(label).and_then(|e| e.served.as_ref()) else {
            return text(StatusCode::FORBIDDEN, "not a preview");
        };
        (served.root.clone(), served.shell.clone())
    };
    if is_hidden(&segments) {
        return text(StatusCode::FORBIDDEN, "hidden files are not served");
    }
    match read_served(&shell, &root, &segments) {
        Ok(Served::Bytes(bytes)) => respond(StatusCode::OK, mime_of(&rel), bytes),
        Ok(Served::Missing) => text(StatusCode::NOT_FOUND, "not found"),
        Ok(Served::Dir) => redirect_to_dir(&url),
        Ok(Served::Outside) => text(StatusCode::FORBIDDEN, "outside the project"),
        Ok(Served::TooLarge) => text(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
        Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// `register_asynchronous_uri_scheme_protocol` に渡すハンドラ。読み込みは WSL では
/// プロセスを起こすので、メインスレッドから外す。
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let label = ctx.webview_label().to_owned();
    let uri = request.uri().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PreviewState>();
        responder.respond(serve(&state, &label, &uri));
    });
}

/// もう無い子 webview の登録を落とす。**閉じた知らせを受ける口を持たない**（タブを閉じた、
/// ウィンドウごと閉じた、作っている途中で捨てた、のどれでも同じ形で消える）ので、次に
/// 開くときに掃除する。
fn prune(app: &AppHandle, entries: &mut HashMap<String, Entry>) {
    entries.retain(|label, _| app.get_webview(label).is_some());
}

/// 呼んだウィンドウにプレビューの子 webview を作り、`entry`（ルートからの相対パス）を開く。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_open(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, PreviewState>,
    label: String,
    root: String,
    shell: ShellConfig,
    entry: String,
    bounds: Bounds,
) -> Result<(), String> {
    check_label(&label)?;
    let Some(segments) = relative_segments(&entry) else {
        return Err("entry is outside the root".into());
    };
    let mut url = origin().clone();
    // セグメントごとに URL の規則で符号化させる（`#` や空白を含む名前がある）。
    url.path_segments_mut()
        .map_err(|_| "bad origin")?
        .clear()
        .extend(&segments);
    let root = canonical_root(&shell, root)?;
    let served = ServedRoot { root, shell };
    open_child(
        app,
        &window,
        &state,
        label,
        Some(served),
        url,
        bounds,
        is_preview_url,
    )
}

/// 開発サーバー（Vite）のページを描くプレビューの子 webview を作る（#397）。ページが自分で
/// 動いてよいのは `url` と同じオリジンの中だけ（HMR の WebSocket は遷移ではないので通る）。
#[tauri::command]
pub async fn preview_dev_open(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, PreviewState>,
    label: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    check_label(&label)?;
    let url = browser::check_page_url(&app, &url)?;
    let origin = url.origin();
    let stays = move |u: &Url| u.origin() == origin;
    open_child(app, &window, &state, label, None, url, bounds, stays)
}

/// 開発サーバーの入口を取りに行った結果（#397）。フロントは候補の URL を順に試し、
/// `Ready` を返した最初のものを開く。
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DevProbe {
    /// Vite が入口を返した。
    Ready,
    /// 繋がらない（開発サーバーが動いていない）。
    Unreachable,
    /// 繋がったが入口が無い（別のプロジェクトのサーバー、`base` の食い違い、SSR の構成）。
    /// 別のプロジェクトの Vite は無い `.html` にも `index.html` を 200 で返すので、印
    /// （`marker`）の無い Vite のページもここに入る。
    NotFound,
    /// 返ってきたが Vite の開発サーバーのページではない。
    NotVite,
}

/// 開発サーバーの応答だけを見るので短く切る（候補を順に試すあいだ待たせない）。
const DEV_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Vite が開発時の HTML に差し込むクライアント（`base` が付いても末尾はこの形）。
const VITE_CLIENT: &[u8] = b"/@vite/client";

/// `url`（開発サーバー上の入口）を取りに行き、Vite が返したかを確かめる。**入口は Pike が
/// そのプロジェクトの下に書いたファイル**で、`marker` はそこに埋めた印（`lib/devServer.ts` の
/// `previewMarker`）。別のプロジェクトの Vite や別のサーバーはここで落ちる（ポートだけを
/// 見る形より取り違えが無い）。
#[tauri::command]
pub async fn preview_dev_probe(
    app: AppHandle,
    url: String,
    marker: String,
) -> Result<DevProbe, String> {
    let url = browser::check_page_url(&app, &url)?;
    let policy = FetchPolicy {
        allow_http: true,
        // 追うと `base` の食い違いを別のページで埋めてしまう。
        redirects: Redirects::Never,
        // 自己署名の証明書・`*.localhost`（リバースプロキシの `VIRTUAL_HOST`）・ページとしての
        // 要求（`Accept: text/html`）。中身は `Target::LocalDevServer` の doc。
        target: Target::LocalDevServer,
        timeout: DEV_PROBE_TIMEOUT,
        max_bytes: 64 * 1024,
        partial: Partial::Keep,
    };
    Ok(match http::fetch(url.as_str(), &policy).await {
        Ok(page) => classify(&page.body, &marker),
        Err(e) if http::is_status_error(&e) => DevProbe::NotFound,
        Err(_) => DevProbe::Unreachable,
    })
}

fn contains(body: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && body.windows(needle.len()).any(|w| w == needle)
}

/// 返ってきたページを見分ける。印が無い Vite のページは SPA のフォールバック（`NotFound`）。
fn classify(body: &[u8], marker: &str) -> DevProbe {
    if !contains(body, VITE_CLIENT) {
        DevProbe::NotVite
    } else if contains(body, marker.as_bytes()) {
        DevProbe::Ready
    } else {
        DevProbe::NotFound
    }
}

/// 子 webview を作って登録する（HTML と開発サーバーのプレビューで共通）。`stays` はページが
/// 自分で移動してよい URL か。**外へは移動させない**: リンクはブラウザのタブで開く（プレビューは
/// そのファイルを見る場所で、移動を始めると戻る手段が要る）。
#[allow(clippy::too_many_arguments)]
fn open_child(
    app: AppHandle,
    window: &Window,
    state: &PreviewState,
    label: String,
    served: Option<ServedRoot>,
    url: Url,
    bounds: Bounds,
    stays: impl Fn(&Url) -> bool + Send + 'static,
) -> Result<(), String> {
    {
        let mut entries = state.lock();
        prune(&app, &mut entries);
        entries.insert(
            label.clone(),
            Entry {
                served,
                last_link: None,
            },
        );
    }
    let window_label = window.label().to_owned();
    let opener = label.clone();
    let redirect = move |url: &Url| open_in_browser_tab(&app, &window_label, &opener, url);
    let on_new_window = redirect.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        // ブラウザのタブと同じ理由（`browser_open` のコメント）。
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if stays(url) {
                return true;
            }
            redirect(url);
            false
        })
        .on_new_window(move |url, _| {
            on_new_window(&url);
            NewWindowResponse::Deny
        });
    let rect = bounds.rect();
    let result = window
        .add_child(builder, rect.position, rect.size)
        .map(|_| ())
        .map_err(|e| e.to_string());
    if result.is_err() {
        state.lock().remove(&label);
    }
    result
}

/// リンクをブラウザのタブへ逃がす。受けるのは http(s) だけで、Pike 自身のオリジンは
/// `browser_open` の側が拒む。間隔は `LINK_INTERVAL` 空ける。
fn open_in_browser_tab(app: &AppHandle, window: &str, opener: &str, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") || is_preview_url(url) {
        return;
    }
    {
        let state = app.state::<PreviewState>();
        let mut entries = state.lock();
        let Some(entry) = entries.get_mut(opener) else {
            return;
        };
        let now = Instant::now();
        if entry
            .last_link
            .is_some_and(|t| now.duration_since(t) < LINK_INTERVAL)
        {
            return;
        }
        entry.last_link = Some(now);
    }
    let _ = app.emit_to(
        EventTarget::window(window),
        "browser_new_tab",
        browser::BrowserNewTabPayload {
            label: opener.to_owned(),
            url: url.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_stay_inside_the_root() {
        let seg = |p: &str| relative_segments(p);
        assert_eq!(seg("/a/b.html").unwrap(), ["a", "b.html"]);
        assert_eq!(seg("/a/./b%20c.css").unwrap(), ["a", "b c.css"]);
        assert_eq!(seg("/%E6%97%A5.html").unwrap(), ["日.html"]);
        assert!(seg("/a/../../etc/passwd").is_none());
        assert!(seg("/%2E%2E/x").is_none());
        assert!(seg("/a%2Fb").is_none());
        assert!(seg("/a%5Cb").is_none());
        assert!(seg("/C:/Windows").is_none());
        assert!(seg("/x.txt:stream").is_none());
    }

    #[test]
    fn labels_must_be_previews() {
        assert!(check_label("browser-preview-1a2b").is_ok());
        assert!(check_label("browser-1a2b").is_err());
        assert!(check_label("preview-1a2b").is_err());
    }

    #[test]
    fn hidden_names_are_not_served() {
        let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        assert!(is_hidden(&s(&[".env"])));
        assert!(is_hidden(&s(&["a", ".git", "config"])));
        assert!(!is_hidden(&s(&["a", "b.html"])));
    }

    #[test]
    fn reads_files_and_tells_dirs_apart() {
        let dir = std::env::temp_dir().join(format!("pike-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("a.html"), b"<p>x</p>").unwrap();
        let shell = ShellConfig::host_default();
        let root = canonical_root(&shell, dir.to_string_lossy().into_owned()).unwrap();
        let seg = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            read_served(&shell, &root, &seg(&["sub", "a.html"])).unwrap(),
            Served::Bytes(b"<p>x</p>".to_vec())
        );
        assert_eq!(
            read_served(&shell, &root, &seg(&["sub"])).unwrap(),
            Served::Dir
        );
        assert_eq!(
            read_served(&shell, &root, &seg(&["nope.css"])).unwrap(),
            Served::Missing
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_our_entry_is_ready() {
        let ours = br#"<script type="module" src="/app/@vite/client"></script>
            <meta name="pike-preview" content="pike-preview-0a1b2c3d" />"#;
        let fallback = br#"<script type="module" src="/@vite/client"></script><div id="app">"#;
        let m = "pike-preview-0a1b2c3d";
        assert_eq!(classify(ours, m), DevProbe::Ready);
        assert_eq!(classify(fallback, m), DevProbe::NotFound);
        assert_eq!(classify(b"<p>nginx</p>", m), DevProbe::NotVite);
        assert_eq!(classify(ours, ""), DevProbe::NotFound);
    }

    #[test]
    fn module_scripts_get_a_js_mime() {
        assert_eq!(mime_of("a/b.mjs"), "text/javascript");
        assert_eq!(mime_of("INDEX.HTML"), "text/html");
        assert_eq!(mime_of("noext"), "application/octet-stream");
    }

    #[test]
    fn only_the_preview_origin_counts() {
        assert!(is_preview_url(&origin().join("a.html").unwrap()));
        assert!(!is_preview_url(
            &Url::parse("https://example.com/").unwrap()
        ));
        assert!(!is_preview_url(
            &Url::parse("http://tauri.localhost/").unwrap()
        ));
    }
}
