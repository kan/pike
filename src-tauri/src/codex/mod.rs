pub mod approval;
pub mod auth;
pub mod protocol;
pub mod runtime;
pub mod session;

use std::sync::Arc;

use crate::types::ShellConfig;
use runtime::CodexRuntime;

/// Global Codex state managed by Tauri.
/// Uses tokio::sync::Mutex because lock guards are held across await points.
/// The client is wrapped in Arc so it can be shared between state and session.
pub struct CodexState {
    pub client: Arc<tokio::sync::Mutex<Option<Arc<protocol::client::AppServerClient>>>>,
    pub runtime: Arc<tokio::sync::Mutex<Option<Arc<dyn CodexRuntime>>>>,
    pub session: Arc<tokio::sync::Mutex<Option<session::ThreadSession>>>,
}

impl Default for CodexState {
    fn default() -> Self {
        Self {
            client: Arc::new(tokio::sync::Mutex::new(None)),
            runtime: Arc::new(tokio::sync::Mutex::new(None)),
            session: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

/// Connect to the Codex app-server for the given shell environment and working directory.
#[tauri::command]
pub async fn codex_connect(
    shell: ShellConfig,
    cwd: String,
    _app: tauri::AppHandle,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    // Shut down existing client if any
    {
        let mut client_guard = state.client.lock().await;
        if let Some(old_client) = client_guard.take() {
            old_client.shutdown().await;
        }
    }

    let rt: Arc<dyn CodexRuntime> = Arc::from(runtime::runtime_for_shell(&shell));
    let client = protocol::client::AppServerClient::connect(rt.as_ref(), &cwd).await?;

    *state.runtime.lock().await = Some(rt.clone());
    *state.client.lock().await = Some(Arc::new(client));

    log::info!("[codex] Connected to app-server for {:?} at {cwd}", shell);
    Ok(())
}

/// Disconnect from the Codex app-server.
#[tauri::command]
pub async fn codex_disconnect(
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    *state.session.lock().await = None;
    {
        let mut client_guard = state.client.lock().await;
        if let Some(old_client) = client_guard.take() {
            old_client.shutdown().await;
        }
    }
    *state.runtime.lock().await = None;
    log::info!("[codex] Disconnected");
    Ok(())
}

/// Check if codex CLI is available in the given shell environment.
#[tauri::command]
pub async fn codex_check_available(shell: ShellConfig) -> Result<String, String> {
    let rt = runtime::runtime_for_shell(&shell);
    rt.codex_version()
}

/// Get current authentication status.
#[tauri::command]
pub async fn codex_auth_status(
    state: tauri::State<'_, CodexState>,
) -> Result<auth::AuthState, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Codex not connected")?;
    auth::check_auth_status(client).await
}

/// Start ChatGPT OAuth login flow.
#[tauri::command]
pub async fn codex_auth_login_chatgpt(
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let url = {
        let guard = state.client.lock().await;
        let client = guard.as_ref().ok_or("Codex not connected")?;
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

/// Cancel an in-progress login.
#[tauri::command]
pub async fn codex_auth_cancel_login(
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Codex not connected")?;
    auth::cancel_login(client).await
}

/// Log out of the current account.
#[tauri::command]
pub async fn codex_auth_logout(
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Codex not connected")?;
    auth::logout(client).await
}

/// Start a Codex session: connect, start/resume thread, begin forwarding events.
#[tauri::command]
pub async fn codex_start_session(
    shell: ShellConfig,
    cwd: String,
    thread_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, CodexState>,
) -> Result<String, String> {
    // Connect if not already connected
    {
        let guard = state.client.lock().await;
        if guard.is_none() {
            drop(guard);
            codex_connect(shell, cwd.clone(), app.clone(), state.clone()).await?;
        }
    }

    // Get Arc clone of client — client stays in state for auth commands
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Codex not connected")?.clone()
    };

    let rt = state
        .runtime
        .lock()
        .await
        .clone()
        .ok_or("Runtime not set")?;

    let sess = session::ThreadSession::new(client, rt, app);

    // Start or resume thread
    let tid = if let Some(existing_tid) = thread_id {
        match sess.resume_thread(&existing_tid).await {
            Ok(()) => existing_tid,
            Err(e) => {
                log::warn!("[codex] Failed to resume thread {existing_tid}: {e}, starting new");
                sess.start_thread(&cwd).await?
            }
        }
    } else {
        sess.start_thread(&cwd).await?
    };

    // Start notification/approval forwarding
    sess.start_notification_forwarder();
    sess.start_approval_handler().await;

    *state.session.lock().await = Some(sess);

    Ok(tid)
}

/// Submit a prompt to the active Codex session, optionally with editor context.
#[tauri::command]
pub async fn codex_submit_turn(
    prompt: String,
    editor_context: Option<session::EditorContext>,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    let sess = guard.as_ref().ok_or("No active Codex session")?;
    sess.submit_turn(prompt, editor_context).await
}

/// Interrupt the current Codex turn.
#[tauri::command]
pub async fn codex_interrupt_turn(
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    let sess = guard.as_ref().ok_or("No active Codex session")?;
    sess.interrupt_turn().await
}

/// Respond to an approval request from the Codex app-server.
#[tauri::command]
pub async fn codex_respond_approval(
    request_id: serde_json::Value,
    decision: approval::ApprovalDecision,
    state: tauri::State<'_, CodexState>,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    let sess = guard.as_ref().ok_or("No active Codex session")?;

    let id: protocol::messages::RequestId =
        serde_json::from_value(request_id).map_err(|e| format!("Invalid request ID: {e}"))?;

    sess.client
        .respond_to_server(id, decision.to_json())
        .await
}
