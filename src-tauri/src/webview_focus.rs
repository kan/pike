//! ウィンドウが得たフォーカスを Pike 本体の webview へ渡す（#439、WebView2 専用）。
//!
//! **`unstable` feature（#368）を有効にすると、Pike 本体の webview も子 webview として
//! 作られる**（`tauri-runtime-wry` が `build_as_child` を選ぶ）。wry が親ウィンドウの
//! `WM_SETFOCUS` を webview へ転送するのは子でない webview だけ（`attach_parent_subclass`）
//! なので、Alt+Tab・タスクバー・`restore_window` で前に出したときにフォーカスがネイティブの
//! ウィンドウに留まり、**ページ内をクリックするまで打鍵がどこにも届かない**。wry が張らなく
//! なったその転送を、同じ形（親ウィンドウのサブクラス）で張り直す。
//!
//! **`WindowEvent::Focused` には載せられない。** 子 webview を 1 つも足していないウィンドウ
//! （ブラウザのタブを開いていない普通の状態）では、Tauri は tao の Focused を捨てて webview の
//! `GotFocus` / `LostFocus` から合成する。webview がフォーカスを得ないかぎり、イベント自体が
//! 来ない。しかも合成された `Focused(true)` で `MoveFocus` を呼ぶと、既に持っている webview が
//! Lost → Got を繰り返してフォーカスが点滅し続ける（実機で確認）。`WM_SETFOCUS` は
//! ウィンドウ自身がフォーカスを得たときにしか来ないので、この往復が起きない。
//!
//! DOM のフォーカスをどのタブへ置くかはフロントの仕事で、ここは触らない。webview が
//! フォーカスを得ると `window` の `focus` が発火し、ターミナルはそれを見て xterm へ戻す
//! （`TerminalTab.vue` の `windowFocusHandler`）。エディタは DOM のフォーカスが残っている。
//!
//! 渡す先は常に Pike 本体で、ブラウザのタブのページに居たまま離れた場合も本体へ戻る。
//!
//! **`unstable` を外したら、このモジュールも外す**（wry の転送と二重になる）。
//!
//! 型の注意は `drop_paths.rs` と同じ: コントローラは webview2-com（wry と同じ版の
//! windows-core）、サブクラスの API は本体の windows 0.62。

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{WM_NCDESTROY, WM_SETFOCUS};

/// wry の `PARENT_SUBCLASS_ID` などと重ならない、このモジュールだけの番号。
const SUBCLASS_ID: usize = 0x50_69_6B_65; // "Pike"

/// ウィンドウを作った直後に呼ぶ（`drop_paths::attach` と対）。`with_webview` は
/// メインスレッド＝ウィンドウの所有スレッドでクロージャを走らせる。
pub fn attach(window: &WebviewWindow) {
    let Some(hwnd) = crate::win32_hwnd(&window.as_ref().window(), "webview_focus") else {
        return;
    };
    // `HWND` は `Send` でないので、クロージャへは整数で運ぶ。
    let hwnd = hwnd.0 as isize;
    let _ = window.with_webview(move |webview| unsafe {
        let controller = Box::into_raw(Box::new(webview.controller()));
        let installed = SetWindowSubclass(
            HWND(hwnd as *mut _),
            Some(subclass_proc),
            SUBCLASS_ID,
            controller as usize,
        );
        if !installed.as_bool() {
            drop(Box::from_raw(controller));
        }
    });
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    refdata: usize,
) -> LRESULT {
    unsafe {
        let controller = refdata as *mut ICoreWebView2Controller;
        match msg {
            WM_SETFOCUS => {
                let _ = (*controller).MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                drop(Box::from_raw(controller));
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}
