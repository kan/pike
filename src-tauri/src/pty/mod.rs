use crate::types::ShellConfig;
use percent_encoding::percent_decode_str;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct PtyState {
    pub sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    cwd: Arc<Mutex<Option<String>>>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
    code: i32,
}

#[derive(Serialize)]
pub struct PtySpawnResult {
    id: String,
}

/// Common PTY spawn logic: open PTY, run command, start reader thread
fn spawn_pty_with_command(
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    app: AppHandle,
    state: &PtyState,
) -> Result<PtySpawnResult, String> {
    let pty_system = native_pty_system();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let shared_cwd = Arc::new(Mutex::new(cwd));

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                cwd: Arc::clone(&shared_cwd),
            },
        );
    }

    // Spawn reader thread to forward PTY output to frontend
    let read_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = vec![0u8; 4096];
        let mut carry = Vec::new(); // Incomplete UTF-8 bytes from previous read
        let mut osc_buf = Vec::new(); // Buffer for accumulating OSC 7 sequence
        let mut in_osc7 = false;
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => {
                    let _ = app.emit(
                        "pty_exit",
                        PtyExitPayload {
                            id: read_id.clone(),
                            code: 0,
                        },
                    );
                    break;
                }
                Ok(n) => {
                    // Fast path (~99%): no leftover bytes, validate buf directly
                    let chunk = if carry.is_empty() {
                        &buf[..n]
                    } else {
                        carry.extend_from_slice(&buf[..n]);
                        &carry
                    };
                    let (valid, remainder) = match std::str::from_utf8(chunk) {
                        Ok(s) => (s, &[] as &[u8]),
                        Err(e) => {
                            let at = e.valid_up_to();
                            // Safety: from_utf8 confirmed bytes up to `at` are valid
                            let s = unsafe { std::str::from_utf8_unchecked(&chunk[..at]) };
                            (s, &chunk[at..])
                        }
                    };
                    if !valid.is_empty() {
                        // Parse OSC 7 sequences for CWD tracking
                        extract_osc7(valid, &mut in_osc7, &mut osc_buf, &shared_cwd);
                        let _ = app.emit(
                            "pty_output",
                            PtyOutputPayload {
                                id: read_id.clone(),
                                data: valid.to_owned(),
                            },
                        );
                    }
                    // Keep only incomplete trailing bytes (max 3 for UTF-8)
                    if remainder.len() > 4 {
                        // Not an incomplete sequence — flush as lossy
                        let _ = app.emit(
                            "pty_output",
                            PtyOutputPayload {
                                id: read_id.clone(),
                                data: String::from_utf8_lossy(remainder).into_owned(),
                            },
                        );
                        carry.clear();
                    } else {
                        carry = remainder.to_vec();
                    }
                }
                Err(_) => {
                    let _ = app.emit(
                        "pty_exit",
                        PtyExitPayload {
                            id: read_id.clone(),
                            code: -1,
                        },
                    );
                    break;
                }
            }
        }
    });

    Ok(PtySpawnResult { id })
}

