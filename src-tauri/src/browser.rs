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
//! **外部のページに IPC は開かない。** 守りは 2 枚ある。
//!
//! 1. **`capabilities/default.json` が `windows` ではなく `webviews` で絞る**（#368）。
//!    あそこの判定は `resolve_access` の
//!    `cmd.webviews.any(matches(webview)) || cmd.windows.any(matches(window))` で、
//!    **`windows` はウィンドウの中の子 webview まで丸ごと通す**。`WebviewWindowBuilder`
//!    はウィンドウと webview に同じラベルを付けるので、`webviews` に移すだけで Pike
//!    本体（`main` / `project-*` / `global-*`）はそのまま通り、ここで作る
//!    `browser-{uuid}` は**オリジンに関わらず**対象から外れる。**`webviews` は絞り込み
//!    ではなく OR で足す側**なので、`windows` を残したまま併記しても意味が無い
//! 2. `AppOrigin` が、そもそも Pike 自身のオリジンへ移動させない
//!
//! 1 だけで足りるが、2 も残す。capability は tauri の版で意味が変わりうるうえ、
//! アドレス欄に打った利用者にはエラーを見せたほうが親切（1 だけだと、権限の無い
//! Pike の画面がそのまま開く）。
//!
//! コマンドは全部 `async`。`add_child` はメインスレッドに作らせて結果を待つので、
//! 同期コマンド（＝メインスレッド）から呼ぶとデッドロックする（`build_window` と同じ）。

use crate::site_rules::{self, SiteRule};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
/// HTML のプレビュー（#399、`html_preview.rs`）のリンクも同じ知らせで送る。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserNewTabPayload {
    /// 開こうとしたページのタブ（子 webview のラベル）。
    pub(crate) label: String,
    pub(crate) url: String,
}

/// Jira のページで列の色を変えた（#405）。`colors` は変えた列だけ（消した列は `null`）。
#[derive(Clone, Serialize)]
struct BrowserJiraColorsPayload {
    label: String,
    colors: HashMap<String, Option<String>>,
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

pub(crate) fn check_label(label: &str) -> Result<(), String> {
    let rest = label
        .strip_prefix(LABEL_PREFIX)
        .ok_or("invalid browser label")?;
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid browser label".into());
    }
    Ok(())
}

/// tauri がアプリ本体を配信するホスト。**Windows と Android では独自プロトコルが
/// `http(s)://tauri.localhost` に載る**ので、http(s) しか通さない検査では素通りする
/// （`tauri::manager` の `tauri_protocol_url`）。
const APP_HOST: &str = "tauri.localhost";

/// **Pike 自身のオリジンへは移動させない**（#368。モジュール doc の守りの 2 枚目）。
///
/// **入口は 2 つあり、両方を塞ぐ**: アドレス欄から来るコマンド（`parse_web_url`）と、
/// ページ自身の遷移（`location = …`。`on_navigation` で見る。Rust のコマンドを一度も
/// 通らないので、コマンド側だけを塞いでも意味が無い）。
///
/// 判定は `contains` の 1 か所に置く。**入口を数え上げる防御は取りこぼす**ので、
/// 本命は capability の側（モジュール doc の 1 枚目）。
/// `Default` は製品ビルドの形（`dev` 無し）と同じなので、テストはそれを突く。
#[derive(Default)]
struct AppOrigin {
    /// 開発ビルドの配信元（Vite の `devUrl`）。そちらも `is_local_url` は
    /// 「ローカル」と見なす。
    dev: Option<Url>,
}

impl AppOrigin {
    fn of(app: &AppHandle) -> Self {
        Self {
            // **`cfg!(dev)` で囲うこと。** `devUrl` は配布版の埋め込み設定にも残る
            // （`tauri-codegen` はアセットの選び分けに使うだけで、設定からは落とさない）。
            // 囲わないと、製品版で `http://localhost:1420` を開こうとしたときに
            // 「Pike 自身のオリジン」として誤って拒否する。
            dev: cfg!(dev)
                .then(|| app.config().build.dev_url.clone())
                .flatten(),
        }
    }

