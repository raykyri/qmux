use crate::adapters::{TranscriptLifecycleEvent, adapter_registry};
use crate::events::QmuxEvent;
use crate::state::{AgentSendSource, AppState};
use crate::turn_queue::{IdleResolution, advance_after_idle};
use crate::workspace::{AgentInfo, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom};
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
        // The first successful read rebuilds the timeline from the whole file rather
        // than appending. Turn ids are `agent-<line index>`, so they collide across a
        // pane's transcripts; binding a new file (e.g. picking a past session) must
        // replace the agent's turns wholesale, or the dedup-by-id on the frontend
        // would keep the previously loaded transcript's turns.
        let mut first_read = true;
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
            if snapshot.reset || first_read {
                // Rebuild from the whole file: either this is the tail's first read of
                // a freshly bound transcript (which must replace any prior timeline), or
                // the file is now shorter than what we'd already consumed (a truncation
                // or in-place rewrite) so our timeline no longer prefixes it.
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
                consumed = snapshot.consumed_bytes;
            } else {
                // Steady state: parse only the complete lines that arrived since the
                // last tick. line_index advances for every complete line (parsed or
                // not) so source indices stay aligned with the file's line numbers.
                for line in complete_lines(&snapshot.data) {
                    let lifecycle_event = adapter.parse_transcript_lifecycle_event(&line);
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
                    if let Some(lifecycle_event) = lifecycle_event {
                        match transcript_lifecycle_agent_event(
                            &state,
                            &agent_id,
                            &transcript_path,
                            lifecycle_event,
                        ) {
                            Ok(Some(event)) => state.emit(event),
                            Ok(None) => {}
                            Err(err) => {
                                state.emit(transcript_persist_error(
                                    &agent_id,
                                    &transcript_path,
                                    &err,
                                ));
                            }
                        }
                    }
                    line_index += 1;
                }
                consumed += snapshot.consumed_bytes;
            }
            first_read = false;

            thread::sleep(Duration::from_millis(350));
        }
    });
}

/// Consecutive failed reads (at 500ms each, ~3s) before the bound transcript file
/// being unreadable is surfaced as an unexpected state rather than a write race.
const READ_FAILURE_NOTICE_THRESHOLD: u32 = 6;

fn transcript_lifecycle_agent_event(
    state: &AppState,
    agent_id: &str,
    transcript_path: &str,
    lifecycle_event: TranscriptLifecycleEvent,
) -> Result<Option<QmuxEvent>, String> {
    let Some(agent) = state.agent(agent_id)? else {
        return Ok(None);
    };
    if !matches!(agent.status, AgentStatus::Starting | AgentStatus::Running) {
        return Ok(None);
    }
    // If a normal Stop/idle hook already drained a queued turn, a late transcript
    // abort marker belongs to the previous turn. Do not drain again while that
    // queued send is still waiting for its prompt-submit echo.
    if state.agent_has_outstanding_send_source(agent_id, AgentSendSource::QueuedTurn)? {
        return Ok(None);
    }

    match advance_after_idle(state, agent_id) {
        Ok(IdleResolution::Drained) => transcript_lifecycle_updated_agent_event(
            state,
            agent_id,
            transcript_path,
            lifecycle_event,
            "agent.running",
        ),
        Ok(IdleResolution::Paused | IdleResolution::Idle) => {
            transcript_lifecycle_updated_agent_event(
                state,
                agent_id,
                transcript_path,
                lifecycle_event,
                "agent.done",
            )
        }
        Err(err) => Ok(Some(QmuxEvent::new(
            "agent.queue_error",
            agent.pane_id,
            Some(agent_id.to_string()),
            json!({
                "error": err,
                "transcriptLifecycleEvent": lifecycle_event.as_str(),
                "transcriptPath": transcript_path,
            }),
        ))),
    }
}

