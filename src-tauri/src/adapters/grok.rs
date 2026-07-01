use super::{
    AdapterNotification, AdapterNotificationOutcome, AgentAdapter, ComposerPolicy, LaunchEnv,
    PrepareShellAgentLaunchRequest, PreparedShellAgentLaunch, ShellCommandIntegration,
    SpawnAgentRequest, TranscriptLifecycleEvent, ensure_on_path, reusable_session_agent,
    shell_quote_arg, shell_quote_path,
};
use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::pty::{InitialPaneSize, PtySpawnSpec, qmux_pane_envs, recoverable_dir, spawn_pty};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::transcript::{Turn, TurnBlock, start_transcript_tail};
use crate::turn_queue::{IdleResolution, advance_after_idle, is_shell_escape_turn};
use crate::workspace::{
    AgentInfo, AgentStatus, PrepareAgentWorkspaceRequest, attach_agent_pane, mark_agent_failed,
    prepare_agent_workspace,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// The xAI Grok Build lifecycle hook events qMux installs. Grok's hook system is
/// Claude-compatible (a `hooks` block in `~/.grok/user-settings.json` whose entries
/// run a command per event, receiving the event JSON on stdin), so qMux drives the
/// agent timeline from the same events it uses for Claude.
const GROK_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
];

/// Adapter for the xAI Grok Build CLI. Grok ships a Claude-compatible hook system
/// (shell commands run at lifecycle events, event JSON on stdin), so qMux integrates
/// it like its Claude and Codex adapters rather than like OpenCode: a qMux-managed
/// hook command is installed into `~/.grok/user-settings.json` and forwards each
/// lifecycle event back to qMux via `qmux notify <event>`. The hook command no-ops
/// outside qMux (it checks for the `QMUX_*` env vars only qMux-launched panes set),
/// so standalone `grok` runs are unaffected. Agent status (running, idle, awaiting
/// permission) is driven by these hooks; the transcript timeline binds to the
/// transcript path the `SessionStart` hook reports when Grok provides one.
#[derive(Clone, Debug)]
pub struct GrokAdapter {
    binary: String,
}

impl GrokAdapter {
    pub fn new(config: &QmuxConfig) -> Self {
        Self {
            binary: config.grok_binary(),
        }
    }

    fn ensure_binary(&self) -> Result<String, String> {
        let binary = ensure_on_path(&self.binary).ok_or_else(|| {
            format!(
                "Grok adapter binary '{}' was not found on PATH or standard macOS tool paths. Install the Grok CLI or update adapters.grok.binary in qmux.config.json.",
                self.binary
            )
        })?;
        Ok(binary.display().to_string())
    }

    /// The qMux-managed JSONL transcript fallback path for an agent, used when Grok's
    /// `SessionStart` hook does not report a transcript path of its own. It is shaped
    /// for `parse_transcript_line` and tailed with the same pipeline used for Claude,
    /// Codex, and OpenCode.
    fn transcript_path_for(state: &AppState, agent_id: &str) -> PathBuf {
        state
            .config()
            .workspace_root
            .join(".qmux")
            .join("grok")
            .join(format!("{agent_id}.jsonl"))
    }
}

