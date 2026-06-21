pub mod claude;
pub mod codex;

use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::pty::InitialPaneSize;
use crate::state::{AppState, PaneInfo};
use crate::transcript::Turn;
use crate::workspace::{AgentInfo, AgentStatus};
use claude::ClaudeAdapter;
use codex::CodexAdapter;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub use claude::{PrepareShellClaudeLaunchRequest, SpawnClaudeRequest};

/// Single-quotes a path for safe interpolation into a POSIX shell command,
/// escaping embedded single quotes. Shared by the Claude and Codex adapters,
/// which both embed the qmux CLI path into generated hook commands.
pub(crate) fn shell_quote_path(path: &Path) -> String {
    let raw = path.display().to_string();
    format!("'{}'", raw.replace('\'', "'\\''"))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAgentRequest {
    pub adapter_id: String,
    pub prompt: String,
    pub group_id: Option<String>,
    pub base_repo: Option<String>,
    pub base_ref: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub initial_size: Option<InitialPaneSize>,
    /// Opt in to an isolated git worktree; defaults to false (run in place).
    pub use_worktree: Option<bool>,
    #[serde(default)]
    pub options: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareShellAgentLaunchRequest {
    pub adapter_id: String,
    pub pane_id: String,
    pub cwd: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedShellAgentLaunch {
    pub binary: String,
    pub cwd: String,
    pub args: Vec<String>,
    pub envs: Vec<LaunchEnv>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchEnv {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterNotification {
    pub adapter_id: Option<String>,
    pub event: String,
    pub pane_id: Option<String>,
    pub agent_id: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

pub enum AdapterNotificationOutcome {
    Event(QmuxEvent),
    #[allow(dead_code)]
    Events(Vec<QmuxEvent>),
}

impl AdapterNotificationOutcome {
    pub fn into_events(self) -> Vec<QmuxEvent> {
        match self {
            AdapterNotificationOutcome::Event(event) => vec![event],
            AdapterNotificationOutcome::Events(events) => events,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ShellCommandIntegration {
    pub command_name: &'static str,
    pub adapter_id: &'static str,
}

#[derive(Clone, Debug)]
pub struct PermissionAction {
    #[allow(dead_code)]
    pub id: &'static str,
    #[allow(dead_code)]
    pub label: &'static str,
    #[allow(dead_code)]
    pub input: &'static str,
}

#[derive(Clone, Debug)]
pub struct ComposerPolicy {
    pub ready_statuses: Vec<AgentStatus>,
    pub queue_statuses: Vec<AgentStatus>,
    pub steer_statuses: Vec<AgentStatus>,
    #[allow(dead_code)]
    pub permission_actions: Vec<PermissionAction>,
}

impl ComposerPolicy {
    pub fn can_send(&self, status: AgentStatus) -> bool {
        self.ready_statuses.contains(&status)
    }

    pub fn should_queue(&self, status: AgentStatus) -> bool {
        self.queue_statuses.contains(&status)
    }

    pub fn can_steer(&self, status: AgentStatus) -> bool {
        self.steer_statuses.contains(&status)
    }
}

pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;

    fn launch(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String>;

    fn resume(
        &self,
        state: &AppState,
        pane: &PaneInfo,
        agent: &AgentInfo,
    ) -> Result<PaneInfo, String>;

    fn prepare_shell_launch(
        &self,
        state: &AppState,
        request: PrepareShellAgentLaunchRequest,
    ) -> Result<PreparedShellAgentLaunch, String>;

    fn shell_commands(&self) -> Vec<ShellCommandIntegration>;

    fn ingest_notification(
        &self,
        state: &AppState,
        notification: AdapterNotification,
    ) -> Result<AdapterNotificationOutcome, String>;

    fn parse_transcript_line(
        &self,
        agent_id: &str,
        source_index: usize,
        line: &str,
    ) -> Option<Turn>;

    fn composer_policy(&self) -> ComposerPolicy;
}

pub struct AdapterRegistry {
    adapters: Vec<Box<dyn AgentAdapter>>,
}

impl AdapterRegistry {
    pub fn new(adapters: Vec<Box<dyn AgentAdapter>>) -> Self {
        Self { adapters }
    }

    pub fn get(&self, adapter_id: &str) -> Result<&dyn AgentAdapter, String> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == adapter_id)
            .map(|adapter| adapter.as_ref())
            .ok_or_else(|| format!("unknown agent adapter '{adapter_id}'"))
    }

    pub fn shell_commands(&self) -> Vec<ShellCommandIntegration> {
        self.adapters
            .iter()
            .flat_map(|adapter| adapter.shell_commands())
            .collect()
    }

    pub fn metadata(&self) -> Vec<AdapterMetadata> {
        self.adapters
            .iter()
            .map(|adapter| AdapterMetadata {
                id: adapter.id().to_string(),
                label: adapter.display_name().to_string(),
                default: adapter.id() == "claude",
            })
            .collect()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterMetadata {
    pub id: String,
    pub label: String,
    pub default: bool,
}

pub fn adapter_registry(config: &QmuxConfig) -> AdapterRegistry {
    AdapterRegistry::new(vec![
        Box::new(ClaudeAdapter::new(config)),
        Box::new(CodexAdapter::new(config)),
    ])
}

pub(crate) fn ensure_on_path(binary: &str) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        return binary_path.is_file().then(|| binary_path.to_path_buf());
    }

    crate::launch_path::resolve_binary(binary)
}

pub fn agent_spawn(state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
    adapter_registry(state.config())
        .get(&request.adapter_id)?
        .launch(state, request)
}

/// Forks the agent running in `authed_pane` into a new tab and resumes its session.
/// With `nest`, the new tab is nested under the source (a child); otherwise it lands
/// immediately after the source as a sibling. The source is resolved from the
/// authenticated pane (never caller input), so a pane can only fork its own session.
/// Claude only.
pub fn agent_fork(
    state: &AppState,
    authed_pane: &str,
    use_worktree: bool,
    nest: bool,
) -> Result<PaneInfo, String> {
    let source = state
        .agent_by_pane(authed_pane)?
        .ok_or_else(|| "no agent is running in this pane to fork".to_string())?;
    if source.adapter != "claude" {
        return Err("fork is only supported for Claude sessions".to_string());
    }

    let (pane, agent) =
        ClaudeAdapter::new(state.config()).fork_pane(state, &source, use_worktree)?;
    if nest {
        state.nest_pane_under(&pane.id, authed_pane)?;
    } else {
        state.place_pane_after(&pane.id, authed_pane)?;
    }
    state.emit(QmuxEvent::new(
        "agent.forked",
        Some(pane.id.clone()),
        Some(agent.id.clone()),
        json!({ "agent": agent, "pane": pane, "sourceAgentId": source.id }),
    ));
    Ok(pane)
}

pub fn agent_prepare_shell_launch(
    state: &AppState,
    request: PrepareShellAgentLaunchRequest,
) -> Result<PreparedShellAgentLaunch, String> {
    adapter_registry(state.config())
        .get(&request.adapter_id)?
        .prepare_shell_launch(state, request)
}

pub fn agent_composer_policy(
    state: &AppState,
    agent: &AgentInfo,
) -> Result<ComposerPolicy, String> {
    Ok(adapter_registry(state.config())
        .get(&agent.adapter)?
        .composer_policy())
}

pub fn ingest_adapter_notification(
    state: &AppState,
    notification: AdapterNotification,
) -> Result<AdapterNotificationOutcome, String> {
    let adapter_id = notification_adapter_id(state, &notification)?;
    adapter_registry(state.config())
        .get(&adapter_id)?
        .ingest_notification(state, notification)
}

fn notification_adapter_id(
    state: &AppState,
    notification: &AdapterNotification,
) -> Result<String, String> {
    if let Some(agent_id) = notification.agent_id.as_deref() {
        let agent = state
            .agent(agent_id)?
            .ok_or_else(|| format!("agent {agent_id} was not found"))?;
        return Ok(agent.adapter);
    }

    if let Some(pane_id) = notification.pane_id.as_deref() {
        if let Some(agent) = state.agent_by_pane(pane_id)? {
            return Ok(agent.adapter);
        }
    }

    notification
        .adapter_id
        .clone()
        .or_else(|| {
            notification
                .payload
                .get("adapterId")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .ok_or_else(|| "hook.notify could not resolve an agent adapter for this pane".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig};
    use std::path::PathBuf;

    fn test_config() -> QmuxConfig {
        QmuxConfig {
            workspace_root: PathBuf::from("/tmp/qmux-adapter-tests"),
            socket_path: PathBuf::from("/tmp/qmux-adapter-tests.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: PathBuf::new(),
        }
    }

    #[test]
    fn registry_rejects_unknown_adapter() {
        let registry = adapter_registry(&test_config());

        let err = match registry.get("missing") {
            Ok(_) => panic!("missing adapter should be rejected"),
            Err(err) => err,
        };

        assert_eq!(err, "unknown agent adapter 'missing'");
    }

    #[test]
    fn runtime_metadata_marks_claude_as_default() {
        let registry = adapter_registry(&test_config());

        let metadata = registry.metadata();
        assert_eq!(metadata.len(), 2);
        assert_eq!(metadata[0].id, "claude");
        assert!(metadata[0].default);
        assert_eq!(metadata[1].id, "codex");
        assert!(!metadata[1].default);
    }

    #[test]
    fn agent_fork_requires_a_claude_agent_in_the_pane() {
        let state = AppState::new(test_config());

        // No agent bound to the pane: nothing to fork.
        let err = agent_fork(&state, "pane-1", false, true).unwrap_err();
        assert!(err.contains("no agent"), "unexpected error: {err}");

        // A non-Claude agent is rejected before any spawn is attempted.
        state
            .insert_agent(AgentInfo {
                id: "agent-1".to_string(),
                group_id: "group-1".to_string(),
                adapter: "codex".to_string(),
                worktree_dir: "/tmp/qmux-adapter-tests".to_string(),
                branch: None,
                pane_id: Some("pane-1".to_string()),
                orphaned_queue_pane_id: None,
                session_id: Some("session-1".to_string()),
                transcript_path: None,
                status: AgentStatus::Running,
                model: None,
                parent_id: None,
                fork_point: None,
                root_session_id: None,
                paused: false,
                created_at: 1,
            })
            .unwrap();
        let err = agent_fork(&state, "pane-1", false, true).unwrap_err();
        assert!(
            err.contains("only supported for Claude"),
            "unexpected error: {err}"
        );
    }
}
