mod agent;
mod claude_usage;
mod cli;
mod codex;
mod docker;
mod font;
mod fs;
mod git;
mod search;
mod project;
mod pty;
mod tasks;
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
/// Must match the prefix checked in isSecondaryWindow() in src/lib/window.ts
const SECONDARY_PREFIX: &str = "secondary-";

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
/// For Windows paths, uses PowerShell as the default shell.
fn create_adhoc_project(app: &AppHandle, path: &str) -> Option<project::ProjectConfig> {
    let state = app.try_state::<project::ProjectState>()?;

    let (root, shell) = if let Some(distro) = cli::wsl_distro_from_path(path) {
        // Convert UNC path to native WSL path: \\wsl.localhost\Ubuntu\home\user → /home/user
        let norm = path.replace('\\', "/");
        let prefix_localhost = format!("//wsl.localhost/{distro}/");
        let prefix_dollar = format!("//wsl$/{distro}/");
        let wsl_path = if let Some(rest) = norm.strip_prefix(&prefix_localhost) {
            format!("/{rest}")
        } else if let Some(rest) = norm.strip_prefix(&prefix_dollar) {
            format!("/{rest}")
        } else {
            return None;
        };
        (wsl_path, types::ShellConfig::Wsl { distro })
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
        format!("{}-{}", &base_id, ts % 100000)
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
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("Pike")
        .inner_size(800.0, 600.0)
        .resizable(true)
        .disable_drag_drop_handler()
        .build()
}

fn create_secondary_window(app: &AppHandle) -> String {
    let label = format!("{SECONDARY_PREFIX}{}", uuid::Uuid::new_v4());
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
    let _ = window.set_focus();
    let _ = app.emit_to(window.label(), "cli_open", action);
}

/// Handle the second-instance callback (deferred from WM_COPYDATA context).
fn handle_second_instance(app: &AppHandle, args: &[String], cwd: &str) {
    let wait_id = wait::extract_wait_id(args);
    let action = cli::parse_args(args, cwd);
    log::debug!("[single-instance] args={args:?}, cwd={cwd:?}, action={action:?}, wait_id={wait_id:?}");

    // --wait: register wait_id and always open in a new dedicated window
    if let Some(ref wid) = wait_id {
        if let cli::CliAction::OpenFile { ref path, .. } = action {
            if let Some(state) = app.try_state::<wait::WaitState>() {
                wait::register(&state, wid.clone(), path);
            }
            let label = create_secondary_window(app);
            store_pending(app, &label, action);
            return;
        }
    }

    match &action {
        cli::CliAction::None => {
            // No args: focus existing window on current desktop, or create new
            let windows = current_desktop_windows(app);
            if let Some(w) = windows.first() {
                let _ = w.unminimize();
                let _ = w.set_focus();
            } else {
                create_secondary_window(app);
            }
        }

        cli::CliAction::OpenDirectory { path } => {
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
            if let Some(proj) = create_adhoc_project(app, path) {
                let label = format!("{PROJECT_WINDOW_PREFIX}{}", proj.id);
                let _ = build_window(app, &label);
            } else {
                let label = create_secondary_window(app);
                store_pending(app, &label, action);
            }
        }

        cli::CliAction::OpenFile { path, .. } => {
            let projects = load_all_projects(app);
            let windows = current_desktop_windows(app);

            // 1. Window with a project that contains this file on this desktop? → open there
            for w in &windows {
                if let Some(pid) = window_project_id(w.label()) {
                    if let Some(proj) = projects.iter().find(|p| p.id == pid) {
                        if is_under_root(path, &proj.root) {
                            log::debug!("[single-instance] file: open in project window {}", w.label());
                            emit_action_to(app, w, &action);
                            return;
                        }
                    }
                }
            }

            // 2. No matching project window → new window + editor tab
            log::debug!("[single-instance] file: new secondary window");
            let label = create_secondary_window(app);
            store_pending(app, &label, action);
        }
    }
}

#[tauri::command]
async fn open_project_window(project_id: String, app: AppHandle) -> Result<(), String> {
    let label = format!("{}{}", PROJECT_WINDOW_PREFIX, project_id);
    if let Some(window) = app.get_webview_window(&label) {
        // Verify the window is actually visible — tauri-plugin-window-state may
        // keep a stale handle for a previously closed window.
        if window.is_visible().unwrap_or(false) {
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        let _ = window.close();
    }
    match build_window(&app, &label) {
        Ok(_) => Ok(()),
        Err(_) => {
            if let Some(w) = app.get_webview_window(&label) {
                w.set_focus().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

#[tauri::command]
fn save_all_window_state(app: AppHandle) -> Result<(), String> {
    app.save_window_state(StateFlags::all()).map_err(|e| e.to_string())
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
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
        }))
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
        })
        .manage(codex::CodexState::default())
        .manage(agent::state::AgentState::default())
        .setup(|app| {
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
                detected: std::sync::Mutex::new(None),
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
                    // Hide main instead of closing: Tauri tears down the async
                    // runtime when main is destroyed, which panics tokio::spawn
                    // in Codex cleanup while project windows are still active.
                    let has_others = window.app_handle().webview_windows()
                        .keys()
                        .any(|l| l != "main");
                    if has_others {
                        api.prevent_close();
                        let _ = window.emit("window-hide-requested", ());
                        if let Some(state) = window.try_state::<pty::PtyState>() {
                            pty::cleanup_for_window(&state, "main");
                        }
                        if let Some(state) = window.try_state::<project::ProjectState>() {
                            if let Some(pid) = project::take_window_project(&state, "main") {
                                let _ = project::remove_open_project(&state, &pid);
                            }
                        }
                        let _ = window.hide();
                    }
                }
                WindowEvent::Destroyed => {
                    // Abort any --wait processes when any window is destroyed
                    if let Some(state) = window.try_state::<wait::WaitState>() {
                        wait::signal_abort_all(&state);
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

                    // Single snapshot of all windows for remaining-window checks
                    let windows = window.app_handle().webview_windows();
                    let current = window.label();

                    // If this was the last visible project window, tell the
                    // hidden main to exit so the app shuts down gracefully.
                    if current != "main" {
                        let has_visible_project = windows.iter().any(|(l, w)| {
                            l.as_str() != current
                                && l.as_str() != "main"
                                && w.is_visible().unwrap_or(false)
                        });
                        if !has_visible_project {
                            let _ = window.app_handle().emit("app-should-exit", ());
                        }
                    }

                    // Global cleanup only when the last window is closing
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
            save_all_window_state,
            tasks::task_discover,
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
            search::search_detect_backend,
            search::search_execute,
            search::list_project_files,
            git::git_status,
            git::git_log,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard_changes,
            git::git_commit,
            git::git_branch_list,
            git::git_checkout,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
