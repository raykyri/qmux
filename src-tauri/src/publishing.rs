use crate::{persistence, state::AppState};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const GITHUB_API_VERSION: &str = "2026-03-10";
const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_AGENT: &str = "qmux-publisher";
const KEYCHAIN_SERVICE: &str = "app.qmux.github-oauth";
const KEYCHAIN_ACCOUNT: &str = "github";
const PUBLICATIONS_FILE: &str = "publications.json";
const PUBLICATION_INDEX_FILE: &str = "publication.json";
const PUBLICATION_README_FILE: &str = "README.md";
const MAX_PUBLICATION_FILES: usize = 250;
const MAX_PUBLICATION_FILE_BYTES: usize = 10_000_000;
const MAX_PUBLICATION_TOTAL_BYTES: usize = 12_000_000;

static PUBLICATIONS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishingAuthStatus {
    configured: bool,
    connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    login: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishingDeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_at: u64,
    interval_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PublishingAuthPollResult {
    Pending {
        #[serde(rename = "intervalSeconds")]
        interval_seconds: u64,
    },
    Connected {
        account: PublishingAuthStatus,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationSource {
    kind: String,
    #[serde(flatten)]
    detail: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPublicationRequest {
    publication_id: String,
    title: String,
    is_public: bool,
    files: BTreeMap<String, String>,
    source: PublicationSource,
    #[serde(default)]
    public_node_ids: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationBinding {
    publication_id: String,
    gist_id: String,
    gist_url: String,
    share_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_login: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    is_public: bool,
    source: PublicationSource,
    #[serde(default)]
    public_node_ids: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationStore {
    #[serde(default = "publication_store_version")]
    version: u32,
    #[serde(default)]
    bindings: Vec<PublicationBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredCredential {
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    login: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default = "default_poll_interval")]
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct AccessTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GitHubGist {
    id: String,
    html_url: String,
    #[serde(default)]
    owner: Option<GitHubUser>,
    #[serde(default)]
    history: Vec<GitHubGistRevision>,
}

#[derive(Debug, Deserialize)]
struct GitHubGistRevision {
    version: String,
}

#[derive(Serialize)]
struct CreateGistRequest<'a> {
    description: String,
    public: bool,
    files: BTreeMap<&'a str, CreateGistFile<'a>>,
}

#[derive(Serialize)]
struct CreateGistFile<'a> {
    content: &'a str,
}

#[tauri::command]
pub async fn publishing_auth_status() -> Result<PublishingAuthStatus, String> {
    auth_status()
}

#[tauri::command]
pub async fn publishing_auth_begin() -> Result<PublishingDeviceAuthorization, String> {
    let client_id = github_client_id().ok_or_else(|| {
        "GitHub publishing is not configured. Set QMUX_GITHUB_CLIENT_ID when building qmux."
            .to_string()
    })?;
    let client = http_client()?;
    let response = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", "gist")])
        .send()
        .await
        .map_err(|error| github_request_error("start GitHub authorization", error))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("failed to read GitHub authorization response: {error}"))?;
    if !status.is_success() {
        return Err(github_response_error(
            "start GitHub authorization",
            status,
            &body,
        ));
    }
    let authorization: DeviceCodeResponse = serde_json::from_str(&body)
        .map_err(|error| format!("invalid GitHub authorization response: {error}"))?;
    Ok(PublishingDeviceAuthorization {
        device_code: authorization.device_code,
        user_code: authorization.user_code,
        verification_uri: authorization.verification_uri,
        expires_at: now_millis().saturating_add(authorization.expires_in.saturating_mul(1_000)),
        interval_seconds: authorization.interval.max(1),
    })
}

#[tauri::command]
pub async fn publishing_auth_poll(device_code: String) -> Result<PublishingAuthPollResult, String> {
    let client_id = github_client_id().ok_or_else(|| {
        "GitHub publishing is not configured. Set QMUX_GITHUB_CLIENT_ID when building qmux."
            .to_string()
    })?;
    if device_code.trim().is_empty() || device_code.len() > 512 {
        return Err("GitHub device code is invalid.".to_string());
    }
    let client = http_client()?;
    let response = client
        .post(GITHUB_ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.trim()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|error| github_request_error("complete GitHub authorization", error))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("failed to read GitHub token response: {error}"))?;
    if !status.is_success() {
        return Err(github_response_error(
            "complete GitHub authorization",
            status,
            &body,
        ));
    }
    let token_response: AccessTokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("invalid GitHub token response: {error}"))?;
    if let Some(error) = token_response.error.as_deref() {
        return match error {
            "authorization_pending" => Ok(PublishingAuthPollResult::Pending {
                interval_seconds: token_response.interval.unwrap_or(5).max(1),
            }),
            "slow_down" => Ok(PublishingAuthPollResult::Pending {
                interval_seconds: token_response.interval.unwrap_or(10).saturating_add(5),
            }),
            "expired_token" => {
                Err("The GitHub authorization code expired. Start again.".to_string())
            }
            "access_denied" => Err("GitHub authorization was denied.".to_string()),
            _ => Err(token_response
                .error_description
                .unwrap_or_else(|| format!("GitHub authorization failed: {error}"))),
        };
    }
    let access_token = token_response
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "GitHub did not return an access token.".to_string())?;
    if !has_gist_scope(token_response.scope.as_deref()) {
        return Err("GitHub authorization did not grant the required gist scope.".to_string());
    }
    let user = fetch_github_user(&client, &access_token).await?;
    let credential = StoredCredential {
        access_token,
        login: Some(user.login.clone()),
        scope: token_response.scope,
    };
    save_stored_credential(&credential)?;
    Ok(PublishingAuthPollResult::Connected {
        account: PublishingAuthStatus {
            configured: true,
            connected: true,
            login: Some(user.login),
            expires_at: None,
        },
    })
}

