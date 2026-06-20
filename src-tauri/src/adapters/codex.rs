use super::{
    AdapterNotification, AdapterNotificationOutcome, AgentAdapter, ComposerPolicy, LaunchEnv,
    PrepareShellAgentLaunchRequest, PreparedShellAgentLaunch, ShellCommandIntegration,
    SpawnAgentRequest, ensure_on_path,
};
use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::pty::{InitialPaneSize, PtySpawnSpec, qmux_pane_envs, recoverable_dir, spawn_pty};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::transcript::Turn;
use crate::workspace::{
    AgentInfo, AgentStatus, PrepareAgentWorkspaceRequest, attach_agent_pane, mark_agent_failed,
    prepare_agent_workspace,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct CodexAdapter {
    binary: String,
}

impl CodexAdapter {
    pub fn new(config: &QmuxConfig) -> Self {
        Self {
            binary: config.codex_binary(),
        }
    }

    fn ensure_binary(&self) -> Result<String, String> {
        ensure_on_path(&self.binary).ok_or_else(|| {
            format!(
                "Codex adapter binary '{}' was not found on PATH. Install Codex CLI or update adapters.codex.binary in qmux.config.json.",
                self.binary
            )
        })?;
        Ok(self.binary.clone())
    }
}

impl AgentAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn display_name(&self) -> &'static str {
        "Codex"
    }

    fn launch(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        self.spawn_pane(state, request)
    }

    fn resume(
        &self,
        state: &AppState,
        pane: &PaneInfo,
        agent: &AgentInfo,
    ) -> Result<PaneInfo, String> {
        self.respawn_pane(state, pane, agent)
    }

    fn prepare_shell_launch(
        &self,
        state: &AppState,
        request: PrepareShellAgentLaunchRequest,
    ) -> Result<PreparedShellAgentLaunch, String> {
        self.prepare_shell_launch(state, request)
    }

    fn shell_commands(&self) -> Vec<ShellCommandIntegration> {
        vec![ShellCommandIntegration {
            command_name: "codex",
            adapter_id: self.id(),
        }]
    }

    fn ingest_notification(
        &self,
        state: &AppState,
        notification: AdapterNotification,
    ) -> Result<AdapterNotificationOutcome, String> {
        self.ingest_codex_notification(state, notification)
    }

    fn parse_transcript_line(
        &self,
        _agent_id: &str,
        _source_index: usize,
        _line: &str,
    ) -> Option<Turn> {
        None
    }

    fn composer_policy(&self) -> ComposerPolicy {
        ComposerPolicy {
            ready_statuses: vec![
                AgentStatus::Running,
                AgentStatus::AwaitingInput,
                AgentStatus::Done,
                AgentStatus::Idle,
            ],
            queue_statuses: vec![AgentStatus::Starting, AgentStatus::AwaitingPermission],
            steer_statuses: vec![AgentStatus::Starting, AgentStatus::Running],
            permission_actions: Vec::new(),
        }
    }
}

