//! デスクトップ通知（#318）の前提確認。**#265 で一度作って外した機能の再挑戦**なので、
//! 実装より先に「何が本当に要るのか」を実機で押さえるための道具。
//!
//! Usage:
//!   cargo run --bin verify_toast -- shortcut          # AUMID 付きショートカットを作る
//!   cargo run --bin verify_toast -- toast             # トーストを出してクリックを待つ
//!   cargo run --bin verify_toast -- toast --process-aumid  # プロセス AUMID も設定して出す
//!   cargo run --bin verify_toast -- toast --drop      # Toast を drop してからクリックを待つ
//!   cargo run --bin verify_toast -- toast --no-shortcut-check
//!   cargo run --bin verify_toast -- remove            # ショートカットを消す
//!
//! 確かめたいこと（#265 の実測は「AUMID を書いたショートカットが無いと、バナーも出ず
//! 通知センターへ直行し、クリックも返らない」だった）:
//!   1. `IShellLinkW` + `IPropertyStore` で AUMID 付きの `.lnk` を作れるか
//!   2. その AUMID のトーストが**バナーとして**出るか（通知センター直行でないか）
//!   3. クリックで `on_activated` が発火するか。**プロセス AUMID を設定しない状態で**
//!      （設定が要るなら、ジャンプリストの `SetAppID` とタスクバーのピン留めまで巻き込む）
//!   4. `Toast` を保持しないとハンドラが死ぬのか（crate の `show()` は `ToastNotification` を
//!      その場で drop するので、保持が要るかは実物に聞くしかない）
//!   5. `on_dismissed` が来るか（リークを防ぐ解放の契機に使えるか）

