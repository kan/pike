//! Tauri commands for the unified agent API.
//!
//! These commands replace the codex_* commands with agent_* equivalents that
//! work with any AgentRuntime implementation. The frontend calls these through
//! `invoke('agent_*', { ... })`.

use std::sync::Arc;

use super::acp_runtime::{ACPRuntime, AcpAgentConfig};
use super::codex_runtime::CodexAppServerRuntime;
use super::state::{AgentSession, AgentState};
use super::types::{
    AgentAuthState, AgentCapabilities, ApprovalDecision, EditorContext, ModelInfo, SessionConfig,
};
use crate::types::ShellConfig;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn get_runtime(
    window: &tauri::WebviewWindow,
    state: &AgentState,
) -> Result<Arc<dyn super::types::AgentRuntime>, String> {
    state.get_runtime(window.label()).await
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Check if an agent is available in the given shell environment.
/// `agent_type`: "codex" or "claude-code".
#[tauri::command]
pub async fn agent_check_available(
    agent_type: String,
    shell: ShellConfig,
) -> Result<String, String> {
    match agent_type.as_str() {
        "codex" => {
            let rt = crate::codex::runtime::runtime_for_shell(&shell);
            rt.codex_version()
        }
        "claude-code" => {
            let acp_config = AcpAgentConfig::default();
            // Check if the binary exists by trying --version
            let is_wsl = matches!(shell, ShellConfig::Wsl { .. });
            if is_wsl {
                if let ShellConfig::Wsl { ref distro } = shell {
                    let wsl_shell = ShellConfig::Wsl { distro: distro.clone() };
                    wsl_shell.run_stdout(&acp_config.command, &["--version"])
                } else {
                    Err("Unexpected shell config".to_string())
                }
            } else {
                let mut cmd = crate::types::silent_command(&acp_config.command);
                cmd.arg("--version");
                let output = cmd
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .output()
                    .map_err(|e| format!("{} not found: {e}", acp_config.command))?;
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            }
        }
        _ => Err(format!("Unknown agent type: {agent_type}")),
    }
}

/// Start an agent session for this window.
/// `agent_type`: "codex" or "claude-code".
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_start_session(
    agent_type: String,
    shell: ShellConfig,
    cwd: String,
    session_id: Option<String>,
    sandbox_mode: Option<String>,
    approval_policy: Option<String>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentState>,
) -> Result<String, String> {
    let window_label = window.label().to_string();

    let config = SessionConfig {
        cwd: cwd.clone(),
        resume_session_id: session_id,
        sandbox_mode,
        approval_policy,
    };

    let runtime: Arc<dyn super::types::AgentRuntime> = match agent_type.as_str() {
        "codex" => {
            let rt = CodexAppServerRuntime::connect(shell, &cwd, app, window_label.clone()).await?;
            Arc::new(rt)
        }
        "claude-code" => {
            let acp_config = AcpAgentConfig::default();
            let rt = ACPRuntime::connect(shell, &cwd, acp_config, app, window_label.clone()).await?;
            Arc::new(rt)
        }
        _ => return Err(format!("Unknown agent type: {agent_type}")),
    };

    let tid = runtime.start_session(config).await?;

    state
        .insert(
            window_label,
            AgentSession {
                runtime,
                agent_type,
            },
        )
        .await;

    Ok(tid)
}

/// Get the capabilities of the active agent for this window.
#[tauri::command]
pub async fn agent_capabilities(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<AgentCapabilities, String> {
    let rt = get_runtime(&window, &state).await?;
    Ok(rt.capabilities())
}

/// Submit a user prompt to the active agent.
#[tauri::command]
pub async fn agent_submit_turn(
    prompt: String,
    editor_context: Option<EditorContext>,
    model: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&window, &state).await?;
    rt.submit_turn(prompt, editor_context, model).await
}

/// Interrupt the current turn.
#[tauri::command]
pub async fn agent_interrupt_turn(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&window, &state).await?;
    rt.interrupt_turn().await
}

/// Roll back the last turn.
#[tauri::command]
pub async fn agent_rollback_turn(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&window, &state).await?;
    rt.rollback_turn().await
}

/// Compact the conversation context.
#[tauri::command]
pub async fn agent_compact(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&window, &state).await?;
    rt.compact().await
}

/// Respond to an approval request.
#[tauri::command]
pub async fn agent_respond_approval(
    request_id: serde_json::Value,
    decision: ApprovalDecision,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&window, &state).await?;
    rt.respond_approval(request_id, decision).await
}

/// Get authentication status.
#[tauri::command]
pub async fn agent_auth_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<AgentAuthState, String> {
    let rt = get_runtime(&window, &state).await?;
    rt.auth_status().await
}

/// Start the auth login flow.
#[tauri::command]
pub async fn agent_auth_login(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&window, &state).await?;
    rt.auth_login().await
}

/// Log out.
#[tauri::command]
pub async fn agent_auth_logout(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&window, &state).await?;
    rt.auth_logout().await
}

/// List available models.
#[tauri::command]
pub async fn agent_list_models(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<Vec<ModelInfo>, String> {
    let rt = get_runtime(&window, &state).await?;
    rt.list_models().await
}

/// Disconnect the agent session for this window.
#[tauri::command]
pub async fn agent_disconnect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let window_id = window.label().to_string();
    state.remove(&window_id).await;
    log::info!("[agent] Disconnected window {window_id}");
    Ok(())
}
