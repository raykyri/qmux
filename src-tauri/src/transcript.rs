use crate::adapters::adapter_registry;
use crate::events::QmuxEvent;
use crate::state::AppState;
use crate::workspace::AgentInfo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
        // Incremental tail state: bytes of complete lines already consumed, and the
        // running absolute line index so parsed turns keep stable source indices as
        // the file grows. Reading only the appended tail each tick keeps steady
        // state O(new bytes) instead of re-reading and re-diffing the whole file.
        let mut consumed: u64 = 0;
        let mut line_index: usize = 0;
        let mut read_failures: u32 = 0;
        let mut notice_active = false;
        // Whether this tail has ever read its bound file. Recovery only makes sense
        // for a file we were actually following that then vanished (a rotation); a
        // file that has never appeared is a freshly launched session still warming
        // up, and jumping to the newest existing JSONL would bind us to an unrelated
        // old session instead of the new one whose SessionStart just set this path.
        let mut have_read_bound_file = false;
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

            let snapshot = match read_transcript_from(&path, consumed) {
                Ok(snapshot) => {
                    read_failures = 0;
                    have_read_bound_file = true;
                    if notice_active {
                        notice_active = false;
                        state.emit(transcript_notice(&agent_id, &transcript_path, None));
                    }
                    snapshot
                }
                Err(err) => {
                    if should_recover_missing(err.kind(), have_read_bound_file)
                        && let Ok(Some(recovered_path)) = recover_missing_transcript(
                            &state,
                            &agent_id,
                            &transcript_path,
                            &path,
                            &adapter_id,
                        )
                    {
                        if notice_active {
                            state.emit(transcript_notice(&agent_id, &transcript_path, None));
                        }
                        state.clear_transcript_tail(&agent_id, &transcript_path);
                        start_transcript_tail(
                            state.clone(),
                            agent_id.clone(),
                            recovered_path,
                            adapter_id.clone(),
                        );
                        return;
                    }
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
            if snapshot.reset {
                // The file is now shorter than what we'd already consumed (a
                // truncation or in-place rewrite), so our timeline no longer
                // prefixes it: rebuild from the whole file.
                let lines = complete_lines(&snapshot.data);
                let turns = lines
                    .iter()
                    .enumerate()
                    .filter_map(|(index, line)| {
                        adapter.parse_transcript_line(&agent_id, index, line)
                    })
                    .collect::<Vec<_>>();
                if let Err(err) = state.replace_turns(&agent_id, turns.clone()) {
                    state.emit(transcript_persist_error(&agent_id, &transcript_path, &err));
                } else {
                    state.emit(QmuxEvent::new(
                        "turn.updated",
                        None,
                        Some(agent_id.clone()),
                        json!({ "reset": true, "turns": turns }),
                    ));
                }
                line_index = lines.len();
                consumed = complete_len(&snapshot.data);
            } else {
                // Steady state: parse only the complete lines that arrived since the
                // last tick. line_index advances for every complete line (parsed or
                // not) so source indices stay aligned with the file's line numbers.
                for line in complete_lines(&snapshot.data) {
                    if let Some(turn) = adapter.parse_transcript_line(&agent_id, line_index, &line)
                    {
                        // Surface a persistence failure rather than silently emitting a
                        // turn the store never recorded, which would drift the UI
                        // timeline from recovered state.
                        if let Err(err) = state.append_turn(turn.clone()) {
                            state.emit(transcript_persist_error(&agent_id, &transcript_path, &err));
                        } else {
                            state.emit(QmuxEvent::new(
                                "turn.appended",
                                None,
                                Some(agent_id.clone()),
                                json!({ "turn": turn }),
                            ));
                        }
                    }
                    line_index += 1;
                }
                consumed += complete_len(&snapshot.data);
            }

            thread::sleep(Duration::from_millis(350));
        }
    });
}

/// Consecutive failed reads (at 500ms each, ~3s) before the bound transcript file
/// being unreadable is surfaced as an unexpected state rather than a write race.
const READ_FAILURE_NOTICE_THRESHOLD: u32 = 6;

