//! Window size / position for project and global windows (#200).
//!
//! `tauri-plugin-window-state` keys its state by window label, and Pike gives
//! every project / global window a fresh uuid label per launch (#175, the label
//! is deliberately opaque because a window can switch projects in place). The
//! plugin can therefore only ever restore `main`, and its state file collects one
//! dead entry per window ever opened.
//!
//! So the plugin is limited to `main` (see `TRACKED_LABEL`), and geometry for the
//! other windows lives here, keyed by the project the window shows — which is
//! what the user actually means by "this project's window". Machine-local on
//! purpose: monitor layouts differ per machine, so this never goes into the
//! synced `project.json`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// The only window label `tauri-plugin-window-state` still tracks.
pub const TRACKED_LABEL: &str = "main";

/// Key shared by all global (project-less) windows.
pub const GLOBAL_KEY: &str = "global";

/// Size a window opens at with nothing stored for it, in the logical pixels the
/// window builder takes. Everything stored in this module is physical instead,
/// so `default_rect` converts.
pub const DEFAULT_LOGICAL_SIZE: (u32, u32) = (800, 600);

const FILENAME: &str = "window-geometry.json";

/// A window rect in **physical** pixels, as `inner_size` / `outer_position`
/// report it and `set_size` / `set_position` take it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

fn file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILENAME))
}

fn load(app: &AppHandle) -> HashMap<String, Geometry> {
    let Some(path) = file_path(app) else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store(app: &AppHandle, map: &HashMap<String, Geometry>) {
    let Some(path) = file_path(app) else { return };
    let Ok(bytes) = serde_json::to_vec_pretty(map) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, bytes);
}

/// Geometry key for a window: the project it currently shows, or `GLOBAL_KEY` for
/// a project-less one. `main` is recorded too, even though the plugin restores it
/// by label: the first restored project opens in main, and without this its size
/// would be forgotten the moment that project moves to a window of its own.
fn key_for(app: &AppHandle, label: &str) -> String {
    app.try_state::<crate::project::ProjectState>()
        .and_then(|state| state.window_projects.lock().ok().and_then(|map| map.get(label).cloned()))
        .unwrap_or_else(|| GLOBAL_KEY.to_string())
}

/// The rect to restore the window to. None while it is maximized or minimized:
/// those report the filled / hidden rect, which would overwrite the rect the
/// window should return to.
fn restorable_rect(window: &WebviewWindow) -> Option<Geometry> {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return None;
    }
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(Geometry {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: false,
    })
}

/// Record every window's geometry under its project. Called from the debounced
/// move/resize handler, before a window closes, and at exit, so one file write
/// covers all windows.
pub fn record_all(app: &AppHandle) {
    let mut map = load(app);
    let mut changed = false;
    for window in app.webview_windows().into_values() {
        let key = key_for(app, window.label());
        let maximized = window.is_maximized().unwrap_or(false);
        // While maximized or minimized, keep the stored rect (so un-maximizing after
        // a restore lands where the user left it) and update only the flag. With
        // nothing stored — maximized right after opening — fall back to the default
        // size, which at least carries the maximized state into the next launch.
        let rect = restorable_rect(&window)
            .or_else(|| map.get(&key).copied())
            .unwrap_or_else(|| default_rect(&window));
        let next = Geometry { maximized, ..rect };
        if map.get(&key) != Some(&next) {
            map.insert(key, next);
            changed = true;
        }
    }
    if changed {
        store(app, &map);
    }
}

fn default_rect(window: &WebviewWindow) -> Geometry {
    let position = window.outer_position().unwrap_or(PhysicalPosition { x: 0, y: 0 });
    let size: PhysicalSize<u32> = LogicalSize::new(DEFAULT_LOGICAL_SIZE.0, DEFAULT_LOGICAL_SIZE.1)
        .to_physical(window.scale_factor().unwrap_or(1.0));
    Geometry {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: false,
    }
}

/// Apply the stored geometry for `key` to a freshly built window, which the
/// caller then shows. Everything here is in physical pixels, matching what the
/// rect was recorded in.
///
/// It has to happen after `build()` for that reason: the builder's `inner_size`
/// and `position` take *logical* pixels, so handing them a recorded rect scales
/// the window up by the display's scale factor — a 150% display reopened every
/// window 1.5x too wide and that much further right. Building the window hidden
/// keeps this from showing as a jump from the default rect.
pub fn restore(app: &AppHandle, key: &str, window: &WebviewWindow) {
    let Some(geom) = load(app).get(key).copied() else {
        return;
    };
    // Only restore the position while it still lands on a monitor: an unplugged
    // second display would otherwise put the window out of reach. Position first,
    // so that moving onto a display with a different scale factor (which makes
    // Windows resize the window to match) cannot undo the size set below.
    if on_some_monitor(app, &geom) {
        let _ = window.set_position(PhysicalPosition { x: geom.x, y: geom.y });
    }
    let _ = window.set_size(PhysicalSize {
        width: geom.width,
        height: geom.height,
    });
    // After the rect, not via the builder: maximizing a window that already sits
    // on its stored rect leaves that rect as the one un-maximizing returns to.
    if geom.maximized {
        let _ = window.maximize();
    }
}

