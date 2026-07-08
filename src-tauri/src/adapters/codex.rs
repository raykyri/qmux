use super::{
    AdapterNotification, AdapterNotificationOutcome, AgentAdapter, ComposerPolicy, LaunchEnv,
    PrepareShellAgentLaunchRequest, PreparedShellAgentLaunch, ShellCommandIntegration,
    SpawnAgentRequest, TranscriptLifecycleEvent, ensure_on_path, hook_transcript_path_acceptable,
    reusable_session_agent, shell_quote_arg, shell_quote_path,
};
use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::pty::{InitialPaneSize, PtySpawnSpec, qmux_pane_envs, recoverable_dir, spawn_pty};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::transcript::{
    Turn, TurnBlock, codex_transcript_session_id, gather_transcript_candidates_recursive,
    read_codex_transcript_session_id, start_transcript_tail, string_field,
};
use crate::turn_queue::{IdleResolution, advance_after_idle, is_shell_escape_turn};
use crate::workspace::{
    AgentInfo, AgentStatus, PrepareAgentWorkspaceRequest, attach_agent_pane, mark_agent_failed,
    mark_agent_spawn_failed, prepare_agent_workspace,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

const CODEX_QMUX_PROFILE: &str = "qmux-codex";
const CODEX_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PreToolUse",
    "PostToolUse",
    "Stop",
];

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
        let binary = ensure_on_path(&self.binary).ok_or_else(|| {
            format!(
                "Codex adapter binary '{}' was not found on PATH or standard macOS tool paths. Install Codex CLI or update adapters.codex.binary in qmux.config.json.",
                self.binary
            )
        })?;
        Ok(binary.display().to_string())
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

    fn shell_resume_command(&self, session_id: &str) -> Option<String> {
        Some(format!("codex resume {}", shell_quote_arg(session_id)))
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
        agent_id: &str,
        source_index: usize,
        line: &str,
    ) -> Option<Turn> {
        parse_transcript_line(agent_id, source_index, line)
    }

    fn parse_transcript_lifecycle_event(&self, line: &str) -> Option<TranscriptLifecycleEvent> {
        parse_transcript_lifecycle_event(line)
    }

    fn composer_policy(&self) -> ComposerPolicy {
        ComposerPolicy {
            ready_statuses: vec![
                AgentStatus::AwaitingInput,
                AgentStatus::Done,
                AgentStatus::Idle,
            ],
            queue_statuses: vec![
                AgentStatus::Starting,
                AgentStatus::Running,
                AgentStatus::AwaitingPermission,
            ],
            steer_statuses: vec![AgentStatus::Starting, AgentStatus::Running],
            permission_actions: Vec::new(),
        }
    }
}

impl CodexAdapter {
    fn spawn_pane(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        let binary = self.ensure_binary()?;
        let options = CodexLaunchOptions::from_value(request.options)?;
        let codex_home = ensure_codex_integration()?;

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

        let has_initial_prompt = prompt_has_initial_text(&request.prompt);
        let tail_args = prompt_tail_args(&request.prompt);
        let args = build_codex_args(
            &cwd,
            Some(&state.config().workspace_root),
            request.model.as_deref(),
            &options,
            tail_args,
        );
        let pane_id = state.next_id("pane");
        let mut envs = qmux_pane_envs(state, &pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        envs.push(("QMUX_CLI".to_string(), qmux_cli_path()?));
        envs.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));

        let spawn_result = spawn_pty(
            state,
            PtySpawnSpec {
                pane_id: Some(pane_id.clone()),
                agent_id: Some(agent.id.clone()),
                group_id: agent.group_id.clone(),
                kind: PaneKind::Agent,
                title: self.display_name().to_string(),
                program: binary,
                args,
                cwd,
                envs,
                initial_size: request.initial_size,
                recovered: false,
                skip_scrollback_restore: false,
            },
        );

        match spawn_result {
            Ok(pane) => {
                attach_codex_agent_pane(state, &agent.id, pane.id.clone(), has_initial_prompt)?;
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
        let codex_home = ensure_codex_integration()?;
        let cwd = recoverable_dir(&agent.worktree_dir).ok_or_else(|| {
            format!(
                "agent worktree {} no longer exists; relaunch manually",
                agent.worktree_dir
            )
        })?;
        let options = CodexLaunchOptions::default();
        let (args, resumed) = build_codex_resume_args(
            &cwd,
            Some(&state.config().workspace_root),
            agent.model.as_deref(),
            &options,
            agent.session_id.as_deref(),
        );

        let mut envs = qmux_pane_envs(state, &pane.id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        envs.push(("QMUX_CLI".to_string(), qmux_cli_path()?));
        envs.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));

        let info = spawn_pty(
            state,
            PtySpawnSpec {
                pane_id: Some(pane.id.clone()),
                agent_id: Some(agent.id.clone()),
                group_id: agent.group_id.clone(),
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
                skip_scrollback_restore: resumed,
            },
        )?;

        // A recovered Codex process is launched without an inline prompt, even when
        // resuming a session, so it is ready once the TUI appears. Mark it Idle (not
        // Running) so a recovered quiet session isn't shown as working; the first real
        // prompt/tool hook promotes it to Running.
        let restored = attach_codex_agent_pane(state, &agent.id, pane.id.clone(), false)?;
        if let Some(transcript_path) = restored.transcript_path.clone() {
            start_transcript_tail(
                state.clone(),
                restored.id.clone(),
                transcript_path,
                self.id().to_string(),
            );
        }
        state.emit(QmuxEvent::new(
            "agent.recovered",
            Some(pane.id.clone()),
            Some(restored.id.clone()),
            json!({ "resumed": resumed, "agent": restored }),
        ));

        Ok(info)
    }

    /// Forks `source` into a new Codex agent pane using `codex fork <session> [prompt]`.
    /// Codex records a fresh session id for the fork, so the source session keeps
    /// running independently.
    pub fn fork_pane(
        &self,
        state: &AppState,
        source: &AgentInfo,
        use_worktree: bool,
        prompt: Option<&str>,
    ) -> Result<(PaneInfo, AgentInfo), String> {
        let binary = self.ensure_binary()?;
        let codex_home = ensure_codex_integration()?;
        let session_id = source
            .session_id
            .clone()
            .map(|session| session.trim().to_string())
            .filter(|session| !session.is_empty())
            .ok_or_else(|| {
                "this Codex session isn't ready to fork yet (no session id); send a turn first"
                    .to_string()
            })?;

        let mut agent = prepare_agent_workspace(
            state,
            PrepareAgentWorkspaceRequest {
                group_id: Some(source.group_id.clone()),
                // Worktree forks branch off the group's base repo; in-place forks run
                // in the source's own directory so they see the same files.
                base_repo: if use_worktree {
                    None
                } else {
                    Some(source.worktree_dir.clone())
                },
                base_ref: Some("HEAD".to_string()),
                adapter: self.id().to_string(),
                model: source.model.clone(),
                use_worktree,
            },
        )?;

        agent.parent_id = Some(source.id.clone());
        agent.fork_point = Some(session_id.clone());
        agent.root_session_id = source
            .root_session_id
            .clone()
            .or_else(|| Some(session_id.clone()));
        agent.status = AgentStatus::Idle;
        state.update_agent(agent.clone())?;

        let cwd = recoverable_dir(&agent.worktree_dir).ok_or_else(|| {
            format!(
                "fork working directory {} does not exist",
                agent.worktree_dir
            )
        })?;
        let options = CodexLaunchOptions::default();
        let prompt = prompt.map(str::trim).unwrap_or_default();
        let has_initial_prompt = !prompt.is_empty();
        let args = build_codex_fork_args(
            &cwd,
            Some(&state.config().workspace_root),
            agent.model.as_deref(),
            &options,
            &session_id,
            if has_initial_prompt {
                Some(prompt)
            } else {
                None
            },
        );

        let pane_id = state.next_id("pane");
        let mut envs = qmux_pane_envs(state, &pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        envs.push(("QMUX_CLI".to_string(), qmux_cli_path()?));
        envs.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));

        // Bind before spawn so a fast Codex SessionStart hook passes the control
        // socket's agent/pane scope check. mark_agent_spawn_failed clears this
        // reserved binding if the process fails to launch.
        attach_codex_agent_pane(state, &agent.id, pane_id.clone(), has_initial_prompt)?;

