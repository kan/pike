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
    writer: Box<dyn Write + Send>,
    #[allow(dead_code)]
    child: Box<dyn Child + Send + Sync>,
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

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    // Spawn reader thread to forward PTY output to frontend
    let read_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = vec![0u8; 4096];
        let mut carry = Vec::new(); // Incomplete UTF-8 bytes from previous read
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

#[tauri::command]
pub async fn pty_spawn(
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<PtySpawnResult, String> {
    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.arg("bash");
    cmd.env("TERM", "xterm-256color");
    spawn_pty_with_command(cmd, cols, rows, app, &state)
}

fn validate_session_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Session name must be 1-64 characters".to_string());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Session name must contain only [a-zA-Z0-9_-]".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_spawn_tmux(
    session_name: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<PtySpawnResult, String> {
    validate_session_name(&session_name)?;
    let tmux_cmd = format!(
        "tmux has-session -t {name} 2>/dev/null && tmux -2 attach-session -t {name} || tmux -2 new-session -s {name}",
        name = session_name
    );
    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.args(&["bash", "-lc", &tmux_cmd]);
    cmd.env("TERM", "xterm-256color");
    spawn_pty_with_command(cmd, cols, rows, app, &state)
}

#[tauri::command]
pub async fn pty_write(
    id: String,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("Session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
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