fn transcript_lifecycle_updated_agent_event(
    state: &AppState,
    agent_id: &str,
    transcript_path: &str,
    lifecycle_event: TranscriptLifecycleEvent,
    event_type: &str,
) -> Result<Option<QmuxEvent>, String> {
    let Some(agent) = state.agent(agent_id)? else {
        return Ok(None);
    };
    Ok(Some(QmuxEvent::new(
        event_type,
        agent.pane_id.clone(),
        Some(agent.id.clone()),
        json!({
            "agent": agent,
            "transcriptLifecycleEvent": lifecycle_event.as_str(),
            "transcriptPath": transcript_path,
        }),
    )))
}

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
pub(crate) struct TranscriptCandidate {
    pub(crate) path: PathBuf,
    pub(crate) modified: SystemTime,
    pub(crate) session_id: Option<String>,
}

/// All `*.jsonl` transcript files in `dir`, each paired with its mtime and the
/// session id read from its filename. Shared by auto-recovery and the manual
/// session picker so both reason over the same candidate set.
fn gather_transcript_candidates(dir: &Path) -> Result<Vec<TranscriptCandidate>, String> {
    gather_transcript_candidates_in(dir, false)
}

pub(crate) fn gather_transcript_candidates_recursive(
    dir: &Path,
) -> Result<Vec<TranscriptCandidate>, String> {
    gather_transcript_candidates_in(dir, true)
}

fn gather_transcript_candidates_in(
    dir: &Path,
    recursive: bool,
) -> Result<Vec<TranscriptCandidate>, String> {
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
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            if recursive {
                candidates.extend(gather_transcript_candidates_in(&path, true)?);
            }
            continue;
        }
        if !metadata.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
        {
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

/// Characters of the first usable user message shown as a session preview.
const PREVIEW_MAX_CHARS: usize = 90;
const PREVIEW_USER_MESSAGE_LOOKAHEAD_LIMIT: usize = 5;

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

fn transcript_listing_root(agent: &AgentInfo, current_path: &Path) -> Option<PathBuf> {
    if agent.adapter == "codex" {
        codex_sessions_root(current_path)
    } else {
        current_path.parent().map(Path::to_path_buf)
    }
}

fn codex_sessions_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| ancestor.file_name().and_then(|name| name.to_str()) == Some("sessions"))
        .map(Path::to_path_buf)
}

fn transcript_session_id(
    agent: &AgentInfo,
    path: &Path,
    fallback: Option<String>,
) -> Option<String> {
    if agent.adapter == "codex" {
        return codex_transcript_session_id(path).or(fallback);
    }
    fallback
}

pub(crate) fn codex_transcript_session_id(path: &Path) -> Option<String> {
    read_codex_transcript_session_id(path).ok().flatten()
}

pub(crate) fn read_codex_transcript_session_id(path: &Path) -> Result<Option<String>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("failed to open Codex transcript {}: {err}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    let bytes = reader
        .read_line(&mut first)
        .map_err(|err| format!("failed to read Codex transcript {}: {err}", path.display()))?;
    if bytes == 0 {
        return Ok(None);
    }

    let terminated = first.ends_with('\n');
    let first = first.trim_end_matches(['\n', '\r']);
    let value = match serde_json::from_str::<Value>(first) {
        Ok(value) => value,
        Err(_) if !terminated => return Ok(None),
        Err(err) => {
            return Err(format!(
                "Codex transcript {} does not start with valid JSON: {err}",
                path.display()
            ));
        }
    };
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err(format!(
            "Codex transcript {} does not start with session_meta",
            path.display()
        ));
    }
    Ok(value
        .get("payload")
        .and_then(|payload| string_field(payload, "id")))
}

/// The working directory recorded in a Codex rollout's leading `session_meta`
/// line. Codex stores every project's sessions in one global tree (unlike Claude's
/// per-project session directories), so this is how the picker scopes its listing
/// to the current session's project. Best-effort: an unreadable file, an empty
/// file, or a first line that isn't a `session_meta` with a `cwd` yields `None`.
pub(crate) fn codex_transcript_cwd(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    if reader.read_line(&mut first).ok()? == 0 {
        return None;
    }
    let first = first.trim_end_matches(['\n', '\r']);
    let value = serde_json::from_str::<Value>(first).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    value
        .get("payload")
        .and_then(|payload| string_field(payload, "cwd"))
}

