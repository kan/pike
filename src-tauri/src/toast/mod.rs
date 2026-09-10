//! デスクトップ通知（#318）。エージェントの入力待ち / 完了を Windows のトーストで
//! 知らせ、**押したらそのターミナルを持つウィンドウを前に出す**。
//!
//! ## なぜ公式プラグインを使わないか
//!
//! `tauri-plugin-notification` の desktop 実装は `notify_rust` へ投げっぱなしで、
//! クリックを受ける口がそもそも無い（`onAction` はモバイル専用）。押させたい知らせを
//! あれに載せられないことは `lib/notify.ts` の doc が言っているとおり。
//!
//! ## XML を自前で組む理由（#334）
//!
//! 押されたことを受けるのは**プロトコル活性化**（`activation.rs` の doc が正本）で、
//! そのためには `<toast>` に `activationType="protocol"` と `launch` を書く必要がある。
//! `tauri-winrt-notification` はテンプレートを内部で組み立てていて、この 2 つを書く口が
//! 無い（出せる属性は `duration` と `scenario` だけ）。WinRT の口（`XmlDocument` ＋
//! `ToastNotification`）は `windows` crate に既にあるので、そこだけ直に叩く。
//!
//! ## AUMID とショートカット
//!
//! **未パッケージのデスクトップアプリがトーストを出すには、スタートメニューの
//! ショートカットに AppUserModelID が書かれていることが要る。** #265 でこの機能を
//! 一度作って外したのは、それが無い状態で試して「バナーも出ず通知センターへ直行し、
//! クリックも返らない」を踏んだため。今回は Pike 自身がショートカットを用意する。
//!
//! **プロセスの AUMID は設定しない**（`SetCurrentProcessExplicitAppUserModelID` を
//! 呼ばない）。実機で確かめたところ、それ無しで `on_activated` は発火する。呼ぶと
//! タスクバーのグループ化がその AUMID になり、ジャンプリストの `SetAppID` と
//! ピン留めまで巻き込む（`project.md` の「AUMID は明示設定しない」）。**要らないなら
//! 触らない**。
//!
//! ## 保持しない
//!
//! 送出した通知を覚えておく仕組みは持たない。**#334 で活性化がプロセスの外へ出た**ので、
//! 押されたことを受けるのに Rust 側の値が生きている必要すらなくなった（Windows が
//! `launch` の URL で新しい `pike.exe` を起こし、single-instance が走っているほうへ
//! 転送する）。

pub mod activation;

#[cfg(windows)]
mod imp {
    use super::activation::{scheme, Activation};
    use std::path::PathBuf;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::OnceLock;
    use windows::core::{Interface, GUID, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READWRITE,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    /// `PKEY_AppUserModel_ID`。`windows` crate の PKEY 定数は別 feature に入っているので、
    /// `jumplist` の `PKEY_TITLE` と同じく値を直接書く。
    const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    /// `PKEY_AppUserModel_ToastActivatorCLSID`（#334）。AUMID と同じ fmtid の pid 26。
    const PKEY_TOAST_ACTIVATOR_CLSID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 26,
    };

    /// ショートカットに書く活性化 CLSID（#334）。
    ///
    /// **COM サーバーは実装しない**（スタブ）。Microsoft が挙げている 2 案のうち
    /// 「スタブ CLSID ＋ プロトコル活性化」を採ったので、Windows がここを CoCreate して
    /// 失敗したあと `launch` の URL へ落ちる。値は固定であればよく、**ビルドで分けない**:
    /// 分ける先のショートカットが既に別（`link_name`）なので、同じ値でも取り違えない。
    const TOAST_ACTIVATOR_CLSID: GUID = GUID::from_u128(0xc221827b_dacc_4e32_a805_a991753a6af8);

