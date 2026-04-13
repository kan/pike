use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::messages::*;
use crate::codex::runtime::CodexRuntime;

/// Type alias for the pending request map to keep clippy happy.
type PendingMap = HashMap<u64, oneshot::Sender<Result<serde_json::Value, JsonRpcErrorData>>>;

/// A server-initiated request that the client must respond to.
#[derive(Debug)]
#[allow(dead_code)]
pub struct ServerRequest {
    pub id: RequestId,
    pub method: String,
    pub params: serde_json::Value,
}

/// A server-initiated notification.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ServerNotification {
    pub method: String,
    pub params: serde_json::Value,
}

/// Bidirectional JSON-RPC client for the Codex app-server.
///
/// Manages:
/// - A writer task that sends JSON lines to the child's stdin
/// - A reader task that parses JSON lines from stdout and dispatches them
/// - A stderr task that logs the child's stderr output
#[allow(dead_code)]
pub struct AppServerClient {
    /// Channel to send serialized JSON lines to the writer task.
    stdin_tx: mpsc::Sender<String>,
    /// Monotonically increasing request ID counter.
    next_id: AtomicU64,
    /// Pending request responses keyed by request ID.
    pending: Arc<Mutex<PendingMap>>,
    /// Channel for server notifications (unbounded to avoid dropping messages).
    notification_tx: mpsc::UnboundedSender<ServerNotification>,
    /// Receiver slot for notifications (taken once by the forwarder).
    notification_rx_slot: Arc<Mutex<Option<mpsc::UnboundedReceiver<ServerNotification>>>>,
    /// Channel for server-initiated requests (approval etc.).
    server_request_tx: mpsc::Sender<ServerRequest>,
    /// For creating new receivers for server requests.
    server_request_rx_factory: Arc<Mutex<Option<mpsc::Receiver<ServerRequest>>>>,
    /// Handle to the child process for cleanup.
    child_handle: Arc<Mutex<Option<tokio::process::Child>>>,
    /// Handles for the spawned tasks.
    task_handles: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl AppServerClient {
    /// Spawn the Codex app-server, establish JSON-RPC communication, and perform
    /// the initialize handshake.
    pub async fn connect(runtime: &dyn CodexRuntime, working_dir: &str) -> Result<Self, String> {
        log::info!("[codex] Spawning app-server for working_dir={working_dir}");
        let mut child = runtime.spawn_app_server(working_dir)?;
        log::info!("[codex] App-server process spawned (pid={:?})", child.id());

        let stdin = child.stdin.take().ok_or("Failed to get child stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get child stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get child stderr")?;

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
        let (notification_tx, notification_rx) = mpsc::unbounded_channel::<ServerNotification>();
        let (server_request_tx, server_request_rx) = mpsc::channel::<ServerRequest>(32);

        let mut task_handles = Vec::new();

        // Writer task: sends JSON lines to child stdin
        let writer_handle = tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = stdin_rx.recv().await {
                if let Err(e) = stdin.write_all(line.as_bytes()).await {
                    log::error!("[codex-writer] Failed to write to stdin: {e}");
                    break;
                }
                if let Err(e) = stdin.write_all(b"\n").await {
                    log::error!("[codex-writer] Failed to write newline: {e}");
                    break;
                }
                if let Err(e) = stdin.flush().await {
                    log::error!("[codex-writer] Failed to flush stdin: {e}");
                    break;
                }
            }
            log::debug!("[codex-writer] Writer task exiting");
        });
        task_handles.push(writer_handle);

