//! デスクトップ通知（#318 → #334）の前提確認。**通知センターからのクリックは実機でしか
//! 確かめられない**（画面上のトーストとは別の経路を通る）ので、その道具。
//!
//! Usage:
//!   cargo run --bin verify_toast -- shortcut   # AUMID + 活性化 CLSID 付きの .lnk を作る
//!   cargo run --bin verify_toast -- protocol   # pike-dev:// を自分の exe に紐付ける
//!   cargo run --bin verify_toast -- toast      # プロトコル活性化のトーストを出す
//!   cargo run --bin verify_toast -- remove     # ショートカットを消す
//!
//! 確かめたいこと（#334）:
//!   1. AUMID と `PKEY_AppUserModel_ToastActivatorCLSID` の両方を書いた `.lnk` を作れるか
//!   2. `activationType="protocol"` のトーストがバナーとして出るか
//!   3. **バナーを押したときと、通知センターへ送ってから押したときの両方で**、
//!      `launch` の URL のハンドラ（＝この exe）が起動するか
//!   4. アプリを終了したあとのクリックでも起動するか
//!
//! 3 と 4 が #318 の版（インプロセスの `on_activated`）では成り立たなかった。CLSID を
//! 書いた時点でインプロセスの経路は消えるので、**両方が同じ URL 経由になる**のが狙い。
//!
//! この exe が URL で起動されたときは、受け取った argv をそのまま出して終わる
//! （`pike.exe` 側は `lib.rs` の `try_handle_activation` が受ける）。

/// Windows のシェル API と WinRT に依存するので中身ごと Windows 専用。**アイテムごとに
/// `#[cfg(windows)]` を付けないこと**（`verify_busy.rs` と同じ理由）。
#[cfg(windows)]
mod imp {
    use std::path::PathBuf;
    use windows::core::{Interface, GUID, HSTRING, PCWSTR, PWSTR};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Win32::Foundation::{E_OUTOFMEMORY, PROPERTYKEY};
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    use windows::Win32::System::Variant::{VT_CLSID, VT_LPWSTR};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    /// 検証で使う AUMID。開発版の identifier に合わせる（`types::app_identifier`）。
    const AUMID: &str = "com.pike.dev.debug";

    /// 検証で使う URI スキーム。開発版のもの（`toast::activation::scheme`）。
    const SCHEME: &str = "pike-dev";

    /// スタートメニューに置くショートカットの名前。**これが通知の送信元名として出る**
    /// ので、インストール版（`Pike`）と区別できる綴りにする。
    const LINK_NAME: &str = "Pike (dev).lnk";

