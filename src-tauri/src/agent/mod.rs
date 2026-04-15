//! Agent runtime abstraction layer.
//!
//! This module defines the `AgentRuntime` trait that abstracts over different
//! AI coding agent backends (Codex app-server, ACP protocol, etc.), allowing
//! the Pike UI to work with any backend through a uniform interface.
//!
//! # Architecture
//!
//! ```text
//! Vue/TS UI ──(Tauri IPC)──► agent commands ──► AgentRuntime trait
//!                                                  ├── CodexAppServerRuntime (Codex app-server protocol)
//!                                                  └── ACPRuntime (ACP JSON-RPC over stdio)
//! ```
//!
//! Events flow back from runtimes to the UI via `AgentEvent` emitted as Tauri events.

pub mod types;
pub mod commands;
pub mod codex_runtime;
pub mod acp_runtime;
pub mod state;
