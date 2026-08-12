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

use std::collections::HashMap;
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
// Helpers
// ---------------------------------------------------------------------------

pub(super) use crate::types::{WSL_EXTRA_PATH, bash_quote};

/// Build a shell command string with quoting for `bash -c`.
fn build_shell_command(command: &str, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(1 + args.len());
    parts.push(bash_quote(command));
    for arg in args {
        parts.push(bash_quote(arg));
    }
    format!("PATH=\"{WSL_EXTRA_PATH}:$PATH\" {}", parts.join(" "))
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
            let acp_cmd = build_shell_command(&self.config.command, &self.config.args);
            // WSL では `cmd.env` は wsl.exe（Windows 側）にしか効かず、distro の中の
            // プロセスには渡らない。bash に渡す行の頭で代入する。
            let assigns: String = self
                .config
                .env
                .iter()
                .map(|(k, v)| format!("{k}={} ", bash_quote(v)))
                .collect();
            let mut c = Command::new("wsl.exe");
            c.args([
                "--cd",
                &linux_dir,
                "-d",
                distro,
                "--",
                "bash",
                "-c",
                &format!("{assigns}{acp_cmd}"),
            ]);
            c
        } else {
            // On Windows, npm-installed binaries are .cmd files.
            // Use `cmd /C` to resolve them correctly.
            let mut c = Command::new("cmd.exe");
            c.arg("/C").arg(&self.config.command);
            for arg in &self.config.args {
                c.arg(arg);
            }
            c.current_dir(working_dir);
            c
        };

        // Set environment variables (the WSL branch already put them in the bash line).
        if !is_wsl {
            for (key, val) in &self.config.env {
                cmd.env(key, val);
            }
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

/// `session/request_permission` の `options` を読む。ACP の `PermissionOption` は
/// `{ optionId, name, kind }`。`optionId` の無い要素は応答に使えないので捨てる。
fn parse_permission_options(params: &serde_json::Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let id = v.get("optionId").and_then(|id| id.as_str())?;
                    Some(PermissionOption {
                        id: id.to_string(),
                        name: v
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or(id)
                            .to_string(),
                        kind: v
                            .get("kind")
                            .and_then(|k| k.as_str())
                            .unwrap_or("other")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// ツール呼び出しの通知を、チャット UI が描き分ける種別に落とす。
///
/// 見るのは ACP の `kind`（`execute` / `edit` / `read` / …）。ツールの呼び名
/// （Bash / Write / …）はエージェントごとに違ううえ、ACP の ToolCallUpdate には
/// そもそも名前のフィールドが無い（#227）。名前で分岐していたころは、どのツールも
/// 種別が付かず `"unknown"` として流れていた。
fn item_type_for(tool_call: &serde_json::Value) -> String {
    match tool_call.get("kind").and_then(|v| v.as_str()) {
        Some("execute") => "commandExecution".to_string(),
        Some("edit") | Some("delete") | Some("move") => "fileChange".to_string(),
        Some(kind) => kind.to_string(),
        None => "other".to_string(),
    }
}

/// ツール呼び出しの `content[]` からテキストを集める。ToolCallContent の中身は
/// メッセージ本文と同じ ContentBlock なので `content_block_text` で読める。diff や
/// terminal の要素はテキストを持たないので落ちる。
fn tool_call_output(tool_call: &serde_json::Value) -> String {
    let Some(items) = tool_call.get("content").and_then(|v| v.as_array()) else {
        return String::new();
    };
    items
        .iter()
        .map(content_block_text)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// ACP のツール呼び出しを、チャット UI が読むキーに寄せる。
///
/// UI（`AgentChatTab.vue`）は Codex 由来の `command` / `output` / `filePath` を見る。
/// ACP の生の更新をそのまま渡していたころは、どのキーも無いので**コマンド名も出力も
/// 出ず、項目を開いても空**だった（#227 の対応中に発見）。
///
/// **`title` をコマンドとして渡さない**。最初のツール呼び出しは入力が流れきる前に来る
/// ので、Bash の title はまだ "Terminal"（アダプタのフォールバック）でしかなく、それを
/// command にするとそのラベルが確定値として残る。`title` 自体は別のキーで渡し、
/// コマンドが決まるまでの表示は UI 側でそちらに落とす。
fn tool_call_data(tool_call: &serde_json::Value) -> serde_json::Value {
    let mut data = serde_json::Map::new();
    let raw = tool_call.get("rawInput");

    if let Some(command) = raw.and_then(|v| v.get("command")).and_then(|v| v.as_str()) {
        data.insert("command".into(), json!(command));
    }

    let file_path = raw
        .and_then(|v| v.get("file_path").or_else(|| v.get("path")))
        .and_then(|v| v.as_str())
        .or_else(|| {
            tool_call
                .get("locations")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|l| l.get("path"))
                .and_then(|v| v.as_str())
        });
    if let Some(file_path) = file_path {
        data.insert("filePath".into(), json!(file_path));
    }

    let output = tool_call_output(tool_call);
    if !output.is_empty() {
        data.insert("output".into(), json!(output));
    }
    if let Some(title) = tool_call.get("title").and_then(|v| v.as_str()) {
        data.insert("title".into(), json!(title));
    }
    serde_json::Value::Object(data)
}

/// `session/update` が運ぶ ContentBlock からテキストを取り出す。ACP は
/// `{ "type": "text", "text": "…" }` の形で送る（メッセージ本文と thinking で共通）。
/// 素の文字列も受けるのは、そう送ってくる ACP エージェント向けの保険。
fn content_block_text(update: &serde_json::Value) -> String {
    update
        .get("content")
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).or_else(|| v.as_str()))
        .unwrap_or("")
        .to_string()
}

/// ACP の plan（`entries[]`）を markdown のチェックリストに畳む。
///
/// チェックボックスは `[x]` と `[ ]` だけにする。GFM のタスクリストはこの 2 つしか
/// 認識せず、`[-]` のような第 3 のマーカーを混ぜるとその行だけ生の文字列で描かれて
/// 見た目が割れる。実行中の項目は太字で示す。
fn plan_summary(update: &serde_json::Value) -> String {
    let Some(entries) = update.get("entries").and_then(|v| v.as_array()) else {
        return String::new();
    };
    entries
        .iter()
        .filter_map(|e| {
            let content = e.get("content").and_then(|v| v.as_str())?;
            Some(match e.get("status").and_then(|v| v.as_str()) {
                Some("completed") => format!("- [x] {content}"),
                Some("in_progress") => format!("- [ ] **{content}**"),
                _ => format!("- [ ] {content}"),
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// コマンド / ファイル変更の承認は Pike の決まった 4 択なので、対応する `kind` の
/// 選択肢を探す。該当が無ければ `None`（呼び出し側は `cancelled` で応答する）。
/// 近そうな選択肢で代用はしない — 拒否のつもりが許可になりかねない。
///
/// 汎用ダイアログはこれを通さない。エージェントは同じ `kind` の選択肢を複数出しうる
/// ので（`claude-agent-acp` の ExitPlanMode は `allow_always` を 3 つ並べる）、
/// `kind` から引き直すと押したものと違う選択肢を送ってしまう。あちらは UI が
/// `option_id` をそのまま返す。
fn option_for_decision(
    options: &[PermissionOption],
    decision: &ApprovalDecision,
) -> Option<String> {
    let wanted = match decision {
        ApprovalDecision::Allow => "allow_once",
        ApprovalDecision::AllowAlways => "allow_always",
        ApprovalDecision::Reject => "reject_once",
        ApprovalDecision::Cancel => return None,
    };
    options.iter().find(|o| o.kind == wanted).map(|o| o.id.clone())
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
    shell: ShellConfig,
    codex_runtime: Arc<dyn CodexRuntime>,
    client: Arc<AppServerClient>,
    session_id: Mutex<Option<String>>,
    emitter: Arc<TauriEventEmitter>,
    /// 未応答の承認リクエストが提示していた選択肢。決まった 4 択のダイアログ
    /// （コマンド / ファイル変更）はここから `optionId` を引く（#227）。汎用ダイアログは
    /// UI が押した id を返すので、こちらは使わない。応答・中断・終了で消す。
    pending_options: Arc<Mutex<HashMap<RequestId, Vec<PermissionOption>>>>,
}

impl ACPRuntime {
    /// Connect to an ACP agent process and perform the initialize handshake.
    pub async fn connect(
        shell: ShellConfig,
        cwd: &str,
        agent_config: AcpAgentConfig,
        app_handle: tauri::AppHandle,
        window_label: String,
        tab_id: String,
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
            tab_id.clone(),
        ));

        log::info!(
            "[acp-agent] Connected {} for tab {tab_id} (window {window_label}) at {cwd}",
            agent_config.name
        );

        Ok(Self {
            config: agent_config,
            shell,
            codex_runtime,
            client,
            session_id: Mutex::new(None),
            emitter,
            pending_options: Arc::new(Mutex::new(HashMap::new())),
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
                if events.is_empty() {
                    let preview = notif.params.to_string();
                    let preview = if preview.len() > 300 { &preview[..300] } else { &preview };
                    log::debug!("[acp-bridge] 0 events from {}: {preview}", notif.method);
                } else {
                    log::debug!("[acp-bridge] {} event(s) from {}", events.len(), notif.method);
                }
                for event in events {
                    emitter.emit(event);
                }
            }
            log::debug!("[acp-agent] Notification channel closed");
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
        let pending_options = self.pending_options.clone();

        tokio::spawn(async move {
            while let Some(req) = rx.recv().await {
                let request_id =
                    serde_json::to_value(&req.id).unwrap_or(serde_json::Value::Null);

                match req.method.as_str() {
                    "session/request_permission" => {
                        // ACP spec: toolCall is a ToolCallUpdate — `title` / `kind` /
                        // `rawInput` / `locations`. **`toolName` / `toolInput` という
                        // フィールドは無い**（#227。あると思って読んでいたので、ツール名は
                        // 常に "unknown" になり、コマンド/ファイル用の表示にも一度も
                        // 到達していなかった）。
                        let tool_call = req
                            .params
                            .get("toolCall")
                            .cloned()
                            .unwrap_or(json!({}));
                        let title = tool_call
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let kind = tool_call
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("other")
                            .to_string();
                        let tool_input = tool_call
                            .get("rawInput")
                            .cloned()
                            .unwrap_or(json!({}));
                        let tool_call_id = tool_call
                            .get("toolCallId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // 汎用ダイアログはこの一覧をそのまま UI に渡し、押した選択肢の
                        // id が返ってくる。決まった 4 択の画面（コマンド / ファイル変更）は
                        // 選択肢を持たないので、応答するときに引けるよう覚えておく。
                        let mut remember = Some(parse_permission_options(&req.params));

                        // 振り分けは ACP の `kind` で行う。ツールの呼び名（Bash / Write /
                        // …）はエージェントごとに違うが、`kind` は ACP が定めている。
                        let event = match kind.as_str() {
                            "execute" => {
                                let command = tool_input
                                    .get("command")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    // Bash ツールの `title` はコマンドそのもの。
                                    .or_else(|| (!title.is_empty()).then(|| title.clone()));
                                let cwd = tool_input
                                    .get("cwd")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                AgentEvent::ApprovalCommandRequest {
                                    request_id,
                                    item_id: tool_call_id,
                                    command,
                                    cwd,
                                    payload: req.params.clone(),
                                }
                            }
                            "edit" | "delete" | "move" => {
                                let file_path = tool_input
                                    .get("path")
                                    .or_else(|| tool_input.get("file_path"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .or_else(|| {
                                        tool_call
                                            .get("locations")
                                            .and_then(|v| v.as_array())
                                            .and_then(|a| a.first())
                                            .and_then(|l| l.get("path"))
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string())
                                    });
                                AgentEvent::ApprovalFileRequest {
                                    request_id,
                                    item_id: tool_call_id,
                                    file_path,
                                    reason: (!title.is_empty()).then(|| title.clone()),
                                    payload: req.params.clone(),
                                }
                            }
                            _ => AgentEvent::ApprovalGenericRequest {
                                request_id,
                                tool_name: if title.is_empty() { kind } else { title },
                                tool_arguments: tool_input,
                                options: remember.take().unwrap_or_default(),
                                payload: req.params.clone(),
                            },
                        };
                        if let Some(options) = remember {
                            pending_options.lock().await.insert(req.id.clone(), options);
                        }
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
        super::commands::check_acp_available(&self.config, &self.shell)
    }

    async fn start_session(&self, config: SessionConfig) -> Result<String, String> {
        let linux_cwd = self.codex_runtime.translate_path_to_codex(&config.cwd);

        // Try to load an existing session if resume_session_id is provided
        if let Some(ref existing_id) = config.resume_session_id {
            match self
                .client
                .request::<_, serde_json::Value>(
                    "session/load",
                    &json!({
                        "sessionId": existing_id,
                        "cwd": linux_cwd,
                        "mcpServers": [],
                    }),
                )
                .await
            {
                Ok(_) => {
                    *self.session_id.lock().await = Some(existing_id.clone());
                    self.start_event_forwarding().await;
                    log::info!("[acp-agent] Session loaded");
                    log::debug!("[acp-agent] Loaded session id: {existing_id}");
                    return Ok(existing_id.clone());
                }
                Err(e) => {
                    log::warn!("[acp-agent] Failed to load session: {e}, creating new");
                    log::debug!("[acp-agent] Failed session id: {existing_id}");
                }
            }
        }

        // Create a new session
        let resp: serde_json::Value = self
            .client
            .request(
                "session/new",
                &json!({
                    "cwd": linux_cwd,
                    "mcpServers": [],
                }),
            )
            .await?;

        let session_id = resp
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("session/new response missing sessionId: {resp}"))?
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

        // Fire the request in a background task — session/prompt blocks until
        // the entire turn completes (by ACP spec). Streaming updates arrive as
        // session/update notifications via the notification bridge.
        let client = self.client.clone();
        let emitter = self.emitter.clone();
        let sid = session_id.clone();

        log::debug!("[acp-agent] Sending session/prompt for session {sid}");

        tokio::spawn(async move {
            log::debug!("[acp-agent] session/prompt background task started");
            match client
                .request::<_, serde_json::Value>(
                    "session/prompt",
                    &json!({
                        "sessionId": sid,
                        "prompt": [{ "type": "text", "text": full_prompt }],
                    }),
                )
                .await
            {
                Ok(resp) => {
                    log::debug!("[acp-agent] session/prompt completed: {resp}");
                    emitter.emit(AgentEvent::TurnCompleted);
                }
                Err(e) => {
                    log::error!("[acp-agent] session/prompt error: {e}");
                    emitter.emit(AgentEvent::Disconnected {
                        reason: format!("session/prompt failed: {e}"),
                    });
                }
            }
        });

        Ok(())
    }

    async fn interrupt_turn(&self) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or("No active ACP session")?;

        // session/cancel is a notification (one-way), not a request
        self.client
            .notify("session/cancel", &json!({ "sessionId": session_id }))
            .await?;

        // 中断したターンの承認にはもう応答しない（UI 側も pending を捨てる）。
        // 消さないとタブを閉じるまで残る。
        self.pending_options.lock().await.clear();
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
        option_id: Option<String>,
    ) -> Result<(), String> {
        // 先に `RequestId` へ戻してから引く。`Value` の文字列表現を鍵にすると、
        // フロントを往復した JSON の書式が少しでも変われば黙って引けなくなり、
        // 「選択肢が無い」＝取り消し扱いになる（#227 が直したのと同じ、無言で
        // 違う結果になる失敗形）。
        let id: RequestId =
            serde_json::from_value(request_id).map_err(|e| format!("Invalid request ID: {e}"))?;
        let pending = self.pending_options.lock().await.remove(&id).unwrap_or_default();

        // ACP spec: response is { outcome: { outcome: "selected", optionId: "..." } }
        // or { outcome: { outcome: "cancelled" } }.
        //
        // **`optionId` はリクエストで提示されたものでなければならない**（#227）。汎用
        // ダイアログは押した選択肢の id をそのまま渡してくる。決まった 4 択の画面は
        // `kind` から引く。該当が無ければ、適当な id を送らず取り消す。
        let selected = option_id.or_else(|| option_for_decision(&pending, &decision));
        let response = match selected {
            Some(option_id) => json!({
                "outcome": { "outcome": "selected", "optionId": option_id }
            }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
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
        self.pending_options.lock().await.clear();
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
                    match parse_incoming(value.clone()) {
                        Ok(IncomingMessage::Response { id, result }) => {
                            log::debug!("[acp-reader] Response id={id:?}");
                            if let RequestId::Num(n) = id {
                                let mut map = pending_clone.lock().await;
                                if let Some(tx) = map.remove(&n) {
                                    let _ = tx.send(Ok(result));
                                }
                            }
                        }
                        Ok(IncomingMessage::Error { id, error }) => {
                            log::warn!("[acp-reader] Error response id={id:?}: {error}");
                            if let RequestId::Num(n) = id {
                                let mut map = pending_clone.lock().await;
                                if let Some(tx) = map.remove(&n) {
                                    let _ = tx.send(Err(error));
                                }
                            }
                        }
                        Ok(IncomingMessage::ServerRequest { id, method, params }) => {
                            log::debug!("[acp-reader] ServerRequest: {method} (id={id:?})");
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
                            // Log the raw message to understand what we're getting
                            let preview = value.to_string();
                            let preview = if preview.len() > 200 { &preview[..200] } else { &preview };
                            log::warn!("[acp-reader] Unrecognized message: {e} — raw: {preview}");
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
    // ACP spec uses camelCase and protocolVersion 0 (bumped only for breaking changes).
    // See: https://agentclientprotocol.com/protocol/schema
    let init_params = json!({
        "protocolVersion": 0,
        "clientInfo": {
            "name": "pike",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "clientCapabilities": {
            "fs": {
                "readTextFile": false,
                "writeTextFile": false,
            },
            "terminal": false,
        },
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
///
/// ACP session/update uses a discriminated union on the `sessionUpdate` field
/// within the `update` object. All field names are camelCase per the ACP spec.
fn parse_session_update(params: &serde_json::Value) -> Vec<AgentEvent> {
    let mut events = Vec::new();

    let update = match params.get("update").or(Some(params)) {
        Some(u) => u,
        None => return events,
    };

    // ACP discriminates update type via "sessionUpdate" field
    let update_type = update
        .get("sessionUpdate")
        // Fallback to "type" for forward compatibility
        .or_else(|| update.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match update_type {
        // Agent message chunk (streaming text)
        "agent_message_chunk" | "message" => {
            let text = content_block_text(update);
            if !text.is_empty() {
                events.push(AgentEvent::MessageDelta {
                    delta: text,
                    item_id: update
                        .get("messageId")
                        .or_else(|| update.get("message_id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
            // Check for role to detect turn boundaries
            if let Some("assistant") = update.get("role").and_then(|v| v.as_str()) {
                if update.get("stopReason").or(update.get("stop_reason")).is_some() {
                    events.push(AgentEvent::TurnCompleted);
                }
            }
        }

        // User message chunk
        "user_message_chunk" => {
            // Usually ignored by the UI, but log for debugging
            log::debug!("[acp-agent] User message chunk received");
        }

        // Tool call update (camelCase: toolCallUpdate wraps a ToolCallUpdate object)
        "tool_call_update" => {
            let tool_call = update
                .get("toolCallUpdate")
                .unwrap_or(update);
            let tool_call_id = tool_call
                .get("toolCallId")
                .or_else(|| tool_call.get("tool_call_id"))
                .or_else(|| tool_call.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // If the tool call has content, it's completed; otherwise it's starting
            let has_content = tool_call
                .get("content")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);

            if has_content {
                events.push(AgentEvent::ItemCompleted {
                    item_id: tool_call_id,
                    data: tool_call_data(tool_call),
                });
            } else {
                events.push(AgentEvent::ItemStarted {
                    item_type: item_type_for(tool_call),
                    item_id: tool_call_id,
                    data: tool_call_data(tool_call),
                });
            }
        }

        // Legacy tool_call / tool_result (for agents that use older format)
        "tool_call" => {
            let tool_call_id = update
                .get("toolCallId")
                .or_else(|| update.get("tool_call_id"))
                .or_else(|| update.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending");

            match status {
                "pending" | "in_progress" => {
                    events.push(AgentEvent::ItemStarted {
                        item_type: item_type_for(update),
                        item_id: tool_call_id,
                        data: tool_call_data(update),
                    });
                }
                "completed" | "failed" => {
                    events.push(AgentEvent::ItemCompleted {
                        item_id: tool_call_id,
                        data: tool_call_data(update),
                    });
                }
                _ => {}
            }
        }

        "tool_result" => {
            let tool_call_id = update
                .get("toolCallId")
                .or_else(|| update.get("tool_call_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            events.push(AgentEvent::ItemCompleted {
                item_id: tool_call_id,
                data: update.clone(),
            });
        }

        // Plan — ACP sends the whole plan every time, as `entries[]`.
        "plan" => {
            let summary = plan_summary(update);
            if !summary.is_empty() {
                events.push(AgentEvent::Reasoning {
                    item_id: "plan".to_string(),
                    summary,
                    append: false,
                });
            }
        }

        // Thinking — streamed as chunks, like the message text.
        "agent_thought_chunk" => {
            let text = content_block_text(update);
            if !text.is_empty() {
                events.push(AgentEvent::Reasoning {
                    item_id: "thought".to_string(),
                    summary: text,
                    append: true,
                });
            }
        }

        // Token usage — ACP sends "usage_update" with {used, size, cost}
        // and also the prompt response includes detailed usage
        "usage_update" | "usage" | "token_usage" => {
            let input = update
                .get("inputTokens")
                .or_else(|| update.get("input_tokens"))
                .or_else(|| update.get("input"))
                .or_else(|| update.get("used"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output = update
                .get("outputTokens")
                .or_else(|| update.get("output_tokens"))
                .or_else(|| update.get("output"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cached_read = update
                .get("cacheReadInputTokens")
                .or_else(|| update.get("cache_read_input_tokens"))
                .and_then(|v| v.as_u64());
            let cached_write = update
                .get("cacheCreationInputTokens")
                .or_else(|| update.get("cache_creation_input_tokens"))
                .and_then(|v| v.as_u64());
            events.push(AgentEvent::TokenUsage {
                input,
                output,
                cached_read,
                cached_write,
            });
        }

        // Available commands update (e.g., slash commands)
        "available_commands_update" => {
            let commands: Vec<AgentCommandInfo> = update
                .get("availableCommands")
                .and_then(|v| v.as_array())
                .map(|cmds| {
                    cmds.iter()
                        .filter_map(|c| {
                            let name = c.get("name")?.as_str()?.to_string();
                            let description = c.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let input_hint = c.get("input").and_then(|v| v.get("hint")).and_then(|v| v.as_str()).map(|s| s.to_string());
                            Some(AgentCommandInfo { name, description, input_hint })
                        })
                        .collect()
                })
                .unwrap_or_default();
            events.push(AgentEvent::AvailableCommandsUpdated { commands });
        }

        // Config option update
        "config_option_update" => {
            log::debug!("[acp-agent] Config option update received");
        }

        // Session info update (title, etc.)
        "session_info_update" => {
            let title = update
                .get("title")
                .or_else(|| update.get("sessionTitle"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if title.is_some() {
                events.push(AgentEvent::SessionInfoUpdated { title });
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `claude-agent-acp` 0.28.0 が実際に送ってくる形（#227）。ツール名も `toolInput` も
    /// 無く、`optionId` は `kind` とは別の文字列であることを固定する。
    fn tool_permission_request() -> serde_json::Value {
        json!({
            "sessionId": "s1",
            "options": [
                { "kind": "allow_always", "name": "Always Allow", "optionId": "allow_always" },
                { "kind": "allow_once", "name": "Allow", "optionId": "allow" },
                { "kind": "reject_once", "name": "Reject", "optionId": "reject" },
            ],
            "toolCall": {
                "toolCallId": "t1",
                "title": "ls -la",
                "kind": "execute",
                "rawInput": { "command": "ls -la" },
            },
        })
    }

    #[test]
    fn parses_options_with_ids_names_and_kinds() {
        let options = parse_permission_options(&tool_permission_request());
        assert_eq!(options.len(), 3);
        assert_eq!(options[1].id, "allow");
        assert_eq!(options[1].name, "Allow");
        assert_eq!(options[1].kind, "allow_once");
    }

    #[test]
    fn skips_options_without_an_id() {
        let params = json!({ "options": [{ "kind": "allow_once", "name": "Allow" }] });
        assert!(parse_permission_options(&params).is_empty());
    }

    /// 決定から引くのは `kind`。返すのはエージェントが決めた `id` で、両者は別物。
    #[test]
    fn maps_decision_to_the_agents_own_option_id() {
        let options = parse_permission_options(&tool_permission_request());
        assert_eq!(
            option_for_decision(&options, &ApprovalDecision::Allow).as_deref(),
            Some("allow")
        );
        assert_eq!(
            option_for_decision(&options, &ApprovalDecision::AllowAlways).as_deref(),
            Some("allow_always")
        );
        assert_eq!(
            option_for_decision(&options, &ApprovalDecision::Reject).as_deref(),
            Some("reject")
        );
        assert_eq!(option_for_decision(&options, &ApprovalDecision::Cancel), None);
    }

    /// 該当が無ければ近そうなもので代用しない（呼び出し側が取り消しに落とす）。
    #[test]
    fn no_substitute_when_the_kind_is_not_offered() {
        let options = parse_permission_options(&json!({
            "options": [{ "kind": "allow_always", "name": "Always", "optionId": "always" }]
        }));
        assert_eq!(option_for_decision(&options, &ApprovalDecision::Allow), None);
        assert_eq!(option_for_decision(&options, &ApprovalDecision::Reject), None);
    }

    /// thinking は `agent_thought_chunk` という名前で、本文は ContentBlock に入る。
    /// 以前は `"thought"` / `"thinking"` という存在しない名前を、しかも素の文字列として
    /// 読んでいたので、ACP エージェントの思考が丸ごと捨てられていた（#227）。
    #[test]
    fn thought_chunks_become_appending_reasoning() {
        let events = parse_session_update(&json!({
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "まず前提を確認する" },
            }
        }));
        assert!(matches!(
            events.as_slice(),
            [AgentEvent::Reasoning { summary, append: true, .. }] if summary == "まず前提を確認する"
        ));
    }

    /// plan は毎回全体が来るので置き換える。旧実装は `"plan_update"` という名前と、
    /// ACP が `entries[]` に置く内容を `content` から読もうとしていた。
    #[test]
    fn plan_replaces_and_renders_entries() {
        let events = parse_session_update(&json!({
            "update": {
                "sessionUpdate": "plan",
                "entries": [
                    { "content": "調べる", "status": "completed", "priority": "medium" },
                    { "content": "直す", "status": "in_progress", "priority": "medium" },
                    { "content": "確かめる", "status": "pending", "priority": "medium" },
                ],
            }
        }));
        assert!(matches!(
            events.as_slice(),
            [AgentEvent::Reasoning { summary, append: false, .. }]
                if summary == "- [x] 調べる\n- [ ] **直す**\n- [ ] 確かめる"
        ));
    }

    #[test]
    fn empty_plan_emits_nothing() {
        let events = parse_session_update(&json!({
            "update": { "sessionUpdate": "plan", "entries": [] }
        }));
        assert!(events.is_empty());
    }

    /// ツール項目の `data` は、UI が読むキー（`command` / `output` / `filePath`）に
    /// 寄せる。生の更新をそのまま渡していたころは、コマンド名も出力も出なかった。
    #[test]
    fn tool_call_data_maps_to_ui_keys() {
        let started = tool_call_data(&json!({
            "toolCallId": "t1",
            "title": "ls -la",
            "kind": "execute",
            "rawInput": { "command": "ls -la" },
        }));
        assert_eq!(started["command"], json!("ls -la"));
        assert_eq!(started.get("output"), None);

        // 完了の更新は status と content だけで、title もツール名も無い。
        let completed = tool_call_data(&json!({
            "toolCallId": "t1",
            "status": "completed",
            "content": [
                { "type": "content", "content": { "type": "text", "text": "total 0" } },
                { "type": "terminal", "terminalId": "x" },
            ],
        }));
        assert_eq!(completed["output"], json!("total 0"));
    }

    /// 最初のツール呼び出しは入力が流れきる前に来る。Bash の `title` はまだ
    /// "Terminal"（アダプタのフォールバック）なので、コマンドとして採らない。
    /// 本当のコマンドは、あとから来る更新の `rawInput` で上書きされる。
    #[test]
    fn title_is_not_taken_as_the_command() {
        let streaming = tool_call_data(&json!({ "title": "Terminal", "kind": "execute" }));
        assert_eq!(streaming.get("command"), None);
        assert_eq!(streaming["title"], json!("Terminal"));

        let refined = tool_call_data(&json!({
            "title": "npm test",
            "kind": "execute",
            "rawInput": { "command": "npm test" },
        }));
        assert_eq!(refined["command"], json!("npm test"));
    }

    #[test]
    fn file_path_comes_from_raw_input_or_locations() {
        let edit = tool_call_data(&json!({
            "title": "Write src/main.rs",
            "kind": "edit",
            "locations": [{ "path": "/w/src/main.rs" }],
        }));
        assert_eq!(edit.get("command"), None);
        assert_eq!(edit["filePath"], json!("/w/src/main.rs"));
    }

    /// 振り分けは ACP の `kind`。ツールの呼び名では分岐しない（そもそも届かない）。
    #[test]
    fn item_type_comes_from_the_acp_kind() {
        assert_eq!(item_type_for(&json!({ "kind": "execute" })), "commandExecution");
        assert_eq!(item_type_for(&json!({ "kind": "edit" })), "fileChange");
        assert_eq!(item_type_for(&json!({ "kind": "delete" })), "fileChange");
        assert_eq!(item_type_for(&json!({ "kind": "read" })), "read");
        assert_eq!(item_type_for(&json!({ "title": "Bash" })), "other");
    }
}
