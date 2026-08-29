pub mod transient;

use crate::types::{ShellConfig, silent_command};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager, State, WebviewWindow};

/// 1 つのウィンドウが持っているプロジェクト（#264）。
///
/// **`held` は `shown` を含む。** タブは切り替えても消えないので、ウィンドウは複数の
/// プロジェクトを抱えうる。「見せている」は「持っている」の部分集合という関係を型に
///出しておかないと、2 つのマップに割れて掃除の抜けが出る。
#[derive(Default, Clone)]
pub struct WindowProjects {
    /// 今見せているプロジェクト。
    pub shown: String,
    /// タブを持っているプロジェクト（見せているものを含む）。フロントが押してくる
    /// （タブはフロントのものなので Rust からは導出できない）。
    pub held: Vec<String>,
}

impl WindowProjects {
    /// 保持しているうち、今見せていないもの。復元したウィンドウが起動時に引く。
    pub fn parked(&self) -> Vec<String> {
        self.held.iter().filter(|id| *id != &self.shown).cloned().collect()
    }
}

pub struct ProjectState {
    pub config_dir: PathBuf,
    /// Maps window label → the projects that window holds, for routing and for
    /// cleanup when the window is destroyed.
    pub window_projects: Mutex<HashMap<String, WindowProjects>>,
    /// `last_project.txt` に最後に書いた内容。同じものを書き直さないための控え。
    pub last_written_sessions: Mutex<Option<String>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_thread_id: Option<String>,
    /// Unified agent session ID (used by agent store for session resume).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    /// Optional free-text group label for organizing projects in the panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Optional preset accent color name for identifying windows/projects.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Optional emoji shown in front of the name in the project panel (#203).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Manual position within the project's group, set by drag & drop in the
    /// panel (#203). The backend only carries it; ordering happens in the panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    /// git remote `origin` URL, refreshed by the front end whenever the git
    /// panel resolves one. Kept here so a project whose root is not on this
    /// machine can still be cloned back into place (#164). `None` for
    /// non-repositories and repositories without an origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// Command the Problems panel runs instead of the golangci-lint line it
    /// would derive from go.mod (#213). Projects whose toolchain lives in a
    /// container set something like `docker compose exec -T golang make lint`.
    /// Runs in the Go module's directory like the built-in one, so the paths in
    /// its output still resolve.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub golangci_command: Option<String>,
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

fn groups_file(state: &ProjectState) -> PathBuf {
    state.config_dir.join("groups.json")
}

#[tauri::command]
pub async fn project_groups_list(
    state: State<'_, ProjectState>,
) -> Result<Vec<String>, String> {
    match fs::read_to_string(groups_file(&state)) {
        Ok(content) => serde_json::from_str::<Vec<String>>(&content).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupsUpdatedPayload {
    source_label: String,
    groups: Vec<String>,
}

#[tauri::command]
pub async fn project_groups_save(
    groups: Vec<String>,
    window: WebviewWindow,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let path = groups_file(&state);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&groups).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())?;

    // Broadcast like `project_update` does: the other windows hold their own
    // copy of this list, and the one that publishes the project list to the
    // sync file (#164) is not necessarily the one that made the change — it
    // would otherwise share a group list it loaded at startup.
    let _ = window.app_handle().emit(
        "project_groups_updated",
        GroupsUpdatedPayload {
            source_label: window.label().to_string(),
            groups,
        },
    );
    Ok(())
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

/// 前回の 1 ウィンドウぶん（#264）。`shown` を開き、`held` は「保持していた」ものとして
/// 覚えるだけ（タブは切り替えたときに作る）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSession {
    pub shown: String,
    pub held: Vec<String>,
}

#[tauri::command]
pub async fn project_get_last(
    state: State<'_, ProjectState>,
) -> Result<Vec<WindowSession>, String> {
    let path = last_project_file(&state);
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // 1 行 1 ウィンドウで `見せていたid <TAB> 保持していたid...`。タブを持たない
    // 古い形式（1 行 1 id）は、そのまま `held` が空のウィンドウとして読める。
    let sessions: Vec<WindowSession> = content
        .lines()
        .map(|line| {
            line.split('\t')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty() && project_file(&state, s).exists())
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        })
        .filter(|ids| !ids.is_empty())
        .map(|mut ids| WindowSession {
            shown: ids.remove(0),
            held: ids,
        })
        .collect();
    Ok(sessions)
}

/// トレイを持つウィンドウ。`last_project.txt` の 1 行目に置き、次の起動で
/// `restoreLastProject` がこのウィンドウとして開く（`stores/project.ts` の `sessions[0]`）。
const MAIN_WINDOW_LABEL: &str = "main";