impl AgentAdapter for GrokAdapter {
    fn id(&self) -> &'static str {
        "grok"
    }

    fn display_name(&self) -> &'static str {
        "Grok"
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
            command_name: "grok",
            adapter_id: self.id(),
        }]
    }

    fn shell_resume_command(&self, session_id: &str) -> Option<String> {
        Some(format!("grok --resume {}", shell_quote_arg(session_id)))
    }

    fn ingest_notification(
        &self,
        state: &AppState,
        notification: AdapterNotification,
    ) -> Result<AdapterNotificationOutcome, String> {
        self.ingest_grok_notification(state, notification)
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

impl GrokAdapter {
    fn spawn_pane(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        let binary = self.ensure_binary()?;
        let _options = GrokLaunchOptions::from_value(request.options)?;
        ensure_grok_integration()?;

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
                "Grok working directory {} does not exist",
                cwd.display()
            ));
        }

        let has_initial_prompt = prompt_has_initial_text(&request.prompt);
        let args = build_grok_args(&cwd, request.model.as_deref(), &request.prompt);

        let pane_id = state.next_id("pane");
        let mut envs = qmux_pane_envs(state, &pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        envs.push(("QMUX_CLI".to_string(), qmux_cli_path()?));

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
                attach_grok_agent_pane(state, &agent.id, pane.id.clone(), has_initial_prompt)?;
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
        ensure_grok_integration()?;
        let cwd = recoverable_dir(&agent.worktree_dir).ok_or_else(|| {
            format!(
                "agent worktree {} no longer exists; relaunch manually",
                agent.worktree_dir
            )
        })?;

        // Resume the recorded session when there is one (`grok --resume <id>`;
        // sessions live under ~/.grok/sessions), so a recovered pane continues the
        // prior conversation instead of starting over.
        let (args, resumed) =
            build_grok_resume_args(&cwd, agent.model.as_deref(), agent.session_id.as_deref());

        let mut envs = qmux_pane_envs(state, &pane.id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        envs.push(("QMUX_CLI".to_string(), qmux_cli_path()?));

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
                // A resumed session replays its own scrollback, so skip qMux's restore
                // to avoid double output; a fresh relaunch keeps it.
                skip_scrollback_restore: resumed,
            },
        )?;

        // A recovered Grok process launches without an inline prompt, so it is ready
        // once the TUI appears. The first real prompt/tool hook promotes it to Running.
        let mut restored = agent.clone();
        restored.pane_id = Some(pane.id.clone());
        restored.status = AgentStatus::Idle;
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
        ensure_grok_integration()?;

        if state.pane_writer(&request.pane_id)?.is_none() {
            return Err(format!("pane {} was not found", request.pane_id));
        }

        let cwd = PathBuf::from(&request.cwd);
        if !cwd.is_dir() {
            return Err(format!(
                "Grok working directory {} does not exist",
                cwd.display()
            ));
        }

        // A restart-driven resume (`grok --resume <id>`) rebinds the original agent
        // for that session instead of minting a duplicate; any other invocation starts
        // a fresh agent in the current directory.
        let cwd_str = cwd.display().to_string();
        let pane_group_id = state
            .pane_group_id(&request.pane_id)?
            .ok_or_else(|| format!("pane {} was not found", request.pane_id))?;
        let agent = match reusable_session_agent(
            state,
            self.id(),
            grok_resume_session_id(&request.args),
            &cwd_str,
        )? {
            Some(existing) => existing,
            None => prepare_agent_workspace(
                state,
                PrepareAgentWorkspaceRequest {
                    group_id: Some(pane_group_id),
                    base_repo: Some(cwd_str),
                    base_ref: Some("HEAD".to_string()),
                    adapter: self.id().to_string(),
                    model: None,
                    // Typing `grok` in a shell runs in the current directory; no worktree.
                    use_worktree: false,
                },
            )?,
        };
        let agent = attach_grok_agent_pane(
            state,
            &agent.id,
            request.pane_id.clone(),
            args_contain_prompt(&request.args),
        )?;

        let args = build_grok_args_from_shell(&cwd, &request.args);
        let mut envs = qmux_pane_envs(state, &request.pane_id)?;
        envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
        envs.push(("QMUX_CLI".to_string(), qmux_cli_path()?));
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

    fn ingest_grok_notification(
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
                        .or_else(|| string_field(&notification.payload, "sessionId"));
                    // Grok's SessionStart hook reports the rollout transcript path when
                    // it has one (Claude-compatible). Prefer it so the timeline tails
                    // Grok's own transcript.
                    let hook_transcript_path =
                        string_field(&notification.payload, "transcript_path")
                            .or_else(|| string_field(&notification.payload, "transcriptPath"));
                    let fallback_transcript_path = Self::transcript_path_for(state, &current.id)
                        .display()
                        .to_string();
                    // Field-scoped mutation, not a full-struct `update_agent`: this
                    // freshly spawned process's pane is being bound by attach_agent_pane
                    // on another thread, and a stale-snapshot write here would race it —
                    // wiping either the pane_id it set or the session_id we set.
                    let updated = state.mutate_agent(&current.id, |agent| {
                        if let Some(session_id) = session_id {
                            agent.session_id = Some(session_id);
                        }
                        // Only overwrite a recorded path when this event actually carries
                        // one. A late/duplicate SessionStart that omits the field must not
                        // rebind the tail out from under a running transcript, which would
                        // silently freeze the timeline. When nothing is recorded yet, bind
                        // the qMux-managed fallback so a tail still starts and picks up
                        // content once it appears.
                        if let Some(transcript_path) = hook_transcript_path {
                            agent.transcript_path = Some(transcript_path);
                        } else if agent.transcript_path.is_none() {
                            agent.transcript_path = Some(fallback_transcript_path);
                        }
                        // A session starting doesn't mean a turn is running. Keep status
                        // unchanged here; the first real prompt/tool hook promotes the
                        // agent to Running.
                    })?;

                    // Start tailing the bound transcript. The file may not exist yet, so
                    // the tail waits for it to appear rather than erroring.
                    if let Some(transcript_path) = updated.and_then(|agent| agent.transcript_path)
                    {
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
        // surgically instead of refetching the entire agent list on every hook event.
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
struct GrokLaunchOptions {}

impl GrokLaunchOptions {
    fn from_value(value: Value) -> Result<Self, String> {
        if value.is_null() {
            return Ok(Self::default());
        }
        serde_json::from_value(value).map_err(|err| format!("invalid Grok adapter options: {err}"))
    }
}

/// Builds the argument list for a qMux-launched Grok process. Uses the xAI Grok
/// Build CLI contract: `--cwd <dir>` for the working directory, `--model <model>`,
/// and the initial prompt as a trailing positional argument (which starts the
/// interactive TUI and submits the prompt immediately — unlike `-p/--prompt`, which
/// runs headless and exits, so it can't back an interactive pane).
fn build_grok_args(cwd: &Path, model: Option<&str>, prompt: &str) -> Vec<String> {
    let mut args = Vec::new();

    // The working directory is passed explicitly so Grok runs in the agent's cwd
    // even when the process cwd differs (e.g. worktree paths).
    args.push("--cwd".to_string());
    args.push(cwd.display().to_string());

    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    // The interactive initial prompt is a trailing positional, so it must come after
    // all flags.
    let prompt = prompt.trim();
    if !prompt.is_empty() {
        args.push(prompt.to_string());
    }

    args
}

/// Builds args for recovering a Grok agent. With a recorded session id, resumes it
/// via `grok --cwd <dir> [--model <m>] --resume <id>` and returns `true`; without
/// one, falls back to a fresh interactive launch and returns `false`.
fn build_grok_resume_args(
    cwd: &Path,
    model: Option<&str>,
    session_id: Option<&str>,
) -> (Vec<String>, bool) {
    let Some(session_id) = session_id
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
    else {
        return (build_grok_args(cwd, model, ""), false);
    };

    let mut args = build_grok_args(cwd, model, "");
    args.push("--resume".to_string());
    args.push(session_id.to_string());
    (args, true)
}

/// Builds args for a `grok ...` invocation typed in a shell pane. The user's own
/// args are forwarded verbatim; a `--cwd` is supplied only when the user did not
/// pass one so the agent still runs in the pane's cwd.
fn build_grok_args_from_shell(cwd: &Path, tail_args: &[String]) -> Vec<String> {
    let mut args = Vec::new();
    if !args_contain_directory(tail_args) {
        args.push("--cwd".to_string());
        args.push(cwd.display().to_string());
    }
    args.extend(tail_args.iter().cloned());
    args
}

/// Installs the qMux Grok hook integration: an env-gated shim and a `hooks` block
/// in `~/.grok/user-settings.json` whose entries run the shim for each lifecycle
/// event. Idempotent — re-running replaces qMux's own hook entries and preserves
/// everything else in the file. Called before every Grok launch/resume.
fn ensure_grok_integration() -> Result<(), String> {
    let grok_home = grok_home()?;
    write_grok_integration_files(&grok_home)
}

/// The Grok config home. Honors a `GROK_HOME` override (used by tests and unusual
/// installs); otherwise `~/.grok`, where Grok keeps its user settings and sessions.
fn grok_home() -> Result<PathBuf, String> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok")))
        .ok_or_else(|| "GROK_HOME and HOME are not set; cannot configure Grok hooks".to_string())
}

fn qmux_cli_path() -> Result<String, String> {
    env::current_exe()
        .map(|path| path.display().to_string())
        .map_err(|err| format!("failed to resolve qmux executable for Grok hooks: {err}"))
}

fn write_grok_integration_files(grok_home: &Path) -> Result<(), String> {
    let qmux_dir = grok_home.join("qmux");
    fs::create_dir_all(&qmux_dir)
        .map_err(|err| format!("failed to create {}: {err}", qmux_dir.display()))?;

    let shim_path = qmux_dir.join("qmux-grok-hook");
    fs::write(&shim_path, grok_hook_shim())
        .map_err(|err| format!("failed to write {}: {err}", shim_path.display()))?;
    fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o755))
        .map_err(|err| format!("failed to chmod {}: {err}", shim_path.display()))?;

    let settings_path = grok_home.join("user-settings.json");
    // Read-modify-write so qMux only manages its own hook entries and never
    // clobbers the user's model, trust, or other hooks. A present-but-unparseable
    // file is an error rather than something to overwrite blindly.
    let existing = match fs::read_to_string(&settings_path) {
        Ok(raw) if !raw.trim().is_empty() => serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("failed to parse {}: {err}", settings_path.display()))?,
        _ => json!({}),
    };
    let merged = merge_grok_hooks(existing, &shim_path);
    let raw = serde_json::to_string_pretty(&merged)
        .map_err(|err| format!("failed to encode Grok settings: {err}"))?;
    fs::write(&settings_path, raw)
        .map_err(|err| format!("failed to write {}: {err}", settings_path.display()))?;
    Ok(())
}

