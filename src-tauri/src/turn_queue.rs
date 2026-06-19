use crate::events::QmuxEvent;
use crate::pty::{PaneWriteOptions, write_pane};
use crate::state::{AppState, PaneKind};
use crate::workspace::{AgentInfo, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAgentTurnRequest {
    pub agent_id: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAgentTurnResult {
    pub queued: bool,
    pub pending_turns: usize,
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

    let pane_kind = agent
        .pane_id
        .as_deref()
        .and_then(|pane_id| state.pane(pane_id).ok().flatten())
        .map(|pane| pane.kind);

    if should_queue(agent.status, pane_kind) {
        let pending_turns = state.enqueue_agent_turn(&agent.id, data)?;
        return Ok(SubmitAgentTurnResult {
            queued: true,
            pending_turns,
        });
    }

    send_agent_turn(state, &agent, data)?;
    Ok(SubmitAgentTurnResult {
        queued: false,
        pending_turns: 0,
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
    state.emit(QmuxEvent::new(
        "agent.queued_turn_sent",
        agent.pane_id.clone(),
        Some(agent.id),
        json!({ "pendingTurns": pending_turns }),
    ));
    Ok(true)
}

fn should_queue(status: AgentStatus, pane_kind: Option<PaneKind>) -> bool {
    if matches!(status, AgentStatus::AwaitingInput | AgentStatus::Stopped) {
        return false;
    }

    if matches!(pane_kind, Some(PaneKind::Shell)) {
        return matches!(
            status,
            AgentStatus::Starting | AgentStatus::AwaitingPermission
        );
    }

    matches!(
        status,
        AgentStatus::Starting | AgentStatus::Running | AgentStatus::AwaitingPermission
    )
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
        assert!(!should_queue(AgentStatus::AwaitingInput, None));
        assert!(!should_queue(AgentStatus::Stopped, None));
    }

    #[test]
    fn app_spawned_running_agents_queue_turns() {
        assert!(should_queue(AgentStatus::Running, Some(PaneKind::Agent)));
        assert!(should_queue(AgentStatus::Running, None));
    }

    #[test]
    fn shell_hosted_running_agents_send_immediately() {
        assert!(!should_queue(AgentStatus::Running, Some(PaneKind::Shell)));
        assert!(should_queue(
            AgentStatus::AwaitingPermission,
            Some(PaneKind::Shell)
        ));
    }
}
