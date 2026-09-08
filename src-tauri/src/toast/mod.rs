//! デスクトップ通知（#318）。エージェントの入力待ち / 完了を Windows のトーストで
//! 知らせ、**押したらそのターミナルを持つウィンドウを前に出す**。
//!
//! ## なぜ公式プラグインを使わないか
//!
//! `tauri-plugin-notification` の desktop 実装は `notify_rust` へ投げっぱなしで、
//! クリックを受ける口がそもそも無い（`onAction` はモバイル専用）。押させたい知らせを
//! あれに載せられないことは `lib/notify.ts` の doc が言っているとおりで、ここは
//! `tauri-winrt-notification` を直接叩く（依存ツリーには `notify_rust` 経由で既にいる）。
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
//! `Toast` を持ち続ける必要は無い（実機で確認）。`show()` がハンドラを登録した時点で
//! COM 側が参照を取るので、Rust 側の値を drop してもクリックは返る。**送出した通知を
//! 覚えておく仕組みを足さないこと**: 溜めれば解放の契機（`on_dismissed`）が要るが、
//! 持たなければリークのしようがない。

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_winrt_notification::Toast;
    use windows::core::{Interface, GUID, HSTRING};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READWRITE,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    /// `PKEY_AppUserModel_ID`。`windows` crate の PKEY 定数は別 feature に入っているので、
    /// `jumplist` の `PKEY_TITLE` と同じく値を直接書く。
    const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    /// 1 件ぶんの依頼と、それを届ける先。
    struct Job {
        app: AppHandle,
        /// 押されたときに前へ出すウィンドウのラベル。
        window: String,
        /// どのターミナルの知らせか。**押されたときにそのままフロントへ返す**
        /// （`toast_activated`）ので、Rust 側はタブを知らなくてよい。
        pty: String,
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

    /// AUMID を書いたショートカットを用意する。**冪等**で、既に入っていれば読むだけ。
    ///
    /// **既存のファイルは読み込んでから書き足す。** インストール版のショートカットは
    /// NSIS が作ったもので、ターゲットも作業ディレクトリもあちらの持ち物。作り直すと
    /// その内容を Pike が決めることになる。
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
            if current_aumid(&store).as_deref() == Some(aumid) {
                return Ok(());
            }
        } else {
            // 開発版はここを通る。インストール版で NSIS のショートカットを消した人も。
            let exe = std::env::current_exe()?;
            let exe = HSTRING::from(exe.to_string_lossy().as_ref());
            link.SetPath(&exe)?;
            link.SetIconLocation(&exe, 0)?;
        }

        let pv = crate::types::lpwstr_propvariant(aumid)?;
        store.SetValue(&PKEY_APPUSERMODEL_ID, &pv)?;
        store.Commit()?;
        file.Save(&wide_path, true)?;
        Ok(())
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
                    // **ショートカットの用意は最初の 1 件のときだけ。** 通知を出さない人
                    // （設定が off、hook 未登録）のスタートメニューには何も置かない。
                    // 失敗しても再試行しない: 直らない類の失敗（APPDATA が読めない等）で
                    // 毎回 COM を叩いても仕方がないうえ、show() は試す価値がある。
                    let mut prepared = false;
                    while let Ok(job) = rx.recv() {
                        if !prepared {
                            prepared = true;
                            if let Err(e) = unsafe { ensure_shortcut(aumid) } {
                                log::warn!("[toast] shortcut setup failed: {e:?}");
                            }
                        }
                        show(aumid, job);
                    }
                })
                .expect("spawn toast thread");
            tx
        })
    }

    fn show(aumid: &str, job: Job) {
        let Job {
            app,
            window: label,
            pty,
            title,
            body,
        } = job;
        let toast = Toast::new(aumid)
            .title(&title)
            .text1(&body)
            .on_activated(move |_action| {
                // **コールバックは WinRT のスレッドプールで走る**ので、ウィンドウを
                // 直接触らずメインスレッドへ回す。`action` は `launch` 属性の値で、
                // 設定していないので常に空。**どのウィンドウかはここで capture した
                // ラベルが持つ**（アプリが生きているあいだのクリックだけが対象なので、
                // XML に載せて往復させる必要が無い）。
                let app = app.clone();
                let label = label.clone();
                let pty = pty.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    let Some(w) = app.get_webview_window(&label) else {
                        return;
                    };
                    crate::restore_window(&w);
                    // **そのタブまで連れて行くのはフロントの仕事**（別プロジェクトの
                    // タブなら切り替えが要り、その手順は `stores/project.ts` にある）。
                    // ここは pty id をそのまま返すだけで、タブを知らない。
                    let _ = w.emit("toast_activated", pty);
                });
                Ok(())
            });
        // **`on_dismissed` は登録しない。** 保持しないので解放する対象が無く、
        // 消えたことを知っても何もすることがない。
        if let Err(e) = toast.show() {
            log::warn!("[toast] show failed: {e:?}");
        }
    }

    /// トーストを 1 件出す。**呼ぶかどうかはフロントの設定（`desktopNotify`）が決める**
    /// ので、ここでは見ない（Rust 側に設定の写しを持たない）。
    pub fn notify(app: &AppHandle, window: String, pty: String, title: String, body: String) {
        let _ = worker().send(Job {
            app: app.clone(),
            window,
            pty,
            title,
            body,
        });
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
    pub fn notify(
        _app: &tauri::AppHandle,
        _window: String,
        _pty: String,
        _title: String,
        _body: String,
    ) {
    }
}

/// エージェントの知らせをデスクトップ通知で出す。
#[tauri::command]
pub fn toast_notify(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    pty: String,
    title: String,
    body: String,
) {
    imp::notify(&app, window.label().to_string(), pty, title, body);
}
