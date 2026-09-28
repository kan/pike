//! ログイン時に Pike を起動する（#419）。
//!
//! **正本はレジストリで、Pike の設定には持たない。** HKCU の `Run` キーに exe を登録すると、
//! Windows の「設定 > アプリ > スタートアップ」にも Pike が出て、そこからも切り替えられる。
//! そちらで切ったときは `Run` の値は残ったまま `StartupApproved\Run` に無効の印が付くので、
//! 読むときは両方を見る（Pike の設定画面と Windows の表示が食い違わないように）。マシンに
//! 結び付く値なので、設定の同期にも乗せない。
//!
//! macOS では持たない（何もしない stub。`platform.md` の「macOS で持たない機能」）。

#[cfg(windows)]
mod imp {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
        RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    /// Windows の設定画面で切り替えたときの印。値は 12 バイトで、先頭のバイトが奇数なら無効。
    const APPROVED_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    /// `Run` の値の名前。スタートアップの一覧にはこの名前が出る。**開発版と分ける**
    /// （同じ名前だと、開発版で切り替えたときにインストール版の登録を書き換える）。
    const VALUE_NAME: &str = if cfg!(debug_assertions) {
        "Pike (dev)"
    } else {
        "Pike"
    };

    /// 見つからないのは「無い」の答えで、失敗ではない。
    fn missing_ok(e: WIN32_ERROR) -> Result<(), String> {
        if e.is_ok() || e == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(windows::core::Error::from(e.to_hresult()).to_string())
        }
    }

    pub fn enabled() -> bool {
        let name = HSTRING::from(VALUE_NAME);
        // SAFETY: バッファを渡さない問い合わせ（在るかだけを見る）。
        let registered = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                &name,
                RRF_RT_REG_SZ,
                None,
                None,
                None,
            )
        }
        .is_ok();
        if !registered {
            return false;
        }
        // 普通は 12 バイトだが、長い値で `ERROR_MORE_DATA` になると「印が無い＝有効」と
        // 読み違えるので余裕を取る。
        let mut buf = [0u8; 64];
        let mut size = buf.len() as u32;
        // SAFETY: `buf` と `size` はこの関数の中で生きている。
        let approved = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(APPROVED_KEY),
                &name,
                RRF_RT_REG_BINARY,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        // 印が無ければ有効（登録しただけの状態）。
        !approved.is_ok() || size == 0 || buf[0] & 1 == 0
    }

    pub fn set(on: bool) -> Result<(), String> {
        let name = HSTRING::from(VALUE_NAME);
        // 切り替えのたびに Windows 側の印を消す。有効にするときに残っていると、
        // `Run` に書いても無効のままになる。
        // SAFETY: 文字列はどれも呼び出しのあいだ生きている。
        missing_ok(unsafe {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(APPROVED_KEY), &name)
        })?;
        if !on {
            // SAFETY: 同上。
            return missing_ok(unsafe {
                RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(RUN_KEY), &name)
            });
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let command = format!("\"{}\"", exe.to_string_lossy());
        let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` は呼び出しのあいだ生きており、長さはバイト数で渡す。
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                &name,
                REG_SZ.0,
                Some(wide.as_ptr().cast()),
                (wide.len() * 2) as u32,
            )
        }
        .ok()
        .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn enabled() -> bool {
        false
    }

    pub fn set(_on: bool) -> Result<(), String> {
        Err("autostart is only supported on Windows".to_owned())
    }
}

/// ログイン時に起動するか（Windows の設定画面で切った状態も「しない」と答える）。
#[tauri::command]
pub async fn autostart_get() -> Result<bool, String> {
    tokio::task::spawn_blocking(imp::enabled)
        .await
        .map_err(|e| e.to_string())
}

/// ログイン時の起動を切り替える。有効にすると、今動いている exe を登録する。
#[tauri::command]
pub async fn autostart_set(enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || imp::set(enabled))
        .await
        .map_err(|e| e.to_string())?
}
