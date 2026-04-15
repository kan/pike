//! `AgentRuntime` implementation for the Agent Client Protocol (ACP).
//!
//! ACP uses JSON-RPC 2.0 over NDJSON (newline-delimited JSON) on stdio.
//! The agent process (e.g. `claude-agent-acp`) is spawned as a child process.
//!
//! Key ACP methods:
//! - `initialize` — protocol handshake
//! - `session/new` — create a conversation session
//! - `session/prompt` — submit a user turn
//! - `session/cancel` — cancel an in-progress turn
//! - `session/load` — restore a previous session (optional)
//! - `session/set_session_mode` — switch modes (optional)
//!
//! ACP notifications (agent → client):
//! - `session/update` — streaming updates (messages, tool calls, etc.)
//!
//! ACP requests (agent → client, require response):
//! - `session/request_permission` — permission for tool use

use std::sync::Arc;

use serde_json::json;
use tokio::sync::Mutex;

use super::codex_runtime::TauriEventEmitter;
use super::types::*;
use crate::codex::protocol::client::AppServerClient;
use crate::codex::protocol::messages::RequestId;
use crate::codex::runtime::{self, CodexRuntime};
use crate::types::ShellConfig;

// ---------------------------------------------------------------------------
// ACP agent configuration
// ---------------------------------------------------------------------------

/// Configuration for an ACP agent binary.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentConfig {
    /// Human-readable name (e.g. "Claude Code").
    pub name: String,
    /// Command to run (e.g. "claude-agent-acp" or full path).
    pub command: String,
    /// Additional command-line arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Additional environment variables.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

