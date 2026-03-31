use crate::fs::IGNORED_DIRS;
use crate::types::{silent_command, ShellConfig};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

pub struct WatcherState {
    pub handles: Arc<Mutex<HashMap<String, WatcherHandle>>>,
}

pub enum WatcherHandle {
    Native {
        _watcher: RecommendedWatcher,
        stop_flag: Arc<Mutex<bool>>,
    },
    Wsl {
        child_pid: u32,
        stop_flag: Arc<Mutex<bool>>,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayload {
    pub watcher_id: String,
    pub changed_dirs: Vec<String>,
    pub changed_files: Vec<FsChangeEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEntry {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Create,
    Modify,
    Delete,
}

fn path_contains_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        if let std::path::Component::Normal(name) = c {
            if let Some(s) = name.to_str() {
                return IGNORED_DIRS.contains(&s);
            }
        }
        false
    })
}

struct EventBuffer {
    dirs: HashSet<String>,
    files: Vec<FsChangeEntry>,
    last_event: Instant,
    first_event: Instant,
}

impl EventBuffer {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            dirs: HashSet::new(),
            files: Vec::new(),
            last_event: now,
            first_event: now,
        }
    }

    fn add(&mut self, dir: String, file: FsChangeEntry) {
        self.dirs.insert(dir);
        self.files.push(file);
        self.last_event = Instant::now();
    }

    fn should_flush(&self) -> bool {
        let now = Instant::now();
        let since_last = now.duration_since(self.last_event);
        let since_first = now.duration_since(self.first_event);
        since_last >= Duration::from_millis(200) || since_first >= Duration::from_millis(1000)
    }

    fn take(&mut self) -> Option<(Vec<String>, Vec<FsChangeEntry>)> {
        if self.dirs.is_empty() {
            return None;
        }
        let dirs: Vec<String> = self.dirs.drain().collect();
        let files: Vec<FsChangeEntry> = std::mem::take(&mut self.files);
        let now = Instant::now();
        self.first_event = now;
        self.last_event = now;
        Some((dirs, files))
    }
}

fn event_kind_to_change(kind: &EventKind) -> Option<ChangeKind> {
    match kind {
        EventKind::Create(_) => Some(ChangeKind::Create),
        EventKind::Modify(_) => Some(ChangeKind::Modify),
        EventKind::Remove(_) => Some(ChangeKind::Delete),
        _ => None,
    }
}

fn spawn_flush_thread(
    buffer: Arc<Mutex<EventBuffer>>,
    stop_flag: Arc<Mutex<bool>>,
    app: AppHandle,
    watcher_id: String,
) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(100));
            if *stop_flag.lock().unwrap() {
                break;
            }
            let payload = {
                let mut buf = buffer.lock().unwrap();
                if buf.should_flush() {
                    buf.take()
                } else {
                    None
                }
            };
            if let Some((dirs, files)) = payload {
                let _ = app.emit(
                    "fs_changed",
                    FsChangedPayload {
                        watcher_id: watcher_id.clone(),
                        changed_dirs: dirs,
                        changed_files: files,
                    },
                );
            }
        }
    });
}

#[tauri::command]
pub async fn fs_watch_start(
    shell: ShellConfig,
    root: String,
    app: AppHandle,
    state: State<'_, WatcherState>,
) -> Result<String, String> {
    let watcher_id = uuid::Uuid::new_v4().to_string();

    match &shell {
        ShellConfig::Wsl { .. } => {
            start_wsl_watcher(&watcher_id, &shell, &root, app, &state)?;
        }
        _ => start_native_watcher(&watcher_id, &root, app, &state)?,
    }

    Ok(watcher_id)
}

