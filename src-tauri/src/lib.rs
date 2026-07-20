mod agent;
mod claude_usage;
mod cli;
mod codex;
mod codex_usage;
mod diagnostics;
mod docker;
mod drop_paths;
mod elevate;
mod font;
mod fs;
mod git;
mod jumplist;
mod search;
mod project;
mod pty;
mod settings_sync;
mod tasks;
mod tray;
pub mod todo_cli;
mod types;
pub mod wait;
mod watcher;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WebviewWindow, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

/// Must match PROJECT_WINDOW_PREFIX in src/lib/window.ts
const PROJECT_WINDOW_PREFIX: &str = "project-";
/// Project-independent (global-mode) window: sidebar-less editor/terminal.
/// Must match the prefix checked in isGlobalWindow() in src/lib/window.ts
const GLOBAL_PREFIX: &str = "global-";

/// Close-to-tray setting (issue #161): when true (default), closing main hides
/// it to the tray and keeps Pike resident; when false, closing main exits the
/// app. The frontend syncs the persisted `closeToTray` setting via
/// `tray_set_close_to_tray`. Read synchronously in the main CloseRequested
/// handler, so it lives in a process-global atomic rather than managed state.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Must be called outside of WM_COPYDATA / SendMessage context — COM calls
/// fail with RPC_E_CANTCALLOUT_ININPUTSYNCCALL inside input-synchronous messages.
/// Falls back to `true` (assume visible) when COM or the API is unavailable.
fn is_on_current_virtual_desktop(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

        let hwnd_raw = match window.hwnd() {
            Ok(h) => h.0 as isize,
            Err(e) => {
                log::warn!("[vdesktop] hwnd() failed: {e}");
                return true;
            }
        };
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let manager: IVirtualDesktopManager =
                match CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL) {
                    Ok(m) => m,
                    Err(e) => {
                        log::warn!("[vdesktop] CoCreateInstance failed: {e}");
                        return true;
                    }
                };
            let hwnd = windows::Win32::Foundation::HWND(hwnd_raw as *mut _);
            match manager.IsWindowOnCurrentVirtualDesktop(hwnd) {
                Ok(b) => {
                    let result = b.as_bool();
                    log::debug!(
                        "[vdesktop] IsWindowOnCurrentVirtualDesktop({hwnd_raw:#x}) = {result}"
                    );
                    result
                }
                Err(e) => {
                    log::warn!(
                        "[vdesktop] IsWindowOnCurrentVirtualDesktop failed: {e}"
                    );
                    true
                }
            }
        }
    }
    #[cfg(not(windows))]
    true
}

