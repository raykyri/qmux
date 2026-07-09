pub mod claude;
pub mod codex;
pub mod grok;
pub mod opencode;

use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::pty::InitialPaneSize;
use crate::state::{AppState, PaneInfo};
use crate::transcript::{Turn, TurnBlock};
// The canonical JSON string-field extractor. Re-exported so the adapters can reach it
// as `super::string_field` and share the one definition (see `transcript::string_field`).
pub(crate) use crate::transcript::string_field;
use crate::workspace::{AgentInfo, AgentStatus};
use claude::ClaudeAdapter;
use codex::CodexAdapter;
use grok::GrokAdapter;
use opencode::OpencodeAdapter;
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

/// Single-quotes an arbitrary argument for safe interpolation into a POSIX shell
/// command. Used to embed a session id into an adapter's resume command line.
pub(crate) fn shell_quote_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Whether a `transcript_path` reported by an adapter's hook notification may be
/// bound and tailed.
///
/// A hook arrives over the control socket carrying the pane's token, so a
/// prompt-injected agent can forge a `SessionStart` and point `transcript_path`
/// at any file. We can't fully validate the *first* path (SessionStart is how
/// qmux discovers it, and the agent may not have written the file yet), but we
/// constrain it several ways: a `.jsonl` extension, an absolute path (a relative
/// one would resolve against an unknown cwd), and — when the target already
/// exists — a regular file, so a forged hook can't aim the tailer at a directory,
/// a symlink, or a FIFO/device (which could block the tail thread). Once a
/// transcript is bound we additionally require any later path to be a sibling in
/// the same session directory. Adapters keep a session's rollouts in one flat
/// directory, so a legitimate rotation stays a sibling while a forged mid-session
/// hook can no longer relocate the tail to an unrelated file (another agent's
/// transcript, a device/FIFO, an arbitrary log). The Claude adapter delegates
/// here so the guard stays single-sourced.
pub(crate) fn hook_transcript_path_acceptable(current: Option<&str>, candidate: &str) -> bool {
    let candidate = Path::new(candidate);
    if candidate.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return false;
    }
    if !candidate.is_absolute() {
        return false;
    }
    // `symlink_metadata` does not follow the final component, so a symlink is seen as a
    // symlink (not a regular file) and rejected. A path that doesn't exist yet is allowed
    // through — the agent may not have written its transcript at SessionStart time.
    if let Ok(meta) = std::fs::symlink_metadata(candidate)
        && !meta.file_type().is_file()
    {
        return false;
    }
    match current {
        Some(current) => Path::new(current).parent() == candidate.parent(),
        None => true,
    }
}

/// Finds the existing unbound agent for `session_id` running in `cwd`, so a shell
/// resume (`claude --resume <id>` / `codex resume <id>`) rebinds the original agent
/// instead of minting a duplicate every restart. Scoped to the same adapter, the
/// same directory, and an agent not currently bound to a pane, so a manual resume
/// of a live session (bound elsewhere) or a different project still starts fresh.
pub(crate) fn reusable_session_agent(
    state: &AppState,
    adapter_id: &str,
    session_id: Option<&str>,
    cwd: &str,
) -> Result<Option<AgentInfo>, String> {
    let Some(session_id) = session_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    Ok(state.list_agents()?.into_iter().find(|agent| {
        agent.adapter == adapter_id
            && agent.pane_id.is_none()
            && same_dir(&agent.worktree_dir, cwd)
            && agent.session_id.as_deref() == Some(session_id)
    }))
}

