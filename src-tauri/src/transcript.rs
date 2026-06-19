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
    Text { text: String },
    ToolUse { name: String, input: Value },
    ToolResult { content: Value, is_error: bool },
    Raw { value: Value },
}

pub fn start_transcript_tail(state: AppState, agent_id: String, transcript_path: String) {
    let should_start = state
        .mark_transcript_tail(&agent_id, &transcript_path)
        .unwrap_or(false);
    if !should_start {
        return;
    }

    thread::spawn(move || {
        let path = PathBuf::from(&transcript_path);
        let mut seen_lines: Vec<String> = Vec::new();

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
                    if let Some(turn) = parse_transcript_line(&agent_id, index, line) {
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
                    .filter_map(|(index, line)| parse_transcript_line(&agent_id, index, line))
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
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            input: value.get("input").cloned().unwrap_or(Value::Null),
        }),
        Some("tool_result") => Some(TurnBlock::ToolResult {
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