fn iso_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = (secs / 86400) as i64;
    // Approximate date from days since epoch (good enough for sorting)
    let (y, mo, day) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
    // Civil days algorithm (Howard Hinnant)
    days += 719468;
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn normalize_path(p: &str) -> String {
    p.to_lowercase()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn is_under_root(file_path: &str, root: &str) -> bool {
    let f = normalize_path(file_path);
    let r = normalize_path(root);
    f.starts_with(&format!("{r}/")) || f == r
}

fn load_all_projects(app: &AppHandle) -> Vec<project::ProjectConfig> {
    let Some(state) = app.try_state::<project::ProjectState>() else {
        return vec![];
    };
    project::read_all_projects(&state.config_dir)
}

/// Create an ad-hoc project for an unregistered directory path.
/// For WSL UNC paths, extracts distro and uses the native WSL path as root.
/// For native WSL paths (e.g. /home/user/foo), uses the `distro_hint` captured
/// by the CLI parser before UNC→native conversion erased the distro context.
/// For Windows paths, uses PowerShell as the default shell.
fn create_adhoc_project(
    app: &AppHandle,
    path: &str,
    distro_hint: Option<&str>,
) -> Option<project::ProjectConfig> {
    let state = app.try_state::<project::ProjectState>()?;

    let (root, shell) = if let Some(distro) = cli::wsl_distro_from_path(path) {
        // Convert UNC path to native WSL path: \\wsl.localhost\Ubuntu\home\user → /home/user
        let norm = path.replace('\\', "/");
        let prefix_localhost = format!("//wsl.localhost/{distro}/");
        let prefix_dollar = format!("//wsl$/{distro}/");
        let wsl_path = if let Some(rest) = norm.strip_prefix(&prefix_localhost) {
            format!("/{rest}")
        } else {
            let rest = norm.strip_prefix(&prefix_dollar)?;
            format!("/{rest}")
        };
        (wsl_path, types::ShellConfig::Wsl { distro })
    } else if let Some(distro) = distro_hint {
        // Path is already native WSL — CLI parser converted UNC→native and
        // passed the distro through CliAction so we can recover it here.
        (
            path.to_string(),
            types::ShellConfig::Wsl {
                distro: distro.to_string(),
            },
        )
    } else {
        (path.to_string(), types::ShellConfig::Powershell)
    };

    // Generate a slug from the directory name
    let dir_name = root
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("project");
    let slug: String = dir_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let base_id = if slug.is_empty() {
        "adhoc".to_string()
    } else {
        slug.chars().take(48).collect()
    };

    // Ensure unique ID
    let existing = project::read_all_projects(&state.config_dir);
    let id = if existing.iter().any(|p| p.id == base_id) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{}-{}", base_id, ts % 100000)
    } else {
        base_id
    };

    let config = project::ProjectConfig {
        id,
        name: dir_name.to_string(),
        root,
        shell,
        pinned_tabs: vec![],
        last_opened: iso_now(),
        last_session: None,
        codex_thread_id: None,
        agent_session_id: None,
        group: None,
        color: None,
    };

    let dir = state.config_dir.join("projects").join(&config.id);
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let content = serde_json::to_string_pretty(&config).ok()?;
    std::fs::write(dir.join("project.json"), content).ok()?;

    log::debug!(
        "[adhoc] created project id={} name={} root={} shell={:?}",
        config.id,
        config.name,
        config.root,
        config.shell
    );
    Some(config)
}

fn current_desktop_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .filter(is_on_current_virtual_desktop)
        .collect()
}

fn window_project_id(label: &str) -> Option<&str> {
    label.strip_prefix(PROJECT_WINDOW_PREFIX)
}

fn build_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, tauri::Error> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("Pike")
        .inner_size(800.0, 600.0)
        .resizable(true)
        // 背景透過（issue #162）: 透過はランタイムで切替えるため常に透過ウィンドウで生成し、
        // 透過 OFF 時は CSS 側で不透明に塗る。アクリル/Mica もこの透過を前提に乗る。
        .transparent(true)
        .disable_drag_drop_handler()
        .build()?;
    drop_paths::attach(&window);
    Ok(window)
}

fn create_global_window(app: &AppHandle) -> String {
    let label = format!("{GLOBAL_PREFIX}{}", uuid::Uuid::new_v4());
    let _ = build_window(app, &label);
    label
}

fn store_pending(app: &AppHandle, label: &str, action: cli::CliAction) {
    if let Some(state) = app.try_state::<cli::CliState>() {
        if let Ok(mut pending) = state.pending.lock() {
            pending.insert(label.to_string(), action);
        }
    }
}

/// Send a CLI action to an existing window via event.
fn emit_action_to(app: &AppHandle, window: &WebviewWindow, action: &cli::CliAction) {
    let _ = window.unminimize();
    // show() handles the case where the window is hidden (e.g. main was
    // closed and the app is still running with a hidden main).
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(window.label(), "cli_open", action);
}

/// Path form the editor tab will use for a --wait file in a global window.
/// WSL-native paths are rebuilt as UNC there (Windows-side file I/O), so the
/// wait registration must match that form for close-signal lookup.
/// Must stay in sync with `tabPathFor` in src/composables/useCliOpen.ts.
fn wait_tab_path(f: &cli::CliFileTarget) -> String {
    match &f.distro {
        Some(d) => format!(r"\\wsl.localhost\{d}{}", f.path.replace('/', "\\")),
        None => f.path.clone(),
    }
}