/// POSIX shim that forwards a Grok lifecycle event to `qmux notify <event>`. No-ops
/// (exit 0) unless launched inside a qMux pane, so a standalone `grok` run that
/// inherits the globally-installed hook is unaffected. The event JSON Grok writes to
/// the shim's stdin is passed through to qmux, which reads it as the hook payload.
fn grok_hook_shim() -> &'static str {
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

/// Merges qMux's hook entries into a Grok `user-settings.json` value. Existing keys
/// and any non-qMux hook entries are preserved; qMux's own entries (identified by a
/// command that runs the shim) are replaced so repeated launches don't accumulate
/// duplicates. The settings shape is Claude-compatible:
/// `{"hooks": {"<Event>": [{"matcher": "", "hooks": [{"type": "command", "command": "<shim> <Event>"}]}]}}`.
fn merge_grok_hooks(mut settings: Value, shim_path: &Path) -> Value {
    if !settings.is_object() {
        settings = json!({});
    }
    let command_prefix = shell_quote_path(shim_path);
    let obj = settings.as_object_mut().expect("settings is an object");
    let hooks_entry = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks_entry.is_object() {
        *hooks_entry = json!({});
    }
    let hooks = hooks_entry.as_object_mut().expect("hooks is an object");
    for event in GROK_HOOK_EVENTS {
        let entry = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let list = entry.as_array_mut().expect("event hooks is an array");
        list.retain(|item| !is_qmux_grok_hook_entry(item, shim_path));
        list.push(json!({
            "matcher": "",
            "hooks": [
                {
                    "type": "command",
                    "command": format!("{command_prefix} {event}"),
                }
            ]
        }));
    }
    settings
}

