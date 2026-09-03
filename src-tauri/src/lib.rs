/// macOS のアプリケーションメニュー（#254）。`Cmd+W` などを AppKit から奪い返す
/// 唯一の手段で、Windows / Linux にはメニューバーを出さない（ショートカットは
/// フロントの window keydown が拾う）。
#[cfg(target_os = "macos")]
mod appmenu;
#[cfg(not(target_os = "macos"))]
mod appmenu {
    pub fn refresh(
        _app: &tauri::AppHandle,
        _lang: &str,
        _actions: &[crate::types::MenuAction],
    ) {
    }
    pub fn on_menu_event(_app: &tauri::AppHandle, _event: tauri::menu::MenuEvent) {}
}
mod claude_usage;
mod cli;
mod codex_usage;
mod diagnostics;
mod docker;
/// タブバーへの OS ファイルドロップの実パス解決は WebView2 の COM API に依存する
/// （#見出し「タブバーへの OS ファイルドロップ」）。macOS の WKWebView には相当する
/// 経路が無いので、非 Windows では何もしない（ドロップは App.vue の window ガードが
/// 飲むだけで、実害はドロップからタブが開けないこと）。
#[cfg(windows)]
mod drop_paths;
#[cfg(not(windows))]
mod drop_paths {
    pub fn attach(_window: &tauri::WebviewWindow) {}
}
mod elevate;
mod font;
mod fs;
mod git;
mod ime_debug;
mod issues;
/// ジャンプリスト（タスクバー右クリック、#160）は `ICustomDestinationList` という
/// Windows 専用 COM API。macOS の Dock メニューは別物なので、ここでは何もしない
/// （トレイメニュー側は tray-icon が macOS を見るのでそのまま動く）。
#[cfg(windows)]
mod jumplist;
#[cfg(not(windows))]
mod jumplist {
    pub fn refresh(
        _lang: &str,
        _projects: &[crate::project::ProjectConfig],
        _shells: &[crate::types::MenuShell],
    ) {
    }
}
mod search;
mod project;
mod pty;
mod http;
mod page_title;
mod remote_image;
mod settings_sync;
mod tasks;
mod tray;
mod types;
/// main.rs から起動時に呼ぶ（macOS / Linux の GUI プロセスの PATH 補正）。
pub use types::augment_process_path;
pub mod wait;
mod watcher;
mod window_geom;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WebviewWindow, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

/// Prefix for project-window labels (`project-{uuid}`). Opaque to the frontend:
/// the window_projects map, not this label, says which project a window shows.
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

/// Set when main was hidden by its own close while close-to-tray is off (#202).
/// Main can never be destroyed — it owns the async runtime — so hiding stands in
/// for closing it, and this flag says the window is logically gone: it no longer
/// keeps Pike alive, and the app exits once the last real window closes. Cleared
/// whenever main is shown again (tray click, "Show", project focus).
static MAIN_CLOSED_HIDDEN: AtomicBool = AtomicBool::new(false);

/// Whether the window backdrop setting is `acrylic` (#277).
///
/// DWM turns the `DWMWA_SYSTEMBACKDROP_TYPE` material off for an *inactive*
/// window and paints an opaque fallback behind it, so an unfocused Pike stopped
/// looking translucent at all even though its per-pixel alpha was still on. The
/// material is therefore taken off on blur and asked for again on focus, which
/// leaves the plain `transparent` look (no blur, still see-through) in between.
/// The focus handler needs to know the setting, and `window_set_backdrop` is
/// stateless, so it is mirrored here — the same trick `CLOSE_TO_TRAY` uses for a
/// frontend setting Rust cannot read. One flag for the process is enough: the
/// setting lives in `pike:settings`, which every window shares and re-broadcasts.
#[cfg(windows)]
static ACRYLIC_BACKDROP: AtomicBool = AtomicBool::new(false);

/// Put the acrylic material on the window, or take it off, following the
/// setting and the window's focus. Taking it off leaves the per-pixel alpha
/// alone, so the window stays see-through. Must run on the thread owning it.
///
/// Takes the handle trait window-vibrancy itself asks for, so both callers pass
/// what they already hold: the window-event handler a `Window`, the command a
/// `WebviewWindow`.
#[cfg(windows)]
fn sync_acrylic_material(window: impl raw_window_handle::HasWindowHandle, focused: bool) {
    if ACRYLIC_BACKDROP.load(Ordering::Relaxed) && focused {
        let _ = window_vibrancy::apply_acrylic(window, None);
    } else {
        let _ = window_vibrancy::clear_acrylic(window);
    }
}

/// The dark theme's opaque surface color, kept in sync with `--bg-primary-rgb`
/// in `src/assets/theme.css`. Used as the pre-mount window background and as the
/// fallback when the frontend's color cannot be parsed (issue #162).
const DARK_SURFACE_RGB: (u8, u8, u8) = (30, 30, 30);

/// The window's `HWND` as the `windows` crate version this crate depends on
/// directly. `WebviewWindow::hwnd()` hands back tauri's own `HWND`, which comes
/// from an older `windows` release and is therefore a *different* type, so the
/// handle has to be re-wrapped through a raw pointer.
#[cfg(windows)]
fn win32_hwnd(window: &WebviewWindow, tag: &str) -> Option<windows::Win32::Foundation::HWND> {
    match window.hwnd() {
        Ok(h) => Some(windows::Win32::Foundation::HWND(h.0 as isize as *mut _)),
        Err(e) => {
            log::warn!("[{tag}] hwnd() failed: {e}");
            None
        }
    }
}

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

        let Some(hwnd) = win32_hwnd(window, "vdesktop") else {
            return true;
        };
        let hwnd_raw = hwnd.0 as isize;
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
    {
        // 仮想デスクトップという概念が無いので常に「見えている」。
        let _ = window;
        true
    }
}

pub(crate) fn iso_now() -> String {
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

pub(crate) fn normalize_path(p: &str) -> String {
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

/// The registered project whose root a path argument names, if any.
fn project_for_root<'a>(
    projects: &'a [project::ProjectConfig],
    path: &str,
) -> Option<&'a project::ProjectConfig> {
    let norm = normalize_path(path);
    projects.iter().find(|p| normalize_path(&p.root) == norm)
}

/// Read a lone path argument that names a registered project root as a
/// directory. `resolve_path_arg` can only ask the file system, so the root of a
/// project the sync file brought in and nobody cloned here yet (#212) — or of a
/// WSL project whose distro is stopped — looks like a file, and the launch would
/// end up as an editor tab on a directory. The jump list (#160) passes exactly
/// these roots, so route them as the project launch they are and let the window
/// offer to clone what is missing.
///
/// The correction lives here rather than in `parse_args` because the project
/// list is app state and the parser is deliberately free of it. Every caller of
/// `parse_args` therefore has to apply this.
fn as_project_dir(projects: &[project::ProjectConfig], action: cli::CliAction) -> cli::CliAction {
    if let cli::CliAction::OpenFiles { files } = &action {
        if let [f] = files.as_slice() {
            if f.line.is_none() && project_for_root(projects, &f.path).is_some() {
                return cli::CliAction::OpenDirectory {
                    path: f.path.clone(),
                    distro: f.distro.clone(),
                };
            }
        }
    }
    action
}

