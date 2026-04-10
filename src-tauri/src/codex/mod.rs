pub mod approval;
pub mod auth;
pub mod protocol;
pub mod runtime;
pub mod session;

use std::collections::HashMap;
use std::sync::Arc;

use crate::types::ShellConfig;
use protocol::client::AppServerClient;
use runtime::CodexRuntime;

/// Per-window Codex session: client + runtime + thread session.
pub struct CodexSession {
    pub client: Arc<AppServerClient>,
    #[allow(dead_code)]
    pub runtime: Arc<dyn CodexRuntime>,
    pub thread_session: Option<session::ThreadSession>,
}

impl CodexSession {
    pub async fn shutdown(&self) {
        self.client.shutdown().await;
    }
}

/// Global Codex state: a map of window label → session.
/// Uses tokio::sync::Mutex because lock guards are held across await points.
pub struct CodexState {
    pub sessions: Arc<tokio::sync::Mutex<HashMap<String, CodexSession>>>,
}

impl Default for CodexState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Get client from a session map, or return an error.
fn get_client<'a>(
    sessions: &'a HashMap<String, CodexSession>,
    window_id: &str,
) -> Result<&'a Arc<AppServerClient>, String> {
    sessions
        .get(window_id)
        .map(|s| &s.client)
        .ok_or_else(|| "Codex not connected".to_string())
}

/// Get thread session from a session map, or return an error.
fn get_thread_session<'a>(
    sessions: &'a HashMap<String, CodexSession>,
    window_id: &str,
) -> Result<&'a session::ThreadSession, String> {
    sessions
        .get(window_id)
        .and_then(|s| s.thread_session.as_ref())
        .ok_or_else(|| "No active Codex session".to_string())
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

/// Check if codex CLI is available in the given shell environment.
#[tauri::command]
pub async fn codex_check_available(shell: ShellConfig) -> Result<String, String> {
    let rt = runtime::runtime_for_shell(&shell);
    rt.codex_version()
}

/// Start a Codex session for this window: connect, authenticate, start/resume thread.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn codex_start_session(
    shell: ShellConfig,
    cwd: String,
    thread_id: Option<String>,
    sandbox_mode: Option<String>,
    approval_policy: Option<String>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, CodexState>,
) -> Result<String, String> {
    let window_id = window.label().to_string();

    // Shut down existing session for this window if any
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(old) = sessions.remove(&window_id) {
            old.shutdown().await;
        }
    }

    // Connect
    let rt: Arc<dyn CodexRuntime> = Arc::from(runtime::runtime_for_shell(&shell));
    let client = Arc::new(AppServerClient::connect(rt.as_ref(), &cwd).await?);
    log::info!("[codex] Connected for window {window_id} at {cwd}");

    // Create thread session
    let sess = session::ThreadSession::new(
        client.clone(),
        rt.clone(),
        app,
        window_id.clone(),
    );

    // Start or resume thread
    let sandbox_ref = sandbox_mode.as_deref();
    let approval_ref = approval_policy.as_deref();
    let tid = if let Some(existing_tid) = thread_id {
        match sess.resume_thread(&existing_tid, &cwd).await {
            Ok(()) => existing_tid,
            Err(e) => {
                log::warn!("[codex] Failed to resume thread {existing_tid}: {e}, starting new");
                sess.start_thread(&cwd, sandbox_ref, approval_ref).await?
            }
        }
    } else {
        sess.start_thread(&cwd, sandbox_ref, approval_ref).await?
    };

    // Start event forwarding
    sess.start_notification_forwarder();
    sess.start_approval_handler().await;

    // Store session
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(
            window_id,
            CodexSession {
                client,
                runtime: rt,
                thread_session: Some(sess),
            },
        );
    }

    Ok(tid)
}

/// Disconnect the Codex session for this window.
#[tauri::command]
pub async fn codex_disconnect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let window_id = window.label();
    let mut sessions = state.sessions.lock().await;
    if let Some(old) = sessions.remove(window_id) {
        old.shutdown().await;
    }
    log::info!("[codex] Disconnected window {window_id}");
    Ok(())
}

/// Get current authentication status for this window's session.
#[tauri::command]
pub async fn codex_auth_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<auth::AuthState, String> {
    let sessions = state.sessions.lock().await;
    let client = get_client(&sessions, window.label())?;
    auth::check_auth_status(client).await
}

/// Start ChatGPT OAuth login flow.
#[tauri::command]
pub async fn codex_auth_login_chatgpt(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let url = {
        let sessions = state.sessions.lock().await;
        let client = get_client(&sessions, window.label())?;
        auth::start_chatgpt_login(client).await?
    };
    if let Some(url) = url {
        tokio::task::spawn_blocking(move || {
            crate::types::silent_command("explorer.exe")
                .arg(&url)
                .spawn()
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
        .map(|_| ())?;
    }
    Ok(())
}

/// Log out of the current account.
#[tauri::command]
pub async fn codex_auth_logout(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let client = get_client(&sessions, window.label())?;
    auth::logout(client).await
}

/// Submit a prompt to this window's Codex session.
#[tauri::command]
pub async fn codex_submit_turn(
    prompt: String,
    editor_context: Option<session::EditorContext>,
    model: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = get_thread_session(&sessions, window.label())?;
    sess.submit_turn(prompt, editor_context, model).await
}

/// List available models for this window's Codex session.
#[tauri::command]
pub async fn codex_model_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<Vec<session::ModelInfo>, String> {
    let sessions = state.sessions.lock().await;
    let sess = get_thread_session(&sessions, window.label())?;
    sess.list_models().await
}

/// Interrupt the current turn for this window's session.
#[tauri::command]
pub async fn codex_interrupt_turn(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = get_thread_session(&sessions, window.label())?;
    sess.interrupt_turn().await
}

/// Roll back the last turn for this window's session.
#[tauri::command]
pub async fn codex_rollback_turn(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = get_thread_session(&sessions, window.label())?;
    sess.rollback_turn().await
}

/// Compact the current thread's context.
#[tauri::command]
pub async fn codex_compact_thread(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = get_thread_session(&sessions, window.label())?;
    sess.compact_thread().await
}

/// Respond to an approval request for this window's session.
#[tauri::command]
pub async fn codex_respond_approval(
    request_id: serde_json::Value,
    decision: approval::ApprovalDecision,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = get_thread_session(&sessions, window.label())?;

    let id: protocol::messages::RequestId =
        serde_json::from_value(request_id).map_err(|e| format!("Invalid request ID: {e}"))?;

    sess.client
        .respond_to_server(id, decision.to_json())
        .await
}