impl CodexAdapter {
    fn spawn_pane(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        let binary = self.ensure_binary()?;
        let options = CodexLaunchOptions::from_value(request.options)?;

        let agent = prepare_agent_workspace(
            state,
            PrepareAgentWorkspaceRequest {
                group_id: request.group_id,
                base_repo: request.base_repo,
                base_ref: request.base_ref,
                adapter: self.id().to_string(),
                model: request.model.clone(),
                use_worktree: request.use_worktree.unwrap_or(false),
            },
        )?;
        let cwd = request
            .cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&agent.worktree_dir));
        if !cwd.is_dir() {
            let _ = mark_agent_failed(state, &agent.id);
            return Err(format!(
                "Codex working directory {} does not exist",
                cwd.display()
            ));
        }

        let prompt = request.prompt.trim();
        let mut tail_args = Vec::new();
        if !prompt.is_empty() {
            tail_args.push(prompt.to_string());
        }
        let args = build_codex_args(&cwd, request.model.as_deref(), &options, tail_args);
        let pane_id = state.next_id("pane");
        let mut envs = qmux_pane_envs(state, &pane_id);
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));

        let spawn_result = spawn_pty(
            state,
            PtySpawnSpec {
                pane_id: Some(pane_id.clone()),
                agent_id: Some(agent.id.clone()),
                kind: PaneKind::Agent,
                title: self.display_name().to_string(),
                program: binary,
                args,
                cwd,
                envs,
                initial_size: request.initial_size,
                recovered: false,
            },
        );

        match spawn_result {
            Ok(pane) => {
                attach_agent_pane(state, &agent.id, pane.id.clone())?;
                Ok(pane)
            }
            Err(err) => {
                let _ = mark_agent_failed(state, &agent.id);
                Err(err)
            }
        }
    }

    fn respawn_pane(
        &self,
        state: &AppState,
        pane: &PaneInfo,
        agent: &AgentInfo,
    ) -> Result<PaneInfo, String> {
        let binary = self.ensure_binary()?;
        let cwd = recoverable_dir(&agent.worktree_dir).ok_or_else(|| {
            format!(
                "agent worktree {} no longer exists; relaunch manually",
                agent.worktree_dir
            )
        })?;
        let options = CodexLaunchOptions::default();
        let args = build_codex_args(&cwd, agent.model.as_deref(), &options, Vec::new());

        let mut envs = qmux_pane_envs(state, &pane.id);
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));

        let info = spawn_pty(
            state,
            PtySpawnSpec {
                pane_id: Some(pane.id.clone()),
                agent_id: Some(agent.id.clone()),
                kind: PaneKind::Agent,
                title: pane.title.clone(),
                program: binary,
                args,
                cwd,
                envs,
                initial_size: Some(InitialPaneSize {
                    cols: pane.cols,
                    rows: pane.rows,
                }),
                recovered: true,
            },
        )?;

        let restored = attach_agent_pane(state, &agent.id, pane.id.clone())?;
        state.emit(QmuxEvent::new(
            "agent.recovered",
            Some(pane.id.clone()),
            Some(restored.id.clone()),
            json!({ "resumed": false, "agent": restored }),
        ));

        Ok(info)
    }

    fn prepare_shell_launch(
        &self,
        state: &AppState,
        request: PrepareShellAgentLaunchRequest,
    ) -> Result<PreparedShellAgentLaunch, String> {
        let binary = self.ensure_binary()?;

        if state.pane_writer(&request.pane_id)?.is_none() {
            return Err(format!("pane {} was not found", request.pane_id));
        }

        let cwd = PathBuf::from(&request.cwd);
        if !cwd.is_dir() {
            return Err(format!(
                "Codex working directory {} does not exist",
                cwd.display()
            ));
        }

        let agent = prepare_agent_workspace(
            state,
            PrepareAgentWorkspaceRequest {
                group_id: None,
                base_repo: Some(cwd.display().to_string()),
                base_ref: Some("HEAD".to_string()),
                adapter: self.id().to_string(),
                model: None,
                // Typing `codex` in a shell runs in the current directory; no worktree.
                use_worktree: false,
            },
        )?;
        let agent = attach_agent_pane(state, &agent.id, request.pane_id.clone())?;

        let options = CodexLaunchOptions::default();
        let args = build_codex_args(&cwd, None, &options, request.args);
        let mut envs = qmux_pane_envs(state, &request.pane_id);
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        let agent_id = agent.id.clone();
        let worktree_dir = agent.worktree_dir.clone();

        state.emit(QmuxEvent::new(
            "agent.spawned",
            Some(request.pane_id),
            Some(agent_id),
            json!({ "agent": agent.clone(), "source": "shell" }),
        ));

        Ok(PreparedShellAgentLaunch {
            binary,
            cwd: worktree_dir,
            args,
            envs: envs
                .into_iter()
                .map(|(key, value)| LaunchEnv { key, value })
                .collect(),
        })
    }

    fn ingest_codex_notification(
        &self,
        state: &AppState,
        notification: AdapterNotification,
    ) -> Result<AdapterNotificationOutcome, String> {
        let pane_id = notification.pane_id.clone();
        let agent_id = notification.agent_id.clone().or_else(|| {
            pane_id
                .as_deref()
                .and_then(|pane_id| state.agent_by_pane(pane_id).ok().flatten())
                .map(|agent| agent.id)
        });
        let event = notification.event;

        Ok(AdapterNotificationOutcome::Event(QmuxEvent::new(
            format!("agent.hook.{event}"),
            pane_id,
            agent_id,
            json!({
                "hookEvent": event,
                "payload": notification.payload,
            }),
        )))
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexLaunchOptions {
    #[serde(default)]
    sandbox: Option<String>,
    #[serde(default)]
    approval_policy: Option<String>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    oss: bool,
    #[serde(default)]
    search: bool,
}

impl CodexLaunchOptions {
    fn from_value(value: Value) -> Result<Self, String> {
        if value.is_null() {
            return Ok(Self::default());
        }

        let mut options: CodexLaunchOptions = serde_json::from_value(value)
            .map_err(|err| format!("invalid Codex adapter options: {err}"))?;
        options.sandbox = normalize_option(
            "sandbox",
            options.sandbox.as_deref(),
            &["read-only", "workspace-write", "danger-full-access"],
        )?;
        options.approval_policy = normalize_option(
            "approvalPolicy",
            options.approval_policy.as_deref(),
            &["untrusted", "on-request", "on-failure", "never"],
        )?;
        options.profile = options
            .profile
            .map(|profile| profile.trim().to_string())
            .filter(|profile| !profile.is_empty());
        Ok(options)
    }
}

fn normalize_option(
    field: &str,
    value: Option<&str>,
    allowed: &[&str],
) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if allowed.contains(&value) {
        Ok(Some(value.to_string()))
    } else {
        Err(format!(
            "invalid Codex adapter option {field}='{value}'; expected one of {}",
            allowed.join(", ")
        ))
    }
}