pub(crate) fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
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
    // The opencode adapter writes transcript JSONL to a qmux-managed file, not
    // to a session directory with multiple selectable past sessions. Skip the
    // picker for opencode agents (MVP).
    if agent.adapter == "opencode" {
        return Ok(Vec::new());
    }
    let Some(current_path) = agent.transcript_path.clone() else {
        return Ok(Vec::new());
    };
    let current = Path::new(&current_path);
    let Some(dir) = transcript_listing_root(&agent, current) else {
        return Ok(Vec::new());
    };

    let mut candidates = if agent.adapter == "codex" {
        let mut candidates = gather_transcript_candidates_recursive(&dir)?;
        // Codex keeps every project's rollouts in one global `sessions` tree, so the
        // recursive scan above sees sessions from unrelated directories. Scope the
        // picker to the project the current session ran in — its `session_meta` cwd —
        // so it lists only same-project sessions, matching Claude's naturally
        // per-project listing. If the active rollout's cwd can't be read, fall back to
        // the unfiltered list rather than hiding everything.
        if let Some(project_cwd) = codex_transcript_cwd(current) {
            candidates.retain(|candidate| {
                candidate.path.as_path() == current
                    || codex_transcript_cwd(&candidate.path).as_deref()
                        == Some(project_cwd.as_str())
            });
        }
        candidates
    } else {
        gather_transcript_candidates(&dir)?
    };
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
                session_id: transcript_session_id(&agent, &candidate.path, candidate.session_id),
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
    // Confinement needs a reference directory. A repoint is only ever offered by
    // the session picker, which scans the directory of the agent's *current*
    // transcript (`transcript_listing_root`) — so with no current transcript
    // there is no legitimate source directory. Refuse instead of binding an
    // arbitrary `.jsonl`: otherwise a caller (e.g. a compromised webview) could
    // `set_agent_transcript(id, null)` to clear the binding and then bind any
    // `.jsonl` on disk, turning this into an unconfined transcript-read
    // primitive over sessions from unrelated projects. qmux discovers the
    // initial transcript itself via the adapter's SessionStart hook.
    let Some(current) = agent.transcript_path.as_deref() else {
        return Err(
            "cannot repoint a transcript before this agent has an active one".to_string(),
        );
    };
    let current = Path::new(current);
    if agent.adapter == "codex" {
        let Some(root) = codex_sessions_root(current) else {
            return Err("transcript is outside the agent's session directory".to_string());
        };
        let root = root.canonicalize().map_err(|err| {
            format!(
                "failed to resolve transcript session directory {}: {err}",
                root.display()
            )
        })?;
        let candidate_root = candidate
            .canonicalize()
            .map_err(|err| format!("failed to resolve transcript {path}: {err}"))?;
        if !candidate_root.starts_with(root) {
            return Err("transcript is outside the agent's session directory".to_string());
        }
        // Mirror the picker's project scoping: a Codex rollout from a different
        // project (a different `session_meta` cwd) must not be bound here, even
        // though it shares the global sessions root. Lenient when either cwd can't
        // be read, so an unparseable rollout still binds rather than hard-failing.
        if let Some(project_cwd) = codex_transcript_cwd(current)
            && let Some(candidate_cwd) = codex_transcript_cwd(candidate)
            && project_cwd != candidate_cwd
        {
            return Err("transcript belongs to a different project".to_string());
        }
    } else if current.parent() != candidate.parent() {
        return Err("transcript is outside the agent's session directory".to_string());
    }

    let already_bound = agent.transcript_path.as_deref() == Some(path);
    agent.session_id = transcript_session_id(
        &agent,
        candidate,
        session_id_from_transcript_path(candidate),
    );
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

/// Reads a transcript's first usable user-message preview and total line count
/// without holding the file open — best-effort, so an unreadable file yields
/// `(None, 0)`.
pub(crate) fn read_transcript_meta(path: &Path) -> (Option<String>, usize) {
    let Ok(raw) = fs::read_to_string(path) else {
        return (None, 0);
    };
    let mut line_count = 0;
    let mut preview = None;
    let mut user_messages_seen = 0;
    for line in raw.lines() {
        line_count += 1;
        if preview.is_some() || user_messages_seen >= PREVIEW_USER_MESSAGE_LOOKAHEAD_LIMIT {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let message = transcript_message_value(&value);
        let is_user = value.get("type").and_then(Value::as_str) == Some("user")
            || message
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("user");
        if !is_user {
            continue;
        }
        if let Some(text) = first_text_block(message.and_then(|message| message.get("content"))) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                user_messages_seen += 1;
                if !is_tagged_user_instruction(&text) {
                    preview = Some(truncate_preview(trimmed));
                }
            }
        }
    }
    (preview, line_count)
}