    fn contains(&self, url: &Url) -> bool {
        if url.host_str() == Some(APP_HOST) {
            return true;
        }
        self.dev.as_ref().is_some_and(|dev| {
            dev.host_str() == url.host_str()
                && dev.port_or_known_default() == url.port_or_known_default()
        })
    }
}

/// ローカルのファイルへの遷移か（#396）。
///
/// **`disable_drag_drop_handler` の代償を埋める。** それを切ると WebView2 の既定の外部
/// ドロップが戻るので、ページにファイルを落とすと**そのページが `file://` へ移動する**
/// （アドレス欄の `parse_web_url` は通らないので、http(s) だけという線引きがそこだけ
/// 破れる）。差し込みのスクリプト（利用者のルールと Jira の拡張機能）も、その `file://`
/// の文書で走ることになる。
///
/// **許可制ではなく `file:` の拒否にしてある。** ここへ来るのは普通のページの動き
/// （`blob:` / `about:blank`、外部アプリを起こすスキーム）も含むので、並べ上げた
/// スキームだけを通す形にすると、並べ忘れたものが黙って動かなくなる。
fn is_local_file(url: &Url) -> bool {
    url.scheme() == "file"
}

/// 開けるのは http(s) だけ（`open_url` と同じ線引き。`file:` や `javascript:` を通さない）。
fn check_web_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).map_err(|e| e.to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme: {other}")),
    }
    Ok(parsed)
}

const APP_ORIGIN_REFUSED: &str = "refusing to open Pike's own origin";