#[tauri::command]
pub async fn publishing_auth_disconnect() -> Result<PublishingAuthStatus, String> {
    delete_stored_credential()?;
    auth_status()
}

#[tauri::command]
pub async fn publishing_publish(
    state: tauri::State<'_, AppState>,
    request: PublishPublicationRequest,
) -> Result<PublicationBinding, String> {
    validate_publish_request(&request)?;
    let token = github_access_token()?
        .ok_or_else(|| "Connect a GitHub account before publishing this content.".to_string())?;
    let workspace_root = state.config().workspace_root.clone();
    let client = http_client()?;
    let files = request
        .files
        .iter()
        .map(|(name, content)| {
            (
                name.as_str(),
                CreateGistFile {
                    content: content.as_str(),
                },
            )
        })
        .collect();
    let payload = CreateGistRequest {
        description: format!("{} — published with qmux", request.title.trim()),
        public: request.is_public,
        files,
    };
    let response = client
        .post(format!("{GITHUB_API_BASE}/gists"))
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("User-Agent", GITHUB_USER_AGENT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .json(&payload)
        .send()
        .await
        .map_err(|error| github_request_error("publish Gist", error))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("failed to read GitHub Gist response: {error}"))?;
    if !status.is_success() {
        return Err(github_response_error("publish Gist", status, &body));
    }
    let gist: GitHubGist = serde_json::from_str(&body)
        .map_err(|error| format!("invalid GitHub Gist response: {error}"))?;
    let now = now_millis();
    let mut binding = PublicationBinding {
        publication_id: request.publication_id,
        gist_id: gist.id.clone(),
        gist_url: gist.html_url,
        share_url: format!("{}/p/{}", share_base_url(), gist.id),
        owner_login: gist.owner.map(|owner| owner.login).or(token.login),
        revision: gist
            .history
            .first()
            .map(|revision| revision.version.clone()),
        is_public: request.is_public,
        source: request.source,
        public_node_ids: request.public_node_ids,
        warning: None,
        created_at: now,
        updated_at: now,
    };
    if let Err(error) = upsert_publication_binding(&workspace_root, &binding) {
        binding.warning = Some(format!(
            "The Gist was created, but qmux could not save its local publication binding: {error}"
        ));
    }
    Ok(binding)
}

