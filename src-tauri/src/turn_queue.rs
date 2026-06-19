use crate::events::QmuxEvent;
use crate::pty::{PaneWriteOptions, write_pane};
use crate::state::AppState;
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

    match request.mode.unwrap_or(SubmitAgentTurnMode::Auto) {
        SubmitAgentTurnMode::Auto => {
            if should_queue(agent.status) {
                return queue_agent_turn(state, &agent, data);
            }
            send_agent_turn(state, &agent, data)?;
            let queued_turns = state.list_agent_turn_queue(&agent.id)?;
            Ok(SubmitAgentTurnResult {
                queued: false,
                pending_turns: queued_turns.len(),
                queued_turns,
            })
        }
        SubmitAgentTurnMode::Send => {
            if should_queue(agent.status) {
                return Err("agent is busy; queue the turn instead".to_string());
            }
            send_agent_turn(state, &agent, data)?;
            let queued_turns = state.list_agent_turn_queue(&agent.id)?;
            Ok(SubmitAgentTurnResult {
                queued: false,
                pending_turns: queued_turns.len(),
                queued_turns,
            })
        }
        SubmitAgentTurnMode::Queue => {
            if !should_queue(agent.status) {
                return Err("agent is ready for input; send the turn instead".to_string());
            }
            queue_agent_turn(state, &agent, data)
        }
        SubmitAgentTurnMode::Steer => {
            // Deliberately skips the busy guard: steering injects the turn into a
            // working agent now rather than queueing it until idle.
            send_agent_turn(state, &agent, data)?;
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
    if let Err(err) = send_agent_turn(state, &agent, data.clone()) {
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

fn should_queue(status: AgentStatus) -> bool {
    !matches!(status, AgentStatus::AwaitingInput | AgentStatus::Stopped)
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

fn send_agent_turn(state: &AppState, agent: &AgentInfo, data: String) -> Result<(), String> {
    let pane_id = agent
        .pane_id
        .clone()
        .ok_or_else(|| format!("agent {} does not have an attached pane", agent.id))?;
    let mut updated = agent.clone();
    updated.status = AgentStatus::Running;
    state.update_agent(updated)?;
    write_pane(
        state,
        PaneWriteOptions {
            pane_id,
            data,
            paste: true,
            submit: true,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_agent_statuses_send_immediately() {
        assert!(!should_queue(AgentStatus::AwaitingInput));
        assert!(!should_queue(AgentStatus::Stopped));
    }

    #[test]
    fn busy_agent_statuses_queue_turns() {
        assert!(should_queue(AgentStatus::Starting));
        assert!(should_queue(AgentStatus::Running));
        assert!(should_queue(AgentStatus::AwaitingPermission));
    }
}
