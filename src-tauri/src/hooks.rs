use crate::events::QmuxEvent;
use crate::state::AppState;
use crate::transcript::start_transcript_tail;
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
    "Notification",
    "Stop",
    "SubagentStop",
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
        "Notification" => {
            if let Some(agent) = agent.as_mut() {
                agent.status = AgentStatus::AwaitingInput;
                state.update_agent(agent.clone())?;
            }
            "agent.awaiting_input"
        }
        "Stop" => {
            if let Some(agent) = agent.as_mut() {
                agent.status = AgentStatus::Stopped;
                state.update_agent(agent.clone())?;
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

    Ok(QmuxEvent::new(
        event_type,
        pane_id,
        agent.map(|agent| agent.id),
        json!({
            "hookEvent": notification.event,
            "payload": notification.payload,
        }),
    ))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn shell_quote(path: &Path) -> String {
    let raw = path.display().to_string();
    format!("'{}'", raw.replace('\'', "'\\''"))
}