fn recover_missing_transcript(
    state: &AppState,
    agent_id: &str,
    bound_path: &str,
    missing_path: &Path,
    adapter_id: &str,
) -> Result<Option<String>, String> {
    if adapter_id != "claude" {
        return Ok(None);
    }

    let Some(dir) = missing_path.parent() else {
        return Ok(None);
    };
    let candidates = gather_transcript_candidates(dir)?;
    // Never recover onto a file another agent is already tailing — in a shared
    // project directory the newest JSONL by mtime is frequently a sibling agent's
    // live session, which would silently bind this agent to the wrong transcript.
    let excluded = other_agent_transcript_paths(state, agent_id);
    let Some(candidate) = select_newest_transcript_candidate(&candidates, &excluded, bound_path)
    else {
        return Ok(None);
    };
    let recovered_path = candidate.path.display().to_string();
    if recovered_path == bound_path {
        return Ok(None);
    }

    let Some(mut agent) = state.agent(agent_id)? else {
        return Ok(None);
    };
    if agent.transcript_path.as_deref() != Some(bound_path) {
        return Ok(None);
    }

    agent.session_id = candidate.session_id.clone();
    agent.transcript_path = Some(recovered_path.clone());
    state.update_agent(agent.clone())?;
    state.emit(QmuxEvent::new(
        "agent.transcript_recovered",
        agent.pane_id.clone(),
        Some(agent.id.clone()),
        json!({
            "agent": agent,
            "missingPath": bound_path,
            "transcriptPath": recovered_path,
        }),
    ));

    Ok(Some(recovered_path))
}

#[derive(Clone, Debug)]
struct TranscriptCandidate {
    path: PathBuf,
    modified: SystemTime,
    session_id: Option<String>,
}

/// All `*.jsonl` transcript files in `dir`, each paired with its mtime and the
/// session id read from its filename. Shared by auto-recovery and the manual
/// session picker so both reason over the same candidate set.
fn gather_transcript_candidates(dir: &Path) -> Result<Vec<TranscriptCandidate>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(format!(
                "failed to inspect transcript directory {}: {err}",
                dir.display()
            ));
        }
    };

    let mut candidates = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        candidates.push(TranscriptCandidate {
            session_id: session_id_from_transcript_path(&path),
            path,
            modified,
        });
    }

    Ok(candidates)
}

/// Transcript paths bound to agents other than `agent_id`, so recovery can avoid
/// stealing a sibling agent's live session.
fn other_agent_transcript_paths(state: &AppState, agent_id: &str) -> HashSet<String> {
    state
        .list_agents()
        .unwrap_or_default()
        .into_iter()
        .filter(|agent| agent.id != agent_id)
        .filter_map(|agent| agent.transcript_path)
        .collect()
}

/// Newest candidate by mtime, ignoring the now-missing bound path and any file
/// another agent is tailing. Path is a stable tiebreaker for equal mtimes.
fn select_newest_transcript_candidate(
    candidates: &[TranscriptCandidate],
    excluded: &HashSet<String>,
    bound_path: &str,
) -> Option<TranscriptCandidate> {
    candidates
        .iter()
        .filter(|candidate| {
            let path = candidate.path.display().to_string();
            path != bound_path && !excluded.contains(&path)
        })
        .max_by(|left, right| {
            left.modified
                .cmp(&right.modified)
                .then(left.path.cmp(&right.path))
        })
        .cloned()
}

/// Cap on how many sessions the picker offers, newest first — old projects can
/// accumulate hundreds of JSONL files and the user only ever wants a recent one.
const MAX_TRANSCRIPT_OPTIONS: usize = 30;

/// Characters of the first user message shown as a session preview.
const PREVIEW_MAX_CHARS: usize = 90;

/// One selectable session for the right pane's transcript picker.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptOption {
    pub path: String,
    pub session_id: Option<String>,
    pub modified_ms: u128,
    pub preview: Option<String>,
    pub line_count: usize,
    /// This is the transcript the agent is currently bound to.
    pub is_active: bool,
    /// Another agent is tailing this file; selecting it would collide.
    pub bound_to_other_agent: bool,
}

