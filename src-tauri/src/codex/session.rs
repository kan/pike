use std::sync::Arc;

use futures_util::FutureExt;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use serde::Serialize;

use crate::codex::protocol::client::AppServerClient;
use crate::codex::runtime::CodexRuntime;

/// Editor context passed from the frontend for prompt injection.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    pub path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub selection_start: Option<u32>,
    pub selection_end: Option<u32>,
}

/// Manages a Codex thread and its turns.
pub struct ThreadSession {
    pub client: Arc<AppServerClient>,
    pub runtime: Arc<dyn CodexRuntime>,
    pub thread_id: tokio::sync::Mutex<Option<String>>,
    pub app_handle: AppHandle,
}

/// Response from `thread/start` — contains a nested `thread` object with an `id` field.
#[derive(Debug, Deserialize)]
struct ThreadStartResponse {
    thread: ThreadInfo,
}

#[derive(Debug, Deserialize)]
struct ThreadInfo {
    id: String,
}

impl ThreadSession {
    pub fn new(
        client: Arc<AppServerClient>,
        runtime: Arc<dyn CodexRuntime>,
        app_handle: AppHandle,
    ) -> Self {
        Self {
            client,
            runtime,
            thread_id: tokio::sync::Mutex::new(None),
            app_handle,
        }
    }

    /// Start a new thread with the given working directory.
    /// Sandbox policy is determined by the runtime:
    /// - WSL: workspace-write (Linux sandbox is stable)
    /// - Windows native: externalSandbox (Codex's Windows sandbox is unstable)
    pub async fn start_thread(&self, cwd: &str) -> Result<String, String> {
        let linux_cwd = self.runtime.translate_path_to_codex(cwd);
        let sandbox_policy = self.runtime.default_sandbox_policy();
        let sandbox_trusted = self.runtime.codex_sandbox_trusted();
        // If sandbox is trusted (WSL), let Codex handle approval normally.
        // If not (Windows/externalSandbox), use "on-failure" as a safety net.
        // Windows (externalSandbox): untrusted — all commands require user approval
        // WSL (workspaceWrite): on-request — agent asks for approval only when needed
        let approval = if sandbox_trusted { "on-request" } else { "untrusted" };
        log::info!(
            "[codex-session] Starting thread: sandboxPolicy={}, approval={approval}, trusted={sandbox_trusted}",
            sandbox_policy
        );
        let resp: ThreadStartResponse = self
            .client
            .request(
                "thread/start",
                &json!({
                    "cwd": linux_cwd,
                    "sandboxPolicy": sandbox_policy,
                    "approvalPolicy": approval,
                }),
            )
            .await?;
        let tid = resp.thread.id;
        *self.thread_id.lock().await = Some(tid.clone());
        log::info!("[codex-session] Thread started: {tid}");
        Ok(tid)
    }

    /// Resume an existing thread.
    pub async fn resume_thread(&self, thread_id: &str) -> Result<(), String> {
        let _: serde_json::Value = self
            .client
            .request("thread/resume", &json!({ "threadId": thread_id }))
            .await?;
        *self.thread_id.lock().await = Some(thread_id.to_string());
        log::info!("[codex-session] Thread resumed: {thread_id}");
        Ok(())
    }

    /// Submit a user turn (prompt), optionally with editor context.
    pub async fn submit_turn(
        &self,
        prompt: String,
        editor_context: Option<EditorContext>,
    ) -> Result<(), String> {
        let thread_id = self
            .thread_id
            .lock()
            .await
            .clone()
            .ok_or("No active thread")?;

        // Build the full prompt with editor context header if available
        let full_prompt = if let Some(ctx) = editor_context {
            let codex_path = self.runtime.translate_path_to_codex(&ctx.path);
            let mut header = format!("[Pike context]\nCurrent file: {codex_path}");
            if let Some(line) = ctx.line {
                header.push_str(&format!("\nCursor: line {}", line));
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
                "turn/start",
                &json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": full_prompt }],
                }),
            )
            .await?;