        let spawn_result = spawn_pty(
            state,
            PtySpawnSpec {
                pane_id: Some(pane_id.clone()),
                agent_id: Some(agent.id.clone()),
                group_id: agent.group_id.clone(),
                kind: PaneKind::Agent,
                title: self.display_name().to_string(),
                program: binary,
                args,
                cwd,
                envs,
                initial_size: None,
                recovered: false,
                skip_scrollback_restore: false,
            },
        );

        match spawn_result {
            Ok(pane) => {
                let forked = state
                    .agent(&agent.id)?
                    .ok_or_else(|| format!("forked agent {} disappeared during spawn", agent.id))?;
                Ok((pane, forked))
            }
            Err(err) => {
                let _ = mark_agent_spawn_failed(state, &agent.id, &pane_id);
                Err(err)
            }
        }
    }

    fn prepare_shell_launch(
        &self,
        state: &AppState,
        request: PrepareShellAgentLaunchRequest,
    ) -> Result<PreparedShellAgentLaunch, String> {
        let binary = self.ensure_binary()?;
        validate_shell_tail_args(&request.args)?;

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
        let codex_home = ensure_codex_integration()?;

        // A restart-driven resume (`codex resume <id>`) rebinds the original agent for
        // that session instead of minting a duplicate; any other invocation starts a
        // fresh agent in the current directory.
        let cwd_str = cwd.display().to_string();
        let pane_group_id = state
            .pane_group_id(&request.pane_id)?
            .ok_or_else(|| format!("pane {} was not found", request.pane_id))?;
        let agent = match reusable_session_agent(
            state,
            self.id(),
            codex_resume_session_id(&request.args),
            &cwd_str,
        )? {
            Some(existing) => existing,
            None => prepare_agent_workspace(
                state,
                PrepareAgentWorkspaceRequest {
                    group_id: Some(pane_group_id),
                    base_repo: Some(cwd_str.clone()),
                    base_ref: Some("HEAD".to_string()),
                    adapter: self.id().to_string(),
                    model: None,
                    // Typing `codex` in a shell runs in the current directory; no worktree.
                    use_worktree: false,
                },
            )?,
        };
        let agent = attach_codex_agent_pane(
            state,
            &agent.id,
            request.pane_id.clone(),
            args_contain_prompt(&request.args),
        )?;

        let options = CodexLaunchOptions::default();
        let args = build_codex_args(
            &cwd,
            Some(&state.config().workspace_root),
            None,
            &options,
            request.args,
        );
        let mut envs = qmux_pane_envs(state, &request.pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        envs.push(("QMUX_CLI".to_string(), qmux_cli_path()?));
        envs.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));
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
        let mut send_tracking = None;
        let mut agent = notification
            .agent_id
            .as_deref()
            .and_then(|agent_id| state.agent(agent_id).ok().flatten())
            .or_else(|| {
                pane_id
                    .as_deref()
                    .and_then(|pane_id| state.agent_by_pane(pane_id).ok().flatten())
            });
        let hook_event = notification.event.clone();
        let event_type = match hook_event.as_str() {
            "SessionStart" => {
                if let Some(current) = agent.as_ref() {
                    let session_id = string_field(&notification.payload, "session_id")
                        .or_else(|| string_field(&notification.payload, "sessionId"))
                        .or_else(|| string_field(&notification.payload, "resource_id"))
                        .or_else(|| string_field(&notification.payload, "resourceId"));
                    let transcript_path = string_field(&notification.payload, "transcript_path")
                        .or_else(|| string_field(&notification.payload, "transcriptPath"))
                        // This payload arrives over the control socket under the pane's
                        // token, so a prompt-injected agent can forge a SessionStart.
                        // Reject a path that isn't a sibling of the already-bound
                        // transcript (or isn't a .jsonl) before tailing it; a rejected
                        // path falls back to session-id directory discovery, which is
                        // confined to $CODEX_HOME/sessions and matched on session_meta id.
                        .filter(|candidate| {
                            hook_transcript_path_acceptable(
                                current.transcript_path.as_deref(),
                                candidate,
                            )
                        });
                    let session_id_for_tail = session_id.clone();
                    let transcript_path_for_tail = transcript_path.clone();
                    // Field-scoped mutation, not a full-struct `update_agent`: this
                    // freshly spawned process's pane is being bound by attach_agent_pane
                    // on another thread, and a stale-snapshot write here would race it —
                    // wiping either the pane_id it set or the session_id we set.
                    state.mutate_agent(&current.id, |agent| {
                        // Only overwrite when this event carries a session id; a
                        // late/duplicate SessionStart that omits it must not blank a
                        // recorded one, which fork + recovery key off.
                        if let Some(session_id) = session_id {
                            agent.session_id = Some(session_id);
                        }
                        // A startup hook only means Codex is ready, not that a turn is
                        // running. Keep status unchanged here; the first real prompt/tool
                        // hook promotes the agent to Running.
                    })?;
                    start_codex_transcript_binding(
                        state.clone(),
                        current.id.clone(),
                        session_id_for_tail,
                        transcript_path_for_tail,
                    );
                }
                "agent.session_start"
            }
            "UserPromptSubmit" => {
                if let Some(agent) = agent.as_mut() {
                    let prompt = string_field(&notification.payload, "prompt")
                        .or_else(|| string_field(&notification.payload, "input"));
                    if !prompt.as_deref().is_some_and(is_shell_escape_turn) {
                        agent.status = AgentStatus::Running;
                        state.set_agent_status(&agent.id, agent.status)?;
                    }
                    send_tracking =
                        Some(state.match_agent_prompt_submit(&agent.id, prompt.as_deref())?);
                }
                "agent.prompt_submitted"
            }
            "PreToolUse" => {
                if let Some(agent) = agent.as_mut() {
                    agent.status = AgentStatus::Running;
                    state.set_agent_status(&agent.id, agent.status)?;
                }
                "agent.tool_use"
            }
            "PostToolUse" => {
                if let Some(agent) = agent.as_mut() {
                    agent.status = AgentStatus::Running;
                    state.set_agent_status(&agent.id, agent.status)?;
                }
                "agent.tool_result"
            }
            "PermissionRequest" => {
                if let Some(agent) = agent.as_mut() {
                    agent.status = AgentStatus::AwaitingPermission;
                    state.set_agent_status(&agent.id, agent.status)?;
                }
                "agent.awaiting_permission"
            }
            "Stop" => {
                let drained = if let Some(agent) = agent.as_mut() {
                    finish_agent_after_stop(state, agent)?
                } else {
                    false
                };
                if drained {
                    "agent.running"
                } else {
                    "agent.done"
                }
            }
            other => {
                return Ok(AdapterNotificationOutcome::Event(QmuxEvent::new(
                    format!("agent.hook.{other}"),
                    pane_id,
                    agent.map(|agent| agent.id),
                    json!({
                        "hookEvent": hook_event,
                        "payload": notification.payload,
                    }),
                )));
            }
        };
        let mut event_payload = json!({
            "hookEvent": hook_event,
            "payload": notification.payload,
        });
        if let Some(send_tracking) = send_tracking
            && let Value::Object(payload) = &mut event_payload
        {
            payload.insert(
                "sendTracking".to_string(),
                serde_json::to_value(send_tracking)
                    .map_err(|err| format!("failed to encode send tracking: {err}"))?,
            );
        }
        // The idle handler (advance_after_idle) writes status/paused straight to the
        // store without touching this local snapshot, so re-read the agent before
        // attaching it — otherwise the event ships a stale (e.g. not-yet-paused) copy
        // and the surgical upsert below hides the change from the UI.
        let agent = match agent {
            Some(agent) => state.agent(&agent.id)?.or(Some(agent)),
            None => None,
        };
        // Carry the updated agent so the frontend can apply this status change
        // surgically instead of refetching the entire agent list on every hook
        // event (which also avoids out-of-order refetches clobbering newer state).
        if let (Value::Object(payload), Some(agent)) = (&mut event_payload, agent.as_ref()) {
            payload.insert(
                "agent".to_string(),
                serde_json::to_value(agent)
                    .map_err(|err| format!("failed to encode agent: {err}"))?,
            );
        }

        Ok(AdapterNotificationOutcome::Event(QmuxEvent::new(
            event_type,
            pane_id,
            agent.map(|agent| agent.id),
            event_payload,
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
    approvals_reviewer: Option<String>,
    // Kept only so saved launcher options that still carry `search: true` parse
    // cleanly under `deny_unknown_fields`; --search is now always emitted.
    #[serde(default)]
    #[allow(dead_code)]
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
            &["untrusted", "on-request", "never"],
        )?;
        options.approvals_reviewer = normalize_option(
            "approvalsReviewer",
            options.approvals_reviewer.as_deref(),
            &["auto_review"],
        )?;
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
    additional_workspace_root: Option<&Path>,
    model: Option<&str>,
    options: &CodexLaunchOptions,
    tail_args: Vec<String>,
) -> Vec<String> {
    let mut args = vec!["--cd".to_string(), cwd.display().to_string()];
    if let Some(additional_workspace_root) = additional_workspace_root {
        args.push("--add-dir".to_string());
        args.push(additional_workspace_root.display().to_string());
    }

    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args.push("--profile".to_string());
    args.push(CODEX_QMUX_PROFILE.to_string());
    let sandbox = options.sandbox.as_deref().unwrap_or("workspace-write");
    args.push("--sandbox".to_string());
    args.push(sandbox.to_string());
    if let Some(approval_policy) = options.approval_policy.as_deref()
        && options.approvals_reviewer.as_deref() != Some("auto_review")
    {
        args.push("--ask-for-approval".to_string());
        args.push(approval_policy.to_string());
    }
    if let Some(approvals_reviewer) = options.approvals_reviewer.as_deref() {
        args.push("--config".to_string());
        args.push(format!(
            "approvals_reviewer={}",
            toml_string(approvals_reviewer)
        ));
    }
    args.push("--search".to_string());

    args.extend(tail_args);
    args
}

fn build_codex_resume_args(
    cwd: &Path,
    additional_workspace_root: Option<&Path>,
    model: Option<&str>,
    options: &CodexLaunchOptions,
    session_id: Option<&str>,
) -> (Vec<String>, bool) {
    let Some(session_id) = session_id
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
    else {
        return (
            build_codex_args(cwd, additional_workspace_root, model, options, Vec::new()),
            false,
        );
    };

    (
        build_codex_args(
            cwd,
            additional_workspace_root,
            model,
            options,
            vec!["resume".to_string(), session_id.to_string()],
        ),
        true,
    )
}

fn build_codex_fork_args(
    cwd: &Path,
    additional_workspace_root: Option<&Path>,
    model: Option<&str>,
    options: &CodexLaunchOptions,
    session_id: &str,
    prompt: Option<&str>,
) -> Vec<String> {
    let mut tail_args = vec!["fork".to_string(), session_id.trim().to_string()];
    if let Some(prompt) = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()) {
        // Delimit the prompt with `--` so a fork prompt that happens to start with
        // `-` (e.g. a forged `agent.fork` payload of "--dangerously-bypass-...") is
        // parsed as the positional prompt, not as a Codex flag that could weaken the
        // sandbox/approval posture. Mirrors the initial-launch path (`prompt_tail_args`).
        tail_args.push("--".to_string());
        tail_args.push(prompt.to_string());
    }
    build_codex_args(cwd, additional_workspace_root, model, options, tail_args)
}