/// Sessions in the agent's transcript directory, newest first, for the manual
/// picker. Empty when the agent has no transcript path yet (nothing to scan).
pub fn list_agent_transcripts(
    state: &AppState,
    agent_id: &str,
) -> Result<Vec<TranscriptOption>, String> {
    let Some(agent) = state.agent(agent_id)? else {
        return Ok(Vec::new());
    };
    let Some(current_path) = agent.transcript_path.clone() else {
        return Ok(Vec::new());
    };
    let Some(dir) = Path::new(&current_path).parent().map(Path::to_path_buf) else {
        return Ok(Vec::new());
    };

    let mut candidates = gather_transcript_candidates(&dir)?;
    candidates.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then(left.path.cmp(&right.path))
    });

    let other = other_agent_transcript_paths(state, agent_id);
    let options = candidates
        .into_iter()
        .take(MAX_TRANSCRIPT_OPTIONS)
        .map(|candidate| {
            let path = candidate.path.display().to_string();
            let (preview, line_count) = read_transcript_meta(&candidate.path);
            TranscriptOption {
                is_active: path == current_path,
                bound_to_other_agent: other.contains(&path),
                modified_ms: candidate
                    .modified
                    .duration_since(UNIX_EPOCH)
                    .map(|since| since.as_millis())
                    .unwrap_or(0),
                session_id: candidate.session_id,
                preview,
                line_count,
                path,
            }
        })
        .collect();

    Ok(options)
}

/// Repoints an agent at `path` and restarts its tail there, or clears the current
/// binding when `path` is `None`. The old tail stops itself once it sees the agent
/// no longer pointing at its file.
pub fn set_agent_transcript(
    state: &AppState,
    agent_id: &str,
    path: Option<&str>,
) -> Result<AgentInfo, String> {
    let Some(mut agent) = state.agent(agent_id)? else {
        return Err(format!("agent {agent_id} not found"));
    };
    let Some(path) = path else {
        agent.session_id = None;
        agent.transcript_path = None;
        state.update_agent(agent.clone())?;
        return Ok(agent);
    };

    let candidate = Path::new(path);
    if candidate
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("jsonl")
    {
        return Err("transcript must be a .jsonl file".to_string());
    }
    if !candidate.is_file() {
        return Err(format!("transcript {path} does not exist"));
    }
    // Keep selection inside the agent's current session directory so a stray path
    // can't repoint the tail outside the project's transcript folder.
    if let Some(current) = agent.transcript_path.as_deref()
        && Path::new(current).parent() != candidate.parent()
    {
        return Err("transcript is outside the agent's session directory".to_string());
    }

    let already_bound = agent.transcript_path.as_deref() == Some(path);
    agent.session_id = session_id_from_transcript_path(candidate);
    agent.transcript_path = Some(path.to_string());
    state.update_agent(agent.clone())?;
    // Clear any recovery/ambiguity notice tied to the previous binding.
    state.emit(transcript_notice(agent_id, path, None));
    if !already_bound {
        start_transcript_tail(
            state.clone(),
            agent_id.to_string(),
            path.to_string(),
            agent.adapter.clone(),
        );
    }

    Ok(agent)
}

/// Reads a transcript's first user-message preview and total line count without
/// holding the file open — best-effort, so an unreadable file yields `(None, 0)`.
fn read_transcript_meta(path: &Path) -> (Option<String>, usize) {
    let Ok(raw) = fs::read_to_string(path) else {
        return (None, 0);
    };
    let mut line_count = 0;
    let mut preview = None;
    for line in raw.lines() {
        line_count += 1;
        if preview.is_some() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let message = value.get("message").unwrap_or(&value);
        let is_user = value.get("type").and_then(Value::as_str) == Some("user")
            || message.get("role").and_then(Value::as_str) == Some("user");
        if !is_user {
            continue;
        }
        if let Some(text) = first_text_block(message.get("content")) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                preview = Some(truncate_preview(trimmed));
            }
        }
    }
    (preview, line_count)
}

/// First textual content of a message: the string itself, or the first text block
/// of a content array. Ignores tool results and other non-text blocks.
fn first_text_block(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => blocks.iter().find_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            }
        }),
        _ => None,
    }
}

fn truncate_preview(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PREVIEW_MAX_CHARS {
        return collapsed;
    }
    let head: String = collapsed.chars().take(PREVIEW_MAX_CHARS).collect();
    format!("{head}…")
}

fn session_id_from_transcript_path(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty() && !stem.starts_with('.'))
        .map(ToString::to_string)
}

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

/// Reports a failure to persist parsed turns (a poisoned state lock or full
/// disk) so the UI can show the timeline is no longer authoritative instead of
/// silently diverging from recovered state.
fn transcript_persist_error(agent_id: &str, path: &str, error: &str) -> QmuxEvent {
    QmuxEvent::new(
        "transcript.error",
        None,
        Some(agent_id.to_string()),
        json!({ "error": error, "path": path }),
    )
}

