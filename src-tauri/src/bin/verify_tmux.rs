///! tmux セッション管理の確認
///! Usage: cargo run --bin verify_tmux
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};

fn check_tmux_available() -> bool {
    let output = std::process::Command::new("wsl.exe")
        .args(["bash", "-lc", "which tmux"])
        .output()
        .expect("Failed to run wsl.exe");
    output.status.success()
}

fn check_session_exists(name: &str) -> bool {
    let output = std::process::Command::new("wsl.exe")
        .args([
            "bash",
            "-lc",
            &format!("tmux has-session -t {} 2>/dev/null", name),
        ])
        .output()
        .expect("Failed to run wsl.exe");
    output.status.success()
}

fn main() {
    let session_name = "verify_test";

    println!("=== tmux Verification ===\n");

    // Step 1: Check tmux is available
    println!("[1] Checking tmux availability...");
    if !check_tmux_available() {
        eprintln!("ERROR: tmux not found in WSL2. Install with: wsl.exe bash -lc 'sudo apt install tmux'");
        std::process::exit(1);
    }
    println!("    OK: tmux is available\n");

    // Step 2: Check if session already exists
    println!("[2] Checking if session '{}' exists...", session_name);
    let existed = check_session_exists(session_name);
    if existed {
        println!("    Session already exists — will attach\n");
    } else {
        println!("    Session does not exist — will create new\n");
    }

    // Step 3: Spawn PTY with tmux
    println!("[3] Opening PTY with tmux...");
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).expect("Failed to open PTY");

    let tmux_cmd = format!(
        "tmux has-session -t {name} 2>/dev/null && tmux -2 attach-session -t {name} || tmux -2 new-session -s {name}",
        name = session_name
    );
    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.args(&["bash", "-lc", &tmux_cmd]);
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).expect("Failed to spawn");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("Failed to get reader");
    let mut writer = pair.master.take_writer().expect("Failed to get writer");

    println!("    PTY spawned, reading initial output...\n---");

    // Read initial output (tmux draws the screen)
    let mut buf = [0u8; 4096];
    // Set a short timeout by reading in a thread
    let (tx, rx) = std::sync::mpsc::channel();
    let read_thread = std::thread::spawn(move || {
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(None);
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    if tx.send(Some(text)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    break;
                }
            }
        }
    });

    // Collect output for 2 seconds
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(Some(text)) => print!("{}", text),
            Ok(None) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
    println!("\n---");

    // Step 4: Send a test command
    println!("\n[4] Sending test command: echo 'tmux works!'");
    writer
        .write_all(b"echo 'tmux works!'\n")
        .expect("Failed to write");
    writer.flush().expect("Failed to flush");

    // Read command output for 1 second
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    print!("---\n");
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(Some(text)) => print!("{}", text),
            Ok(None) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
    println!("\n---");

    // Step 5: Detach from tmux (Ctrl+B d)
    println!("\n[5] Detaching from tmux (Ctrl+B d)...");
    writer.write_all(&[0x02]).expect("Failed to write Ctrl+B"); // Ctrl+B
    writer.flush().expect("Failed to flush");
    std::thread::sleep(std::time::Duration::from_millis(200));
    writer.write_all(b"d").expect("Failed to write 'd'");
    writer.flush().expect("Failed to flush");

    // Wait for process to exit after detach
    std::thread::sleep(std::time::Duration::from_secs(1));

    // Step 6: Verify session survived detach
    println!("[6] Verifying session survived detach...");
    if check_session_exists(session_name) {
        println!("    OK: Session '{}' is still alive after detach!", session_name);
    } else {
        eprintln!("    ERROR: Session was destroyed after detach");
        std::process::exit(1);
    }

    // Cleanup: kill the verification session
    println!("\n[7] Cleaning up: killing session '{}'...", session_name);
    let _ = std::process::Command::new("wsl.exe")
        .args([
            "bash",
            "-lc",
            &format!("tmux kill-session -t {}", session_name),
        ])
        .output();

    drop(writer);
    let _ = read_thread.join();
    let _ = child.wait();

    println!("\n=== tmux Verification Complete ===");
}
