//! ターミナルの「シェル以外のプロセスが動いているか」判定 (#178) の前提確認。
//! Usage: cargo run --bin verify_busy
//!
//! 確かめたいこと:
//!   1. ConPTY 配下の Windows シェルは、アイドル時に子プロセスを持たないか
//!      （conhost 等がぶら下がると常時 busy 扱いになってしまう）
//!   2. コマンド実行中はその子プロセスが見えるか
//!   3. WSL では PIKE_PTY_ID マーカーが Linux 側へ伝わり、/proc 走査で
//!      「シェル + 実行中プロセス」を数えられるか
#[cfg(windows)]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
#[cfg(windows)]
use std::io::{Read, Write};
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
const SIZE: PtySize = PtySize {
    rows: 24,
    cols: 80,
    pixel_width: 0,
    pixel_height: 0,
};

/// (pid, ppid, exe) の一覧をプロセススナップショットから取る。
#[cfg(windows)]
fn snapshot() -> Vec<(u32, u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                out.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..len]),
                ));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// root の子孫プロセスを列挙する。
#[cfg(windows)]
fn descendants(root: u32) -> Vec<(u32, String)> {
    let all = snapshot();
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, ppid, exe) in &all {
            if *ppid == parent && *pid != parent && !found.iter().any(|(p, _)| p == pid) {
                found.push((*pid, exe.clone()));
                frontier.push(*pid);
            }
        }
    }
    found
}

#[cfg(windows)]
type Shared = std::sync::Arc<std::sync::Mutex<String>>;
#[cfg(windows)]
type SharedWriter = std::sync::Arc<std::sync::Mutex<Box<dyn Write + Send>>>;

/// PTY を 1 つ起動する。戻り値は (writer, pid, 出力バッファ)。
///
/// ConPTY は起動直後にカーソル位置問い合わせ (DSR, `ESC[6n`) を送り、応答が
/// 返るまで先へ進まない。実機では xterm.js が応答するので、検証側でも
/// リーダースレッドが同じ応答を返す。
#[cfg(windows)]
fn spawn(cmd: CommandBuilder) -> (SharedWriter, u32, Shared) {
    let pair = native_pty_system().openpty(SIZE).expect("openpty");
    let child = pair.slave.spawn_command(cmd).expect("spawn");
    let pid = child.process_id().expect("process_id");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let writer: SharedWriter =
        std::sync::Arc::new(std::sync::Mutex::new(pair.master.take_writer().expect("writer")));
    let out: Shared = Default::default();
    let sink = out.clone();
    let responder = writer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&buf[..n]).into_owned();
            if text.contains("\u{1b}[6n") {
                let mut w = responder.lock().unwrap();
                let _ = w.write_all(b"\x1b[1;1R");
                let _ = w.flush();
            }
            sink.lock().unwrap().push_str(&text);
        }
    });
    // master を保持し続けないと ConPTY が閉じるのでリークさせる（検証用）
    std::mem::forget(pair.master);
    (writer, pid, out)
}

#[cfg(windows)]
fn send(writer: &SharedWriter, line: &str) {
    let mut w = writer.lock().unwrap();
    write!(w, "{line}\r\n").expect("write");
    w.flush().ok();
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    snapshot().iter().any(|(p, _, _)| *p == pid)
}

#[cfg(windows)]
fn tail(out: &Shared) -> String {
    let s = out.lock().unwrap();
    let t: String = s.chars().rev().take(160).collect::<Vec<_>>()
        .into_iter().rev().collect();
    t.replace('\u{1b}', "<ESC>").replace('\r', "\\r").replace('\n', "\\n")
}

#[cfg(windows)]
fn windows_shell(label: &str, mut cmd: CommandBuilder, busy_line: &str) {
    println!("\n=== [{label}] ===");
    cmd.env("TERM", "xterm-256color");
    let (writer, pid, out) = spawn(cmd);
    println!("  shell pid = {pid}");

    std::thread::sleep(Duration::from_millis(2500));
    let idle = descendants(pid);
    println!("  alive={} idle 時の子孫: {} 件 {:?}", alive(pid), idle.len(), idle);
    println!("  出力末尾: {}", tail(&out));

    send(&writer, busy_line);
    std::thread::sleep(Duration::from_millis(2500));
    let busy = descendants(pid);
    println!("  実行中の子孫: {} 件 {:?}", busy.len(), busy);
    println!("  出力末尾: {}", tail(&out));

    println!(
        "  => idle={} busy={} {}",
        idle.len(),
        busy.len(),
        if idle.is_empty() && !busy.is_empty() {
            "OK"
        } else {
            "NG (判定に使えない)"
        }
    );
}

/// WSL 側で marker を持つプロセス数を数える。
#[cfg(windows)]
fn wsl_marked_count(marker: &str) -> String {
    let script = format!(
        "n=0; for p in /proc/[0-9]*; do grep -qz '^PIKE_PTY_ID={marker}$' \"$p/environ\" 2>/dev/null && n=$((n+1)); done; echo $n"
    );
    let out = std::process::Command::new("wsl.exe")
        .args(["-e", "bash", "-c", &script])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(e) => format!("error: {e}"),
    }
}

#[cfg(windows)]
fn wsl() {
    println!("\n=== [wsl bash] ===");
    let marker = "verify-busy-0000";
    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.args(["--cd", "~"]);
    cmd.arg("bash");
    cmd.env("TERM", "xterm-256color");
    cmd.env("PIKE_PTY_ID", marker);
    cmd.env("WSLENV", "PIKE_PTY_ID");
    let (writer, pid, out) = spawn(cmd);
    println!("  wsl.exe pid = {pid} (Windows 側)");

    std::thread::sleep(Duration::from_millis(3000));
    println!("  Windows 側の子孫: {:?}", descendants(pid));
    println!("  出力末尾: {}", tail(&out));
    let idle = wsl_marked_count(marker);
    println!("  idle 時の marker 付きプロセス数 = {idle} (期待: 1 = bash のみ)");

    send(&writer, "sleep 8");
    std::thread::sleep(Duration::from_millis(2500));
    let busy = wsl_marked_count(marker);
    println!("  sleep 実行中の marker 付きプロセス数 = {busy} (期待: 2)");

    println!(
        "  => {}",
        if idle == "1" && busy == "2" {
            "OK"
        } else {
            "NG (判定に使えない)"
        }
    );
}

#[cfg(windows)]
fn main() {
    println!("=== Busy Detection Verification (#178) ===");

    let mut ps = CommandBuilder::new("powershell.exe");
    ps.arg("-NoLogo");
    windows_shell("powershell", ps, "ping -n 8 127.0.0.1 > $null");

    windows_shell(
        "cmd",
        CommandBuilder::new("cmd.exe"),
        "ping -n 8 127.0.0.1 > nul",
    );

    wsl();

    println!("\n=== Complete ===");
    std::process::exit(0);
}

/// ConPTY と WSL の挙動を確かめるものなので、中身ごと Windows 専用。
/// 非 Windows でもビルド対象には入る（cargo は src/bin/*.rs を自動で拾う）ため、
/// main だけは常に生やしておく。
#[cfg(not(windows))]
fn main() {
    eprintln!("verify_busy は Windows 専用です（ConPTY / WSL の挙動確認）");
}
