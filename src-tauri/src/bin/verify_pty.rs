//! PTY + wsl.exe の接続確認
//! Usage: cargo run --bin verify_pty
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;

fn main() {
    println!("=== PTY Verification ===\n");

    let pty_system = native_pty_system();

    let size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };

    println!("[1] Opening PTY...");
    let pair = pty_system.openpty(size).expect("Failed to open PTY");

    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.arg("bash");
    cmd.arg("-c");
    cmd.arg("echo 'Hello from WSL2!' && uname -a && exit");
    cmd.env("TERM", "xterm-256color");

    println!("[2] Spawning wsl.exe bash...");
    let mut child = pair.slave.spawn_command(cmd).expect("Failed to spawn");

    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("Failed to get reader");

    println!("[3] Reading output...\n---");

    let mut buf = [0u8; 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                print!("{}", text);
            }
            Err(e) => {
                eprintln!("\nRead error: {}", e);
                break;
            }
        }
    }

    println!("---\n[4] Waiting for exit...");
    let status = child.wait().expect("Failed to wait");
    println!("[5] Process exited: {:?}", status);
    println!("\n=== PTY Verification Complete ===");
}
