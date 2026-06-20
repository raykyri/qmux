use crate::adapters::adapter_registry;
use crate::events::QmuxEvent;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub role: String,
    pub blocks: Vec<TurnBlock>,
    pub source_index: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TurnBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: Option<String>,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: Option<String>,
        content: Value,
        is_error: bool,
    },
    Raw {
        value: Value,
    },
}

pub fn start_transcript_tail(
    state: AppState,
    agent_id: String,
    transcript_path: String,
    adapter_id: String,
) {
    if let Err(err) = adapter_registry(state.config()).get(&adapter_id) {
        state.emit(QmuxEvent::new(
            "transcript.error",
            None,
            Some(agent_id),
            json!({ "error": err, "path": transcript_path, "adapterId": adapter_id }),
        ));
        return;
    }

    let should_start = state
        .mark_transcript_tail(&agent_id, &transcript_path)
        .unwrap_or(false);
    if !should_start {
        return;
    }

    thread::spawn(move || {
        let path = PathBuf::from(&transcript_path);
        let mut seen_lines: Vec<String> = Vec::new();
        let registry = adapter_registry(state.config());
        let adapter = match registry.get(&adapter_id) {
            Ok(adapter) => adapter,
            Err(err) => {
                state.emit(QmuxEvent::new(
                    "transcript.error",
                    None,
                    Some(agent_id),
                    json!({ "error": err, "path": transcript_path, "adapterId": adapter_id }),
                ));
                return;
            }
        };

        loop {
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(_) => {
                    thread::sleep(Duration::from_millis(500));
                    continue;
                }
            };
            let lines = raw.lines().map(ToString::to_string).collect::<Vec<_>>();

            if is_append_only(&seen_lines, &lines) {
                for (index, line) in lines.iter().enumerate().skip(seen_lines.len()) {
                    if let Some(turn) = adapter.parse_transcript_line(&agent_id, index, line) {
                        let _ = state.append_turn(turn.clone());
                        state.emit(QmuxEvent::new(
                            "turn.appended",
                            None,
                            Some(agent_id.clone()),
                            json!({ "turn": turn }),
                        ));
                    }
                }
            } else {
                let turns = lines
                    .iter()
                    .enumerate()
                    .filter_map(|(index, line)| {
                        adapter.parse_transcript_line(&agent_id, index, line)
                    })
                    .collect::<Vec<_>>();
                let _ = state.replace_turns(&agent_id, turns.clone());
                state.emit(QmuxEvent::new(
                    "turn.updated",
                    None,
                    Some(agent_id.clone()),
                    json!({ "reset": true, "turns": turns }),
                ));
            }

            seen_lines = lines;
            thread::sleep(Duration::from_millis(350));
        }
    });
}

fn is_append_only(previous: &[String], current: &[String]) -> bool {
    previous.len() <= current.len()
        && previous
            .iter()
            .zip(current.iter())
            .all(|(previous, current)| previous == current)
}
