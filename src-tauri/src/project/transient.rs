//! Projects that exist only in memory (#230).
//!
//! Opening a directory used to write a `project.json`, so a directory the user
//! only wanted to look at stayed in the project list, in `last_project.txt`, in
//! the jump list and — if it sat under the sync base — in the sync file, with no
//! way back out but deleting it by hand. A transient project is the same
//! `ProjectConfig` without any of that: the window behaves like a project window
//! (sidebar, file tree, git, search), and the config dies with the window.
//!
//! The map is keyed by project id and `window_projects` points at it exactly as
//! it points at a registered project, so window focus, CLI routing and
//! `project_for_window` need no separate notion of "anonymous window". What has
//! to know the difference is every path that *writes* something keyed on the
//! project:
//!
//! - `project.json` — `switchProject`'s `projectUpdate`, `flushSession`,
//!   `saveProject` (all in `stores/project.ts`)
//! - `last_project.txt` — `project_add_open` / `project_remove_open`
//! - the sync file (#164) and the shell menus (#160, #161) — driven by the
//!   frontend's `projects` array, which a transient project is deliberately kept
//!   out of, so those skip it without testing anything
//! - `window-geometry.json` (#200) — the **deliberate exception**: `key_for`
//!   reads `window_projects`, so a transient window does store its size under
//!   its slug id, and `config_for_dir` derives that id from the directory name
//!   rather than a uuid precisely so reopening the directory gets its window
//!   back. The cost is one entry per distinct directory ever opened this way.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{State, WebviewWindow};

use super::{read_all_projects, set_window_project, ProjectConfig, ProjectState};
use crate::types::ShellConfig;

#[derive(Default)]
pub struct TransientState {
    projects: Mutex<HashMap<String, ProjectConfig>>,
}

impl TransientState {
    pub fn get(&self, id: &str) -> Option<ProjectConfig> {
        self.projects.lock().ok()?.get(id).cloned()
    }

    /// Drop the entry, if any. Called when the window showing it is destroyed,
    /// when that window switches to another project, and when the user promotes
    /// it to a registered project.
    pub fn remove(&self, id: &str) -> Option<ProjectConfig> {
        self.projects.lock().ok()?.remove(id)
    }

    fn contains(&self, id: &str) -> bool {
        self.projects
            .lock()
            .map(|m| m.contains_key(id))
            .unwrap_or(false)
    }

    /// The root of the project with `id`, without cloning the whole config.
    pub fn find_by_id_root(&self, id: &str) -> Option<String> {
        self.projects.lock().ok()?.get(id).map(|c| c.root.clone())
    }

    /// The transient project whose root is `path`. Lets a second `pike <dir>` on
    /// the same directory focus the window that already shows it.
    pub fn find_by_root(&self, path: &str) -> Option<ProjectConfig> {
        let norm = crate::normalize_path(path);
        let map = self.projects.lock().ok()?;
        map.values()
            .find(|c| crate::normalize_path(&c.root) == norm)
            .cloned()
    }

    /// Register a project for an unregistered directory and return it.
    ///
    /// `existing` is the registered list, which every caller already holds — it
    /// is only read to keep the generated id unique, and re-scanning the projects
    /// directory for that would double the disk work of opening a directory.
    pub fn create(
        &self,
        existing: &[ProjectConfig],
        path: &str,
        distro_hint: Option<&str>,
    ) -> Option<ProjectConfig> {
        let config = self.config_for_dir(existing, path, distro_hint)?;
        if let Ok(mut map) = self.projects.lock() {
            map.insert(config.id.clone(), config.clone());
        }
        Some(config)
    }

    /// Build a config for an unregistered directory.
    ///
    /// For WSL UNC paths, uses the native WSL path as root. For native WSL paths
    /// (e.g. `/home/user/foo`), uses the `distro_hint` the CLI parser captured
    /// before UNC→native conversion erased the distro context. For Windows paths,
    /// uses PowerShell as the default shell.
    ///
    /// The id is a slug of the directory name, kept unique against both the
    /// registered projects and the transient ones: it reaches `window_projects`
    /// and CLI arguments, and a collision would point two different directories
    /// at one window. Deriving it from the name rather than a fresh uuid is what
    /// keeps the window geometry (#200) of a directory the user reopens.
    fn config_for_dir(
        &self,
        existing: &[ProjectConfig],
        path: &str,
        distro_hint: Option<&str>,
    ) -> Option<ProjectConfig> {
        let (root, shell) = if let Some((distro, native)) = crate::cli::split_wsl_unc(path) {
            (native, ShellConfig::Wsl { distro })
        } else if let Some(distro) = distro_hint {
            (
                path.to_string(),
                ShellConfig::Wsl {
                    distro: distro.to_string(),
                },
            )
        } else {
            // UNC でも distro ヒントでもない＝ホストのパス。Windows なら PowerShell、
            // macOS / Linux ならログインシェル。
            (path.to_string(), ShellConfig::host_default())
        };

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
        let base: String = if slug.is_empty() {
            "dir".to_string()
        } else {
            slug.chars().take(48).collect()
        };

        let taken = |id: &str| existing.iter().any(|p| p.id == id) || self.contains(id);
        let id = if taken(&base) {
            (2..).map(|n| format!("{base}-{n}")).find(|c| !taken(c))?
        } else {
            base
        };

        Some(ProjectConfig {
            id,
            name: dir_name.to_string(),
            root,
            shell,
            pinned_tabs: vec![],
            last_opened: crate::iso_now(),
            last_session: None,
            group: None,
            color: None,
            icon: None,
            order: None,
            remote_url: None,
            golangci_command: None,
        })
    }
}

/// Register a transient project for `path` and return it. The caller decides
/// which window shows it (`project_transient_bind` for this one, or
/// `open_project_window` for a new one).
#[tauri::command]
pub async fn project_transient_create(
    path: String,
    distro: Option<String>,
    state: State<'_, ProjectState>,
    transient: State<'_, TransientState>,
) -> Result<ProjectConfig, String> {
    let existing = read_all_projects(&state.config_dir);
    transient
        .create(&existing, &path, distro.as_deref())
        .ok_or_else(|| format!("Cannot open directory: {path}"))
}

/// The transient project for `id`, or `None` when the id names a registered one.
/// A window resolves its own project this way when `project_for_window` hands it
/// an id the project list doesn't have.
#[tauri::command]
pub async fn project_transient_get(
    id: String,
    transient: State<'_, TransientState>,
) -> Result<Option<ProjectConfig>, String> {
    Ok(transient.get(&id))
}

/// Point this window at a transient project. The counterpart of
/// `project_add_open` for a registered one, minus the open-list write — a
/// transient project must not come back on the next plain launch.
///
/// No slug check: every id in the map came from `config_for_dir`, so the
/// existence test below is the stronger guard.
#[tauri::command]
pub async fn project_transient_bind(
    id: String,
    window: WebviewWindow,
    state: State<'_, ProjectState>,
    transient: State<'_, TransientState>,
) -> Result<(), String> {
    if !transient.contains(&id) {
        return Err(format!("No transient project '{id}'"));
    }
    set_window_project(&state, window.label(), &id);
    Ok(())
}

/// Forget the transient entry: the frontend has written the same config to disk
/// (so the id now resolves as a registered project), or the window moved to a
/// different project and the directory is no longer open anywhere.
#[tauri::command]
pub async fn project_transient_drop(
    id: String,
    transient: State<'_, TransientState>,
) -> Result<(), String> {
    transient.remove(&id);
    Ok(())
}
