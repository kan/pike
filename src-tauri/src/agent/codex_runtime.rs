//! `AgentRuntime` implementation backed by the Codex app-server protocol.
//!
//! This wraps the existing Codex integration (`crate::codex`) to conform to
//! the unified `AgentRuntime` trait. All behavior is preserved — this is purely
//! a structural refactor.

use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::types::*;
use crate::codex::auth;
use crate::codex::protocol::client::AppServerClient;
use crate::codex::protocol::messages::RequestId;
use crate::codex::runtime::CodexRuntime;
use crate::codex::session::ThreadSession;
use crate::types::ShellConfig;

// ---------------------------------------------------------------------------
// Tauri event emitter
// ---------------------------------------------------------------------------

/// Forwards `AgentEvent`s as Tauri events to a specific window.
///
/// Events are emitted with the prefix `agent://` followed by the event type.
/// Each payload includes `tabId` so the frontend can route to the correct tab.
pub struct TauriEventEmitter {
    app_handle: AppHandle,
    window_label: String,
    tab_id: String,
}

/// Wraps an `AgentEvent` with `tabId` for frontend routing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TabEvent {
    tab_id: String,
    #[serde(flatten)]
    event: AgentEvent,
}

impl TauriEventEmitter {
    pub fn new(app_handle: AppHandle, window_label: String, tab_id: String) -> Self {
        Self {
            app_handle,
            window_label,
            tab_id,
        }
    }
}

impl EventEmitter for TauriEventEmitter {
    fn emit(&self, event: AgentEvent) {
        let event_name = match &event {
            AgentEvent::MessageDelta { .. } => "agent://message-delta",
            AgentEvent::TurnStarted => "agent://turn-started",
            AgentEvent::TurnCompleted => "agent://turn-completed",
            AgentEvent::ItemStarted { .. } => "agent://item-started",
            AgentEvent::ItemCompleted { .. } => "agent://item-completed",
            AgentEvent::CommandOutputDelta { .. } => "agent://command-output-delta",
            AgentEvent::ApprovalCommandRequest { .. } => "agent://approval-command",
            AgentEvent::ApprovalFileRequest { .. } => "agent://approval-file",
            AgentEvent::ApprovalGenericRequest { .. } => "agent://approval-generic",
            AgentEvent::AuthUpdated { .. } => "agent://auth-updated",
            AgentEvent::TokenUsage { .. } => "agent://token-usage",
            AgentEvent::Reasoning { .. } => "agent://reasoning",
            AgentEvent::Disconnected { .. } => "agent://disconnect",
            AgentEvent::Error { .. } => "agent://error",
        };
        let payload = TabEvent {
            tab_id: self.tab_id.clone(),
            event,
        };
        if let Err(e) = self
            .app_handle
            .emit_to(&self.window_label, event_name, &payload)
        {
            log::error!(
                "[agent-emit] Failed to emit {event_name} to {}: {e}",
                self.window_label
            );
        }
    }
}

// ---------------------------------------------------------------------------
// CodexAppServerRuntime
// ---------------------------------------------------------------------------

/// Wraps the existing Codex app-server integration as an `AgentRuntime`.
#[allow(dead_code)]
pub struct CodexAppServerRuntime {
    shell: ShellConfig,
    codex_runtime: Arc<dyn CodexRuntime>,
    client: Arc<AppServerClient>,
    thread_session: Arc<ThreadSession>,
    emitter: Arc<TauriEventEmitter>,
}

impl CodexAppServerRuntime {
    /// Connect to Codex app-server and create the runtime.
    pub async fn connect(
        shell: ShellConfig,
        cwd: &str,
        app_handle: AppHandle,
        window_label: String,
        tab_id: String,
    ) -> Result<Self, String> {
        let codex_runtime: Arc<dyn CodexRuntime> =
            Arc::from(crate::codex::runtime::runtime_for_shell(&shell));
        let client = Arc::new(AppServerClient::connect(codex_runtime.as_ref(), cwd).await?);
        log::info!(
            "[codex-agent] Connected for tab {tab_id} (window {window_label}) at {cwd}"
        );

        let emitter = Arc::new(TauriEventEmitter::new(
            app_handle.clone(),
            window_label.clone(),
            tab_id,
        ));

        let thread_session = Arc::new(ThreadSession::new(
            client.clone(),
            codex_runtime.clone(),
            app_handle,
            window_label,
        ));

        Ok(Self {
            shell,
            codex_runtime,
            client,
            thread_session,
            emitter,
        })
    }

    /// Start event forwarding tasks that bridge Codex notifications → AgentEvents.
    pub async fn start_event_forwarding(&self) {
        self.start_notification_bridge().await;
        self.start_approval_bridge().await;
    }