/// Handle the second-instance callback (deferred from WM_COPYDATA context).
fn handle_second_instance(app: &AppHandle, args: &[String], cwd: &str) {
    let wait_id = wait::extract_wait_id(args);
    let from_window = cli::extract_from_window(args);
    let action = cli::parse_args(args, cwd);
    log::debug!(
        "[single-instance] args={args:?}, cwd={cwd:?}, action={action:?}, wait_id={wait_id:?}, from_window={from_window:?}"
    );

    // --wait: register wait_id and always open in a new dedicated global window.
    // GIT_EDITOR passes exactly one file; with multiple files, the first governs.
    if let Some(ref wid) = wait_id {
        if let cli::CliAction::OpenFiles { ref files } = action {
            let label = create_global_window(app);
            if let (Some(state), Some(f)) = (app.try_state::<wait::WaitState>(), files.first()) {
                wait::register(&state, wid.clone(), &wait_tab_path(f), &label);
            }
            store_pending(app, &label, action);
            return;
        }
        // --wait without an openable file (bare flag, directory arg): there is
        // nothing to wait on — release the blocked CLI immediately, then
        // handle the action normally.
        wait::signal_abort(wid);
    }

    match &action {
        cli::CliAction::None => {
            // Plain `pike` while already running: open a global terminal
            // window (Windows Terminal replacement). Shell is inferred from
            // the invocation cwd (WSL UNC path → that distro, else the
            // frontend's globalShell setting).
            let action = cli::terminal_action_for_cwd(cwd);
            log::debug!("[single-instance] no args: global terminal window: {action:?}");
            let label = create_global_window(app);
            store_pending(app, &label, action);
        }

        cli::CliAction::OpenTerminal { .. } => {
            // Not produced by parse_args (built from None above), but route it
            // sanely if it ever arrives: dedicated global terminal window.
            let label = create_global_window(app);
            store_pending(app, &label, action);
        }

        cli::CliAction::OpenDirectory { path, distro } => {
            let projects = load_all_projects(app);
            let windows = current_desktop_windows(app);
            let norm = normalize_path(path);

            // 1. Window with matching project already on this desktop? → focus
            for w in &windows {
                if let Some(pid) = window_project_id(w.label()) {
                    if let Some(proj) = projects.iter().find(|p| p.id == pid) {
                        if normalize_path(&proj.root) == norm {
                            log::debug!("[single-instance] dir: focus project window {}", w.label());
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                            return;
                        }
                    }
                }
            }

            // 2. Registered project for this path? → new window for that project
            if let Some(proj) = projects.iter().find(|p| normalize_path(&p.root) == norm) {
                log::debug!("[single-instance] dir: open project {} in new window", proj.id);
                let label = format!("{PROJECT_WINDOW_PREFIX}{}", proj.id);
                store_pending(app, &label, action);
                let _ = build_window(app, &label);
                return;
            }

            // 3. No registered project → create ad-hoc project and open in new window
            log::debug!("[single-instance] dir: creating ad-hoc project for {path}");
            if let Some(proj) = create_adhoc_project(app, path, distro.as_deref()) {
                let label = format!("{PROJECT_WINDOW_PREFIX}{}", proj.id);
                let _ = build_window(app, &label);
            } else {
                let label = create_global_window(app);
                store_pending(app, &label, action);
            }
        }

        cli::CliAction::OpenFiles { files } => {
            // 0. Invoked from inside a Pike terminal? Route to that window
            // unconditionally — the user explicitly chose where to launch it.
            if let Some(ref label) = from_window {
                if let Some(w) = app.get_webview_window(label) {
                    log::debug!("[single-instance] files: open in originating window {label}");
                    emit_action_to(app, &w, &action);
                    return;
                }
                log::debug!("[single-instance] files: from_window {label} not found, falling back");
            }

            let projects = load_all_projects(app);
            let windows = current_desktop_windows(app);

            // 1. Window whose project contains ALL files on this desktop? → open there
            for w in &windows {
                if let Some(pid) = window_project_id(w.label()) {
                    if let Some(proj) = projects.iter().find(|p| p.id == pid) {
                        if files.iter().all(|f| is_under_root(&f.path, &proj.root)) {
                            log::debug!("[single-instance] files: open in project window {}", w.label());
                            emit_action_to(app, w, &action);
                            return;
                        }
                    }
                }
            }

            // 2. No matching project window → global (sidebar-less) editor window
            log::debug!("[single-instance] files: new global window");
            let label = create_global_window(app);
            store_pending(app, &label, action);
        }

        cli::CliAction::OpenProject { id, .. } => {
            // The elevated relaunch uses `--new-instance` (single-instance is
            // skipped), so this only runs for a manual `pike --open-project=<id>`
            // while another instance is live. Focus or open the project window;
            // its handleActionLocal adds the pinned-shell terminal.
            if load_all_projects(app).iter().any(|p| &p.id == id) {
                let label = format!("{PROJECT_WINDOW_PREFIX}{id}");
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    emit_action_to(app, &w, &action);
                } else {
                    store_pending(app, &label, action.clone());
                    let _ = build_window(app, &label);
                }
            }
        }
    }
}

