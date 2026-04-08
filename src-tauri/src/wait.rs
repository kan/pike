use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

const EVENT_DONE_PREFIX: &str = "pike-wait-done-";
const EVENT_ABORT_PREFIX: &str = "pike-wait-abort-";

/// Matches `WMCOPYDATA_SINGLE_INSTANCE_DATA` in tauri-plugin-single-instance.
const COPYDATA_SINGLE_INSTANCE: usize = 1542;

/// Suffix conventions from tauri-plugin-single-instance (appended to the app identifier):
///   -sim  = single-instance mutex
///   -sic  = single-instance window class
///   -siw  = single-instance window name
const SI_MUTEX_SUFFIX: &str = "-sim";
const SI_CLASS_SUFFIX: &str = "-sic";
const SI_WINDOW_SUFFIX: &str = "-siw";

const APP_ID: &str = if cfg!(debug_assertions) {
    "com.pike.dev.debug"
} else {
    "com.pike.dev"
};

pub struct WaitState {
    /// Maps wait_id → normalized file path
    pub active: Mutex<HashMap<String, String>>,
}

pub fn extract_wait_id(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|a| a.strip_prefix("--wait-id=").map(|s| s.to_string()))
}

pub fn register(state: &WaitState, wait_id: String, path: &str) {
    let norm = crate::normalize_path(path);
    log::debug!("[wait] register: wait_id={wait_id}, norm={norm:?}");
    if let Ok(mut active) = state.active.lock() {
        active.insert(wait_id, norm);
    }
}

pub fn signal_abort_all(state: &WaitState) {
    let ids: Vec<String> = if let Ok(mut active) = state.active.lock() {
        let ids: Vec<String> = active.keys().cloned().collect();
        active.clear();
        ids
    } else {
        return;
    };
    for id in &ids {
        signal_event(&format!("{EVENT_ABORT_PREFIX}{id}"));
    }
}

/// Returns true if any wait_ids were signaled.
#[tauri::command]
pub fn wait_signal_by_path(path: String, state: State<'_, WaitState>) -> bool {
    let norm = crate::normalize_path(&path);
    let ids: Vec<String> = if let Ok(mut active) = state.active.lock() {
        let matched: Vec<String> = active
            .iter()
            .filter(|(_, p)| **p == norm)
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

    // Check if another instance is already running via the single-instance mutex.
    let mutex_name = encode_wide(&format!("{APP_ID}{SI_MUTEX_SUFFIX}"));
    let is_second = unsafe {
        use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
        use windows::Win32::System::Threading::CreateMutexW;

        let handle = CreateMutexW(None, true, windows::core::PCWSTR(mutex_name.as_ptr()));
        let already = GetLastError() == ERROR_ALREADY_EXISTS;
        if let Ok(h) = handle {
            let _ = CloseHandle(h);
        }
        already
    };

    if !is_second {
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

        if result.0 == 0 { 0 } else { 1 }
    };

    std::process::exit(exit_code);
}

#[cfg(not(windows))]
pub fn try_wait_and_exit() {}

#[cfg(windows)]
fn send_to_first_instance(args: &[String], cwd: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SendMessageW, WM_COPYDATA};

    let class_name = encode_wide(&format!("{APP_ID}{SI_CLASS_SUFFIX}"));
    let window_name = encode_wide(&format!("{APP_ID}{SI_WINDOW_SUFFIX}"));

    unsafe {
        let hwnd = match FindWindowW(
            PCWSTR(class_name.as_ptr()),
            PCWSTR(window_name.as_ptr()),
        ) {
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

        let _ = SendMessageW(
            hwnd,
            WM_COPYDATA,
            Some(windows::Win32::Foundation::WPARAM(0)),
            Some(windows::Win32::Foundation::LPARAM(&cds as *const _ as isize)),
        );
    }
}

fn encode_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
