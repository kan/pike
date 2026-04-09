use serde::{Deserialize, Serialize};

/// Items that appear within a Codex thread turn.
/// Unknown item types are preserved as `Unknown` with their raw JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum ThreadItem {
    /// Agent text response.
    #[serde(rename = "agentMessage")]
    AgentMessage {
        id: String,
        #[serde(default)]
        content: String,
        #[serde(flatten)]
        extra: serde_json::Value,
    },

    /// Shell command execution.
    #[serde(rename = "commandExecution")]
    CommandExecution {
        id: String,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        exit_code: Option<i32>,
        #[serde(flatten)]
        extra: serde_json::Value,
    },

    /// File modification.
    #[serde(rename = "fileChange")]
    FileChange {
        id: String,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        diff: Option<String>,
        #[serde(flatten)]
        extra: serde_json::Value,
    },

    /// Agent's internal plan.
    #[serde(rename = "todoList")]
    TodoList {
        id: String,
        #[serde(flatten)]
        extra: serde_json::Value,
    },

    /// Reasoning summary.
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        #[serde(default)]
        summary: Option<String>,
        #[serde(flatten)]
        extra: serde_json::Value,
    },

    /// Catch-all for unknown item types — preserved as raw JSON.
    #[serde(untagged)]
    Unknown(serde_json::Value),
}
