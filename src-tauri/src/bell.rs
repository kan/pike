//! ターミナルの BEL で OS のシステム音を鳴らす（#481）。
//!
//! xterm.js は v5 で音を鳴らす機能（`bellStyle` / `bellSound`）を外し、今は `onBell` を
//! 出すだけなので、鳴らすのは組み込む側の仕事になる。**音は OS に任せる**: 音量・ミュート・
//! サウンドの設定（警告音を消している人には鳴らない）にそのまま従い、Pike 独自の音を持たない。
//! 鳴らすかどうか（設定）と連打の間引きはフロントが持つ（`src/lib/bell.ts`）。

/// システムの既定の警告音を鳴らす。
///
/// **同期の `fn` にしてある。** Tauri は同期のコマンドをメインスレッドで動かすので、
/// macOS の `NSBeep`（AppKit）の要件をそれで満たす。どちらの OS も鳴らすのを待たずに返る。
#[tauri::command]
pub fn system_beep() {
    #[cfg(windows)]
    {
        use windows::Win32::System::Diagnostics::Debug::MessageBeep;
        use windows::Win32::UI::WindowsAndMessaging::MB_OK;
        // MB_OK は「一般の警告音」（サウンドの設定の「既定のビープ音」）。
        // SAFETY: 引数を取らない単純な Win32 呼び出し。
        if let Err(e) = unsafe { MessageBeep(MB_OK) } {
            log::warn!("[bell] MessageBeep failed: {e}");
        }
    }
    #[cfg(target_os = "macos")]
    objc2_app_kit::NSBeep();
}
