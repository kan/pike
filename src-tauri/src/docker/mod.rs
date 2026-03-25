use crate::types::ShellConfig;
use bollard::container::{
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeService {
    pub name: String,
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

async fn try_connect() -> Result<Docker, String> {
    if let Ok(docker) = Docker::connect_with_local_defaults() {
        if docker.ping().await.is_ok() {
            return Ok(docker);
        }
    }
    for port in [2375, 2376] {
        let url = format!("tcp://127.0.0.1:{port}");
        if let Ok(docker) = Docker::connect_with_http(&url, 4, bollard::API_DEFAULT_VERSION) {
            if docker.ping().await.is_ok() {
                return Ok(docker);
            }
        }
    }
    Err("Docker is not reachable".into())
}

async fn get_docker(state: &DockerState) -> Result<Docker, String> {
    state
        .client
        .get_or_try_init(|| try_connect())
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

#[tauri::command]
pub async fn docker_compose_services(
    root: String,
    shell: ShellConfig,
) -> Result<Vec<ComposeService>, String> {
    let content = tokio::task::spawn_blocking(move || {
        for filename in [
            "compose.yml",
            "compose.yaml",
            "docker-compose.yml",
            "docker-compose.yaml",
        ] {
            let result = match &shell {
                ShellConfig::Wsl { .. } => {
                    let path = format!("{root}/{filename}");
                    shell.run_stdout("cat", &["--", &path]).ok()
                }
                _ => {
                    let sep = if root.contains('/') { "/" } else { "\\" };
                    let path = format!("{root}{sep}{filename}");
                    std::fs::read_to_string(&path).ok()
                }
            };
            if let Some(content) = result {
                return Ok(content);
            }
        }
        Err("No compose file found".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    #[derive(Deserialize)]
    struct ComposeFile {
        services: Option<HashMap<String, serde_yaml::Value>>,
    }

    let parsed: ComposeFile = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse compose file: {e}"))?;

    Ok(parsed
        .services
        .unwrap_or_default()
        .keys()
        .map(|name| ComposeService {
            name: name.clone(),
        })
        .collect())
}

#[tauri::command]
pub async fn docker_list_containers(
    state: State<'_, DockerState>,
) -> Result<Vec<ContainerInfo>, String> {
    let docker = get_docker(&state).await?;
    let opts = ListContainersOptions::<String> {
        all: true,
        ..Default::default()
    };
    let containers = docker
        .list_containers(Some(opts))
        .await
        .map_err(|e| e.to_string())?;

    Ok(containers
        .into_iter()
        .map(|c| {
            let labels = c.labels.unwrap_or_default();
            ContainerInfo {
                id: c.id.unwrap_or_default(),
                name: c
                    .names
                    .and_then(|n| n.first().cloned())
                    .unwrap_or_default()
                    .trim_start_matches('/')
                    .to_string(),
                image: c.image.unwrap_or_default(),
                state: c.state.unwrap_or_default(),
                status: c.status.unwrap_or_default(),
                compose_service: labels.get("com.docker.compose.service").cloned(),
                compose_project: labels.get("com.docker.compose.project").cloned(),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn docker_start(
    container_id: String,
    state: State<'_, DockerState>,
) -> Result<(), String> {
    let docker = get_docker(&state).await?;
    docker
        .start_container(&container_id, None::<StartContainerOptions<String>>)
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

    let opts = LogsOptions::<String> {
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

        loop {
            tokio::select! {
                item = stream.next() => {
                    match item {
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
