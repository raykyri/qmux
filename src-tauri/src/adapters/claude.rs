use super::{
    AdapterNotification, AdapterNotificationOutcome, AgentAdapter, ComposerPolicy, LaunchEnv,
    PermissionAction, PrepareShellAgentLaunchRequest, PreparedShellAgentLaunch,
    ShellCommandIntegration, SpawnAgentRequest, ensure_on_path, shell_quote_path,
};
use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::pty::{InitialPaneSize, PtySpawnSpec, qmux_pane_envs, recoverable_dir, spawn_pty};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::transcript::{Turn, TurnBlock, start_transcript_tail};
use crate::turn_queue::{IdleResolution, advance_after_idle};
use crate::workspace::{
    AgentInfo, AgentStatus, PrepareAgentWorkspaceRequest, attach_agent_pane, mark_agent_failed,
    mark_agent_spawn_failed, prepare_agent_workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SubagentStop",
];

const CLAUDE_NOTIFICATION_MATCHERS: &[(&str, &str)] = &[
    ("permission_prompt", "Notification.permission_prompt"),
    ("idle_prompt", "Notification.idle_prompt"),
    ("elicitation_dialog", "Notification.elicitation_dialog"),
];

const CLAUDE_PERMISSION_MODES: &[&str] = &[
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "default",
    "dontAsk",
    "plan",
];

#[derive(Clone, Debug)]
pub struct ClaudeAdapter {
    binary: String,
    plugin_dir: PathBuf,
}

impl ClaudeAdapter {
    pub fn new(config: &QmuxConfig) -> Self {
        Self {
            binary: config.claude_binary(),
            plugin_dir: config.claude_plugin_dir.clone(),
        }
    }

    /// `--plugin-dir` args that inject the qmux-managed plugin (and its skills)
    /// into a launched Claude instance. Emitted only when the plugin directory
    /// actually exists, so a checkout without one launches cleanly. This is the
    /// sole skill-injection vector: it points at a qmux-owned directory and never
    /// touches the user's `~/.claude` or the project's `.claude`.
    fn plugin_dir_args(&self) -> Vec<String> {
        if self.plugin_dir.is_dir() {
            vec![
                "--plugin-dir".to_string(),
                self.plugin_dir.display().to_string(),
            ]
        } else {
            Vec::new()
        }
    }

    fn ensure_binary(&self) -> Result<String, String> {
        let binary = ensure_on_path(&self.binary).ok_or_else(|| {
            format!(
                "Claude adapter binary '{}' was not found on PATH or standard macOS tool paths. Install Claude Code or update adapters.claude.binary in qmux.config.json.",
                self.binary
            )
        })?;
        Ok(binary.display().to_string())
    }
}

impl AgentAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn display_name(&self) -> &'static str {
        "Claude"
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
            command_name: "claude",
            adapter_id: self.id(),
        }]
    }

    fn ingest_notification(
        &self,
        state: &AppState,
        notification: AdapterNotification,
    ) -> Result<AdapterNotificationOutcome, String> {
        self.ingest_hook_notification(state, notification)
    }

    fn parse_transcript_line(
        &self,
        agent_id: &str,
        source_index: usize,
        line: &str,
    ) -> Option<Turn> {
        parse_transcript_line(agent_id, source_index, line)
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
            permission_actions: vec![
                PermissionAction {
                    id: "approve",
                    label: "Approve",
                    input: "y",
                },
                PermissionAction {
                    id: "deny",
                    label: "Deny",
                    input: "n",
                },
            ],
        }
    }
}

impl ClaudeAdapter {
    fn spawn_pane(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        let binary = self.ensure_binary()?;
        let options = ClaudeLaunchOptions::from_value(request.options)?;

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
            return Err(format!(
                "Claude working directory {} does not exist",
                cwd.display()
            ));
        }
        let pane_id = state.next_id("pane");
        let settings_path = match write_hook_settings(&agent) {
            Ok(settings_path) => settings_path,
            Err(err) => {
                let _ = mark_agent_failed(state, &agent.id);
                return Err(err);
            }
        };
        let mut args = vec![
            "--settings".to_string(),
            settings_path.display().to_string(),
        ];
        args.extend(self.plugin_dir_args());

        if let Some(model) = request.model.filter(|model| !model.trim().is_empty()) {
            args.push("--model".to_string());
            args.push(model);
        }

        let permission_mode = options.permission_mode.unwrap_or("auto".to_string());
        args.push("--permission-mode".to_string());
        args.push(permission_mode);

        let prompt = request.prompt.trim();
        let has_prompt = !prompt.is_empty();
        if has_prompt {
            args.push(prompt.to_string());
        }