        Ok(())
    }

    /// Interrupt the current turn.
    pub async fn interrupt_turn(&self) -> Result<(), String> {
        let thread_id = self
            .thread_id
            .lock()
            .await
            .clone()
            .ok_or("No active thread")?;

        let _: serde_json::Value = self
            .client
            .request("turn/interrupt", &json!({ "threadId": thread_id }))
            .await?;

        log::info!("[codex-session] Turn interrupted");
        Ok(())
    }

    /// Start the notification forwarding loop.
    /// This spawns a task that listens for Codex notifications and emits them as Tauri events.
    pub fn start_notification_forwarder(&self) {
        let mut rx = self.client.subscribe_notifications();
        let app = self.app_handle.clone();

        tokio::spawn(async move {
            let result = std::panic::AssertUnwindSafe(async {
                loop {
                    match rx.recv().await {
                        Ok(notif) => {
                            if log::log_enabled!(log::Level::Debug) {
                                log::debug!(
                                    "[codex-notif] {} (payload {} bytes)",
                                    notif.method,
                                    notif.params.to_string().len()
                                );
                            }
                            let event_name = format!("codex://{}", notif.method);
                            if let Err(e) = app.emit(&event_name, &notif.params) {
                                log::error!("[codex-notif] Failed to emit {event_name}: {e}");
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("[codex-notif] Lagged by {n} messages");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            log::info!("[codex-notif] Channel closed");
                            break;
                        }
                    }
                }
            });
            if let Err(e) = result.catch_unwind().await {
                log::error!("[codex-notif] PANIC in notification forwarder: {e:?}");
            }
        });
    }

    /// Start the server request handler loop (approvals etc.).
    pub async fn start_approval_handler(&self) {
        let rx = self.client.take_server_requests().await;
        let Some(mut rx) = rx else {
            log::warn!("[codex-session] Server request receiver already taken");
            return;
        };
        let client = self.client.clone();
        let app = self.app_handle.clone();
        let runtime_name = self.runtime.display_environment_name();
        let sandbox_trusted = self.runtime.codex_sandbox_trusted();

        tokio::spawn(async move {
            while let Some(req) = rx.recv().await {
                log::debug!(
                    "[codex-approval] Server request: {} (id={:?})",
                    req.method,
                    req.id
                );
                match req.method.as_str() {
                    "item/commandExecution/requestApproval" => {
                        log::debug!(
                            "[codex-approval] Command approval requested: {}",
                            req.params.get("command").and_then(|v| v.as_str()).unwrap_or("(none)")
                        );
                        let mut params = req.params.clone();
                        if let Some(obj) = params.as_object_mut() {
                            obj.insert("environment".into(), json!(runtime_name));
                            obj.insert("requestId".into(), serde_json::to_value(&req.id).unwrap_or_default());
                            obj.insert("sandboxTrusted".into(), json!(sandbox_trusted));
                        }
                        if let Err(e) = app.emit("codex://approval/command", &params) {
                            log::error!("[codex-approval] Failed to emit command approval: {e}");
                        }
                    }
                    "item/fileChange/requestApproval" => {
                        log::debug!("[codex-approval] File change approval requested");
                        let mut params = req.params.clone();
                        if let Some(obj) = params.as_object_mut() {
                            obj.insert("environment".into(), json!(runtime_name));
                            obj.insert("requestId".into(), serde_json::to_value(&req.id).unwrap_or_default());
                            obj.insert("sandboxTrusted".into(), json!(sandbox_trusted));
                        }
                        if let Err(e) = app.emit("codex://approval/file", &params) {
                            log::error!("[codex-approval] Failed to emit file approval: {e}");
                        }
                    }
                    _ => {
                        log::warn!(
                            "[codex-approval] Unknown server request: {} — declining",
                            req.method
                        );
                        let _ = client
                            .respond_to_server(req.id, json!({ "decision": "decline" }))
                            .await;
                    }
                }
            }
            log::info!("[codex-approval] Handler exiting");
        });
    }
}