#[tauri::command]
async fn open_project_window(project_id: String, app: AppHandle) -> Result<(), String> {
    // Same guard as project_get/update/delete: the id becomes a window label,
    // so reject anything outside [a-zA-Z0-9_-].
    types::validate_slug(&project_id, "Project ID")?;
    focus_or_build_project_window(&app, &project_id);
    Ok(())
}

/// Focus the project window for `id` if it's live, else build it. Shared by the
/// `open_project_window` command and the tray "recent project" menu. `id` must
/// already be slug-validated (it becomes a window label).
fn focus_or_build_project_window(app: &AppHandle, id: &str) {
    let label = format!("{PROJECT_WINDOW_PREFIX}{id}");
    if let Some(window) = app.get_webview_window(&label) {
        // Verify the window is actually visible — tauri-plugin-window-state may
        // keep a stale handle for a previously closed window.
        if window.is_visible().unwrap_or(false) {
            restore_window(&window);
            return;
        }
        let _ = window.close();
    }
    if build_window(app, &label).is_err() {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_focus();
        }
    }
}

/// Open a fresh global-mode (project-less) window with a terminal on the
/// frontend's configured global shell. Used by the project switcher's "Global
/// Mode" action when it can't reuse the current window (a project is active, or
/// the window is already global).
#[tauri::command]
async fn open_global_window(app: AppHandle) -> Result<(), String> {
    spawn_global_terminal_window(&app);
    Ok(())
}

/// Create a global-mode window and queue a terminal on the user's global shell.
/// Shared by the `open_global_window` command and the tray "New Terminal" menu.
fn spawn_global_terminal_window(app: &AppHandle) {
    let label = create_global_window(app);
    // shell = None → the frontend applies the user's globalShell setting.
    store_pending(app, &label, cli::CliAction::OpenTerminal { cwd: None, shell: None });
}

#[tauri::command]
fn save_all_window_state(app: AppHandle) -> Result<(), String> {
    app.save_window_state(StateFlags::all()).map_err(|e| e.to_string())
}

/// Rebuild the shell-integration menus — the taskbar jump list (#160) and the
/// system-tray menu (#161). Called by the frontend on startup and whenever the
/// project set / names / recency / UI locale change. Reads the project list
/// once here and feeds both menus, instead of each re-scanning the projects
/// dir; `lang` carries the UI locale so labels follow it.
#[tauri::command]
async fn menus_refresh(app: AppHandle, lang: String) -> Result<(), String> {
    let projects = app
        .try_state::<project::ProjectState>()
        .map(|s| project::read_all_projects_sorted(&s.config_dir))
        .unwrap_or_default();
    jumplist::refresh(&lang, &projects);
    // jumplist と違い tray は同期のまま。muda のメニュー構築は main スレッドに
    // 載って返るだけでシェルの解決（AppResolver / UNC）を伴わないため、jumplist を
    // ハングさせた経路には該当しない。ここに重い処理を足すときは jumplist と同じく
    // 専用スレッドへ逃がすこと。
    tray::refresh(&app, &lang, &projects);
    Ok(())
}