/// Whether a hook matcher entry is one qMux installed, i.e. one of its `command`s
/// runs the qMux Grok shim. Used to replace qMux's own entries on re-install without
/// touching hooks the user added themselves.
fn is_qmux_grok_hook_entry(entry: &Value, shim_path: &Path) -> bool {
    let needle = shim_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("qmux-grok-hook");
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(needle))
            })
        })
}

fn prompt_has_initial_text(prompt: &str) -> bool {
    !prompt.trim().is_empty()
}

fn attach_grok_agent_pane(
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

/// Whether a manual `grok ...` invocation carries a prompt — either a headless
/// prompt flag (`-p`/`--prompt`/`--single <text>`) or a trailing positional (the
/// interactive initial message). Value-taking flags and their values are skipped so
/// `grok --model grok-4` or `grok --resume <id>` is treated as interactive (no
/// prompt). Erring toward "no prompt" is safe: the agent starts idle and the first
/// real turn promotes it.
fn args_contain_prompt(args: &[String]) -> bool {
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        // Headless prompt flags carry the prompt as their value.
        if arg == "-p" || arg == "--prompt" || arg == "--single" {
            return true;
        }
        if arg.starts_with("--prompt=") || arg.starts_with("--single=") {
            return arg
                .split_once('=')
                .is_some_and(|(_, value)| !value.is_empty());
        }
        // A value-taking flag consumes the next arg, so that value isn't a prompt.
        if grok_value_flag(arg) {
            skip_next = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        // A bare positional is the interactive initial prompt.
        return true;
    }
    false
}

/// Extracts the session id from a `grok --resume <id>` (or `-r <id>` /
/// `--resume=<id>`) shell argument list, so a resume launch can rebind the original
/// agent. `None` when the invocation doesn't resume a specific session.
fn grok_resume_session_id(args: &[String]) -> Option<&str> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--resume" || arg == "-r" {
            return iter
                .next()
                .map(String::as_str)
                .filter(|next| !next.starts_with('-'));
        }
        if let Some(value) = arg.strip_prefix("--resume=") {
            return (!value.is_empty()).then_some(value);
        }
    }
    None
}

/// Grok flags that take a separate value argument, so the following token is the
/// flag's value rather than a positional prompt. Inline `--flag=value` forms start
/// with `-` and are skipped by the generic flag check, so they need no entry here.
fn grok_value_flag(arg: &str) -> bool {
    matches!(
        arg,
        "--cwd"
            | "--model"
            | "-m"
            | "--base-url"
            | "-u"
            | "--api-key"
            | "-k"
            | "--max-tool-rounds"
            | "--session-id"
            | "-s"
            | "--resume"
            | "-r"
            | "--output-format"
    )
}

/// Whether the user already supplied a `--cwd` so qMux does not add a duplicate one
/// when forwarding shell args.
fn args_contain_directory(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--cwd" || arg.starts_with("--cwd="))
}

