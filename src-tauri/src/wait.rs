use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

const EVENT_DONE_PREFIX: &str = "pike-wait-done-";
const EVENT_ABORT_PREFIX: &str = "pike-wait-abort-";

/// Matches `WMCOPYDATA_SINGLE_INSTANCE_DATA` in tauri-plugin-single-instance.
#[cfg(windows)]
const COPYDATA_SINGLE_INSTANCE: usize = 1542;

/// Suffix conventions from tauri-plugin-single-instance (appended to the app identifier):
///   -sim  = single-instance mutex
///   -sic  = single-instance window class
///   -siw  = single-instance window name
/// これらは single-instance の Windows 実装（WM_COPYDATA + 名前付きミューテックス）
/// にしか出てこない。非 Windows ではプラグインが別の仕組みを使うので参照されない。
#[cfg(windows)]
const SI_MUTEX_SUFFIX: &str = "-sim";
#[cfg(windows)]
const SI_CLASS_SUFFIX: &str = "-sic";
#[cfg(windows)]
const SI_WINDOW_SUFFIX: &str = "-siw";

/// single-instance の名前に使う identifier。正本は `types::app_identifier`。
#[cfg(windows)]
use crate::types::app_identifier as app_id;

pub struct WaitEntry {
    /// Normalized file path the editor tab uses
    path: String,
    /// Label of the window that hosts the tab
    window: String,
}

pub struct WaitState {
    /// Maps wait_id → waiting entry
    pub active: Mutex<HashMap<String, WaitEntry>>,
}

pub fn extract_wait_id(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|a| a.strip_prefix("--wait-id=").map(|s| s.to_string()))
}

pub fn register(state: &WaitState, wait_id: String, path: &str, window: &str) {
    let norm = crate::normalize_path(path);
    log::debug!("[wait] register: wait_id={wait_id}, norm={norm:?}, window={window}");
    if let Ok(mut active) = state.active.lock() {
        active.insert(
            wait_id,
            WaitEntry {
                path: norm,
                window: window.to_string(),
            },
        );
    }
}

/// Abort the waiters owned by `window` (its editor tab can no longer be
/// closed normally). Waits hosted by other windows are unaffected — global
/// terminal windows come and go and must not release a pending GIT_EDITOR.
pub fn signal_abort_for_window(state: &WaitState, window: &str) {
    let ids: Vec<String> = if let Ok(mut active) = state.active.lock() {
        let ids: Vec<String> = active
            .iter()
            .filter(|(_, e)| e.window == window)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            active.remove(id);
        }
        ids
    } else {
        return;
    };
    for id in &ids {
        signal_event(&format!("{EVENT_ABORT_PREFIX}{id}"));
    }
}

/// Release a single --wait CLI that never got a wait registration
/// (e.g. `pike --wait` with no file argument — nothing to wait on).
pub fn signal_abort(wait_id: &str) {
    signal_event(&format!("{EVENT_ABORT_PREFIX}{wait_id}"));
}

/// Returns true if any wait_ids were signaled.
#[tauri::command]
pub fn wait_signal_by_path(path: String, state: State<'_, WaitState>) -> bool {
    let norm = crate::normalize_path(&path);
    let ids: Vec<String> = if let Ok(mut active) = state.active.lock() {
        let matched: Vec<String> = active
            .iter()
            .filter(|(_, e)| e.path == norm)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &matched {
            active.remove(id);
        }
        matched
    } else {
        return false;
    };
    for id in &ids {
        signal_event(&format!("{EVENT_DONE_PREFIX}{id}"));
    }
    !ids.is_empty()
}

// --- Windows-specific implementation ---

#[cfg(windows)]
fn signal_event(name: &str) {
    use windows::core::HSTRING;
    use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};

    unsafe {
        let hname = HSTRING::from(name);
        if let Ok(handle) = OpenEventW(EVENT_MODIFY_STATE, false, &hname) {
            let _ = SetEvent(handle);
            let _ = windows::Win32::Foundation::CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
fn signal_event(_name: &str) {}

/// Probe the single-instance mutex to determine whether another Pike instance
/// is already running. Creates+closes the mutex; safe to call multiple times
/// from the same (second) process.
#[cfg(windows)]
fn is_second_instance() -> bool {
    let mutex_name = encode_wide(&format!("{}{SI_MUTEX_SUFFIX}", app_id()));
    unsafe {
        use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
        use windows::Win32::System::Threading::CreateMutexW;

        let handle = CreateMutexW(None, true, windows::core::PCWSTR(mutex_name.as_ptr()));
        let already = GetLastError() == ERROR_ALREADY_EXISTS;
        if let Ok(h) = handle {
            let _ = CloseHandle(h);
        }
        already
    }
}

/// If pike CLI was invoked from inside a Pike terminal (PIKE_WINDOW_LABEL set
/// by pty_spawn) and another Pike instance is already running, forward the args
/// with `--from-window=<label>` appended, then exit. Returns immediately if not
/// applicable, letting normal flow proceed.
///
/// Skips when `--wait` is present (handled by `try_wait_and_exit`) or when
/// argv has no meaningful payload (no point routing an empty action).
#[cfg(windows)]
pub fn try_forward_pty_origin_and_exit() {
    let label = match std::env::var("PIKE_WINDOW_LABEL") {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };

    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--wait") {
        return;
    }

    let has_payload = args
        .iter()
        .skip(1)
        .any(|a| !a.starts_with("--wait-id=") && !a.starts_with("--from-window="));
    if !has_payload {
        return;
    }

    if !is_second_instance() {
        return;
    }

    let mut augmented = args;
    augmented.push(format!("--from-window={label}"));

    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    send_to_first_instance(&augmented, &cwd);
    std::process::exit(0);
}

#[cfg(not(windows))]
pub fn try_forward_pty_origin_and_exit() {}

/// Called early in main(), before the Tauri runtime.
/// If `--wait` is in args and an existing Pike instance is running,
/// this function sends the args to that instance, blocks until the
/// edit is complete, and then exits the process — it never returns.
#[cfg(windows)]
pub fn try_wait_and_exit() {
    let args: Vec<String> = std::env::args().collect();

    if !args.iter().any(|a| a == "--wait") {
        return;
    }

    if !is_second_instance() {
        return;
    }

    let wait_id = uuid::Uuid::new_v4().to_string();

    let done_name = format!("{EVENT_DONE_PREFIX}{wait_id}");
    let abort_name = format!("{EVENT_ABORT_PREFIX}{wait_id}");

    let (done_event, abort_event) = unsafe {
        use windows::core::HSTRING;
        use windows::Win32::System::Threading::CreateEventW;

        let done = CreateEventW(None, true, false, &HSTRING::from(&done_name))
            .expect("CreateEventW failed for done event");
        let abort = CreateEventW(None, true, false, &HSTRING::from(&abort_name))
            .expect("CreateEventW failed for abort event");
        (done, abort)
    };

    let rewritten: Vec<String> = args
        .iter()
        .map(|a| {
            if a == "--wait" {
                format!("--wait-id={wait_id}")
            } else {
                a.clone()
            }
        })
        .collect();

    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    send_to_first_instance(&rewritten, &cwd);

    let exit_code = unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{WaitForMultipleObjects, INFINITE};

        let handles = [done_event, abort_event];
        let result = WaitForMultipleObjects(&handles, false, INFINITE);

        let _ = CloseHandle(done_event);
        let _ = CloseHandle(abort_event);

        if result.0 == 0 {
            0
        } else {
            1
        }
    };

    std::process::exit(exit_code);
}