/// True when both paths name the same directory. Canonicalization resolves symlinks,
/// `.`/`..`, trailing slashes, and (on case-insensitive volumes) the on-disk case, so a
/// shell's reported `$PWD` rebinds the original agent even when its spelling differs from
/// the recorded launch dir. Falls back to a raw compare when a side can't be canonicalized
/// (e.g. the directory no longer exists), preserving the previous exact-match behavior.
fn same_dir(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Parse a single line from a Claude-style or Grok-native rollout transcript (the
/// JSONL format used by Claude Code and by Grok Build's Claude-compatible sessions).
/// This is used for the `transcript_path` that Grok reports via its SessionStart hook.
pub(crate) fn parse_claude_native_transcript_line(
    agent_id: &str,
    source_index: usize,
    line: &str,
) -> Option<Turn> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    parse_claude_native_transcript_value(agent_id, source_index, &value)
}

/// As [`parse_claude_native_transcript_line`], but over an already-parsed value.
/// Lets a caller that also inspects the same line for other shapes (the Grok
/// adapter's synthetic-format fallback) parse the JSON once instead of per attempt.
pub(crate) fn parse_claude_native_transcript_value(
    agent_id: &str,
    source_index: usize,
    value: &Value,
) -> Option<Turn> {
    let message = value.get("message").unwrap_or(value);
    let role = message
        .get("role")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("event")
        .to_string();
    let session_id = string_field(value, "session_id").or_else(|| string_field(value, "sessionId"));
    let content = message.get("content").or_else(|| value.get("content"))?;
    let blocks = parse_claude_native_blocks(content);

    if blocks.is_empty() {
        return None;
    }

    Some(Turn {
        id: format!("{agent_id}-{source_index}"),
        agent_id: agent_id.to_string(),
        session_id,
        role,
        blocks,
        source_index,
        status: None,
        status_reason: None,
        native_id: string_field(value, "uuid"),
        parent_native_id: string_field(value, "parentUuid")
            .or_else(|| string_field(value, "parent_uuid")),
        native_message_id: string_field(message, "id"),
    })
}

pub(crate) fn parse_claude_native_lifecycle_event(line: &str) -> Option<TranscriptLifecycleEvent> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    parse_claude_native_lifecycle_value(&value)
}

/// As [`parse_claude_native_lifecycle_event`], but over an already-parsed value (see
/// [`parse_claude_native_transcript_value`]).
pub(crate) fn parse_claude_native_lifecycle_value(
    value: &Value,
) -> Option<TranscriptLifecycleEvent> {
    if value.get("interruptedMessageId").is_some() || value.get("interrupted_message_id").is_some()
    {
        return Some(TranscriptLifecycleEvent::Interrupted);
    }

    let message = value.get("message").unwrap_or(value);
    let content = message.get("content").or_else(|| value.get("content"))?;
    claude_native_content_has_interruption_marker(content)
        .then_some(TranscriptLifecycleEvent::Interrupted)
}

fn claude_native_content_has_interruption_marker(content: &Value) -> bool {
    match content {
        Value::String(text) => is_claude_interruption_marker(text),
        Value::Array(items) => items.iter().any(|item| {
            item.get("type").and_then(Value::as_str) == Some("text")
                && item
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(is_claude_interruption_marker)
        }),
        _ => false,
    }
}

fn is_claude_interruption_marker(text: &str) -> bool {
    matches!(
        text.trim(),
        "[Request interrupted by user]" | "[Request interrupted by user for tool use]"
    )
}

fn parse_claude_native_blocks(content: &Value) -> Vec<TurnBlock> {
    match content {
        Value::String(text) => vec![TurnBlock::Text { text: text.clone() }],
        Value::Array(items) => items.iter().filter_map(parse_claude_native_block).collect(),
        other => vec![TurnBlock::Raw {
            value: other.clone(),
        }],
    }
}