/// The id of the project whose root is `path` — registered, or transient (#230)
/// and therefore only alive as long as the window showing it. Both kinds live in
/// `window_projects`, so the caller can focus either one the same way.
fn project_id_for_root(app: &AppHandle, projects: &[project::ProjectConfig], path: &str) -> Option<String> {
    if let Some(proj) = project_for_root(projects, path) {
        return Some(proj.id.clone());
    }
    let state = app.try_state::<project::transient::TransientState>()?;
    state.find_by_root(path).map(|c| c.id)
}

/// The root of the project with `id`, registered or transient (#230). Only the
/// root is returned: a whole `ProjectConfig` would have to be cloned out of the
/// transient map, dragging along `last_session`, which holds the full text of
/// every unsaved editor buffer.
fn project_root_for_id(app: &AppHandle, projects: &[project::ProjectConfig], id: &str) -> Option<String> {
    if let Some(proj) = projects.iter().find(|p| p.id == id) {
        return Some(proj.root.clone());
    }
    let state = app.try_state::<project::transient::TransientState>()?;
    state.find_by_id_root(id)
}

/// Register a transient project for an unregistered directory and return its id.
/// Nothing is written to disk: the window offers to register the directory once
/// it is up, and the entry dies with the window (see `project/transient.rs`).
/// `projects` is the registered list the caller already loaded.
fn create_transient_project(
    app: &AppHandle,
    projects: &[project::ProjectConfig],
    path: &str,
    distro_hint: Option<&str>,
) -> Option<String> {
    let transient = app.try_state::<project::transient::TransientState>()?;
    let config = transient.create(projects, path, distro_hint)?;
    log::debug!("[transient] {} → {} ({:?})", config.id, config.root, config.shell);
    Some(config.id)
}

fn current_desktop_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .filter(is_on_current_virtual_desktop)
        .collect()
}

/// Build a window, restoring the size / position stored for `geom_key` (#200):
/// the project id for a project window, `GLOBAL_KEY` for a project-less one.
/// tauri-plugin-window-state cannot do this itself because these labels are
/// single-use uuids.
fn build_window(app: &AppHandle, label: &str, geom_key: &str) -> Result<WebviewWindow, tauri::Error> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("Pike")
        .inner_size(
            f64::from(window_geom::DEFAULT_LOGICAL_SIZE.0),
            f64::from(window_geom::DEFAULT_LOGICAL_SIZE.1),
        )
        .resizable(true);
    // 背景透過（issue #162）: 透過はランタイムで切替えるため常に透過ウィンドウで生成し、
    // 実際の透け方は window_set_backdrop が決める。アクリルもこの透過を前提に乗る。
    //
    // macOS では `transparent` は `macos-private-api` feature（App Store 非対応）が
    // 要るため、そもそもビルダーにメソッドが生えない。透過を諦めて不透明で生成する。
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let builder = builder
        // ただし window_set_backdrop はフロントの mount 後にしか走らないので、
        // それまでの数フレームは下地を不透明にしておく（既定の不透明モードで
        // デスクトップが一瞬透けるのを防ぐ）。tauri.conf.json の main ウィンドウ
        // 側は backgroundColor に同じ値を置いてある。
        .background_color(tauri::window::Color(
            DARK_SURFACE_RGB.0,
            DARK_SURFACE_RGB.1,
            DARK_SURFACE_RGB.2,
            255,
        ))
        // 保存した geometry は物理ピクセルなので、論理ピクセルを取るビルダーではなく
        // build 後に適用する（window_geom::restore）。既定サイズから復元サイズへ飛ぶのが
        // 見えないよう、非表示で生成して適用後に show する。
        .visible(false)
        .disable_drag_drop_handler();
    let window = builder.build()?;
    window_geom::restore(app, geom_key, &window);
    drop_paths::attach(&window);
    let _ = window.show();
    Ok(window)
}

fn create_global_window(app: &AppHandle) -> String {
    let label = format!("{GLOBAL_PREFIX}{}", uuid::Uuid::new_v4());
    let _ = build_window(app, &label, window_geom::GLOBAL_KEY);
    label
}

/// Build a project window with an opaque unique label, seeding `window_projects`
/// (label → project id) BEFORE the window is built. The label is meaningless on
/// its own — the map is the single source of truth for which project a window
/// shows — so the frontend's `project_for_window` and the focus resolution must
/// be able to read the entry the moment the webview mounts. An optional pending
/// CLI action is queued (also before build) for the new window to drain.
fn build_project_window(app: &AppHandle, project_id: &str, pending: Option<cli::CliAction>) -> String {
    let label = format!("{PROJECT_WINDOW_PREFIX}{}", uuid::Uuid::new_v4());
    if let Some(state) = app.try_state::<project::ProjectState>() {
        project::set_window_project(&state, &label, project_id);
    }
    if let Some(action) = pending {
        store_pending(app, &label, action);
    }
    let _ = build_window(app, &label, project_id);
    label
}

fn store_pending(app: &AppHandle, label: &str, action: cli::CliAction) {
    if let Some(state) = app.try_state::<cli::CliState>() {
        if let Ok(mut pending) = state.pending.lock() {
            pending.insert(label.to_string(), action);
        }
    }
}

