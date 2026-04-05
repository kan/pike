use crate::types::{ShellConfig, silent_command};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use tauri::State;

pub struct ProjectState {
    pub config_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedTabDef {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_start: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTabDef {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSession {
    pub tabs: Vec<SessionTabDef>,
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub id: String,
    pub name: String,
    pub root: String,
    pub shell: ShellConfig,
    pub pinned_tabs: Vec<PinnedTabDef>,
    pub last_opened: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_session: Option<LastSession>,
}

fn projects_dir(state: &ProjectState) -> PathBuf {
    state.config_dir.join("projects")
}

fn project_file(state: &ProjectState, id: &str) -> PathBuf {
    projects_dir(state).join(id).join("project.json")
}

fn last_project_file(state: &ProjectState) -> PathBuf {
    state.config_dir.join("last_project.txt")
}

use crate::types::validate_slug;

#[tauri::command]
pub async fn detect_wsl_distros() -> Result<Vec<String>, String> {
    let child = silent_command("wsl.exe")
        .args(["--list", "--quiet"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.id();
    let output = crate::types::wait_with_timeout(
        pid,
        std::time::Duration::from_secs(10),
        "wsl --list",
        move || child.wait_with_output(),
    )?;

    let raw = &output.stdout;
    let distros = if raw.len() >= 2 && raw.len() % 2 == 0 {
        let u16s: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(raw).into_owned()
    };

    Ok(distros
        .lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

#[tauri::command]
pub async fn project_get_last(
    state: State<'_, ProjectState>,
) -> Result<Vec<String>, String> {
    let path = last_project_file(&state);
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let ids: Vec<String> = content
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && project_file(&state, l).exists())
        .collect();
    Ok(ids)
}

#[tauri::command]
pub async fn project_set_last(
    ids: Vec<String>,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    fs::write(last_project_file(&state), ids.join("\n")).map_err(|e| e.to_string())
}

fn read_open_ids(state: &ProjectState) -> Vec<String> {
    fs::read_to_string(last_project_file(state))
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn write_open_ids(state: &ProjectState, ids: &[String]) -> Result<(), String> {
    fs::write(last_project_file(state), ids.join("\n")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn project_add_open(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let mut ids = read_open_ids(&state);
    if !ids.contains(&id) {
        ids.push(id);
    }
    write_open_ids(&state, &ids)
}

#[tauri::command]
pub async fn project_remove_open(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let ids: Vec<String> = read_open_ids(&state)
        .into_iter()
        .filter(|l| *l != id)
        .collect();
    write_open_ids(&state, &ids)
}

/// Read all project configs from the projects directory.
pub fn read_all_projects(config_dir: &std::path::Path) -> Vec<ProjectConfig> {
    let dir = config_dir.join("projects");
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };
    let mut projects = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path().join("project.json");
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<ProjectConfig>(&content) {
                projects.push(config);
            }
        }
    }
    projects
}

#[tauri::command]
pub async fn project_list(state: State<'_, ProjectState>) -> Result<Vec<ProjectConfig>, String> {
    let mut projects = read_all_projects(&state.config_dir);
    projects.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    Ok(projects)
}

#[tauri::command]
pub async fn project_get(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<ProjectConfig, String> {
    validate_slug(&id, "Project ID")?;
    let path = project_file(&state, &id);
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn project_create(
    config: ProjectConfig,
    state: State<'_, ProjectState>,
) -> Result<ProjectConfig, String> {
    validate_slug(&config.id, "Project ID")?;
    let dir = projects_dir(&state).join(&config.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(project_file(&state, &config.id), content).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub async fn project_update(
    config: ProjectConfig,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    validate_slug(&config.id, "Project ID")?;
    let path = project_file(&state, &config.id);
    if !path.exists() {
        return Err(format!("Project '{}' not found", config.id));
    }
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn project_delete(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    validate_slug(&id, "Project ID")?;
    let dir = projects_dir(&state).join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
