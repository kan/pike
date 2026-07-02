use bollard::models::{ContainerCreateBody, ContainerSummary, HostConfig, PortBinding};
use bollard::query_parameters::{
    CreateContainerOptions, CreateImageOptions, InspectContainerOptions, ListContainersOptions,
    RemoveContainerOptions, StartContainerOptions,
};
use bollard::Docker;
use futures_util::TryStreamExt;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

use super::{get_docker, instance_owner, DockerState};

const SOCAT_IMAGE: &str = "alpine/socat:latest";
pub(super) const TUNNEL_LABEL: &str = "pike.tunnel";
// Scopes tunnels to one Pike instance (installed com.pike.dev and dev
// com.pike.dev.debug coexist): sweeps must not kill the other instance's
// live tunnels.
const OWNER_LABEL: &str = "pike.tunnel.owner";
const TARGET_LABEL: &str = "pike.tunnel.target";
const PORT_LABEL: &str = "pike.tunnel.port";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub tunnel_id: String,
    pub target_id: String,
    pub target_port: u16,
    pub local_port: u16,
}

async fn ensure_socat_image(docker: &Docker) -> Result<(), String> {
    if docker.inspect_image(SOCAT_IMAGE).await.is_ok() {
        return Ok(());
    }
    let options = CreateImageOptions {
        from_image: Some(SOCAT_IMAGE.to_string()),
        ..Default::default()
    };
    docker
        .create_image(Some(options), None, None)
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| format!("Failed to pull socat image: {e}"))?;
    Ok(())
}

async fn create_tunnel(
    docker: &Docker,
    owner: &str,
    target_id: &str,
    target_port: u16,
) -> Result<TunnelInfo, String> {
    ensure_socat_image(docker).await?;

    let info = docker
        .inspect_container(target_id, None::<InspectContainerOptions>)
        .await
        .map_err(|e| format!("Failed to inspect container: {e}"))?;

    let networks = info
        .network_settings
        .as_ref()
        .and_then(|ns| ns.networks.as_ref())
        .ok_or("Target container has no network settings")?;

    // Prefer non-bridge network (compose creates custom networks)
    let (net_name, net_info) = networks
        .iter()
        .find(|(name, _)| name.as_str() != "bridge")
        .or_else(|| networks.iter().next())
        .ok_or("Target container is not attached to any network")?;

    // On user-defined networks Docker's embedded DNS resolves the container
    // name, which survives restarts/recreates that change the IP. The default
    // bridge network has no DNS, so use the current IP there.
    let container_name = info
        .name
        .as_deref()
        .map(|n| n.trim_start_matches('/'))
        .unwrap_or_default();
    let target_host = if net_name != "bridge" && !container_name.is_empty() {
        container_name.to_string()
    } else {
        net_info
            .ip_address
            .as_ref()
            .filter(|ip| !ip.is_empty())
            .ok_or("Target container has no IP address")?
            .clone()
    };

    let mut labels = HashMap::new();
    labels.insert(TUNNEL_LABEL.to_string(), "true".to_string());
    labels.insert(OWNER_LABEL.to_string(), owner.to_string());
    labels.insert(TARGET_LABEL.to_string(), target_id.to_string());
    labels.insert(PORT_LABEL.to_string(), target_port.to_string());

    // Empty host port = the daemon picks a free port in its own network
    // namespace (a host-side probe would race and, on the WSL2 TCP fallback,
    // check the wrong namespace).
    let mut port_bindings = HashMap::new();
    port_bindings.insert(
        format!("{target_port}/tcp"),
        Some(vec![PortBinding {
            host_ip: Some("127.0.0.1".to_string()),
            host_port: Some(String::new()),
        }]),
    );

    let host_config = HostConfig {
        auto_remove: Some(true),
        network_mode: Some(net_name.clone()),
        port_bindings: Some(port_bindings),
        ..Default::default()
    };

    let config = ContainerCreateBody {
        image: Some(SOCAT_IMAGE.to_string()),
        cmd: Some(vec![
            format!("TCP-LISTEN:{target_port},fork,reuseaddr"),
            format!("TCP-CONNECT:{target_host}:{target_port}"),
        ]),
        labels: Some(labels),
        exposed_ports: Some(vec![format!("{target_port}/tcp")]),
        host_config: Some(host_config),
        ..Default::default()
    };

    let options = CreateContainerOptions {
        name: Some(format!("pike-tunnel-{}", uuid::Uuid::new_v4().simple())),
        ..Default::default()
    };

    let created = docker
        .create_container(Some(options), config)
        .await
        .map_err(|e| format!("Failed to create tunnel container: {e}"))?;

    // auto_remove only applies after a successful start; roll back manually
    // so a failed start doesn't leak an invisible Created container.
    if let Err(e) = docker
        .start_container(&created.id, None::<StartContainerOptions>)
        .await
    {
        let _ = remove_tunnel(docker, &created.id).await;
        return Err(format!("Failed to start tunnel container: {e}"));
    }

    let local_port = match assigned_host_port(docker, &created.id, target_port).await {
        Ok(port) => port,
        Err(e) => {
            let _ = remove_tunnel(docker, &created.id).await;
            return Err(e);
        }
    };

    wait_listening(local_port).await;

    Ok(TunnelInfo {
        tunnel_id: created.id,
        target_id: target_id.to_string(),
        target_port,
        local_port,
    })
}

