//! Core types for the agent runtime abstraction.
//!
//! # Design Decisions
//!
//! ## AgentRuntime trait
//! Methods are extracted from the actual operations the UI performs on the Codex
//! backend. Each method maps 1:1 to a user-visible action. Protocol-specific
//! details (thread IDs, sandbox policies) are encapsulated in `SessionConfig`
//! and runtime-specific config structs — the trait surface stays minimal.
//!
//! ## AgentEvent enum
//! Variants cover the union of Codex app-server notifications and ACP
//! `session/update` events. Approval payloads carry `serde_json::Value` so the
//! UI can display runtime-specific details without the trait needing to model
//! every protocol's approval schema.
//!
//! ## AgentCapabilities
//! Runtimes declare what they support so the UI can conditionally show controls
//! (e.g. hide "Sandbox" dropdown for ACP agents that don't expose sandbox config).

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

/// Configuration for starting an agent session.
/// Runtime implementations interpret these fields according to their protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    /// Working directory (host path — runtime translates as needed).
    pub cwd: String,
    /// Resume an existing session/thread by ID, if supported.
    pub resume_session_id: Option<String>,
    /// Sandbox mode override (Codex-specific; ignored by runtimes that don't support it).
    pub sandbox_mode: Option<String>,
    /// Approval policy override (Codex-specific; ignored by runtimes that don't support it).
    pub approval_policy: Option<String>,
}

/// Editor context for prompt injection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    pub path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub selection_start: Option<u32>,
    pub selection_end: Option<u32>,
}

// ---------------------------------------------------------------------------
// Agent capabilities
// ---------------------------------------------------------------------------

/// Declares what features a runtime supports so the UI can adapt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    /// Human-readable name for this agent type (e.g. "Codex", "Claude Code").
    pub display_name: String,
    /// Whether the runtime supports listing/switching models.
    pub supports_model_selection: bool,
    /// Whether the runtime supports session resumption.
    pub supports_session_resume: bool,
    /// Whether the runtime supports rollback (undo last turn).
    pub supports_rollback: bool,
    /// Whether the runtime supports context compaction.
    pub supports_compact: bool,
    /// Whether the runtime exposes sandbox mode configuration.
    pub supports_sandbox_config: bool,
    /// Whether the runtime exposes approval policy configuration.
    pub supports_approval_config: bool,
    /// Whether the runtime has its own auth flow (Codex ChatGPT OAuth).
    /// If false, auth is handled externally (e.g. claude-agent-acp uses API key).
    pub supports_auth_flow: bool,
}

// ---------------------------------------------------------------------------
// Model info
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub is_default: bool,
}

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

/// Authentication state — shared across runtimes.
/// Codex uses ChatGPT OAuth; ACP agents may use API keys or external auth.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AgentAuthState {
    /// Auth status not yet checked.
    Unknown,
    /// Not authenticated — user needs to log in.
    Unauthenticated,
    /// OAuth flow in progress.
    Authenticating,
    /// Successfully authenticated.
    Authenticated {
        /// Auth method (e.g. "chatgpt", "apiKey", "anthropic").
        mode: String,
        #[serde(rename = "planType")]
        plan_type: Option<String>,
        email: Option<String>,
    },
    /// Auth check failed.
    Error { message: String },
}

// ---------------------------------------------------------------------------
// Approval types
// ---------------------------------------------------------------------------

/// User's decision for an approval request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    /// Allow this one action.
    Allow,
    /// Allow this and similar future actions for this session.
    AllowAlways,
    /// Deny this action.
    Reject,
    /// Cancel the current operation.
    Cancel,
}

// ---------------------------------------------------------------------------
// Agent events (runtime → UI)
// ---------------------------------------------------------------------------