    /// 1 件ぶんの依頼。
    ///
    /// **ウィンドウのラベルは持たない**（#334）。押されたことを受けるのはプロトコル
    /// 経由になり、そのころ**このプロセスは生きていないことがある**ので、宛先は
    /// 「今どのウィンドウにあるか」ではなく「何を探せばよいか」（pty とプロジェクト）で
    /// 持つ。
    struct Job {
        /// どのターミナルの知らせか。
        pty: String,
        /// そのタブの持ち主。pty が見つからないときの行き先（#334）。
        project: Option<String>,
        /// 太字で出る 1 行目。
        title: String,
        /// 2 行目（何が起きたか）。
        body: String,
    }

    /// スタートメニューに置くショートカットの名前。
    ///
    /// **インストール版は NSIS が作る名前（`productName`）に合わせる。** 違う綴りで
    /// 作ると同じアプリの入口が 2 つ並ぶので、既にあるファイルへ AUMID を書き足す形に
    /// なる（`ensure_shortcut`）。開発版はショートカットを持たないので新しく作る。
    ///
    /// 判定は `types::app_identifier` と同じ `cfg!(debug_assertions)` だが、あちらは
    /// identifier でこちらは表示名なので、値を導き合えない。
    ///
    /// **開発版のショートカットは押しても使えない**（AUMID を Windows へ登録するためだけに
    /// ある）。デバッグビルドは `devUrl` を読むので Vite が要り、コンソールを隠す
    /// `windows_subsystem` も release にしか付かない。押すと端末が開いて「このページに
    /// 到達できません」になるのが正しい姿で、開発版は従来どおり `just dev` から起動する。
    ///
    /// **明示 AUMID を書いても、タスクバーのグループ化とジャンプリストは変わらない**
    /// （実機で確認）。プロセス側の AUMID を設定していないので、`project.md` の
    /// 「AUMID は明示設定しない」はそのまま保たれる。
    fn link_name() -> &'static str {
        if cfg!(debug_assertions) {
            "Pike (dev).lnk"
        } else {
            "Pike.lnk"
        }
    }

    /// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\<名前>`。
    ///
    /// **見るのはユーザー単位のスタートメニューだけ**（NSIS の既定の置き場）。MSI で
    /// 入れた場合は WiX がマシン単位の `ProgramMenuFolder\Pike\Pike.lnk` に置くので、
    /// ここからは見えず 2 つ目の「Pike」ができる。**既知の制約として据え置く**: MSI は
    /// 既に PATH の追加も「プログラムから開く」の登録も受けない扱い（CLAUDE.md の
    /// 「NSIS 推奨の理由の 1 つ」）で、しかもマシン単位の置き場は管理者権限が無いと
    /// 書けないので、探す範囲を広げても書き足せずに終わる。
    fn link_path() -> Option<PathBuf> {
        let appdata = std::env::var_os("APPDATA")?;
        Some(
            PathBuf::from(appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs")
                .join(link_name()),
        )
    }

    /// ショートカットに既に入っている AUMID。**書いてあるかを見るためだけ**なので、
    /// 自分が書いた形（VT_LPWSTR）以外は「無い」でよい。
    unsafe fn current_aumid(store: &IPropertyStore) -> Option<String> {
        let pv = store.GetValue(&PKEY_APPUSERMODEL_ID).ok()?;
        let inner = &*pv.Anonymous.Anonymous;
        if inner.vt != VT_LPWSTR {
            return None;
        }
        let p = inner.Anonymous.pwszVal;
        (!p.is_null()).then(|| p.to_string().ok()).flatten()
    }

    /// 既に入っている活性化 CLSID（#334）。AUMID と同じく、読むのは「書いてあるか」だけ。
    unsafe fn current_activator(store: &IPropertyStore) -> Option<GUID> {
        use windows::Win32::System::Variant::VT_CLSID;
        let pv = store.GetValue(&PKEY_TOAST_ACTIVATOR_CLSID).ok()?;
        let inner = &*pv.Anonymous.Anonymous;
        if inner.vt != VT_CLSID {
            return None;
        }
        let p = inner.Anonymous.puuid;
        (!p.is_null()).then(|| *p)
    }

    /// AUMID と活性化 CLSID を書いたショートカットを用意する。**冪等**で、既に両方
    /// 入っていれば読むだけ。
    ///
    /// **既存のファイルは読み込んでから書き足す。** インストール版のショートカットは
    /// NSIS が作ったもので、ターゲットも作業ディレクトリもあちらの持ち物。作り直すと
    /// その内容を Pike が決めることになる。
    ///
    /// **CLSID を書くと、画面上のトーストもプロトコル経由になる**（#334。`activation.rs` の
    /// doc）。だから「既に AUMID がある」だけで戻らないこと: #318 の版が書いた
    /// ショートカットには CLSID が無く、そのままでは通知センターからのクリックが死ぬ。
    unsafe fn ensure_shortcut(aumid: &str) -> windows::core::Result<()> {
        let Some(path) = link_path() else {
            return Ok(());
        };
        let wide_path = HSTRING::from(path.to_string_lossy().as_ref());
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        // どちらも同じオブジェクトへのインターフェースなので、1 回ずつ取れば足りる
        // （`Load` はこのあとでよく、読む側も書く側も同じ `store` を見る）。
        let file: IPersistFile = link.cast()?;
        let store: IPropertyStore = link.cast()?;

        if path.is_file() {
            file.Load(&wide_path, STGM_READWRITE)?;
            if current_aumid(&store).as_deref() == Some(aumid)
                && current_activator(&store) == Some(TOAST_ACTIVATOR_CLSID)
            {
                return Ok(());
            }
        } else {
            // 開発版はここを通る。インストール版で NSIS のショートカットを消した人も。
            //
            // **開発版のショートカットを消す経路は持たない。** `cargo clean` のあとは
            // リンク先の無いショートカットがスタートメニューに残るが、消す先は
            // `cargo run --bin verify_toast -- remove`（インストール版の `Pike.lnk` は
            // NSIS のアンインストーラが持っていく）。
            let exe = std::env::current_exe()?;
            let exe = HSTRING::from(exe.to_string_lossy().as_ref());
            link.SetPath(&exe)?;
            link.SetIconLocation(&exe, 0)?;
        }

        let pv = crate::types::lpwstr_propvariant(aumid)?;
        store.SetValue(&PKEY_APPUSERMODEL_ID, &pv)?;
        let pv = crate::types::clsid_propvariant(TOAST_ACTIVATOR_CLSID)?;
        store.SetValue(&PKEY_TOAST_ACTIVATOR_CLSID, &pv)?;
        store.Commit()?;
        file.Save(&wide_path, true)?;
        Ok(())
    }

    /// `pike://` を自分の exe に紐付ける（#334）。**冪等**で、同じ行が既に入っていれば
    /// 何も書かない。
    ///
    /// **書くのは HKCU**（`HKEY_CLASSES_ROOT` はマシン全体で、管理者権限が要る）。
    /// インストーラではなくアプリ自身が書くのは、開発版と、既に入れてある版の両方を
    /// 同じ経路で賄うため（インストーラに足すと、更新しない限り登録されない）。
    unsafe fn ensure_protocol() -> windows::core::Result<()> {
        let exe = std::env::current_exe()?;
        let command = format!("\"{}\" \"%1\"", exe.to_string_lossy());
        let root = format!(r"Software\Classes\{}", scheme());
        // シェルが「URL のハンドラ」と見なすのに要る 2 つ。値の中身は表示用で、
        // 判定に使われるのは `URL Protocol` が**在ること**だけ。**名前はショートカットと
        // 揃える**（`Pike` / `Pike (dev)`）: identifier をそのまま書くと、レジストリを
        // 覗いた人に `URL:com.pike.dev.debug Protocol` という綴りが見える。
        let name = link_name().trim_end_matches(".lnk");
        write_reg(&root, None, &format!("URL:{name} Protocol"))?;
        write_reg(&root, Some("URL Protocol"), "")?;
        write_reg(&format!(r"{root}\shell\open\command"), None, &command)
    }

    /// HKCU の 1 つの値を書く（既に同じ値なら書かない）。`value` が `None` は既定値。
    unsafe fn write_reg(path: &str, value: Option<&str>, data: &str) -> windows::core::Result<()> {
        use windows::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE,
            REG_OPTION_NON_VOLATILE,
        };
        let mut key = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &HSTRING::from(path),
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_READ | KEY_WRITE,
            None,
            &mut key,
            None,
        )
        .ok()?;
        // **開いた鍵は必ず閉じる**（この関数は通知のたびには呼ばれないが、失敗しても
        // 漏らさない形にしておく）。
        let result = write_value(key, value, data);
        let _ = RegCloseKey(key);
        result
    }

    unsafe fn write_value(
        key: windows::Win32::System::Registry::HKEY,
        value: Option<&str>,
        data: &str,
    ) -> windows::core::Result<()> {
        use windows::Win32::System::Registry::{RegQueryValueExW, RegSetValueExW, REG_SZ};
        let name = value.map(HSTRING::from);
        let name = name
            .as_ref()
            .map(|n| windows::core::PCWSTR(n.as_ptr()))
            .unwrap_or(windows::core::PCWSTR::null());
        // 同じ値なら書かない。レジストリは他人も見る場所なので、起動のたびに更新時刻を
        // 動かさない。
        let existing = {
            // **`u16` のバッファで受ける。** `Vec<u8>` の先頭を `*const u16` として読むのは
            // 未整列参照（実際のアロケータでは整列するが、仕様上は UB）。
            // 入らなければ `ERROR_MORE_DATA` で失敗し、「違う値」として書き直すだけ
            // （書く内容は同じなので実害は無い）。exe のパス 1 本ぶんの余裕は取る。
            let mut buf = vec![0u16; 1024];
            let mut size = (buf.len() * 2) as u32;
            let ok = RegQueryValueExW(
                key,
                name,
                None,
                None,
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut size),
            )
            .is_ok();
            ok.then(|| {
                let len = (size as usize / 2).min(buf.len());
                String::from_utf16_lossy(&buf[..len])
                    .trim_end_matches('\0')
                    .to_string()
            })
        };
        if existing.as_deref() == Some(data) {
            return Ok(());
        }
        let wide: Vec<u16> = data.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
        RegSetValueExW(key, name, None, REG_SZ, Some(bytes)).ok()
    }

    /// 常駐スレッドへの送信口。初回の通知でスレッドを起こす。
    ///
    /// **専用スレッドが要るのは COM のため。** Tauri のコマンドは tokio のワーカーで
    /// 走るので初期化されておらず、`ShellLink` は STA を要求する（`jumplist` と同じ）。
    /// ここは Pike と同じ寿命で他に COM を使う者もいないので、初期化しっぱなしにする。
    ///
    /// **溜まったジョブを間引かないこと**（`jumplist` はそうしている）。あちらは同じ
    /// 一覧を作り直す冪等な仕事だが、通知は 1 件ずつ別の出来事を指す。
    fn worker() -> &'static Sender<Job> {
        static W: OnceLock<Sender<Job>> = OnceLock::new();
        W.get_or_init(|| {
            let (tx, rx) = channel::<Job>();
            std::thread::Builder::new()
                .name("toast".into())
                .spawn(move || {
                    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
                        log::warn!("[toast] CoInitializeEx failed; desktop notifications disabled");
                        return;
                    }
                    let aumid = crate::types::app_identifier();
                    // **用意は最初の 1 件のときだけ。** 通知を出さない人（設定が off、
                    // hook 未登録）のスタートメニューにもレジストリにも何も置かない。
                    // 失敗しても再試行しない: 直らない類の失敗（APPDATA が読めない等）で
                    // 毎回 COM を叩いても仕方がないうえ、show() は試す価値がある。
                    let mut prepared = false;
                    while let Ok(job) = rx.recv() {
                        if !prepared {
                            prepared = true;
                            if let Err(e) = unsafe { ensure_shortcut(aumid) } {
                                log::warn!("[toast] shortcut setup failed: {e:?}");
                            }
                            // **ショートカットと対**（#334）。CLSID を書いた時点で活性化は
                            // プロトコル経由になるので、宛先が無いと押しても何も起きない。
                            if let Err(e) = unsafe { ensure_protocol() } {
                                log::warn!("[toast] protocol setup failed: {e:?}");
                            }
                        }
                        show(aumid, job);
                    }
                })
                .expect("spawn toast thread");
            tx
        })
    }

    /// トーストの XML。**`launch` と `activationType` を書くために自前で組む**（モジュール
    /// doc）。テンプレートは `ToastGeneric`: CLSID を指定したトーストでは、`ToastText02`
    /// のようなレガシーテンプレートだと活性化が失敗する。
    fn toast_xml(launch: &str, title: &str, body: &str) -> String {
        format!(
            r#"<toast activationType="protocol" launch="{}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
            xml_escape(launch),
            xml_escape(title),
            xml_escape(body)
        )
    }

    /// XML の属性とテキストに入れてよい形にする。**`launch` はクエリ（`&`）を含む**ので、
    /// これを通さないと `LoadXml` がその場で失敗する（＝通知が 1 件も出なくなる）。
    fn xml_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                _ => out.push(c),
            }
        }
        out
    }

    fn show(aumid: &str, job: Job) {
        let Job {
            pty,
            project,
            title,
            body,
        } = job;
        // **どのタブかは URL が持つ**（#334）。押されるのは数時間後でもよく、そのころ
        // この プロセスは生きていないことがある。
        let launch = Activation { pty, project }.to_url();
        if let Err(e) = show_xml(aumid, &toast_xml(&launch, &title, &body)) {
            log::warn!("[toast] show failed: {e:?}");
        }
    }

    fn show_xml(aumid: &str, xml: &str) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))?.Show(&toast)
    }

    /// トーストを 1 件出す。**呼ぶかどうかはフロントの設定（`desktopNotify`）が決める**
    /// ので、ここでは見ない（Rust 側に設定の写しを持たない）。
    pub fn notify(pty: String, project: Option<String>, title: String, body: String) {
        let _ = worker().send(Job {
            pty,
            project,
            title,
            body,
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// `launch` のクエリの `&` を escape しないと、`LoadXml` がその場で失敗して
        /// **通知が 1 件も出なくなる**。
        #[test]
        fn escapes_the_launch_url() {
            let xml = toast_xml("pike://focus?pty=a&project=b", "t", "b");
            assert!(xml.contains("pty=a&amp;project=b"));
            assert!(!xml.contains("pty=a&project=b"));
        }

        /// 見出しと本文にも人の書いた文字列が入る（プロジェクト名・タブ名）。
        #[test]
        fn escapes_the_text() {
            let xml = toast_xml("pike://focus?pty=a", "a<b>", "x & y");
            assert!(xml.contains("a&lt;b&gt;"));
            assert!(xml.contains("x &amp; y"));
        }
    }
}

/// 配送も AUMID も Windows のものなので、他の OS では何もしない。**入力待ちの知らせ
/// （#265）自体が Windows 限定**（`agent_hook` の hook をそこでしか登録しない）なので、
/// ここに届く経路もそもそも無い。
///
/// **依頼を構造体で受けないこと。** そうすると非 Windows ではフィールドが 1 つも読まれず、
/// `dead_code` が `-D warnings` に当たって**macOS の CI だけが落ちる**（`platform.md` の
/// 死角そのもので、Windows の手元では 1 行も見えない）。引数なら `_` を付ければ済む。
#[cfg(not(windows))]
mod imp {
    pub fn notify(_pty: String, _project: Option<String>, _title: String, _body: String) {}
}

/// エージェントの知らせをデスクトップ通知で出す。
///
/// **`project` はタブの持ち主**（#334）。押されたときに pty が見つからなくても、そこまでは
/// 連れて行けるように通知そのものへ載せる（通知センターからは数時間後に押されうる）。
#[tauri::command]
pub fn toast_notify(pty: String, project: Option<String>, title: String, body: String) {
    imp::notify(pty, project, title, body);
}