fn build_codex_args(
    cwd: &Path,
    model: Option<&str>,
    options: &CodexLaunchOptions,
    tail_args: Vec<String>,
) -> Vec<String> {
    let mut args = vec!["--cd".to_string(), cwd.display().to_string()];

    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(profile) = options.profile.as_deref() {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }
    if let Some(sandbox) = options.sandbox.as_deref() {
        args.push("--sandbox".to_string());
        args.push(sandbox.to_string());
    }
    if let Some(approval_policy) = options.approval_policy.as_deref() {
        args.push("--ask-for-approval".to_string());
        args.push(approval_policy.to_string());
    }
    if options.oss {
        args.push("--oss".to_string());
    }
    if options.search {
        args.push("--search".to_string());
    }

    args.extend(tail_args);
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_options_reject_unknown_fields() {
        let err = CodexLaunchOptions::from_value(json!({ "bogus": true })).unwrap_err();

        assert!(err.contains("invalid Codex adapter options"));
    }

    #[test]
    fn launch_options_validate_known_enums() {
        let err = CodexLaunchOptions::from_value(json!({ "sandbox": "full-send" })).unwrap_err();

        assert!(err.contains("invalid Codex adapter option sandbox"));
    }

    #[test]
    fn build_args_adds_cwd_model_options_and_prompt() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request",
            "profile": "work",
            "oss": true,
            "search": true
        }))
        .unwrap();

        let args = build_codex_args(
            Path::new("/tmp/qmux"),
            Some("gpt-5"),
            &options,
            vec!["start here".to_string()],
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/qmux",
                "--model",
                "gpt-5",
                "--profile",
                "work",
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--oss",
                "--search",
                "start here"
            ]
        );
    }

    #[test]
    fn composer_policy_sends_running_codex_panes_without_queueing() {
        let policy = CodexAdapter {
            binary: "codex".to_string(),
        }
        .composer_policy();

        assert!(policy.can_send(AgentStatus::Running));
        assert!(!policy.should_queue(AgentStatus::Running));
        assert!(policy.can_steer(AgentStatus::Running));
    }
}
