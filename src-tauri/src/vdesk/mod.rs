//! 仮想デスクトップ（Windows の公開 COM API `IVirtualDesktopManager`）。
//!
//! 3 つの問いをここに集める。**どれも同じインターフェースを開く**ので、別々の場所で
//! `CoCreateInstance` を書くと、COM の作法（初期化・失敗時の落とし方）が枝ごとに散る。
//!
//! - そのウィンドウは今見えているデスクトップに居るか（`on_current`）
//! - どのデスクトップに居るか（`desktop_id`、#317）
//! - そこへ戻す（`move_to`、#317）
//!
//! ## 消えたデスクトップは作り直せない（#317）
//!
//! 公開 API にできるのは「既にあるデスクトップへ移す」までで、保存した GUID の
//! デスクトップが無くなっていれば `MoveWindowToDesktop` は失敗する。呼び出し側は
//! 現在のデスクトップに出す側へ落とす。作り直しは非公開の
//! `IVirtualDesktopManagerInternal` の領分で、**Windows のビルド更新で壊れる前提**の
//! ものなので採らない。
//!
//! ## GUID の持ち方
//!
//! 文字列（`XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`）で持つ。`GUID` の `Debug` が
//! この形を出し、`TryFrom<&str>` が同じ形を受けるので往復する。数値（`u128`）より
//! これを採るのは、レジストリ（`HKCU\...\Explorer\VirtualDesktops`）に入っている
//! 綴りと目で突き合わせられるため。

#[cfg(windows)]
mod imp {
    use tauri::WebviewWindow;
    use windows::core::GUID;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

    /// デスクトップが決まっていないウィンドウ（最小化中・未表示）に返る値。
    const NULL_GUID: GUID = GUID::from_u128(0);

    /// このスレッドの COM を、使うあいだだけ初期化する。
    ///
    /// **対で解除するのが要点**（#317）。`record_all` はウィンドウを動かすたびに tokio の
    /// ワーカースレッドから走る（500ms デバウンス）ので、入れっぱなしにすると
    /// **メッセージポンプを持たないワーカーが恒久的に STA のまま残り**、初期化の参照
    /// カウントも増え続ける。
    ///
    /// 既に初期化済みのスレッド（メインは WebView2 が STA にしている）では
    /// `RPC_E_CHANGED_MODE` が返る。**そのときは解除もしない**: このスコープが作った
    /// 初期化ではないので、減らすと他人のぶんを削る。
    struct ComScope(bool);

    impl ComScope {
        fn enter() -> Self {
            Self(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
        }
    }

    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// **呼び出し側は `ComScope` を先に作ること。** ローカル変数は宣言の逆順に drop される
    /// ので、スコープを先に宣言しておけば COM オブジェクトのほうが先に解放される（順序が
    /// 逆だと、生きているオブジェクトを残したまま `CoUninitialize` することになる）。
    fn manager(tag: &str) -> Option<IVirtualDesktopManager> {
        match unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL) } {
            Ok(m) => Some(m),
            Err(e) => {
                log::warn!("[vdesk] {tag}: CoCreateInstance failed: {e}");
                None
            }
        }
    }

    /// **`WM_COPYDATA` / `SendMessage` の文脈から呼ばないこと。** 入力同期メッセージの
    /// 中では COM 呼び出しが `RPC_E_CANTCALLOUT_ININPUTSYNCCALL` で失敗する。
    ///
    /// COM が使えないときは `true`（見えているものとして扱う）。この答えはウィンドウを
    /// 選ぶ側が使うので、判定できないなら候補から外さないほうが安全。
    pub fn on_current(window: &WebviewWindow) -> bool {
        let _com = ComScope::enter();
        let Some(hwnd) = crate::win32_hwnd(window, "vdesk") else {
            return true;
        };
        let Some(manager) = manager("on_current") else {
            return true;
        };
        match unsafe { manager.IsWindowOnCurrentVirtualDesktop(hwnd) } {
            Ok(b) => b.as_bool(),
            Err(e) => {
                log::warn!("[vdesk] IsWindowOnCurrentVirtualDesktop failed: {e}");
                true
            }
        }
    }

    /// 今いる仮想デスクトップ。**まだ決まっていなければ `None`**（最小化中や未表示では
    /// `GUID_NULL` が返る）。覚えても復元先にならないので、呼び出し側は前の値を残す。
    pub fn desktop_id(window: &WebviewWindow) -> Option<String> {
        let _com = ComScope::enter();
        let hwnd = crate::win32_hwnd(window, "vdesk")?;
        let id = match unsafe { manager("desktop_id")?.GetWindowDesktopId(hwnd) } {
            Ok(id) => id,
            Err(e) => {
                log::warn!("[vdesk] GetWindowDesktopId failed: {e}");
                return None;
            }
        };
        (id != NULL_GUID).then(|| format!("{id:?}"))
    }

    /// 保存しておいたデスクトップへ移す。**そのデスクトップが無ければ失敗する**ので、
    /// 呼び出し側は現在のデスクトップに出す側へ落とす。
    pub fn move_to(window: &WebviewWindow, id: &str) -> bool {
        let _com = ComScope::enter();
        let Ok(guid) = GUID::try_from(id) else {
            log::warn!("[vdesk] not a guid: {id}");
            return false;
        };
        let Some(hwnd) = crate::win32_hwnd(window, "vdesk") else {
            return false;
        };
        let Some(manager) = manager("move_to") else {
            return false;
        };
        match unsafe { manager.MoveWindowToDesktop(hwnd, &guid) } {
            Ok(()) => true,
            Err(e) => {
                log::warn!("[vdesk] MoveWindowToDesktop({id}) failed: {e}");
                false
            }
        }
    }
}

/// 仮想デスクトップという概念が無い OS。**呼び出し側は分岐しない**（`platform.md`）。
#[cfg(not(windows))]
mod imp {
    use tauri::WebviewWindow;

    /// 隠れているデスクトップが無いので、常に見えている。
    pub fn on_current(_window: &WebviewWindow) -> bool {
        true
    }

    pub fn desktop_id(_window: &WebviewWindow) -> Option<String> {
        None
    }

    pub fn move_to(_window: &WebviewWindow, _id: &str) -> bool {
        false
    }
}

pub use imp::{desktop_id, move_to, on_current};
