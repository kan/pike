pub mod tunnel;

use crate::fs::{batch_read_files, file_name_of, parent_dir_of, rel_path_of, walk_files_by_name};
use crate::types::ShellConfig;
use bollard::query_parameters::{
    ListContainersOptions, LogsOptions, RestartContainerOptions, StartContainerOptions,
    StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::Docker;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::OnceCell;

pub struct DockerState {
    pub log_streams: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub client: OnceCell<Docker>,
    /// App identifier (com.pike.dev / com.pike.dev.debug), set at setup.
    /// Scopes tunnel containers so coexisting instances don't sweep each
    /// other's tunnels.
    pub instance_id: std::sync::OnceLock<String>,
    /// Set once this session creates a tunnel; gates exit-time cleanup so
    /// app exit isn't delayed when Docker was merely browsed.
    pub tunnels_created: std::sync::atomic::AtomicBool,
}

pub fn instance_owner(state: &DockerState) -> String {
    state.instance_id.get().cloned().unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub compose_service: Option<String>,
    pub compose_project: Option<String>,
    /// Directory Compose ran in. Recorded by Compose itself, so matching a
    /// container to a discovered compose file needs no guess about how the
    /// project got its name (`-p`, `COMPOSE_PROJECT_NAME` in the environment or
    /// in the directory's `.env`, …).
    pub compose_working_dir: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeService {
    pub name: String,
}

/// One compose file and the services it declares. A monorepo has several (#221).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    /// Directory holding the file — where `docker compose` has to be run.
    pub dir: String,
    /// The file relative to the project root (`compose.yml`,
    /// `apps/web/compose.yml`); identifies the group in the panel.
    pub file: String,
    /// The project name Compose will use, derived from the directory (or the
    /// file's `name:`). Only a fallback for matching — `dir` against the
    /// container's `compose_working_dir` is the authoritative comparison.
    pub name: String,
    pub services: Vec<ComposeService>,
}

/// Compose's own precedence order — the first one present in a directory wins.
const COMPOSE_FILE_NAMES: &[&str] = &[
    "compose.yml",
    "compose.yaml",
    "docker-compose.yml",
    "docker-compose.yaml",
];

/// The project root plus two subdirectory levels, so `apps/web/compose.yml`
/// is found (#221). The walkers count files in the root itself as depth 1.
const MAX_DEPTH: u32 = 3;

/// Upper bound on compose files parsed per discovery, so a large monorepo
/// cannot stall the panel or blow the WSL batch command line.
const MAX_COMPOSE_FILES: usize = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerListResult {
    pub containers: Vec<ContainerInfo>,
    pub tunnels: Vec<tunnel::TunnelInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DockerLogPayload {
    stream_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DockerLogExitPayload {
    stream_id: String,
}

async fn try_connect(owner: String) -> Result<Docker, String> {
    let docker = connect_any().await?;
    // First successful connection in this process: sweep stale tunnel
    // containers left behind by a crashed session of this instance.
    let sweep = docker.clone();
    tokio::spawn(async move { tunnel::cleanup_all(&sweep, &owner).await });
    Ok(docker)
}

async fn connect_any() -> Result<Docker, String> {
    let ping_timeout = std::time::Duration::from_secs(5);
    if let Ok(docker) = Docker::connect_with_local_defaults() {
        if tokio::time::timeout(ping_timeout, docker.ping())
            .await
            .is_ok_and(|r| r.is_ok())
        {
            return Ok(docker);
        }
    }
    for port in [2375, 2376] {
        let url = format!("tcp://127.0.0.1:{port}");
        if let Ok(docker) = Docker::connect_with_http(&url, 4, bollard::API_DEFAULT_VERSION) {
            if tokio::time::timeout(ping_timeout, docker.ping())
                .await
                .is_ok_and(|r| r.is_ok())
            {
                return Ok(docker);
            }
        }
    }
    Err("Docker is not reachable".into())
}

async fn get_docker(state: &DockerState) -> Result<Docker, String> {
    let owner = instance_owner(state);
    state
        .client
        .get_or_try_init(|| try_connect(owner))
        .await
        .cloned()
}

#[tauri::command]
pub async fn docker_ping(state: State<'_, DockerState>) -> Result<bool, String> {
    match get_docker(&state).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// The project name Compose derives from a directory: lowercase, keep only
/// `[a-z0-9_-]`, then drop leading `_`/`-` (Compose's `NormalizeProjectName`).
/// Note the dashes and underscores survive — stripping them, as the panel used
/// to, mismatched every project whose directory had one in its name.
fn normalize_project_name(dir_name: &str) -> String {
    dir_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .collect::<String>()
        .trim_start_matches(['_', '-'])
        .to_string()
}

fn parse_compose_file(root: &str, path: &str, content: &str) -> Option<ComposeProject> {
    #[derive(Deserialize)]
    struct ComposeFile {
        /// Top-level `name:` overrides the directory-derived project name.
        name: Option<String>,
        services: Option<HashMap<String, serde_yaml::Value>>,
    }

    let parsed: ComposeFile = serde_yaml::from_str(content).ok()?;
    let services = parsed.services?;
    if services.is_empty() {
        return None;
    }
    let dir = parent_dir_of(path);
    let mut names: Vec<String> = services.into_keys().collect();
    names.sort();
    Some(ComposeProject {
        dir: dir.to_string(),
        file: rel_path_of(path, root),
        name: parsed
            .name
            .unwrap_or_else(|| normalize_project_name(file_name_of(dir))),
        services: names.into_iter().map(|name| ComposeService { name }).collect(),
    })
}

/// Find every compose file in the project (root + two levels, #221) and read
/// the services out of each. Discovery and the batched read are the same
/// helpers the task panel uses, so WSL still costs one round trip each.
#[tauri::command]
pub async fn docker_compose_discover(
    root: String,
    shell: ShellConfig,
) -> Result<Vec<ComposeProject>, String> {
    tokio::task::spawn_blocking(move || {
        let sep = if root.contains('/') { "/" } else { "\\" };
        let mut paths = walk_files_by_name(&shell, &root, COMPOSE_FILE_NAMES, MAX_DEPTH);
        // Committed vendor trees aren't gitignored and this walk doesn't consult
        // git anyway, so drop them the way task discovery does.
        paths.retain(|p| !p.split(['/', '\\']).any(|seg| seg == "vendor"));
        // Compose reads one file per directory, so keep the first name of its
        // precedence list and drop the rest of that directory's matches.
        let rank = |p: &str| {
            COMPOSE_FILE_NAMES
                .iter()
                .position(|n| n.eq_ignore_ascii_case(file_name_of(p)))
                .unwrap_or(usize::MAX)
        };
        paths.sort_by(|a, b| (parent_dir_of(a), rank(a)).cmp(&(parent_dir_of(b), rank(b))));
        paths.dedup_by(|a, b| parent_dir_of(a) == parent_dir_of(b));
        paths.truncate(MAX_COMPOSE_FILES);

        let contents = batch_read_files(&shell, &root, sep, &paths);
        let mut projects: Vec<ComposeProject> = paths
            .iter()
            .zip(contents)
            .filter_map(|(path, content)| parse_compose_file(&root, path, &content?))
            .collect();
        // The root's own compose file first, then the nested ones by path.
        // `rel_path_of` normalizes to `/`, so counting that one separator is
        // the depth.
        projects.sort_by(|a, b| {
            (a.file.matches('/').count(), &a.file).cmp(&(b.file.matches('/').count(), &b.file))
        });
        Ok(projects)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_list_containers(
    state: State<'_, DockerState>,
) -> Result<ContainerListResult, String> {
    let docker = get_docker(&state).await?;
    let owner = instance_owner(&state);
    let opts = ListContainersOptions {
        all: true,
        ..Default::default()
    };
    let summaries = docker
        .list_containers(Some(opts))
        .await
        .map_err(|e| e.to_string())?;

    // Single pass: tunnel containers become TunnelInfo (own instance,
    // running only) instead of a second list_containers round-trip.
    let mut result = ContainerListResult {
        containers: Vec::new(),
        tunnels: Vec::new(),
    };
    for c in summaries {
        if c.labels
            .as_ref()
            .is_some_and(|l| l.contains_key(tunnel::TUNNEL_LABEL))
        {
            let running = c
                .state
                .as_ref()
                .is_some_and(|s| s.to_string() == "running");
            if running {
                if let Some(t) = tunnel::tunnel_from_summary(&c, &owner) {
                    result.tunnels.push(t);
                }
            }
            continue;
        }
        let labels = c.labels.unwrap_or_default();
        result.containers.push(ContainerInfo {
            id: c.id.unwrap_or_default(),
            name: c
                .names
                .and_then(|n| n.first().cloned())
                .unwrap_or_default()
                .trim_start_matches('/')
                .to_string(),
            image: c.image.unwrap_or_default(),
            state: c.state.map(|s| s.to_string()).unwrap_or_default(),
            status: c.status.unwrap_or_default(),
            compose_service: labels.get("com.docker.compose.service").cloned(),
            compose_project: labels.get("com.docker.compose.project").cloned(),
            compose_working_dir: labels.get("com.docker.compose.project.working_dir").cloned(),
        });
    }
    Ok(result)
}

#[tauri::command]
pub async fn docker_start(
    container_id: String,
    state: State<'_, DockerState>,
) -> Result<(), String> {
    let docker = get_docker(&state).await?;
    docker
        .start_container(&container_id, None::<StartContainerOptions>)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_stop(
    container_id: String,
    state: State<'_, DockerState>,
) -> Result<(), String> {
    let docker = get_docker(&state).await?;
    docker
        .stop_container(&container_id, None::<StopContainerOptions>)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_restart(
    container_id: String,
    state: State<'_, DockerState>,
) -> Result<(), String> {
    let docker = get_docker(&state).await?;
    docker
        .restart_container(&container_id, None::<RestartContainerOptions>)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_logs_start(
    container_id: String,
    app: AppHandle,
    state: State<'_, DockerState>,
) -> Result<String, String> {
    let docker = get_docker(&state).await?;
    let stream_id = uuid::Uuid::new_v4().to_string();
    let sid = stream_id.clone();

    let opts = LogsOptions {
        follow: true,
        stdout: true,
        stderr: true,
        tail: "200".to_string(),
        ..Default::default()
    };

    let handle = tokio::spawn(async move {
        let mut stream = docker.logs(&container_id, Some(opts));
        let mut buffer = String::new();
        let mut flush_interval = tokio::time::interval(std::time::Duration::from_millis(50));
        let stale_timeout = std::time::Duration::from_secs(60);

        loop {
            tokio::select! {
                item = tokio::time::timeout(stale_timeout, stream.next()) => {
                    match item.ok().flatten() {
                        Some(Ok(output)) => {
                            buffer.push_str(&output.to_string());
                        }
                        _ => {
                            // Flush remaining buffer
                            if !buffer.is_empty() {
                                let _ = app.emit(
                                    "docker_log_output",
                                    DockerLogPayload {
                                        stream_id: sid.clone(),
                                        data: std::mem::take(&mut buffer),
                                    },
                                );
                            }
                            let _ = app.emit(
                                "docker_log_exit",
                                DockerLogExitPayload {
                                    stream_id: sid.clone(),
                                },
                            );
                            break;
                        }
                    }
                }
                _ = flush_interval.tick() => {
                    if !buffer.is_empty() {
                        let _ = app.emit(
                            "docker_log_output",
                            DockerLogPayload {
                                stream_id: sid.clone(),
                                data: std::mem::take(&mut buffer),
                            },
                        );
                    }
                }
            }
        }
    });

    state
        .log_streams
        .lock()
        .map_err(|e| e.to_string())?
        .insert(stream_id.clone(), handle);

    Ok(stream_id)
}

#[tauri::command]
pub async fn docker_detect_shell(
    container_id: String,
    state: State<'_, DockerState>,
) -> Result<String, String> {
    let docker = get_docker(&state).await?;
    let exec = docker
        .create_exec(
            &container_id,
            CreateExecOptions::<&str> {
                cmd: Some(vec!["sh", "-c", "test -x /bin/bash && echo bash || echo sh"]),
                attach_stdout: Some(true),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut shell_name = String::new();
    if let StartExecResults::Attached { mut output, .. } =
        docker.start_exec(&exec.id, None).await.map_err(|e| e.to_string())?
    {
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(Ok(msg)) = output.next().await {
                shell_name.push_str(&msg.to_string());
            }
        })
        .await;
        if result.is_err() {
            return Err("Shell detection timed out".into());
        }
    }

    let name = shell_name.trim();
    if name == "bash" {
        Ok("/bin/bash".to_string())
    } else {
        Ok("/bin/sh".to_string())
    }
}

#[tauri::command]
pub async fn docker_logs_stop(
    stream_id: String,
    state: State<'_, DockerState>,
) -> Result<(), String> {
    if let Some(handle) = state
        .log_streams
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&stream_id)
    {
        handle.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_project_name, parse_compose_file};

    #[test]
    fn project_name_matches_compose_normalization() {
        // Verified against running containers: the dashes survive.
        assert_eq!(
            normalize_project_name("screenshot-com-440-seed-293c2893"),
            "screenshot-com-440-seed-293c2893"
        );
        assert_eq!(normalize_project_name("My_App"), "my_app");
        // Everything outside [a-z0-9_-] is dropped, and leading _/- trimmed.
        assert_eq!(normalize_project_name("app.v2"), "appv2");
        assert_eq!(normalize_project_name("_hidden"), "hidden");
        assert_eq!(normalize_project_name("日本語"), "");
    }

    #[test]
    fn reads_services_and_derives_the_group() {
        let yaml = "services:\n  web:\n    image: nginx\n  db:\n    image: mysql\n";
        let p = parse_compose_file("/home/kan/repo", "/home/kan/repo/apps/web/compose.yml", yaml)
            .expect("a compose file with services");
        assert_eq!(p.dir, "/home/kan/repo/apps/web");
        assert_eq!(p.file, "apps/web/compose.yml");
        assert_eq!(p.name, "web");
        // Sorted, so the panel's order does not depend on YAML map iteration.
        assert_eq!(p.services.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["db", "web"]);
    }

    #[test]
    fn top_level_name_wins_over_the_directory() {
        let yaml = "name: custom\nservices:\n  web:\n    image: nginx\n";
        let p = parse_compose_file("C:\\repo", "C:\\repo\\compose.yml", yaml).unwrap();
        assert_eq!(p.name, "custom");
        assert_eq!(p.file, "compose.yml");
    }

    #[test]
    fn files_without_services_are_skipped() {
        assert!(parse_compose_file("/r", "/r/compose.yml", "services:\n").is_none());
        assert!(parse_compose_file("/r", "/r/compose.yml", "volumes:\n  db:\n").is_none());
        assert!(parse_compose_file("/r", "/r/compose.yml", "\t- not: yaml\n  bad").is_none());
    }
}