        // Reader task: reads JSON lines from child stdout and dispatches
        let pending_clone = pending.clone();
        let notif_tx = notification_tx.clone();
        let srv_req_tx = server_request_tx.clone();
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
                            let truncate_at = line.char_indices()
                                .map(|(i, _)| i)
                                .take_while(|&i| i <= 200)
                                .last()
                                .unwrap_or(0);
                            log::debug!("[codex-reader] <- {}… ({} bytes)", &line[..truncate_at], line.len());
                        } else {
                            log::debug!("[codex-reader] <- {line}");
                        }
                        let value: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("[codex-reader] Failed to parse JSON: {e} — line: {line}");
                                continue;
                            }
                        };
                        match parse_incoming(value) {
                            Ok(IncomingMessage::Response { id, result }) => {
                                if let RequestId::Num(n) = id {
                                    let mut map = pending_clone.lock().await;
                                    if let Some(tx) = map.remove(&n) {
                                        let _ = tx.send(Ok(result));
                                    }
                                }
                            }
                            Ok(IncomingMessage::Error { id, error }) => {
                                log::warn!("[codex-reader] Error response: {error}");
                                if let RequestId::Num(n) = id {
                                    let mut map = pending_clone.lock().await;
                                    if let Some(tx) = map.remove(&n) {
                                        let _ = tx.send(Err(error));
                                    }
                                }
                            }
                            Ok(IncomingMessage::ServerRequest { id, method, params }) => {
                                log::debug!("[codex-reader] Server request: {method} (id={id:?})");
                                if let Err(e) = srv_req_tx.send(ServerRequest { id, method, params }).await {
                                    log::error!("[codex-reader] Failed to forward server request: {e}");
                                }
                            }
                            Ok(IncomingMessage::Notification { method, params }) => {
                                log::debug!("[codex-reader] Notification: {method}");
                                if let Err(e) = notif_tx.send(ServerNotification { method: method.clone(), params }) {
                                    log::warn!("[codex-reader] No notification subscribers for {method}: {e}");
                                }
                            }
                            Err(e) => {
                                log::warn!("[codex-reader] Unrecognized message: {e}");
                            }
                        }
                    }
                    Ok(None) => {
                        log::info!("[codex-reader] Stdout EOF — app-server process ended");
                        break;
                    }
                    Err(e) => {
                        log::error!("[codex-reader] Error reading stdout: {e}");
                        break;
                    }
                }
            }
        });
        task_handles.push(reader_handle);

        // Stderr task: logs the child's stderr output
        let stderr_handle = tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        log::debug!("[codex-stderr] {line}");
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::error!("[codex-stderr] Error reading: {e}");
                        break;
                    }
                }
            }
        });
        task_handles.push(stderr_handle);

        let client = Self {
            stdin_tx,
            next_id: AtomicU64::new(1),
            pending,
            notification_tx,
            notification_rx_slot: Arc::new(Mutex::new(Some(notification_rx))),
            server_request_tx,
            server_request_rx_factory: Arc::new(Mutex::new(Some(server_request_rx))),
            child_handle: Arc::new(Mutex::new(Some(child))),
            task_handles: Arc::new(Mutex::new(task_handles)),
        };

        // Perform initialize handshake with timeout
        let init_params = InitializeParams {
            client_info: ClientInfo {
                name: "pike".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            capabilities: None,
        };

        log::info!("[codex] Sending initialize request...");
        let result: InitializeResult = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            client.request("initialize", &init_params),
        )
        .await
        .map_err(|_| "Initialize handshake timed out after 15s — is codex app-server running?".to_string())?
        ?;
        log::info!(
            "[codex] Initialize complete — userAgent: {:?}",
            result.user_agent
        );

        // Send initialized notification
        client.notify("initialized", &serde_json::Value::Null).await?;

        Ok(client)
    }

    /// Send a JSON-RPC request and wait for the response.
    pub async fn request<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<R, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();

        {
            let mut map = self.pending.lock().await;
            map.insert(id, tx);
        }

        let request = JsonRpcRequest {
            id: RequestId::Num(id),
            method: method.to_string(),
            params: Some(serde_json::to_value(params).map_err(|e| format!("Serialize error: {e}"))?),
        };

        let json = serde_json::to_string(&request).map_err(|e| format!("Serialize error: {e}"))?;
        log::trace!("[codex-client] -> {json}");

        self.stdin_tx
            .send(json)
            .await
            .map_err(|_| "Failed to send to stdin — channel closed".to_string())?;

        let result = rx.await.map_err(|_| "Request cancelled — channel dropped".to_string())?;

        match result {
            Ok(value) => {
                serde_json::from_value(value).map_err(|e| format!("Deserialize response error: {e}"))
            }
            Err(err) => Err(err.to_string()),
        }
    }

    /// Send a JSON-RPC notification (no response expected).
    pub async fn notify<P: serde::Serialize>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<(), String> {
        let notification = JsonRpcNotification {
            method: method.to_string(),
            params: Some(serde_json::to_value(params).map_err(|e| format!("Serialize error: {e}"))?),
        };

        let json = serde_json::to_string(&notification).map_err(|e| format!("Serialize error: {e}"))?;
        log::trace!("[codex-client] -> {json}");

        self.stdin_tx
            .send(json)
            .await
            .map_err(|_| "Failed to send notification — channel closed".to_string())
    }

    /// Take the notification receiver. Can only be called once.
    #[allow(dead_code)]
    pub async fn take_notifications(&self) -> Option<mpsc::UnboundedReceiver<ServerNotification>> {
        self.notification_rx_slot.lock().await.take()
    }

    /// Take the server request receiver. Can only be called once.
    #[allow(dead_code)]
    pub async fn take_server_requests(&self) -> Option<mpsc::Receiver<ServerRequest>> {
        self.server_request_rx_factory.lock().await.take()
    }

    /// Respond to a server-initiated request.
    #[allow(dead_code)]
    pub async fn respond_to_server(
        &self,
        id: RequestId,
        result: serde_json::Value,
    ) -> Result<(), String> {
        let response = JsonRpcResponse { id, result };
        let json = serde_json::to_string(&response).map_err(|e| format!("Serialize error: {e}"))?;
        log::trace!("[codex-client] -> {json}");

        self.stdin_tx
            .send(json)
            .await
            .map_err(|_| "Failed to send response — channel closed".to_string())
    }

    /// Shut down the client: kill the child process and abort tasks.
    pub async fn shutdown(&self) {
        // Kill child process
        if let Some(mut child) = self.child_handle.lock().await.take() {
            let _ = child.kill().await;
            log::debug!("[codex] Child process killed");
        }

        // Abort tasks
        let handles: Vec<_> = {
            let mut guards = self.task_handles.lock().await;
            guards.drain(..).collect()
        };
        for h in handles {
            h.abort();
        }
        log::debug!("[codex] All tasks aborted");
    }

}