fn on_some_monitor(app: &AppHandle, geom: &Geometry) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors
        .iter()
        .any(|monitor| overlaps(geom, monitor.position(), monitor.size()))
}

/// Whether the window rect overlaps a monitor rect at all. Partial overlap counts:
/// a window hanging off the edge of a display is still reachable.
fn overlaps(geom: &Geometry, m_pos: &PhysicalPosition<i32>, m_size: &PhysicalSize<u32>) -> bool {
    let right = m_pos.x.saturating_add_unsigned(m_size.width);
    let bottom = m_pos.y.saturating_add_unsigned(m_size.height);
    geom.x < right
        && geom.x.saturating_add_unsigned(geom.width) > m_pos.x
        && geom.y < bottom
        && geom.y.saturating_add_unsigned(geom.height) > m_pos.y
}

/// Drop the dead uuid-label entries earlier versions left in the plugin's state
/// file. Runs before the plugin is registered, because the plugin loads that file
/// into memory at registration and writes the whole cache back on every save —
/// pruning afterwards would just be undone.
///
/// The path is built by hand for the same reason: `AppHandle::path()` needs an app
/// that does not exist yet. `%APPDATA%\{identifier}` is what Tauri resolves
/// `app_config_dir` to on Windows.
pub fn prune_plugin_state(identifier: &str) {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    let path = PathBuf::from(appdata)
        .join(identifier)
        .join(tauri_plugin_window_state::DEFAULT_FILENAME);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    if let Some(bytes) = pruned_plugin_state(&text) {
        let _ = std::fs::write(&path, bytes);
    }
}

/// The state file with every untracked label dropped, or None when there is
/// nothing to drop (so an unchanged file is never rewritten).
fn pruned_plugin_state(text: &str) -> Option<Vec<u8>> {
    let serde_json::Value::Object(mut entries) = serde_json::from_str::<serde_json::Value>(text).ok()? else {
        return None;
    };
    let before = entries.len();
    entries.retain(|label, _| label == TRACKED_LABEL);
    if entries.len() == before {
        return None;
    }
    serde_json::to_vec_pretty(&entries).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geom(x: i32, y: i32) -> Geometry {
        Geometry {
            width: 800,
            height: 600,
            x,
            y,
            maximized: false,
        }
    }

    #[test]
    fn overlap_accepts_a_window_hanging_off_the_edge() {
        let pos = PhysicalPosition { x: 0, y: 0 };
        let size = PhysicalSize {
            width: 1920,
            height: 1080,
        };
        assert!(overlaps(&geom(0, 0), &pos, &size));
        assert!(overlaps(&geom(1900, 1060), &pos, &size));
        assert!(overlaps(&geom(-400, -300), &pos, &size));
    }

    #[test]
    fn overlap_rejects_a_window_on_a_detached_monitor() {
        let pos = PhysicalPosition { x: 0, y: 0 };
        let size = PhysicalSize {
            width: 1920,
            height: 1080,
        };
        // Right of the monitor (the unplugged display's coordinates), and above it.
        assert!(!overlaps(&geom(1920, 0), &pos, &size));
        assert!(!overlaps(&geom(0, -600), &pos, &size));
    }

    #[test]
    fn prune_keeps_main_and_drops_uuid_labels() {
        let text = r#"{
          "main": { "width": 1, "height": 2 },
          "project-6f0c": { "width": 3, "height": 4 },
          "global-9ab1": { "width": 5, "height": 6 },
          "secondary-42fa": { "width": 7, "height": 8 }
        }"#;
        let pruned = pruned_plugin_state(text).expect("garbage entries should be dropped");
        let value: serde_json::Value = serde_json::from_slice(&pruned).unwrap();
        let entries = value.as_object().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries.contains_key("main"));
    }

    #[test]
    fn prune_leaves_a_clean_file_alone() {
        assert!(pruned_plugin_state(r#"{"main":{"width":1}}"#).is_none());
        assert!(pruned_plugin_state("not json").is_none());
    }
}