fn prompt_tail_args(prompt: &str) -> Vec<String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        Vec::new()
    } else {
        vec!["--".to_string(), prompt.to_string()]
    }
}

fn prompt_has_initial_text(prompt: &str) -> bool {
    !prompt.trim().is_empty()
}

fn attach_codex_agent_pane(
    state: &AppState,
    agent_id: &str,
    pane_id: String,
    has_initial_prompt: bool,
) -> Result<AgentInfo, String> {
    let agent = attach_agent_pane(state, agent_id, pane_id)?;
    if !has_initial_prompt {
        // Field-scoped write — a full-struct update here would race the SessionStart
        // hook recording session_id on another thread. Return the post-write state so
        // callers see the final Idle status.
        if let Some(updated) = state.set_agent_status(agent_id, AgentStatus::Idle)? {
            return Ok(updated);
        }
    }
    Ok(agent)
}

/// Whether a manual `codex ...` invocation carries an inline prompt. Value-taking
/// flags are skipped so `codex --model gpt-5` is treated as interactive.
fn args_contain_prompt(args: &[String]) -> bool {
    let mut after_delimiter = false;
    let mut skip_next = false;
    for arg in args {
        if after_delimiter {
            return true;
        }
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            after_delimiter = true;
            continue;
        }
        if codex_value_flag(arg) {
            skip_next = true;
            continue;
        }
        if codex_inline_value_flag(arg) || arg.starts_with('-') {
            continue;
        }
        // `codex resume [...]` is an interactive subcommand launch (resume a saved
        // session), not an inline prompt. Treating it as a prompt left the rebound
        // agent in its prior working status, pinning a stale "Thinking…" indicator
        // until the next turn finished.
        if arg == "resume" {
            return false;
        }
        return true;
    }
    false
}

/// Extracts the session id from a `codex resume <id>` shell argument list, so a resume
/// launch can rebind the original agent. `None` when the invocation isn't a `resume` of
/// a specific session (e.g. `codex resume --last`).
fn codex_resume_session_id(args: &[String]) -> Option<&str> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "resume" {
            return iter.find(|next| !next.starts_with('-')).map(String::as_str);
        }
        if arg == "--" {
            break;
        }
    }
    None
}

fn codex_value_flag(arg: &str) -> bool {
    matches!(
        arg,
        "--cd"
            | "-C"
            | "--add-dir"
            | "--model"
            | "-m"
            | "--sandbox"
            | "--ask-for-approval"
            | "--config"
            | "-c"
    )
}

fn codex_inline_value_flag(arg: &str) -> bool {
    [
        "--cd=",
        "--add-dir=",
        "--model=",
        "--sandbox=",
        "--ask-for-approval=",
        "--config=",
    ]
    .iter()
    .any(|prefix| arg.starts_with(prefix))
        || (arg.starts_with("-C") && arg.len() > 2)
        || (arg.starts_with("-m") && arg.len() > 2)
        || (arg.starts_with("-c") && arg.len() > 2)
}

fn ensure_codex_integration() -> Result<PathBuf, String> {
    let codex_home = codex_home()?;
    let qmux_cli = env::current_exe()
        .map_err(|err| format!("failed to resolve qmux executable for Codex hooks: {err}"))?;
    write_codex_integration_files(&codex_home, &qmux_cli)?;
    Ok(codex_home)
}

fn codex_home() -> Result<PathBuf, String> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .ok_or_else(|| "CODEX_HOME and HOME are not set; cannot configure Codex hooks".to_string())
}

fn qmux_cli_path() -> Result<String, String> {
    env::current_exe()
        .map(|path| path.display().to_string())
        .map_err(|err| format!("failed to resolve qmux executable for Codex hooks: {err}"))
}

fn write_codex_integration_files(codex_home: &Path, qmux_cli: &Path) -> Result<(), String> {
    let qmux_dir = codex_home.join("qmux");
    fs::create_dir_all(&qmux_dir)
        .map_err(|err| format!("failed to create {}: {err}", qmux_dir.display()))?;

    let shim_path = qmux_dir.join("qmux-codex-hook");
    let shim = codex_hook_shim();
    fs::write(&shim_path, shim)
        .map_err(|err| format!("failed to write {}: {err}", shim_path.display()))?;
    fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o755))
        .map_err(|err| format!("failed to chmod {}: {err}", shim_path.display()))?;

    let profile_path = codex_home.join(format!("{CODEX_QMUX_PROFILE}.config.toml"));
    let existing_profile = fs::read_to_string(&profile_path).ok();
    let profile = codex_profile_toml(&shim_path, qmux_cli, existing_profile.as_deref());
    fs::write(&profile_path, profile)
        .map_err(|err| format!("failed to write {}: {err}", profile_path.display()))?;

    Ok(())
}

fn codex_hook_shim() -> &'static str {
    r#"#!/bin/sh
event="${1:-}"
if [ -z "$event" ]; then
  exit 0
fi
if [ -z "${QMUX_SOCK:-}" ] || [ -z "${QMUX_TOKEN:-}" ] || [ -z "${QMUX_PANE_ID:-}" ] || [ -z "${QMUX_AGENT_ID:-}" ] || [ -z "${QMUX_CLI:-}" ]; then
  exit 0
fi
exec "$QMUX_CLI" notify "$event"
"#
}