    /// `PKEY_AppUserModel_ID` と `PKEY_AppUserModel_ToastActivatorCLSID`。`windows` crate の
    /// PKEY 定数は feature が要るので、`toast/mod.rs` と同じく値を直接書く。
    const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };
    const PKEY_TOAST_ACTIVATOR_CLSID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 26,
    };

    /// 本体と同じスタブ CLSID（`toast/mod.rs` の `TOAST_ACTIVATOR_CLSID`）。
    const ACTIVATOR: GUID = GUID::from_u128(0xc221827b_dacc_4e32_a805_a991753a6af8);

    fn link_path() -> Option<PathBuf> {
        let appdata = std::env::var_os("APPDATA")?;
        Some(
            PathBuf::from(appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs")
                .join(LINK_NAME),
        )
    }

    /// ショートカットが指す先。実運用では `pike.exe` なので、隣にあればそれを使う。
    fn target_exe() -> PathBuf {
        let me = std::env::current_exe().expect("current_exe");
        let sibling = me.with_file_name("pike.exe");
        if sibling.is_file() {
            sibling
        } else {
            me
        }
    }

    fn init_com() -> bool {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok()
    }

    /// VT_LPWSTR の PROPVARIANT（`types::lpwstr_propvariant` と同じ手組み。crate の
    /// `From<&str>` は VT_BSTR になり、AUMID としては読まれない）。
    unsafe fn lpwstr_propvariant(s: &str) -> windows::core::Result<PROPVARIANT> {
        let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
        let mem = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
        if mem.is_null() {
            return Err(windows::core::Error::from(E_OUTOFMEMORY));
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), mem, wide.len());
        Ok(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_LPWSTR,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        pwszVal: PWSTR(mem),
                    },
                }),
            },
        })
    }

    /// VT_CLSID の PROPVARIANT（`types::clsid_propvariant` と同じ）。
    unsafe fn clsid_propvariant(guid: GUID) -> windows::core::Result<PROPVARIANT> {
        let mem = CoTaskMemAlloc(std::mem::size_of::<GUID>()) as *mut GUID;
        if mem.is_null() {
            return Err(windows::core::Error::from(E_OUTOFMEMORY));
        }
        std::ptr::write(mem, guid);
        Ok(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_CLSID,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 { puuid: mem },
                }),
            },
        })
    }

    /// 1: AUMID と活性化 CLSID を書いたショートカットを作る。
    fn make_shortcut() {
        let Some(path) = link_path() else {
            println!("  [1] APPDATA が読めない");
            return;
        };
        let exe = target_exe();
        println!("  [1] 作成先: {}", path.display());
        println!("      ターゲット: {}", exe.display());
        println!("      AUMID: {AUMID} / CLSID: {ACTIVATOR:?}");

        // `?` を使うのでクロージャに包む（`unsafe` ブロックは式なので、そのままだと
        // 呼び出し側の関数から抜けようとする）。
        let result: windows::core::Result<()> = (|| unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.to_string_lossy().as_ref()))?;
            link.SetIconLocation(&HSTRING::from(exe.to_string_lossy().as_ref()), 0)?;
            if let Some(dir) = exe.parent() {
                link.SetWorkingDirectory(&HSTRING::from(dir.to_string_lossy().as_ref()))?;
            }
            let store: IPropertyStore = link.cast()?;
            // AUMID は通知の身元（#265 が踏んだ壁）。CLSID は通知センターからの活性化を
            // プロトコルへ落とすための目印（#334）。**両方要る。**
            let pv = lpwstr_propvariant(AUMID)?;
            store.SetValue(&PKEY_APPUSERMODEL_ID, &pv)?;
            let pv = clsid_propvariant(ACTIVATOR)?;
            store.SetValue(&PKEY_TOAST_ACTIVATOR_CLSID, &pv)?;
            store.Commit()?;

            let file: IPersistFile = link.cast()?;
            file.Save(&HSTRING::from(path.to_string_lossy().as_ref()), true)?;
            Ok(())
        })();
        match result {
            Ok(()) => println!("      => 作成した（スタートメニューを検索して確認できる）"),
            Err(e) => println!("      => 失敗: {e:?}"),
        }
    }

    /// 2: URI スキームをこの exe に紐付ける。
    fn register_protocol() {
        let exe = target_exe();
        let command = format!("\"{}\" \"%1\"", exe.to_string_lossy());
        println!("  [2] HKCU\\Software\\Classes\\{SCHEME}");
        println!("      command: {command}");
        let result: windows::core::Result<()> = unsafe {
            (|| {
                let root = format!(r"Software\Classes\{SCHEME}");
                write_reg(&root, None, "URL:Pike (dev) Protocol")?;
                write_reg(&root, Some("URL Protocol"), "")?;
                write_reg(&format!(r"{root}\shell\open\command"), None, &command)
            })()
        };
        match result {
            Ok(()) => println!("      => 登録した（`start {SCHEME}://focus?pty=x` で試せる）"),
            Err(e) => println!("      => 失敗: {e:?}"),
        }
    }

    unsafe fn write_reg(path: &str, value: Option<&str>, data: &str) -> windows::core::Result<()> {
        let mut key = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &HSTRING::from(path),
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        )
        .ok()?;
        let name = value.map(HSTRING::from);
        let name = name
            .as_ref()
            .map(|n| PCWSTR(n.as_ptr()))
            .unwrap_or(PCWSTR::null());
        let wide: Vec<u16> = data.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
        let result = RegSetValueExW(key, name, None, REG_SZ, Some(bytes)).ok();
        let _ = RegCloseKey(key);
        result
    }

    /// ショートカットの後始末。
    fn remove_shortcut() {
        let Some(path) = link_path() else { return };
        match std::fs::remove_file(&path) {
            Ok(()) => println!("  削除した: {}", path.display()),
            Err(e) => println!("  削除できない ({}): {e}", path.display()),
        }
    }

    /// 3〜4: プロトコル活性化のトーストを出す。**待たない**（押されたときに起動するのは
    /// この プロセスではなく、URL のハンドラとして起こされる新しいプロセス）。
    fn show_toast() {
        match link_path() {
            Some(p) if p.is_file() => println!("  ショートカット: あり ({})", p.display()),
            Some(p) => {
                println!("  ショートカット: **無い** ({})", p.display());
                println!("  => まず `shortcut` と `protocol` を実行すること");
            }
            None => println!("  ショートカット: APPDATA が読めず判定できない"),
        }

        let launch = format!("{SCHEME}://focus?pty=verify-toast");
        let xml = format!(
            r#"<toast activationType="protocol" launch="{launch}"><visual><binding template="ToastGeneric"><text>Pike</text><text>押すと {SCHEME}:// のハンドラが起動するはず（#334 の検証）</text></binding></visual></toast>"#
        );
        let result: windows::core::Result<()> = (|| {
            let doc = XmlDocument::new()?;
            doc.LoadXml(&HSTRING::from(xml.as_str()))?;
            let toast = ToastNotification::CreateToastNotification(&doc)?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)
        })();
        match result {
            Ok(()) => {
                println!("  show(): 成功（バナーが出たかは目で確認する）");
                println!("  1) バナーを押す  2) バナーを消して通知センターから押す");
                println!("  どちらでも新しいプロセスが起動し、argv に {launch} が入る");
            }
            Err(e) => {
                println!("  show(): 失敗: {e:?}");
                println!("  => AUMID が登録されていない可能性が高い（`shortcut` を先に）");
            }
        }
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        // URL で起こされた側。**受け取ったことだけを見せて終わる**（本体の受け口は
        // `lib.rs` の `try_handle_activation`）。
        if let Some(url) = args.iter().find(|a| a.starts_with(&format!("{SCHEME}://"))) {
            println!("=== verify_toast (activated) ===");
            println!("  受け取った URL: {url}");
            println!("=== Complete ===");
            return;
        }
        let cmd = args.first().map(String::as_str).unwrap_or("toast");

        if !init_com() {
            println!("CoInitializeEx が失敗した");
            return;
        }

        println!("=== verify_toast ({cmd}) ===");
        match cmd {
            "shortcut" => make_shortcut(),
            "protocol" => register_protocol(),
            "remove" => remove_shortcut(),
            "toast" => show_toast(),
            other => {
                println!("知らないサブコマンド: {other}（shortcut / protocol / toast / remove）")
            }
        }
        println!("=== Complete ===");
    }
}

#[cfg(windows)]
fn main() {
    imp::run();
}

/// 非 Windows でもビルド対象には入る（cargo は `src/bin/*.rs` を自動で拾う）ため、
/// main だけは常に生やしておく。
#[cfg(not(windows))]
fn main() {
    eprintln!("verify_toast は Windows 専用です（WinRT のトーストと AUMID の確認）");
}