/// Send a CLI action to an existing window via event. The window may be hidden
/// (main closed to the tray), so it goes through the shared restore.
fn emit_action_to(app: &AppHandle, window: &WebviewWindow, action: &cli::CliAction) {
    restore_window(window);
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
    // Both path-carrying shapes need the registered projects: to spot a root that
    // is not on this machine (`as_project_dir`) and to route to the window that
    // owns it. Read the list once here — the other shapes never look at it.
    let projects = if matches!(
        action,
        cli::CliAction::OpenFiles { .. } | cli::CliAction::OpenDirectory { .. }
    ) {
        load_all_projects(app)
    } else {
        Vec::new()
    };
    let action = as_project_dir(&projects, action);
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
            // 1. A window already on this root — registered or transient (#230)?
            //    → focus it, so a second `pike <dir>` never opens a duplicate.
            if let Some(id) = project_id_for_root(app, &projects, path) {
                if focus_project_window_anywhere(app, &id, None) {
                    log::debug!("[single-instance] dir: focus project window for {id}");
                    return;
                }
                // 2. Registered but no window → new window for that project.
                //    (A transient project cannot reach here: its entry is dropped
                //    with the window, so a match implies a live window.)
                log::debug!("[single-instance] dir: open project {id} in new window");
                build_project_window(app, &id, Some(action));
                return;
            }

            // 3. Unregistered directory → transient project window. The window
            //    asks whether to register it once it is up (#230).
            log::debug!("[single-instance] dir: transient window for {path}");
            if let Some(id) = create_transient_project(app, &projects, path, distro.as_deref()) {
                build_project_window(app, &id, None);
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

            // Files land on the desktop the user is on (current_desktop_windows),
            // unlike project focus which dedups to the canonical window anywhere.
            let windows = current_desktop_windows(app);
            let win_projects = window_projects_snapshot(app);

            // 1. Window whose project contains ALL files on this desktop? → open there
            for w in &windows {
                if let Some(pid) = win_projects.get(w.label()) {
                    // Transient projects (#230) are not in the list, and a window
                    // showing one owns its root just as much: `pike file.rs` from
                    // inside a directory opened without registering it must land
                    // there rather than in a new sidebar-less window.
                    if let Some(root) = project_root_for_id(app, &projects, pid) {
                        if files.iter().all(|f| is_under_root(&f.path, &root)) {
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
            if load_all_projects(app).iter().any(|p| &p.id == id)
                && !focus_project_window_anywhere(app, id, Some(&action))
            {
                build_project_window(app, id, Some(action.clone()));
            }
        }
    }
}

#[tauri::command]
async fn open_project_window(project_id: String, held: Option<Vec<String>>, app: AppHandle) -> Result<(), String> {
    // Guard as elsewhere: the id ends up in window_projects and as a CLI arg, so
    // reject anything outside [a-zA-Z0-9_-].
    types::validate_slug(&project_id, "Project ID")?;
    // 復元のときだけ「保持していたもの」を種として渡す（#264）。開いた側は
    // `project_held_for_window` で自分のぶんを読む。
    let held: Vec<String> = held
        .unwrap_or_default()
        .into_iter()
        .filter(|id| types::validate_slug(id, "Project ID").is_ok())
        .collect();
    // 既に見せている / 保持しているウィンドウがあればそちらへ（重複して開かない）。
    if focus_project_window_anywhere(&app, &project_id, None) {
        return Ok(());
    }
    let label = build_project_window(&app, &project_id, None);
    // 空なら何もしない（復元以外の経路は空で呼ぶ）。
    if let Some(state) = app.try_state::<project::ProjectState>() {
        project::seed_window_held(&state, &label, &held);
    }
    Ok(())
}

/// The project a window currently shows, plus the ones it holds (#264), from the
/// authoritative window_projects map (seeded at build for project windows). None
/// for main/global windows and any window not yet on a project. The frontend
/// calls this at startup to learn its project instead of parsing its (now
/// opaque) label.
///
/// **`held` を別のコマンドにしない。** 分けると、フロントが 2 回に分けて読むあいだに
/// 自分の `project_set_parked` がこの entry を上書きし、復元した保持一覧が黙って
/// 消える（実際に踏んだ）。1 回で返せばその順序の問題자体が無くなる。
#[tauri::command]
fn project_for_window(
    window: WebviewWindow,
    state: State<'_, project::ProjectState>,
) -> Option<project::WindowSession> {
    state
        .window_projects
        .lock()
        .ok()
        .and_then(|m| m.get(window.label()).cloned())
        .filter(|w| !w.shown.is_empty())
        .map(|w| project::WindowSession {
            shown: w.shown.clone(),
            held: w.parked(),
        })
}

/// Focus the window already showing `project_id`, if any. Returns whether one
/// was found — never builds. Lets the project panel jump to an existing window
/// instead of switching the current window in place (the caller does that when
/// this returns false).
#[tauri::command]
fn focus_project_window(project_id: String, app: AppHandle) -> bool {
    focus_project_window_anywhere(&app, &project_id, None)
}

/// Focus the project window for `id` if it's live, else build it. Shared by the
/// `open_project_window` command and the tray "recent project" menu.
fn focus_or_build_project_window(app: &AppHandle, id: &str) {
    if !focus_project_window_anywhere(app, id, None) {
        build_project_window(app, id, None);
    }
}

/// A cloned snapshot of label → the project that window shows.
/// Cloning lets callers drop the lock before touching window IPC in a loop.
fn window_projects_snapshot(app: &AppHandle) -> HashMap<String, String> {
    app.try_state::<project::ProjectState>()
        .and_then(|s| s.window_projects.lock().ok().map(|m| m.clone()))
        .map(|m| m.into_iter().map(|(label, w)| (label, w.shown)).collect())
        .unwrap_or_default()
}

/// `id` のウィンドウを前面に出す。**タブを保持しているだけのウィンドウも対象**（#264）で、
/// その場合は「そのプロジェクトへ切り替えろ」と伝える（保持しているタブがそのまま出る）。
///
/// これをしないと、保持中のプロジェクトをジャンプリストやトレイ、`pike <dir>` から開く
/// たびに新しいウィンドウができ、同じリポジトリでエージェントが二重に動く。
///
/// `action` を渡すと、見つけたウィンドウにそれをそのまま届ける（`--shell=` のような
/// 付随情報を落とさないため）。渡さなければ、保持しているウィンドウには「そのプロジェクトへ
/// 切り替えろ」だけを伝える。
fn focus_project_window_anywhere(app: &AppHandle, id: &str, action: Option<&cli::CliAction>) -> bool {
    let state = app.state::<project::ProjectState>();
    let Some((label, shown)) = project::window_holding(&state, id) else {
        return false;
    };
    let Some(w) = app.get_webview_window(&label) else {
        return false;
    };
    // 見せているウィンドウに用が無ければ前面に出すだけ。保持しているだけなら、そちらへ
    // 切り替えるよう伝える（保持しているタブがそのまま出る）。
    match action {
        Some(a) => emit_action_to(app, &w, a),
        None if shown => restore_window(&w),
        None => emit_action_to(
            app,
            &w,
            &cli::CliAction::OpenProject {
                id: id.to_string(),
                shell: None,
            },
        ),
    }
    true
}

/// Open a fresh global-mode (project-less) window with a terminal on the
/// frontend's configured global shell. Used by the project switcher's "Global
/// Mode" action when it can't reuse the current window (a project is active, or
/// the window is already global).
#[tauri::command]
async fn open_global_window(app: AppHandle) -> Result<(), String> {
    spawn_global_terminal_window(&app, None);
    Ok(())
}

/// Create a global-mode window and queue a terminal on `shell` — or, with None,
/// on the user's global shell (the frontend applies the globalShell setting).
/// Shared by the `open_global_window` command and the tray "New Terminal" menu,
/// whose per-shell submenu entries pass one (#240).
fn spawn_global_terminal_window(app: &AppHandle, shell: Option<types::ShellConfig>) {
    let label = create_global_window(app);
    store_pending(app, &label, cli::CliAction::OpenTerminal { cwd: None, shell });
}

#[tauri::command]
fn save_all_window_state(app: AppHandle) -> Result<(), String> {
    window_geom::record_all(&app);
    app.save_window_state(StateFlags::all()).map_err(|e| e.to_string())
}

/// Rebuild the shell-integration menus — the taskbar jump list (#160) and the
/// system-tray menu (#161). Called by the frontend on startup and whenever the
/// project set / names / recency / UI locale change. Reads the project list
/// once here and feeds both menus, instead of each re-scanning the projects
/// dir; `lang` carries the UI locale so labels follow it. `shells` is the user's
/// visible shell list — both menus offer one terminal entry per shell (#240; see
/// `types::MenuShell` for why the frontend has to hand it over).
#[tauri::command]
async fn menus_refresh(
    app: AppHandle,
    lang: String,
    shells: Vec<types::MenuShell>,
    actions: Vec<types::MenuAction>,
) -> Result<(), String> {
    let projects = app
        .try_state::<project::ProjectState>()
        .map(|s| project::read_all_projects_sorted(&s.config_dir))
        .unwrap_or_default();
    jumplist::refresh(&lang, &projects, &shells);
    // jumplist と違い tray は同期のまま。muda のメニュー構築は main スレッドに
    // 載って返るだけでシェルの解決（AppResolver / UNC）を伴わないため、jumplist を
    // ハングさせた経路には該当しない。ここに重い処理を足すときは jumplist と同じく
    // 専用スレッドへ逃がすこと。
    tray::refresh(&app, &lang, &projects, &shells);
    // macOS のメニューバー（#254）。ラベルもアクセラレータもフロントの持ち物なので
    // `actions` で受け取る（`MenuShell` と同じ理由）。
    appmenu::refresh(&app, &lang, &actions);
    Ok(())
}

/// Update the tray tooltip (issue #161). The main window pushes its formatted
/// usage summary (e.g. "Claude 5h 42%") so it is visible at a glance while Pike
/// sits minimized in the tray; the app name in front of it comes from
/// `tray::set_tooltip`, which is also where the dev-build marker lives.
#[tauri::command]
async fn tray_set_tooltip(app: AppHandle, detail: String) -> Result<(), String> {
    tray::set_tooltip(&app, &detail);
    Ok(())
}

/// Sync the close-to-tray setting from the frontend (issue #161). When disabled,
/// closing the main window exits Pike instead of hiding it to the tray — or,
/// with other windows open, hides it as logically closed (#202). Turning the
/// setting back on clears that state: main is then tray-resident again, so an
/// earlier close must not still make the last window's close quit Pike.
#[tauri::command]
async fn tray_set_close_to_tray(enabled: bool) -> Result<(), String> {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
    if enabled {
        MAIN_CLOSED_HIDDEN.store(false, Ordering::Relaxed);
    }
    Ok(())
}

/// Parse the `"R G B"` form of a CSS `rgb()` component list (e.g. `"30 30 30"`,
/// as `--bg-primary-rgb` is written in theme.css). Commas are tolerated so the
/// legacy `"30, 30, 30"` spelling also works. Returns `None` on anything else.
fn parse_rgb_triplet(s: &str) -> Option<(u8, u8, u8)> {
    let mut parts = s
        .split_whitespace()
        .map(|v| v.trim_end_matches(',').parse::<u8>());
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(Ok(r)), Some(Ok(g)), Some(Ok(b)), None) => Some((r, g, b)),
        _ => None,
    }
}

/// Turn the window's per-pixel alpha on or off (issue #162).
///
/// Windows are always *created* transparent because tao's `transparent` flag
/// cannot be flipped afterwards, but the effect it produces can: the flag only
/// makes tao call `DwmEnableBlurBehindWindow` with an empty blur region, which
/// is the standard trick for a per-pixel-alpha window. Undoing it in the opaque
/// mode puts the window back on the plain composition path instead of leaving
/// every user on the transparent one.
#[cfg(windows)]
unsafe fn set_per_pixel_alpha(hwnd: windows::Win32::Foundation::HWND, enable: bool) {
    use windows::Win32::Graphics::Dwm::{
        DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND,
    };
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, HRGN};

    // 空リージョン = 「どこもブラーしない」= ウィンドウ全体が per-pixel alpha。
    // tao の透過ウィンドウ生成と同じ指定にそろえてある。
    let region = if enable {
        CreateRectRgn(0, 0, -1, -1)
    } else {
        HRGN::default()
    };
    let bb = DWM_BLURBEHIND {
        dwFlags: if enable {
            DWM_BB_ENABLE | DWM_BB_BLURREGION
        } else {
            DWM_BB_ENABLE
        },
        fEnable: enable.into(),
        hRgnBlur: region,
        fTransitionOnMaximized: false.into(),
    };
    let _ = DwmEnableBlurBehindWindow(hwnd, &bb);
    if enable {
        let _ = DeleteObject(region.into());
    }
}

