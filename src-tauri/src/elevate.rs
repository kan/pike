//! Windows 管理者権限（昇格）連携。
//!
//! ConPTY は Pike プロセス配下に子シェルを spawn するため、非昇格ウィンドウ内に
//! 昇格タブを混在させることはできない。代わりに `ShellExecuteW` の `runas` で
//! Pike 自身を管理者権限の別インスタンスとして起動し、そのウィンドウでグローバル
//! ターミナルを 1 タブ開く（#138）。対象は Windows シェルのみ（WSL は対象外）。

/// 現在のプロセスが昇格（管理者トークン）で動作しているか。
#[cfg(windows)]
pub fn is_process_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_process_elevated() -> bool {
    false
}

#[tauri::command]
pub fn is_elevated() -> bool {
    is_process_elevated()
}

/// 昇格起動を許可する Windows シェル種別（ShellConfig の serde タグと一致）。
/// WSL は意図的に除外する。
fn is_windows_shell_kind(kind: &str) -> bool {
    matches!(kind, "cmd" | "powershell" | "pwsh" | "git-bash")
}

/// 指定シェルのターミナルを、管理者権限の別 Pike インスタンスで開く。UAC 承認後に
/// `--new-instance` 付きで自身を再起動する（single-instance をスキップし、昇格
/// インスタンスが非昇格の既存インスタンスへ引数転送されるのを防ぐ）。
///
/// - `project_id` あり: 呼び出し元がプロジェクトウィンドウ。同じプロジェクトを
///   通常モードで開き、そのシェルのターミナルを 1 タブ開く（モード引き継ぎ）。
/// - `project_id` なし: グローバルモード。グローバルターミナルとして開く。
#[tauri::command]
pub fn open_elevated_terminal(
    shell: String,
    project_id: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    if !is_windows_shell_kind(&shell) {
        return Err(format!("unsupported shell for elevation: {shell}"));
    }
    if let Some(id) = project_id.as_deref() {
        crate::types::validate_slug(id, "project id")?;
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut params = vec!["--new-instance".to_string()];
        match project_id.filter(|s| !s.is_empty()) {
            Some(id) => {
                params.push(format!("--open-project={id}"));
                params.push(format!("--shell={shell}"));
            }
            None => {
                params.push("--terminal".to_string());
                params.push(format!("--shell={shell}"));
                if let Some(c) = cwd.filter(|c| !c.is_empty()) {
                    params.push(format!("--cwd={c}"));
                }
            }
        }
        run_elevated(&exe, &params)
    }
    #[cfg(not(windows))]
    {
        let _ = cwd;
        Err("elevation is only supported on Windows".to_string())
    }
}

#[cfg(windows)]
fn run_elevated(exe: &std::path::Path, params: &[String]) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // スペースを含む引数（cwd パス）は引用符で囲む。シェル種別は許可リストで
    // 検証済み、それ以外の引数は固定文字列なので注入の余地はない。
    let joined = params
        .iter()
        .map(|p| {
            if p.contains(' ') {
                format!("\"{p}\"")
            } else {
                p.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    let verb = HSTRING::from("runas");
    let file = HSTRING::from(&*exe.to_string_lossy());
    let args = HSTRING::from(joined.as_str());

    let ret = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(args.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW は HINSTANCE 相当を返し、値が 32 超なら成功。UAC キャンセルは
    // SE_ERR_ACCESSDENIED(5) 等の小さい値になる。
    if ret.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "elevation failed or was cancelled (code {})",
            ret.0 as isize
        ))
    }
}
