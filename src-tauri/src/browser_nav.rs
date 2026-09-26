//! ブラウザのタブの移動を WebView2 のイベントで見分ける（#416）。
//!
//! 閲覧履歴（#412）は、Tauri の API だけでは近似するしかなかった。
//!
//! - **リダイレクト** … ユーザーの操作による移動かを Tauri が出していないので、「読み込んでから
//!   3 秒以内に次へ移ったら前のページを載せない」で近似していた
//! - **ページの中の移動**（`pushState`）… `on_page_load` が発火しないので、1 秒ごとに
//!   `browser_url` を引いていた
//!
//! WebView2 の COM にはどちらもイベントがあるので、子 webview の `ICoreWebView2` で直接受けて
//! フロントへ送る（配線は `drop_paths.rs` と同じ `with_webview`）。
//!
//! - `NavigationStarting` → `browser_navigation_starting`（ユーザーの操作による移動か）
//! - `SourceChanged` で `IsNewDocument` が偽のもの → `browser_same_document`（ページの中の移動）
//!
//! **Pike 自身が起こした移動（アドレス欄・戻る・進む・再読み込み）は、WebView2 から見ると
//! ユーザーの操作ではない**（`Navigate` の API と、ページの中で走らせる `history.back()`）。
//! ここでは区別せずにそのまま送り、フロントが送る前に待っているページを載せておく
//! （`BrowserTab.vue` の `leaveByUser`）。Pike の移動はどれもフロントから始まるので、
//! Rust で「次の移動は Pike のもの」を覚えておく必要が無い。
//!
//! **macOS の WKWebView には同じイベントが無い**ので、`attach` は何もしない。フロントは
//! ホストで分岐して、そちらでは従来の近似を使う（`lib/browserVisits.ts`）。

use tauri::Webview;

#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationStartingPayload {
    label: String,
    user_initiated: bool,
}

#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
struct SameDocumentPayload {
    label: String,
    url: String,
}

/// COM の `BOOL` を返す getter を読む。読めなければ偽。
#[cfg(windows)]
fn read_bool(get: impl FnOnce(&mut windows_core::BOOL) -> windows_core::Result<()>) -> bool {
    let mut value = windows_core::BOOL::default();
    get(&mut value).is_ok() && value.as_bool()
}

#[cfg(windows)]
pub(crate) fn attach(webview: &Webview) {
    use crate::browser::emit_to_owner;
    use tauri::Manager;

    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    let _ = webview.with_webview(move |platform| unsafe {
        use webview2_com::{take_pwstr, NavigationStartingEventHandler, SourceChangedEventHandler};

        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };

        let starting = {
            let app = app.clone();
            let label = label.clone();
            NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                // サーバーのリダイレクト（3xx）は同じ移動の続きなので、最初の 1 回だけ見る。
                // `on_navigation` が止めた移動（`file:` など）は、ページが替わらないので知らせない。
                // wry のハンドラが先に登録されているので、止めたかどうかはここで読める。
                if read_bool(|v| args.IsRedirected(v)) || read_bool(|v| args.Cancel(v)) {
                    return Ok(());
                }
                let Some(view) = app.get_webview(&label) else {
                    return Ok(());
                };
                emit_to_owner(
                    &view,
                    "browser_navigation_starting",
                    NavigationStartingPayload {
                        label: label.clone(),
                        user_initiated: read_bool(|v| args.IsUserInitiated(v)),
                    },
                );
                Ok(())
            }))
        };

        let source_changed = {
            let app = app.clone();
            let label = label.clone();
            SourceChangedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else {
                    return Ok(());
                };
                // 新しい文書は読み込みの完了（`on_page_load`）が届ける。
                if read_bool(|v| args.IsNewDocument(v)) {
                    return Ok(());
                }
                let mut raw = windows_core::PWSTR::null();
                if sender.Source(&mut raw).is_err() {
                    return Ok(());
                }
                let Some(view) = app.get_webview(&label) else {
                    return Ok(());
                };
                emit_to_owner(
                    &view,
                    "browser_same_document",
                    SameDocumentPayload {
                        label: label.clone(),
                        url: take_pwstr(raw),
                    },
                );
                Ok(())
            }))
        };

        // 外さない: ハンドラは webview と一緒に消える（`drop_paths::attach` と同じ）。
        let mut token = 0i64;
        let _ = core.add_NavigationStarting(&starting, &mut token);
        let _ = core.add_SourceChanged(&source_changed, &mut token);
    });
}

#[cfg(not(windows))]
pub(crate) fn attach(_webview: &Webview) {}