/// Windows のシェル API と WinRT に依存するので中身ごと Windows 専用。**アイテムごとに
/// `#[cfg(windows)]` を付けないこと**（`verify_busy.rs` と同じ理由）。
#[cfg(windows)]
mod imp {
    use std::path::PathBuf;
    use std::sync::mpsc::{channel, Sender};
    use std::time::Duration;
    use tauri_winrt_notification::{Toast, ToastDismissalReason};
    use windows::core::{Interface, GUID, HSTRING, PWSTR};
    use windows::Win32::Foundation::{E_OUTOFMEMORY, PROPERTYKEY};
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };

    /// 検証で使う AUMID。開発版の identifier に合わせる（`types::app_identifier`）。
    const AUMID: &str = "com.pike.dev.debug";

    /// スタートメニューに置くショートカットの名前。**これが通知の送信元名として出る**
    /// ので、インストール版（`Pike`）と区別できる綴りにする。
    const LINK_NAME: &str = "Pike (dev).lnk";

    /// `PKEY_AppUserModel_ID`。`windows` crate の PKEY 定数は feature が要るので、
    /// ジャンプリストの `PKEY_TITLE` と同じく値を直接書く。
    const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    /// クリック / 消滅を待つ上限。押されるまで手で操作するので長めに取る。
    const WAIT: Duration = Duration::from_secs(60);

    /// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\<LINK_NAME>`。
    fn link_path() -> Option<PathBuf> {
        let appdata = std::env::var_os("APPDATA")?;
        Some(
            PathBuf::from(appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs")
                .join(LINK_NAME),
        )
    }

    /// ショートカットが指す先。実運用では `pike.exe` なので、隣にあればそれを使う
    /// （無ければこの検証バイナリ自身。通知の身元としてしか使わないので、どちらでも
    /// 「出るか」は確かめられる）。
    fn target_exe() -> PathBuf {
        let me = std::env::current_exe().expect("current_exe");
        let sibling = me.with_file_name("pike.exe");
        if sibling.is_file() {
            sibling
        } else {
            me
        }
    }

    /// COM を STA で初期化する。`jumplist` と違って使い捨てのプロセスなので、
    /// 解除は考えない。
    fn init_com() -> bool {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok()
    }

    /// VT_LPWSTR の PROPVARIANT（`jumplist::title_propvariant` と同じ手組み。crate の
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

    /// 1: AUMID 付きショートカットを作る。
    fn make_shortcut() {
        let Some(path) = link_path() else {
            println!("  [1] APPDATA が読めない");
            return;
        };
        let exe = target_exe();
        println!("  [1] 作成先: {}", path.display());
        println!("      ターゲット: {}", exe.display());
        println!("      AUMID: {AUMID}");

        // `?` を使うのでクロージャに包む（`unsafe` ブロックは式なので、そのままだと
        // 呼び出し側の関数から抜けようとする）。
        let result: windows::core::Result<()> = (|| unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.to_string_lossy().as_ref()))?;
            link.SetIconLocation(&HSTRING::from(exe.to_string_lossy().as_ref()), 0)?;
            if let Some(dir) = exe.parent() {
                link.SetWorkingDirectory(&HSTRING::from(dir.to_string_lossy().as_ref()))?;
            }
            // ここが要点。**これが無いと通知の身元が決まらない**（#265 が踏んだ壁）。
            let store: IPropertyStore = link.cast()?;
            let pv = lpwstr_propvariant(AUMID)?;
            store.SetValue(&PKEY_APPUSERMODEL_ID, &pv)?;
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

    /// ショートカットの後始末。
    fn remove_shortcut() {
        let Some(path) = link_path() else { return };
        match std::fs::remove_file(&path) {
            Ok(()) => println!("  削除した: {}", path.display()),
            Err(e) => println!("  削除できない ({}): {e}", path.display()),
        }
    }

    /// 押されたか消えたかの知らせ。
    enum Event {
        Activated(Option<String>),
        Dismissed(Option<ToastDismissalReason>),
    }

    /// 2〜5: トーストを出して待つ。
    fn show_toast(process_aumid: bool, drop_toast: bool, check_shortcut: bool) {
        if check_shortcut {
            match link_path() {
                Some(p) if p.is_file() => println!("  ショートカット: あり ({})", p.display()),
                Some(p) => {
                    println!("  ショートカット: **無い** ({})", p.display());
                    println!(
                        "  => まず `shortcut` を実行すること（#265 はこの状態で試して失敗した）"
                    );
                }
                None => println!("  ショートカット: APPDATA が読めず判定できない"),
            }
        }

        if process_aumid {
            // **B の検証。** これを呼ぶとタスクバーのグループ化がこの AUMID になるので、
            // 要るかどうかで実装の範囲（ジャンプリストの SetAppID・ピン留め）が変わる。
            let r = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)) };
            println!("  プロセス AUMID: 設定した ({r:?})");
        } else {
            println!("  プロセス AUMID: 設定しない（A の検証）");
        }

        let (tx, rx) = channel::<Event>();
        let tx_act: Sender<Event> = tx.clone();
        let tx_dis: Sender<Event> = tx;

        let toast = Toast::new(AUMID)
            .title("Pike")
            .text1("クリックするとこのプロセスに通知が返るはず（#318 の検証）")
            .on_activated(move |action| {
                let _ = tx_act.send(Event::Activated(action));
                Ok(())
            })
            .on_dismissed(move |reason| {
                let _ = tx_dis.send(Event::Dismissed(reason));
                Ok(())
            });

        match toast.show() {
            Ok(()) => println!("  show(): 成功（バナーが出たかは目で確認する）"),
            Err(e) => {
                println!("  show(): 失敗: {e:?}");
                println!("  => AUMID が登録されていない可能性が高い");
                return;
            }
        }

        // **4 の検証。** crate の `show()` は `ToastNotification` をその場で drop するので、
        // `Toast` 側の保持が要るのかを分けて見る。待つあいだ生かしておくのが既定。
        let held = if drop_toast {
            println!("  Toast を drop した（保持しなくてもハンドラが生きるかを見る）");
            None
        } else {
            Some(toast)
        };

        println!(
            "  {} 秒待つ。トーストを押す / 無視する / × で閉じる を試すこと",
            WAIT.as_secs()
        );
        match rx.recv_timeout(WAIT) {
            Ok(Event::Activated(action)) => {
                println!("  => on_activated が来た。action={action:?}");
                println!(
                    "     （action は launch 属性の値。クロージャの capture で足りるので空でよい）"
                );
            }
            Ok(Event::Dismissed(reason)) => {
                println!("  => on_dismissed が来た。reason={reason:?}");
                println!("     もう一度実行して、今度は押してみること");
            }
            Err(e) => {
                println!("  => 何も来なかった ({e})");
                println!("     バナーが出ていたなら、押しても返らない＝#265 と同じ壁");
                println!("     バナーが出ていなかったなら、AUMID の登録から見直す");
            }
        }
        drop(held);
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let cmd = args.first().map(String::as_str).unwrap_or("toast");
        let has = |flag: &str| args.iter().any(|a| a == flag);

        if !init_com() {
            println!("CoInitializeEx が失敗した");
            return;
        }

        println!("=== verify_toast ({cmd}) ===");
        match cmd {
            "shortcut" => make_shortcut(),
            "remove" => remove_shortcut(),
            "toast" => show_toast(
                has("--process-aumid"),
                has("--drop"),
                !has("--no-shortcut-check"),
            ),
            other => println!("知らないサブコマンド: {other}（shortcut / toast / remove）"),
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