/// Resolves an idle Grok agent: drains the next queued turn, or enters/stays paused.
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

/// Parses a line written by the qMux Grok plugin into a `Turn`.
///
/// The plugin writes one JSON line per message part, mirroring the Codex/OpenCode
/// transcript shape so the same `TurnBlock` variants apply:
/// ```json
/// {"type":"response_item","payload":{"type":"message","role":"user","content":[...]},"session_id":"..."}
/// ```
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
            let blocks = parse_grok_message_blocks(payload.get("content"))?;
            (role.to_string(), blocks)
        }
        "tool_use" | "function_call" | "custom_tool_call" => {
            let name = string_field(payload, "name").unwrap_or_else(|| "tool".to_string());
            (
                "assistant".to_string(),
                vec![TurnBlock::ToolUse {
                    id: string_field(payload, "id")
                        .or_else(|| string_field(payload, "call_id"))
                        .or_else(|| string_field(payload, "callId")),
                    name,
                    input: payload.get("input").cloned().unwrap_or(Value::Null),
                }],
            )
        }
        "tool_result" | "function_call_output" | "custom_tool_call_output" => (
            "assistant".to_string(),
            vec![TurnBlock::ToolResult {
                tool_use_id: string_field(payload, "tool_use_id")
                    .or_else(|| string_field(payload, "toolUseId"))
                    .or_else(|| string_field(payload, "call_id"))
                    .or_else(|| string_field(payload, "callId")),
                content: payload.get("content").cloned().unwrap_or(Value::Null),
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

fn parse_grok_message_blocks(content: Option<&Value>) -> Option<Vec<TurnBlock>> {
    match content? {
        Value::String(text) => Some(vec![TurnBlock::Text { text: text.clone() }]),
        Value::Array(items) => {
            let blocks =
                items
                    .iter()
                    .filter_map(|item| {
                        let block_type = item.get("type").and_then(Value::as_str);
                        match block_type {
                            Some("text") => item.get("text").and_then(Value::as_str).map(|text| {
                                TurnBlock::Text {
                                    text: text.to_string(),
                                }
                            }),
                            Some("tool_use") => Some(TurnBlock::ToolUse {
                                id: item
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .map(ToString::to_string),
                                name: item
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool")
                                    .to_string(),
                                input: item.get("input").cloned().unwrap_or(Value::Null),
                            }),
                            Some("tool_result") => Some(TurnBlock::ToolResult {
                                tool_use_id: item
                                    .get("tool_use_id")
                                    .and_then(Value::as_str)
                                    .map(ToString::to_string),
                                content: item.get("content").cloned().unwrap_or(Value::Null),
                                is_error: item
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            }),
                            _ => item.get("text").and_then(Value::as_str).map(|text| {
                                TurnBlock::Text {
                                    text: text.to_string(),
                                }
                            }),
                        }
                    })
                    .collect::<Vec<_>>();
            Some(blocks)
        }
        _ => None,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
        OpencodeAdapterConfig,
    };
    use crate::state::AppState;
    use std::path::PathBuf;

    fn test_config() -> QmuxConfig {
        QmuxConfig {
            workspace_root: PathBuf::from("/tmp/qmux-grok-tests"),
            socket_path: PathBuf::from("/tmp/qmux-grok-tests.sock"),
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

    fn test_state() -> AppState {
        AppState::new(test_config())
    }

    fn sample_agent() -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "grok".to_string(),
            worktree_dir: "/tmp/qmux-grok-tests".to_string(),
            branch: None,
            pane_id: None,
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Starting,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
            created_at: 1,
        }
    }

    fn hook_for_agent(event: &str, agent_id: &str, payload: Value) -> AdapterNotification {
        AdapterNotification {
            adapter_id: None,
            event: event.to_string(),
            pane_id: None,
            agent_id: Some(agent_id.to_string()),
            payload,
        }
    }

    fn ingest(state: &AppState, notification: AdapterNotification) -> QmuxEvent {
        let outcome = GrokAdapter::new(state.config())
            .ingest_notification(state, notification)
            .unwrap();
        match outcome {
            AdapterNotificationOutcome::Event(event) => event,
            AdapterNotificationOutcome::Events(events) => events.into_iter().next().unwrap(),
        }
    }

    #[test]
    fn launch_options_reject_unknown_fields() {
        let err = GrokLaunchOptions::from_value(json!({ "bogus": true })).unwrap_err();
        assert!(err.contains("invalid Grok adapter options"));
    }

    #[test]
    fn build_args_adds_cwd_model_and_positional_prompt() {
        let args = build_grok_args(Path::new("/tmp/qmux"), Some("grok-code"), "fix the bug");

        // The prompt is a trailing positional, after --cwd and --model.
        assert_eq!(
            args,
            vec!["--cwd", "/tmp/qmux", "--model", "grok-code", "fix the bug"]
        );
    }

    #[test]
    fn build_args_omit_empty_prompt_and_model() {
        let args = build_grok_args(Path::new("/tmp/qmux"), None, "  ");

        assert_eq!(args, vec!["--cwd", "/tmp/qmux"]);
    }

    #[test]
    fn resume_args_include_session_id_when_present() {
        let (args, resumed) =
            build_grok_resume_args(Path::new("/tmp/qmux"), Some("grok-code"), Some(" sess-1 "));

        assert!(resumed);
        assert_eq!(
            args,
            vec![
                "--cwd",
                "/tmp/qmux",
                "--model",
                "grok-code",
                "--resume",
                "sess-1"
            ]
        );
    }

    #[test]
    fn resume_args_fall_back_to_fresh_launch_without_session_id() {
        let (args, resumed) = build_grok_resume_args(Path::new("/tmp/qmux"), None, Some("   "));

        assert!(!resumed);
        assert_eq!(args, vec!["--cwd", "/tmp/qmux"]);
    }

    #[test]
    fn shell_resume_command_resumes_the_session() {
        let command = GrokAdapter::new(&test_config())
            .shell_resume_command("sess-1")
            .expect("grok supports shell resume");
        assert_eq!(command, "grok --resume 'sess-1'");
    }

    #[test]
    fn shell_args_supply_cwd_only_when_absent() {
        // No cwd in the user's args: qMux adds the pane cwd.
        let args = build_grok_args_from_shell(
            Path::new("/tmp/qmux"),
            &["--model".to_string(), "grok-code".to_string()],
        );
        assert_eq!(args, vec!["--cwd", "/tmp/qmux", "--model", "grok-code"]);

        // User already passed a cwd: forward verbatim, no duplicate.
        let args = build_grok_args_from_shell(
            Path::new("/tmp/qmux"),
            &["--cwd".to_string(), "/elsewhere".to_string()],
        );
        assert_eq!(args, vec!["--cwd", "/elsewhere"]);
    }

    #[test]
    fn args_contain_prompt_detects_prompt_and_positional() {
        // Interactive, no prompt: bare flags or resume/model only.
        assert!(!args_contain_prompt(&[]));
        assert!(!args_contain_prompt(&[
            "--model".to_string(),
            "grok-code".to_string()
        ]));
        assert!(!args_contain_prompt(&[
            "--cwd".to_string(),
            "/tmp".to_string()
        ]));
        // `--resume <id>` consumes the id as a value, not a positional prompt.
        assert!(!args_contain_prompt(&[
            "--resume".to_string(),
            "sess-1".to_string()
        ]));

        // Headless prompt flags.
        assert!(args_contain_prompt(&[
            "--prompt".to_string(),
            "fix the bug".to_string()
        ]));
        assert!(args_contain_prompt(&[
            "-p".to_string(),
            "fix the bug".to_string()
        ]));
        assert!(args_contain_prompt(&["--prompt=fix the bug".to_string()]));
        // A trailing positional is the interactive initial prompt.
        assert!(args_contain_prompt(&["fix the bug".to_string()]));
        assert!(args_contain_prompt(&[
            "--model".to_string(),
            "grok-code".to_string(),
            "fix the bug".to_string()
        ]));
    }

    #[test]
    fn composer_policy_queues_running_panes() {
        let policy = GrokAdapter {
            binary: "grok".to_string(),
        }
        .composer_policy();

        assert!(!policy.can_send(AgentStatus::Running));
        assert!(policy.should_queue(AgentStatus::Running));
        assert!(policy.can_steer(AgentStatus::Running));
    }

    #[test]
    fn interactive_attach_marks_agent_idle() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_grok_agent_pane(&state, "agent-1", "pane-1".to_string(), false).unwrap();

        assert!(matches!(attached.status, AgentStatus::Idle));
        let stored = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(stored.status, AgentStatus::Idle));
    }

    #[test]
    fn prompted_attach_keeps_agent_running() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_grok_agent_pane(&state, "agent-1", "pane-1".to_string(), true).unwrap();

        assert!(matches!(attached.status, AgentStatus::Running));
    }

    #[test]
    fn session_start_captures_session_id_and_binds_transcript() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        state.insert_agent(agent).unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "SessionStart",
                "agent-1",
                json!({ "session_id": "grok-session-1" }),
            ),
        );

        assert_eq!(event.event_type, "agent.session_start");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert_eq!(agent.session_id.as_deref(), Some("grok-session-1"));
        // SessionStart does not promote to Running (matches Claude/Codex/OpenCode).
        assert!(matches!(agent.status, AgentStatus::Starting));
        assert!(
            agent
                .transcript_path
                .as_deref()
                .unwrap()
                .ends_with("/.qmux/grok/agent-1.jsonl")
        );
    }

    #[test]
    fn stop_marks_agent_done_without_queued_turns() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Running;
        state.insert_agent(agent).unwrap();

        let event = ingest(&state, hook_for_agent("Stop", "agent-1", json!({})));

        assert_eq!(event.event_type, "agent.done");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Done));
    }

    #[test]
    fn permission_request_marks_agent_awaiting_permission() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Running;
        state.insert_agent(agent).unwrap();

        let event = ingest(
            &state,
            hook_for_agent("PermissionRequest", "agent-1", json!({})),
        );

        assert_eq!(event.event_type, "agent.awaiting_permission");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::AwaitingPermission));
    }

    #[test]
    fn parse_transcript_line_extracts_user_message() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"hello world"}]},"session_id":"sess-1"}"#;

        let turn = parse_transcript_line("agent-1", 0, line).unwrap();

        assert_eq!(turn.role, "user");
        assert_eq!(turn.session_id.as_deref(), Some("sess-1"));
        assert_eq!(turn.blocks.len(), 1);
        match &turn.blocks[0] {
            TurnBlock::Text { text } => assert_eq!(text, "hello world"),
            other => panic!("expected text block, got {other:?}"),
        }
    }

    #[test]
    fn parse_transcript_line_extracts_assistant_tool_use() {
        let line = r#"{"type":"response_item","payload":{"type":"tool_use","name":"bash","id":"call-1","input":{"command":"ls"}},"session_id":"sess-1"}"#;

        let turn = parse_transcript_line("agent-1", 1, line).unwrap();

        assert_eq!(turn.role, "assistant");
        assert_eq!(turn.blocks.len(), 1);
        match &turn.blocks[0] {
            TurnBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_deref(), Some("call-1"));
                assert_eq!(name, "bash");
                assert_eq!(input["command"], "ls");
            }
            other => panic!("expected tool use block, got {other:?}"),
        }
    }

    #[test]
    fn parse_transcript_line_ignores_developer_messages() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"text","text":"system"}]},"session_id":"sess-1"}"#;

        assert!(parse_transcript_line("agent-1", 0, line).is_none());
    }

    #[test]
    fn parse_grok_turn_aborted_lifecycle_event() {
        let abort_line = json!({
            "type": "event_msg",
            "payload": { "type": "turn_aborted", "reason": "interrupt" },
            "session_id": "sess-1"
        })
        .to_string();
        let ordinary_event_line = json!({
            "type": "event_msg",
            "payload": { "type": "status", "message": "ok" },
            "session_id": "sess-1"
        })
        .to_string();

        assert_eq!(
            parse_transcript_lifecycle_event(&abort_line),
            Some(TranscriptLifecycleEvent::Interrupted)
        );
        assert_eq!(parse_transcript_lifecycle_event(&ordinary_event_line), None);
    }

    #[test]
    fn transcript_path_is_under_workspace_root() {
        let state = test_state();
        let path = GrokAdapter::transcript_path_for(&state, "agent-42");

        assert!(path.ends_with(".qmux/grok/agent-42.jsonl"));
        assert!(path.starts_with("/tmp/qmux-grok-tests"));
    }

    #[test]
    fn session_start_prefers_hook_provided_transcript_path() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        state.insert_agent(agent).unwrap();

        let event = ingest(
            &state,
            hook_for_agent(
                "SessionStart",
                "agent-1",
                json!({
                    "session_id": "grok-session-1",
                    "transcript_path": "/home/user/.grok/sessions/grok-session-1/rollout.jsonl"
                }),
            ),
        );

        assert_eq!(event.event_type, "agent.session_start");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        // The hook-provided path wins over the qMux-managed fallback.
        assert_eq!(
            agent.transcript_path.as_deref(),
            Some("/home/user/.grok/sessions/grok-session-1/rollout.jsonl")
        );
    }

    #[test]
    fn session_start_without_transcript_path_keeps_recorded_path() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Idle;
        agent.session_id = Some("grok-session-1".to_string());
        agent.transcript_path =
            Some("/home/user/.grok/sessions/grok-session-1/rollout.jsonl".to_string());
        state.insert_agent(agent).unwrap();

        // A late/duplicate SessionStart (e.g. after a resume) that omits the field
        // must not rebind the tail to the qMux fallback path.
        let event = ingest(&state, hook_for_agent("SessionStart", "agent-1", json!({})));

        assert_eq!(event.event_type, "agent.session_start");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert_eq!(
            agent.transcript_path.as_deref(),
            Some("/home/user/.grok/sessions/grok-session-1/rollout.jsonl")
        );
        // Nor blank a recorded session id.
        assert_eq!(agent.session_id.as_deref(), Some("grok-session-1"));
    }

    #[test]
    fn resume_session_id_parses_resume_forms() {
        let args = |values: &[&str]| values.iter().map(ToString::to_string).collect::<Vec<_>>();

        assert_eq!(
            grok_resume_session_id(&args(&["--resume", "sess-1"])),
            Some("sess-1")
        );
        assert_eq!(
            grok_resume_session_id(&args(&["-r", "sess-1"])),
            Some("sess-1")
        );
        assert_eq!(
            grok_resume_session_id(&args(&["--resume=sess-1"])),
            Some("sess-1")
        );
        assert_eq!(
            grok_resume_session_id(&args(&["--model", "grok-code", "--resume", "sess-1"])),
            Some("sess-1")
        );

        // Not a resume of a specific session.
        assert_eq!(grok_resume_session_id(&args(&[])), None);
        assert_eq!(grok_resume_session_id(&args(&["fix the bug"])), None);
        assert_eq!(grok_resume_session_id(&args(&["--resume"])), None);
        assert_eq!(grok_resume_session_id(&args(&["--resume="])), None);
        assert_eq!(
            grok_resume_session_id(&args(&["--resume", "--model"])),
            None
        );
    }

    #[test]
    fn grok_hook_shim_is_env_gated_and_forwards_notify() {
        let shim = grok_hook_shim();
        // No-ops outside qMux: every required env var is checked.
        assert!(shim.contains("QMUX_SOCK"));
        assert!(shim.contains("QMUX_TOKEN"));
        assert!(shim.contains("QMUX_PANE_ID"));
        assert!(shim.contains("QMUX_AGENT_ID"));
        assert!(shim.contains("QMUX_CLI"));
        // Inside qMux it forwards the event to `qmux notify`.
        assert!(shim.contains(r#"exec "$QMUX_CLI" notify "$event""#));
    }

    #[test]
    fn merge_grok_hooks_installs_events_and_preserves_existing() {
        let shim = Path::new("/home/user/.grok/qmux/qmux-grok-hook");
        // Existing settings carry an unrelated key and a user's own SessionStart hook.
        let existing = json!({
            "model": "grok-code-fast",
            "hooks": {
                "SessionStart": [
                    { "matcher": "", "hooks": [{ "type": "command", "command": "echo user-hook" }] }
                ]
            }
        });

        let merged = merge_grok_hooks(existing, shim);

        // Unrelated settings are preserved untouched.
        assert_eq!(merged["model"], "grok-code-fast");
        // Every qMux event gets an entry whose command runs the shim.
        for event in GROK_HOOK_EVENTS {
            let entries = merged["hooks"][event].as_array().expect("event array");
            assert!(
                entries
                    .iter()
                    .any(|entry| is_qmux_grok_hook_entry(entry, shim)),
                "missing qMux hook entry for {event}"
            );
        }
        // The user's own SessionStart hook is preserved alongside qMux's.
        let session_start = merged["hooks"]["SessionStart"].as_array().unwrap();
        assert!(
            session_start
                .iter()
                .any(|entry| entry["hooks"][0]["command"] == "echo user-hook")
        );
        assert_eq!(session_start.len(), 2);
    }

    #[test]
    fn merge_grok_hooks_is_idempotent() {
        let shim = Path::new("/home/user/.grok/qmux/qmux-grok-hook");
        let once = merge_grok_hooks(json!({}), shim);
        let twice = merge_grok_hooks(once.clone(), shim);

        // Re-installing replaces qMux's entry rather than appending a duplicate.
        for event in GROK_HOOK_EVENTS {
            assert_eq!(
                twice["hooks"][event].as_array().unwrap().len(),
                1,
                "duplicate qMux hook entry for {event}"
            );
        }
        assert_eq!(once, twice);
    }

    #[test]
    fn write_grok_integration_files_creates_shim_and_settings() {
        let home = std::env::temp_dir().join(format!("qmux-grok-home-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);

        write_grok_integration_files(&home).unwrap();

        let shim_path = home.join("qmux").join("qmux-grok-hook");
        let shim_meta = fs::metadata(&shim_path).expect("shim written");
        // Executable bit set so Grok can run it.
        assert_eq!(shim_meta.permissions().mode() & 0o111, 0o111);

        let settings_raw = fs::read_to_string(home.join("user-settings.json")).unwrap();
        let settings: Value = serde_json::from_str(&settings_raw).unwrap();
        for event in GROK_HOOK_EVENTS {
            assert!(
                settings["hooks"][event].is_array(),
                "missing hooks for {event}"
            );
        }

        let _ = fs::remove_dir_all(&home);
    }
}