fn codex_profile_toml(shim_path: &Path, qmux_cli: &Path, existing_profile: Option<&str>) -> String {
    let command_prefix = shell_quote_path(shim_path);
    let mut raw = String::new();
    raw.push_str("# Generated by qMux. Do not edit.\n");
    raw.push_str(
        "# This profile enables qMux Codex lifecycle hooks only for qMux-launched panes.\n",
    );
    raw.push_str(&format!("# qMux executable: {}\n\n", qmux_cli.display()));
    raw.push_str("[features]\n");
    raw.push_str("hooks = true\n\n");

    for event in CODEX_HOOK_EVENTS {
        if *event == "SessionStart" {
            raw.push_str("[[hooks.SessionStart]]\n");
            raw.push_str("matcher = \"startup|resume\"\n");
        } else {
            raw.push_str(&format!("[[hooks.{event}]]\n"));
        }
        raw.push_str(&format!("[[hooks.{event}.hooks]]\n"));
        raw.push_str("type = \"command\"\n");
        raw.push_str(&format!(
            "command = {}\n",
            toml_string(&format!("{command_prefix} {event}"))
        ));
        raw.push_str("timeout = 5\n\n");
    }

    if let Some(state) = existing_profile.and_then(codex_hooks_state_toml) {
        raw.push('\n');
        raw.push_str(state.trim_start_matches('\n'));
        if !raw.ends_with('\n') {
            raw.push('\n');
        }
    }

    raw
}

fn codex_hooks_state_toml(raw: &str) -> Option<&str> {
    let mut offset = 0;
    for line in raw.split_inclusive('\n') {
        if line.trim() == "[hooks.state]" {
            return Some(&raw[offset..]);
        }
        offset += line.len();
    }
    None
}

fn toml_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped.push('"');
    escaped
}

fn validate_shell_tail_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        if arg == "--" {
            break;
        }
        if arg == "--oss" {
            return Err("qMux Codex integration does not support --oss".to_string());
        }
        if arg == "--profile" || arg == "-p" || arg.starts_with("--profile=") {
            return Err(
                "qMux Codex integration uses its own profile and does not support --profile"
                    .to_string(),
            );
        }
        if arg.starts_with("-p") && arg.len() > 2 {
            return Err(
                "qMux Codex integration uses its own profile and does not support -p".to_string(),
            );
        }
    }
    Ok(())
}

/// Resolves an idle Codex agent: drains the next queued turn, or enters/stays paused.
/// Returns whether a turn was drained. Status/paused are written by
/// `advance_after_idle`; the passed agent is only used for its id afterward.
fn finish_agent_after_stop(state: &AppState, agent: &AgentInfo) -> Result<bool, String> {
    match advance_after_idle(state, &agent.id) {
        Ok(IdleResolution::Drained) => Ok(true),
        Ok(IdleResolution::Paused | IdleResolution::Idle) => Ok(false),
        Err(err) => {
            state.emit(QmuxEvent::new(
                "agent.queue_error",
                agent.pane_id.clone(),
                Some(agent.id.clone()),
                json!({ "error": err }),
            ));
            Ok(false)
        }
    }
}

const CODEX_TRANSCRIPT_DISCOVERY_ATTEMPTS: usize = 40;
const CODEX_TRANSCRIPT_DISCOVERY_DELAY: Duration = Duration::from_millis(250);

fn start_codex_transcript_binding(
    state: AppState,
    agent_id: String,
    session_id: Option<String>,
    transcript_path: Option<String>,
) {
    if let Some(transcript_path) = transcript_path {
        if codex_binding_should_continue(&state, &agent_id, false) {
            start_explicit_codex_transcript_binding(state, agent_id, session_id, transcript_path);
        }
        return;
    }

    let Some(session_id) = session_id.filter(|id| looks_like_codex_session_id(id)) else {
        // No usable session id and no explicit transcript path, so directory
        // discovery can't run. Surface a notice instead of leaving the timeline
        // silently empty.
        emit_codex_transcript_notice(
            &state,
            &agent_id,
            Some("Transcript unavailable: Codex did not report a usable session id"),
            None,
        );
        return;
    };
    if !codex_binding_should_continue(&state, &agent_id, true) {
        return;
    }
    let Ok(codex_home) = codex_home() else {
        return;
    };

    thread::spawn(move || {
        for attempt in 0..CODEX_TRANSCRIPT_DISCOVERY_ATTEMPTS {
            if !codex_binding_should_continue(&state, &agent_id, true) {
                return;
            }
            match find_codex_transcript_path(&codex_home, &session_id) {
                Ok(Some(path)) => {
                    let path_string = path.display().to_string();
                    if let Err(err) =
                        bind_codex_transcript_path(&state, &agent_id, Some(&session_id), &path)
                    {
                        emit_codex_transcript_notice(
                            &state,
                            &agent_id,
                            Some(&err),
                            Some(&path_string),
                        );
                    }
                    return;
                }
                Ok(None) => {}
                Err(err) => {
                    emit_codex_transcript_notice(&state, &agent_id, Some(&err), None);
                    return;
                }
            }

            if attempt + 1 < CODEX_TRANSCRIPT_DISCOVERY_ATTEMPTS {
                thread::sleep(CODEX_TRANSCRIPT_DISCOVERY_DELAY);
            }
        }

        emit_codex_transcript_notice(&state, &agent_id, Some("Transcript unavailable"), None);
    });
}

fn start_explicit_codex_transcript_binding(
    state: AppState,
    agent_id: String,
    expected_session_id: Option<String>,
    transcript_path: String,
) {
    thread::spawn(move || {
        let path = PathBuf::from(&transcript_path);
        for attempt in 0..CODEX_TRANSCRIPT_DISCOVERY_ATTEMPTS {
            if !codex_binding_should_continue(&state, &agent_id, false) {
                return;
            }
            match codex_transcript_path_ready(&path, expected_session_id.as_deref()) {
                Ok(true) => {
                    if let Err(err) = bind_codex_transcript_path(
                        &state,
                        &agent_id,
                        expected_session_id.as_deref(),
                        &path,
                    ) {
                        emit_codex_transcript_notice(
                            &state,
                            &agent_id,
                            Some(&err),
                            Some(&transcript_path),
                        );
                    }
                    return;
                }
                Ok(false) => {}
                Err(err) => {
                    emit_codex_transcript_notice(
                        &state,
                        &agent_id,
                        Some(&err),
                        Some(&transcript_path),
                    );
                    return;
                }
            }

            if attempt + 1 < CODEX_TRANSCRIPT_DISCOVERY_ATTEMPTS {
                thread::sleep(CODEX_TRANSCRIPT_DISCOVERY_DELAY);
            }
        }

        emit_codex_transcript_notice(
            &state,
            &agent_id,
            Some("Transcript unavailable"),
            Some(&transcript_path),
        );
    });
}

/// Whether a Codex transcript binding loop should keep running. Returns false
/// once the agent is gone, or — when `require_unbound` is set — once the agent
/// already has a transcript path (a duplicate SessionStart or prior iteration
/// bound it). A poisoned model lock is treated as transient so a momentary
/// failure does not tear down discovery.
fn codex_binding_should_continue(state: &AppState, agent_id: &str, require_unbound: bool) -> bool {
    match state.agent(agent_id) {
        Ok(Some(agent)) => !require_unbound || agent.transcript_path.is_none(),
        Ok(None) => false,
        Err(_) => true,
    }
}

fn codex_transcript_path_ready(
    path: &Path,
    expected_session_id: Option<&str>,
) -> Result<bool, String> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
        return Err("Codex transcript must be a .jsonl file".to_string());
    }

    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => {
            return Err(format!(
                "failed to inspect Codex transcript {}: {err}",
                path.display()
            ));
        }
    };
    if !metadata.is_file() {
        return Err(format!("Codex transcript {} is not a file", path.display()));
    }

    if let Some(expected_session_id) = expected_session_id {
        let Some(actual_session_id) = read_codex_transcript_session_id(path)? else {
            return Ok(false);
        };
        if actual_session_id != expected_session_id {
            // The file at this path currently belongs to a different session — it
            // may be a stale/rotated rollout, or still mid-write so its first line
            // is an older session_meta. Treat it as "not ready yet" so the caller
            // keeps polling rather than permanently aborting the binding; if it
            // never matches, the discovery loop emits a notice once attempts run
            // out.
            return Ok(false);
        }
    }

    Ok(true)
}

fn bind_codex_transcript_path(
    state: &AppState,
    agent_id: &str,
    expected_session_id: Option<&str>,
    path: &Path,
) -> Result<(), String> {
    let path_string = path.display().to_string();
    let mut should_start = false;
    let updated = state.mutate_agent(agent_id, |agent| {
        if let Some(expected_session_id) = expected_session_id {
            if agent
                .session_id
                .as_deref()
                .is_some_and(|current| current != expected_session_id)
            {
                return;
            }
            if agent.session_id.is_none() {
                agent.session_id = Some(expected_session_id.to_string());
            }
        }
        if agent.transcript_path.as_deref() != Some(path_string.as_str()) {
            agent.transcript_path = Some(path_string.clone());
        }
        should_start = true;
    })?;

    if should_start {
        if let Some(agent) = updated {
            state.emit(QmuxEvent::new(
                "agent.transcript_bound",
                agent.pane_id.clone(),
                Some(agent.id.clone()),
                json!({ "agent": agent, "transcriptPath": path_string }),
            ));
        }
        emit_codex_transcript_notice(state, agent_id, None, Some(&path_string));
        start_transcript_tail(
            state.clone(),
            agent_id.to_string(),
            path_string,
            "codex".to_string(),
        );
    }

    Ok(())
}