#[tauri::command(async)]
pub fn publishing_list(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PublicationBinding>, String> {
    Ok(load_publication_store(&state.config().workspace_root)?.bindings)
}

fn auth_status() -> Result<PublishingAuthStatus, String> {
    let configured = github_client_id().is_some() || environment_credential().is_some();
    let credential = github_access_token()?;
    Ok(PublishingAuthStatus {
        configured,
        connected: credential.is_some(),
        login: credential.and_then(|value| value.login),
        expires_at: None,
    })
}

fn github_client_id() -> Option<String> {
    std::env::var("QMUX_GITHUB_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("QMUX_GITHUB_CLIENT_ID").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn share_base_url() -> String {
    std::env::var("QMUX_SHARE_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .unwrap_or_else(|| "https://qmux.app".to_string())
}

fn github_access_token() -> Result<Option<StoredCredential>, String> {
    if let Some(credential) = environment_credential() {
        return Ok(Some(credential));
    }
    load_stored_credential()
}

fn environment_credential() -> Option<StoredCredential> {
    std::env::var("QMUX_GITHUB_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|access_token| StoredCredential {
            access_token,
            login: std::env::var("QMUX_GITHUB_LOGIN")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            scope: Some("gist".to_string()),
        })
}

#[cfg(target_os = "macos")]
fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("failed to access macOS Keychain: {error}"))
}

#[cfg(target_os = "macos")]
fn load_stored_credential() -> Result<Option<StoredCredential>, String> {
    match keychain_entry()?.get_password() {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| format!("invalid GitHub credential in macOS Keychain: {error}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "failed to read GitHub credential from macOS Keychain: {error}"
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn load_stored_credential() -> Result<Option<StoredCredential>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn save_stored_credential(credential: &StoredCredential) -> Result<(), String> {
    let raw = serde_json::to_string(credential)
        .map_err(|error| format!("failed to encode GitHub credential: {error}"))?;
    keychain_entry()?
        .set_password(&raw)
        .map_err(|error| format!("failed to save GitHub credential to macOS Keychain: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn save_stored_credential(_credential: &StoredCredential) -> Result<(), String> {
    Err("Secure GitHub credential storage is currently available on macOS only.".to_string())
}

#[cfg(target_os = "macos")]
fn delete_stored_credential() -> Result<(), String> {
    match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "failed to remove GitHub credential from macOS Keychain: {error}"
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_stored_credential() -> Result<(), String> {
    Ok(())
}

fn has_gist_scope(scope: Option<&str>) -> bool {
    scope
        .unwrap_or_default()
        .split([',', ' '])
        .map(str::trim)
        .any(|value| value == "gist")
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("failed to build GitHub HTTP client: {error}"))
}

async fn fetch_github_user(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<GitHubUser, String> {
    let response = client
        .get(format!("{GITHUB_API_BASE}/user"))
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", GITHUB_USER_AGENT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .send()
        .await
        .map_err(|error| github_request_error("load GitHub account", error))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("failed to read GitHub account response: {error}"))?;
    if !status.is_success() {
        return Err(github_response_error("load GitHub account", status, &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("invalid GitHub account response: {error}"))
}

fn github_request_error(action: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("GitHub timed out while trying to {action}.")
    } else {
        format!("Failed to {action}: {error}")
    }
}

fn github_response_error(action: &str, status: StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("GitHub request failed")
                .to_string()
        });
    match status {
        StatusCode::UNAUTHORIZED => {
            "GitHub rejected the saved credential. Disconnect and connect the account again."
                .to_string()
        }
        StatusCode::FORBIDDEN => format!("GitHub refused to {action}: {detail}"),
        _ => format!("Failed to {action} (HTTP {}): {detail}", status.as_u16()),
    }
}

fn validate_publish_request(request: &PublishPublicationRequest) -> Result<(), String> {
    if !valid_public_identifier(&request.publication_id) {
        return Err("publicationId has an invalid format.".to_string());
    }
    let title = request.title.trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err("Publication title must contain 1 to 240 characters.".to_string());
    }
    if request.files.is_empty() || request.files.len() > MAX_PUBLICATION_FILES {
        return Err(format!(
            "A publication must contain between 1 and {MAX_PUBLICATION_FILES} files."
        ));
    }
    if !request.files.contains_key(PUBLICATION_INDEX_FILE)
        || !request.files.contains_key(PUBLICATION_README_FILE)
    {
        return Err(format!(
            "A publication must contain {PUBLICATION_INDEX_FILE} and {PUBLICATION_README_FILE}."
        ));
    }
    let mut total_bytes = 0usize;
    for (name, content) in &request.files {
        if !valid_publication_filename(name) {
            return Err(format!("Publication filename {name:?} is invalid."));
        }
        let bytes = content.len();
        if bytes > MAX_PUBLICATION_FILE_BYTES {
            return Err(format!(
                "{name} exceeds the {MAX_PUBLICATION_FILE_BYTES} byte publication limit."
            ));
        }
        total_bytes = total_bytes.saturating_add(bytes);
    }
    if total_bytes > MAX_PUBLICATION_TOTAL_BYTES {
        return Err(format!(
            "Publication exceeds the {MAX_PUBLICATION_TOTAL_BYTES} byte total limit."
        ));
    }
    let index = request
        .files
        .get(PUBLICATION_INDEX_FILE)
        .expect("required publication index checked above");
    validate_publication_index(index, &request.publication_id, title, &request.files)
}

fn validate_publication_index(
    raw: &str,
    expected_publication_id: &str,
    expected_title: &str,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("{PUBLICATION_INDEX_FILE} is invalid JSON: {error}"))?;
    let root = value
        .as_object()
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} must contain an object."))?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} has an unsupported schema version."
        ));
    }
    if root.get("publicationId").and_then(Value::as_str) != Some(expected_publication_id) {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} does not match the publication being published."
        ));
    }
    if root.get("title").and_then(Value::as_str) != Some(expected_title) {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} does not match the publication title."
        ));
    }
    let supplied_hash = root
        .get("contentHash")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} is missing contentHash."))?;
    let mut unhashed = value.clone();
    unhashed
        .as_object_mut()
        .expect("publication root checked above")
        .remove("contentHash");
    let expected_hash = format!("{:x}", Sha256::digest(canonical_json(&unhashed).as_bytes()));
    if supplied_hash != expected_hash {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} has an invalid content hash."
        ));
    }
    match root.get("kind").and_then(Value::as_str) {
        Some("transcript") => validate_transcript_index(root, files),
        Some("research-answer") | Some("research-tree") => validate_research_index(root, files),
        _ => Err(format!(
            "{PUBLICATION_INDEX_FILE} has an unsupported publication kind."
        )),
    }
}

