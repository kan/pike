//! Global agent state: maps window labels to active agent sessions.

use std::collections::HashMap;
use std::sync::Arc;

use super::types::AgentRuntime;

/// Per-window agent session.
#[allow(dead_code)]
pub struct AgentSession {
    /// The runtime powering this session.
    pub runtime: Arc<dyn AgentRuntime>,
    /// Human-readable agent type (e.g. "codex", "claude-code").
    pub agent_type: String,
}

/// Global state managing agent sessions across all windows.
/// Uses tokio::sync::Mutex because lock guards are held across await points.
pub struct AgentState {
    pub sessions: Arc<tokio::sync::Mutex<HashMap<String, AgentSession>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

impl AgentState {
    /// Get the runtime for a window, or return an error.
    pub async fn get_runtime(
        &self,
        window_id: &str,
    ) -> Result<Arc<dyn AgentRuntime>, String> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(window_id)
            .map(|s| s.runtime.clone())
            .ok_or_else(|| "No active agent session".to_string())
    }

    /// Insert a new session, shutting down any existing one for this window.
    pub async fn insert(
        &self,
        window_id: String,
        session: AgentSession,
    ) {
        let mut sessions = self.sessions.lock().await;
        if let Some(old) = sessions.remove(&window_id) {
            let _ = old.runtime.shutdown().await;
        }
        sessions.insert(window_id, session);
    }

    /// Remove and shut down a session.
    pub async fn remove(&self, window_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(old) = sessions.remove(window_id) {
            let _ = old.runtime.shutdown().await;
        }
    }

    /// Shut down all sessions (called on app exit).
    #[allow(dead_code)]
    pub async fn shutdown_all(&self) {
        let mut sessions = self.sessions.lock().await;
        for (_, session) in sessions.drain() {
            let _ = session.runtime.shutdown().await;
        }
    }
}