#[cfg(not(windows))]
pub fn try_wait_and_exit() {}

/// エージェントの hook からの通知を送るときの待ち時間（ミリ秒、#265）。
///
/// **`--wait` と違って返事を待ち続けない。** あちらは利用者が起こす稀な操作だが、通知の
/// hook は**ターンのたび**に走る。素の `SendMessageW` は受け側がメッセージを処理するまで
/// 戻らないので、Pike の UI スレッドが詰まっているあいだ（ジャンプリストの構築で実績が
/// ある。`jumplist/mod.rs`）、Claude Code のターンの終わりが hook のタイムアウトまで
/// 止まる。届かなかったときに失うのは通知 1 回だけなので、待たずに諦める。
#[cfg(windows)]
const NOTICE_TIMEOUT_MS: u32 = 1000;

/// Send argv to the running instance the way the single-instance plugin does.
#[cfg(windows)]
fn send_to_first_instance(args: &[String], cwd: &str) {
    send_copydata(args, cwd, None)
}

/// 同じ経路で、返事を待たずに送る（#265）。hook プロセスは Tauri を起動しないので、
/// この WM_COPYDATA が走っている Pike へ届ける唯一の手段。
///
/// **cwd は送らない。** 届け先は pty id で決まるので受け側が読まないうえ、hook プロセスの
/// cwd は WSL の native パスで、Windows 側では意味を持たない。
#[cfg(windows)]
pub(crate) fn send_notice_to_first_instance(args: &[String]) {
    send_copydata(args, "", Some(NOTICE_TIMEOUT_MS))
}

#[cfg(windows)]
fn send_copydata(args: &[String], cwd: &str, timeout_ms: Option<u32>) {
    use windows::core::PCWSTR;
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SendMessageTimeoutW, SendMessageW, SMTO_ABORTIFHUNG, WM_COPYDATA,
    };

    let class_name = encode_wide(&format!("{}{SI_CLASS_SUFFIX}", app_id()));
    let window_name = encode_wide(&format!("{}{SI_WINDOW_SUFFIX}", app_id()));

    unsafe {
        let hwnd = match FindWindowW(PCWSTR(class_name.as_ptr()), PCWSTR(window_name.as_ptr())) {
            Ok(h) if !h.is_invalid() => h,
            _ => return,
        };

        let data = format!("{cwd}|{}\0", args.join("|"));
        let bytes = data.as_bytes();

        let cds = COPYDATASTRUCT {
            dwData: COPYDATA_SINGLE_INSTANCE,
            cbData: bytes.len() as u32,
            lpData: bytes.as_ptr() as *mut std::ffi::c_void,
        };

        // `SendMessageW` は `Option` で受け、`SendMessageTimeoutW` は素の値で受ける
        // （windows クレート 0.62 のシグネチャの差）。
        let wparam = windows::Win32::Foundation::WPARAM(0);
        let lparam = windows::Win32::Foundation::LPARAM(&cds as *const _ as isize);
        match timeout_ms {
            // `SMTO_ABORTIFHUNG`: 受け側が既にハングしていると分かっているなら待たない。
            Some(ms) => {
                SendMessageTimeoutW(
                    hwnd,
                    WM_COPYDATA,
                    wparam,
                    lparam,
                    SMTO_ABORTIFHUNG,
                    ms,
                    None,
                );
            }
            None => {
                let _ = SendMessageW(hwnd, WM_COPYDATA, Some(wparam), Some(lparam));
            }
        }
    }
}

/// 配送は WM_COPYDATA だけなので、非 Windows では届ける先が無い（#265 が Windows
/// 限定なのはこれが理由）。呼び出し側を `cfg` で割らずに済むよう、ここで何もしない。
#[cfg(not(windows))]
pub(crate) fn send_notice_to_first_instance(_args: &[String]) {}

#[cfg(windows)]
fn encode_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
