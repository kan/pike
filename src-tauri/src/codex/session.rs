use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

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
    app_handle: AppHandle,
    window_label: String,
}

#[derive(Debug, Deserialize)]
struct ThreadStartResponse {
    thread: ThreadInfo,
}

#[derive(Debug, Deserialize)]
struct ThreadInfo {
    id: String,
}

/// Model information returned by `model/list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub is_default: bool,
}

impl ThreadSession {
    pub fn new(
        client: Arc<AppServerClient>,
        runtime: Arc<dyn CodexRuntime>,
        app_handle: AppHandle,
        window_label: String,
    ) -> Self {
        Self {
            client,
            runtime,
            thread_id: tokio::sync::Mutex::new(None),
            app_handle,
            window_label,
        }
    }

    pub async fn start_thread(
        &self,
        cwd: &str,
        sandbox_override: Option<&str>,
        approval_override: Option<&str>,
    ) -> Result<String, String> {
        let linux_cwd = self.runtime.translate_path_to_codex(cwd);
        let sandbox_policy = sandbox_override
            .map(|s| json!({"type": s}))
            .unwrap_or_else(|| self.runtime.default_sandbox_policy());
        let sandbox_trusted = self.runtime.codex_sandbox_trusted();
        let approval = approval_override
            .unwrap_or(if sandbox_trusted { "on-request" } else { "untrusted" });

        // Load AGENTS.md or CLAUDE.md as developer instructions
        let developer_instructions = load_developer_instructions(cwd);
        if let Some(ref file) = developer_instructions {
            log::info!(
                "[codex-session] Loaded developer instructions ({} bytes)",
                file.len()
            );
        }

        log::info!(
            "[codex-session] Starting thread for {}: sandboxPolicy={}, approval={approval}",
            self.window_label,
            sandbox_policy
        );

        let mut params = json!({
            "cwd": linux_cwd,
            "sandboxPolicy": sandbox_policy,
            "approvalPolicy": approval,
        });
        if let Some(instructions) = developer_instructions {
            params["developerInstructions"] = json!(instructions);
        }

        let resp: ThreadStartResponse = self
            .client
            .request("thread/start", &params)
            .await?;
        let tid = resp.thread.id;
        *self.thread_id.lock().await = Some(tid.clone());
        log::info!("[codex-session] Thread started: {tid}");
        Ok(tid)
    }

    pub async fn resume_thread(&self, thread_id: &str, cwd: &str) -> Result<(), String> {
        let developer_instructions = load_developer_instructions(cwd);
        let mut params = json!({ "threadId": thread_id });
        if let Some(instructions) = developer_instructions {
            log::info!(
                "[codex-session] Loaded developer instructions for resume ({} bytes)",
                instructions.len()
            );
            params["developerInstructions"] = json!(instructions);
        }
        let _: serde_json::Value = self
            .client
            .request("thread/resume", &params)
            .await?;
        *self.thread_id.lock().await = Some(thread_id.to_string());
        log::info!("[codex-session] Thread resumed");
        log::debug!("[codex-session] Resumed thread id: {thread_id}");
        Ok(())
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, String> {
        let resp: serde_json::Value = self
            .client
            .request("model/list", &json!({}))
            .await?;
        log::debug!("[codex-session] model/list response: {resp}");

        // Parse flexibly: response may be { data: [...] }, { models: [...] }, or [...]
        let arr = resp
            .get("data")
            .and_then(|v| v.as_array())
            .or_else(|| resp.get("models").and_then(|v| v.as_array()))
            .or_else(|| resp.as_array())
            .ok_or_else(|| format!("Unexpected model/list response: {resp}"))?;

        let models: Vec<ModelInfo> = arr
            .iter()
            .filter_map(|v| {
                let id = v.get("id").and_then(|x| x.as_str())?;
                Some(ModelInfo {
                    id: id.to_string(),
                    display_name: v
                        .get("displayName")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string()),
                    description: v
                        .get("description")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string()),
                    is_default: v
                        .get("isDefault")
                        .and_then(|b| b.as_bool())
                        .unwrap_or(false),
                })
            })
            .collect();

