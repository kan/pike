use serde::{Deserialize, Serialize};

/// JSON-RPC request ID — can be either a number or a string.
/// Codex app-server uses integer IDs, but we support both per spec.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(untagged)]
pub enum RequestId {
    Num(u64),
    Str(String),
}

/// Outgoing JSON-RPC request (client → server).
#[derive(Debug, Serialize)]
pub struct JsonRpcRequest {
    pub id: RequestId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// Outgoing JSON-RPC notification (client → server, no response expected).
#[derive(Debug, Serialize)]
pub struct JsonRpcNotification {
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// Outgoing JSON-RPC response (client → server, replying to a server request).
#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct JsonRpcResponse {
    pub id: RequestId,
    pub result: serde_json::Value,
}

/// Error data inside a JSON-RPC error response.
#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcErrorData {
    pub code: i64,
    pub message: String,
    #[allow(dead_code)]
    pub data: Option<serde_json::Value>,
}

impl std::fmt::Display for JsonRpcErrorData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JSON-RPC error {}: {}", self.code, self.message)
    }
}

// ---------------------------------------------------------------------------
// Initialize handshake types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<InitializeCapabilities>,
}

#[derive(Debug, Serialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experimental_api: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub user_agent: Option<String>,
}

// ---------------------------------------------------------------------------
// Incoming message parsing
// ---------------------------------------------------------------------------

/// Discriminated incoming JSON-RPC message from the Codex app-server.
#[derive(Debug)]
pub enum IncomingMessage {
    /// Response to a client request (has id + result).
    Response {
        id: RequestId,
        result: serde_json::Value,
    },
    /// Error response to a client request (has id + error).
    Error {
        id: RequestId,
        error: JsonRpcErrorData,
    },
    /// Server-initiated request (has id + method) — requires a response.
    ServerRequest {
        id: RequestId,
        method: String,
        params: serde_json::Value,
    },
    /// Server-initiated notification (has method, no id).
    Notification {
        method: String,
        params: serde_json::Value,
    },
}

/// Parse a raw JSON value into an IncomingMessage.
/// Dispatches based on the presence of `id`, `method`, `result`, `error` fields.
pub fn parse_incoming(value: serde_json::Value) -> Result<IncomingMessage, String> {
    let obj = value.as_object().ok_or("Expected JSON object")?;

    let has_id = obj.contains_key("id");
    let has_method = obj.contains_key("method");
    let has_result = obj.contains_key("result");
    let has_error = obj.contains_key("error");

    if has_id && has_method {
        // Server request
        let id: RequestId = serde_json::from_value(obj["id"].clone())
            .map_err(|e| format!("Invalid request id: {e}"))?;
        let method = obj["method"]
            .as_str()
            .ok_or("method must be a string")?
            .to_string();
        let params = obj.get("params").cloned().unwrap_or(serde_json::Value::Null);
        Ok(IncomingMessage::ServerRequest { id, method, params })
    } else if has_id && has_error {
        // Error response
        let id: RequestId = serde_json::from_value(obj["id"].clone())
            .map_err(|e| format!("Invalid request id: {e}"))?;
        let error: JsonRpcErrorData = serde_json::from_value(obj["error"].clone())
            .map_err(|e| format!("Invalid error data: {e}"))?;
        Ok(IncomingMessage::Error { id, error })
    } else if has_id && has_result {
        // Success response
        let id: RequestId = serde_json::from_value(obj["id"].clone())
            .map_err(|e| format!("Invalid request id: {e}"))?;
        let result = obj["result"].clone();
        Ok(IncomingMessage::Response { id, result })
    } else if has_method && !has_id {
        // Notification
        let method = obj["method"]
            .as_str()
            .ok_or("method must be a string")?
            .to_string();
        let params = obj.get("params").cloned().unwrap_or(serde_json::Value::Null);
        Ok(IncomingMessage::Notification { method, params })
    } else {
        Err(format!("Unrecognized JSON-RPC message shape: {value}"))
    }
}
