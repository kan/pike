use serde::{Deserialize, Serialize};
use serde_json::json;

use super::protocol::client::AppServerClient;

/// Authentication state for the Codex session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AuthState {
    Unknown,
    Unauthenticated,
    AuthenticatingChatGpt,
    Authenticated {
        mode: String,
        #[serde(rename = "planType")]
        plan_type: Option<String>,
        email: Option<String>,
    },
    Error {
        message: String,
    },
}

/// Response from `account/read`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountReadResponse {
    account: Option<AccountInfo>,
    #[allow(dead_code)]
    requires_openai_auth: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum AccountInfo {
    #[serde(rename = "apiKey")]
    ApiKey,
    #[serde(rename = "chatgpt")]
    ChatGpt {
        email: String,
        #[serde(rename = "planType")]
        plan_type: String,
    },
}

/// Response from `account/login/start`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginStartResponse {
    url: Option<String>,
}

/// Check the current authentication status via `account/read`.
pub async fn check_auth_status(client: &AppServerClient) -> Result<AuthState, String> {
    let resp: AccountReadResponse = client.request("account/read", &json!({})).await?;
    match resp.account {
        Some(AccountInfo::ChatGpt { email, plan_type }) => Ok(AuthState::Authenticated {
            mode: "chatgpt".to_string(),
            plan_type: Some(plan_type),
            email: Some(email),
        }),
        Some(AccountInfo::ApiKey) => Ok(AuthState::Authenticated {
            mode: "apiKey".to_string(),
            plan_type: None,
            email: None,
        }),
        None => Ok(AuthState::Unauthenticated),
    }
}

/// Start the ChatGPT OAuth login flow. Returns the URL to open in the browser, if any.
pub async fn start_chatgpt_login(client: &AppServerClient) -> Result<Option<String>, String> {
    let resp: LoginStartResponse = client
        .request("account/login/start", &json!({ "type": "chatgpt" }))
        .await?;
    Ok(resp.url)
}

/// Log out of the current account.
pub async fn logout(client: &AppServerClient) -> Result<(), String> {
    let _: serde_json::Value = client.request("account/logout", &json!({})).await?;
    Ok(())
}