fn parse_web_url(origin: &AppOrigin, url: &str) -> Result<Url, String> {
    let parsed = check_web_url(url)?;
    if origin.contains(&parsed) {
        return Err(APP_ORIGIN_REFUSED.to_owned());
    }
    Ok(parsed)
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
    pub(crate) fn rect(self) -> Rect {
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
    let origin = AppOrigin::of(&app);
    let url = parse_web_url(&origin, &url)?;
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
        // **ネイティブの D&D を切らないと、ページの中のドラッグが効かない**（#396）。
        // Windows では wry がウィンドウに OLE のドロップ先を張るので、有効なままだと
        // ページ上のドラッグが横取りされ、HTML5 の drag & drop が「禁止」のカーソルで
        // 止まる（Jira のカードを動かせない、という形で出た）。Pike 本体の webview は
        // 最初からこれを切ってある（`lib.rs` の `build_window` と `tauri.conf.json`）ので、
        // **子 webview だけが取り残されていた**。
        //
        // **代償がある**: wry が `SetAllowExternalDrop(false)` を呼ぶのは自前の
        // ハンドラを張るときだけ（`webview2/mod.rs`）なので、切ると WebView2 の既定の
        // 外部ドロップが復活する。つまり**ファイルを落とすとそのページが `file://` へ
        // 移動する**。それを止めるのが下の `on_navigation` のスキームの検査。
        .disable_drag_drop_handler()
        // **ページ自身の遷移（`location = …`）はコマンドを通らない。** アドレス欄の
        // 経路（`parse_web_url`）だけを塞いでも、ここが開いていれば同じことができる。
        // 弾くのは Pike 自身のオリジンと `file:` の 2 つだけ（`blob:` や `about:blank` は
        // 普通のページの動きなので、スキームの許可制にはしない）。
        .on_navigation(move |url| !origin.contains(url) && !is_local_file(url))
        .on_new_window(move |url, features| {
            // 列の色分けが色の表を送ってきた（#405）。開かずに読むだけ。受け付けるのは
            // Jira のページからだけ（他のサイトが同じ URL を開いても、色を書き換えさせない）。
            // **ページから Pike へ知らせる経路はここに集める**（ページには IPC が無い）。
            // 2 つ目ができたら、`pike.invalid/<channel>` を汎用の知らせにして振り分ける。
            if let Some(colors) = site_rules::parse_jira_colors_message(&url) {
                let from_jira = app
                    .get_webview(&opener_label)
                    .and_then(|w| w.url().ok())
                    .is_some_and(|u| site_rules::is_jira_host(&u));
                if from_jira {
                    let _ = app.emit_to(
                        EventTarget::window(&window_label),
                        "browser_jira_colors",
                        BrowserJiraColorsPayload {
                            label: opener_label.clone(),
                            colors,
                        },
                    );
                }
                return NewWindowResponse::Deny;
            }
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

/// Jira の列の色の表（ステータス名→色の名前）を開いているページへ渡す（#405）。読み込みが
/// 終わるたびと、設定が変わったときにフロントが呼ぶ。Jira 以外のページでは何もしない。
#[tauri::command]
pub async fn browser_jira_colors(
    app: AppHandle,
    label: String,
    colors: HashMap<String, String>,
) -> Result<(), String> {
    webview(&app, &label)?
        .eval(site_rules::jira_colors_script(&colors))
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
    let url = parse_web_url(&AppOrigin::of(&app), &url)?;
    webview(&app, &label)?
        .navigate(url)
        .map_err(|e| e.to_string())
}

/// 今いるページの URL（WebView2 の `Source`）。
///
/// **ページの中の移動（`history.pushState`）を拾う唯一の手**（#368）。イベントでは
/// 届かない: `on_page_load` も `on_navigation` も**文書の読み込みを伴う遷移でしか
/// 発火しない**（WebView2 の `NavigationStarting` / `NavigationCompleted`）。
/// `on_document_title_changed` に相乗りする形も試したが、**契機がページ側の都合**に
/// なる（タイトルを変えないサイトでは何も起きず、pushState より先にタイトルを変える
/// サイトでは前のページの URL を拾う）。`Source` のほうは pushState で更新されるので、
/// 契機だけをこちらから作る。
///
/// 差し込むスクリプトから知らせる形は採れない。ブラウザのタブの子 webview は
/// capability の対象外なので（モジュール doc）、ページから `invoke` は通らない。
#[tauri::command]
pub async fn browser_url(app: AppHandle, label: String) -> Result<String, String> {
    webview(&app, &label)?
        .url()
        .map(|u| u.to_string())
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

    /// ドロップで起きる `file://` への遷移を止める（#396）。`disable_drag_drop_handler`
    /// の代償を埋めるガードなので、普通のページの動きは通したままにする。
    #[test]
    fn refuses_local_files() {
        let local = |u: &str| is_local_file(&Url::parse(u).unwrap());
        assert!(local("file:///C:/Users/me/secret.txt"));
        assert!(local("file://host/share/x"));
        assert!(!local("https://example.com/a"));
        assert!(!local("about:blank"));
        assert!(!local("blob:https://example.com/1234"));
    }

    #[test]
    fn only_web_schemes() {
        assert!(check_web_url("https://example.atlassian.net/browse/X-1").is_ok());
        assert!(check_web_url(" http://localhost:3000 ").is_ok());
        assert!(check_web_url("file:///C:/Windows").is_err());
        assert!(check_web_url("javascript:alert(1)").is_err());
    }

    /// Pike 自身の配信オリジンへは移動させない（#368）。**スキームの検査だけでは
    /// 止まらない**のが要点で、Windows の独自プロトコルは http に載る。
    /// 製品ビルドでは `dev` が無いので `AppOrigin::default()` が実物と同じ形になる。
    #[test]
    fn refuses_the_app_origin() {
        let refused = |u: &str| AppOrigin::default().contains(&Url::parse(u).unwrap());
        assert!(refused("http://tauri.localhost/"));
        assert!(refused("https://tauri.localhost/index.html"));
        // 普通の localhost は通す（Docker のポートフォワードや開発中のサーバー）。
        assert!(!refused("http://localhost:3000"));
        // ホスト名の一部に含むだけのものは別物。
        assert!(!refused("https://tauri.localhost.example.com/"));
    }
}