    /// Bridge Codex notifications to `AgentEvent`s.
    async fn start_notification_bridge(&self) {
        let rx = self.client.take_notifications().await;
        let Some(mut rx) = rx else {
            log::warn!("[codex-agent] Notification receiver already taken");
            return;
        };
        let emitter = self.emitter.clone();

        tokio::spawn(async move {
            while let Some(notif) = rx.recv().await {
                let event = codex_notification_to_agent_event(&notif.method, &notif.params);
                if let Some(event) = event {
                    emitter.emit(event);
                }
            }
            log::info!("[codex-agent] Notification channel closed");
            emitter.emit(AgentEvent::Disconnected {
                reason: "channel_closed".to_string(),
            });
        });
    }

    /// Bridge Codex server requests (approvals) to `AgentEvent`s.
    async fn start_approval_bridge(&self) {
        let rx = self.client.take_server_requests().await;
        let Some(mut rx) = rx else {
            log::warn!("[codex-agent] Server request receiver already taken");
            return;
        };
        let client = self.client.clone();
        let emitter = self.emitter.clone();
        let environment = self.codex_runtime.display_environment_name();
        let sandbox_trusted = self.codex_runtime.codex_sandbox_trusted();

        tokio::spawn(async move {
            while let Some(req) = rx.recv().await {
                let request_id =
                    serde_json::to_value(&req.id).unwrap_or(serde_json::Value::Null);

                match req.method.as_str() {
                    "item/commandExecution/requestApproval" => {
                        let mut payload = req.params.clone();
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("environment".into(), json!(environment));
                            obj.insert("sandboxTrusted".into(), json!(sandbox_trusted));
                        }
                        emitter.emit(AgentEvent::ApprovalCommandRequest {
                            request_id,
                            item_id: req
                                .params
                                .get("itemId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            command: req
                                .params
                                .get("command")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            cwd: req
                                .params
                                .get("cwd")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            payload,
                        });
                    }
                    "item/fileChange/requestApproval" => {
                        let mut payload = req.params.clone();
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("environment".into(), json!(environment));
                            obj.insert("sandboxTrusted".into(), json!(sandbox_trusted));
                        }
                        emitter.emit(AgentEvent::ApprovalFileRequest {
                            request_id,
                            item_id: req
                                .params
                                .get("itemId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            file_path: req
                                .params
                                .get("filePath")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            reason: req
                                .params
                                .get("reason")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            payload,
                        });
                    }
                    _ => {
                        log::warn!(
                            "[codex-agent] Unknown server request: {} — declining",
                            req.method
                        );
                        let _ = client
                            .respond_to_server(req.id, json!({ "decision": "decline" }))
                            .await;
                    }
                }
            }
        });
    }

    /// Check if this is a Windows (non-WSL) shell for sandbox defaults.
    #[allow(dead_code)]
    fn is_windows_native(&self) -> bool {
        !matches!(self.shell, ShellConfig::Wsl { .. })
    }
}