impl Default for AcpAgentConfig {
    fn default() -> Self {
        Self {
            name: "Claude Code".to_string(),
            command: "claude-agent-acp".to_string(),
            args: vec![],
            env: std::collections::HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// ACP process runtime (environment abstraction)
// ---------------------------------------------------------------------------

/// Environment abstraction for spawning ACP agent processes.
/// Analogous to `CodexRuntime` but for ACP agents.
struct AcpProcessRuntime {
    codex_runtime: Arc<dyn CodexRuntime>,
    config: AcpAgentConfig,
}

impl AcpProcessRuntime {
    fn spawn(&self, working_dir: &str) -> Result<tokio::process::Child, String> {
        use std::process::Stdio;
        use tokio::process::Command;

        let linux_dir = self.codex_runtime.translate_path_to_codex(working_dir);

        // Determine if we need to go through WSL
        let env_name = self.codex_runtime.display_environment_name();
        let is_wsl = env_name.contains("WSL");

        let mut cmd = if is_wsl {
            let distro = env_name.split(" (WSL)").next().unwrap_or("Ubuntu");
            let mut c = Command::new("wsl.exe");
            c.args([
                "--cd",
                &linux_dir,
                "-d",
                distro,
                "--",
                &self.config.command,
            ]);
            for arg in &self.config.args {
                c.arg(arg);
            }
            c
        } else {
            let mut c = Command::new(&self.config.command);
            for arg in &self.config.args {
                c.arg(arg);
            }
            c.current_dir(working_dir);
            c
        };

        // Set environment variables
        for (key, val) in &self.config.env {
            cmd.env(key, val);
        }

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Windows: no console window, isolated process group
        #[cfg(windows)]
        cmd.creation_flags(0x08000000 | 0x00000200);

        cmd.spawn()
            .map_err(|e| format!("Failed to spawn {}: {e}", self.config.command))
    }
}

// ---------------------------------------------------------------------------
// ACPRuntime
// ---------------------------------------------------------------------------

/// ACP-based agent runtime. Communicates with `claude-agent-acp` (or any
/// ACP-compatible agent) via JSON-RPC over stdio.
///
/// Reuses `AppServerClient` from the Codex protocol module for the JSON-RPC
/// transport layer — both protocols use NDJSON over stdio with the same
/// message framing.
pub struct ACPRuntime {
    config: AcpAgentConfig,
    codex_runtime: Arc<dyn CodexRuntime>,
    client: Arc<AppServerClient>,
    session_id: Mutex<Option<String>>,
    emitter: Arc<TauriEventEmitter>,
}

impl ACPRuntime {
    /// Connect to an ACP agent process and perform the initialize handshake.
    pub async fn connect(
        shell: ShellConfig,
        cwd: &str,
        agent_config: AcpAgentConfig,
        app_handle: tauri::AppHandle,
        window_label: String,
    ) -> Result<Self, String> {
        let codex_runtime: Arc<dyn CodexRuntime> =
            Arc::from(runtime::runtime_for_shell(&shell));

        let process_rt = AcpProcessRuntime {
            codex_runtime: codex_runtime.clone(),
            config: agent_config.clone(),
        };

        // Spawn the ACP agent process.
        // We use AppServerClient::connect_with_child which handles the
        // JSON-RPC transport setup. However, AppServerClient expects to
        // spawn via CodexRuntime, so we use a custom adapter.
        let client = Arc::new(
            connect_acp_client(&process_rt, cwd, &codex_runtime).await?,
        );

        let emitter = Arc::new(TauriEventEmitter::new(
            app_handle,
            window_label.clone(),
        ));

        log::info!(
            "[acp-agent] Connected {} for window {window_label} at {cwd}",
            agent_config.name
        );

        Ok(Self {
            config: agent_config,
            codex_runtime,
            client,
            session_id: Mutex::new(None),
            emitter,
        })
    }

    /// Start event forwarding (notifications + permission requests).
    async fn start_event_forwarding(&self) {
        self.start_notification_bridge().await;
        self.start_permission_bridge().await;
    }

    /// Bridge ACP `session/update` notifications to `AgentEvent`s.
    async fn start_notification_bridge(&self) {
        let rx = self.client.take_notifications().await;
        let Some(mut rx) = rx else {
            log::warn!("[acp-agent] Notification receiver already taken");
            return;
        };
        let emitter = self.emitter.clone();

        tokio::spawn(async move {
            while let Some(notif) = rx.recv().await {
                let events = acp_notification_to_agent_events(&notif.method, &notif.params);
                for event in events {
                    emitter.emit(event);
                }
            }
            log::info!("[acp-agent] Notification channel closed");
            emitter.emit(AgentEvent::Disconnected {
                reason: "channel_closed".to_string(),
            });
        });
    }

    /// Bridge ACP `session/request_permission` to `AgentEvent`s.
    async fn start_permission_bridge(&self) {
        let rx = self.client.take_server_requests().await;
        let Some(mut rx) = rx else {
            log::warn!("[acp-agent] Server request receiver already taken");
            return;
        };
        let client = self.client.clone();
        let emitter = self.emitter.clone();

        tokio::spawn(async move {
            while let Some(req) = rx.recv().await {
                let request_id =
                    serde_json::to_value(&req.id).unwrap_or(serde_json::Value::Null);

                match req.method.as_str() {
                    "session/request_permission" => {
                        let tool_name = req
                            .params
                            .get("tool_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let tool_arguments = req
                            .params
                            .get("tool_arguments")
                            .cloned()
                            .unwrap_or(json!({}));
                        let options = req
                            .params
                            .get("options")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();

                        // Map to command/file approval if recognizable
                        let event = match tool_name.as_str() {
                            "terminal" | "bash" | "shell" | "execute_command" => {
                                let command = tool_arguments
                                    .get("command")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                let cwd = tool_arguments
                                    .get("cwd")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                AgentEvent::ApprovalCommandRequest {
                                    request_id,
                                    item_id: req
                                        .params
                                        .get("tool_call_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    command,
                                    cwd,
                                    payload: req.params.clone(),
                                }
                            }
                            "write_text_file" | "fs/write_text_file"
                            | "edit" | "write" => {
                                let file_path = tool_arguments
                                    .get("path")
                                    .or_else(|| tool_arguments.get("file_path"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                AgentEvent::ApprovalFileRequest {
                                    request_id,
                                    item_id: req
                                        .params
                                        .get("tool_call_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    file_path,
                                    reason: None,
                                    payload: req.params.clone(),
                                }
                            }
                            _ => {
                                AgentEvent::ApprovalGenericRequest {
                                    request_id,
                                    tool_name,
                                    tool_arguments,
                                    options,
                                    payload: req.params.clone(),
                                }
                            }
                        };
                        emitter.emit(event);
                    }
                    _ => {
                        log::warn!(
                            "[acp-agent] Unknown server request: {} — rejecting",
                            req.method
                        );
                        let _ = client
                            .respond_to_server(req.id, json!("reject"))
                            .await;
                    }
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// AgentRuntime implementation
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
impl AgentRuntime for ACPRuntime {
    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            display_name: self.config.name.clone(),
            supports_model_selection: false, // ACP model switching is via set_session_mode
            supports_session_resume: true,   // ACP supports session/load
            supports_rollback: false,        // ACP doesn't have rollback
            supports_compact: false,         // ACP doesn't have compact
            supports_sandbox_config: false,  // Sandbox is agent-internal
            supports_approval_config: false, // Approval is agent-internal
            supports_auth_flow: false,       // Auth is handled by the agent process
        }
    }

    async fn check_available(&self) -> Result<String, String> {
        // Try to get version by running `<command> --version`
        let is_wsl = self.codex_runtime.display_environment_name().contains("WSL");
        if is_wsl {
            let distro = self
                .codex_runtime
                .display_environment_name()
                .split(" (WSL)")
                .next()
                .unwrap_or("Ubuntu")
                .to_string();
            let shell = ShellConfig::Wsl { distro };
            let output = shell.run_stdout(&self.config.command, &["--version"])?;
            Ok(output.trim().to_string())
        } else {
            let mut cmd = crate::types::silent_command(&self.config.command);
            cmd.arg("--version");
            let output = cmd
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| format!("Failed to run {} --version: {e}", self.config.command))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("{} --version failed: {stderr}", self.config.command));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
    }

    async fn start_session(&self, config: SessionConfig) -> Result<String, String> {
        let linux_cwd = self.codex_runtime.translate_path_to_codex(&config.cwd);

        // Try to load an existing session if resume_session_id is provided
        if let Some(ref existing_id) = config.resume_session_id {
            match self
                .client
                .request::<_, serde_json::Value>(
                    "session/load",
                    &json!({ "session_id": existing_id }),
                )
                .await
            {
                Ok(_) => {
                    *self.session_id.lock().await = Some(existing_id.clone());
                    self.start_event_forwarding().await;
                    log::info!("[acp-agent] Session loaded: {existing_id}");
                    return Ok(existing_id.clone());
                }
                Err(e) => {
                    log::warn!(
                        "[acp-agent] Failed to load session {existing_id}: {e}, creating new"
                    );
                }
            }
        }

        // Create a new session
        let resp: serde_json::Value = self
            .client
            .request(
                "session/new",
                &json!({
                    "working_directory": linux_cwd,
                }),
            )
            .await?;

        let session_id = resp
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("session/new response missing session_id: {resp}"))?
            .to_string();

        *self.session_id.lock().await = Some(session_id.clone());
        self.start_event_forwarding().await;
        log::info!("[acp-agent] Session created: {session_id}");
        Ok(session_id)
    }

    async fn submit_turn(
        &self,
        prompt: String,
        editor_context: Option<EditorContext>,
        _model: Option<String>,
    ) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or("No active ACP session")?;

        // Build prompt with editor context prefix (same as Codex)
        let full_prompt = if let Some(ctx) = editor_context {
            let codex_path = self.codex_runtime.translate_path_to_codex(&ctx.path);
            let mut header = format!("[Pike context]\nCurrent file: {codex_path}");
            if let Some(line) = ctx.line {
                header.push_str(&format!("\nCursor: line {line}"));
                if let Some(col) = ctx.col {
                    header.push_str(&format!(", col {col}"));
                }
            }
            if let (Some(sel_start), Some(sel_end)) = (ctx.selection_start, ctx.selection_end) {
                if sel_start != sel_end {
                    header.push_str(&format!("\nSelection: lines {sel_start}-{sel_end}"));
                }
            }
            format!("{header}\n\n[User prompt]\n{prompt}")
        } else {
            prompt
        };

        let _: serde_json::Value = self
            .client
            .request(
                "session/prompt",
                &json!({
                    "session_id": session_id,
                    "content": [{ "type": "text", "text": full_prompt }],
                }),
            )
            .await?;

        Ok(())
    }

    async fn interrupt_turn(&self) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or("No active ACP session")?;

        let _: serde_json::Value = self
            .client
            .request("session/cancel", &json!({ "session_id": session_id }))
            .await?;

        Ok(())
    }

    async fn rollback_turn(&self) -> Result<(), String> {
        Err("Rollback not supported by ACP".to_string())
    }

    async fn compact(&self) -> Result<(), String> {
        Err("Compact not supported by ACP".to_string())
    }

    async fn respond_approval(
        &self,
        request_id: serde_json::Value,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let id: RequestId =
            serde_json::from_value(request_id).map_err(|e| format!("Invalid request ID: {e}"))?;

        let response = match decision {
            ApprovalDecision::Allow => json!("allow_once"),
            ApprovalDecision::AllowAlways => json!("allow_always"),
            ApprovalDecision::Reject => json!("reject"),
            ApprovalDecision::Cancel => json!("reject"),
        };

        self.client.respond_to_server(id, response).await
    }

    async fn auth_status(&self) -> Result<AgentAuthState, String> {
        // ACP agents handle auth internally. If we can communicate with the
        // agent, assume authenticated.
        Ok(AgentAuthState::Authenticated {
            mode: "external".to_string(),
            plan_type: None,
            email: None,
        })
    }

    async fn auth_login(&self) -> Result<(), String> {
        // Auth is handled by the agent process itself (e.g. `/login` command)
        Ok(())
    }

    async fn auth_logout(&self) -> Result<(), String> {
        Ok(())
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, String> {
        // ACP doesn't expose model listing in the core spec
        Ok(vec![])
    }

    async fn shutdown(&self) -> Result<(), String> {
        self.client.shutdown().await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// ACP client connection
// ---------------------------------------------------------------------------

/// Connect to an ACP agent process using the same JSON-RPC transport as Codex.
///
/// The `AppServerClient` handles the NDJSON framing — we just need to adapt
/// the initialize handshake to use ACP's protocol version negotiation.
async fn connect_acp_client(
    process_rt: &AcpProcessRuntime,
    working_dir: &str,
    _codex_runtime: &Arc<dyn CodexRuntime>,
) -> Result<AppServerClient, String> {
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::{mpsc, oneshot, Mutex};

    use crate::codex::protocol::client::{ServerNotification, ServerRequest};
    use crate::codex::protocol::messages::*;

    log::info!(
        "[acp-agent] Spawning {} for working_dir={working_dir}",
        process_rt.config.command
    );
    let mut child = process_rt.spawn(working_dir)?;
    log::info!(
        "[acp-agent] Process spawned (pid={:?})",
        child.id()
    );

    let stdin = child.stdin.take().ok_or("Failed to get child stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get child stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get child stderr")?;

    // Wrap in Job Object on Windows
    #[cfg(windows)]
    {
        // Use the same Job Object wrapping as Codex for process cleanup
        if let Err(e) = assign_to_job_object_acp(&child) {
            log::warn!("[acp-agent] Failed to assign to Job Object (non-fatal): {e}");
        }
    }

    type PendingMap = HashMap<u64, oneshot::Sender<Result<serde_json::Value, JsonRpcErrorData>>>;
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
    let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
    let (notification_tx, notification_rx) = mpsc::unbounded_channel::<ServerNotification>();
    let (server_request_tx, server_request_rx) = mpsc::channel::<ServerRequest>(32);

    let mut task_handles = Vec::new();

    // Writer task
    let writer_handle = tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = stdin_rx.recv().await {
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                log::error!("[acp-writer] Failed to write: {e}");
                break;
            }
            if let Err(e) = stdin.write_all(b"\n").await {
                log::error!("[acp-writer] Failed to write newline: {e}");
                break;
            }
            if let Err(e) = stdin.flush().await {
                log::error!("[acp-writer] Failed to flush: {e}");
                break;
            }
        }
        log::debug!("[acp-writer] Writer task exiting");
    });
    task_handles.push(writer_handle);

    // Reader task
    let pending_clone = pending.clone();
    let reader_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let line = line.trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if line.len() > 500 {
                        let truncate_at = line
                            .char_indices()
                            .map(|(i, _)| i)
                            .take_while(|&i| i <= 200)
                            .last()
                            .unwrap_or(0);
                        log::debug!(
                            "[acp-reader] <- {}… ({} bytes)",
                            &line[..truncate_at],
                            line.len()
                        );
                    } else {
                        log::debug!("[acp-reader] <- {line}");
                    }
                    let value: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(e) => {
                            log::warn!("[acp-reader] Failed to parse JSON: {e}");
                            continue;
                        }
                    };
                    match parse_incoming(value) {
                        Ok(IncomingMessage::Response { id, result }) => {
                            if let RequestId::Num(n) = id {
                                let mut map = pending_clone.lock().await;
                                if let Some(tx) = map.remove(&n) {
                                    let _ = tx.send(Ok(result));
                                }
                            }
                        }
                        Ok(IncomingMessage::Error { id, error }) => {
                            log::warn!("[acp-reader] Error response: {error}");
                            if let RequestId::Num(n) = id {
                                let mut map = pending_clone.lock().await;
                                if let Some(tx) = map.remove(&n) {
                                    let _ = tx.send(Err(error));
                                }
                            }
                        }
                        Ok(IncomingMessage::ServerRequest { id, method, params }) => {
                            log::debug!("[acp-reader] Server request: {method} (id={id:?})");
                            if let Err(e) = server_request_tx
                                .send(ServerRequest { id, method, params })
                                .await
                            {
                                log::error!(
                                    "[acp-reader] Failed to forward server request: {e}"
                                );
                            }
                        }
                        Ok(IncomingMessage::Notification { method, params }) => {
                            log::debug!("[acp-reader] Notification: {method}");
                            if let Err(e) =
                                notification_tx.send(ServerNotification { method: method.clone(), params })
                            {
                                log::warn!(
                                    "[acp-reader] No subscribers for {method}: {e}"
                                );
                            }
                        }
                        Err(e) => {
                            log::warn!("[acp-reader] Unrecognized message: {e}");
                        }
                    }
                }
                Ok(None) => {
                    log::info!("[acp-reader] Stdout EOF — agent process ended");
                    break;
                }
                Err(e) => {
                    log::error!("[acp-reader] Error reading stdout: {e}");
                    break;
                }
            }
        }
    });
    task_handles.push(reader_handle);

    // Stderr task
    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    log::debug!("[acp-stderr] {line}");
                }
                Ok(None) => break,
                Err(e) => {
                    log::error!("[acp-stderr] Error reading: {e}");
                    break;
                }
            }
        }
    });
    task_handles.push(stderr_handle);

    // Build client manually with the channels
    let client = AppServerClient::from_parts(
        stdin_tx,
        pending,
        notification_rx,
        server_request_rx,
        child,
        task_handles,
    );

    // ACP initialize handshake
    let init_params = json!({
        "client_info": {
            "name": "pike",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "protocol_version": 1,
    });

    log::info!("[acp-agent] Sending initialize request...");
    let result: serde_json::Value = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.request("initialize", &init_params),
    )
    .await
    .map_err(|_| {
        "ACP initialize timed out after 30s — is the agent binary installed?".to_string()
    })??;

    log::info!("[acp-agent] Initialize complete: {result}");

    // Send initialized notification
    client
        .notify("initialized", &serde_json::Value::Null)
        .await?;

    Ok(client)
}