        let mut envs = qmux_pane_envs(state, &pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));

        attach_agent_pane(state, &agent.id, pane_id.clone())?;

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
                if !has_prompt {
                    // Launched without a prompt: Claude opens interactively and waits
                    // for input, so present the tab as having an agent that is awaiting
                    // input rather than working. Field-scoped write — a full-struct
                    // update here would race the SessionStart hook recording session_id.
                    state.set_agent_status(&agent.id, AgentStatus::AwaitingInput)?;
                }
                Ok(pane)
            }
            Err(err) => {
                let _ = mark_agent_spawn_failed(state, &agent.id, &pane_id);
                Err(err)
            }
        }
    }

    /// Forks `source` into a new agent pane: a fresh Claude started with
    /// `--resume <source session> --fork-session`, so it inherits the source's
    /// transcript but writes to a new session id (the source is unaffected). Runs in
    /// the source's directory, or a fresh worktree when `use_worktree` is set.
    pub fn fork_pane(
        &self,
        state: &AppState,
        source: &AgentInfo,
        use_worktree: bool,
    ) -> Result<(PaneInfo, AgentInfo), String> {
        let binary = self.ensure_binary()?;
        let session_id = source
            .session_id
            .clone()
            .map(|session| session.trim().to_string())
            .filter(|session| !session.is_empty())
            .ok_or_else(|| {
                "this Claude session isn't ready to fork yet (no session id); send a turn first"
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

        // Record fork lineage and the awaiting-input status before the process starts,
        // so the fork's own SessionStart hook (which overwrites session_id) can't race
        // ahead of the lineage write.
        agent.parent_id = Some(source.id.clone());
        agent.fork_point = Some(session_id.clone());
        agent.root_session_id = source
            .root_session_id
            .clone()
            .or_else(|| Some(session_id.clone()));
        agent.status = AgentStatus::AwaitingInput;
        state.update_agent(agent.clone())?;

        let cwd = recoverable_dir(&agent.worktree_dir).ok_or_else(|| {
            format!(
                "fork working directory {} does not exist",
                agent.worktree_dir
            )
        })?;

        let settings_path = match write_hook_settings(&agent) {
            Ok(settings_path) => settings_path,
            Err(err) => {
                let _ = mark_agent_failed(state, &agent.id);
                return Err(err);
            }
        };

        let pane_id = state.next_id("pane");
        let mut args = vec![
            "--settings".to_string(),
            settings_path.display().to_string(),
        ];
        args.extend(self.plugin_dir_args());
        if let Some(model) = agent.model.clone().filter(|model| !model.trim().is_empty()) {
            args.push("--model".to_string());
            args.push(model);
        }
        args.push("--permission-mode".to_string());
        args.push("auto".to_string());
        args.push("--resume".to_string());
        args.push(session_id);
        args.push("--fork-session".to_string());

        let mut envs = qmux_pane_envs(state, &pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));

        attach_agent_pane(state, &agent.id, pane_id.clone())?;

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
                initial_size: None,
                recovered: false,
            },
        );

        let pane = match spawn_result {
            Ok(pane) => pane,
            Err(err) => {
                let _ = mark_agent_spawn_failed(state, &agent.id, &pane_id);
                return Err(err);
            }
        };

        // Restore AwaitingInput after the early pane bind (attach promotes to Running,
        // but a resumed fork with no prompt is sitting idle waiting for the user). Use a
        // field-scoped status write, not a full-struct update: the spawned fork's
        // SessionStart hook may already be recording its new session_id/transcript on
        // another thread, and a stale snapshot write here would wipe them.
        let forked = state
            .set_agent_status(&agent.id, AgentStatus::AwaitingInput)?
            .ok_or_else(|| format!("forked agent {} disappeared during spawn", agent.id))?;

        Ok((pane, forked))
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

        let settings_path = write_hook_settings(agent)?;
        let mut args = vec![
            "--settings".to_string(),
            settings_path.display().to_string(),
        ];
        args.extend(self.plugin_dir_args());

        if let Some(model) = agent.model.clone().filter(|model| !model.trim().is_empty()) {
            args.push("--model".to_string());
            args.push(model);
        }

        let resumed = match agent
            .session_id
            .clone()
            .filter(|session_id| !session_id.trim().is_empty())
        {
            Some(session_id) => {
                args.push("--resume".to_string());
                args.push(session_id);
                true
            }
            None => false,
        };

        let mut envs = qmux_pane_envs(state, &pane.id)?;
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

        // Re-bind the agent to its restored pane. Status returns to Starting until the
        // resumed session's hooks report otherwise; that also keeps queued turns held
        // (rather than sent) until the agent is idle again.
        let mut restored = agent.clone();
        restored.pane_id = Some(pane.id.clone());
        restored.status = AgentStatus::Starting;
        state.update_agent(restored.clone())?;

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
                "Claude working directory {} does not exist",
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
                // Typing `claude` in a shell runs in the current directory; no worktree.
                use_worktree: false,
            },
        )?;
        let settings_path = match write_hook_settings(&agent) {
            Ok(settings_path) => settings_path,
            Err(err) => {
                let _ = mark_agent_failed(state, &agent.id);
                return Err(err);
            }
        };
        let agent = attach_agent_pane(state, &agent.id, request.pane_id.clone())?;
        let agent = if !args_contain_prompt(&request.args) {
            // A bare `claude` (no inline prompt) drops into interactive mode and
            // waits for the user, so present the tab as having an agent that is
            // awaiting input rather than working. The first real turn promotes it.
            // Field-scoped write — a full-struct update here would race the
            // SessionStart hook recording session_id; carry the post-write state so
            // the agent.spawned event below ships the right status.
            state
                .set_agent_status(&agent.id, AgentStatus::AwaitingInput)?
                .unwrap_or(agent)
        } else {
            agent
        };

        let mut envs = qmux_pane_envs(state, &request.pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        let agent_id = agent.id.clone();
        let worktree_dir = agent.worktree_dir.clone();
        state.emit(QmuxEvent::new(
            "agent.spawned",
            Some(request.pane_id),
            Some(agent_id),
            json!({ "agent": agent.clone(), "source": "shell" }),
        ));

        let mut args = vec![
            "--settings".to_string(),
            settings_path.display().to_string(),
        ];
        args.extend(self.plugin_dir_args());
        args.extend(request.args);

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

    fn ingest_hook_notification(
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
        let event_type = match notification.event.as_str() {
            "SessionStart" => {
                if let Some(current) = agent.as_ref() {
                    let session_id = string_field(&notification.payload, "session_id")
                        .or_else(|| string_field(&notification.payload, "sessionId"));
                    let transcript_path = string_field(&notification.payload, "transcript_path")
                        .or_else(|| string_field(&notification.payload, "transcriptPath"));
                    // Field-scoped mutation, not a full-struct `update_agent`: this
                    // freshly spawned process's pane is being bound by attach_agent_pane
                    // on another thread, and a stale-snapshot write here would race it —
                    // wiping either the pane_id it set or the session_id we set.
                    let updated = state.mutate_agent(&current.id, |agent| {
                        // Same guard as transcript_path below: only overwrite when this
                        // event carries a session id. A late/duplicate SessionStart that
                        // omits it must not blank a recorded one, which fork + recovery
                        // key off.
                        if let Some(session_id) = session_id {
                            agent.session_id = Some(session_id);
                        }
                        // Only overwrite a known-good transcript path when this event
                        // actually carries one. A SessionStart whose payload omits the
                        // field must not blank the path out from under a running tail,
                        // which would silently freeze the timeline while the agent runs.
                        if let Some(transcript_path) = transcript_path {
                            agent.transcript_path = Some(transcript_path);
                        }
                        // A session starting doesn't mean a turn is running. When the
                        // agent was launched without a prompt it is idle and awaiting
                        // input, so don't promote that to Running here — the first real
                        // turn (UserPromptSubmit/PreToolUse) does. Resume keeps its
                        // Starting status, which still advances to Running.
                        if agent.status != AgentStatus::AwaitingInput {
                            agent.status = AgentStatus::Running;
                        }
                    })?;
                    if let Some(transcript_path) = updated.and_then(|agent| agent.transcript_path) {
                        start_transcript_tail(
                            state.clone(),
                            current.id.clone(),
                            transcript_path,
                            self.id().to_string(),
                        );
                    }
                }
                "agent.session_start"
            }
            "UserPromptSubmit" => {
                if let Some(agent) = agent.as_mut() {
                    agent.status = AgentStatus::Running;
                    state.set_agent_status(&agent.id, agent.status)?;
                    if !is_subagent_payload(&notification.payload) {
                        let prompt = string_field(&notification.payload, "prompt");
                        send_tracking =
                            Some(state.match_agent_prompt_submit(&agent.id, prompt.as_deref())?);
                    }
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
            event if event.starts_with("Notification") => {
                let notification_kind = notification_kind(&notification);
                if matches!(notification_kind, NotificationKind::IdlePrompt) {
                    let drained = if let Some(agent) = agent.as_mut() {
                        finish_agent_after_idle(state, agent)?
                    } else {
                        false
                    };
                    if drained {
                        "agent.running"
                    } else {
                        "agent.done"
                    }
                } else {
                    if let Some(agent) = agent.as_mut() {
                        agent.status = notification_status(notification_kind);
                        state.set_agent_status(&agent.id, agent.status)?;
                    }
                    notification_event_type(notification_kind)
                }
            }
            "Stop" => {
                let drained = if let Some(agent) = agent.as_mut() {
                    finish_agent_after_idle(state, agent)?
                } else {
                    false
                };
                if drained {
                    "agent.running"
                } else {
                    "agent.done"
                }
            }
            "SubagentStop" => "agent.subagent_stopped",
            other => {
                return Ok(AdapterNotificationOutcome::Event(QmuxEvent::new(
                    format!("agent.hook.{other}"),
                    pane_id,
                    agent.map(|agent| agent.id),
                    json!({
                        "hookEvent": other,
                        "payload": notification.payload,
                    }),
                )));
            }
        };

        let mut event_payload = json!({
            "hookEvent": notification.event,
            "payload": notification.payload,
        });
        if let Some(send_tracking) = send_tracking {
            if let Value::Object(payload) = &mut event_payload {
                payload.insert(
                    "sendTracking".to_string(),
                    serde_json::to_value(send_tracking)
                        .map_err(|err| format!("failed to encode send tracking: {err}"))?,
                );
            }
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

/// Whether a manual `claude …` invocation carries an inline prompt — a positional
/// argument — as opposed to a bare or flags-only launch that drops into Claude's
/// interactive mode and waits for input. Flags that consume a separate value are
/// skipped so e.g. `claude --model sonnet` is not mistaken for carrying a prompt.
/// Erring toward "no prompt" is safe: the agent just starts idle and the first real
/// turn (UserPromptSubmit/PreToolUse) promotes it to running.
fn args_contain_prompt(args: &[String]) -> bool {
    // Claude CLI flags that take a separate value argument; the token after one of
    // these is the flag's value, not a prompt. Boolean flags (e.g. -c/--continue,
    // -p/--print) are intentionally absent so a prompt following them is detected.
    const VALUE_FLAGS: &[&str] = &[
        "--model",
        "--fallback-model",
        "--settings",
        "--setting-sources",
        "--add-dir",
        "--allowedTools",
        "--allowed-tools",
        "--disallowedTools",
        "--disallowed-tools",
        "--mcp-config",
        "--append-system-prompt",
        "--permission-mode",
        "--permission-prompt-tool",
        "--resume",
        "-r",
        "--session-id",
        "--input-format",
        "--output-format",
        "--max-turns",
        "--agents",
        "--plugin-dir",
        "--plugin-url",
    ];

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            // Everything after the `--` separator is positional.
            return iter.next().is_some();
        }
        if arg.starts_with('-') {
            // `--flag=value` is self-contained and never consumes the next token.
            if !arg.contains('=') && VALUE_FLAGS.contains(&arg.as_str()) {
                iter.next();
            }
            continue;
        }
        // A bare, non-flag token is an inline prompt.
        return true;
    }
    false
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeLaunchOptions {
    #[serde(default)]
    permission_mode: Option<String>,
}

impl ClaudeLaunchOptions {
    fn from_value(value: Value) -> Result<Self, String> {
        if value.is_null() {
            return Ok(Self {
                permission_mode: None,
            });
        }
        let mut options: ClaudeLaunchOptions = serde_json::from_value(value)
            .map_err(|err| format!("invalid Claude adapter options: {err}"))?;
        options.permission_mode = match options.permission_mode.map(|mode| mode.trim().to_string())
        {
            Some(permission_mode) if permission_mode.is_empty() => None,
            Some(permission_mode)
                if CLAUDE_PERMISSION_MODES.contains(&permission_mode.as_str()) =>
            {
                Some(permission_mode)
            }
            Some(permission_mode) => {
                return Err(format!(
                    "invalid Claude adapter option permissionMode='{permission_mode}'; expected one of {}",
                    CLAUDE_PERMISSION_MODES.join(", ")
                ));
            }
            None => None,
        };
        Ok(options)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnClaudeRequest {
    pub prompt: String,
    pub group_id: Option<String>,
    pub base_repo: Option<String>,
    pub base_ref: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub initial_size: Option<InitialPaneSize>,
    /// Opt in to an isolated git worktree; defaults to false (run in place).
    pub use_worktree: Option<bool>,
}

impl SpawnClaudeRequest {
    pub fn into_agent_request(self) -> SpawnAgentRequest {
        let options = match self.permission_mode {
            Some(permission_mode) => json!({ "permissionMode": permission_mode }),
            None => Value::Null,
        };

        SpawnAgentRequest {
            adapter_id: "claude".to_string(),
            prompt: self.prompt,
            group_id: self.group_id,
            base_repo: self.base_repo,
            base_ref: self.base_ref,
            cwd: self.cwd,
            model: self.model,
            initial_size: self.initial_size,
            use_worktree: self.use_worktree,
            options,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareShellClaudeLaunchRequest {
    pub pane_id: String,
    pub cwd: String,
    #[serde(default)]
    pub args: Vec<String>,
}

pub fn write_hook_settings(agent: &AgentInfo) -> Result<PathBuf, String> {
    let agent_dir = PathBuf::from(&agent.worktree_dir);
    let qmux_dir = agent_dir.join(".qmux");
    fs::create_dir_all(&qmux_dir)
        .map_err(|err| format!("failed to create {}: {err}", qmux_dir.display()))?;

    let qmux_cli = env::current_exe()
        .map_err(|err| format!("failed to resolve qmux executable for hooks: {err}"))?;
    let mut hooks = serde_json::Map::new();
    for event in CLAUDE_HOOK_EVENTS {
        hooks.insert(
            event.to_string(),
            json!([
                {
                    "matcher": "",
                    "hooks": [
                        {
                            "type": "command",
                            "command": format!("{} notify {}", shell_quote_path(&qmux_cli), event)
                        }
                    ]
                }
            ]),
        );
    }
    hooks.insert(
        "Notification".to_string(),
        json!(
            CLAUDE_NOTIFICATION_MATCHERS
                .iter()
                .map(|(matcher, event)| json!({
                    "matcher": matcher,
                    "hooks": [
                        {
                            "type": "command",
                            "command": format!("{} notify {}", shell_quote_path(&qmux_cli), event)
                        }
                    ]
                }))
                .collect::<Vec<_>>()
        ),
    );

    let settings = json!({ "hooks": hooks });
    let settings_path = qmux_dir.join("qmux-hooks.json");
    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("failed to encode hook settings: {err}"))?;
    fs::write(&settings_path, raw)
        .map_err(|err| format!("failed to write {}: {err}", settings_path.display()))?;
    Ok(settings_path)
}

/// A skill the qmux-managed plugin makes available to launched Claude agents.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSkill {
    /// Stable unique identifier — the skill's directory name. Used as the launcher
    /// key and selection id, so it must be unique even if two skills declare the
    /// same frontmatter `name:`.
    pub id: String,
    /// Human label for the launcher checkbox (e.g. `Deep Research`).
    pub name: String,
    /// Slash command that invokes the skill, namespaced by the plugin
    /// (e.g. `/qmux:deep-research`).
    pub command: String,
}

/// Enumerates the skills inside the qmux-managed Claude plugin (`<plugin>/skills/*`).
/// Returns an empty list when the plugin directory is absent so the launcher simply
/// shows no skill checkboxes rather than erroring.
pub fn list_skills(config: &QmuxConfig) -> Vec<ClaudeSkill> {
    let plugin_dir = &config.claude_plugin_dir;
    let skills_dir = plugin_dir.join("skills");
    let Ok(entries) = fs::read_dir(&skills_dir) else {
        return Vec::new();
    };
    let namespace = plugin_namespace(plugin_dir);

    let mut skills: Vec<ClaudeSkill> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                return None;
            }
            // Skills are inline-only by default — invoked mid-conversation as a slash
            // command (fork, open-in-browser, …), which makes no sense as a "New agent"
            // launch. Only skills that explicitly opt in with `qmux-launcher: true`
            // appear in the cmd-; launcher. Filtering here does not affect Claude's own
            // ability to run any skill inline; it loads the plugin dir independently.
            if !skill_shows_in_launcher(&skill_md) {
                return None;
            }
            // The slug that names the skill to Claude comes from frontmatter `name:`
            // (falling back to the directory name); the command is namespaced by the
            // plugin. The `id` is always the directory name so it stays unique even
            // when two skills share a frontmatter name.
            let dir_name = entry.file_name().to_string_lossy().into_owned();
            let slug = skill_frontmatter_name(&skill_md).unwrap_or_else(|| dir_name.clone());
            Some(ClaudeSkill {
                command: format!("/{namespace}:{slug}"),
                name: humanize_skill_slug(&slug),
                id: dir_name,
            })
        })
        .collect();
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    skills
}

/// The plugin's namespace, taken from `.claude-plugin/plugin.json`'s `name`, which
/// is how Claude prefixes the skill's slash command. When the manifest is missing or
/// nameless, fall back to the plugin directory name (Claude's own default) rather
/// than a hardcoded `qmux`, so the displayed command matches what Claude registers.
fn plugin_namespace(plugin_dir: &Path) -> String {
    let manifest = plugin_dir.join(".claude-plugin").join("plugin.json");
    fs::read_to_string(&manifest)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| string_field(&value, "name"))
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            plugin_dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "qmux".to_string())
}

/// Reads the `name:` value from a SKILL.md YAML frontmatter block. Cheap and safe:
/// it only scans the leading `---` fenced block and never parses the body. Matches
/// the top-level (column-0) `name:` key only — a nested `metadata:\n  name: ...` is
/// skipped — and strips inline `#` comments from unquoted values.
fn skill_frontmatter_name(skill_md: &Path) -> Option<String> {
    let raw = fs::read_to_string(skill_md).ok()?;
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        // Use the raw line (not trimmed) so indented keys nested under another
        // mapping are not mistaken for the top-level skill name.
        let Some(rest) = line.strip_prefix("name:") else {
            continue;
        };
        let value = rest.trim();
        let name = if value.starts_with('"') || value.starts_with('\'') {
            value.trim_matches(['"', '\'']).trim()
        } else {
            // An unescaped ` #` (or a leading `#`) starts a YAML comment.
            let value = value.split(" #").next().unwrap_or(value).trim();
            if value.starts_with('#') { "" } else { value }
        };
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

/// Whether a skill opts into the cmd-; launcher via a top-level `qmux-launcher: true`
/// frontmatter key. Skills are inline-only (invoked mid-conversation) by default, so a
/// skill is hidden from the "New agent" launcher unless it explicitly opts in. Scans
/// the same leading `---` block as `skill_frontmatter_name` and, like it, matches only
/// the column-0 key — an indented `metadata:\n  qmux-launcher: ...` does not count.
fn skill_shows_in_launcher(skill_md: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(skill_md) else {
        return false;
    };
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return false;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        // Use the raw line so an indented key nested under another mapping is ignored.
        let Some(rest) = line.strip_prefix("qmux-launcher:") else {
            continue;
        };
        // Strip an inline `#` comment and optional quotes, then require an explicit
        // `true` (case-insensitive) — anything else, including absent, reads as opt-out.
        let value = rest
            .split(" #")
            .next()
            .unwrap_or(rest)
            .trim()
            .trim_matches(['"', '\'']);
        return value.eq_ignore_ascii_case("true");
    }
    false
}

/// Turns a skill slug into a launcher label by splitting on `-`/`_` and sentence-casing
/// the result (only the first word is capitalized): `deep-research` -> `Deep research`.
fn humanize_skill_slug(slug: &str) -> String {
    let joined = slug
        .split(['-', '_'])
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = joined.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
        None => String::new(),
    }
}

/// Resolves an idle agent: drains the next queued turn, or enters/stays paused.
/// Returns whether a turn was drained (→ `agent.running`), else not (→ `agent.done`).
/// Status/paused are written by `advance_after_idle`; nothing is set on the passed
/// agent (its only later use is its id for the emitted event).
fn finish_agent_after_idle(state: &AppState, agent: &AgentInfo) -> Result<bool, String> {
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

fn notification_event_type(notification_kind: NotificationKind) -> &'static str {
    match notification_kind {
        NotificationKind::PermissionPrompt => "agent.awaiting_permission",
        NotificationKind::IdlePrompt => "agent.done",
        NotificationKind::ElicitationDialog => "agent.awaiting_input",
        NotificationKind::Other => "agent.notification",
    }
}

fn notification_status(notification_kind: NotificationKind) -> AgentStatus {
    match notification_kind {
        NotificationKind::PermissionPrompt => AgentStatus::AwaitingPermission,
        NotificationKind::IdlePrompt => AgentStatus::Done,
        NotificationKind::ElicitationDialog => AgentStatus::AwaitingInput,
        NotificationKind::Other => AgentStatus::AwaitingInput,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NotificationKind {
    PermissionPrompt,
    IdlePrompt,
    ElicitationDialog,
    Other,
}

fn notification_kind(notification: &AdapterNotification) -> NotificationKind {
    match notification.event.as_str() {
        "Notification.permission_prompt" => return NotificationKind::PermissionPrompt,
        "Notification.idle_prompt" => return NotificationKind::IdlePrompt,
        "Notification.elicitation_dialog" => return NotificationKind::ElicitationDialog,
        _ => {}
    }

    if payload_contains(&notification.payload, "permission_prompt") {
        NotificationKind::PermissionPrompt
    } else if payload_contains(&notification.payload, "idle_prompt") {
        NotificationKind::IdlePrompt
    } else if payload_contains(&notification.payload, "elicitation_dialog") {
        NotificationKind::ElicitationDialog
    } else {
        NotificationKind::Other
    }
}

fn payload_contains(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(value) => value.contains(needle),
        Value::Array(values) => values.iter().any(|value| payload_contains(value, needle)),
        Value::Object(values) => values.iter().any(|(key, value)| {
            key.contains(needle)
                || value.as_str().is_some_and(|value| value.contains(needle))
                || payload_contains(value, needle)
        }),
        _ => false,
    }
}

fn is_subagent_payload(value: &Value) -> bool {
    value.get("agent_id").is_some() || value.get("agentId").is_some()
}

fn parse_transcript_line(agent_id: &str, source_index: usize, line: &str) -> Option<Turn> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let message = value.get("message").unwrap_or(&value);
    let role = message
        .get("role")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("event")
        .to_string();
    let session_id =
        string_field(&value, "session_id").or_else(|| string_field(&value, "sessionId"));
    let content = message.get("content").or_else(|| value.get("content"))?;
    let blocks = parse_blocks(content);

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

fn parse_blocks(content: &Value) -> Vec<TurnBlock> {
    match content {
        Value::String(text) => vec![TurnBlock::Text { text: text.clone() }],
        Value::Array(items) => items.iter().filter_map(parse_block).collect(),
        other => vec![TurnBlock::Raw {
            value: other.clone(),
        }],
    }
}

fn parse_block(value: &Value) -> Option<TurnBlock> {
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

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig};
    use crate::state::{AgentSendSource, PaneInfo, PaneRuntime, PaneStatus};
    use portable_pty::{Child, ChildKiller, ExitStatus, PtySize, native_pty_system};
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};

    fn svec(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn args_contain_prompt_detects_inline_prompts() {
        // Bare or flags-only launches drop into interactive mode (no prompt).
        assert!(!args_contain_prompt(&[]));
        assert!(!args_contain_prompt(&svec(&["--model", "sonnet"])));
        assert!(!args_contain_prompt(&svec(&["--permission-mode", "plan"])));
        assert!(!args_contain_prompt(&svec(&["--continue"])));
        assert!(!args_contain_prompt(&svec(&["--resume", "abc123"])));
        assert!(!args_contain_prompt(&svec(&["-r"])));
        assert!(!args_contain_prompt(&svec(&["--model=sonnet"])));
        // Plugin flags take a value, so their argument is not a prompt.
        assert!(!args_contain_prompt(&svec(&["--plugin-dir", "/tmp/p"])));
        assert!(!args_contain_prompt(&svec(&[
            "--plugin-url",
            "https://x/p.zip"
        ])));

        // A positional token is an inline prompt, even after value-taking flags.
        assert!(args_contain_prompt(&svec(&["fix the bug"])));
        assert!(args_contain_prompt(&svec(&[
            "--plugin-dir",
            "/tmp/p",
            "fix the bug"
        ])));
        assert!(args_contain_prompt(&svec(&[
            "--model",
            "sonnet",
            "fix the bug"
        ])));
        assert!(args_contain_prompt(&svec(&["--continue", "keep going"])));
        assert!(args_contain_prompt(&svec(&["--", "after separator"])));
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

    fn test_state() -> AppState {
        AppState::new(QmuxConfig {
            workspace_root: PathBuf::from("/tmp/qmux-hooks-test"),
            socket_path: PathBuf::from("/tmp/qmux-hooks-test.sock"),
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
        })
    }

    fn sample_agent() -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/qmux-hooks-test".to_string(),
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
                    title: "Claude".to_string(),
                    kind: PaneKind::Agent,
                    agent_id: Some("agent-1".to_string()),
                    cwd: "/tmp/qmux-hooks-test".to_string(),
                    cols: 80,
                    rows: 24,
                    status: PaneStatus::Running,
                    recovered: false,
                    depth: 0,
                },
                child: Arc::new(Mutex::new(Box::new(FakeChild))),
                master: Arc::new(Mutex::new(pair.master)),
                writer: Arc::new(Mutex::new(Box::new(RecordingWriter {
                    bytes: bytes.clone(),
                }))),
                backlog: Default::default(),
            })
            .unwrap();
        bytes
    }

    fn hook(event: &str, payload: serde_json::Value) -> AdapterNotification {
        AdapterNotification {
            adapter_id: None,
            event: event.to_string(),
            pane_id: Some("pane-1".to_string()),
            agent_id: None,
            payload,
        }
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
        match ClaudeAdapter::new(&state.config()).ingest_notification(state, notification) {
            Ok(AdapterNotificationOutcome::Event(event)) => event,
            Ok(AdapterNotificationOutcome::Events(mut events)) => events.remove(0),
            Err(err) => panic!("{err}"),
        }
    }

    fn written_text(bytes: &Arc<Mutex<Vec<u8>>>) -> String {
        String::from_utf8(bytes.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn stop_drains_one_queued_turn() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        state
            .enqueue_agent_turn("agent-1", "first".to_string())
            .unwrap();
        state
            .enqueue_agent_turn("agent-1", "second".to_string())
            .unwrap();

        let event = ingest(&state, hook("Stop", json!({})));

        assert_eq!(event.event_type, "agent.running");
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["second".to_string()]
        );
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Running));
        let written = written_text(&bytes);
        assert!(written.contains("first"));
        assert!(!written.contains("second"));
    }

    #[test]
    fn session_start_without_session_id_keeps_a_recorded_one() {
        let state = test_state();
        install_agent_pane(&state);

        // The first SessionStart records the session id.
        ingest(&state, hook("SessionStart", json!({ "session_id": "sess-abc" })));
        assert_eq!(
            state.agent("agent-1").unwrap().unwrap().session_id.as_deref(),
            Some("sess-abc")
        );

        // A late/duplicate SessionStart that omits session_id must not blank it
        // (fork + recovery key off the recorded id).
        ingest(&state, hook("SessionStart", json!({})));
        assert_eq!(
            state.agent("agent-1").unwrap().unwrap().session_id.as_deref(),
            Some("sess-abc")
        );
    }

    #[test]
    fn stop_marks_agent_done_without_queued_turns() {
        let state = test_state();
        install_agent_pane(&state);

        let event = ingest(&state, hook("Stop", json!({})));

        assert_eq!(event.event_type, "agent.done");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Done));
    }

    #[test]
    fn pause_after_turn_pauses_the_queue_then_unpause_resumes() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        state
            .enqueue_agent_turn("agent-1", "first".to_string())
            .unwrap();
        state
            .enqueue_agent_turn("agent-1", "second".to_string())
            .unwrap();
        // Pause after the first queued turn.
        state
            .set_queued_turn_pause("agent-1", 0, true, Some("first"))
            .unwrap();

        // First idle drains the pause-after turn and the agent runs it.
        let event = ingest(&state, hook("Stop", json!({})));
        assert_eq!(event.event_type, "agent.running");
        assert!(written_text(&bytes).contains("first"));

        // When that turn finishes, the queue pauses instead of sending "second".
        let event = ingest(&state, hook("Stop", json!({})));
        assert_eq!(event.event_type, "agent.done");
        // The emitted payload must reflect the paused state (not the stale pre-idle
        // snapshot), so the UI surfaces it without a separate refetch.
        assert_eq!(event.payload["agent"]["paused"], json!(true));
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(agent.paused);
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["second".to_string()]
        );
        assert!(!written_text(&bytes).contains("second"));

        // Unpausing (agent idle) clears the pause and sends the next turn now.
        let result = crate::turn_queue::unpause_agent(&state, "agent-1").unwrap();
        assert!(result.sent);
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(!agent.paused);
        assert!(state.list_agent_turn_queue("agent-1").unwrap().is_empty());
        assert!(written_text(&bytes).contains("second"));
    }

    #[test]
    fn typing_holds_the_queue_until_typing_stops() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        state
            .enqueue_agent_turn("agent-1", "queued".to_string())
            .unwrap();

        // While the user is typing, a finishing turn must not drain the queue.
        crate::turn_queue::set_agent_typing(&state, "agent-1", true).unwrap();
        let event = ingest(&state, hook("Stop", json!({})));
        assert_eq!(event.event_type, "agent.done");
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["queued".to_string()]
        );
        assert!(!written_text(&bytes).contains("queued"));

        // Once typing stops, releasing the hold drains the held turn (agent is idle).
        let result = crate::turn_queue::set_agent_typing(&state, "agent-1", false).unwrap();
        assert!(result.sent);
        assert!(state.list_agent_turn_queue("agent-1").unwrap().is_empty());
        assert!(written_text(&bytes).contains("queued"));
    }

    #[test]
    fn idle_prompt_drains_one_queued_turn() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        state
            .enqueue_agent_turn("agent-1", "queued".to_string())
            .unwrap();

        let event = ingest(
            &state,
            hook(
                "Notification.idle_prompt",
                json!({ "hook_event_name": "Notification" }),
            ),
        );

        assert_eq!(event.event_type, "agent.running");
        assert!(state.list_agent_turn_queue("agent-1").unwrap().is_empty());
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Running));
        assert!(written_text(&bytes).contains("queued"));
    }

    #[test]
    fn idle_prompt_marks_agent_done_without_queued_turns() {
        let state = test_state();
        install_agent_pane(&state);

        let event = ingest(
            &state,
            hook(
                "Notification.idle_prompt",
                json!({ "hook_event_name": "Notification" }),
            ),
        );

        assert_eq!(event.event_type, "agent.done");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Done));
    }

    #[test]
    fn explicit_agent_id_routes_hooks_for_shared_shell_pane() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        let mut second_agent = sample_agent();
        second_agent.id = "agent-2".to_string();
        second_agent.created_at = 2;
        state.insert_agent(second_agent).unwrap();
        state
            .enqueue_agent_turn("agent-1", "wrong queue".to_string())
            .unwrap();
        state
            .enqueue_agent_turn("agent-2", "right queue".to_string())
            .unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "Notification.idle_prompt",
                "agent-2",
                json!({ "hook_event_name": "Notification" }),
            ),
        );

        assert_eq!(event.agent_id.as_deref(), Some("agent-2"));
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["wrong queue".to_string()]
        );
        assert!(state.list_agent_turn_queue("agent-2").unwrap().is_empty());
        let written = written_text(&bytes);
        assert!(written.contains("right queue"));
        assert!(!written.contains("wrong queue"));
    }

    #[test]
    fn user_prompt_submit_matches_outstanding_send() {
        let state = test_state();
        install_agent_pane(&state);
        state
            .record_agent_send(
                "agent-1",
                "hello\n\nworld".to_string(),
                AgentSendSource::DirectSend,
            )
            .unwrap();

        let event = ingest(
            &state,
            hook("UserPromptSubmit", json!({ "prompt": "hello world" })),
        );

        assert!(state.outstanding_agent_sends("agent-1").unwrap().is_empty());
        assert_eq!(
            event.payload["sendTracking"],
            json!({
                "status": "matched",
                "source": "directSend",
                "outstandingSends": 0
            })
        );
    }

    #[test]
    fn user_prompt_submit_mismatch_does_not_block_stop_drain() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        state
            .record_agent_send(
                "agent-1",
                "expected".to_string(),
                AgentSendSource::DirectSend,
            )
            .unwrap();

        let event = ingest(
            &state,
            hook("UserPromptSubmit", json!({ "prompt": "foreign" })),
        );
        assert_eq!(event.payload["sendTracking"]["status"], "mismatched");

        state
            .enqueue_agent_turn("agent-1", "queued after mismatch".to_string())
            .unwrap();
        ingest(&state, hook("Stop", json!({})));

        assert!(written_text(&bytes).contains("queued after mismatch"));
        let outstanding = state.outstanding_agent_sends("agent-1").unwrap();
        assert_eq!(outstanding.len(), 1);
        assert_eq!(outstanding[0].text, "queued after mismatch");
        assert_eq!(outstanding[0].source, AgentSendSource::QueuedTurn);
    }

    #[test]
    fn subagent_prompt_submit_does_not_touch_parent_tracking() {
        let state = test_state();
        install_agent_pane(&state);
        state
            .record_agent_send("agent-1", "expected".to_string(), AgentSendSource::Steer)
            .unwrap();

        let event = ingest(
            &state,
            hook(
                "UserPromptSubmit",
                json!({ "agent_id": "subagent-1", "prompt": "expected" }),
            ),
        );

        assert!(event.payload.get("sendTracking").is_none());
        assert_eq!(state.outstanding_agent_sends("agent-1").unwrap().len(), 1);
    }

    #[test]
    fn parse_tool_blocks_preserves_correlation_ids() {
        let tool_use = json!({
            "type": "tool_use",
            "id": "toolu_1",
            "name": "Bash",
            "input": { "cmd": "pwd" }
        });

        match parse_block(&tool_use).expect("tool_use should parse") {
            TurnBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_deref(), Some("toolu_1"));
                assert_eq!(name, "Bash");
                assert_eq!(input["cmd"], "pwd");
            }
            other => panic!("expected tool use, got {other:?}"),
        }

        let tool_result = json!({
            "type": "tool_result",
            "tool_use_id": "toolu_1",
            "content": "ok",
            "is_error": true
        });

        match parse_block(&tool_result).expect("tool_result should parse") {
            TurnBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("toolu_1"));
                assert_eq!(content, "ok");
                assert!(is_error);
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_result_accepts_camel_case_id() {
        let tool_result = json!({
            "type": "tool_result",
            "toolUseId": "toolu_2",
            "content": "ok"
        });

        match parse_block(&tool_result).expect("tool_result should parse") {
            TurnBlock::ToolResult { tool_use_id, .. } => {
                assert_eq!(tool_use_id.as_deref(), Some("toolu_2"));
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    #[test]
    fn launch_options_reject_unknown_fields() {
        let err = ClaudeLaunchOptions::from_value(json!({ "bogus": true })).unwrap_err();

        assert!(err.contains("invalid Claude adapter options"));
    }

    #[test]
    fn launch_options_validate_permission_mode() {
        let err =
            ClaudeLaunchOptions::from_value(json!({ "permissionMode": "always" })).unwrap_err();

        assert!(err.contains("invalid Claude adapter option permissionMode"));
    }

    #[test]
    fn humanize_skill_slug_sentence_cases_the_label() {
        assert_eq!(humanize_skill_slug("deep-research"), "Deep research");
        assert_eq!(humanize_skill_slug("hello_stub"), "Hello stub");
        assert_eq!(humanize_skill_slug("single"), "Single");
        assert_eq!(humanize_skill_slug("a--b"), "A b");
    }

    #[test]
    fn skill_frontmatter_name_reads_declared_name_or_none() {
        let dir = env::temp_dir().join(format!("qmux-skill-fm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("SKILL.md");

        fs::write(
            &path,
            "---\nname: deep-research\ndescription: x\n---\n# Body\n",
        )
        .unwrap();
        assert_eq!(
            skill_frontmatter_name(&path).as_deref(),
            Some("deep-research")
        );

        // Quoted values are unwrapped.
        fs::write(&path, "---\nname: \"Quoted Name\"\n---\n").unwrap();
        assert_eq!(
            skill_frontmatter_name(&path).as_deref(),
            Some("Quoted Name")
        );

        // No frontmatter fence -> no name.
        fs::write(&path, "# No frontmatter\nname: ignored\n").unwrap();
        assert_eq!(skill_frontmatter_name(&path), None);

        // A nested `name:` under another mapping is not the skill name; the
        // top-level key wins.
        fs::write(
            &path,
            "---\nmetadata:\n  name: nested\nname: top-level\n---\n",
        )
        .unwrap();
        assert_eq!(skill_frontmatter_name(&path).as_deref(), Some("top-level"));

        // Inline `#` comments on an unquoted value are stripped.
        fs::write(&path, "---\nname: deep-research # rename later\n---\n").unwrap();
        assert_eq!(
            skill_frontmatter_name(&path).as_deref(),
            Some("deep-research")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skill_shows_in_launcher_requires_explicit_opt_in() {
        let dir = env::temp_dir().join(format!("qmux-skill-launch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("SKILL.md");

        // Opted in.
        fs::write(&path, "---\nname: x\nqmux-launcher: true\n---\n").unwrap();
        assert!(skill_shows_in_launcher(&path));

        // Case-insensitive, with an inline comment stripped.
        fs::write(&path, "---\nqmux-launcher: TRUE # opt in\n---\n").unwrap();
        assert!(skill_shows_in_launcher(&path));

        // Absent key -> inline-only by default.
        fs::write(&path, "---\nname: x\ndescription: d\n---\n").unwrap();
        assert!(!skill_shows_in_launcher(&path));

        // Explicit false stays hidden.
        fs::write(&path, "---\nqmux-launcher: false\n---\n").unwrap();
        assert!(!skill_shows_in_launcher(&path));

        // A nested key under another mapping does not opt the skill in.
        fs::write(&path, "---\nmetadata:\n  qmux-launcher: true\n---\n").unwrap();
        assert!(!skill_shows_in_launcher(&path));

        // No frontmatter fence -> hidden.
        fs::write(&path, "# No frontmatter\nqmux-launcher: true\n").unwrap();
        assert!(!skill_shows_in_launcher(&path));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn plugin_namespace_falls_back_to_dir_name_without_manifest() {
        let plugin_dir = env::temp_dir().join(format!("qmux-ns-{}", std::process::id()));
        let _ = fs::remove_dir_all(&plugin_dir);
        fs::create_dir_all(&plugin_dir).unwrap();

        // No manifest -> directory name (what Claude itself would use), not "qmux".
        assert_eq!(
            plugin_namespace(&plugin_dir),
            plugin_dir.file_name().unwrap().to_string_lossy()
        );

        // A manifest name takes precedence.
        let manifest_dir = plugin_dir.join(".claude-plugin");
        fs::create_dir_all(&manifest_dir).unwrap();
        fs::write(manifest_dir.join("plugin.json"), r#"{"name":"qmux"}"#).unwrap();
        assert_eq!(plugin_namespace(&plugin_dir), "qmux");

        let _ = fs::remove_dir_all(&plugin_dir);
    }

    #[test]
    fn list_skills_enumerates_named_namespaced_skills() {
        use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig};

        let plugin_dir = env::temp_dir().join(format!("qmux-plugin-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&plugin_dir);
        let manifest_dir = plugin_dir.join(".claude-plugin");
        fs::create_dir_all(&manifest_dir).unwrap();
        fs::write(manifest_dir.join("plugin.json"), r#"{"name":"qmux"}"#).unwrap();

        let skill_dir = plugin_dir.join("skills").join("deep-research");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: deep-research\ndescription: d\nqmux-launcher: true\n---\n",
        )
        .unwrap();
        // A subdirectory without SKILL.md is not a skill.
        fs::create_dir_all(plugin_dir.join("skills").join("scratch")).unwrap();
        // An inline-only skill (no `qmux-launcher: true`) is excluded from the launcher.
        let inline_dir = plugin_dir.join("skills").join("fork");
        fs::create_dir_all(&inline_dir).unwrap();
        fs::write(
            inline_dir.join("SKILL.md"),
            "---\nname: fork\ndescription: d\n---\n",
        )
        .unwrap();

        let config = QmuxConfig {
            workspace_root: env::temp_dir(),
            socket_path: env::temp_dir().join("qmux-list.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: plugin_dir.clone(),
        };

        let skills = list_skills(&config);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "deep-research");
        assert_eq!(skills[0].name, "Deep research");
        assert_eq!(skills[0].command, "/qmux:deep-research");

        let _ = fs::remove_dir_all(&plugin_dir);
    }

    #[test]
    fn list_skills_is_empty_without_a_plugin_dir() {
        use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig};

        let config = QmuxConfig {
            workspace_root: env::temp_dir(),
            socket_path: env::temp_dir().join("qmux-empty.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: env::temp_dir().join("qmux-nonexistent-plugin-dir"),
        };

        assert!(list_skills(&config).is_empty());
    }

    #[test]
    fn list_skills_keeps_ids_unique_when_frontmatter_names_collide() {
        use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig};

        let plugin_dir = env::temp_dir().join(format!("qmux-plugin-dup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&plugin_dir);
        let manifest_dir = plugin_dir.join(".claude-plugin");
        fs::create_dir_all(&manifest_dir).unwrap();
        fs::write(manifest_dir.join("plugin.json"), r#"{"name":"qmux"}"#).unwrap();

        // Two distinct skill directories that declare the same frontmatter name.
        for dir in ["alpha", "beta"] {
            let skill_dir = plugin_dir.join("skills").join(dir);
            fs::create_dir_all(&skill_dir).unwrap();
            fs::write(
                skill_dir.join("SKILL.md"),
                "---\nname: shared\ndescription: d\nqmux-launcher: true\n---\n",
            )
            .unwrap();
        }

        let config = QmuxConfig {
            workspace_root: env::temp_dir(),
            socket_path: env::temp_dir().join("qmux-dup.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: plugin_dir.clone(),
        };

        let skills = list_skills(&config);
        // Ids are the (unique) directory names, even though both share a command.
        // Sort for an order-independent assertion (read_dir order is OS-dependent).
        let mut ids: Vec<&str> = skills.iter().map(|skill| skill.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["alpha", "beta"]);
        assert!(skills.iter().all(|skill| skill.command == "/qmux:shared"));

        let _ = fs::remove_dir_all(&plugin_dir);
    }
}