/// Events emitted by agent runtimes, forwarded to the UI as Tauri events.
///
/// This enum covers the union of Codex app-server notifications and ACP
/// `session/update` events. Each variant includes enough information for the
/// UI to render without knowing the underlying protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    /// Streaming text delta from the agent's response.
    MessageDelta {
        delta: String,
        /// Item ID if available (Codex v2 provides this).
        item_id: Option<String>,
    },

    /// A turn (prompt → response cycle) has started.
    TurnStarted,

    /// A turn has completed.
    TurnCompleted,

    /// An action item has started (command execution, file change, reasoning, etc.).
    ItemStarted {
        /// Item type: "commandExecution", "fileChange", "reasoning", "agentMessage", etc.
        item_type: String,
        /// Unique item ID.
        item_id: String,
        /// Additional data — contents vary by item type and protocol.
        /// The UI interprets known fields (command, filePath, summary, etc.)
        /// and can display unknown fields generically.
        data: serde_json::Value,
    },

    /// An action item has completed.
    ItemCompleted {
        item_id: String,
        /// Completion data (exitCode, filePath, additions, deletions, etc.).
        data: serde_json::Value,
    },

    /// Streaming output from a command execution.
    CommandOutputDelta {
        item_id: String,
        delta: String,
    },

    /// Permission/approval request for a command execution.
    ApprovalCommandRequest {
        /// Opaque request ID — passed back to `respond_approval()`.
        request_id: serde_json::Value,
        item_id: String,
        command: Option<String>,
        cwd: Option<String>,
        /// Full original payload from the protocol for runtime-specific UI.
        payload: serde_json::Value,
    },

    /// Permission/approval request for a file change.
    ApprovalFileRequest {
        request_id: serde_json::Value,
        item_id: String,
        file_path: Option<String>,
        reason: Option<String>,
        payload: serde_json::Value,
    },

    /// Generic permission request (ACP `session/request_permission`).
    /// Used when the request doesn't fit command/file categories.
    ApprovalGenericRequest {
        request_id: serde_json::Value,
        tool_name: String,
        tool_arguments: serde_json::Value,
        /// Available options (e.g. ["allow_once", "allow_always", "reject"]).
        options: Vec<String>,
        payload: serde_json::Value,
    },

    /// Authentication state changed.
    AuthUpdated {
        state: AgentAuthState,
    },

    /// Token usage update.
    TokenUsage {
        input: u64,
        output: u64,
        /// ACP may also provide cached token counts.
        cached_read: Option<u64>,
        cached_write: Option<u64>,
    },

    /// Reasoning/thinking content from the agent.
    Reasoning {
        item_id: String,
        summary: Option<String>,
    },

    /// Agent session disconnected.
    Disconnected {
        reason: String,
    },

    /// Session metadata updated (e.g. title set by agent after first turn).
    SessionInfoUpdated {
        title: Option<String>,
    },

    /// Available slash commands from the agent runtime.
    AvailableCommandsUpdated {
        commands: Vec<AgentCommandInfo>,
    },

    /// Non-fatal error from the agent.
    Error {
        message: String,
    },
}

/// Slash command advertised by an agent runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandInfo {
    pub name: String,
    pub description: String,
    pub input_hint: Option<String>,
}

// ---------------------------------------------------------------------------
// AgentRuntime trait
// ---------------------------------------------------------------------------

/// Abstraction over AI coding agent backends.
///
/// Implementations manage:
/// - Subprocess lifecycle (spawn, communicate, kill)
/// - Protocol translation (Codex app-server JSON-RPC, ACP JSON-RPC)
/// - Event forwarding to the UI via the provided `EventEmitter`
///
/// All methods are async and return `Result<T, String>` following Pike's
/// Tauri command convention.
#[allow(dead_code)]
#[async_trait::async_trait]
pub trait AgentRuntime: Send + Sync {
    /// Returns this runtime's capabilities for UI adaptation.
    fn capabilities(&self) -> AgentCapabilities;

    /// Check if the agent binary is available and return its version string.
    async fn check_available(&self) -> Result<String, String>;

    /// Start a new session or resume an existing one.
    /// Returns the session/thread ID.
    async fn start_session(&self, config: SessionConfig) -> Result<String, String>;

    /// Submit a user prompt.
    async fn submit_turn(
        &self,
        prompt: String,
        editor_context: Option<EditorContext>,
        model: Option<String>,
    ) -> Result<(), String>;

    /// Interrupt the current turn.
    async fn interrupt_turn(&self) -> Result<(), String>;

    /// Roll back the last turn (remove last exchange). Optional — check capabilities.
    async fn rollback_turn(&self) -> Result<(), String>;

    /// Compact/summarize the conversation context. Optional — check capabilities.
    async fn compact(&self) -> Result<(), String>;

    /// Respond to an approval request.
    async fn respond_approval(
        &self,
        request_id: serde_json::Value,
        decision: ApprovalDecision,
    ) -> Result<(), String>;

    /// Get current authentication state.
    async fn auth_status(&self) -> Result<AgentAuthState, String>;

    /// Start the authentication flow (e.g. open OAuth URL).
    /// No-op for runtimes where auth is external.
    async fn auth_login(&self) -> Result<(), String>;

    /// Log out. No-op for runtimes where auth is external.
    async fn auth_logout(&self) -> Result<(), String>;

    /// List available models. Returns empty vec if not supported.
    async fn list_models(&self) -> Result<Vec<ModelInfo>, String>;

    /// Shut down the session and kill the subprocess.
    async fn shutdown(&self) -> Result<(), String>;
}

/// Callback interface for runtimes to emit events to the UI.
/// Implementations wrap Tauri's `AppHandle::emit_to()`.
#[async_trait::async_trait]
pub trait EventEmitter: Send + Sync {
    /// Emit an agent event to the target window.
    fn emit(&self, event: AgentEvent);
}
