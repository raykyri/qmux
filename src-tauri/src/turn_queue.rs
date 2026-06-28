use crate::adapters::agent_composer_policy;
use crate::events::QmuxEvent;
use crate::pty::{PaneWriteOptions, write_pane};
use crate::state::{AgentSendSource, AppState, QueuedTurn};
use crate::workspace::{AgentInfo, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmitAgentTurnMode {
    Auto,
    Send,
    Queue,
    /// Force the turn through to the agent right now, even while it is busy, so
    /// the user can steer a running agent instead of waiting for it to go idle.
    Steer,
}

/// qMux sends leading-`!` text through the agent TUI, but the TUI handles it as a
/// shell escape rather than an agent turn. Those commands may not emit a normal
/// Stop/idle hook after they finish, so they must not enter the running lifecycle.
pub(crate) fn is_shell_escape_turn(text: &str) -> bool {
    text.trim_start().starts_with('!')
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAgentTurnRequest {
    pub agent_id: String,
    pub data: String,
    pub mode: Option<SubmitAgentTurnMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueWaitAgentTurnRequest {
    pub agent_id: String,
    pub data: String,
    pub wait_for_agent_id: String,
    #[serde(default)]
    pub wait_for_pane_id: Option<String>,
    #[serde(default)]
    pub wait_for_label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAgentTurnResult {
    pub queued: bool,
    pub pending_turns: usize,
    pub queued_turns: Vec<QueuedTurn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveQueuedAgentTurnRequest {
    pub agent_id: String,
    pub index: usize,
    pub expected_data: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveQueuedAgentTurnResult {
    pub removed_turn: String,
    pub pending_turns: usize,
    pub queued_turns: Vec<QueuedTurn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderQueuedAgentTurnRequest {
    pub agent_id: String,
    pub from_index: usize,
    pub to_index: usize,
    pub expected_data: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderQueuedAgentTurnResult {
    pub pending_turns: usize,
    pub queued_turns: Vec<QueuedTurn>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendNextQueuedAgentTurnResult {
    pub sent: bool,
    pub pending_turns: usize,
    pub queued_turns: Vec<QueuedTurn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveQueuedAgentTurnRequest {
    pub from_agent_id: String,
    pub to_agent_id: String,
    pub index: usize,
    pub expected_data: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveQueuedAgentTurnResult {
    /// Whether the moved turn was sent to the target immediately (vs. queued).
    pub sent: bool,
    pub source_queued_turns: Vec<QueuedTurn>,
    pub target_queued_turns: Vec<QueuedTurn>,
}

/// Atomically moves a queued turn from one agent to another. The turn is removed
/// from the source first, then handed to the target with normal send-or-queue
/// behavior; if the handoff fails it is rolled back to its original position in the
/// source queue. Because the removal and the add happen in one backend call, a
/// failure can never leave the turn in both queues (the duplication the previous
/// two-call frontend dance risked) nor silently lose it.
pub fn move_queued_agent_turn(
    state: &AppState,
    request: MoveQueuedAgentTurnRequest,
) -> Result<MoveQueuedAgentTurnResult, String> {
    if request.from_agent_id == request.to_agent_id {
        return Err("cannot move a queued turn onto the same agent".to_string());
    }

    let source = state
        .agent(&request.from_agent_id)?
        .ok_or_else(|| format!("agent {} was not found", request.from_agent_id))?;
    let source_id = source.id.clone();
    let source_pane_id = source.pane_id.clone();

    let (removed_turn, source_queued_turns) = state.remove_agent_turn_queue_item(
        &request.from_agent_id,
        request.index,
        request.expected_data.as_deref(),
    )?;
    state.emit(QmuxEvent::new(
        "agent.queued_turn_removed",
        source_pane_id.clone(),
        Some(source_id.clone()),
        json!({
            "pendingTurns": source_queued_turns.len(),
            "queuedTurns": source_queued_turns.clone(),
        }),
    ));

    let submit = submit_agent_turn(
        state,
        SubmitAgentTurnRequest {
            agent_id: request.to_agent_id.clone(),
            // Moving to another agent intentionally resets queue directives
            // (pause-after and wait targets are contextual to the source queue), so
            // hand over just the text.
            data: removed_turn.text.clone(),
            mode: Some(SubmitAgentTurnMode::Auto),
        },
    );
    let target_result = match submit {
        Ok(result) => result,
        Err(err) => {
            // Roll the turn back so the move can't lose it (preserving queue
            // directives). Re-emit the source queue so the UI reflects the restored
            // item.
            let pending =
                state.insert_agent_turn_at(&request.from_agent_id, request.index, removed_turn)?;
            let restored = state.agent_queued_turns(&request.from_agent_id)?;
            state.emit(QmuxEvent::new(
                "agent.turn_queued",
                source_pane_id,
                Some(source_id),
                json!({ "pendingTurns": pending, "queuedTurns": restored }),
            ));
            return Err(err);
        }
    };
    release_waiters_for_agent(state, &request.from_agent_id)?;

    Ok(MoveQueuedAgentTurnResult {
        sent: !target_result.queued,
        source_queued_turns,
        target_queued_turns: target_result.queued_turns,
    })
}

pub fn submit_agent_turn(
    state: &AppState,
    request: SubmitAgentTurnRequest,
) -> Result<SubmitAgentTurnResult, String> {
    let data = request.data.trim().to_string();
    if data.is_empty() {
        return Err("turn text cannot be empty".to_string());
    }

    let agent = state
        .agent(&request.agent_id)?
        .ok_or_else(|| format!("agent {} was not found", request.agent_id))?;

    if matches!(agent.status, AgentStatus::Failed) {
        return Err(format!("agent {} has failed", agent.id));
    }
    let policy = agent_composer_policy(state, &agent)?;
    let has_pending_queue = !state.agent_queued_turns(&agent.id)?.is_empty();

    match request.mode.unwrap_or(SubmitAgentTurnMode::Auto) {
        SubmitAgentTurnMode::Auto => {
            if policy.should_queue(agent.status) || has_pending_queue {
                return queue_agent_turn(state, &agent, data);
            }
            if !policy.can_send(agent.status) {
                return Err(format!(
                    "agent {} is not accepting turns in its current state",
                    agent.id
                ));
            }
            send_agent_turn(state, &agent, data, AgentSendSource::DirectSend)?;
            let queued_turns = state.agent_queued_turns(&agent.id)?;
            Ok(SubmitAgentTurnResult {
                queued: false,
                pending_turns: queued_turns.len(),
                queued_turns,
            })
        }
        SubmitAgentTurnMode::Send => {
            if !policy.can_send(agent.status) {
                return Err("agent is not ready for input; queue the turn instead".to_string());
            }
            send_agent_turn(state, &agent, data, AgentSendSource::DirectSend)?;
            let queued_turns = state.agent_queued_turns(&agent.id)?;
            Ok(SubmitAgentTurnResult {
                queued: false,
                pending_turns: queued_turns.len(),
                queued_turns,
            })
        }
        SubmitAgentTurnMode::Queue => {
            if !policy.should_queue(agent.status) && !has_pending_queue {
                return Err("agent is ready for input; send the turn instead".to_string());
            }
            queue_agent_turn(state, &agent, data)
        }
        SubmitAgentTurnMode::Steer => {
            if !policy.can_steer(agent.status) {
                return Err("agent does not support steering in its current state".to_string());
            }
            send_agent_turn(state, &agent, data, AgentSendSource::Steer)?;
            let queued_turns = state.agent_queued_turns(&agent.id)?;
            Ok(SubmitAgentTurnResult {
                queued: false,
                pending_turns: queued_turns.len(),
                queued_turns,
            })
        }
    }
}

pub fn queue_wait_agent_turn(
    state: &AppState,
    request: QueueWaitAgentTurnRequest,
) -> Result<SubmitAgentTurnResult, String> {
    let data = request.data.trim().to_string();
    if data.is_empty() {
        return Err("turn text cannot be empty".to_string());
    }

    let agent = state
        .agent(&request.agent_id)?
        .ok_or_else(|| format!("agent {} was not found", request.agent_id))?;
    if matches!(agent.status, AgentStatus::Failed) {
        return Err(format!("agent {} has failed", agent.id));
    }

    let pending_turns = state.enqueue_agent_wait_turn_with_target_label(
        &agent.id,
        data,
        &request.wait_for_agent_id,
        request.wait_for_pane_id.as_deref(),
        request.wait_for_label.as_deref(),
    )?;
    let queued_turns = state.agent_queued_turns(&agent.id)?;
    state.emit(QmuxEvent::new(
        "agent.turn_queued",
        agent.pane_id.clone(),
        Some(agent.id.clone()),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns }),
    ));

    let agent = state.agent(&agent.id)?.unwrap_or(agent);
    let policy = agent_composer_policy(state, &agent)?;
    let sent = !agent.paused
        && !state.agent_is_typing(&agent.id)?
        && policy.can_send(agent.status)
        && drain_agent_turn_queue(state, &agent.id)?;
    let queued_turns = state.agent_queued_turns(&agent.id)?;
    Ok(SubmitAgentTurnResult {
        queued: !sent,
        pending_turns: queued_turns.len(),
        queued_turns,
    })
}

pub fn remove_queued_agent_turn(
    state: &AppState,
    request: RemoveQueuedAgentTurnRequest,
) -> Result<RemoveQueuedAgentTurnResult, String> {
    let agent = state
        .agent(&request.agent_id)?
        .ok_or_else(|| format!("agent {} was not found", request.agent_id))?;
    let agent_id = agent.id.clone();
    let (removed_turn, queued_turns) = state.remove_agent_turn_queue_item(
        &agent_id,
        request.index,
        request.expected_data.as_deref(),
    )?;
    let pending_turns = queued_turns.len();
    state.emit(QmuxEvent::new(
        "agent.queued_turn_removed",
        agent.pane_id.clone(),
        Some(agent_id.clone()),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns.clone() }),
    ));
    release_waiters_for_agent(state, &agent_id)?;
    Ok(RemoveQueuedAgentTurnResult {
        removed_turn: removed_turn.text,
        pending_turns,
        queued_turns,
    })
}

pub fn reorder_queued_agent_turn(
    state: &AppState,
    request: ReorderQueuedAgentTurnRequest,
) -> Result<ReorderQueuedAgentTurnResult, String> {
    let agent = state
        .agent(&request.agent_id)?
        .ok_or_else(|| format!("agent {} was not found", request.agent_id))?;
    let queued_turns = state.reorder_agent_turn_queue_item(
        &agent.id,
        request.from_index,
        request.to_index,
        request.expected_data.as_deref(),
    )?;
    let pending_turns = queued_turns.len();
    state.emit(QmuxEvent::new(
        "agent.queued_turn_reordered",
        agent.pane_id.clone(),
        Some(agent.id),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns.clone() }),
    ));
    Ok(ReorderQueuedAgentTurnResult {
        pending_turns,
        queued_turns,
    })
}

pub fn drain_agent_turn_queue(state: &AppState, agent_id: &str) -> Result<bool, String> {
    let Some((turn, pending_turns)) = state.pop_ready_agent_turn(agent_id)? else {
        return Ok(false);
    };
    let agent = match state.agent(agent_id)? {
        Some(agent) => agent,
        None => {
            requeue_after_failed_drain(state, agent_id, turn);
            return Err(format!("agent {agent_id} was not found"));
        }
    };
    if let Err(err) = send_agent_turn(
        state,
        &agent,
        turn.text.clone(),
        AgentSendSource::QueuedTurn,
    ) {
        requeue_after_failed_drain(state, agent_id, turn);
        return Err(err);
    }
    // A pause-after turn arms the pause; it takes effect when this turn finishes
    // (see `advance_after_idle`), not now.
    if turn.pause_after {
        state.mark_agent_pending_pause(agent_id)?;
    }
    let queued_turns = state.agent_queued_turns(agent_id)?;
    state.emit(QmuxEvent::new(
        "agent.queued_turn_sent",
        agent.pane_id.clone(),
        Some(agent.id),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns }),
    ));
    Ok(true)
}

/// What an agent going idle should do next.
pub enum IdleResolution {
    /// A queued turn was sent; the agent is running again.
    Drained,
    /// The just-finished turn requested a pause; the agent is now paused.
    Paused,
    /// Nothing to send (empty queue or already paused); the agent is idle.
    Idle,
}

/// Decides what happens when an agent goes idle: enter paused mode if the turn that
/// just finished requested it, stay idle while paused, otherwise drain the next
/// queued turn. Writes status/paused with field-scoped setters so a concurrent hook
/// update can't clobber them. Shared by the Claude and Codex idle handlers.
pub fn advance_after_idle(state: &AppState, agent_id: &str) -> Result<IdleResolution, String> {
    // Outstanding-send tracking is advisory; clear it best-effort on every idle.
    let _ = state.clear_agent_outstanding_sends(agent_id);

    if state.take_agent_pending_pause(agent_id)? {
        state.set_agent_paused(agent_id, true)?;
        state.set_agent_status(agent_id, AgentStatus::Done)?;
        release_waiters_for_agent(state, agent_id)?;
        return Ok(IdleResolution::Paused);
    }
    if state.agent_is_paused(agent_id)? {
        // Paused: leave the queue intact and don't auto-send.
        state.set_agent_status(agent_id, AgentStatus::Done)?;
        release_waiters_for_agent(state, agent_id)?;
        return Ok(IdleResolution::Idle);
    }
    if state.agent_is_typing(agent_id)? {
        // The user is mid-keystroke: hold the queue so a finishing turn doesn't spam
        // a queued message into what they're typing. Draining resumes when the
        // frontend clears the typing flag (1500ms after the last keystroke).
        state.set_agent_status(agent_id, AgentStatus::Done)?;
        release_waiters_for_agent(state, agent_id)?;
        return Ok(IdleResolution::Idle);
    }

    let drained = drain_agent_turn_queue(state, agent_id)?;
    let status = if drained {
        AgentStatus::Running
    } else {
        AgentStatus::Done
    };
    state.set_agent_status(agent_id, status)?;
    if !drained {
        release_waiters_for_agent(state, agent_id)?;
    }
    Ok(if drained {
        IdleResolution::Drained
    } else {
        IdleResolution::Idle
    })
}

pub fn release_waiters_for_agent(state: &AppState, target_agent_id: &str) -> Result<usize, String> {
    let waiting_agent_ids = state.agents_with_front_wait_for(target_agent_id)?;
    let mut drained_count = 0;

    for source_agent_id in waiting_agent_ids {
        if source_agent_id == target_agent_id {
            continue;
        }
        let Some(source) = state.agent(&source_agent_id)? else {
            continue;
        };
        if source.paused || state.agent_is_typing(&source.id)? {
            continue;
        }
        let policy = agent_composer_policy(state, &source)?;
        if !policy.can_send(source.status) {
            continue;
        }
        match drain_agent_turn_queue(state, &source.id) {
            Ok(true) => {
                drained_count += 1;
                if let Some(updated) = state.agent(&source.id)? {
                    state.emit(QmuxEvent::new(
                        "agent.running",
                        updated.pane_id.clone(),
                        Some(updated.id.clone()),
                        json!({ "agent": updated }),
                    ));
                }
            }
            Ok(false) => {}
            Err(err) => {
                state.emit(QmuxEvent::new(
                    "agent.queue_error",
                    source.pane_id.clone(),
                    Some(source.id.clone()),
                    json!({ "error": err }),
                ));
            }
        }
    }

    Ok(drained_count)
}

/// Clears an agent's paused state. If the agent is in a ready (idle) state, the next
/// queued turn is sent immediately; otherwise normal draining resumes once its
/// current work finishes. Emits so the UI reflects the cleared pause and any send.
pub fn unpause_agent(
    state: &AppState,
    agent_id: &str,
) -> Result<SendNextQueuedAgentTurnResult, String> {
    let agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    let agent = state.set_agent_paused(agent_id, false)?.unwrap_or(agent);

    let policy = agent_composer_policy(state, &agent)?;
    let sent = if policy.can_send(agent.status) {
        drain_agent_turn_queue(state, agent_id)?
    } else {
        false
    };

    let queued_turns = state.agent_queued_turns(agent_id)?;
    state.emit(QmuxEvent::new(
        "agent.unpaused",
        agent.pane_id.clone(),
        Some(agent.id.clone()),
        json!({
            "agent": state.agent(agent_id)?,
            "sent": sent,
            "pendingTurns": queued_turns.len(),
            "queuedTurns": queued_turns.clone(),
        }),
    ));
    Ok(SendNextQueuedAgentTurnResult {
        sent,
        pending_turns: queued_turns.len(),
        queued_turns,
    })
}

/// Marks/clears whether the user is actively typing for an agent. While typing, the
/// idle handler holds the queue. On clear, if the agent is idle (and not paused), the
/// held turn is drained now; otherwise it resumes on the next idle. The frontend sets
/// this on keystrokes and clears it 1500ms after typing stops.
pub fn set_agent_typing(
    state: &AppState,
    agent_id: &str,
    typing: bool,
) -> Result<SendNextQueuedAgentTurnResult, String> {
    state.set_agent_typing(agent_id, typing)?;

    let mut sent = false;
    if !typing {
        // Typing stopped: drain a held turn if the agent is idle and not paused.
        if let Some(agent) = state.agent(agent_id)?
            && !agent.paused
            && agent_composer_policy(state, &agent)?.can_send(agent.status)
        {
            sent = drain_agent_turn_queue(state, agent_id)?;
        }
    }

    let queued_turns = state.agent_queued_turns(agent_id)?;
    Ok(SendNextQueuedAgentTurnResult {
        sent,
        pending_turns: queued_turns.len(),
        queued_turns,
    })
}

pub fn send_next_queued_agent_turn(
    state: &AppState,
    agent_id: &str,
) -> Result<SendNextQueuedAgentTurnResult, String> {
    let sent = drain_agent_turn_queue(state, agent_id)?;
    let queued_turns = state.agent_queued_turns(agent_id)?;
    Ok(SendNextQueuedAgentTurnResult {
        sent,
        pending_turns: queued_turns.len(),
        queued_turns,
    })
}

fn queue_agent_turn(
    state: &AppState,
    agent: &AgentInfo,
    data: String,
) -> Result<SubmitAgentTurnResult, String> {
    let pending_turns = state.enqueue_agent_turn(&agent.id, data)?;
    let queued_turns = state.agent_queued_turns(&agent.id)?;
    state.emit(QmuxEvent::new(
        "agent.turn_queued",
        agent.pane_id.clone(),
        Some(agent.id.clone()),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns }),
    ));
    Ok(SubmitAgentTurnResult {
        queued: true,
        pending_turns,
        queued_turns,
    })
}

/// Restores a just-popped turn to the front of the queue after a drain fails to
/// deliver it. If even the rollback fails the turn is genuinely lost, so log it
/// rather than dropping it silently — the caller already propagates the original
/// send error.
fn requeue_after_failed_drain(state: &AppState, agent_id: &str, turn: QueuedTurn) {
    if let Err(err) = state.prepend_agent_turn(agent_id, turn) {
        eprintln!("qmux: dropped queued turn for agent {agent_id} after failed re-queue: {err}");
    }
}

fn send_agent_turn(
    state: &AppState,
    agent: &AgentInfo,
    data: String,
    source: AgentSendSource,
) -> Result<(), String> {
    let pane_id = agent
        .pane_id
        .clone()
        .ok_or_else(|| format!("agent {} does not have an attached pane", agent.id))?;
    let text = data.clone();
    write_pane(
        state,
        PaneWriteOptions {
            pane_id,
            data,
            paste: true,
            submit: true,
        },
    )?;
    // Field-scoped status write: a full-struct update_agent here would drop the lock
    // between read and write and could clobber a concurrent SessionStart hook's
    // session_id/transcript_path (leaving the session unresumable/unforkable). Only
    // the status changes, so write only the status.
    if !is_shell_escape_turn(&text) {
        state.set_agent_status(&agent.id, AgentStatus::Running)?;
    }
    // Send tracking is advisory (it feeds de-dup/echo suppression), so a failure
    // here must not fail the send the user already sees in the pane — but log it
    // rather than discarding it without a trace.
    if let Err(err) = state.record_agent_send(&agent.id, text, source) {
        eprintln!("qmux: failed to record send for agent {}: {err}", agent.id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{ComposerPolicy, PermissionAction};
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, OpencodeAdapterConfig, QmuxConfig,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_workspace() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-turn-queue-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_state() -> AppState {
        AppState::new(QmuxConfig {
            workspace_root: temp_workspace(),
            socket_path: PathBuf::from("/tmp/qmux-test.sock"),
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
            },
            legacy_claude_binary: None,
            claude_plugin_dir: std::path::PathBuf::new(),
            opencode_plugin_dir: std::path::PathBuf::new(),
        })
    }

    fn sample_agent(status: AgentStatus) -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/work/agent-1".to_string(),
            branch: None,
            pane_id: Some("missing-pane".to_string()),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
            created_at: 1,
        }
    }

    fn claude_policy() -> ComposerPolicy {
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

    #[test]
    fn ready_agent_statuses_send_immediately() {
        let policy = claude_policy();
        assert!(!policy.should_queue(AgentStatus::AwaitingInput));
        assert!(!policy.should_queue(AgentStatus::Done));
        assert!(!policy.should_queue(AgentStatus::Idle));
    }

    #[test]
    fn busy_agent_statuses_queue_turns() {
        let policy = claude_policy();
        assert!(policy.should_queue(AgentStatus::Starting));
        assert!(policy.should_queue(AgentStatus::Running));
        assert!(policy.should_queue(AgentStatus::AwaitingPermission));
    }

    #[test]
    fn steer_statuses_are_policy_owned() {
        let policy = claude_policy();
        assert!(policy.can_steer(AgentStatus::Starting));
        assert!(policy.can_steer(AgentStatus::Running));
        assert!(!policy.can_steer(AgentStatus::AwaitingInput));
    }

    #[test]
    fn shell_escape_turns_are_detected_after_leading_space() {
        assert!(is_shell_escape_turn("!git status"));
        assert!(is_shell_escape_turn("  \n\t!git status"));
        assert!(!is_shell_escape_turn("please run !git status"));
        assert!(!is_shell_escape_turn(""));
    }

    #[test]
    fn failed_direct_send_preserves_agent_status_and_tracking() {
        let state = test_state();
        state
            .insert_agent(sample_agent(AgentStatus::AwaitingInput))
            .unwrap();

        let err = submit_agent_turn(
            &state,
            SubmitAgentTurnRequest {
                agent_id: "agent-1".to_string(),
                data: "hello".to_string(),
                mode: Some(SubmitAgentTurnMode::Send),
            },
        )
        .unwrap_err();

        assert!(err.contains("pane missing-pane was not found"));
        let agent = state.agent("agent-1").unwrap().unwrap();
        assert!(matches!(agent.status, AgentStatus::AwaitingInput));
        assert!(state.outstanding_agent_sends("agent-1").unwrap().is_empty());
    }

    #[test]
    fn failed_queue_drain_reprepends_turn_without_running_status() {
        let state = test_state();
        state.insert_agent(sample_agent(AgentStatus::Done)).unwrap();
        state
            .enqueue_agent_turn("agent-1", "queued turn".to_string())
            .unwrap();

        let err = drain_agent_turn_queue(&state, "agent-1").unwrap_err();

        assert!(err.contains("pane missing-pane was not found"));
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["queued turn".to_string()]
        );
        let agent = state.agent("agent-1").unwrap().unwrap();
        assert!(matches!(agent.status, AgentStatus::Done));
        assert!(state.outstanding_agent_sends("agent-1").unwrap().is_empty());
    }

    #[test]
    fn failed_drain_preserves_the_pause_after_flag() {
        let state = test_state();
        state.insert_agent(sample_agent(AgentStatus::Done)).unwrap();
        state
            .enqueue_agent_turn("agent-1", "queued".to_string())
            .unwrap();
        state
            .set_queued_turn_pause("agent-1", 0, true, Some("queued"))
            .unwrap();

        // The pane is missing, so the send fails and the turn is requeued.
        let err = drain_agent_turn_queue(&state, "agent-1").unwrap_err();
        assert!(err.contains("missing-pane"));

        // The requeued turn keeps its pause-after flag (not reset to false).
        let items = state.agent_queued_turns("agent-1").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "queued");
        assert!(items[0].pause_after);
    }

    fn agent_with_id(id: &str, status: AgentStatus) -> AgentInfo {
        let mut agent = sample_agent(status);
        agent.id = id.to_string();
        agent
    }

    #[test]
    fn move_onto_a_busy_target_relocates_the_turn_without_duplicating() {
        let state = test_state();
        let mut source = agent_with_id("source", AgentStatus::Done);
        source.pane_id = None;
        state.insert_agent(source).unwrap();
        // A busy target queues rather than sends, so no pane write is needed.
        state
            .insert_agent(agent_with_id("target", AgentStatus::Running))
            .unwrap();
        state
            .enqueue_agent_turn("source", "move me".to_string())
            .unwrap();

        let result = move_queued_agent_turn(
            &state,
            MoveQueuedAgentTurnRequest {
                from_agent_id: "source".to_string(),
                to_agent_id: "target".to_string(),
                index: 0,
                expected_data: Some("move me".to_string()),
            },
        )
        .unwrap();

        assert!(!result.sent);
        assert!(state.list_agent_turn_queue("source").unwrap().is_empty());
        assert_eq!(
            state.list_agent_turn_queue("target").unwrap(),
            vec!["move me".to_string()]
        );
    }

    #[test]
    fn failed_move_rolls_the_turn_back_to_the_source() {
        let state = test_state();
        let mut source = agent_with_id("source", AgentStatus::Done);
        source.pane_id = None;
        state.insert_agent(source).unwrap();
        // The target is ready to send but its pane is missing, so the handoff fails.
        state
            .insert_agent(agent_with_id("target", AgentStatus::AwaitingInput))
            .unwrap();
        state
            .enqueue_agent_turn("source", "keep me".to_string())
            .unwrap();

        let err = move_queued_agent_turn(
            &state,
            MoveQueuedAgentTurnRequest {
                from_agent_id: "source".to_string(),
                to_agent_id: "target".to_string(),
                index: 0,
                expected_data: Some("keep me".to_string()),
            },
        )
        .unwrap_err();

        assert!(err.contains("missing-pane"));
        // Restored to the source rather than duplicated into both or lost.
        assert_eq!(
            state.list_agent_turn_queue("source").unwrap(),
            vec!["keep me".to_string()]
        );
        assert!(state.list_agent_turn_queue("target").unwrap().is_empty());
    }

    #[test]
    fn auto_submit_appends_behind_existing_queue_for_ready_agent() {
        let state = test_state();
        state
            .insert_agent(sample_agent(AgentStatus::AwaitingInput))
            .unwrap();
        state
            .enqueue_agent_turn("agent-1", "first queued".to_string())
            .unwrap();

        let result = submit_agent_turn(
            &state,
            SubmitAgentTurnRequest {
                agent_id: "agent-1".to_string(),
                data: "second queued".to_string(),
                mode: Some(SubmitAgentTurnMode::Auto),
            },
        )
        .unwrap();

        assert!(result.queued);
        assert_eq!(result.pending_turns, 2);
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["first queued".to_string(), "second queued".to_string()]
        );
    }

    #[test]
    fn explicit_queue_appends_behind_existing_queue_for_ready_agent() {
        let state = test_state();
        state.insert_agent(sample_agent(AgentStatus::Done)).unwrap();
        state
            .enqueue_agent_turn("agent-1", "first queued".to_string())
            .unwrap();

        let result = submit_agent_turn(
            &state,
            SubmitAgentTurnRequest {
                agent_id: "agent-1".to_string(),
                data: "second queued".to_string(),
                mode: Some(SubmitAgentTurnMode::Queue),
            },
        )
        .unwrap();

        assert!(result.queued);
        assert_eq!(result.pending_turns, 2);
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["first queued".to_string(), "second queued".to_string()]
        );
    }
}
