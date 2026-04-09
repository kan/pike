use serde::{Deserialize, Serialize};

/// User's decision for an approval request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

impl ApprovalDecision {
    /// Convert to the JSON value expected by the Codex app-server.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Accept => serde_json::json!({ "decision": "accept" }),
            Self::AcceptForSession => serde_json::json!({ "decision": "acceptForSession" }),
            Self::Decline => serde_json::json!({ "decision": "decline" }),
            Self::Cancel => serde_json::json!({ "decision": "cancel" }),
        }
    }
}