/// Returns the newline-terminated lines of a transcript snapshot, holding back
/// any trailing bytes after the final '\n'. A transcript record is one JSON
/// object per line ending in '\n', so content past the last newline is a record
/// still being written: parsing it would either be dropped as invalid JSON or,
/// once it completes, differ from the stored partial line and churn a full
/// timeline reset. Deferring it until its newline lands keeps the tail purely
/// append-driven.
fn complete_lines(raw: &str) -> Vec<String> {
    let complete = raw.rfind('\n').map_or("", |idx| &raw[..=idx]);
    complete.lines().map(ToString::to_string).collect()
}

/// Result of an incremental transcript read.
struct TranscriptRead {
    /// File content from the read offset, or the whole file when `reset` is set.
    data: String,
    /// The file is now shorter than the requested offset (truncated or rewritten),
    /// so `data` holds the whole file and the caller must rebuild rather than append.
    reset: bool,
}

/// Reads a transcript incrementally: only the bytes appended past `offset`. When
/// the file has shrunk below `offset` it reads the whole file and flags a reset so
/// the caller rebuilds the timeline. `offset` is always a newline boundary, so a
/// tail read from it is valid UTF-8.
fn read_transcript_from(path: &Path, offset: u64) -> std::io::Result<TranscriptRead> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len < offset {
        let mut data = String::new();
        file.read_to_string(&mut data)?;
        return Ok(TranscriptRead { data, reset: true });
    }
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))?;
    }
    let mut data = String::new();
    file.read_to_string(&mut data)?;
    Ok(TranscriptRead { data, reset: false })
}

/// Byte length of the complete (newline-terminated) prefix of `raw`. Bytes after
/// the final '\n' are an in-progress record and are not counted as consumed, so
/// the next read picks them up once their newline lands.
fn complete_len(raw: &str) -> u64 {
    raw.rfind('\n').map_or(0, |idx| (idx + 1) as u64)
}

/// Whether a tail bound to `bound_path` should keep running. `current` is the
/// agent's freshly looked-up transcript path: `Some(Some(path))` when the agent
/// exists with a path set, `Some(None)` when it exists with none, and `None` when
/// the agent is gone. The tail only continues while the agent is still pointing at
/// the exact file this tail was started for; any rotation or removal stops it.
fn tail_should_continue(current: Option<Option<&str>>, bound_path: &str) -> bool {
    matches!(current, Some(Some(path)) if path == bound_path)
}