/// Assign an ACP child process to a Windows Job Object for cleanup.
#[cfg(windows)]
fn assign_to_job_object_acp(child: &tokio::process::Child) -> Result<(), String> {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::*;

    static JOB: OnceLock<isize> = OnceLock::new();

    unsafe {
        let job_raw = JOB.get_or_init(|| {
            let job = match CreateJobObjectW(None, None) {
                Ok(h) => h,
                Err(e) => {
                    log::error!("[acp-agent] CreateJobObject failed: {e}");
                    return 0;
                }
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            if let Err(e) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                log::error!("[acp-agent] SetInformationJobObject failed: {e}");
                return 0;
            }
            job.0 as isize
        });

        if *job_raw == 0 {
            return Err("Job Object not available".to_string());
        }

        let job = HANDLE(*job_raw as *mut std::ffi::c_void);
        let raw = child.raw_handle().ok_or("Failed to get child raw handle")?;
        AssignProcessToJobObject(job, HANDLE(raw))
            .map_err(|e| format!("AssignProcessToJobObject failed: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ACP notification → AgentEvent conversion
// ---------------------------------------------------------------------------

/// Convert ACP notifications to `AgentEvent`s.
/// A single ACP `session/update` can contain multiple update items.
fn acp_notification_to_agent_events(
    method: &str,
    params: &serde_json::Value,
) -> Vec<AgentEvent> {
    match method {
        "session/update" => parse_session_update(params),
        _ => {
            log::debug!("[acp-agent] Unhandled notification: {method}");
            vec![]
        }
    }
}

/// Parse an ACP `session/update` notification into one or more `AgentEvent`s.
fn parse_session_update(params: &serde_json::Value) -> Vec<AgentEvent> {
    let mut events = Vec::new();

    let update = match params.get("update").or(Some(params)) {
        Some(u) => u,
        None => return events,
    };

    let update_type = update
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match update_type {
        // Agent message chunk (streaming text)
        "message" => {
            if let Some(content) = update.get("content").and_then(|v| v.as_str()) {
                events.push(AgentEvent::MessageDelta {
                    delta: content.to_string(),
                    item_id: update
                        .get("message_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
            // Check for role to detect turn boundaries
            if let Some("assistant") = update.get("role").and_then(|v| v.as_str()) {
                if update.get("stop_reason").is_some() {
                    events.push(AgentEvent::TurnCompleted);
                }
            }
        }

        // Thought/reasoning chunk
        "thought" | "thinking" => {
            let summary = update.get("content").and_then(|v| v.as_str()).map(|s| s.to_string());
            let item_id = update
                .get("thought_id")
                .or_else(|| update.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("thought")
                .to_string();
            events.push(AgentEvent::Reasoning {
                item_id,
                summary,
            });
        }

        // Tool call
        "tool_call" => {
            let tool_call_id = update
                .get("tool_call_id")
                .or_else(|| update.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_name = update
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending");

            match status {
                "pending" | "in_progress" => {
                    // Map tool name to item type
                    let item_type = match tool_name {
                        "bash" | "terminal" | "shell" | "execute_command" => {
                            "commandExecution"
                        }
                        "write_text_file" | "edit" | "write" => "fileChange",
                        _ => tool_name,
                    };
                    events.push(AgentEvent::ItemStarted {
                        item_type: item_type.to_string(),
                        item_id: tool_call_id,
                        data: update.clone(),
                    });
                }
                "completed" | "failed" => {
                    events.push(AgentEvent::ItemCompleted {
                        item_id: tool_call_id,
                        data: update.clone(),
                    });
                }
                _ => {}
            }
        }

        // Tool result
        "tool_result" => {
            let tool_call_id = update
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            events.push(AgentEvent::ItemCompleted {
                item_id: tool_call_id,
                data: update.clone(),
            });
        }

        // Plan update (map to reasoning)
        "plan" => {
            let summary = update.get("content").and_then(|v| v.as_str()).map(|s| s.to_string());
            events.push(AgentEvent::Reasoning {
                item_id: "plan".to_string(),
                summary,
            });
        }

        // Token usage
        "usage" | "token_usage" => {
            let input = update
                .get("input_tokens")
                .or_else(|| update.get("input"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output = update
                .get("output_tokens")
                .or_else(|| update.get("output"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cached_read = update
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64());
            let cached_write = update
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64());
            events.push(AgentEvent::TokenUsage {
                input,
                output,
                cached_read,
                cached_write,
            });
        }

        // Stop reason / turn end
        "stop" | "end" => {
            events.push(AgentEvent::TurnCompleted);
        }

        _ => {
            log::debug!("[acp-agent] Unknown session/update type: {update_type}");
        }
    }

    events
}
