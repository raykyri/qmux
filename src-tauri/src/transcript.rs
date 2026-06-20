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
        let mut read_failures: u32 = 0;
        let mut notice_active = false;
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
            // Stop once the agent has rotated to a different transcript file (resume,
            // compact, a fresh session) or has gone away entirely. Claude only ever
            // changes the path alongside a freshly started tail for the new file, so
            // this tail exiting leaves exactly one live tail rather than two racing on
            // the same agent. Without this the tail stays pinned to a now-dead file
            // and the timeline silently stops advancing while the agent runs on.
            // A poisoned model lock (the implicit Err case) is transient from this
            // thread's view, so it falls through and we keep polling rather than
            // tearing the tail down on a momentary failure.
            if let Ok(found) = state.agent(&agent_id) {
                let current = found.as_ref().map(|agent| agent.transcript_path.as_deref());
                if !tail_should_continue(current, &transcript_path) {
                    if notice_active {
                        state.emit(transcript_notice(&agent_id, &transcript_path, None));
                    }
                    state.clear_transcript_tail(&agent_id, &transcript_path);
                    return;
                }
            }

            let raw = match fs::read_to_string(&path) {
                Ok(raw) => {
                    read_failures = 0;
                    if notice_active {
                        notice_active = false;
                        state.emit(transcript_notice(&agent_id, &transcript_path, None));
                    }
                    raw
                }
                Err(_) => {
                    // A single miss is normal while Claude is mid-write; a file that
                    // stays unreadable means the timeline has quietly stalled, so
                    // surface that once (cleared above when reads recover).
                    read_failures = read_failures.saturating_add(1);
                    if read_failures == READ_FAILURE_NOTICE_THRESHOLD && !notice_active {
                        notice_active = true;
                        state.emit(transcript_notice(
                            &agent_id,
                            &transcript_path,
                            Some("Transcript unavailable"),
                        ));
                    }
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

/// Consecutive failed reads (at 500ms each, ~3s) before the bound transcript file
/// being unreadable is surfaced as an unexpected state rather than a write race.
const READ_FAILURE_NOTICE_THRESHOLD: u32 = 6;

/// Builds a `transcript.notice` event carrying a short, user-facing message about
/// the tail's health. A `None` message clears any notice the UI is showing.
fn transcript_notice(agent_id: &str, path: &str, message: Option<&str>) -> QmuxEvent {
    QmuxEvent::new(
        "transcript.notice",
        None,
        Some(agent_id.to_string()),
        json!({ "message": message, "path": path }),
    )
}

fn is_append_only(previous: &[String], current: &[String]) -> bool {
    previous.len() <= current.len()
        && previous
            .iter()
            .zip(current.iter())
            .all(|(previous, current)| previous == current)
}

/// Whether a tail bound to `bound_path` should keep running. `current` is the
/// agent's freshly looked-up transcript path: `Some(Some(path))` when the agent
/// exists with a path set, `Some(None)` when it exists with none, and `None` when
/// the agent is gone. The tail only continues while the agent is still pointing at
/// the exact file this tail was started for; any rotation or removal stops it.
fn tail_should_continue(current: Option<Option<&str>>, bound_path: &str) -> bool {
    matches!(current, Some(Some(path)) if path == bound_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_continues_only_while_bound_to_the_same_path() {
        // Agent still pointing at this tail's file: keep tailing.
        assert!(tail_should_continue(Some(Some("/t/a.jsonl")), "/t/a.jsonl"));
        // Rotated to a new transcript (resume/compact/new session): stop.
        assert!(!tail_should_continue(Some(Some("/t/b.jsonl")), "/t/a.jsonl"));
        // Path cleared while the agent lives: stop.
        assert!(!tail_should_continue(Some(None), "/t/a.jsonl"));
        // Agent gone entirely: stop.
        assert!(!tail_should_continue(None, "/t/a.jsonl"));
    }

    #[test]
    fn append_only_detects_prefix_growth_but_not_rewrites() {
        let base = vec!["a".to_string(), "b".to_string()];
        // Pure appends keep the existing lines as a prefix.
        assert!(is_append_only(&base, &[
            "a".to_string(),
            "b".to_string(),
            "c".to_string()
        ]));
        assert!(is_append_only(&base, &base));
        // A rewritten or truncated file is not append-only and forces a reset.
        assert!(!is_append_only(&base, &["a".to_string()]));
        assert!(!is_append_only(&base, &["x".to_string(), "b".to_string()]));
    }
}