fn start_native_watcher(
    watcher_id: &str,
    root: &str,
    app: AppHandle,
    state: &State<'_, WatcherState>,
) -> Result<(), String> {
    let id = watcher_id.to_string();
    let root_path = PathBuf::from(root);
    let buffer = Arc::new(Mutex::new(EventBuffer::new()));
    let stop_flag = Arc::new(Mutex::new(false));

    spawn_flush_thread(buffer.clone(), stop_flag.clone(), app, id.clone());

    let root_for_filter = root_path.clone();
    let buffer_cb = buffer.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let kind = match event_kind_to_change(&event.kind) {
                    Some(k) => k,
                    None => return,
                };
                for path in &event.paths {
                    let rel = match path.strip_prefix(&root_for_filter) {
                        Ok(r) => r,
                        Err(_) => continue,
                    };
                    if path_contains_ignored(rel) {
                        continue;
                    }
                    let parent = path
                        .parent()
                        .unwrap_or(path)
                        .to_string_lossy()
                        .into_owned();
                    let file_path = path.to_string_lossy().into_owned();
                    let mut buf = buffer_cb.lock().unwrap();
                    buf.add(
                        parent,
                        FsChangeEntry {
                            path: file_path,
                            kind: kind.clone(),
                        },
                    );
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(root_path.as_path(), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    state
        .handles
        .lock()
        .unwrap()
        .insert(id, WatcherHandle::Native { _watcher: watcher, stop_flag });

    Ok(())
}

fn start_wsl_watcher(
    watcher_id: &str,
    shell: &ShellConfig,
    root: &str,
    app: AppHandle,
    state: &State<'_, WatcherState>,
) -> Result<(), String> {
    let id = watcher_id.to_string();
    let stop_flag = Arc::new(Mutex::new(false));

    let exclude_pattern = IGNORED_DIRS
        .iter()
        .map(|d| format!("/{d}/"))
        .collect::<Vec<_>>()
        .join("|");
    let exclude_regex = format!("({})", exclude_pattern);

    let distro = match shell {
        ShellConfig::Wsl { distro } => distro,
        _ => return Err("WSL shell expected".into()),
    };
    // Use -e flag to bypass bash and avoid shell interpretation of | and ()
    let mut cmd = silent_command("wsl.exe");
    cmd.args(["-d", distro, "-e", "inotifywait",
        "-m", "-r",
        "-e", "create,delete,modify,move",
        "--format", "%w%f|%e",
        "--exclude", &exclude_regex,
        "--", root,
    ]);

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    let mut child = cmd.spawn().map_err(|e| {
        format!("inotifywait not available: {e}\nInstall with: sudo apt install inotify-tools")
    })?;

    let child_pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture inotifywait stdout".to_string())?;

    let buffer = Arc::new(Mutex::new(EventBuffer::new()));

    spawn_flush_thread(buffer.clone(), stop_flag.clone(), app, id.clone());

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let parts: Vec<&str> = line.splitn(2, '|').collect();
            if parts.len() != 2 {
                continue;
            }
            let file_path = parts[0].to_string();
            let event_str = parts[1].to_uppercase();

            let kind = if event_str.contains("CREATE") || event_str.contains("MOVED_TO") {
                ChangeKind::Create
            } else if event_str.contains("DELETE") || event_str.contains("MOVED_FROM") {
                ChangeKind::Delete
            } else if event_str.contains("MODIFY") {
                ChangeKind::Modify
            } else {
                continue;
            };

            let parent = if let Some(pos) = file_path.rfind('/') {
                file_path[..pos].to_string()
            } else {
                file_path.clone()
            };

            let mut buf = buffer.lock().unwrap();
            buf.add(parent, FsChangeEntry { path: file_path, kind });
        }
        let _ = child.wait();
    });

    state.handles.lock().unwrap().insert(
        id,
        WatcherHandle::Wsl {
            child_pid,
            stop_flag,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn fs_watch_stop(
    watcher_id: String,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let handle = state.handles.lock().unwrap().remove(&watcher_id);
    if let Some(handle) = handle {
        stop_watcher_handle(handle);
    }
    Ok(())
}

fn stop_watcher_handle(handle: WatcherHandle) {
    match handle {
        WatcherHandle::Native { stop_flag, .. } => {
            *stop_flag.lock().unwrap() = true;
        }
        WatcherHandle::Wsl {
            child_pid,
            stop_flag,
        } => {
            *stop_flag.lock().unwrap() = true;
            let pid_str = child_pid.to_string();
            std::thread::spawn(move || {
                let _ = silent_command("taskkill")
                    .args(["/F", "/T", "/PID", &pid_str])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            });
        }
    }
}

pub fn stop_all(state: &WatcherState) {
    if let Ok(mut handles) = state.handles.lock() {
        for (_, handle) in handles.drain() {
            stop_watcher_handle(handle);
        }
    }
}