fn emit_codex_transcript_notice(
    state: &AppState,
    agent_id: &str,
    message: Option<&str>,
    path: Option<&str>,
) {
    state.emit(QmuxEvent::new(
        "transcript.notice",
        None,
        Some(agent_id.to_string()),
        json!({ "message": message, "path": path }),
    ));
}

fn find_codex_transcript_path(
    codex_home: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Ok(None);
    }
    let root = codex_home.join("sessions");
    if !root.exists() {
        return Ok(None);
    }

    let mut candidates = gather_transcript_candidates_recursive(&root)?
        .into_iter()
        .filter(|candidate| {
            codex_transcript_session_id(&candidate.path).as_deref() == Some(session_id)
        })
        .map(|candidate| (candidate.modified, candidate.path))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    Ok(candidates.into_iter().map(|(_, path)| path).next())
}

fn looks_like_codex_session_id(value: &str) -> bool {
    let value = value.trim();
    // Only a sanity gate to avoid scanning the sessions tree for an obviously
    // unusable id. Accept any non-empty id free of path separators and control
    // characters rather than requiring a canonical 36-char UUID, so a non-UUID id
    // scheme still drives directory discovery instead of silently binding nothing.
    !value.is_empty()
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(|ch| ch.is_control())
}

fn parse_transcript_line(agent_id: &str, source_index: usize, line: &str) -> Option<Turn> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let payload = value.get("payload")?;
    let item_type = payload.get("type").and_then(Value::as_str)?;
    let session_id =
        string_field(&value, "session_id").or_else(|| string_field(&value, "sessionId"));

    let (role, blocks) = match item_type {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str)?;
            if role == "developer" || role == "system" {
                return None;
            }
            let blocks = parse_codex_message_blocks(payload.get("content"))?;
            (role.to_string(), blocks)
        }
        "function_call" | "custom_tool_call" => {
            let name = string_field(payload, "name").unwrap_or_else(|| "tool".to_string());
            (
                "assistant".to_string(),
                vec![TurnBlock::ToolUse {
                    id: string_field(payload, "call_id")
                        .or_else(|| string_field(payload, "callId"))
                        .or_else(|| string_field(payload, "id")),
                    name,
                    input: codex_tool_input(payload),
                }],
            )
        }
        "function_call_output" | "custom_tool_call_output" => (
            "assistant".to_string(),
            vec![TurnBlock::ToolResult {
                tool_use_id: string_field(payload, "call_id")
                    .or_else(|| string_field(payload, "callId")),
                content: payload.get("output").cloned().unwrap_or(Value::Null),
                is_error: payload
                    .get("is_error")
                    .or_else(|| payload.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }],
        ),
        _ => return None,
    };

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
    })
}

fn parse_transcript_lifecycle_event(line: &str) -> Option<TranscriptLifecycleEvent> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    (payload.get("type").and_then(Value::as_str) == Some("turn_aborted"))
        .then_some(TranscriptLifecycleEvent::Interrupted)
}

fn parse_codex_message_blocks(content: Option<&Value>) -> Option<Vec<TurnBlock>> {
    match content? {
        Value::String(text) => Some(vec![TurnBlock::Text { text: text.clone() }]),
        Value::Array(items) => {
            let blocks = items
                .iter()
                .filter_map(|item| {
                    let block_type = item.get("type").and_then(Value::as_str);
                    match block_type {
                        Some("input_text" | "output_text" | "text") => item
                            .get("text")
                            .and_then(Value::as_str)
                            .map(|text| TurnBlock::Text {
                                text: text.to_string(),
                            }),
                        _ => None,
                    }
                })
                .collect::<Vec<_>>();
            Some(blocks)
        }
        _ => None,
    }
}

