//! ブラウザのタブ（#368）。ウィンドウの子 webview を作り、タブの中身の領域に重ねる。
//!
//! **iframe では出せない。** Jira のような外部サービスは `X-Frame-Options` と
//! `frame-ancestors` で埋め込みを拒むので、表示するにはネイティブの webview が要る
//! （Tauri の `unstable` feature の `Window::add_child`）。
//!
//! **子 webview は Pike の DOM より手前に描かれる。** 右クリックメニュー・ダイアログ・
//! QuickOpen はブラウザのタブの下に隠れる（#368 で制約として受け入れた）。位置と表示は
//! フロントが決め、ここは言われたとおりに動かすだけにする（`BrowserTab.vue` が
//! `getBoundingClientRect` を測って送る）。
//!
//! **外部のページに IPC は開かない。** capability は既定でローカルの origin にしか
//! 効かない（`remote.urls` を書いていない）ので、ここで作る webview から `invoke` は
//! 通らない。
//!
//! コマンドは全部 `async`。`add_child` はメインスレッドに作らせて結果を待つので、
//! 同期コマンド（＝メインスレッド）から呼ぶとデッドロックする（`build_window` と同じ）。

use crate::site_rules::{self, SiteRule};
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview,
    WebviewUrl, Window,
};

/// フロントが付けるラベルの接頭辞。**他のウィンドウや webview を触らせない**ための印で、
/// ここで作ったもの以外はどのコマンドも受け付けない。
const LABEL_PREFIX: &str = "browser-";

/// ページが新しいウィンドウを開こうとした（`target=_blank` など）ことをフロントへ知らせる。
/// フロントは、開こうとしたタブと同じペインに新しいブラウザのタブを作る。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNewTabPayload {
    /// 開こうとしたページのタブ（子 webview のラベル）。
    label: String,
    url: String,
}

/// ページの状態が変わったことをフロントへ知らせる（開いたウィンドウにだけ送り、フロントの
/// `useBrowserRouter` がラベルで振り分ける）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStatePayload {
    label: String,
    /// 読み込みが終わったページの URL（`on_page_load` の Finished）。
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// `title` がどのページのものか。**タイトルは読み込みの完了より先に届く**ので、
    /// フロントが持っている URL（まだ前のページ）に結び付けると、前のページの履歴の行が
    /// 次のページの名前に書き換わる。
    #[serde(skip_serializing_if = "Option::is_none")]
    title_url: Option<String>,
}

fn check_label(label: &str) -> Result<(), String> {
    let rest = label
        .strip_prefix(LABEL_PREFIX)
        .ok_or("invalid browser label")?;
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid browser label".into());
    }
    Ok(())
}

/// 開けるのは http(s) だけ（`open_url` と同じ線引き。`file:` や `javascript:` を通さない）。
fn parse_web_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).map_err(|e| e.to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("unsupported scheme: {other}")),
    }
}

/// タブの中身の矩形。ウィンドウの client 領域の CSS ピクセル（＝論理ピクセル）。
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            // 0 以下の大きさは WebView2 が嫌うので 1 に丸める（隠すのは `browser_place`）。
            size: LogicalSize::new(self.width.max(1.0), self.height.max(1.0)).into(),
        }
    }
}

fn webview(app: &AppHandle, label: &str) -> Result<Webview, String> {
    check_label(label)?;
    app.get_webview(label)
        .ok_or_else(|| format!("no browser webview: {label}"))
}

/// そのページのタブを持つウィンドウにだけ送る。全ウィンドウへ送ると、関係の無い
/// ウィンドウまで起こして捨てさせることになる。
fn emit_state(webview: &Webview, url: Option<String>, title: Option<String>) {
    let title_url = title
        .as_ref()
        .and_then(|_| webview.url().ok())
        .map(|u| u.to_string());
    let _ = webview.emit_to(
        EventTarget::window(webview.window().label()),
        "browser_state",
        BrowserStatePayload {
            label: webview.label().to_owned(),
            url,
            title,
            title_url,
        },
    );
}