        Ok(models)
    }

    pub async fn submit_turn(
        &self,
        prompt: String,
        editor_context: Option<EditorContext>,
        model: Option<String>,
    ) -> Result<(), String> {
        let thread_id = self
            .thread_id
            .lock()
            .await
            .clone()
            .ok_or("No active thread")?;

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

        let mut params = json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": full_prompt }],
        });
        if let Some(m) = model {
            params["model"] = json!(m);
        }

        let _: serde_json::Value = self
            .client
            .request("turn/start", &params)
            .await?;

        Ok(())
    }

    pub async fn compact_thread(&self) -> Result<(), String> {
        let thread_id = self
            .thread_id
            .lock()
            .await
            .clone()
            .ok_or("No active thread")?;

        let _: serde_json::Value = self
            .client
            .request("thread/compact/start", &json!({ "threadId": thread_id }))
            .await?;

        log::info!("[codex-session] Thread compacted");
        Ok(())
    }

    pub async fn rollback_turn(&self) -> Result<(), String> {
        let thread_id = self
            .thread_id
            .lock()
            .await
            .clone()
            .ok_or("No active thread")?;

        let _: serde_json::Value = self
            .client
            .request("thread/rollback", &json!({ "threadId": thread_id }))
            .await?;

        log::info!("[codex-session] Turn rolled back");
        Ok(())
    }

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

    /// Spawn a task that forwards Codex notifications to this window only.
    pub async fn start_notification_forwarder(&self) {
        let rx = self.client.take_notifications().await;
        let Some(mut rx) = rx else {
            log::warn!("[codex-session] Notification receiver already taken");
            return;
        };
        let app = self.app_handle.clone();
        let target = self.window_label.clone();

        tokio::spawn(async move {
            while let Some(notif) = rx.recv().await {
                let event_name = format!("codex://{}", notif.method);
                if let Err(e) = app.emit_to(&target, &event_name, &notif.params) {
                    log::error!("[codex-notif] Failed to emit to {target}: {e}");
                }
            }
            log::info!("[codex-notif] Channel closed for {target}");
            let _ = app.emit_to(
                &target,
                "codex://disconnect",
                &json!({"reason": "channel_closed"}),
            );
        });
    }

    /// Spawn a task that handles server requests (approvals) for this window.
    pub async fn start_approval_handler(&self) {
        let rx = self.client.take_server_requests().await;
        let Some(mut rx) = rx else {
            log::warn!("[codex-session] Server request receiver already taken");
            return;
        };
        let client = self.client.clone();
        let app = self.app_handle.clone();
        let target = self.window_label.clone();
        let runtime_name = self.runtime.display_environment_name();
        let sandbox_trusted = self.runtime.codex_sandbox_trusted();

        tokio::spawn(async move {
            let emit_approval = |params: &serde_json::Value,
                                 id: &super::protocol::messages::RequestId,
                                 event: &str| {
                let mut params = params.clone();
                if let Some(obj) = params.as_object_mut() {
                    obj.insert("environment".into(), json!(runtime_name));
                    obj.insert("requestId".into(), serde_json::to_value(id).unwrap_or_default());
                    obj.insert("sandboxTrusted".into(), json!(sandbox_trusted));
                }
                let _ = app.emit_to(&target, event, &params);
            };

            while let Some(req) = rx.recv().await {
                match req.method.as_str() {
                    "item/commandExecution/requestApproval" => {
                        emit_approval(&req.params, &req.id, "codex://approval/command");
                    }
                    "item/fileChange/requestApproval" => {
                        emit_approval(&req.params, &req.id, "codex://approval/file");
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
        });
    }
}

/// Load developer instructions from AGENTS.md or CLAUDE.md in the project root.
/// Returns None if neither file exists or is readable.
fn load_developer_instructions(cwd: &str) -> Option<String> {
    let root = std::path::Path::new(cwd);
    for filename in ["AGENTS.md", "CLAUDE.md"] {
        let path = root.join(filename);
        match std::fs::read_to_string(&path) {
            Ok(content) if !content.trim().is_empty() => {
                log::info!("[codex-session] Using {filename} from {}", path.display());
                return Some(content);
            }
            _ => continue,
        }
    }
    None
}