fn find_git_bash() -> Result<String, String> {
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }
    // Try PATH (with 5s timeout to avoid hanging)
    if let Ok(child) = crate::types::silent_command("where")
        .arg("git")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        let pid = child.id();
        if let Ok(output) = crate::types::wait_with_timeout(
            pid,
            std::time::Duration::from_secs(5),
            "where git",
            move || child.wait_with_output(),
        ) {
            if let Ok(git_path) = String::from_utf8(output.stdout) {
                if let Some(line) = git_path.lines().next() {
                    let git_dir = std::path::Path::new(line.trim());
                    if let Some(parent) = git_dir.parent().and_then(|p| p.parent()) {
                        let bash = parent.join("bin").join("bash.exe");
                        if bash.exists() {
                            return Ok(bash.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
    Err("Git Bash not found. Install Git for Windows.".into())
}

#[tauri::command]
pub async fn pty_spawn(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<ShellConfig>,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<PtySpawnResult, String> {
    let mut cmd = match &shell {
        None | Some(ShellConfig::Wsl { .. }) => {
            let mut c = CommandBuilder::new("wsl.exe");
            if let Some(ShellConfig::Wsl { distro }) = &shell {
                c.args(["-d", distro]);
            }
            if let Some(dir) = &cwd {
                c.args(["--cd", dir]);
            }
            c.arg("bash");
            c
        }
        Some(ShellConfig::Cmd) => {
            let mut c = CommandBuilder::new("cmd.exe");
            if let Some(dir) = &cwd {
                c.cwd(dir);
            }
            c
        }
        Some(ShellConfig::Powershell) => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            if let Some(dir) = &cwd {
                c.cwd(dir);
            }
            c
        }
        Some(ShellConfig::GitBash) => {
            let bash_path = find_git_bash()?;
            let mut c = CommandBuilder::new(bash_path);
            c.arg("--login");
            if let Some(dir) = &cwd {
                c.cwd(dir);
            }
            c
        }
    };
    if !matches!(shell, Some(ShellConfig::Cmd)) {
        cmd.env("TERM", "xterm-256color");
    }
    spawn_pty_with_command(cmd, cols, rows, cwd, app, &state)
}

use crate::types::validate_slug;

#[tauri::command]
pub async fn pty_spawn_tmux(
    session_name: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<PtySpawnResult, String> {
    validate_slug(&session_name, "Session name")?;
    let tmux_cmd = format!(
        "tmux has-session -t {name} 2>/dev/null && tmux -2 attach-session -t {name} || tmux -2 new-session -s {name}",
        name = session_name
    );
    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.args(["bash", "-lc", &tmux_cmd]);
    cmd.env("TERM", "xterm-256color");
    spawn_pty_with_command(cmd, cols, rows, None, app, &state)
}

#[tauri::command]
pub async fn pty_get_cwd(
    id: String,
    state: State<'_, PtyState>,
) -> Result<Option<String>, String> {
    let cwd_arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let Some(session) = sessions.get(&id) else {
            return Ok(None);
        };
        Arc::clone(&session.cwd)
    };
    let cwd = cwd_arc.lock().map_err(|e| e.to_string())?;
    Ok(cwd.clone())
}

#[tauri::command]
pub async fn pty_write(
    id: String,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    // Clone the Arc so the sessions lock is released before the write.
    // This prevents a blocked write from deadlocking resize/kill.
    let writer = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&id).ok_or("Session not found")?;
        Arc::clone(&session.writer)
    };
    tokio::task::spawn_blocking(move || {
        let mut w = writer.lock().map_err(|e| e.to_string())?;
        w.write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(id: String, state: State<'_, PtyState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.remove(&id);
    Ok(())
}

/// Scan `text` for OSC 7 sequences (`\x1b]7;file://host/path\x07`) and update
/// the shared CWD when found.  `in_osc7` and `osc_buf` carry state across calls
/// to handle sequences split across read boundaries.
///
/// Known limitation: the 4-byte prefix `\x1b]7;` must appear within a single
/// chunk.  If a read boundary splits the prefix (e.g., chunk ends with `\x1b]`),
/// the sequence will be missed.  In practice this is extremely unlikely with
/// 4096-byte reads.
fn extract_osc7(
    text: &str,
    in_osc7: &mut bool,
    osc_buf: &mut Vec<u8>,
    shared_cwd: &Arc<Mutex<Option<String>>>,
) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if *in_osc7 {
            // Look for terminator: BEL (\x07) or ST (\x1b\\)
            let is_bel = bytes[i] == 0x07;
            let is_st = bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\';
            if is_bel || is_st {
                if let Some(path) = parse_osc7_url(osc_buf) {
                    if let Ok(mut cwd) = shared_cwd.lock() {
                        *cwd = Some(path);
                    }
                }
                osc_buf.clear();
                *in_osc7 = false;
                if is_st {
                    i += 1; // skip the backslash
                }
            } else {
                osc_buf.push(bytes[i]);
                if osc_buf.len() > 4096 {
                    // Runaway sequence — abort
                    osc_buf.clear();
                    *in_osc7 = false;
                }
            }
        } else if bytes[i] == 0x1b
            && i + 3 < bytes.len()
            && bytes[i + 1] == b']'
            && bytes[i + 2] == b'7'
            && bytes[i + 3] == b';'
        {
            *in_osc7 = true;
            osc_buf.clear();
            i += 3; // skip `]7;`, the loop increment handles the `;`
        }
        i += 1;
    }
}

/// Parse an OSC 7 URL payload like `file://hostname/path` and return the path.
fn parse_osc7_url(buf: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(buf).ok()?;
    // Format: file://hostname/path  or  file:///path
    let rest = s.strip_prefix("file://")?;
    // Skip hostname (everything up to the first `/` after `//`)
    let path = if let Some(slash_pos) = rest.find('/') {
        &rest[slash_pos..]
    } else {
        return None;
    };
    Some(percent_decode_str(path).decode_utf8_lossy().into_owned())
}
