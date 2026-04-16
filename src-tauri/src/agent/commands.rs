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

const ACP_NPM_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";

/// Install the ACP agent binary via npm.
/// Returns the installed version string on success.
#[tauri::command]
pub async fn agent_ensure_installed(
    agent_type: String,
    shell: ShellConfig,
) -> Result<String, String> {
    if agent_type != "claude-code" {
        return Err(format!("Auto-install not supported for agent type: {agent_type}"));
    }

    let acp_config = AcpAgentConfig::default();

    // First check if already installed
    let already = check_acp_available(&acp_config, &shell);
    if let Ok(ver) = already {
        return Ok(ver);
    }

    log::info!("[agent] Installing {ACP_NPM_PACKAGE} via npm for shell {shell:?}");

    // Run npm install -g with a long timeout (120s)
    let shell_clone = shell.clone();
    let version = tokio::task::spawn_blocking(move || {
        let timeout = std::time::Duration::from_secs(120);

        // On Windows, `npm` is a .cmd batch file — must run via `cmd /C`.
        // On WSL, ShellConfig::command dispatches through wsl.exe correctly.
        let child = match &shell_clone {
            ShellConfig::Wsl { .. } => shell_clone
                .command("npm", &["install", "-g", ACP_NPM_PACKAGE])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn(),
            _ => crate::types::silent_command("cmd.exe")
                .args(["/C", "npm", "install", "-g", ACP_NPM_PACKAGE])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn(),
        }
        .map_err(|e| format!("Failed to run npm: {e}. Is npm installed?"))?;

        let pid = child.id();
        let output = crate::types::wait_with_timeout(pid, timeout, "npm install", move || {
            child.wait_with_output()
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("npm install failed: {stderr}"));
        }

        log::info!("[agent] npm install succeeded, verifying...");

        // Verify installation by checking version
        check_acp_available(&AcpAgentConfig::default(), &shell_clone)
    })
    .await
    .map_err(|e| format!("Install task failed: {e}"))??;

    log::info!("[agent] {ACP_NPM_PACKAGE} installed: {version}");
    Ok(version)
}

/// Check if the ACP binary is available and return its version.
/// On Windows, npm-installed binaries are `.cmd` files, so we must run via `cmd /C`.
fn check_acp_available(config: &AcpAgentConfig, shell: &ShellConfig) -> Result<String, String> {
    match shell {
        ShellConfig::Wsl { .. } => shell.run_stdout(&config.command, &["--version"]),
        _ => {
            let mut cmd = crate::types::silent_command("cmd.exe");
            cmd.args(["/C", &config.command, "--version"]);
            let output = cmd
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| format!("{} not found: {e}", config.command))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("{} not found: {stderr}", config.command));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
    }
}

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
            check_acp_available(&acp_config, &shell)
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
    log::debug!("[agent] agent_submit_turn called: prompt={}", &prompt[..prompt.len().min(80)]);
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
