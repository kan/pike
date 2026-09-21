use crate::fs::IGNORED_DIRS;
use crate::types::{silent_command, ShellConfig};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

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

/// 監視が止まった理由（#385）。
///
/// **`&'static str` にしないこと。** この値は Rust の分類器・TS の union・i18n のキーの
/// 3 か所を渡り歩くので、素の文字列だと 4 つ目を足したときにどこも照合してくれない
/// （`translate` は知らないキーをそのまま返すので、帯にキー文字列が出る）。enum なら
/// `classify_watch_failure` の `match` が網羅性で気付かせる。`ChangeKind` と同じ形。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchFailReason {
    /// `inotifywait` が distro に入っていない。
    MissingTool,
    /// `fs.inotify.max_user_watches` に届いた。
    WatchLimit,
    /// 当てられなかった（`detail` をそのまま見せる側）。
    Other,
}

/// 監視が落ちたことの知らせ（#385）。
///
/// **spawn の成否では分からない。** WSL では起こすのが `wsl.exe` なので、distro の中に
/// `inotifywait` が無くても spawn は成功し、子が終了コード 1 と stderr の 1 行だけを
/// 残して消える。以前はその stderr を捨てていたので、**監視が始まらなかったことが
/// 誰にも届かなかった**（ファイルツリーのパネルに置いた案内も一度も出ていない）。
///
/// **ネイティブ側（`notify`）も同じ口から知らせる。** あちらは監視が張れなかったことを
/// コールバックの `Err` で言うので、捨てると Windows / macOS では同じ「静かに止まる」が
/// 残る（`fs_watch_failed` という一般的な名前に実装を合わせた）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchFailedPayload {
    pub watcher_id: String,
    pub reason: WatchFailReason,
    /// 実際に出た文言。理由を当てられなかったときの唯一の手がかりになる。
    pub detail: String,
}

/// stderr から理由を当てる。**当てられないときは `Other`**（`detail` をそのまま見せる）。
fn classify_watch_failure(stderr: &str) -> WatchFailReason {
    // `wsl.exe` の relay が出す形（`execvpe(inotifywait) failed: …`）と、シェル越しに
    // 起動されたときの形の両方を見る。
    if stderr.contains("execvpe(inotifywait)") || stderr.contains("inotifywait: not found") {
        WatchFailReason::MissingTool
    } else if stderr.contains("upper limit on inotify watches") {
        // `--exclude` はイベントを捨てるだけで監視は張るので、大きなツリーではここに来る。
        WatchFailReason::WatchLimit
    } else {
        WatchFailReason::Other
    }
}

