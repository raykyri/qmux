use crate::events::QmuxEvent;
use crate::state::AppState;
use crate::transcript::start_transcript_tail;
use crate::turn_queue::drain_agent_turn_queue;
use crate::workspace::{AgentInfo, AgentStatus};
use serde::Deserialize;
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookNotification {
    pub event: String,
    pub pane_id: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

pub fn write_claude_hook_settings(agent: &AgentInfo) -> Result<PathBuf, String> {
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
                            "command": format!("{} notify {}", shell_quote(&qmux_cli), event)
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
                            "command": format!("{} notify {}", shell_quote(&qmux_cli), event)
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

pub fn ingest_hook_notification(
    state: &AppState,
    notification: HookNotification,
) -> Result<QmuxEvent, String> {
    let pane_id = notification.pane_id.clone();
    let mut send_tracking = None;
    let mut agent = pane_id
        .as_deref()
        .and_then(|pane_id| state.agent_by_pane(pane_id).ok().flatten());
    let event_type = match notification.event.as_str() {
        "SessionStart" => {
            if let Some(agent) = agent.as_mut() {
                agent.session_id = string_field(&notification.payload, "session_id")
                    .or_else(|| string_field(&notification.payload, "sessionId"));
                agent.transcript_path = string_field(&notification.payload, "transcript_path")
                    .or_else(|| string_field(&notification.payload, "transcriptPath"));
                agent.status = AgentStatus::Running;
                state.update_agent(agent.clone())?;
                if let Some(transcript_path) = agent.transcript_path.clone() {
                    start_transcript_tail(state.clone(), agent.id.clone(), transcript_path);
                }
            }
            "agent.session_start"
        }
        "UserPromptSubmit" => {
            if let Some(agent) = agent.as_mut() {
                agent.status = AgentStatus::Running;
                state.update_agent(agent.clone())?;
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
                state.update_agent(agent.clone())?;
            }
            "agent.tool_use"
        }
        "PostToolUse" => {
            if let Some(agent) = agent.as_mut() {
                agent.status = AgentStatus::Running;
                state.update_agent(agent.clone())?;
            }
            "agent.tool_result"
        }
        "PermissionRequest" => {
            if let Some(agent) = agent.as_mut() {
                agent.status = AgentStatus::AwaitingPermission;
                state.update_agent(agent.clone())?;
            }
            "agent.awaiting_permission"
        }
        event if event.starts_with("Notification") => {
            let notification_kind = notification_kind(&notification);
            if let Some(agent) = agent.as_mut() {
                agent.status = notification_status(notification_kind);
                state.update_agent(agent.clone())?;
                if matches!(notification_kind, NotificationKind::IdlePrompt) {
                    drain_queued_turn_after_idle(state, agent);
                }
            }
            notification_event_type(notification_kind)
        }
        "Stop" => {
            if let Some(agent) = agent.as_mut() {
                agent.status = AgentStatus::Stopped;
                state.update_agent(agent.clone())?;
                drain_queued_turn_after_idle(state, agent);
            }
            "agent.stopped"
        }
        "SubagentStop" => "agent.subagent_stopped",
        other => {
            return Ok(QmuxEvent::new(
                format!("agent.hook.{other}"),
                pane_id,
                agent.map(|agent| agent.id),
                json!({
                    "hookEvent": other,
                    "payload": notification.payload,
                }),
            ));
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

    Ok(QmuxEvent::new(
        event_type,
        pane_id,
        agent.map(|agent| agent.id),
        event_payload,
    ))
}

fn drain_queued_turn_after_idle(state: &AppState, agent: &AgentInfo) {
    let _ = state.clear_agent_outstanding_sends(&agent.id);
    if let Err(err) = drain_agent_turn_queue(state, &agent.id) {
        state.emit(QmuxEvent::new(
            "agent.queue_error",
            agent.pane_id.clone(),
            Some(agent.id.clone()),
            json!({ "error": err }),
        ));
    }
}

fn notification_event_type(notification_kind: NotificationKind) -> &'static str {
    match notification_kind {
        NotificationKind::PermissionPrompt => "agent.awaiting_permission",
        NotificationKind::IdlePrompt => "agent.idle",
        NotificationKind::ElicitationDialog => "agent.awaiting_input",
        NotificationKind::Other => "agent.notification",
    }
}

fn notification_status(notification_kind: NotificationKind) -> AgentStatus {
    match notification_kind {
        NotificationKind::PermissionPrompt => AgentStatus::AwaitingPermission,
        NotificationKind::IdlePrompt => AgentStatus::Stopped,
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

fn notification_kind(notification: &HookNotification) -> NotificationKind {
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

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn is_subagent_payload(value: &Value) -> bool {
    value.get("agent_id").is_some() || value.get("agentId").is_some()
}

fn shell_quote(path: &Path) -> String {
    let raw = path.display().to_string();
    format!("'{}'", raw.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::QmuxConfig;
    use crate::state::{AgentSendSource, AppState, PaneInfo, PaneKind, PaneRuntime, PaneStatus};
    use portable_pty::{Child, ChildKiller, ExitStatus, PtySize, native_pty_system};
    use serde_json::json;
    use std::io::{self, Write};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

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
            claude_binary: "claude".to_string(),
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
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Running,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
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
                },
                child: Arc::new(Mutex::new(Box::new(FakeChild))),
                master: Arc::new(Mutex::new(pair.master)),
                writer: Arc::new(Mutex::new(Box::new(RecordingWriter {
                    bytes: bytes.clone(),
                }))),
            })
            .unwrap();
        bytes
    }

    fn hook(event: &str, payload: serde_json::Value) -> HookNotification {
        HookNotification {
            event: event.to_string(),
            pane_id: Some("pane-1".to_string()),
            payload,
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

        let event = ingest_hook_notification(&state, hook("Stop", json!({}))).unwrap();

        assert_eq!(event.event_type, "agent.stopped");
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["second".to_string()]
        );
        let written = written_text(&bytes);
        assert!(written.contains("first"));
        assert!(!written.contains("second"));
    }

    #[test]
    fn idle_prompt_drains_one_queued_turn() {
        let state = test_state();
        let bytes = install_agent_pane(&state);
        state
            .enqueue_agent_turn("agent-1", "queued".to_string())
            .unwrap();

        let event = ingest_hook_notification(
            &state,
            hook(
                "Notification.idle_prompt",
                json!({ "hook_event_name": "Notification" }),
            ),
        )
        .unwrap();

        assert_eq!(event.event_type, "agent.idle");
        assert!(state.list_agent_turn_queue("agent-1").unwrap().is_empty());
        assert!(written_text(&bytes).contains("queued"));
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

        let event = ingest_hook_notification(
            &state,
            hook("UserPromptSubmit", json!({ "prompt": "hello world" })),
        )
        .unwrap();

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

        let event = ingest_hook_notification(
            &state,
            hook("UserPromptSubmit", json!({ "prompt": "foreign" })),
        )
        .unwrap();
        assert_eq!(event.payload["sendTracking"]["status"], "mismatched");

        state
            .enqueue_agent_turn("agent-1", "queued after mismatch".to_string())
            .unwrap();
        ingest_hook_notification(&state, hook("Stop", json!({}))).unwrap();

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

        let event = ingest_hook_notification(
            &state,
            hook(
                "UserPromptSubmit",
                json!({ "agent_id": "subagent-1", "prompt": "expected" }),
            ),
        )
        .unwrap();

        assert!(event.payload.get("sendTracking").is_none());
        assert_eq!(state.outstanding_agent_sends("agent-1").unwrap().len(), 1);
    }
}
