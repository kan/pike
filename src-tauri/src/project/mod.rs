use crate::types::ShellConfig;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
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
pub struct ProjectConfig {
    pub id: String,
    pub name: String,
    pub root: String,
    pub shell: ShellConfig,
    pub pinned_tabs: Vec<PinnedTabDef>,
    pub last_opened: String,
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
    let output = Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        .output()
        .map_err(|e| e.to_string())?;

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
) -> Result<Option<String>, String> {
    let path = last_project_file(&state);
    if !path.exists() {
        return Ok(None);
    }
    let id = fs::read_to_string(&path)
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    if id.is_empty() {
        return Ok(None);
    }
    // Verify the project still exists
    if project_file(&state, &id).exists() {
        Ok(Some(id))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn project_set_last(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    fs::write(last_project_file(&state), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn project_list(state: State<'_, ProjectState>) -> Result<Vec<ProjectConfig>, String> {
    let dir = projects_dir(&state);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut projects = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().join("project.json");
        if path.exists() {
            let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if let Ok(config) = serde_json::from_str::<ProjectConfig>(&content) {
                projects.push(config);
            }
        }
    }
    projects.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    Ok(projects)
}

#[tauri::command]
pub async fn project_get(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<ProjectConfig, String> {
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
    let dir = projects_dir(&state).join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