/// Whether a failed read should recover onto a sibling transcript. Only a file we
/// have already followed and that has now vanished counts as a rotation worth
/// recovering. A never-seen file is a freshly launched session (e.g. typing
/// `claude` in the terminal) whose transcript hasn't hit disk yet — recovering
/// then would bind us to an unrelated existing session, so we keep waiting for the
/// real file the new session's SessionStart pointed us at.
fn should_recover_missing(err_kind: ErrorKind, have_read_bound_file: bool) -> bool {
    err_kind == ErrorKind::NotFound && have_read_bound_file
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn tail_continues_only_while_bound_to_the_same_path() {
        // Agent still pointing at this tail's file: keep tailing.
        assert!(tail_should_continue(Some(Some("/t/a.jsonl")), "/t/a.jsonl"));
        // Rotated to a new transcript (resume/compact/new session): stop.
        assert!(!tail_should_continue(
            Some(Some("/t/b.jsonl")),
            "/t/a.jsonl"
        ));
        // Path cleared while the agent lives: stop.
        assert!(!tail_should_continue(Some(None), "/t/a.jsonl"));
        // Agent gone entirely: stop.
        assert!(!tail_should_continue(None, "/t/a.jsonl"));
    }

    #[test]
    fn complete_lines_holds_back_an_unterminated_trailing_record() {
        // Fully terminated snapshot: every record is stable.
        assert_eq!(
            complete_lines("{\"a\":1}\n{\"b\":2}\n"),
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
        // A record still being written (no trailing newline) is withheld until
        // its newline lands, so it is never parsed as a partial line.
        assert_eq!(
            complete_lines("{\"a\":1}\n{\"b\":2"),
            vec!["{\"a\":1}".to_string()]
        );
        // Once the newline arrives the previously-partial record becomes stable,
        // appended after the line already seen (no reset churn).
        assert_eq!(
            complete_lines("{\"a\":1}\n{\"b\":2}\n"),
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
        // A snapshot with no complete line yet yields nothing.
        assert!(complete_lines("{\"partial").is_empty());
        assert!(complete_lines("").is_empty());
    }

    #[test]
    fn recovery_waits_for_a_fresh_session_file_to_appear() {
        // A file we followed that then vanished is a rotation: recover to a sibling.
        assert!(should_recover_missing(ErrorKind::NotFound, true));
        // A never-seen file is a fresh session warming up: keep waiting, don't bind
        // to a pre-existing session in the same folder.
        assert!(!should_recover_missing(ErrorKind::NotFound, false));
        // Other read errors (permissions, mid-write races) never trigger recovery.
        assert!(!should_recover_missing(ErrorKind::PermissionDenied, true));
    }

    #[test]
    fn complete_len_counts_only_the_newline_terminated_prefix() {
        assert_eq!(complete_len(""), 0);
        assert_eq!(complete_len("{\"a\":1}"), 0);
        assert_eq!(complete_len("{\"a\":1}\n"), 8);
        assert_eq!(complete_len("{\"a\":1}\n{\"b\":2"), 8);
        assert_eq!(complete_len("{\"a\":1}\n{\"b\":2}\n"), 16);
    }

    #[test]
    fn incremental_read_returns_only_appended_bytes_then_resets_on_shrink() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-read-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        fs::write(&path, "a\nb\n").unwrap();
        let first = read_transcript_from(&path, 0).unwrap();
        assert!(!first.reset);
        assert_eq!(first.data, "a\nb\n");
        let consumed = complete_len(&first.data);
        assert_eq!(consumed, 4);

        // An append is read back as just the new bytes, not the whole file.
        fs::write(&path, "a\nb\nc\n").unwrap();
        let second = read_transcript_from(&path, consumed).unwrap();
        assert!(!second.reset);
        assert_eq!(second.data, "c\n");

        // A file shorter than what we've consumed signals a rebuild from scratch.
        fs::write(&path, "x\n").unwrap();
        let third = read_transcript_from(&path, consumed).unwrap();
        assert!(third.reset);
        assert_eq!(third.data, "x\n");

        fs::remove_dir_all(&dir).ok();
    }

    fn candidate(path: &str, secs: u64, session: &str) -> TranscriptCandidate {
        TranscriptCandidate {
            path: PathBuf::from(path),
            modified: UNIX_EPOCH + Duration::from_secs(secs),
            session_id: Some(session.to_string()),
        }
    }

    #[test]
    fn newest_transcript_candidate_prefers_latest_modified_file() {
        let candidates = vec![
            candidate("/tmp/a.jsonl", 10, "a"),
            candidate("/tmp/b.jsonl", 20, "b"),
        ];

        let selected = select_newest_transcript_candidate(&candidates, &HashSet::new(), "")
            .expect("newest candidate is selected");

        assert_eq!(selected.path, PathBuf::from("/tmp/b.jsonl"));
        assert_eq!(selected.session_id.as_deref(), Some("b"));
    }

    #[test]
    fn selection_skips_the_bound_path_and_other_agents_files() {
        let candidates = vec![
            candidate("/tmp/a.jsonl", 10, "a"),
            candidate("/tmp/b.jsonl", 20, "b"),
            candidate("/tmp/c.jsonl", 30, "c"),
        ];
        // c is newest but owned by another agent; b is the bound (missing) file —
        // so recovery must fall back to a, the newest unclaimed candidate.
        let excluded = HashSet::from(["/tmp/c.jsonl".to_string()]);

        let selected = select_newest_transcript_candidate(&candidates, &excluded, "/tmp/b.jsonl")
            .expect("an unclaimed candidate remains");

        assert_eq!(selected.path, PathBuf::from("/tmp/a.jsonl"));
    }

    #[test]
    fn session_id_comes_from_transcript_filename() {
        assert_eq!(
            session_id_from_transcript_path(Path::new(
                "/Users/raymond/.claude/projects/project/5e675dea.jsonl"
            ))
            .as_deref(),
            Some("5e675dea")
        );
        assert_eq!(
            session_id_from_transcript_path(Path::new("/tmp/.jsonl")),
            None
        );
    }
}
