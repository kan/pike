//! Global agent state: maps tab IDs to active agent sessions.

use std::collections::HashMap;
use std::sync::Arc;

use super::types::AgentRuntime;

/// Per-tab agent session.
#[allow(dead_code)]
pub struct AgentSession {
    /// The runtime powering this session.
    pub runtime: Arc<dyn AgentRuntime>,
    /// Human-readable agent type (e.g. "codex", "claude-code").
    pub agent_type: String,
    /// Window that owns this session (for cleanup on window destroy).
    pub window_label: String,
}

/// Global state managing agent sessions across all windows.
/// Keys are tab IDs (frontend-provided), not window labels.
/// Uses tokio::sync::Mutex because lock guards are held across await points.
#[derive(Clone)]
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
    /// Get the runtime for a tab, or return an error.
    pub async fn get_runtime(
        &self,
        tab_id: &str,
    ) -> Result<Arc<dyn AgentRuntime>, String> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(tab_id)
            .map(|s| s.runtime.clone())
            .ok_or_else(|| "No active agent session".to_string())
    }

    /// Insert a new session, shutting down any existing one for this tab.
    pub async fn insert(
        &self,
        tab_id: String,
        session: AgentSession,
    ) {
        let mut sessions = self.sessions.lock().await;
        if let Some(old) = sessions.remove(&tab_id) {
            let _ = old.runtime.shutdown().await;
        }
        sessions.insert(tab_id, session);
    }

    /// Remove and shut down a session by tab ID.
    pub async fn remove(&self, tab_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(old) = sessions.remove(tab_id) {
            let _ = old.runtime.shutdown().await;
        }
    }

    /// Remove and shut down all sessions belonging to a window.
    pub async fn remove_by_window(&self, window_label: &str) {
        let mut sessions = self.sessions.lock().await;
        let tab_ids: Vec<String> = sessions
            .iter()
            .filter(|(_, s)| s.window_label == window_label)
            .map(|(k, _)| k.clone())
            .collect();
        for tab_id in tab_ids {
            if let Some(old) = sessions.remove(&tab_id) {
                log::info!("[agent] Cleaning up session {tab_id} for window {window_label}");
                let _ = old.runtime.shutdown().await;
            }
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