/// 監視が止まったことを 1 回だけ知らせて、自分を入れ物から外す。
///
/// **自分の後始末は自分でする。** 外さないと、`inotifywait` の無い distro ではプロジェクトを
/// 切り替えるたびに 100ms ポーリングのスレッドが 1 本ずつ残り、死んだ PID を抱えたハンドルが
/// 溜まる。ウィンドウを閉じるときの `stop_all` はそれ全部に `taskkill /F /T` を撃つので、
/// **Windows が再利用した PID の無関係なプロセスツリーを殺しうる**。
///
/// **自分で止めたときは知らせない**（`stop_flag`）。プロジェクトの切り替えやウィンドウの
/// 破棄で毎回ダイアログが出てしまう。
fn report_watch_failure(
    app: &AppHandle,
    watcher_id: &str,
    stop_flag: &Arc<Mutex<bool>>,
    reason: WatchFailReason,
    detail: String,
) {
    {
        let mut stopped = stop_flag.lock().unwrap();
        if *stopped {
            return;
        }
        *stopped = true;
    }
    let removed = app.try_state::<WatcherState>().and_then(|state| {
        state
            .handles
            .lock()
            .ok()
            .and_then(|mut handles| handles.remove(watcher_id))
    });
    // **落とすのは別スレッドで。** ネイティブ側ではこの関数が `notify` のコールバック
    // スレッドから呼ばれるので、`RecommendedWatcher` をここで drop すると**自分のスレッドを
    // join しに行く**（macOS の `FsEventWatcher` は実際に join する）。ここで止まると、
    // 監視が死んだことを知らせる経路そのものが固まる。
    if let Some(handle) = removed {
        std::thread::spawn(move || drop(handle));
    }
    let _ = app.emit(
        "fs_watch_failed",
        FsWatchFailedPayload {
            watcher_id: watcher_id.to_owned(),
            reason,
            detail: detail.trim().to_owned(),
        },
    );
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

/// 200ms ぶんの変更をためて 1 回にまとめる入れ物。
///
/// **ファイルはパスで畳む**（#276）。1 回の書き込みが Create と Modify のように複数の
/// 生イベントを生むので、そのまま並べるとフロントは同じパスを 2 回受け取る。受け手には
/// 区別が付かず、「自分が書いたぶんは 1 回だけ吸う」という判定（`useFsWatcher.ts` の
/// `isRecentlySaved`）が、余ったほうを他人の書き込みと見なしてしまう。
struct EventBuffer {
    dirs: HashSet<String>,
    /// パス → 最後に観測した種別。到着順を保つため `IndexMap` 相当の使い方を
    /// `Vec` + `HashMap` でせず、素直に挿入順のない `HashMap` にしてある
    /// （受け手はパスごとに独立して扱うので、並びに意味がない）。
    files: HashMap<String, ChangeKind>,
    last_event: Instant,
    first_event: Instant,
}

impl EventBuffer {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            dirs: HashSet::new(),
            files: HashMap::new(),
            last_event: now,
            first_event: now,
        }
    }

    fn add(&mut self, dir: String, file: FsChangeEntry) {
        self.dirs.insert(dir);
        // 同じパスが再び来たら後のもので上書きする（削除のあと作り直された、など）。
        self.files.insert(file.path, file.kind);
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
        let files: Vec<FsChangeEntry> = std::mem::take(&mut self.files)
            .into_iter()
            .map(|(path, kind)| FsChangeEntry { path, kind })
            .collect();
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
    std::thread::spawn(move || loop {
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
    let id = watcher_id.to_owned();
    let root_path = PathBuf::from(root);
    let buffer = Arc::new(Mutex::new(EventBuffer::new()));
    let stop_flag = Arc::new(Mutex::new(false));

    let failed_app = app.clone();
    let failed_id = id.clone();
    let failed_flag = stop_flag.clone();
    spawn_flush_thread(buffer.clone(), stop_flag.clone(), app, id.clone());

    let root_for_filter = root_path.clone();
    // ここが `buffer` の最後の持ち主なので、Arc をもう 1 本増やさずそのまま渡す。
    let buffer_cb = buffer;
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let event = match res {
                Ok(event) => event,
                // **黙って捨てないこと**（#385）。`notify` はここで監視が続けられなく
                // なったことを言う（`MaxFilesWatch`、root の消滅や改名のあとの
                // `ReadDirectoryChangesW`）。捨てると WSL 側で直したのと同じ「静かに
                // 止まる」が Windows / macOS に残る。理由は当てられないので `Other`。
                Err(e) => {
                    report_watch_failure(
                        &failed_app,
                        &failed_id,
                        &failed_flag,
                        WatchFailReason::Other,
                        e.to_string(),
                    );
                    return;
                }
            };
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
                let parent = path.parent().unwrap_or(path).to_string_lossy().into_owned();
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
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(root_path.as_path(), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    state.handles.lock().unwrap().insert(
        id,
        WatcherHandle::Native {
            _watcher: watcher,
            stop_flag,
        },
    );

    Ok(())
}

fn start_wsl_watcher(
    watcher_id: &str,
    shell: &ShellConfig,
    root: &str,
    app: AppHandle,
    state: &State<'_, WatcherState>,
) -> Result<(), String> {
    let id = watcher_id.to_owned();
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
    cmd.args([
        "-d",
        distro,
        "-e",
        "inotifywait",
        "-m",
        "-r",
        "-e",
        "create,delete,modify,move",
        "--format",
        "%w%f|%e",
        "--exclude",
        &exclude_regex,
        "--",
        root,
    ]);

    cmd.stdout(std::process::Stdio::piped());
    // **stderr を捨てないこと**（#385）。`inotifywait` が無い・監視の上限に当たった、の
    // どちらもここにしか出ず、spawn は成功するので他に知る手段がない。
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start the WSL watcher: {e}"))?;

    let child_pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture inotifywait stdout".to_owned())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture inotifywait stderr".to_owned())?;
    let stderr_thread = std::thread::spawn(move || crate::types::drain_stderr(stderr));

    let buffer = Arc::new(Mutex::new(EventBuffer::new()));

    spawn_flush_thread(buffer.clone(), stop_flag.clone(), app.clone(), id.clone());

    let failed_id = id.clone();
    let failed_flag = stop_flag.clone();
    std::thread::spawn(move || {
        // 1 行ずつ、バッファを使い回して読む（#382）。ビルド 1 回で数千行が流れるうえ、
        // 区切りを持たない行はその場で捨てる。
        crate::types::for_each_line(stdout, |line| {
            // **`splitn(2).collect::<Vec<_>>()` にしないこと。** 1 行につきヒープ確保が
            // 1 回増えて、行ごとの `String` を消した意味が半分になる。
            let Some((path, event)) = line.split_once('|') else {
                return true;
            };
            let file_path = path.to_owned();
            let event_str = event.to_uppercase();

            let kind = if event_str.contains("CREATE") || event_str.contains("MOVED_TO") {
                ChangeKind::Create
            } else if event_str.contains("DELETE") || event_str.contains("MOVED_FROM") {
                ChangeKind::Delete
            } else if event_str.contains("MODIFY") {
                ChangeKind::Modify
            } else {
                return true;
            };

            let parent = if let Some(pos) = file_path.rfind('/') {
                file_path[..pos].to_string()
            } else {
                file_path.clone()
            };

            let mut buf = buffer.lock().unwrap();
            buf.add(
                parent,
                FsChangeEntry {
                    path: file_path,
                    kind,
                },
            );
            true
        });
        let _ = child.wait();
        let detail = stderr_thread.join().unwrap_or_default();
        let reason = classify_watch_failure(&detail);
        report_watch_failure(&app, &failed_id, &failed_flag, reason, detail);
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

#[cfg(test)]
mod tests {
    use super::{classify_watch_failure, WatchFailReason};

    /// 実測した文言（Windows + WSL、2026-09-21）に当たること。
    #[test]
    fn tells_the_failures_apart() {
        // `wsl.exe` の relay が出す形。コマンド名まで見るので、別のコマンドでは当たらない。
        let missing = "<3>WSL (1 - Relay) ERROR: CreateProcessCommon:818:             execvpe(inotifywait) failed: No such file or directory";
        assert_eq!(
            classify_watch_failure(missing),
            WatchFailReason::MissingTool
        );
        assert_eq!(
            classify_watch_failure("sh: 1: inotifywait: not found"),
            WatchFailReason::MissingTool
        );

        let limit = "Failed to watch /home/k/x; upper limit on inotify watches reached!";
        assert_eq!(classify_watch_failure(limit), WatchFailReason::WatchLimit);

        // 当てられないものは `Other`（detail をそのまま見せる側へ落とす）。
        assert_eq!(classify_watch_failure(""), WatchFailReason::Other);
        assert_eq!(
            classify_watch_failure("Setting up watches. Beware:"),
            WatchFailReason::Other
        );
    }

    /// TS の union と i18n のキーがこの綴りを前提にしている（`useFsWatcher.ts`）。
    #[test]
    fn reason_serializes_as_camel_case() {
        let json = serde_json::to_string(&WatchFailReason::MissingTool).unwrap();
        assert_eq!(json, "\"missingTool\"");
        let json = serde_json::to_string(&WatchFailReason::WatchLimit).unwrap();
        assert_eq!(json, "\"watchLimit\"");
    }
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