/// 開いているウィンドウの状態を `last_project.txt` へ丸ごと書き直す（#264）。
///
/// 1 行 1 ウィンドウで、`見せているid <TAB> 保持しているid...`。存在しないプロジェクト
/// （削除済み・一時プロジェクト）は読む側が落とすので、ここでは触らない。
///
/// **追記と個別削除をやめて全量書き直しにした。** 以前は `project_add_open` が追記する
/// 一方、削除はウィンドウを閉じたときの「今見せているもの」だけだったので、1 つの
/// ウィンドウで A → B と切り替えると A の記録が残り、次の起動で A と B が別々の
/// ウィンドウで開いていた。ウィンドウの状態そのものを写せば、その手のずれが起きない。
pub(crate) fn write_open_windows(state: &ProjectState) -> Result<(), String> {
    // **ロックはここで手放す**。この先はファイルへの書き込みで、握ったままだと
    // `project_for_window`（UI スレッドで走る同期コマンド）を待たせる。
    let lines = {
        let Ok(map) = state.window_projects.lock() else {
            return Ok(());
        };
        // **並びを決めておく**。1 行目が次の起動で main（トレイを持つウィンドウ）が開くもの
        // なので、`HashMap` の順のままだと再起動のたびに入れ替わる。今の main を先頭に、
        // 残りはラベル順。
        let mut entries: Vec<(&String, &WindowProjects)> = map.iter().collect();
        entries.sort_by_key(|(label, _)| (label.as_str() != MAIN_WINDOW_LABEL, label.as_str()));
        entries
            .into_iter()
            .filter_map(|(_, w)| {
                // 見せているものを先頭に（安定ソートなので、残りの並びは保たれる）。
                let mut ids: Vec<&str> = w.held.iter().map(String::as_str).collect();
                ids.sort_by_key(|id| *id != w.shown);
                (!ids.is_empty()).then(|| ids.join("\t"))
            })
            .collect::<Vec<String>>()
    };

    let content = lines.join("\n");
    // 中身が変わらないなら書かない。1 回の切り替えで `project_add_open` と保持一覧の
    // 通知が続けて来るので、そのままだと同じ内容を 2〜3 回書くことになる。
    if let Ok(mut last) = state.last_written_sessions.lock() {
        if last.as_deref() == Some(content.as_str()) {
            return Ok(());
        }
        *last = Some(content.clone());
    }
    fs::write(last_project_file(state), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn project_add_open(
    id: String,
    window: WebviewWindow,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    // Track window → project mapping for cleanup on window destroy
    set_window_project(&state, window.label(), &id);
    write_open_windows(&state)
}

/// Point a window label at a project. The map is the single source of truth for
/// which project a window shows, so callers that build (or adopt) a window must
/// set it before the webview mounts and asks `project_for_window`.
/// `held ⊇ {shown}` を保つ唯一の足し場（重複させない）。
fn push_held(entry: &mut WindowProjects, id: &str) {
    if !id.is_empty() && !entry.held.iter().any(|h| h == id) {
        entry.held.push(id.to_string());
    }
}

pub fn set_window_project(state: &ProjectState, window_label: &str, id: &str) {
    if let Ok(mut map) = state.window_projects.lock() {
        let entry = map.entry(window_label.to_string()).or_default();
        entry.shown = id.to_string();
        push_held(entry, id);
    }
}

/// Remove and return the project a window was showing.
pub fn take_window_project(state: &ProjectState, window_label: &str) -> Option<String> {
    let entry = state.window_projects.lock().ok().and_then(|mut map| map.remove(window_label))?;
    Some(entry.shown)
}

/// このウィンドウがタブを持っているプロジェクトを差し替える（#264）。見せているものは
/// `project_add_open` が入れるので、ここで消さない。
#[tauri::command]
pub async fn project_set_parked(
    window: tauri::Window,
    ids: Vec<String>,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    if let Ok(mut map) = state.window_projects.lock() {
        let entry = map.entry(window.label().to_string()).or_default();
        entry.held = ids;
        let shown = entry.shown.clone();
        push_held(entry, &shown);
    }
    // 次の起動で戻せるように記録する（#264）。
    write_open_windows(&state)
}

/// 新しいウィンドウに「保持していたもの」を種として渡す（復元用）。
pub fn seed_window_held(state: &ProjectState, window_label: &str, held: &[String]) {
    if let Ok(mut map) = state.window_projects.lock() {
        let entry = map.entry(window_label.to_string()).or_default();
        for id in held {
            push_held(entry, id);
        }
    }
}

/// `id` を持っているウィンドウのラベルと、それを今見せているか。
pub fn window_holding(state: &ProjectState, id: &str) -> Option<(String, bool)> {
    let map = state.window_projects.lock().ok()?;
    map.iter()
        .find(|(_, w)| w.held.iter().any(|h| h == id))
        .map(|(label, w)| (label.clone(), w.shown == id))
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

/// `read_all_projects` を最近開いた順（`last_opened` 降順）で返す。`project_list`
/// と jumplist が共有する「最近のプロジェクト順」の単一定義。
pub fn read_all_projects_sorted(config_dir: &std::path::Path) -> Vec<ProjectConfig> {
    let mut projects = read_all_projects(config_dir);
    projects.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    projects
}

#[tauri::command]
pub async fn project_list(state: State<'_, ProjectState>) -> Result<Vec<ProjectConfig>, String> {
    Ok(read_all_projects_sorted(&state.config_dir))
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectUpdatedPayload {
    source_label: String,
    config: ProjectConfig,
}

#[tauri::command]
pub async fn project_update(
    config: ProjectConfig,
    window: WebviewWindow,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    validate_slug(&config.id, "Project ID")?;
    let path = project_file(&state, &config.id);
    if !path.exists() {
        return Err(format!("Project '{}' not found", config.id));
    }
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())?;

    // Broadcast so other windows refresh their in-memory copy; without this,
    // their full-object writes (session flush / project switch) would revert
    // the edit with stale data.
    let _ = window.app_handle().emit(
        "project_updated",
        ProjectUpdatedPayload {
            source_label: window.label().to_string(),
            config,
        },
    );
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