/// 呼んだウィンドウに子 webview を作る。**ラベルはフロントが毎回新しく作る**（UUID）ので、
/// 同じラベルが既にあれば `add_child` がエラーを返す。
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    window: Window,
    label: String,
    url: String,
    bounds: Bounds,
    rules: Vec<SiteRule>,
    jira: bool,
) -> Result<(), String> {
    check_label(&label)?;
    let url = parse_web_url(&url)?;
    let opener_label = label.clone();
    let window_label = window.label().to_owned();
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url));
    // Jira の拡張機能（#380）。**利用者のルールより先に入れる**: ルールの JS から
    // `window.JIRAPP` を使えるように。
    if jira {
        for script in site_rules::jira_scripts() {
            builder = builder.initialization_script(script);
        }
    }
    // ドメインごとの差し込み（段階 3）。**作った時点で固定される**ので、JS を変えたら
    // フロントが子 webview を作り直す。CSS はあとから `browser_apply_css` で当て直せる。
    for script in rules.iter().filter_map(site_rules::js_script) {
        builder = builder.initialization_script(script);
    }
    // CSS を持つルールが無ければ入れない（ページごとに要素を探すだけの処理になる）。
    if rules.iter().any(|r| !r.css.trim().is_empty()) {
        builder = builder.initialization_script(site_rules::css_script(&rules));
    }
    let builder = builder
        .on_new_window(move |url, features| {
            // **ポップアップかどうかは大きさの指定の有無でしか見分けられない。** WebView2 が
            // 知らせるのは `window.open` の第 3 引数の位置と大きさで、`target=_blank` の
            // リンクや第 3 引数の無い `window.open` はどちらも持たない。ログイン用の
            // ポップアップ（Google や Atlassian の SSO）は幅と高さを指定して開き、呼び出し元と
            // `window.opener` でやり取りする。タブにすると関係が切れて戻ってこないので、
            // WebView2 のウィンドウに任せる。
            if features.size().is_some() {
                return NewWindowResponse::Allow;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = app.emit_to(
                    EventTarget::window(&window_label),
                    "browser_new_tab",
                    BrowserNewTabPayload {
                        label: opener_label.clone(),
                        url: url.to_string(),
                    },
                );
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(|webview, title| {
            emit_state(&webview, None, Some(title));
        })
        // 送るのは読み込みの完了だけ（開始でも呼ばれるが、URL は同じものが 2 度届くだけ）。
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                emit_state(&webview, Some(payload.url().to_string()), None);
            }
        });
    let rect = bounds.rect();
    window
        .add_child(builder, rect.position, rect.size)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// ルールを変えたとき、開いているページの CSS を当て直す（JS は作り直さないと変わらない）。
#[tauri::command]
pub async fn browser_apply_css(
    app: AppHandle,
    label: String,
    rules: Vec<SiteRule>,
) -> Result<(), String> {
    webview(&app, &label)?
        .eval(site_rules::css_script(&rules))
        .map_err(|e| e.to_string())
}

/// 位置と表示をまとめて変える。**1 回の往復で済ませる**: リサイズ中は毎フレーム呼ばれる。
/// 隠すときは位置を送らない（`bounds` は `None`）。
#[tauri::command]
pub async fn browser_place(
    app: AppHandle,
    label: String,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<(), String> {
    let view = webview(&app, &label)?;
    if let Some(b) = bounds {
        view.set_bounds(b.rect()).map_err(|e| e.to_string())?;
    }
    let result = if visible { view.show() } else { view.hide() };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let url = parse_web_url(&url)?;
    webview(&app, &label)?
        .navigate(url)
        .map_err(|e| e.to_string())
}

/// 戻る・進む・再読み込み。ページの中で実行する（WebView2 の履歴の API を Tauri が
/// 出していないため）。受けるのは決まった 3 語だけで、任意の JS は流さない。
#[tauri::command]
pub async fn browser_history(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return Err(format!("unknown action: {other}")),
    };
    webview(&app, &label)?.eval(js).map_err(|e| e.to_string())
}

/// タブを閉じたときに呼ぶ。もう無ければ何もしない（ウィンドウごと閉じた後など）。
#[tauri::command]
pub async fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    check_label(&label)?;
    match app.get_webview(&label) {
        Some(view) => view.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_must_carry_prefix() {
        assert!(check_label("browser-1a2b-3c").is_ok());
        assert!(check_label("main").is_err());
        assert!(check_label("browser-").is_err());
        assert!(check_label("browser-a b").is_err());
    }

    #[test]
    fn only_web_schemes() {
        assert!(parse_web_url("https://example.atlassian.net/browse/X-1").is_ok());
        assert!(parse_web_url(" http://localhost:3000 ").is_ok());
        assert!(parse_web_url("file:///C:/Windows").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
    }
}