/// Apply (or clear) the window backdrop effect for background transparency
/// (issue #162). The frontend calls this per-window on startup and whenever the
/// `windowBackdrop` setting or the light/dark theme changes; each window applies
/// the effect to itself. `base_rgb` is the theme's opaque surface color as
/// `"R G B"` (read from the `--bg-primary-rgb` CSS variable, so theme.css stays
/// the single source of truth).
///
/// `none` restores the fully opaque path: the webview gets an opaque default
/// background and the window's per-pixel alpha is switched off. Otherwise the
/// webview background is made transparent so the CSS surface alpha composites over the
/// desktop, and `acrylic` additionally asks for the Windows 11 frosted-glass
/// material (on older systems that call fails and the plain translucency
/// remains as a graceful fallback). Errors are best-effort.
///
/// The native calls change window attributes, which belongs on the thread that
/// owns the window, so they are dispatched to main instead of running on the
/// invoking tokio worker (they used to run there). Dispatching does not wait, so
/// the command returns before the backdrop lands — fine for a cosmetic effect.
#[tauri::command]
async fn window_set_backdrop(
    window: WebviewWindow,
    kind: String,
    base_rgb: String,
) -> Result<(), String> {
    let opaque = kind == "none";
    // WebView2 は alpha 0 だけを透過として扱い、それ以外は不透明に丸める。
    // 不透明時にテーマ色を渡すのは、読み込み中・リサイズ中の地の色を合わせるため。
    let color = if opaque {
        // フォールバックは theme.css のダーク `--bg-primary-rgb` と同じ値。
        let (r, g, b) = parse_rgb_triplet(&base_rgb).unwrap_or(DARK_SURFACE_RGB);
        tauri::window::Color(r, g, b, 255)
    } else {
        tauri::window::Color(0, 0, 0, 0)
    };
    let _ = window.set_background_color(Some(color));

    #[cfg(windows)]
    {
        let w = window.clone();
        let acrylic = kind == "acrylic";
        ACRYLIC_BACKDROP.store(acrylic, Ordering::Relaxed);
        window
            .app_handle()
            .run_on_main_thread(move || {
                if let Some(hwnd) = win32_hwnd(&w, "backdrop") {
                    unsafe { set_per_pixel_alpha(hwnd, !opaque) };
                }
                if !acrylic {
                    // 旧ビルドが載せた mica の後始末。**効くのは Win11 22621 より前
                    // だけ**で、そこでは clear_acrylic とは別の属性を書く（22621 以降は
                    // どちらも DWMSBT_NONE なので、下の呼び出しと同じ書き込みになる）。
                    let _ = window_vibrancy::clear_mica(&w);
                }
                // 非アクティブのウィンドウには載せない（#277）。載せると DWM が
                // 不透明のフォールバックを塗り、透過そのものが効かなくなる。
                sync_acrylic_material(&w, w.is_focused().unwrap_or(true));
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = kind;
    Ok(())
}

/// Show, unminimize and focus a window — the restore-from-tray/minimized triple.
/// Showing main again undoes its logical close (#202): it counts as a live
/// window from here on.
fn restore_window(w: &WebviewWindow) {
    if w.label() == "main" {
        MAIN_CLOSED_HIDDEN.store(false, Ordering::Relaxed);
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// Hide main — the only window Pike ever hides, since it cannot be destroyed.
/// `logically_closed` is the decision this pairs with `restore_window`: true
/// means the user closed it (close-to-tray off) and it must stop keeping Pike
/// alive; false means it is merely out of sight (tray) and still counts as an
/// open window (#202).
fn hide_main_window(app: &AppHandle, logically_closed: bool) {
    MAIN_CLOSED_HIDDEN.store(logically_closed, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Whether destroying `label` would leave nothing to keep Pike running. A main
/// hidden by its own close (close-to-tray off) does not count — it is logically
/// closed, so the app must not outlive the last real window because of it (#202).
fn close_would_quit(app: &AppHandle, label: &str) -> bool {
    let main_closed = MAIN_CLOSED_HIDDEN.load(Ordering::Relaxed);
    app.webview_windows()
        .keys()
        .all(|l| l == label || (l == "main" && main_closed))
}

/// Whether closing this window would quit Pike, taking every window's PTYs with
/// it. The frontend asks before closing so it can confirm against the app-wide
/// count of running terminals instead of just its own tabs (#178).
#[tauri::command]
fn window_close_quits_app(window: WebviewWindow) -> bool {
    close_would_quit(window.app_handle(), window.label())
}

/// Show and focus the main window, restoring it from the tray / a minimized
/// state.
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        restore_window(&w);
    }
}

/// Toggle main window visibility from a tray left-click: hide it when it is the
/// foreground window, otherwise bring it back. Hiding here (like close-to-tray)
/// never destroys main, so the session and PTYs stay alive — and it is not a
/// close either, so main keeps counting as an open window.
pub(crate) fn toggle_main_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        hide_main_window(app, false);
    } else {
        restore_window(&w);
    }
}

/// Quit Pike. The frontend calls this after confirming the close of a main
/// window whose `closeToTray` is off (#178) — the raw close is always prevented
/// so that confirmation can happen first.
#[tauri::command]
async fn app_exit(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// Dispatch a tray menu click (see `tray::build_menu` for the item ids).
pub(crate) fn tray_menu_action(app: &AppHandle, id: &str) {
    match id {
        "tray:show" => show_main_window(app),
        "tray:new-terminal" => spawn_global_terminal_window(app, None),
        "tray:switcher" => {
            show_main_window(app);
            // The main window listens for this and opens the project switcher.
            let _ = app.emit_to("main", "tray-open-switcher", ());
        }
        "tray:quit" => app.exit(0),
        // Per-shell terminal entries (#240). An id that no longer parses (a stale
        // menu, a distro that was renamed) opens nothing rather than falling back
        // to another shell.
        _ if id.starts_with("tray:new-terminal:") => {
            if let Some(shell) = types::shell_from_id(&id["tray:new-terminal:".len()..]) {
                spawn_global_terminal_window(app, Some(shell));
            }
        }
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
    tokio::task::spawn_blocking(move || types::os_open(&url))
        .await
        .map_err(|e| e.to_string())?
}

/// フォルダ / ファイル選択ダイアログ。OS ごとに丸ごと差し替える。
///
/// **コマンドの本体に cfg のピラミッドを 3 回書かないこと。** 以前は 3 つのコマンドが
/// それぞれ macOS / Windows / それ以外の 3 分岐を持ち、cfg 属性が 13 個あった。
/// プラットフォームを増やすときに 3 つの本体を全部直すことになる。
///
/// **キャンセルの見分け方が OS で違う**: PowerShell 版は ShowDialog が OK 以外だと
/// 空文字を出し、`osascript` は終了コード 1 で終わる。`spawn` がどちらも `None` に畳む。
mod dialog {
    /// ダイアログを外部プログラムで出し、選ばれたパスを返す。
    ///
    /// Rust のダイアログ crate を使わず OS 付属のものを叩くのは、元々そうなっていたから。
    #[cfg(any(windows, target_os = "macos"))]
    async fn spawn(program: String, args: Vec<String>) -> Result<Option<String>, String> {
        tokio::task::spawn_blocking(move || {
            let output = crate::types::silent_command(&program)
                .args(&args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Ok(None);
            }
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(if path.is_empty() { None } else { Some(path) })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// WinForms のダイアログ。`script` は `$f = New-Object ...` の部分。
    ///
    /// **pwsh があればそちらで出す**（#271）。PowerShell 7 は .NET 5+ なので、同じ
    /// `FolderBrowserDialog` がモダンなダイアログになる（アドレス欄でパスを打て、
    /// ナビゲーションペインに WSL の「Linux」が出る）。`powershell.exe` の .NET Framework
    /// は旧式の「フォルダーの参照」ツリーで、UNC を打ち込む手段が無い。
    #[cfg(windows)]
    async fn powershell(script: String) -> Result<Option<String>, String> {
        let cmd = format!("Add-Type -AssemblyName System.Windows.Forms; {script}");
        // pwsh の探索は PATH を辿る stat の連なりなので、実行と同じくブロッキング側で行う
        // （`spawn` が `spawn_blocking` を使っているのと同じ理由。ここで直に呼ぶと、
        // ダイアログを開くたびに tokio のワーカーが PTY の出力ごと止まる）。
        let program = tokio::task::spawn_blocking(|| {
            crate::pty::find_pwsh_path().unwrap_or_else(|| "powershell.exe".to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
        spawn(program, vec!["-NoProfile".into(), "-Command".into(), cmd]).await
    }

    /// PowerShell のリテラルに埋める（単引用符の中では引用符を重ねるのが唯一の逃げ方）。
    #[cfg(windows)]
    fn ps_quote(value: &str) -> String {
        format!("'{}'", value.replace("'", "''"))
    }

    /// `initial` はダイアログの初期位置（#271）。WSL プロジェクトでは
    /// `wsl.localhost` の UNC を渡すので、そのまま WSL の中から選べる。
    #[cfg(windows)]
    pub async fn folder(initial: Option<String>) -> Result<Option<String>, String> {
        let seed = initial
            .filter(|p| !p.is_empty())
            .map(|p| format!("$f.SelectedPath = {};", ps_quote(&p)))
            .unwrap_or_default();
        powershell(format!(
            "$f = New-Object System.Windows.Forms.FolderBrowserDialog; {seed} if($f.ShowDialog() -eq 'OK'){{$f.SelectedPath}}"
        ))
        .await
    }

    #[cfg(windows)]
    pub async fn open(extensions: &[String]) -> Result<Option<String>, String> {
        let patterns = extensions
            .iter()
            .map(|e| format!("*.{e}"))
            .collect::<Vec<_>>()
            .join(";");
        // Filter syntax is `description|patterns`; the patterns read fine as their
        // own description.
        powershell(format!(
            "$f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = '{patterns}|{patterns}'; if($f.ShowDialog() -eq 'OK'){{$f.FileName}}"
        ))
        .await
    }

    #[cfg(windows)]
    pub async fn save(default_name: Option<String>) -> Result<Option<String>, String> {
        // PowerShell single-quoted strings only interpret '' as an escaped quote;
        // no other character ($, `, ;, ...) is special inside them.
        let name = default_name.unwrap_or_default().replace('\'', "''");
        powershell(format!(
            "$f = New-Object System.Windows.Forms.SaveFileDialog; $f.FileName = '{name}'; if($f.ShowDialog() -eq 'OK'){{$f.FileName}}"
        ))
        .await
    }

    /// `osascript` の `choose ...` は AppleScript のエイリアスを返すので、スクリプト側で
    /// `POSIX path of` を通して普通のパスにする。
    #[cfg(target_os = "macos")]
    async fn osascript(script: String) -> Result<Option<String>, String> {
        spawn("osascript".into(), vec!["-e".into(), script]).await
    }

    /// AppleScript の文字列リテラルへ埋め込む。特別扱いが要るのは 2 文字だけ。
    #[cfg(target_os = "macos")]
    fn applescript_quote(s: &str) -> String {
        s.replace('\\', "\\\\").replace('"', "\\\"")
    }

    /// `initial` はダイアログの初期位置（#271）。
    ///
    /// **渡す前に実在を確かめる。** `POSIX file` はパスを参照に変えるだけで存在確認を
    /// しないので、消えたディレクトリを渡すと `choose folder` がエラーで終わる。
    /// それは終了コードでしか分からず、`spawn` はキャンセルと同じ `None` に畳むため、
    /// 「ダイアログが一瞬で閉じた」ようにしか見えない。
    #[cfg(target_os = "macos")]
    pub async fn folder(initial: Option<String>) -> Result<Option<String>, String> {
        let at = initial
            .filter(|p| std::path::Path::new(p).is_dir())
            .map(|p| format!(" default location (POSIX file \"{}\")", applescript_quote(&p)))
            .unwrap_or_default();
        osascript(format!("POSIX path of (choose folder{at})")).await
    }

    #[cfg(target_os = "macos")]
    pub async fn open(extensions: &[String]) -> Result<Option<String>, String> {
        // `choose file of type` は拡張子と UTI のどちらも受ける。呼び出し側で英数字だけに
        // 絞ってあるので、AppleScript のリテラルとしてそのまま並べられる。
        let types = extensions
            .iter()
            .map(|e| format!("\"{e}\""))
            .collect::<Vec<_>>()
            .join(", ");
        osascript(format!("POSIX path of (choose file of type {{{types}}})")).await
    }

    #[cfg(target_os = "macos")]
    pub async fn save(default_name: Option<String>) -> Result<Option<String>, String> {
        let name = applescript_quote(&default_name.unwrap_or_default());
        osascript(format!("POSIX path of (choose file name default name \"{name}\")")).await
    }

    /// Windows でも macOS でもないホスト（Linux）。ネイティブのピッカーは実装していない。
    ///
    /// **`powershell` へ落とさないこと。** cfg を「macOS かそれ以外か」で切っていたころは
    /// Linux が `powershell.exe` を起動しに行き、終了コード判定に当たって意味の分からない
    /// エラーになっていた（`powershell` という名前の別物が PATH にあれば、黙って
    /// 「キャンセルされた」ことになる）。実装が無いことを言う。
    #[cfg(not(any(windows, target_os = "macos")))]
    fn unsupported() -> Result<Option<String>, String> {
        Err("file dialogs are not implemented on this platform".into())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub async fn folder(_initial: Option<String>) -> Result<Option<String>, String> {
        unsupported()
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub async fn open(_extensions: &[String]) -> Result<Option<String>, String> {
        unsupported()
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub async fn save(_default_name: Option<String>) -> Result<Option<String>, String> {
        unsupported()
    }
}

#[tauri::command]
async fn pick_folder(initial: Option<String>) -> Result<Option<String>, String> {
    dialog::folder(initial).await
}

/// Open-file dialog restricted to the given extensions (#241).
///
/// The extensions end up inside a shell/AppleScript command line, so they are
/// checked here rather than trusted: the front end decides which formats to
/// offer, but this is what builds the process arguments.
#[tauri::command]
async fn pick_open_file(extensions: Vec<String>) -> Result<Option<String>, String> {
    let usable: Vec<String> = extensions
        .iter()
        .filter(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| e.to_ascii_lowercase())
        .collect();
    if usable.is_empty() {
        return Err("no usable extensions".into());
    }
    dialog::open(&usable).await
}

#[tauri::command]
async fn pick_save_file(default_name: Option<String>) -> Result<Option<String>, String> {
    dialog::save(default_name).await
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Elevated relaunch (open_elevated_terminal) passes `--new-instance`: skip
    // single-instance so the admin process runs as its own window instead of
    // forwarding its terminal request to the existing non-elevated instance
    // (WM_COPYDATA from elevated → non-elevated would open the shell unelevated).
    let standalone = std::env::args().any(|a| a == "--new-instance");

    // Typed explicitly: bound to a variable, the runtime can no longer be inferred
    // from the `build()` call at the end.
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    // Before the window-state plugin loads its file into memory (#200): it writes
    // the whole cache back on every save, so pruning later would be undone.
    window_geom::prune_plugin_state(&context.config().identifier);

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
        // Only `main` has a stable label; project / global windows get a fresh
        // uuid per launch, so tracking them here can never restore anything and
        // only grows the state file with dead entries. Their geometry is keyed by
        // project in `window_geom` instead (#200).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filter(|label| label == window_geom::TRACKED_LABEL)
                .build(),
        )
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
        // macOS のメニューバーのクリック（#254）。トレイのメニュー項目も同じ
        // リスナに届くので、`appmenu` 側が自分の id 接頭辞だけを拾う。
        .on_menu_event(appmenu::on_menu_event)
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
                last_written_sessions: std::sync::Mutex::new(None),
            });
            // Directories opened without registering them (#230). Managed here
            // because the cold-start CLI routing below already needs it.
            app.manage(project::transient::TransientState::default());

            // Resolve bundled rg sidecar path (externalBin places it next to the executable)
            let rg_path = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
                .and_then(|dir| {
                    // externalBin はトリプルの接尾辞を外した名前で置く。拡張子が付くのは
                    // Windows だけなので、名前を決め打ちにすると macOS で見つからず、
                    // 検索が黙って grep に落ちる（エラーは出ない）。
                    let name = if cfg!(windows) { "rg.exe" } else { "rg" };
                    let p = dir.join(name);
                    p.exists().then(|| p.to_string_lossy().into_owned())
                });
            app.manage(search::SearchState {
                bundled_rg: rg_path,
                detected: std::sync::Arc::new(std::sync::Mutex::new(
                    std::collections::HashMap::new(),
                )),
            });
            app.manage(issues::IssuesState::default());

            // Parse initial CLI args and store for frontend to retrieve
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let mut action = cli::parse_args(&args, &cwd);
            // Cold start on a project root (`pike <dir>`, a jump list entry with
            // Pike closed): hand the main window that project before its webview
            // mounts, the same way a running instance routes those arguments to a
            // project window. The frontend reads `project_for_window`, switches to
            // it instead of restoring the last session, and clears the open list.
            // Only the path-carrying shapes can name a root, so a plain launch
            // still reads no project files here.
            if matches!(
                action,
                cli::CliAction::OpenFiles { .. } | cli::CliAction::OpenDirectory { .. }
            ) {
                let projects = load_all_projects(app.handle());
                action = as_project_dir(&projects, action);
                if let cli::CliAction::OpenDirectory { ref path, ref distro } = action {
                    // Unregistered directories get a transient project (#230) here
                    // too, so a cold `pike <dir>` behaves like a warm one instead
                    // of falling through to the previous session.
                    let id = project_for_root(&projects, path)
                        .map(|p| p.id.clone())
                        .or_else(|| create_transient_project(app.handle(), &projects, path, distro.as_deref()));
                    if let (Some(id), Some(state)) = (id, app.try_state::<project::ProjectState>()) {
                        project::set_window_project(&state, "main", &id);
                    }
                }
            }
            if !matches!(action, cli::CliAction::None) {
                if let Some(state) = app.try_state::<cli::CliState>() {
                    *state.initial_action.lock().unwrap() = Some(action);
                }
            }

            // macOS のアプリケーションメニュー（#254）。これを設定しないと Tauri の
            // 既定メニューが付き、`Cmd+W` がタブではなくウィンドウを閉じる。
            // UI 言語が分かるのは mount 後なので、まず英語で置く。
            appmenu::refresh(app.handle(), "en", &[]);

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
            // Per-project geometry (#200). The debounced handler below covers moves
            // and resizes; a window closed inside its 500ms quiet window would
            // otherwise lose the last one.
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                window_geom::record_all(window.app_handle());
            }
            match event {
                WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    // Always prevent the raw close first: main owns the async
                    // runtime, so destroying it takes down every other window's
                    // async command with it.
                    api.prevent_close();
                    if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                        // Close-to-tray (issue #161): hide main and keep the
                        // session + PTYs + polling alive; the tray icon restores
                        // it, and the tray "Quit" item is the real exit.
                        hide_main_window(window.app_handle(), false);
                        let _ = window.emit("main-minimized-to-tray", ());
                    } else if !close_would_quit(window.app_handle(), window.label()) {
                        // Setting off, but other windows are open: closing main
                        // must not take them down with it (#21/#53/#202). Main
                        // cannot be destroyed, so hide it as logically closed —
                        // Pike then exits when the last real window goes.
                        hide_main_window(window.app_handle(), true);
                        let _ = window.emit("main-window-hidden", ());
                    } else {
                        // Setting off and main is the last window: closing it
                        // exits Pike, which kills every window's PTYs at once.
                        // Hand the decision to the frontend so a terminal still
                        // running something can be confirmed first (#178); it
                        // calls `app_exit` once the user agrees.
                        let _ = window.emit("main-exit-requested", ());
                    }
                }
                // アクリルは非アクティブのあいだ外す（#277。理由は ACRYLIC_BACKDROP
                // の doc）。ここは event loop（= main）の上なので DWM を直接叩いて
                // よいが、**アクリルでなければ何もしない**: 既定の不透明モードで
                // 全ウィンドウの focus / blur ごとに dwmapi を叩くことになるうえ、
                // 外す仕事は設定を変えた経路が既に済ませている。
                #[cfg(windows)]
                WindowEvent::Focused(focused) => {
                    if ACRYLIC_BACKDROP.load(Ordering::Relaxed) {
                        sync_acrylic_material(window, *focused);
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
                    // window_projects (label → current project) is the source of
                    // truth; draining it also removes the entry so the map can't
                    // leak, and removes the project the window actually shows
                    // (not the one its opaque label was minted for).
                    if let Some(state) = window.try_state::<project::ProjectState>() {
                        if let Some(pid) = project::take_window_project(&state, window.label()) {
                            // A transient project (#230) lives exactly as long as
                            // the window showing it, and was never in the open
                            // list, so dropping the entry is the whole cleanup.
                            let transient = window
                                .try_state::<project::transient::TransientState>()
                                .and_then(|t| t.remove(&pid));
                            if transient.is_none() {
                                // このウィンドウは既にマップから消えているので、
                                // 生きているぶんを書き直せば足りる（#264）。
                                if let Err(e) = project::write_open_windows(&state) {
                                    log::warn!("Failed to rewrite the open window list: {e}");
                                }
                            }
                        }
                    }

                    if let Some(state) = window.try_state::<pty::PtyState>() {
                        pty::cleanup_for_window(&state, window.label());
                    }

                    // Global cleanup only when the last window is closing. With
                    // close-to-tray (issue #161) main is only ever destroyed on
                    // an explicit tray Quit (app.exit), so a closing project
                    // window is never the last one and the app stays resident in
                    // the tray instead of auto-exiting. A main that was closed
                    // with the setting off is the exception: it is logically gone
                    // (#202), so this really is the last window and Pike quits
                    // below once the cleanup has run.
                    if !close_would_quit(window.app_handle(), window.label()) {
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
                    // Only a hidden, logically closed main is left, and it cannot
                    // close itself: quit for real (#202). The `!= "main"` guard
                    // is not the same test as `close_would_quit` above — it says
                    // we are not already inside a teardown (tray Quit destroys
                    // main), which would otherwise exit a second time.
                    if window.label() != "main" && MAIN_CLOSED_HIDDEN.load(Ordering::Relaxed) {
                        window.app_handle().exit(0);
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
                                    window_geom::record_all(&app);
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
            project_for_window,
            focus_project_window,
            open_global_window,
            menus_refresh,
            tray_set_tooltip,
            tray_set_close_to_tray,
            window_set_backdrop,
            ime_debug::ime_debug_enabled,
            ime_debug::ime_debug_log,
            elevate::is_elevated,
            elevate::open_elevated_terminal,
            save_all_window_state,
            tasks::task_discover,
            diagnostics::diagnostics_run,
            open_url,
            page_title::page_title_fetch,
            remote_image::remote_image_fetch,
            pick_folder,
            pick_save_file,
            pick_open_file,
            pty::pty_spawn,
            pty::pty_spawn_tmux,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_busy,
            pty::pty_busy_count,
            app_exit,
            window_close_quits_app,
            pty::pty_get_cwd,
            project::detect_wsl_distros,
            project::project_get_last,
            project::project_add_open,
            project::project_set_parked,
            project::transient::project_transient_create,
            project::transient::project_transient_get,
            project::transient::project_transient_bind,
            project::transient::project_transient_drop,
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
            fs::fs_import_file,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_write_file_base64,
            fs::fs_resolve_first_existing,
            fs::fs_dirs_exist,
            fs::fs_open_in_explorer,
            settings_sync::settings_sync_read,
            settings_sync::settings_sync_write,
            watcher::fs_watch_start,
            watcher::fs_watch_stop,
            docker::docker_ping,
            docker::docker_compose_discover,
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
            issues::issues_gh_available,
            issues::issues_list,
            issues::issues_view,
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
            git::git_checkout_track,
            git::git_create_branch,
            git::git_remote_url,
            git::git_remote_urls,
            git::git_fetch,
            git::git_push,
            git::git_pull,
            git::git_show_files,
            git::git_show_file,
            git::git_show_file_base64,
            git::git_log_file,
            git::git_log_file_lines,
            git::git_diff_commit,
            git::git_diff_lines,
            git::git_diff_working,
            font::font_list_monospace,
            font::font_list_all,
            claude_usage::claude_usage_get,
            claude_usage::rate::claude_usage_rate_get,
            claude_usage::sessions::claude_sessions_list,
            codex_usage::codex_usage_get,
        ])
        .build(context)
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Tray "Quit" destroys windows without a CloseRequested, so this is
                // the only chance to catch a resize made in the last 500ms (#200).
                window_geom::record_all(app_handle);
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

#[cfg(test)]
mod tests {
    use super::{as_project_dir, parse_rgb_triplet, project_for_root};
    use crate::cli::{CliAction, CliFileTarget};
    use crate::project::ProjectConfig;
    use crate::types::ShellConfig;

    fn project(id: &str, root: &str) -> ProjectConfig {
        ProjectConfig {
            id: id.to_string(),
            name: id.to_string(),
            root: root.to_string(),
            shell: ShellConfig::Powershell,
            pinned_tabs: vec![],
            last_opened: String::new(),
            last_session: None,
            group: None,
            color: None,
            icon: None,
            order: None,
            remote_url: None,
            golangci_command: None,
        }
    }

    fn open_file(path: &str, line: Option<u32>) -> CliAction {
        CliAction::OpenFiles {
            files: vec![CliFileTarget {
                path: path.to_string(),
                line,
                distro: Some("Ubuntu".to_string()),
            }],
        }
    }

    #[test]
    fn project_root_arg_is_read_as_a_directory() {
        // A project registered here but not cloned onto this machine (#212):
        // the path does not exist, so parse_args could only call it a file.
        let projects = vec![project("pike", "/home/kan/pike")];
        match as_project_dir(&projects, open_file("/home/kan/pike", None)) {
            CliAction::OpenDirectory { path, distro } => {
                assert_eq!(path, "/home/kan/pike");
                assert_eq!(distro.as_deref(), Some("Ubuntu"));
            }
            other => panic!("expected OpenDirectory, got: {other:?}"),
        }
    }

    #[test]
    fn other_file_args_are_left_alone() {
        let projects = vec![project("pike", "/home/kan/pike")];
        // Not a project root.
        assert!(matches!(
            as_project_dir(&projects, open_file("/home/kan/pike-notes.md", None)),
            CliAction::OpenFiles { .. }
        ));
        // A line number means a real file was asked for, root or not.
        assert!(matches!(
            as_project_dir(&projects, open_file("/home/kan/pike", Some(12))),
            CliAction::OpenFiles { .. }
        ));
        // Multiple paths are an "open these files" request (drag & drop).
        let many = CliAction::OpenFiles {
            files: vec![
                CliFileTarget { path: "/home/kan/pike".to_string(), line: None, distro: None },
                CliFileTarget { path: "/home/kan/a.rs".to_string(), line: None, distro: None },
            ],
        };
        assert!(matches!(as_project_dir(&projects, many), CliAction::OpenFiles { .. }));
    }

    #[test]
    fn root_match_ignores_case_and_separators() {
        let projects = vec![project("app", r"C:\src\App")];
        assert!(project_for_root(&projects, r"c:/src/app/").is_some());
        assert!(project_for_root(&projects, r"C:\src\App\sub").is_none());
    }

    #[test]
    fn parses_css_component_list() {
        assert_eq!(parse_rgb_triplet("30 30 30"), Some((30, 30, 30)));
        // getComputedStyle may hand back the value with surrounding space.
        assert_eq!(parse_rgb_triplet("  255 255 255 "), Some((255, 255, 255)));
        assert_eq!(parse_rgb_triplet("37, 37, 38"), Some((37, 37, 38)));
    }

    #[test]
    fn rejects_malformed_input() {
        assert_eq!(parse_rgb_triplet(""), None);
        assert_eq!(parse_rgb_triplet("30 30"), None);
        assert_eq!(parse_rgb_triplet("30 30 30 30"), None);
        assert_eq!(parse_rgb_triplet("30 30 300"), None);
        assert_eq!(parse_rgb_triplet("#1e1e1e"), None);
    }
}
