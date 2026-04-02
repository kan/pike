//! Docker (bollard) 接続確認
//! Usage: cargo run --bin verify_bollard
use bollard::query_parameters::{ListContainersOptions, LogsOptions};
use bollard::Docker;
use futures_util::StreamExt;

/// Connect to Docker with fallback strategy (same as musql):
/// 1. Local defaults (named pipe on Windows / DOCKER_HOST env)
/// 2. TCP 127.0.0.1:2375 (WSL2 dockerd unencrypted)
/// 3. TCP 127.0.0.1:2376 (WSL2 dockerd encrypted)
async fn connect_docker() -> Result<Docker, String> {
    // 1. Platform default (named pipe / DOCKER_HOST)
    if let Ok(docker) = Docker::connect_with_local_defaults() {
        if docker.ping().await.is_ok() {
            println!("    Connected via local defaults (named pipe / DOCKER_HOST)");
            return Ok(docker);
        }
    }
    // 2. TCP fallback for WSL2 dockerd
    for port in [2375, 2376] {
        let url = format!("tcp://127.0.0.1:{}", port);
        if let Ok(docker) =
            Docker::connect_with_http(&url, 4, bollard::API_DEFAULT_VERSION)
        {
            if docker.ping().await.is_ok() {
                println!("    Connected via TCP 127.0.0.1:{}", port);
                return Ok(docker);
            }
        }
    }
    Err("Docker is not reachable. Tried: named pipe, TCP :2375, TCP :2376".to_string())
}

#[tokio::main]
async fn main() {
    println!("=== Bollard (Docker) Verification ===\n");

    // Step 1: Connect
    println!("[1] Connecting to Docker...");
    let docker = match connect_docker().await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("    {}", e);
            eprintln!("    Ensure Docker is running and accessible.");
            eprintln!("    For WSL2 without Docker Desktop, configure dockerd to listen on tcp://127.0.0.1:2375");
            return;
        }
    };

    // Step 2: Version
    println!("[2] Getting Docker version...");
    match docker.version().await {
        Ok(version) => {
            println!(
                "    Version: {}",
                version.version.unwrap_or_default()
            );
            println!(
                "    API Version: {}",
                version.api_version.unwrap_or_default()
            );
            println!(
                "    OS/Arch: {}/{}",
                version.os.unwrap_or_default(),
                version.arch.unwrap_or_default()
            );
        }
        Err(e) => {
            eprintln!("    Failed: {}", e);
            return;
        }
    }

    // Step 3: List containers
    println!("[3] Listing containers...");
    let options = ListContainersOptions {
        all: true,
        ..Default::default()
    };
    let containers = match docker.list_containers(Some(options)).await {
        Ok(c) => {
            if c.is_empty() {
                println!("    No containers found.");
            } else {
                for container in &c {
                    let names = container
                        .names
                        .as_ref()
                        .map(|n| n.join(", "))
                        .unwrap_or_default();
                    let state = container.state.as_ref().map(|s| s.to_string()).unwrap_or_else(|| "unknown".to_string());
                    let image = container.image.as_deref().unwrap_or("unknown");
                    println!("    {} | {} | {}", names, state, image);
                }
                println!("    Total: {} containers", c.len());
            }
            c
        }
        Err(e) => {
            eprintln!("    Failed: {}", e);
            return;
        }
    };

    // Step 4: Log stream from first running container
    println!("[4] Testing log stream...");
    let running = containers
        .iter()
        .find(|c| c.state.as_ref().map(|s| s.to_string()).as_deref() == Some("running"));

    match running {
        Some(container) => {
            let id = container.id.as_deref().unwrap_or("");
            let names = container
                .names
                .as_ref()
                .map(|n| n.join(", "))
                .unwrap_or_default();
            println!("    Streaming logs from: {} ({})", names, &id[..12]);
            println!("    (showing last 10 lines + 3 seconds of live tail)\n---");

            let log_options = LogsOptions {
                stdout: true,
                stderr: true,
                tail: "10".to_string(),
                follow: true,
                ..Default::default()
            };

            let mut stream = docker.logs(id, Some(log_options));
            let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(3);

            loop {
                tokio::select! {
                    item = stream.next() => {
                        match item {
                            Some(Ok(output)) => print!("    {}", output),
                            Some(Err(e)) => {
                                eprintln!("    Stream error: {}", e);
                                break;
                            }
                            None => {
                                println!("    (stream ended)");
                                break;
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        println!("\n---\n    (stopped after 3 seconds)");
                        break;
                    }
                }
            }
        }
        None => {
            println!("    No running containers — skipping log stream test.");
            println!("    Start a container and re-run to verify log streaming.");
        }
    }

    println!("\n=== Bollard Verification Complete ===");
}
