//! DOM ドロップ → 実ファイルパス解決ブリッジ（WebView2 専用）。
//!
//! Pike は HTML5 D&D（タブ並べ替え・ファイルツリー移動）を生かすために
//! Tauri ネイティブ D&D を無効化している（`disable_drag_drop_handler`）。
//! その代償として、OS からのファイルドロップは DOM の File オブジェクトで
//! 届き、フルパスを持たない。WebView2 の `postMessageWithAdditionalObjects`
//! は DOM File を host に渡すと `ICoreWebView2File::Path` で実パスが取れる、
//! まさにこの用途の API なので、各ウィンドウの CoreWebView2 に
//! `WebMessageReceived` ハンドラを追加して受ける。
//!
//! JS 側（src/lib/dropPaths.ts）は `pike:drop-paths:{id}` という文字列
//! メッセージ + File 群を post し、Rust 側が各ファイルのパスと is_dir を
//! 解決して同ウィンドウへ `drop_paths` イベント（`{ id, entries }`）で返す。
//! wry 自身の IPC も同じ WebMessageReceived を使うが、COM のイベントは
//! 多重購読できるため共存する（プレフィックス不一致のメッセージは無視）。
//!
//! 型の注意: webview2-com 0.38 の COM 型は windows-core 0.61 系。本体で使う
//! windows 0.62 とは別インスタンスなので、ここでは `windows_core`（0.61）の
//! Interface / PWSTR を使う（Cargo.toml のコメント参照）。

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropPathEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Clone, Serialize)]
pub struct DropPathsPayload {
    pub id: String,
    pub entries: Vec<DropPathEntry>,
}

/// Must match the message prefix in src/lib/dropPaths.ts
const MESSAGE_PREFIX: &str = "pike:drop-paths:";

/// Attach the WebMessageReceived bridge to a window's CoreWebView2.
/// Safe to call right after window creation; `with_webview` defers the
/// closure until the platform webview exists.
pub fn attach(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let _ = window.with_webview(move |webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
        };
        use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
        use windows_core::Interface;

        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            // Non-string messages and wry's own IPC traffic: ignore silently.
            let mut raw = windows_core::PWSTR::null();
            if args.TryGetWebMessageAsString(&mut raw).is_err() {
                return Ok(());
            }
            let msg = take_pwstr(raw);
            let Some(id) = msg.strip_prefix(MESSAGE_PREFIX) else {
                return Ok(());
            };

            let mut entries = Vec::new();
            if let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                if let Ok(objects) = args2.AdditionalObjects() {
                    let mut count = 0u32;
                    if objects.Count(&mut count).is_ok() {
                        for i in 0..count {
                            let Ok(obj) = objects.GetValueAtIndex(i) else {
                                continue;
                            };
                            let Ok(file) = obj.cast::<ICoreWebView2File>() else {
                                continue;
                            };
                            let mut p = windows_core::PWSTR::null();
                            if file.Path(&mut p).is_err() {
                                continue;
                            }
                            let path = take_pwstr(p);
                            if path.is_empty() {
                                continue;
                            }
                            let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
                            entries.push(DropPathEntry { path, is_dir });
                        }
                    }
                }
            }

            let _ = app.emit_to(
                label.as_str(),
                "drop_paths",
                DropPathsPayload { id: id.to_string(), entries },
            );
            Ok(())
        }));
        // Never unregistered: the handler lives as long as the webview/window.
        let mut token = 0i64;
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    });
}
