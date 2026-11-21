//! Windows のファイル / フォルダ選択ダイアログ（#638）。シェルのコモンアイテムダイアログ
//! （`IFileOpenDialog` / `IFileSaveDialog`）を Pike のプロセスの中で直に出す。
//!
//! **PowerShell + WinForms に戻さないこと。** 以前は別プロセスの PowerShell で出していて、
//! 押してから見えるまでに 2 秒前後かかり、しかもダイアログが前面に出なかった（Pike の
//! ウィンドウの裏に出て、出ていないように見える）。理由は `.claude/rules/platform.md` の
//! 「ダイアログ」。ここでは Pike のウィンドウを owner にするので、プロセスの起動も前面の
//! ロックも無い。pwsh の WinForms（.NET 5+）が出していたのも同じダイアログなので、見た目と
//! 操作（アドレス欄・ナビゲーションペインの「Linux」）は変わらない。
//!
//! **ダイアログごとに専用の STA スレッドを立てる。** シェルのダイアログは STA でしか動かず、
//! `Show` はダイアログが閉じるまで戻らない（中で自分のメッセージループを回す）。
//! メインスレッドに載せると、閉じるまで Tauri のイベントループが入れ子のループの上で
//! 動くことになり、WSL の UNC の解決で詰まったときにイベントループごと止まる（ジャンプ
//! リストが踏んだのと同じ形。`.claude/rules/os-integration.md` の「COM スレッド」）。tokio の
//! ブロッキング用のスレッドは使い回されるので、アパートメントを持ち込まない。
//!
//! **別スレッドでも入力までは切り離せない。** owner がメインスレッドのウィンドウなので、
//! Windows は 2 つのスレッドの入力キューを結合する。`Show` の中（ダイアログが出たあと）で
//! ダイアログのスレッドが詰まると、Pike のウィンドウへの入力も届かなくなりうる（描画・IPC・
//! PTY は動き続ける）。そのため**初期位置の解決（`parse_item`）は `Show` の前、ウィンドウが
//! まだ無いうちに済ませている**。WSL の起動を待つのはそこで、そのあいだ Pike は普通に使える。
//! owner を外せばこの結合は無くなるが、ダイアログがモーダルでなくなり、前面に出る保証も
//! 弱くなる（#638 の症状の半分）。

use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
    CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FILEOPENDIALOGOPTIONS, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, FileOpenDialog, FileSaveDialog,
    IFileDialog, IFileOpenDialog, IFileSaveDialog, IShellItem, SHCreateItemFromParsingName,
    SIGDN_FILESYSPATH,
};
use windows::core::{GUID, Interface};
use windows::core::{HRESULT, HSTRING, PCWSTR};

/// ダイアログの owner。`HWND` は `Send` でないので、スレッドへは整数で渡す。
pub type Owner = Option<isize>;

/// `job` を専用の STA スレッドで走らせ、その結果を返す。
async fn on_sta_thread<F>(job: F) -> Result<Option<String>, String>
where
    F: FnOnce() -> windows::core::Result<Option<String>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("dialog".into())
        .spawn(move || {
            // SAFETY: このスレッドで最初の COM の呼び出し。失敗したら COM に触らずに返す。
            let init =
                unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            if init.is_err() {
                let _ = tx.send(Err(describe(&init.into())));
                return;
            }
            // COM のオブジェクトは `job` の中で作って捨てるので、ここでは全部解放済み。
            let result = job().map_err(|e| describe(&e));
            // SAFETY: 上の CoInitializeEx と対。
            unsafe { CoUninitialize() };
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

/// フロントへ返すエラーの文字列。**HRESULT を必ず添える**（文言を持たない HRESULT では
/// `message()` が空になり、空のエラーが届く）。
fn describe(e: &windows::core::Error) -> String {
    format!("{} ({})", e.message(), e.code())
}

fn parse_item(path: &str) -> windows::core::Result<IShellItem> {
    // SAFETY: HSTRING は呼び出しのあいだ生きている。
    unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }
}

/// 初期位置のフォルダを開き、開けたかを返す。**実在しないと失敗するので、そのときは既定の
/// 位置のまま出す**（消えたディレクトリや止まっている WSL を渡されたとき。ダイアログを
/// 出さずに終わると、押しても何も起きないように見える）。
fn set_folder(dialog: &IFileDialog, dir: &str) -> bool {
    // SAFETY: どちらも生きている COM のオブジェクト。
    match parse_item(dir).and_then(|item| unsafe { dialog.SetFolder(&item) }) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("[dialog] initial folder not usable: {e}");
            false
        }
    }
}

/// シェルのダイアログを作る（`FileOpenDialog` / `FileSaveDialog`）。
fn create<T: Interface>(clsid: &GUID) -> windows::core::Result<T> {
    // SAFETY: STA を初期化したスレッドからだけ呼ぶ（`on_sta_thread`）。
    unsafe { CoCreateInstance(clsid, None, CLSCTX_INPROC_SERVER) }
}