fn validate_transcript_index(
    root: &serde_json::Map<String, Value>,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    let transcript = root
        .get("transcript")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} is missing transcript metadata."))?;
    let text_file = transcript
        .get("textFile")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} is missing transcript.textFile."))?;
    if text_file != "transcript.txt" || !files.contains_key(text_file) {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} must reference the included transcript.txt file."
        ));
    }
    let messages = transcript
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} is missing transcript.messages."))?;
    if messages.len() > 10_000 {
        return Err(
            "A transcript publication cannot contain more than 10,000 messages.".to_string(),
        );
    }
    for (index, message) in messages.iter().enumerate() {
        let item = message.as_object().ok_or_else(|| {
            format!("{PUBLICATION_INDEX_FILE} transcript message {index} must be an object.")
        })?;
        let role = item.get("role").and_then(Value::as_str);
        if role != Some("user") && role != Some("assistant") {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} transcript message {index} has an invalid role."
            ));
        }
        require_bounded_string(item.get("id"), 256, "transcript message id", false)?;
        require_bounded_string(item.get("label"), 120, "transcript message label", false)?;
        require_bounded_string(
            item.get("text"),
            MAX_PUBLICATION_FILE_BYTES,
            "transcript message text",
            false,
        )?;
    }
    Ok(())
}

