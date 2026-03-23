///! Docker (bollard) 接続確認
///! Usage: cargo run --bin verify_bollard
use bollard::Docker;

#[tokio::main]
async fn main() {
    println!("=== Bollard (Docker) Verification ===\n");

    println!("[1] Connecting to Docker via named pipe...");
    let docker = match Docker::connect_with_named_pipe_defaults() {
        Ok(d) => {
            println!("    Connected!");
            d
        }
        Err(e) => {
            eprintln!("    Failed to connect: {}", e);
            eprintln!("    Is Docker Desktop running?");
            return;
        }
    };

    println!("[2] Getting Docker version...");
    match docker.version().await {
        Ok(version) => {
            println!("    Version: {}", version.version.unwrap_or_default());
            println!("    API Version: {}", version.api_version.unwrap_or_default());
            println!("    OS/Arch: {}/{}", version.os.unwrap_or_default(), version.arch.unwrap_or_default());
        }
        Err(e) => {
            eprintln!("    Failed: {}", e);
            return;
        }
    }

    println!("[3] Listing containers...");
    use bollard::container::ListContainersOptions;
    let options = ListContainersOptions::<String> {
        all: true,
        ..Default::default()
    };
    match docker.list_containers(Some(options)).await {
        Ok(containers) => {
            if containers.is_empty() {
                println!("    No containers found.");
            } else {
                for c in &containers {
                    let names = c.names.as_ref().map(|n| n.join(", ")).unwrap_or_default();
                    let state = c.state.as_deref().unwrap_or("unknown");
                    let image = c.image.as_deref().unwrap_or("unknown");
                    println!("    {} | {} | {}", names, state, image);
                }
                println!("    Total: {} containers", containers.len());
            }
        }
        Err(e) => {
            eprintln!("    Failed: {}", e);
            return;
        }
    }

    println!("\n=== Bollard Verification Complete ===");
}
