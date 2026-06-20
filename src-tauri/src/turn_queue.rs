use crate::adapters::agent_composer_policy;
use crate::events::QmuxEvent;
use crate::pty::{PaneWriteOptions, write_pane};
use crate::state::{AgentSendSource, AppState};
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAgentTurnRequest {
    pub agent_id: String,
    pub data: String,
    pub mode: Option<SubmitAgentTurnMode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAgentTurnResult {
    pub queued: bool,
    pub pending_turns: usize,
    pub queued_turns: Vec<String>,
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
    pub queued_turns: Vec<String>,
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
    pub queued_turns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendNextQueuedAgentTurnResult {
    pub sent: bool,
    pub pending_turns: usize,
    pub queued_turns: Vec<String>,
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

    match request.mode.unwrap_or(SubmitAgentTurnMode::Auto) {
        SubmitAgentTurnMode::Auto => {
            if policy.should_queue(agent.status) {
                return queue_agent_turn(state, &agent, data);
            }
            if !policy.can_send(agent.status) {
                return Err(format!(
                    "agent {} is not accepting turns in its current state",
                    agent.id
                ));
            }
            send_agent_turn(state, &agent, data, AgentSendSource::DirectSend)?;
            let queued_turns = state.list_agent_turn_queue(&agent.id)?;
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
            let queued_turns = state.list_agent_turn_queue(&agent.id)?;
            Ok(SubmitAgentTurnResult {
                queued: false,
                pending_turns: queued_turns.len(),
                queued_turns,
            })
        }
        SubmitAgentTurnMode::Queue => {
            if !policy.should_queue(agent.status) {
                return Err("agent is ready for input; send the turn instead".to_string());
            }
            queue_agent_turn(state, &agent, data)
        }
        SubmitAgentTurnMode::Steer => {
            if !policy.can_steer(agent.status) {
                return Err("agent does not support steering in its current state".to_string());
            }
            send_agent_turn(state, &agent, data, AgentSendSource::Steer)?;
            let queued_turns = state.list_agent_turn_queue(&agent.id)?;
            Ok(SubmitAgentTurnResult {
                queued: false,
                pending_turns: queued_turns.len(),
                queued_turns,
            })
        }
    }
}

pub fn remove_queued_agent_turn(
    state: &AppState,
    request: RemoveQueuedAgentTurnRequest,
) -> Result<RemoveQueuedAgentTurnResult, String> {
    let agent = state
        .agent(&request.agent_id)?
        .ok_or_else(|| format!("agent {} was not found", request.agent_id))?;
    let (removed_turn, queued_turns) = state.remove_agent_turn_queue_item(
        &agent.id,
        request.index,
        request.expected_data.as_deref(),
    )?;
    let pending_turns = queued_turns.len();
    state.emit(QmuxEvent::new(
        "agent.queued_turn_removed",
        agent.pane_id.clone(),
        Some(agent.id),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns.clone() }),
    ));
    Ok(RemoveQueuedAgentTurnResult {
        removed_turn,
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
    let Some((data, pending_turns)) = state.pop_agent_turn(agent_id)? else {
        return Ok(false);
    };
    let agent = match state.agent(agent_id)? {
        Some(agent) => agent,
        None => {
            let _ = state.prepend_agent_turn(agent_id, data);
            return Err(format!("agent {agent_id} was not found"));
        }
    };
    if let Err(err) = send_agent_turn(state, &agent, data.clone(), AgentSendSource::QueuedTurn) {
        let _ = state.prepend_agent_turn(agent_id, data);
        return Err(err);
    }
    let queued_turns = state.list_agent_turn_queue(agent_id)?;
    state.emit(QmuxEvent::new(
        "agent.queued_turn_sent",
        agent.pane_id.clone(),
        Some(agent.id),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns }),
    ));
    Ok(true)
}

pub fn send_next_queued_agent_turn(
    state: &AppState,
    agent_id: &str,
) -> Result<SendNextQueuedAgentTurnResult, String> {
    let sent = drain_agent_turn_queue(state, agent_id)?;
    let queued_turns = state.list_agent_turn_queue(agent_id)?;
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
    let queued_turns = state.list_agent_turn_queue(&agent.id)?;
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
    let mut updated = state
        .agent(&agent.id)?
        .ok_or_else(|| format!("agent {} was not found", agent.id))?;
    updated.status = AgentStatus::Running;
    state.update_agent(updated)?;
    let _ = state.record_agent_send(&agent.id, text, source);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{ComposerPolicy, PermissionAction};
    use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, QmuxConfig};
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
            },
            legacy_claude_binary: None,
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
}