fn parse_claude_native_block(value: &Value) -> Option<TurnBlock> {
    let block_type = value.get("type").and_then(Value::as_str);
    match block_type {
        Some("text") => value
            .get("text")
            .and_then(Value::as_str)
            .map(|text| TurnBlock::Text {
                text: text.to_string(),
            }),
        Some("tool_use") => Some(TurnBlock::ToolUse {
            id: string_field(value, "id"),
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            input: value.get("input").cloned().unwrap_or(Value::Null),
        }),
        Some("tool_result") => Some(TurnBlock::ToolResult {
            tool_use_id: string_field(value, "tool_use_id")
                .or_else(|| string_field(value, "toolUseId")),
            content: value.get("content").cloned().unwrap_or(Value::Null),
            is_error: value
                .get("is_error")
                .or_else(|| value.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        Some(_) => Some(TurnBlock::Raw {
            value: value.clone(),
        }),
        None => value.as_str().map(|text| TurnBlock::Text {
            text: text.to_string(),
        }),
    }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptLifecycleEvent {
    Interrupted,
}

impl TranscriptLifecycleEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            TranscriptLifecycleEvent::Interrupted => "interrupted",
        }
    }
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

    /// The shell command that resumes `session_id` through this adapter's injected
    /// wrapper function (e.g. `claude --resume <id>`), used to re-launch the agent in
    /// a recovered shell pane. Defaults to `None` for adapters without a resume command.
    fn shell_resume_command(&self, _session_id: &str) -> Option<String> {
        None
    }

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

    fn resolve_transcript_turns(&self, agent_id: &str, lines: &[String]) -> Vec<Turn> {
        lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| self.parse_transcript_line(agent_id, index, line))
            .collect()
    }

    fn transcript_line_can_update_turn_status(&self, _line: &str) -> bool {
        false
    }

    fn parse_transcript_lifecycle_event(&self, _line: &str) -> Option<TranscriptLifecycleEvent> {
        None
    }

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
        Box::new(OpencodeAdapter::new(config)),
        Box::new(GrokAdapter::new(config)),
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
/// When `prompt` is set, the fork is launched with that initial user message.
pub fn agent_fork(
    state: &AppState,
    authed_pane: &str,
    use_worktree: bool,
    nest: bool,
    prompt: Option<String>,
) -> Result<PaneInfo, String> {
    let source = state
        .agent_by_pane(authed_pane)?
        .ok_or_else(|| "no agent is running in this pane to fork".to_string())?;
    fork_agent_source(state, &source, use_worktree, nest, prompt.as_deref())
}

/// Adapters with a native fork command. Owns the fork-eligibility check (and its
/// error message) for both the dispatch below and the queue engine's fail-fast
/// validation, so a new forkable adapter is added in one place.
pub fn adapter_supports_fork(adapter_id: &str) -> bool {
    matches!(adapter_id, "claude" | "codex")
}

pub const FORK_UNSUPPORTED_ERROR: &str = "fork is only supported for Claude and Codex sessions";

/// The agent-scoped core of [`agent_fork`], also used by the queue engine to
/// dispatch fork-delivery turns (where there is no calling pane to authenticate —
/// the source is the agent that owns the queue). Places the new pane relative to
/// the source's current pane and emits `agent.forked` so the frontend picks up the
/// new tab without stealing focus.
pub fn fork_agent_source(
    state: &AppState,
    source: &AgentInfo,
    use_worktree: bool,
    nest: bool,
    prompt: Option<&str>,
) -> Result<PaneInfo, String> {
    let (pane, agent) = match source.adapter.as_str() {
        "claude" => {
            ClaudeAdapter::new(state.config()).fork_pane(state, source, use_worktree, prompt)?
        }
        "codex" => {
            CodexAdapter::new(state.config()).fork_pane(state, source, use_worktree, prompt)?
        }
        _ => return Err(FORK_UNSUPPORTED_ERROR.to_string()),
    };
    if let Some(source_pane) = source.pane_id.as_deref() {
        if nest {
            state.nest_pane_under(&pane.id, source_pane)?;
        } else {
            state.place_pane_after(&pane.id, source_pane)?;
        }
    }
    state.emit(QmuxEvent::new(
        "agent.forked",
        Some(pane.id.clone()),
        Some(agent.id.clone()),
        json!({ "agent": agent, "pane": pane, "sourceAgentId": source.id }),
    ));
    Ok(pane)
}

/// Starts a fresh session of `source`'s adapter in the source's own directory,
/// launched with `prompt` as its first message, and nests the new pane under the
/// source's. Used by the queue engine for new-session-delivery turns. Emits
/// `agent.spawned` with source "queue" so the frontend refreshes its pane list
/// (unlike launcher spawns, no frontend caller holds the returned pane).
pub fn spawn_sibling_agent_session(
    state: &AppState,
    source: &AgentInfo,
    prompt: &str,
) -> Result<PaneInfo, String> {
    let pane = adapter_registry(state.config())
        .get(&source.adapter)?
        .launch(
            state,
            SpawnAgentRequest {
                adapter_id: source.adapter.clone(),
                prompt: prompt.to_string(),
                group_id: Some(source.group_id.clone()),
                // Run in the source's directory (no worktree), like an in-place fork.
                base_repo: Some(source.worktree_dir.clone()),
                base_ref: Some("HEAD".to_string()),
                cwd: None,
                model: source.model.clone(),
                initial_size: None,
                use_worktree: Some(false),
                options: Value::Null,
            },
        )?;
    if let Some(source_pane) = source.pane_id.as_deref() {
        state.nest_pane_under(&pane.id, source_pane)?;
    }
    let agent = state.agent_by_pane(&pane.id)?;
    state.emit(QmuxEvent::new(
        "agent.spawned",
        Some(pane.id.clone()),
        agent.as_ref().map(|agent| agent.id.clone()),
        json!({ "agent": agent, "pane": pane, "source": "queue" }),
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

    if let Some(pane_id) = notification.pane_id.as_deref()
        && let Some(agent) = state.agent_by_pane(pane_id)?
    {
        return Ok(agent.adapter);
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
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
        OpencodeAdapterConfig,
    };
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
                opencode: OpencodeAdapterConfig {
                    binary: Some("opencode".to_string()),
                },
                grok: GrokAdapterConfig {
                    binary: Some("grok".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: PathBuf::new(),
            opencode_plugin_dir: PathBuf::new(),
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
        assert_eq!(metadata.len(), 4);
        assert_eq!(metadata[0].id, "claude");
        assert!(metadata[0].default);
        assert_eq!(metadata[1].id, "codex");
        assert!(!metadata[1].default);
        assert_eq!(metadata[2].id, "opencode");
        assert!(!metadata[2].default);
        assert_eq!(metadata[3].id, "grok");
        assert!(!metadata[3].default);
    }

    #[test]
    fn agent_fork_requires_a_supported_agent_in_the_pane() {
        let state = AppState::new(test_config());

        // No agent bound to the pane: nothing to fork.
        let err = agent_fork(&state, "pane-1", false, true, None).unwrap_err();
        assert!(err.contains("no agent"), "unexpected error: {err}");

        // An adapter without a native fork command is rejected before any spawn is attempted.
        state
            .insert_agent(AgentInfo {
                id: "agent-1".to_string(),
                group_id: "group-1".to_string(),
                adapter: "opencode".to_string(),
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
                thread_id: None,
                branch_id: None,
                paused: false,
                created_at: 1,
            })
            .unwrap();
        let err = agent_fork(&state, "pane-1", false, true, None).unwrap_err();
        assert!(
            err.contains("only supported for Claude and Codex"),
            "unexpected error: {err}"
        );
    }

    fn session_agent(id: &str, pane_id: Option<&str>, dir: &str, session: &str) -> AgentInfo {
        AgentInfo {
            id: id.to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: dir.to_string(),
            branch: None,
            pane_id: pane_id.map(ToString::to_string),
            orphaned_queue_pane_id: None,
            session_id: Some(session.to_string()),
            transcript_path: None,
            status: AgentStatus::Idle,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            thread_id: None,
            branch_id: None,
            paused: false,
            created_at: 1,
        }
    }

    #[test]
    fn reusable_session_agent_matches_an_unbound_same_dir_session() {
        let state = AppState::new(test_config());
        state
            .insert_agent(session_agent("agent-1", None, "/work", "sess-1"))
            .unwrap();

        let found = reusable_session_agent(&state, "claude", Some("sess-1"), "/work").unwrap();
        assert_eq!(
            found.as_ref().map(|agent| agent.id.as_str()),
            Some("agent-1")
        );

        // No session id, a different session, a different dir, or a different adapter
        // all start fresh instead of reusing.
        assert!(
            reusable_session_agent(&state, "claude", None, "/work")
                .unwrap()
                .is_none()
        );
        assert!(
            reusable_session_agent(&state, "claude", Some("other"), "/work")
                .unwrap()
                .is_none()
        );
        assert!(
            reusable_session_agent(&state, "claude", Some("sess-1"), "/elsewhere")
                .unwrap()
                .is_none()
        );
        assert!(
            reusable_session_agent(&state, "codex", Some("sess-1"), "/work")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn reusable_session_agent_rebinds_across_equivalent_dir_spellings() {
        let state = AppState::new(test_config());
        // A real directory so both the recorded launch dir and the shell's reported $PWD
        // can be canonicalized to the same target.
        let base = std::env::temp_dir().join(format!("qmux-reuse-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let launch_dir = base.display().to_string();
        state
            .insert_agent(session_agent("agent-1", None, &launch_dir, "sess-1"))
            .unwrap();

        // A trailing `/.` (the kind of drift a `cd` round-trip can leave in $PWD) is not a
        // byte-for-byte match, so the rebind now leans on canonicalization to recognize it
        // as the same directory rather than minting a duplicate agent.
        let equivalent_spelling = base.join(".").display().to_string();
        assert_ne!(launch_dir, equivalent_spelling);
        let found =
            reusable_session_agent(&state, "claude", Some("sess-1"), &equivalent_spelling).unwrap();
        assert_eq!(
            found.as_ref().map(|agent| agent.id.as_str()),
            Some("agent-1")
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn reusable_session_agent_never_hijacks_a_bound_session() {
        let state = AppState::new(test_config());
        state
            .insert_agent(session_agent("agent-1", Some("pane-9"), "/work", "sess-1"))
            .unwrap();

        // A session still bound to a live pane must not be stolen by a resume.
        assert!(
            reusable_session_agent(&state, "claude", Some("sess-1"), "/work")
                .unwrap()
                .is_none()
        );
    }
}