/// Update the tray tooltip (issue #161). The main window pushes its formatted
/// usage summary (e.g. "Pike · Claude 5h 42%") so it is visible at a glance
/// while Pike sits minimized in the tray.
#[tauri::command]
async fn tray_set_tooltip(app: AppHandle, text: String) -> Result<(), String> {
    tray::set_tooltip(&app, &text);
    Ok(())
}

/// Sync the close-to-tray setting from the frontend (issue #161). When disabled,
/// closing the main window exits Pike instead of hiding it to the tray.
#[tauri::command]
async fn tray_set_close_to_tray(enabled: bool) -> Result<(), String> {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// Apply (or clear) the window backdrop effect for background transparency
/// (issue #162). The frontend calls this per-window on startup and whenever the
/// `windowBackdrop` setting changes; each window applies the effect to itself.
/// `acrylic` needs Windows 11 (on older systems the call fails and the CSS-level
/// rgba transparency remains as a graceful fallback). `transparent`/`none` apply
/// no native material — the window is already transparent, so the CSS surface
/// alpha alone produces plain (blur-free) translucency. Errors are best-effort.
#[tauri::command]
async fn window_set_backdrop(window: WebviewWindow, kind: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use window_vibrancy::{apply_acrylic, clear_acrylic, clear_mica};
        match kind.as_str() {
            "acrylic" => {
                let _ = clear_mica(&window);
                let _ = apply_acrylic(&window, None);
            }
            _ => {
                // "none" / "transparent" / unknown: strip any native material.
                // clear_mica covers backdrops applied by an earlier build.
                let _ = clear_acrylic(&window);
                let _ = clear_mica(&window);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (&window, &kind);
    Ok(())
}

/// Show, unminimize and focus a window — the restore-from-tray/minimized triple.
fn restore_window(w: &WebviewWindow) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// Show and focus the main window, restoring it from the tray / a minimized
/// state.
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        restore_window(&w);
    }
}

/// Toggle main window visibility from a tray left-click: hide it when it is the
/// foreground window, otherwise bring it back. Hiding here (like close-to-tray)
/// never destroys main, so the session and PTYs stay alive.
pub(crate) fn toggle_main_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        restore_window(&w);
    }
}