fn transcript_message_value(value: &Value) -> Option<&Value> {
    if value.get("type").and_then(Value::as_str) == Some("response_item") {
        return value
            .get("payload")
            .filter(|payload| payload.get("type").and_then(Value::as_str) == Some("message"));
    }
    Some(value.get("message").unwrap_or(value))
}

/// First textual content of a message: the string itself, or the first text block
/// of a content array. Ignores tool results and other non-text blocks.
fn first_text_block(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            blocks
                .iter()
                .find_map(|block| match block.get("type").and_then(Value::as_str) {
                    Some("text" | "input_text" | "output_text") => block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    _ => None,
                })
        }
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

fn is_tagged_user_instruction(text: &str) -> bool {
    let Some(content_start) = tagged_instruction_content_start(text) else {
        return false;
    };

    if is_inline_tagged_instruction_sequence(&text[content_start..]) {
        return true;
    }

    let content = &text[content_start..];
    let Some(first_line_end) = content.find('\n') else {
        return false;
    };
    let first_line =
        trim_horizontal_whitespace(strip_trailing_carriage_return(&content[..first_line_end]));
    let last_line_start = text.rfind('\n').map(|index| index + 1).unwrap_or(0);
    let last_line =
        trim_horizontal_whitespace(strip_trailing_carriage_return(&text[last_line_start..]));
    let Some(opening_tag) = parse_opening_tag(first_line) else {
        return false;
    };
    parse_closing_tag(last_line) == Some(opening_tag)
}

fn is_inline_tagged_instruction_sequence(text: &str) -> bool {
    let mut saw_tag = false;
    for raw_line in text.split('\n') {
        let line = trim_horizontal_whitespace(strip_trailing_carriage_return(raw_line));
        if line.is_empty() {
            continue;
        }
        if parse_inline_tag(line).is_none() {
            return false;
        }
        saw_tag = true;
    }
    saw_tag
}

fn tagged_instruction_content_start(text: &str) -> Option<usize> {
    let mut start = 0;
    while start < text.len() {
        let line_end = text[start..]
            .find('\n')
            .map(|index| start + index)
            .unwrap_or(text.len());
        let line = strip_trailing_carriage_return(&text[start..line_end]);
        if !is_tagged_instruction_prefix_line(line) {
            return Some(start);
        }
        if line_end == text.len() {
            return None;
        }
        start = line_end + 1;
    }
    None
}

fn is_tagged_instruction_prefix_line(line: &str) -> bool {
    line.starts_with("# ") || trim_horizontal_whitespace(line).is_empty()
}

fn strip_trailing_carriage_return(value: &str) -> &str {
    value.strip_suffix('\r').unwrap_or(value)
}

fn trim_horizontal_whitespace(value: &str) -> &str {
    value.trim_matches(|char: char| char != '\n' && char != '\r' && char.is_whitespace())
}

fn parse_inline_tag(line: &str) -> Option<&str> {
    if line.len() < 7 || !line.starts_with('<') {
        return None;
    }
    let opening_end = line.find('>')?;
    if opening_end < 2 {
        return None;
    }
    let tag = &line[1..opening_end];
    if !is_instruction_tag_name(tag) {
        return None;
    }
    let closing = format!("</{tag}>");
    line.ends_with(&closing).then_some(tag)
}

fn parse_opening_tag(line: &str) -> Option<&str> {
    if line.len() < 3 || !line.starts_with('<') || !line.ends_with('>') {
        return None;
    }
    let tag = &line[1..line.len() - 1];
    is_instruction_tag_name(tag).then_some(tag)
}

fn parse_closing_tag(line: &str) -> Option<&str> {
    if line.len() < 4 || !line.starts_with("</") || !line.ends_with('>') {
        return None;
    }
    let tag = &line[2..line.len() - 1];
    is_instruction_tag_name(tag).then_some(tag)
}