fn codex_tool_input(payload: &Value) -> Value {
    if let Some(arguments) = payload.get("arguments") {
        if let Some(arguments) = arguments.as_str() {
            return serde_json::from_str(arguments)
                .unwrap_or_else(|_| Value::String(arguments.to_string()));
        }
        return arguments.clone();
    }
    payload.get("input").cloned().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
        OpencodeAdapterConfig,
    };
    use crate::state::{AppState, PaneInfo, PaneRuntime, PaneStatus};
    use portable_pty::{Child, ChildKiller, ExitStatus, PtySize, native_pty_system};
    use std::io::{self, Write};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn svec(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn launch_options_reject_unknown_fields() {
        let err = CodexLaunchOptions::from_value(json!({ "bogus": true })).unwrap_err();

        assert!(err.contains("invalid Codex adapter options"));
    }

    #[test]
    fn launch_options_reject_removed_profile_and_oss_options() {
        let profile_err = CodexLaunchOptions::from_value(json!({ "profile": "work" })).unwrap_err();
        let oss_err = CodexLaunchOptions::from_value(json!({ "oss": true })).unwrap_err();

        assert!(profile_err.contains("invalid Codex adapter options"));
        assert!(oss_err.contains("invalid Codex adapter options"));
    }

    #[test]
    fn launch_options_validate_known_enums() {
        let err = CodexLaunchOptions::from_value(json!({ "sandbox": "full-send" })).unwrap_err();

        assert!(err.contains("invalid Codex adapter option sandbox"));
    }

    #[test]
    fn launch_options_reject_deprecated_on_failure_approval_policy() {
        let err =
            CodexLaunchOptions::from_value(json!({ "approvalPolicy": "on-failure" })).unwrap_err();

        assert!(err.contains("invalid Codex adapter option approvalPolicy"));
    }

    #[test]
    fn launch_options_validate_approvals_reviewer() {
        let err =
            CodexLaunchOptions::from_value(json!({ "approvalsReviewer": "robot" })).unwrap_err();

        assert!(err.contains("invalid Codex adapter option approvalsReviewer"));
    }

    #[test]
    fn build_args_adds_cwd_model_options_and_tail_args() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request",
            "search": true
        }))
        .unwrap();

        let args = build_codex_args(
            Path::new("/tmp/qmux"),
            Some(Path::new("/tmp/qmux/.qmux/workspaces")),
            Some("gpt-5"),
            &options,
            vec!["--".to_string(), "start here".to_string()],
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/qmux",
                "--add-dir",
                "/tmp/qmux/.qmux/workspaces",
                "--model",
                "gpt-5",
                "--profile",
                "qmux-codex",
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--search",
                "--",
                "start here"
            ]
        );
    }

    #[test]
    fn build_args_adds_auto_review_without_approval_policy_override() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review"
        }))
        .unwrap();

        let args = build_codex_args(Path::new("/tmp/qmux"), None, None, &options, Vec::new());

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/qmux",
                "--profile",
                "qmux-codex",
                "--sandbox",
                "workspace-write",
                "--config",
                "approvals_reviewer=\"auto_review\"",
                "--search"
            ]
        );
    }

    #[test]
    fn prompt_tail_args_trim_and_delimit_initial_prompt() {
        assert_eq!(prompt_tail_args("   "), Vec::<String>::new());
        assert_eq!(
            prompt_tail_args("  start here  "),
            vec!["--".to_string(), "start here".to_string()]
        );
    }

    #[test]
    fn args_contain_prompt_detects_interactive_codex_launches() {
        assert!(!args_contain_prompt(&[]));
        assert!(!args_contain_prompt(&svec(&["--model", "gpt-5"])));
        assert!(!args_contain_prompt(&svec(&[
            "--add-dir",
            "/tmp/workspaces"
        ])));
        assert!(!args_contain_prompt(&svec(&["--sandbox=workspace-write"])));
        assert!(!args_contain_prompt(&svec(&["--add-dir=/tmp/workspaces"])));
        assert!(!args_contain_prompt(&svec(&["--search"])));

        assert!(args_contain_prompt(&svec(&["fix the bug"])));
        assert!(args_contain_prompt(&svec(&[
            "--model",
            "gpt-5",
            "fix the bug"
        ])));
        assert!(args_contain_prompt(&svec(&["--", "after separator"])));

        // `codex resume ...` is an interactive subcommand, not an inline prompt, so the
        // rebound agent is marked Idle instead of being pinned as working.
        assert!(!args_contain_prompt(&svec(&["resume"])));
        assert!(!args_contain_prompt(&svec(&["resume", "sess-1"])));
        assert!(!args_contain_prompt(&svec(&["resume", "--last"])));
        assert!(!args_contain_prompt(&svec(&[
            "--model", "gpt-5", "resume", "sess-1"
        ])));
    }

    #[test]
    fn codex_resume_session_id_reads_the_resumed_session() {
        assert_eq!(
            codex_resume_session_id(&svec(&["resume", "sess-1"])),
            Some("sess-1")
        );
        // Not a resume invocation, or no concrete session id (e.g. `resume --last`).
        assert_eq!(codex_resume_session_id(&svec(&[])), None);
        assert_eq!(codex_resume_session_id(&svec(&["fix the bug"])), None);
        assert_eq!(codex_resume_session_id(&svec(&["resume"])), None);
        assert_eq!(codex_resume_session_id(&svec(&["resume", "--last"])), None);
    }

    #[test]
    fn resume_args_include_session_id_when_present() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request"
        }))
        .unwrap();

        let (args, resumed) = build_codex_resume_args(
            Path::new("/tmp/qmux"),
            Some(Path::new("/tmp/qmux/.qmux/workspaces")),
            Some("gpt-5"),
            &options,
            Some(" session-123 "),
        );

        assert!(resumed);
        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/qmux",
                "--add-dir",
                "/tmp/qmux/.qmux/workspaces",
                "--model",
                "gpt-5",
                "--profile",
                "qmux-codex",
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--search",
                "resume",
                "session-123"
            ]
        );
    }

    #[test]
    fn fork_args_include_session_id_and_prompt_when_present() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request"
        }))
        .unwrap();

        let args = build_codex_fork_args(
            Path::new("/tmp/qmux"),
            Some(Path::new("/tmp/qmux/.qmux/workspaces")),
            Some("gpt-5"),
            &options,
            " session-123 ",
            Some("  continue here  "),
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/qmux",
                "--add-dir",
                "/tmp/qmux/.qmux/workspaces",
                "--model",
                "gpt-5",
                "--profile",
                "qmux-codex",
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--search",
                "fork",
                "session-123",
                "--",
                "continue here"
            ]
        );
    }

    #[test]
    fn fork_args_omit_empty_prompt() {
        let options = CodexLaunchOptions::default();

        let args = build_codex_fork_args(
            Path::new("/tmp/qmux"),
            None,
            None,
            &options,
            "session-123",
            Some("   "),
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/qmux",
                "--profile",
                "qmux-codex",
                "--sandbox",
                "workspace-write",
                "--search",
                "fork",
                "session-123"
            ]
        );
    }

    #[test]
    fn resume_args_fall_back_to_fresh_launch_without_session_id() {
        let options = CodexLaunchOptions::default();

        let (args, resumed) =
            build_codex_resume_args(Path::new("/tmp/qmux"), None, None, &options, Some("   "));

        assert!(!resumed);
        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/qmux",
                "--profile",
                "qmux-codex",
                "--sandbox",
                "workspace-write",
                "--search"
            ]
        );
    }

    #[test]
    fn shell_tail_args_reject_profile_and_oss_before_delimiter() {
        let profile_args = vec!["--profile".to_string(), "work".to_string()];
        let inline_profile_args = vec!["--profile=work".to_string()];
        let short_profile_args = vec!["-pwork".to_string()];
        let oss_args = vec!["--oss".to_string()];
        let prompt_args = vec![
            "--".to_string(),
            "--profile".to_string(),
            "work".to_string(),
        ];

        assert!(validate_shell_tail_args(&profile_args).is_err());
        assert!(validate_shell_tail_args(&inline_profile_args).is_err());
        assert!(validate_shell_tail_args(&short_profile_args).is_err());
        assert!(validate_shell_tail_args(&oss_args).is_err());
        assert!(validate_shell_tail_args(&prompt_args).is_ok());
    }

    #[test]
    fn generated_profile_uses_stable_qmux_shim_and_inline_hooks() {
        let codex_home = temp_dir();
        let qmux_cli = Path::new("/Applications/qmux app/qmux");

        write_codex_integration_files(&codex_home, qmux_cli).unwrap();

        let profile_path = codex_home.join("qmux-codex.config.toml");
        let shim_path = codex_home.join("qmux").join("qmux-codex-hook");
        let profile = fs::read_to_string(profile_path).unwrap();
        let shim = fs::read_to_string(shim_path).unwrap();

        assert!(profile.contains("[features]"));
        assert!(profile.contains("hooks = true"));
        assert!(profile.contains("[[hooks.SessionStart]]"));
        assert!(profile.contains("matcher = \"startup|resume\""));
        assert!(profile.contains("[[hooks.Stop]]"));
        assert!(profile.contains("qmux-codex-hook' Stop"));
        assert!(profile.contains("qMux executable: /Applications/qmux app/qmux"));
        assert!(shim.contains("QMUX_SOCK"));
        assert!(shim.contains("exec \"$QMUX_CLI\" notify \"$event\""));
    }

    #[test]
    fn generated_profile_preserves_codex_hook_trust_state() {
        let codex_home = temp_dir();
        let qmux_cli = Path::new("/Applications/qmux app/qmux");
        let profile_path = codex_home.join("qmux-codex.config.toml");

        fs::write(
            &profile_path,
            r#"[features]
hooks = true

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "'/old/qmux-codex-hook' Stop"
timeout = 5

[hooks.state]

[hooks.state."/Users/raymond/.codex/qmux-codex.config.toml:stop:0:0"]
trusted_hash = "sha256:trusted"
"#,
        )
        .unwrap();

        write_codex_integration_files(&codex_home, qmux_cli).unwrap();

        let profile = fs::read_to_string(profile_path).unwrap();
        assert!(profile.contains("command = \"'/"));
        assert!(profile.contains("qmux-codex-hook' Stop"));
        assert!(profile.contains("[hooks.state]"));
        assert!(profile.contains("trusted_hash = \"sha256:trusted\""));
        assert!(!profile.contains("command = \"'/old/qmux-codex-hook' Stop\""));
    }

    #[test]
    fn composer_policy_queues_running_codex_panes() {
        let policy = CodexAdapter {
            binary: "codex".to_string(),
        }
        .composer_policy();

        assert!(!policy.can_send(AgentStatus::Running));
        assert!(policy.should_queue(AgentStatus::Running));
        assert!(policy.can_steer(AgentStatus::Running));
    }

    #[test]
    fn interactive_codex_attach_marks_agent_idle() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_codex_agent_pane(&state, "agent-1", "pane-1".to_string(), false).unwrap();

        assert!(matches!(attached.status, AgentStatus::Idle));
        let stored = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(stored.status, AgentStatus::Idle));
    }

    #[test]
    fn prompted_codex_attach_marks_agent_running() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_codex_agent_pane(&state, "agent-1", "pane-1".to_string(), true).unwrap();

        assert!(matches!(attached.status, AgentStatus::Running));
        let stored = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(stored.status, AgentStatus::Running));
    }

    #[test]
    fn pre_spawn_fork_attach_allows_session_start_to_record_fork_session() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Idle;
        agent.pane_id = None;
        agent.parent_id = Some("agent-source".to_string());
        agent.fork_point = Some("source-session".to_string());
        agent.root_session_id = Some("root-session".to_string());
        state.insert_agent(agent).unwrap();

        let attached =
            attach_codex_agent_pane(&state, "agent-1", "pane-1".to_string(), false).unwrap();
        assert_eq!(attached.pane_id.as_deref(), Some("pane-1"));
        assert!(matches!(attached.status, AgentStatus::Idle));

        let event = ingest(
            &state,
            hook_for_agent(
                "SessionStart",
                "agent-1",
                json!({ "session_id": "fork-session" }),
            ),
        );

        assert_eq!(event.event_type, "agent.session_start");
        let stored = state.agent("agent-1").unwrap().expect("agent exists");
        assert_eq!(stored.pane_id.as_deref(), Some("pane-1"));
        assert_eq!(stored.session_id.as_deref(), Some("fork-session"));
        assert_eq!(stored.parent_id.as_deref(), Some("agent-source"));
        assert_eq!(stored.fork_point.as_deref(), Some("source-session"));
        assert_eq!(stored.root_session_id.as_deref(), Some("root-session"));
    }

    #[test]
    fn session_start_captures_codex_resource_id() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        state.insert_agent(agent).unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "SessionStart",
                "agent-1",
                json!({ "resource_id": "codex-session-1" }),
            ),
        );

        assert_eq!(event.event_type, "agent.session_start");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert_eq!(agent.session_id.as_deref(), Some("codex-session-1"));
        // SessionStart records the resource id but no longer promotes status: a
        // session merely starting doesn't mean a turn is running, so the agent keeps
        // whatever status it had (here Starting) until a real prompt/tool hook lands.
        assert!(matches!(agent.status, AgentStatus::Starting));
    }

    #[test]
    fn session_start_preserves_interactive_codex_status() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::AwaitingInput;
        state.insert_agent(agent).unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "SessionStart",
                "agent-1",
                json!({ "resource_id": "codex-session-1" }),
            ),
        );

        assert_eq!(event.event_type, "agent.session_start");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert_eq!(agent.session_id.as_deref(), Some("codex-session-1"));
        assert!(matches!(agent.status, AgentStatus::AwaitingInput));
    }

    #[test]
    fn session_start_without_resource_id_keeps_a_recorded_one() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        state.insert_agent(agent).unwrap();

        // The first SessionStart records the resource/session id.
        ingest(
            &state,
            hook_for_agent(
                "SessionStart",
                "agent-1",
                json!({ "resource_id": "codex-session-1" }),
            ),
        );
        assert_eq!(
            state
                .agent("agent-1")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("codex-session-1")
        );

        // A late/duplicate SessionStart that omits the id must not blank it.
        ingest(&state, hook_for_agent("SessionStart", "agent-1", json!({})));
        assert_eq!(
            state
                .agent("agent-1")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("codex-session-1")
        );
    }

    #[test]
    fn session_start_binds_explicit_codex_transcript_path() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        state.insert_agent(agent).unwrap();
        let transcript_path = temp_dir().join("codex-session.jsonl");
        fs::write(
            &transcript_path,
            r#"{"type":"session_meta","payload":{"id":"019eeca7-d820-7b91-b1e8-9c954fb1a105"}}"#,
        )
        .unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "SessionStart",
                "agent-1",
                json!({
                    "resource_id": "019eeca7-d820-7b91-b1e8-9c954fb1a105",
                    "transcript_path": transcript_path.display().to_string()
                }),
            ),
        );

        assert_eq!(event.event_type, "agent.session_start");
        let agent = wait_for_agent_transcript_path(&state, "agent-1", &transcript_path);
        assert_eq!(
            agent.session_id.as_deref(),
            Some("019eeca7-d820-7b91-b1e8-9c954fb1a105")
        );
        assert_eq!(
            agent.transcript_path.as_deref(),
            Some(transcript_path.to_str().unwrap())
        );
    }

    #[test]
    fn explicit_codex_transcript_path_treats_session_mismatch_as_not_ready() {
        let transcript_path = temp_dir().join("codex-session.jsonl");
        fs::write(
            &transcript_path,
            r#"{"type":"session_meta","payload":{"id":"019eeca7-d820-7b91-b1e8-9c954fb1a105"}}"#,
        )
        .unwrap();

        // A path whose first line currently names a different session is treated as
        // "not ready yet" (it may be a stale/rotated rollout or still mid-write), so
        // the binding loop keeps polling rather than aborting permanently.
        let ready = codex_transcript_path_ready(
            &transcript_path,
            Some("029eeca7-d820-7b91-b1e8-9c954fb1a105"),
        )
        .unwrap();

        assert!(!ready);
    }

    #[test]
    fn codex_binding_continues_for_alive_unbound_agent() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.transcript_path = None;
        state.insert_agent(agent).unwrap();

        assert!(codex_binding_should_continue(&state, "agent-1", true));
        assert!(codex_binding_should_continue(&state, "agent-1", false));
    }

    #[test]
    fn codex_binding_stops_when_agent_is_gone() {
        let state = test_state();

        assert!(!codex_binding_should_continue(&state, "missing", true));
        assert!(!codex_binding_should_continue(&state, "missing", false));
    }

    #[test]
    fn codex_binding_stops_when_transcript_bound_only_with_require_unbound() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.transcript_path = Some("/tmp/session.jsonl".to_string());
        state.insert_agent(agent).unwrap();

        assert!(
            !codex_binding_should_continue(&state, "agent-1", true),
            "discovery should stop when transcript is already bound"
        );
        assert!(
            codex_binding_should_continue(&state, "agent-1", false),
            "explicit path binding should continue even when transcript is bound"
        );
    }

    #[test]
    fn bind_codex_transcript_path_skips_when_session_id_mismatches() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.session_id = Some("different-session".to_string());
        state.insert_agent(agent).unwrap();
        let transcript_path = temp_dir().join("codex-mismatch.jsonl");
        fs::write(
            &transcript_path,
            r#"{"type":"session_meta","payload":{"id":"target-session"}}"#,
        )
        .unwrap();

        bind_codex_transcript_path(&state, "agent-1", Some("target-session"), &transcript_path)
            .unwrap();

        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert_eq!(
            agent.transcript_path, None,
            "transcript should not be bound when session_id mismatches"
        );
        assert_eq!(
            agent.session_id.as_deref(),
            Some("different-session"),
            "session_id should not be overwritten"
        );
    }

    #[test]
    fn explicit_codex_transcript_binding_retries_until_file_appears() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        state.insert_agent(agent).unwrap();
        let transcript_path = temp_dir().join("codex-late.jsonl");
        let session_id = "019eeca7-d820-7b91-b1e8-9c954fb1a105";
        let path_for_writer = transcript_path.clone();
        let sid_for_writer = session_id.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            fs::write(
                &path_for_writer,
                format!(r#"{{"type":"session_meta","payload":{{"id":"{sid_for_writer}"}}}}"#),
            )
            .unwrap();
        });

        start_codex_transcript_binding(
            state.clone(),
            "agent-1".to_string(),
            Some(session_id.to_string()),
            Some(transcript_path.display().to_string()),
        );

        let agent = wait_for_agent_transcript_path(&state, "agent-1", &transcript_path);
        assert_eq!(agent.session_id.as_deref(), Some(session_id));
    }

    #[test]
    fn codex_discovery_binds_when_file_appears_late() {
        let codex_home = temp_dir();
        let session_id = "019eeca7-d820-7b91-b1e8-9c954fb1a105";
        let session_dir = codex_home
            .join("sessions")
            .join("2026")
            .join("06")
            .join("21");
        fs::create_dir_all(&session_dir).unwrap();
        let transcript_path =
            session_dir.join(format!("rollout-2026-06-21T20-08-03-{session_id}.jsonl"));
        let path_for_writer = transcript_path.clone();
        let sid_for_writer = session_id.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            fs::write(
                &path_for_writer,
                format!(r#"{{"type":"session_meta","payload":{{"id":"{sid_for_writer}"}}}}"#),
            )
            .unwrap();
        });

        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.session_id = Some(session_id.to_string());
        state.insert_agent(agent).unwrap();

        let prev = env::var_os("CODEX_HOME");
        unsafe {
            env::set_var("CODEX_HOME", &codex_home);
        }

        start_codex_transcript_binding(
            state.clone(),
            "agent-1".to_string(),
            Some(session_id.to_string()),
            None,
        );

        let agent = wait_for_agent_transcript_path(&state, "agent-1", &transcript_path);
        assert_eq!(agent.session_id.as_deref(), Some(session_id));

        unsafe {
            match prev {
                Some(val) => env::set_var("CODEX_HOME", val),
                None => env::remove_var("CODEX_HOME"),
            }
        }
    }

    #[test]
    fn codex_discovery_skips_when_transcript_already_bound() {
        let state = test_state();
        let existing_path = temp_dir().join("existing.jsonl");
        let mut agent = sample_agent();
        agent.transcript_path = Some(existing_path.display().to_string());
        state.insert_agent(agent).unwrap();

        start_codex_transcript_binding(
            state.clone(),
            "agent-1".to_string(),
            Some("019eeca7-d820-7b91-b1e8-9c954fb1a105".to_string()),
            None,
        );

        thread::sleep(Duration::from_millis(300));

        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert_eq!(
            agent.transcript_path.as_deref(),
            Some(existing_path.to_str().unwrap()),
            "transcript_path should not be overridden by discovery when already bound"
        );
    }

    #[test]
    fn codex_transcript_discovery_matches_session_meta_id() {
        let codex_home = temp_dir();
        let session_id = "019eeca7-d820-7b91-b1e8-9c954fb1a105";
        let session_dir = codex_home
            .join("sessions")
            .join("2026")
            .join("06")
            .join("21");
        fs::create_dir_all(&session_dir).unwrap();
        let matching = session_dir.join("rollout-2026-06-21T20-08-03-short-id.jsonl");
        let wrong = session_dir.join(format!("rollout-2026-06-21T20-08-04-{session_id}.jsonl"));
        fs::write(
            &matching,
            format!(r#"{{"type":"session_meta","payload":{{"id":"{session_id}"}}}}"#),
        )
        .unwrap();
        fs::write(
            &wrong,
            r#"{"type":"session_meta","payload":{"id":"not-the-session"}}"#,
        )
        .unwrap();

        let found = find_codex_transcript_path(&codex_home, session_id)
            .unwrap()
            .expect("matching transcript found");

        assert_eq!(found, matching);
    }

    #[test]
    fn parse_codex_message_response_items() {
        let user_line = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "fix the bug" }]
            }
        })
        .to_string();
        let assistant_line = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Done." }]
            }
        })
        .to_string();

        let user = parse_transcript_line("agent-1", 3, &user_line).expect("user turn");
        let assistant =
            parse_transcript_line("agent-1", 4, &assistant_line).expect("assistant turn");

        assert_eq!(user.role, "user");
        assert_eq!(assistant.role, "assistant");
        assert_text_block(&user.blocks[0], "fix the bug");
        assert_text_block(&assistant.blocks[0], "Done.");
    }

    #[test]
    fn parse_codex_tool_call_and_result_response_items() {
        let call_line = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call-1",
                "arguments": "{\"cmd\":\"npm test\"}"
            }
        })
        .to_string();
        let result_line = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "ok"
            }
        })
        .to_string();

        let call = parse_transcript_line("agent-1", 5, &call_line).expect("tool call");
        let result = parse_transcript_line("agent-1", 6, &result_line).expect("tool result");

        assert_eq!(call.role, "assistant");
        match &call.blocks[0] {
            TurnBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_deref(), Some("call-1"));
                assert_eq!(name, "exec_command");
                assert_eq!(input["cmd"], "npm test");
            }
            other => panic!("unexpected block: {other:?}"),
        }
        match &result.blocks[0] {
            TurnBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-1"));
                assert_eq!(content, "ok");
                assert!(!is_error);
            }
            other => panic!("unexpected block: {other:?}"),
        }
    }

    #[test]
    fn parse_codex_transcript_skips_duplicates_and_private_context() {
        let event_line = json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "fix the bug" }
        })
        .to_string();
        let developer_line = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "hidden" }]
            }
        })
        .to_string();
        let reasoning_line = json!({
            "type": "response_item",
            "payload": { "type": "reasoning", "summary": [] }
        })
        .to_string();

        assert!(parse_transcript_line("agent-1", 1, &event_line).is_none());
        assert!(parse_transcript_line("agent-1", 2, &developer_line).is_none());
        assert!(parse_transcript_line("agent-1", 3, &reasoning_line).is_none());
    }

    #[test]
    fn parse_codex_turn_aborted_lifecycle_event() {
        let abort_line = json!({
            "type": "event_msg",
            "payload": {
                "type": "turn_aborted",
                "turn_id": "turn-1",
                "reason": "interrupted"
            }
        })
        .to_string();
        let user_message_line = json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "fix the bug" }
        })
        .to_string();

        assert_eq!(
            parse_transcript_lifecycle_event(&abort_line),
            Some(TranscriptLifecycleEvent::Interrupted)
        );
        assert_eq!(parse_transcript_lifecycle_event(&user_message_line), None);
    }

    #[test]
    fn permission_request_marks_codex_awaiting_permission() {
        let state = test_state();
        state.insert_agent(sample_agent()).unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "PermissionRequest",
                "agent-1",
                json!({ "tool_name": "Bash" }),
            ),
        );

        assert_eq!(event.event_type, "agent.awaiting_permission");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::AwaitingPermission));
    }

    #[test]
    fn stop_marks_codex_done_without_queued_turns() {
        let state = test_state();
        state.insert_agent(sample_agent()).unwrap();

        let event = ingest(&state, hook_for_agent("Stop", "agent-1", json!({})));

        assert_eq!(event.event_type, "agent.done");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Done));
    }

    #[test]
    fn stop_drains_one_queued_codex_turn() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        state
            .enqueue_agent_turn("agent-1", "first".to_string())
            .unwrap();
        state
            .enqueue_agent_turn("agent-1", "second".to_string())
            .unwrap();

        let event = ingest(&state, hook_for_agent("Stop", "agent-1", json!({})));

        assert_eq!(event.event_type, "agent.running");
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["second".to_string()]
        );
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Running));
        let written = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        assert!(written.contains("first"));
        assert!(!written.contains("second"));
    }

    #[test]
    fn shell_escape_prompt_submit_preserves_ready_codex_status() {
        let state = test_state();
        state.insert_agent(sample_agent()).unwrap();
        state
            .set_agent_status("agent-1", AgentStatus::Done)
            .unwrap();
        state
            .record_agent_send(
                "agent-1",
                "!git status".to_string(),
                crate::state::AgentSendSource::DirectSend,
            )
            .unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "UserPromptSubmit",
                "agent-1",
                json!({ "prompt": "!git status" }),
            ),
        );

        assert_eq!(event.event_type, "agent.prompt_submitted");
        assert_eq!(event.payload["sendTracking"]["status"], "matched");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Done));
    }

    fn test_state() -> AppState {
        AppState::new(QmuxConfig {
            workspace_root: temp_dir(),
            socket_path: PathBuf::from("/tmp/qmux-codex-test.sock"),
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
        })
    }

    fn sample_agent() -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "codex".to_string(),
            worktree_dir: "/tmp/qmux-codex-test".to_string(),
            branch: None,
            pane_id: Some("pane-1".to_string()),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Running,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
            created_at: 1,
        }
    }

    fn install_agent_pane(state: &AppState) -> Arc<Mutex<Vec<u8>>> {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        drop(pair.slave);

        state.insert_agent(sample_agent()).unwrap();
        state
            .insert_pane(PaneRuntime {
                info: PaneInfo {
                    id: "pane-1".to_string(),
                    title: "Codex".to_string(),
                    kind: PaneKind::Agent,
                    agent_id: Some("agent-1".to_string()),
                    group_id: "group-1".to_string(),
                    cwd: "/tmp/qmux-codex-test".to_string(),
                    cols: 80,
                    rows: 24,
                    status: PaneStatus::Running,
                    last_active_at: 0,
                    recovered: false,
                    depth: 0,
                },
                child: Arc::new(Mutex::new(Box::new(FakeChild))),
                master: Arc::new(Mutex::new(pair.master)),
                writer: Arc::new(Mutex::new(Box::new(RecordingWriter {
                    bytes: bytes.clone(),
                }))),
                backlog: Default::default(),
                skip_scrollback_restore: false,
            })
            .unwrap();
        bytes
    }

    fn hook_for_agent(
        event: &str,
        agent_id: &str,
        payload: serde_json::Value,
    ) -> AdapterNotification {
        AdapterNotification {
            adapter_id: None,
            event: event.to_string(),
            pane_id: Some("pane-1".to_string()),
            agent_id: Some(agent_id.to_string()),
            payload,
        }
    }

    fn ingest(state: &AppState, notification: AdapterNotification) -> QmuxEvent {
        match CodexAdapter::new(state.config()).ingest_notification(state, notification) {
            Ok(AdapterNotificationOutcome::Event(event)) => event,
            Ok(AdapterNotificationOutcome::Events(mut events)) => events.remove(0),
            Err(err) => panic!("{err}"),
        }
    }

    fn assert_text_block(block: &TurnBlock, expected: &str) {
        match block {
            TurnBlock::Text { text } => assert_eq!(text, expected),
            other => panic!("unexpected block: {other:?}"),
        }
    }

    fn wait_for_agent_transcript_path(
        state: &AppState,
        agent_id: &str,
        expected_path: &Path,
    ) -> AgentInfo {
        let expected = expected_path.to_str().expect("test path is utf-8");
        for _ in 0..20 {
            let agent = state.agent(agent_id).unwrap().expect("agent exists");
            if agent.transcript_path.as_deref() == Some(expected) {
                return agent;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("agent transcript path was not bound to {expected}");
    }

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = env::temp_dir().join(format!("qmux-codex-{nanos}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[derive(Debug)]
    struct FakeChild;

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(FakeChild)
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    struct RecordingWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