fn validate_research_index(
    root: &serde_json::Map<String, Value>,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    let research = root
        .get("research")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} is missing research metadata."))?;
    let root_node_id = research
        .get("rootNodeId")
        .and_then(Value::as_str)
        .filter(|value| valid_public_identifier(value))
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} has an invalid research rootNodeId."))?;
    let selected_node_id = match research.get("selectedNodeId") {
        Some(Value::Null) => None,
        Some(Value::String(value)) if valid_public_identifier(value) => Some(value.as_str()),
        _ => {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} has an invalid research selectedNodeId."
            ));
        }
    };
    let nodes = research
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} is missing research.nodes."))?;
    if nodes.is_empty() || nodes.len() > MAX_PUBLICATION_FILES - 2 {
        return Err(format!(
            "A research publication must contain between 1 and {} nodes.",
            MAX_PUBLICATION_FILES - 2
        ));
    }

    let mut node_ids = HashSet::new();
    let mut parent_by_id = HashMap::<String, Option<String>>::new();
    for (index, node) in nodes.iter().enumerate() {
        let item = node.as_object().ok_or_else(|| {
            format!("{PUBLICATION_INDEX_FILE} research node {index} must be an object.")
        })?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| valid_public_identifier(value))
            .ok_or_else(|| {
                format!("{PUBLICATION_INDEX_FILE} research node {index} has an invalid id.")
            })?;
        if !node_ids.insert(id.to_string()) {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} contains duplicate research node ids."
            ));
        }
        let parent_id = match item.get("parentId") {
            Some(Value::Null) => None,
            Some(Value::String(value)) if valid_public_identifier(value) => Some(value.clone()),
            _ => {
                return Err(format!(
                    "{PUBLICATION_INDEX_FILE} research node {id} has an invalid parentId."
                ));
            }
        };
        parent_by_id.insert(id.to_string(), parent_id);
        if !matches!(
            item.get("kind").and_then(Value::as_str),
            Some("run" | "document")
        ) {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} research node {id} has an invalid kind."
            ));
        }
        require_bounded_string(item.get("title"), 240, "research node title", false)?;
        require_bounded_string(
            item.get("prompt"),
            MAX_PUBLICATION_FILE_BYTES,
            "research node prompt",
            true,
        )?;
        let answer_file = item
            .get("answerFile")
            .and_then(Value::as_str)
            .filter(|value| valid_publication_filename(value))
            .ok_or_else(|| {
                format!("{PUBLICATION_INDEX_FILE} research node {id} has an invalid answerFile.")
            })?;
        let answer = files.get(answer_file).ok_or_else(|| {
            format!("{PUBLICATION_INDEX_FILE} references missing research file {answer_file}.")
        })?;
        let content_hash = item
            .get("contentHash")
            .and_then(Value::as_str)
            .filter(|value| valid_sha256(value))
            .ok_or_else(|| {
                format!("{PUBLICATION_INDEX_FILE} research node {id} has an invalid contentHash.")
            })?;
        let actual_hash = format!("{:x}", Sha256::digest(answer.as_bytes()));
        if content_hash != actual_hash {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} research node {id} does not match {answer_file}."
            ));
        }
        match item.get("responseRevision") {
            Some(Value::Null) => {}
            Some(Value::String(value)) if valid_sha256(value) => {}
            _ => {
                return Err(format!(
                    "{PUBLICATION_INDEX_FILE} research node {id} has an invalid responseRevision."
                ));
            }
        }
        if !matches!(
            item.get("status").and_then(Value::as_str),
            Some("complete" | "failed" | "cancelled")
        ) {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} research node {id} has an invalid status."
            ));
        }
        if !item
            .get("createdAt")
            .and_then(Value::as_f64)
            .is_some_and(|value| value.is_finite() && value >= 0.0)
        {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} research node {id} has an invalid createdAt."
            ));
        }
    }

    if !node_ids.contains(root_node_id) {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} research rootNodeId is not present."
        ));
    }
    if selected_node_id.is_some_and(|id| !node_ids.contains(id)) {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} research selectedNodeId is not present."
        ));
    }
    if parent_by_id.get(root_node_id) != Some(&None) {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} research root must have a null parent."
        ));
    }
    for (id, parent_id) in &parent_by_id {
        if id == root_node_id {
            continue;
        }
        let Some(parent_id) = parent_id else {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} research node {id} is disconnected from the root."
            ));
        };
        if !node_ids.contains(parent_id) {
            return Err(format!(
                "{PUBLICATION_INDEX_FILE} research node {id} has an unknown parent."
            ));
        }
    }
    let mut children_by_parent = HashMap::<String, Vec<String>>::new();
    for (id, parent_id) in &parent_by_id {
        if let Some(parent_id) = parent_id {
            children_by_parent
                .entry(parent_id.clone())
                .or_default()
                .push(id.clone());
        }
    }
    let mut reachable = HashSet::new();
    let mut pending = vec![root_node_id.to_string()];
    while let Some(id) = pending.pop() {
        if !reachable.insert(id.clone()) {
            continue;
        }
        if let Some(children) = children_by_parent.get(&id) {
            pending.extend(children.iter().cloned());
        }
    }
    if reachable.len() != node_ids.len() {
        return Err(format!(
            "{PUBLICATION_INDEX_FILE} contains research nodes disconnected from the root."
        ));
    }
    Ok(())
}