/// オプションを足し、owner の上に出して、選ばれたパスを返す。キャンセルは `None`。
///
/// **`FOS_FORCEFILESYSTEM` を必ず足す。** 無いとライブラリや「PC」のような
/// ファイルシステムに無い場所も選べてしまい、`SIGDN_FILESYSPATH` でパスにできない。
fn show(
    dialog: &IFileDialog,
    owner: Owner,
    extra: FILEOPENDIALOGOPTIONS,
) -> windows::core::Result<Option<String>> {
    // SAFETY: 以下はどれも、このスレッドで作った生きている COM のオブジェクトへの呼び出し。
    // `GetDisplayName` が返す文字列は CoTaskMemAlloc したもので、読んだあと解放する。
    unsafe {
        let options = dialog.GetOptions()?;
        dialog.SetOptions(options | FOS_FORCEFILESYSTEM | extra)?;
        let owner = owner.map(|h| HWND(h as *mut _));
        if let Err(e) = dialog.Show(owner) {
            return if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                Ok(None)
            } else {
                Err(e)
            };
        }
        let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = String::from_utf16_lossy(name.as_wide());
        CoTaskMemFree(Some(name.0 as *const _));
        Ok(if path.is_empty() { None } else { Some(path) })
    }
}

/// フォルダ選択。`initial` の扱いは pwsh の `FolderBrowserDialog.SelectedPath` に合わせる:
/// **親のフォルダを開き、`initial` 自身を名前の欄に入れて選んだ状態にする**（そのまま
/// 「フォルダーの選択」を押せば `initial` が返る）。親が無い（ドライブや UNC の共有の
/// 直下）か開けないときは、`initial` をそのまま名前の欄に入れる。
pub async fn folder(owner: Owner, initial: Option<String>) -> Result<Option<String>, String> {
    on_sta_thread(move || {
        let dialog: IFileOpenDialog = create(&FileOpenDialog)?;
        if let Some(initial) = initial.filter(|p| !p.is_empty()) {
            let path = std::path::Path::new(&initial);
            let opened = path
                .parent()
                .is_some_and(|p| set_folder(&dialog, &p.to_string_lossy()));
            let name = match path.file_name() {
                Some(leaf) if opened => HSTRING::from(leaf),
                _ => HSTRING::from(initial.as_str()),
            };
            // SAFETY: 生きている COM のオブジェクトへの呼び出し。
            unsafe { dialog.SetFileName(&name)? };
        }
        show(&dialog, owner, FOS_PICKFOLDERS)
    })
    .await
}

/// ファイルを開く。`extensions` は呼び出し側で英数字だけに絞ってあり、空なら絞らない
/// （#410）。`initial` は初期位置のディレクトリ。
pub async fn open(
    owner: Owner,
    extensions: Vec<String>,
    initial: Option<String>,
) -> Result<Option<String>, String> {
    on_sta_thread(move || {
        let dialog: IFileOpenDialog = create(&FileOpenDialog)?;
        if !extensions.is_empty() {
            // WinForms の `Filter = "*.a;*.b|*.a;*.b"` と同じく、パターンを表示名にも使う。
            let patterns = HSTRING::from(
                extensions
                    .iter()
                    .map(|e| format!("*.{e}"))
                    .collect::<Vec<_>>()
                    .join(";"),
            );
            let spec = COMDLG_FILTERSPEC {
                pszName: PCWSTR(patterns.as_ptr()),
                pszSpec: PCWSTR(patterns.as_ptr()),
            };
            // SAFETY: `patterns` は呼び出しのあいだ生きている（ダイアログが写し取る）。
            unsafe { dialog.SetFileTypes(&[spec])? };
        }
        if let Some(dir) = initial.filter(|p| !p.is_empty()) {
            let _ = set_folder(&dialog, &dir);
        }
        show(&dialog, owner, FILEOPENDIALOGOPTIONS(0))
    })
    .await
}

/// 保存先の選択。`default_name` を名前の欄に入れる。上書きの確認はダイアログの既定
/// （`FOS_OVERWRITEPROMPT`）が出す。
pub async fn save(owner: Owner, default_name: Option<String>) -> Result<Option<String>, String> {
    on_sta_thread(move || {
        let dialog: IFileSaveDialog = create(&FileSaveDialog)?;
        if let Some(name) = default_name.filter(|n| !n.is_empty()) {
            // SAFETY: 生きている COM のオブジェクトへの呼び出し。
            unsafe { dialog.SetFileName(&HSTRING::from(name))? };
        }
        show(&dialog, owner, FILEOPENDIALOGOPTIONS(0))
    })
    .await
}