// ---------------------------------------------------------------------------
// AgentRuntime implementation
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
impl AgentRuntime for CodexAppServerRuntime {
    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            display_name: "Codex".to_string(),
            supports_model_selection: true,
            supports_session_resume: true,
            supports_rollback: true,
            supports_compact: true,
            supports_sandbox_config: true,
            supports_approval_config: true,
            supports_auth_flow: true,
        }
    }

    async fn check_available(&self) -> Result<String, String> {
        self.codex_runtime.codex_version()
    }

    async fn start_session(&self, config: SessionConfig) -> Result<String, String> {
        let sandbox_ref = config.sandbox_mode.as_deref();
        let approval_ref = config.approval_policy.as_deref();

        let tid = if let Some(existing_tid) = config.resume_session_id {
            match self
                .thread_session
                .resume_thread(&existing_tid, &config.cwd)
                .await
            {
                Ok(()) => existing_tid,
                Err(e) => {
                    log::warn!(
                        "[codex-agent] Failed to resume thread {existing_tid}: {e}, starting new"
                    );
                    self.thread_session
                        .start_thread(&config.cwd, sandbox_ref, approval_ref)
                        .await?
                }
            }
        } else {
            self.thread_session
                .start_thread(&config.cwd, sandbox_ref, approval_ref)
                .await?
        };

        // Start event forwarding after thread is established
        self.start_event_forwarding().await;

        Ok(tid)
    }

    async fn submit_turn(
        &self,
        prompt: String,
        editor_context: Option<EditorContext>,
        model: Option<String>,
    ) -> Result<(), String> {
        // Convert our EditorContext to the Codex-specific one
        let codex_ctx = editor_context.map(|ctx| crate::codex::session::EditorContext {
            path: ctx.path,
            line: ctx.line,
            col: ctx.col,
            selection_start: ctx.selection_start,
            selection_end: ctx.selection_end,
        });
        self.thread_session
            .submit_turn(prompt, codex_ctx, model)
            .await
    }

    async fn interrupt_turn(&self) -> Result<(), String> {
        self.thread_session.interrupt_turn().await
    }

    async fn rollback_turn(&self) -> Result<(), String> {
        self.thread_session.rollback_turn().await
    }

    async fn compact(&self) -> Result<(), String> {
        self.thread_session.compact_thread().await
    }

    async fn respond_approval(
        &self,
        request_id: serde_json::Value,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let id: RequestId =
            serde_json::from_value(request_id).map_err(|e| format!("Invalid request ID: {e}"))?;

        let codex_decision = match decision {
            ApprovalDecision::Allow => json!({ "decision": "accept" }),
            ApprovalDecision::AllowAlways => json!({ "decision": "acceptForSession" }),
            ApprovalDecision::Reject => json!({ "decision": "decline" }),
            ApprovalDecision::Cancel => json!({ "decision": "cancel" }),
        };

        self.client.respond_to_server(id, codex_decision).await
    }

    async fn auth_status(&self) -> Result<AgentAuthState, String> {
        let codex_state = auth::check_auth_status(&self.client).await?;
        Ok(codex_auth_to_agent_auth(codex_state))
    }

    async fn auth_login(&self) -> Result<(), String> {
        let url = auth::start_chatgpt_login(&self.client).await?;
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

    async fn auth_logout(&self) -> Result<(), String> {
        auth::logout(&self.client).await
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, String> {
        let codex_models = self.thread_session.list_models().await?;
        Ok(codex_models
            .into_iter()
            .map(|m| ModelInfo {
                id: m.id,
                display_name: m.display_name,
                description: m.description,
                is_default: m.is_default,
            })
            .collect())
    }

    async fn shutdown(&self) -> Result<(), String> {
        self.client.shutdown().await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/// Convert a Codex AuthState to the unified AgentAuthState.
fn codex_auth_to_agent_auth(state: auth::AuthState) -> AgentAuthState {
    match state {
        auth::AuthState::Unknown => AgentAuthState::Unknown,
        auth::AuthState::Unauthenticated => AgentAuthState::Unauthenticated,
        auth::AuthState::AuthenticatingChatGpt => AgentAuthState::Authenticating,
        auth::AuthState::Authenticated {
            mode,
            plan_type,
            email,
        } => AgentAuthState::Authenticated {
            mode,
            plan_type,
            email,
        },
        auth::AuthState::Error { message } => AgentAuthState::Error { message },
    }
}

/// Map a Codex notification (method + params) to an `AgentEvent`.
/// Returns `None` for notifications we don't need to forward.
fn codex_notification_to_agent_event(
    method: &str,
    params: &serde_json::Value,
) -> Option<AgentEvent> {
    match method {
        // Text streaming
        "item/agentMessage/delta" => {
            let delta = params.get("delta")?.as_str()?.to_string();
            let item_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some(AgentEvent::MessageDelta { delta, item_id })
        }

        // Turn lifecycle
        "turn/started" => Some(AgentEvent::TurnStarted),
        "turn/completed" => Some(AgentEvent::TurnCompleted),

        // v1 fallback
        "codex/event/task_completed" => Some(AgentEvent::TurnCompleted),

        // Item lifecycle
        "item/started" => {
            let item = params.get("item")?;
            let item_type = item.get("type")?.as_str()?.to_string();
            let item_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(AgentEvent::ItemStarted {
                item_type,
                item_id,
                data: item.clone(),
            })
        }
        "item/completed" => {
            let item = params.get("item")?;
            let item_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(AgentEvent::ItemCompleted {
                item_id,
                data: item.clone(),
            })
        }

        // v1 fallback for item completed
        "codex/event/item_completed" => {
            let msg = params.get("msg")?;
            let item = msg.get("item")?;
            let item_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(AgentEvent::ItemCompleted {
                item_id,
                data: item.clone(),
            })
        }

        // Command output
        "item/commandExecution/outputDelta" => {
            let delta = params.get("delta")?.as_str()?.to_string();
            let item_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(AgentEvent::CommandOutputDelta { item_id, delta })
        }

        // Auth
        "account/updated" => {
            let account = params.get("account");
            let state = match account.and_then(|a| a.get("type")).and_then(|t| t.as_str()) {
                Some("chatgpt") => AgentAuthState::Authenticated {
                    mode: "chatgpt".to_string(),
                    plan_type: account
                        .and_then(|a| a.get("planType"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    email: account
                        .and_then(|a| a.get("email"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                },
                Some("apiKey") => AgentAuthState::Authenticated {
                    mode: "apiKey".to_string(),
                    plan_type: None,
                    email: None,
                },
                _ => AgentAuthState::Unauthenticated,
            };
            Some(AgentEvent::AuthUpdated { state })
        }
        "account/login/completed" => {
            // Frontend will re-fetch auth status on this event
            Some(AgentEvent::AuthUpdated {
                state: AgentAuthState::Unknown,
            })
        }

        // Token usage
        "thread/tokenUsage/updated" => {
            let usage = params.get("usage")?;
            let input = usage
                .get("inputTokens")
                .or_else(|| usage.get("input"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output = usage
                .get("outputTokens")
                .or_else(|| usage.get("output"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            Some(AgentEvent::TokenUsage {
                input,
                output,
                cached_read: None,
                cached_write: None,
            })
        }

        // Error
        "error" => {
            let message = params
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error")
                .to_string();
            Some(AgentEvent::Error { message })
        }

        _ => {
            log::debug!("[codex-agent] Unhandled notification: {method}");
            None
        }
    }
}
