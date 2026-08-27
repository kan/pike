//! Tauri commands for the unified agent API.
//!
//! These commands replace the codex_* commands with agent_* equivalents that
//! work with any AgentRuntime implementation. The frontend calls these through
//! `invoke('agent_*', { ... })`.
//!
//! All session-dependent commands take a `tab_id` parameter to identify the
//! agent session. This allows multiple agent tabs per window.

use std::sync::Arc;

use super::acp_runtime::{ACPRuntime, AcpAgentConfig, WSL_EXTRA_PATH};
use super::codex_runtime::CodexAppServerRuntime;
use super::state::{AgentSession, AgentState};
use super::types::{
    AgentAuthState, AgentCapabilities, ApprovalDecision, EditorContext, ModelInfo, SessionConfig,
};
use crate::types::{ShellConfig, UNIX_NPM_PREFIX};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn get_runtime(
    tab_id: &str,
    state: &AgentState,
) -> Result<Arc<dyn super::types::AgentRuntime>, String> {
    state.get_runtime(tab_id).await
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

        // Use bash -c (not -lc) to avoid .profile hang in non-tty contexts.
        // POSIX 側は `-g` の既定 prefix に書き込み権限が要ることがあるので、WSL・
        // ローカル Unix とも `UNIX_NPM_PREFIX` へ入れる（sudo を要求しない）。違いは
        // PATH の前置だけで、WSL は distro の素の PATH から始まるため必要、ローカルは
        // `augment_process_path` がプロセス側で広げてあるため不要。
        let mut cmd = match &shell_clone {
            s if s.is_posix() => {
                let path_prefix = match s {
                    ShellConfig::Wsl { .. } => format!("PATH=\"{WSL_EXTRA_PATH}:$PATH\" "),
                    _ => String::new(),
                };
                let line = format!(
                    "{path_prefix}npm install -g --prefix \"{UNIX_NPM_PREFIX}\" {ACP_NPM_PACKAGE}"
                );
                // WSL は `command` が wsl.exe 越しに bash を起こす。ローカル Unix は
                // ホスト自身なので `sh` をそのまま起動する。
                let program = if matches!(s, ShellConfig::Wsl { .. }) { "bash" } else { "sh" };
                shell_clone.command(program, &["-c", &line])
            }
            // On Windows, `npm` is a .cmd batch file — must run via `cmd /C`.
            _ => {
                let mut c = crate::types::silent_command("cmd.exe");
                c.args(["/C", "npm", "install", "-g", ACP_NPM_PACKAGE]);
                c
            }
        };
        let child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
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
/// Check if the ACP binary exists. Uses `which`/`where` instead of `--version`
/// because claude-agent-acp is a JSON-RPC server that hangs on `--version`.
pub fn check_acp_available(config: &AcpAgentConfig, shell: &ShellConfig) -> Result<String, String> {
    match shell {
        // POSIX 側は `run_stdout_with_user_path` に任せる。WSL は `WSL_EXTRA_PATH` を
        // 前置した `bash -c`、ローカル Unix はそのまま（PATH は `augment_process_path`
        // が起動時に広げてある）と、ちょうどこの 2 通りを既に振り分けている。手で
        // `bash -c` を組むと PATH 前置の方針が 2 箇所に散り、`bash_quote` も外れる。
        s if s.is_posix() => Ok(shell
            .run_stdout_with_user_path("which", &[&config.command])?
            .trim()
            .to_string()),
        _ => {
            let mut cmd = crate::types::silent_command("cmd.exe");
            cmd.args(["/C", "where", &config.command]);
            let output = cmd
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| format!("{} not found: {e}", config.command))?;
            if !output.status.success() {
                return Err(format!("{} not found", config.command));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
    }
}

/// Check if an agent is available in the given shell environment.
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

/// Start an agent session for a specific tab.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_start_session(
    tab_id: String,
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
            let rt = CodexAppServerRuntime::connect(
                shell, &cwd, app, window_label.clone(), tab_id.clone(),
            )
            .await?;
            Arc::new(rt)
        }
        "claude-code" => {
            // このタブの claude は、ターミナルで起動する claude と同じアカウントで
            // 動かないと困る（#225）。`CLAUDE_CONFIG_DIR` を明示的に渡す: ACP エージェントは
            // `bash -c`（非対話・非ログイン）で起動するので、ユーザーが `.bashrc` や
            // `.envrc` で設定していても、そのままでは既定の `~/.claude` を使ってしまう。
            let mut acp_config = AcpAgentConfig::default();
            let probe = (shell.clone(), cwd.clone());
            let config_dir = tokio::task::spawn_blocking(move || {
                crate::claude_usage::config::resolve(&probe.0, &probe.1).native_override
            })
            .await
            .ok()
            .flatten();
            if let Some(dir) = config_dir {
                acp_config.env.insert("CLAUDE_CONFIG_DIR".to_string(), dir);
            }
            let rt = ACPRuntime::connect(
                shell, &cwd, acp_config, app, window_label.clone(), tab_id.clone(),
            )
            .await?;
            Arc::new(rt)
        }
        _ => return Err(format!("Unknown agent type: {agent_type}")),
    };

    let tid = runtime.start_session(config).await?;

    state
        .insert(
            tab_id,
            AgentSession {
                runtime,
                agent_type,
                window_label,
            },
        )
        .await;

    Ok(tid)
}

/// Get the capabilities of the agent for a specific tab.
#[tauri::command]
pub async fn agent_capabilities(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<AgentCapabilities, String> {
    let rt = get_runtime(&tab_id, &state).await?;
    Ok(rt.capabilities())
}

/// Submit a user prompt to the agent.
#[tauri::command]
pub async fn agent_submit_turn(
    tab_id: String,
    prompt: String,
    editor_context: Option<EditorContext>,
    model: Option<String>,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    log::debug!("[agent] agent_submit_turn tab={tab_id}: prompt={}", &prompt[..prompt.len().min(80)]);
    let rt = get_runtime(&tab_id, &state).await?;
    rt.submit_turn(prompt, editor_context, model).await
}

/// Interrupt the current turn.
#[tauri::command]
pub async fn agent_interrupt_turn(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.interrupt_turn().await
}

/// Roll back the last turn.
#[tauri::command]
pub async fn agent_rollback_turn(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.rollback_turn().await
}

/// Compact the conversation context.
#[tauri::command]
pub async fn agent_compact(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.compact().await
}

/// Respond to an approval request.
#[tauri::command]
pub async fn agent_respond_approval(
    tab_id: String,
    request_id: serde_json::Value,
    decision: ApprovalDecision,
    option_id: Option<String>,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.respond_approval(request_id, decision, option_id).await
}

/// Get authentication status.
#[tauri::command]
pub async fn agent_auth_status(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<AgentAuthState, String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.auth_status().await
}

/// Start the auth login flow.
#[tauri::command]
pub async fn agent_auth_login(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.auth_login().await
}

/// Log out.
#[tauri::command]
pub async fn agent_auth_logout(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.auth_logout().await
}

/// List available models.
#[tauri::command]
pub async fn agent_list_models(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<Vec<ModelInfo>, String> {
    let rt = get_runtime(&tab_id, &state).await?;
    rt.list_models().await
}

/// Disconnect the agent session for a specific tab.
#[tauri::command]
pub async fn agent_disconnect(
    tab_id: String,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    state.remove(&tab_id).await;
    log::info!("[agent] Disconnected tab {tab_id}");
    Ok(())
}