async fn assigned_host_port(
    docker: &Docker,
    tunnel_id: &str,
    target_port: u16,
) -> Result<u16, String> {
    let info = docker
        .inspect_container(tunnel_id, None::<InspectContainerOptions>)
        .await
        .map_err(|e| e.to_string())?;
    info.network_settings
        .and_then(|ns| ns.ports)
        .and_then(|mut ports| ports.remove(&format!("{target_port}/tcp")).flatten())
        .and_then(|bindings| bindings.into_iter().find_map(|b| b.host_port?.parse().ok()))
        .ok_or_else(|| "Failed to determine assigned local port".to_string())
}

// Best-effort readiness probe so "open in browser" right after creation
// doesn't hit a not-yet-listening socat. Never fails: worst case ~1s wait.
async fn wait_listening(port: u16) {
    for _ in 0..20 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn tunnel_filters(owner: &str) -> HashMap<String, Vec<String>> {
    let mut filters = HashMap::new();
    filters.insert(
        "label".to_string(),
        vec![
            format!("{TUNNEL_LABEL}=true"),
            format!("{OWNER_LABEL}={owner}"),
        ],
    );
    filters
}

async fn remove_tunnel(docker: &Docker, tunnel_id: &str) -> Result<(), String> {
    let result = docker
        .remove_container(
            tunnel_id,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
    match result {
        Ok(()) => Ok(()),
        // auto_remove may have raced us; gone counts as removed
        Err(e) => {
            if docker
                .inspect_container(tunnel_id, None::<InspectContainerOptions>)
                .await
                .is_err()
            {
                Ok(())
            } else {
                Err(format!("Failed to remove tunnel container: {e}"))
            }
        }
    }
}

/// Stop all tunnel containers owned by this Pike instance (found by label,
/// so leftovers from a crashed session are also swept).
pub async fn cleanup_all(docker: &Docker, owner: &str) {
    let opts = ListContainersOptions {
        all: true,
        filters: Some(tunnel_filters(owner)),
        ..Default::default()
    };
    let Ok(containers) = docker.list_containers(Some(opts)).await else {
        return;
    };
    let ids: Vec<String> = containers.into_iter().filter_map(|c| c.id).collect();
    futures_util::future::join_all(ids.iter().map(|id| async move {
        let _ = remove_tunnel(docker, id).await;
    }))
    .await;
}

/// Build a TunnelInfo from a running tunnel container's labels and port
/// bindings. Returns None for tunnels owned by another Pike instance.
pub(super) fn tunnel_from_summary(c: &ContainerSummary, owner: &str) -> Option<TunnelInfo> {
    let labels = c.labels.as_ref()?;
    if labels.get(OWNER_LABEL).map(String::as_str) != Some(owner) {
        return None;
    }
    let local_port = c.ports.as_ref()?.iter().find_map(|p| p.public_port)?;
    Some(TunnelInfo {
        tunnel_id: c.id.clone()?,
        target_id: labels.get(TARGET_LABEL)?.clone(),
        target_port: labels.get(PORT_LABEL)?.parse().ok()?,
        local_port,
    })
}

#[tauri::command]
pub async fn docker_tunnel_create(
    container_id: String,
    port: u16,
    state: State<'_, DockerState>,
) -> Result<TunnelInfo, String> {
    let docker = get_docker(&state).await?;
    let owner = instance_owner(&state);
    let info = create_tunnel(&docker, &owner, &container_id, port).await?;
    state
        .tunnels_created
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(info)
}

#[tauri::command]
pub async fn docker_tunnel_stop(
    tunnel_id: String,
    state: State<'_, DockerState>,
) -> Result<(), String> {
    let docker = get_docker(&state).await?;
    remove_tunnel(&docker, &tunnel_id).await
}

/// List the exposed TCP ports of a container (image EXPOSE / compose expose),
/// used as forward-target candidates in the UI.
#[tauri::command]
pub async fn docker_container_ports(
    container_id: String,
    state: State<'_, DockerState>,
) -> Result<Vec<u16>, String> {
    let docker = get_docker(&state).await?;
    let info = docker
        .inspect_container(&container_id, None::<InspectContainerOptions>)
        .await
        .map_err(|e| e.to_string())?;

    let mut ports: Vec<u16> = info
        .config
        .and_then(|c| c.exposed_ports)
        .map(|exposed| {
            exposed
                .iter()
                .filter_map(|key| key.strip_suffix("/tcp")?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}