/// Dispatch a tray menu click (see `tray::build_menu` for the item ids).
pub(crate) fn tray_menu_action(app: &AppHandle, id: &str) {
    match id {
        "tray:show" => show_main_window(app),
        "tray:new-terminal" => spawn_global_terminal_window(app),
        "tray:switcher" => {
            show_main_window(app);
            // The main window listens for this and opens the project switcher.
            let _ = app.emit_to("main", "tray-open-switcher", ());
        }
        "tray:quit" => app.exit(0),
        _ => {
            let Some(pid) = id.strip_prefix("tray:proj:") else {
                return;
            };
            // Same slug guard as the other project-window entry points: the id
            // becomes a window label.
            if types::validate_slug(pid, "project id").is_ok() {
                focus_or_build_project_window(app, pid);
            }
        }
    }
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    // Allowlist: only http/https URLs to prevent opening arbitrary protocols
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http/https URLs are allowed".to_string());
    }
    tokio::task::spawn_blocking(move || {
        // Use explorer.exe which delegates to ShellExecuteW internally,
        // avoiding cmd.exe shell metacharacter injection (&, |, >, etc.)
        types::silent_command("explorer.exe")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        let output = types::silent_command("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){$f.SelectedPath}",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| e.to_string())?;
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_save_file(default_name: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let name = default_name.unwrap_or_default();
        // PowerShell single-quoted strings only interpret '' as escaped quote;
        // no other characters ($, `, ;, etc.) are special inside single quotes.
        let cmd = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $f = New-Object System.Windows.Forms.SaveFileDialog; \
             $f.FileName = '{}'; \
             if($f.ShowDialog() -eq 'OK'){{$f.FileName}}",
            name.replace('\'', "''")
        );
        let output = types::silent_command("powershell.exe")
            .args(["-NoProfile", "-Command", &cmd])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| e.to_string())?;
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Elevated relaunch (open_elevated_terminal) passes `--new-instance`: skip
    // single-instance so the admin process runs as its own window instead of
    // forwarding its terminal request to the existing non-elevated instance
    // (WM_COPYDATA from elevated → non-elevated would open the shell unelevated).
    let standalone = std::env::args().any(|a| a == "--new-instance");

    let mut builder = tauri::Builder::default();

    // WebDriver E2E 用プラグイン (issue #142)。embedded provider が WebView 内で
    // WebDriver サーバを立てる。`e2e` feature のときだけ有効で本番には含めない。
    #[cfg(feature = "e2e")]
    {
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    if !standalone {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // Defer via run_on_main_thread to escape the WM_COPYDATA
            // input-synchronous context.  COM cross-apartment calls
            // (IVirtualDesktopManager) fail with RPC_E_CANTCALLOUT_ININPUTSYNCCALL
            // while inside SendMessage.
            let app_handle = app.clone();
            let args: Vec<String> = args.to_vec();
            let cwd = cwd.to_string();
            std::thread::spawn(move || {
                let app2 = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    handle_second_instance(&app2, &args, &cwd);
                });
            });
        }));
    }

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(cli::CliState {
            initial_action: std::sync::Mutex::new(None),
            pending: std::sync::Mutex::new(HashMap::new()),
        })
        .manage(wait::WaitState {
            active: std::sync::Mutex::new(HashMap::new()),
        })
        .manage(pty::PtyState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
        .manage(watcher::WatcherState {
            handles: Arc::new(Mutex::new(HashMap::new())),
        })
        .manage(docker::DockerState {
            log_streams: Arc::new(Mutex::new(HashMap::new())),
            client: tokio::sync::OnceCell::new(),
            instance_id: std::sync::OnceLock::new(),
            tunnels_created: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(codex::CodexState::default())
        .manage(agent::state::AgentState::default())
        .setup(|app| {
            if let Some(state) = app.try_state::<docker::DockerState>() {
                let _ = state.instance_id.set(app.config().identifier.clone());
            }

            // The main window comes from tauri.conf.json (not build_window),
            // so it needs its own drop-paths bridge attachment.
            if let Some(main) = app.get_webview_window("main") {
                drop_paths::attach(&main);
            }

            // WebDriver E2E の capability を実行時に登録する (issue #142)。
            // wdio-webdriver:default はプラグイン同梱の permission で、静的な
            // capabilities/ に載せるとプラグイン非搭載の本番ビルドが壊れる。
            // dynamic-acl で `e2e` feature 時のみ登録し、本番を無傷に保つ。
            #[cfg(feature = "e2e")]
            {
                if let Err(e) =
                    app.handle().add_capability(include_str!("../capabilities-runtime/wdio.json"))
                {
                    log::warn!("failed to add wdio capability: {e}");
                }
            }

            let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(config_dir.join("projects"))
                .map_err(|e| e.to_string())?;
            app.manage(project::ProjectState {
                config_dir,
                window_projects: std::sync::Mutex::new(HashMap::new()),
            });

            // Resolve bundled rg sidecar path (externalBin places it next to the executable)
            let rg_path = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
                .and_then(|dir| {
                    let p = dir.join("rg.exe");
                    p.exists().then(|| p.to_string_lossy().into_owned())
                });
            app.manage(search::SearchState {
                bundled_rg: rg_path,
                detected: std::sync::Arc::new(std::sync::Mutex::new(
                    std::collections::HashMap::new(),
                )),
            });

            // Parse initial CLI args and store for frontend to retrieve
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let action = cli::parse_args(&args, &cwd);
            if !matches!(action, cli::CliAction::None) {
                if let Some(state) = app.try_state::<cli::CliState>() {
                    *state.initial_action.lock().unwrap() = Some(action);
                }
            }

            // System-tray icon (issue #161): quick-launch menu + close-to-tray
            // restore. Non-fatal if it can't be created.
            if let Err(e) = tray::build(app.handle()) {
                log::warn!("[tray] failed to create tray icon: {e}");
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    // Always prevent the raw close first: destroying main tears
                    // down the async runtime, panicking Codex cleanup in still-open
                    // project windows.
                    api.prevent_close();
                    if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                        // Close-to-tray (issue #161): hide main and keep the
                        // session + PTYs + polling alive; the tray icon restores
                        // it, and the tray "Quit" item is the real exit.
                        let _ = window.hide();
                        let _ = window.emit("main-minimized-to-tray", ());
                    } else {
                        // Setting off: closing main exits Pike. app.exit drives a
                        // controlled shutdown (the Codex cleanup in Destroyed is
                        // guarded against a torn-down runtime), avoiding the panic.
                        window.app_handle().exit(0);
                    }
                }
                WindowEvent::Destroyed => {
                    // Abort --wait processes hosted by THIS window (tab still
                    // open when the window died). Other windows' waits keep
                    // running — global terminal windows come and go freely.
                    if let Some(state) = window.try_state::<wait::WaitState>() {
                        wait::signal_abort_for_window(&state, window.label());
                    }

                    // Authoritative cleanup: JS beforeunload is best-effort only.
                    if let Some(state) = window.try_state::<project::ProjectState>() {
                        let project_id = window_project_id(window.label())
                            .map(|s| s.to_string())
                            .or_else(|| project::take_window_project(&state, window.label()));
                        if let Some(pid) = project_id {
                            if let Err(e) = project::remove_open_project(&state, &pid) {
                                log::warn!("Failed to remove project {pid} from open list: {e}");
                            }
                        }
                    }

                    // Per-window Codex cleanup (guard against missing runtime on shutdown)
                    if let Some(state) = window.try_state::<codex::CodexState>() {
                        let label = window.label().to_string();
                        let sessions = state.sessions.clone();
                        if let Ok(handle) = tokio::runtime::Handle::try_current() {
                            handle.spawn(async move {
                                let mut map = sessions.lock().await;
                                if let Some(session) = map.remove(&label) {
                                    log::info!("[codex] Cleaning up session for window {label}");
                                    session.shutdown().await;
                                }
                            });
                        }
                    }

                    // Per-window agent cleanup (shuts down all tabs in this window)
                    if let Some(agent_state) = window.try_state::<agent::state::AgentState>() {
                        let label = window.label().to_string();
                        let state = agent_state.inner().clone();
                        if let Ok(handle) = tokio::runtime::Handle::try_current() {
                            handle.spawn(async move {
                                state.remove_by_window(&label).await;
                            });
                        }
                    }

                    if let Some(state) = window.try_state::<pty::PtyState>() {
                        pty::cleanup_for_window(&state, window.label());
                    }

                    // Global cleanup only when the last window is closing. With
                    // close-to-tray (issue #161) main is only ever destroyed on
                    // an explicit tray Quit (app.exit), so a closing project
                    // window is never the last one and the app stays resident in
                    // the tray instead of auto-exiting.
                    let windows = window.app_handle().webview_windows();
                    let current = window.label();
                    if windows.keys().any(|l| l != current) {
                        return;
                    }
                    if let Some(state) = window.try_state::<watcher::WatcherState>() {
                        watcher::stop_all(&state);
                    }
                    if let Some(state) = window.try_state::<docker::DockerState>() {
                        if let Ok(mut streams) = state.log_streams.lock() {
                            for (_, handle) in streams.drain() {
                                handle.abort();
                            }
                        }
                    }
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    // Trailing-edge debounce: save only after 500ms of quiet
                    static GENERATION: AtomicU64 = AtomicU64::new(0);
                    static TASK_RUNNING: AtomicBool = AtomicBool::new(false);
                    GENERATION.fetch_add(1, Ordering::Relaxed);
                    if !TASK_RUNNING.swap(true, Ordering::Relaxed) {
                        let app = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            loop {
                                let gen = GENERATION.load(Ordering::Relaxed);
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                if GENERATION.load(Ordering::Relaxed) == gen {
                                    let _ = app.save_window_state(StateFlags::all());
                                    TASK_RUNNING.store(false, Ordering::Relaxed);
                                    break;
                                }
                            }
                        });
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            cli::cli_get_initial_action,
            cli::cli_set_pending_action,
            wait::wait_signal_by_path,
            open_project_window,
            open_global_window,
            menus_refresh,
            tray_set_tooltip,
            tray_set_close_to_tray,
            window_set_backdrop,
            elevate::is_elevated,
            elevate::open_elevated_terminal,
            save_all_window_state,
            tasks::task_discover,
            diagnostics::diagnostics_run,
            open_url,
            pick_folder,
            pick_save_file,
            pty::pty_spawn,
            pty::pty_spawn_tmux,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_get_cwd,
            project::detect_wsl_distros,
            project::project_get_last,
            project::project_set_last,
            project::project_add_open,
            project::project_remove_open,
            project::project_list,
            project::project_get,
            project::project_create,
            project::project_update,
            project::project_delete,
            project::project_groups_list,
            project::project_groups_save,
            fs::fs_list_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_read_file_base64,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_copy,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_write_file_base64,
            fs::fs_resolve_first_existing,
            fs::fs_open_in_explorer,
            settings_sync::settings_sync_read,
            settings_sync::settings_sync_write,
            watcher::fs_watch_start,
            watcher::fs_watch_stop,
            docker::docker_ping,
            docker::docker_compose_services,
            docker::docker_list_containers,
            docker::docker_start,
            docker::docker_stop,
            docker::docker_restart,
            docker::docker_logs_start,
            docker::docker_logs_stop,
            docker::docker_detect_shell,
            docker::tunnel::docker_tunnel_create,
            docker::tunnel::docker_tunnel_stop,
            docker::tunnel::docker_container_ports,
            search::search_detect_backend,
            search::search_execute,
            search::list_project_files,
            git::git_status,
            git::git_is_repo,
            git::git_init,
            git::git_log,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard_changes,
            git::git_commit,
            git::git_branch_list,
            git::git_worktree_list,
            git::git_checkout,
            git::git_create_branch,
            git::git_remote_url,
            git::git_fetch,
            git::git_push,
            git::git_pull,
            git::git_show_files,
            git::git_show_file,
            git::git_log_file,
            git::git_log_file_lines,
            git::git_diff_commit,
            git::git_diff_lines,
            git::git_diff_working,
            font::font_list_monospace,
            font::font_list_all,
            codex::codex_check_available,
            codex::codex_start_session,
            codex::codex_disconnect,
            codex::codex_auth_status,
            codex::codex_auth_login_chatgpt,
            codex::codex_auth_logout,
            codex::codex_submit_turn,
            codex::codex_interrupt_turn,
            codex::codex_respond_approval,
            codex::codex_rollback_turn,
            codex::codex_compact_thread,
            codex::codex_model_list,
            claude_usage::claude_usage_get,
            claude_usage::rate::claude_usage_rate_get,
            codex_usage::codex_usage_get,
            agent::commands::agent_check_available,
            agent::commands::agent_ensure_installed,
            agent::commands::agent_start_session,
            agent::commands::agent_capabilities,
            agent::commands::agent_submit_turn,
            agent::commands::agent_interrupt_turn,
            agent::commands::agent_rollback_turn,
            agent::commands::agent_compact,
            agent::commands::agent_respond_approval,
            agent::commands::agent_auth_status,
            agent::commands::agent_auth_login,
            agent::commands::agent_auth_logout,
            agent::commands::agent_list_models,
            agent::commands::agent_disconnect,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Stop this instance's socat tunnel containers before the
                // process exits. Only when this session actually created a
                // tunnel (avoids stalling exit on a hung daemon); leftovers
                // from a hard kill are swept on next connect by label.
                if let Some(state) = app_handle.try_state::<docker::DockerState>() {
                    let created = state
                        .tunnels_created
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if let (true, Some(docker)) = (created, state.client.get()) {
                        let owner = docker::instance_owner(&state);
                        let _ = tauri::async_runtime::block_on(tokio::time::timeout(
                            std::time::Duration::from_secs(3),
                            docker::tunnel::cleanup_all(docker, &owner),
                        ));
                    }
                }
            }
        });
}