fn require_bounded_string(
    value: Option<&Value>,
    max_bytes: usize,
    label: &str,
    allow_empty: bool,
) -> Result<(), String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{PUBLICATION_INDEX_FILE} has an invalid {label}."))?;
    if (!allow_empty && value.is_empty()) || value.len() > max_bytes {
        return Err(format!("{PUBLICATION_INDEX_FILE} has an invalid {label}."));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_public_identifier(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_publication_filename(value: &str) -> bool {
    (1..=120).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-'
        })
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("JSON string serialization"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let entries = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key serialization"),
                        canonical_json(&values[key])
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", entries.join(","))
        }
    }
}

fn publication_store_version() -> u32 {
    1
}

fn publications_path(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(persistence::STATE_DIR)
        .join(PUBLICATIONS_FILE)
}

fn load_publication_store(workspace_root: &Path) -> Result<PublicationStore, String> {
    let path = publications_path(workspace_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PublicationStore {
                version: publication_store_version(),
                bindings: Vec::new(),
            });
        }
        Err(error) => {
            return Err(format!(
                "failed to read publication bindings {}: {error}",
                path.display()
            ));
        }
    };
    let store: PublicationStore = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid publication bindings {}: {error}", path.display()))?;
    if store.version != publication_store_version() {
        return Err(format!(
            "unsupported publication bindings version {}",
            store.version
        ));
    }
    Ok(store)
}

fn upsert_publication_binding(
    workspace_root: &Path,
    binding: &PublicationBinding,
) -> Result<(), String> {
    let _guard = PUBLICATIONS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut store = load_publication_store(workspace_root)?;
    if let Some(existing) = store
        .bindings
        .iter_mut()
        .find(|existing| existing.publication_id == binding.publication_id)
    {
        *existing = binding.clone();
    } else {
        store.bindings.push(binding.clone());
    }
    store
        .bindings
        .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    save_publication_store(workspace_root, &store)
}