fn is_instruction_tag_name(tag: &str) -> bool {
    !tag.is_empty()
        && tag
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '-')
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
    /// Raw file bytes covered by `data`: the byte length of the newline-terminated
    /// prefix that was read. The tail offset must advance by this, not by
    /// `data.len()` — `from_utf8_lossy` can make `data` *longer* than the bytes read
    /// when a complete line contains an invalid byte (each becomes a 3-byte U+FFFD),
    /// and measuring the decoded string would overshoot the real file position and
    /// wedge the tail into a perpetual reset.
    consumed_bytes: u64,
    /// The file is now shorter than the requested offset (truncated or rewritten),
    /// so `data` holds the whole file and the caller must rebuild rather than append.
    reset: bool,
}

/// Reads a transcript incrementally: only the bytes appended past `offset`. When
/// the file has shrunk below `offset` it reads the whole file and flags a reset so
/// the caller rebuilds the timeline. `offset` is always a newline boundary, so the
/// read starts on a valid-UTF-8 boundary; the *end* may land mid-record, so the read
/// holds back any unterminated trailing bytes (see `read_complete_lines_utf8`).
fn read_transcript_from(path: &Path, offset: u64) -> std::io::Result<TranscriptRead> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    // A shrink below `offset` is an obvious truncation/rewrite. An in-place rewrite to
    // the same-or-greater length is subtler: `offset` is always a newline boundary, so
    // if the byte just before it is no longer '\n', the bytes up to `offset` changed and
    // appending from here would splice new content onto a stale timeline. Rebuild in
    // both cases. (This catches the common rewrite where line boundaries shift; a rewrite
    // that happens to keep a newline at exactly `offset - 1` still reads as an append.)
    let rewritten_in_place =
        offset > 0 && len >= offset && !byte_before_is_newline(&mut file, offset)?;
    if len < offset || rewritten_in_place {
        file.seek(SeekFrom::Start(0))?;
        let (data, consumed_bytes) = read_complete_lines_utf8(&mut file)?;
        return Ok(TranscriptRead {
            data,
            consumed_bytes,
            reset: true,
        });
    }
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))?;
    }
    let (data, consumed_bytes) = read_complete_lines_utf8(&mut file)?;
    Ok(TranscriptRead {
        data,
        consumed_bytes,
        reset: false,
    })
}

/// Reads the single byte at `offset - 1` to check the tail offset still lands just
/// after a newline. Caller guarantees `0 < offset <= len`, so the byte exists.
fn byte_before_is_newline(file: &mut fs::File, offset: u64) -> std::io::Result<bool> {
    file.seek(SeekFrom::Start(offset - 1))?;
    let mut byte = [0u8; 1];
    file.read_exact(&mut byte)?;
    Ok(byte[0] == b'\n')
}

/// Reads from the file's current position to EOF and returns the longest prefix that
/// ends on a newline, decoded as UTF-8. A transcript is appended one JSON line at a
/// time, so the bytes after the final '\n' are an in-progress record that may end in
/// the middle of a multi-byte UTF-8 character. `read_to_string` would reject the whole
/// read as invalid UTF-8 — surfacing a spurious "Transcript unavailable" until the
/// character completes — so instead we cut at the last newline (the unterminated tail
/// is what `complete_lines` discards anyway). Returns the decoded prefix together with
/// its raw byte length (`cut`): a complete line can still hold an invalid byte mid-way,
/// which `from_utf8_lossy` expands to a 3-byte U+FFFD, so the decoded string's length is
/// not a reliable file offset — the caller must advance by the raw byte count.
fn read_complete_lines_utf8(file: &mut fs::File) -> std::io::Result<(String, u64)> {
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let cut = bytes
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map_or(0, |idx| idx + 1);
    Ok((String::from_utf8_lossy(&bytes[..cut]).into_owned(), cut as u64))
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
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
        OpencodeAdapterConfig, QmuxConfig,
    };
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
    fn read_reports_only_the_newline_terminated_prefix_as_consumed() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-consumed-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        // Two complete records plus an unterminated third: only the newline-terminated
        // prefix counts as consumed, so the partial tail is picked up on a later read.
        fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"c\":3").unwrap();
        let read = read_transcript_from(&path, 0).unwrap();
        assert_eq!(read.data, "{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(read.consumed_bytes, 16);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn transcript_lifecycle_interruption_marks_running_agent_done() {
        let state = test_state();
        state
            .insert_agent(sample_agent(AgentStatus::Running))
            .unwrap();

        let event = transcript_lifecycle_agent_event(
            &state,
            "agent-1",
            "/tmp/session.jsonl",
            TranscriptLifecycleEvent::Interrupted,
        )
        .unwrap()
        .expect("interruption should emit an agent event");

        assert_eq!(event.event_type, "agent.done");
        assert_eq!(event.payload["transcriptLifecycleEvent"], "interrupted");
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Done));
    }

    #[test]
    fn transcript_lifecycle_interruption_ignores_non_working_agent() {
        let state = test_state();
        state.insert_agent(sample_agent(AgentStatus::Done)).unwrap();

        let event = transcript_lifecycle_agent_event(
            &state,
            "agent-1",
            "/tmp/session.jsonl",
            TranscriptLifecycleEvent::Interrupted,
        )
        .unwrap();

        assert!(event.is_none());
    }

    #[test]
    fn transcript_lifecycle_interruption_does_not_double_drain_queued_send() {
        let state = test_state();
        state
            .insert_agent(sample_agent(AgentStatus::Running))
            .unwrap();
        state
            .record_agent_send(
                "agent-1",
                "already drained".to_string(),
                AgentSendSource::QueuedTurn,
            )
            .unwrap();

        let event = transcript_lifecycle_agent_event(
            &state,
            "agent-1",
            "/tmp/session.jsonl",
            TranscriptLifecycleEvent::Interrupted,
        )
        .unwrap();

        assert!(event.is_none());
        let agent = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(agent.status, AgentStatus::Running));
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
        let consumed = first.consumed_bytes;
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

    #[test]
    fn incremental_read_holds_back_a_partial_multibyte_tail_without_erroring() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-utf8-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        // A complete record, then the first byte of '€' (E2 82 AC) with no terminating
        // newline: the next record is mid-write and the read ends mid-character.
        let mut bytes = b"{\"a\":1}\n".to_vec();
        bytes.push(0xE2);
        fs::write(&path, &bytes).unwrap();

        // read_to_string would fail with InvalidData here (a spurious read failure);
        // instead the read succeeds and defers the unterminated partial record.
        let read = read_transcript_from(&path, 0).unwrap();
        assert!(!read.reset);
        assert_eq!(read.data, "{\"a\":1}\n");
        assert_eq!(read.consumed_bytes, 8);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn incremental_read_advances_by_raw_bytes_over_an_invalid_utf8_line() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-badutf8-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        // A COMPLETE (newline-terminated) line with a lone invalid byte mid-way.
        // from_utf8_lossy expands 0xFF to a 3-byte U+FFFD, so the decoded string is
        // longer than the file; measuring it would overshoot and wedge the tail into
        // a perpetual reset (len < offset every tick). The offset must track raw bytes.
        let mut bytes = b"caf".to_vec();
        bytes.push(0xFF);
        bytes.push(b'\n');
        let raw_len = bytes.len() as u64;
        fs::write(&path, &bytes).unwrap();

        let read = read_transcript_from(&path, 0).unwrap();
        assert!(!read.reset);
        // Decoded string is longer than the bytes on disk...
        assert!(read.data.len() as u64 > raw_len);
        // ...but the consumed offset is the raw byte count, so a follow-up read from it
        // sees EOF (len == offset), not a spurious reset (len < offset).
        assert_eq!(read.consumed_bytes, raw_len);
        let next = read_transcript_from(&path, read.consumed_bytes).unwrap();
        assert!(!next.reset);
        assert_eq!(next.data, "");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_resets_when_an_in_place_rewrite_moves_the_last_newline() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-rewrite-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        fs::write(&path, "aa\nbb\n").unwrap(); // 6 bytes, trailing newline at offset 5
        let first = read_transcript_from(&path, 0).unwrap();
        assert!(!first.reset);
        assert_eq!(first.consumed_bytes, 6);

        // Rewritten in place to the same length, but the byte before offset 6 is no
        // longer '\n' — the content up to the offset changed. Appending would splice new
        // bytes onto a stale timeline, so this must be detected as a reset and rebuilt.
        fs::write(&path, "wxyz\nQ").unwrap(); // 6 bytes, newline now at offset 4
        let second = read_transcript_from(&path, first.consumed_bytes).unwrap();
        assert!(second.reset);
        assert_eq!(second.data, "wxyz\n");

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
    fn truncate_preview_collapses_whitespace_and_caps_length() {
        assert_eq!(truncate_preview("  hello   world \n"), "hello world");
        let long = "x ".repeat(120);
        let preview = truncate_preview(&long);
        assert!(preview.ends_with('…'));
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS + 1);
    }

    #[test]
    fn read_transcript_meta_extracts_first_user_message_and_line_count() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-meta-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first prompt\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"reply\"}}\n",
            ),
        )
        .unwrap();

        let (preview, line_count) = read_transcript_meta(&path);
        assert_eq!(preview.as_deref(), Some("first prompt"));
        assert_eq!(line_count, 2);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_transcript_meta_extracts_codex_user_message() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-codex-meta-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-2026-06-21T20-08-03-019eeca7.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"019eeca7\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"codex prompt\"}]}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"duplicate\"}}\n",
            ),
        )
        .unwrap();

        let (preview, line_count) = read_transcript_meta(&path);
        assert_eq!(preview.as_deref(), Some("codex prompt"));
        assert_eq!(line_count, 3);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_transcript_meta_skips_tagged_instruction_previews() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-tagged-meta-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<context>ignore</context>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"# comment\\n<instructions>ignore</instructions>\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"reply\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"real prompt\"}}\n",
            ),
        )
        .unwrap();

        let (preview, line_count) = read_transcript_meta(&path);
        assert_eq!(preview.as_deref(), Some("real prompt"));
        assert_eq!(line_count, 4);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_transcript_meta_stops_preview_scan_after_five_user_messages() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-preview-limit-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<one>ignore</one>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<two>ignore</two>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<three>ignore</three>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<four>ignore</four>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<five>ignore</five>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"sixth prompt\"}}\n",
            ),
        )
        .unwrap();

        let (preview, line_count) = read_transcript_meta(&path);
        assert_eq!(preview, None);
        assert_eq!(line_count, 6);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_transcript_cwd_reads_session_meta_cwd() {
        let dir = std::env::temp_dir().join(format!(
            "qmux-transcript-codex-cwd-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();

        // A well-formed rollout exposes its project directory from session_meta.
        let with_cwd = dir.join("rollout-with-cwd.jsonl");
        fs::write(
            &with_cwd,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"abc\",\"cwd\":\"/work/project\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            codex_transcript_cwd(&with_cwd).as_deref(),
            Some("/work/project")
        );

        // A first line that isn't a session_meta, or one without a cwd, yields None
        // (so the picker falls back to listing rather than hiding everything).
        let without_meta = dir.join("rollout-no-meta.jsonl");
        fs::write(&without_meta, "{\"type\":\"response_item\"}\n").unwrap();
        assert_eq!(codex_transcript_cwd(&without_meta), None);

        let empty = dir.join("rollout-empty.jsonl");
        fs::write(&empty, "").unwrap();
        assert_eq!(codex_transcript_cwd(&empty), None);

        assert_eq!(codex_transcript_cwd(&dir.join("missing.jsonl")), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_sessions_root_finds_date_sharded_parent() {
        let path = Path::new(
            "/Users/raymond/.codex/sessions/2026/06/21/rollout-2026-06-21T20-08-03-id.jsonl",
        );

        assert_eq!(
            codex_sessions_root(path).as_deref(),
            Some(Path::new("/Users/raymond/.codex/sessions"))
        );
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

    fn test_state() -> AppState {
        AppState::new(QmuxConfig {
            workspace_root: temp_dir(),
            socket_path: PathBuf::from("/tmp/qmux-transcript-test.sock"),
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

    fn sample_agent(status: AgentStatus) -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/qmux-transcript-test".to_string(),
            branch: None,
            pane_id: Some("pane-1".to_string()),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: Some("/tmp/session.jsonl".to_string()),
            status,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
            created_at: 1,
        }
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "qmux-transcript-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ))
    }
}