fn save_publication_store(workspace_root: &Path, store: &PublicationStore) -> Result<(), String> {
    let path = publications_path(workspace_root);
    let parent = path
        .parent()
        .ok_or_else(|| "publication bindings path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create publication bindings directory {}: {error}",
            parent.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    let raw = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("failed to encode publication bindings: {error}"))?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    persistence::write_synced(&tmp, &raw)
        .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("failed to commit {}: {error}", path.display())
    })?;
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn default_poll_interval() -> u64 {
    5
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> PublishPublicationRequest {
        let index = r#"{
  "schemaVersion": 1,
  "publicationId": "pub_12345678",
  "kind": "transcript",
  "title": "Test",
  "createdAt": "2026-07-16T12:00:00.000Z",
  "updatedAt": "2026-07-16T12:00:00.000Z",
  "contentHash": "5f70c4ffb7f0fcbdb0791011aa88513de9cf613c40addbc5c46ad4666bf905fa",
  "transcript": {
    "textFile": "transcript.txt",
    "messages": []
  }
}"#;
        PublishPublicationRequest {
            publication_id: "pub_12345678".to_string(),
            title: "Test".to_string(),
            is_public: false,
            files: BTreeMap::from([
                (PUBLICATION_INDEX_FILE.to_string(), index.to_string()),
                (PUBLICATION_README_FILE.to_string(), "# Test\n".to_string()),
                ("transcript.txt".to_string(), "You\n\nTest\n".to_string()),
            ]),
            source: PublicationSource {
                kind: "transcript".to_string(),
                detail: BTreeMap::new(),
            },
            public_node_ids: BTreeMap::new(),
        }
    }

    fn research_request() -> PublishPublicationRequest {
        let root_file = "# Root\n\n## Answer\n\nRoot answer.\n";
        let child_file = "# Child\n\n## Answer\n\nChild answer.\n";
        let mut publication = serde_json::json!({
            "schemaVersion": 1,
            "publicationId": "pub_research123",
            "kind": "research-tree",
            "title": "Research",
            "createdAt": "2026-07-16T12:00:00.000Z",
            "updatedAt": "2026-07-16T12:00:00.000Z",
            "research": {
                "rootNodeId": "node_root1234",
                "selectedNodeId": "node_child123",
                "nodes": [
                    {
                        "id": "node_root1234",
                        "parentId": null,
                        "kind": "run",
                        "title": "Root",
                        "prompt": "Root question",
                        "answerFile": "node_root1234.md",
                        "contentHash": format!("{:x}", Sha256::digest(root_file.as_bytes())),
                        "responseRevision": "a".repeat(64),
                        "status": "complete",
                        "createdAt": 1
                    },
                    {
                        "id": "node_child123",
                        "parentId": "node_root1234",
                        "kind": "run",
                        "title": "Child",
                        "prompt": "Child question",
                        "answerFile": "node_child123.md",
                        "contentHash": format!("{:x}", Sha256::digest(child_file.as_bytes())),
                        "responseRevision": "b".repeat(64),
                        "status": "complete",
                        "createdAt": 2
                    }
                ]
            }
        });
        rehash_publication(&mut publication);
        PublishPublicationRequest {
            publication_id: "pub_research123".to_string(),
            title: "Research".to_string(),
            is_public: false,
            files: BTreeMap::from([
                (
                    PUBLICATION_INDEX_FILE.to_string(),
                    serde_json::to_string_pretty(&publication).unwrap(),
                ),
                (
                    PUBLICATION_README_FILE.to_string(),
                    "# Research\n".to_string(),
                ),
                ("node_root1234.md".to_string(), root_file.to_string()),
                ("node_child123.md".to_string(), child_file.to_string()),
            ]),
            source: PublicationSource {
                kind: "researchTree".to_string(),
                detail: BTreeMap::new(),
            },
            public_node_ids: BTreeMap::new(),
        }
    }

    fn rehash_publication(publication: &mut Value) {
        publication.as_object_mut().unwrap().remove("contentHash");
        let hash = format!(
            "{:x}",
            Sha256::digest(canonical_json(publication).as_bytes())
        );
        publication
            .as_object_mut()
            .unwrap()
            .insert("contentHash".to_string(), Value::String(hash));
    }

    #[test]
    fn validates_a_matching_publication_index() {
        validate_publish_request(&valid_request()).unwrap();
    }

    #[test]
    fn rejects_traversal_filenames() {
        let mut request = valid_request();
        request
            .files
            .insert("../secret".to_string(), "no".to_string());
        assert!(validate_publish_request(&request).is_err());
    }

    #[test]
    fn validates_research_topology_and_file_hashes() {
        validate_publish_request(&research_request()).unwrap();
    }

    #[test]
    fn rejects_research_nodes_disconnected_from_the_root() {
        let mut request = research_request();
        let mut publication: Value =
            serde_json::from_str(&request.files[PUBLICATION_INDEX_FILE]).unwrap();
        publication["research"]["nodes"][1]["parentId"] = Value::Null;
        rehash_publication(&mut publication);
        request.files.insert(
            PUBLICATION_INDEX_FILE.to_string(),
            serde_json::to_string_pretty(&publication).unwrap(),
        );
        assert!(
            validate_publish_request(&request)
                .unwrap_err()
                .contains("disconnected")
        );
    }

    #[test]
    fn canonical_json_sorts_object_keys() {
        let value = serde_json::json!({"z": [2, 1], "a": {"b": true, "a": null}});
        assert_eq!(
            canonical_json(&value),
            r#"{"a":{"a":null,"b":true},"z":[2,1]}"#
        );
    }
}
