//! Acknowledged remote hooks. Retries recover observations without replaying
//! lifecycle actions (queued sends, fork release, or research completion).
use crate::adapters::AdapterNotification;
use crate::events::QmuxEvent;
use crate::state::{AppState, RemoteHookHealth};
use crate::workspace::AgentStatus;
use qmux_proto::{HookObservation, hook_observation, hook_payload_is_subagent};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// The remote sender durably marks an event attempted BEFORE sending it. Thus
// even after desktop restart or receipt eviction a retry takes the harmless
// reconciliation path. This cache suppresses redundant observations in-process.
#[derive(Default)]
pub(crate) struct Receipts(HashMap<String, Arc<Mutex<PaneReceipts>>>);
#[derive(Default)]
struct PaneReceipts {
    ids: VecDeque<String>,
    lease: Option<(String, Instant)>,
}
const MAX_RECEIPTS: usize = 512;

fn live_lease(lease: Option<&(String, Instant)>, offered: Option<&str>) -> bool {
    lease.is_some_and(|(value, issued)| {
        offered == Some(value.as_str()) && issued.elapsed() < Duration::from_secs(2)
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Delivery {
    id: String,
    replay: bool,
    latest: bool,
    notification: Value,
    #[serde(default)]
    snapshot: Option<Value>,
    #[serde(default)]
    lease: Option<String>,
}

fn pane_receipts(state: &AppState, pane: &str) -> Result<Arc<Mutex<PaneReceipts>>, String> {
    let mut receipts = state
        .hook_delivery_receipts()
        .lock()
        .map_err(|_| "hook receipt lock poisoned")?;
    if receipts.0.len() >= 1024 {
        receipts
            .0
            .retain(|_, receipts| Arc::strong_count(receipts) > 1);
    }
    Ok(receipts.0.entry(pane.to_string()).or_default().clone())
}

/// A remote clock cannot establish freshness. Issue a desktop-clock lease so
/// an SSH-buffered request arriving after a stall cannot execute old actions.
pub(crate) fn lease(state: &AppState, pane: &str) -> Result<Value, String> {
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let value = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
    pane_receipts(state, pane)?
        .lock()
        .map_err(|_| "hook receipt lock poisoned")?
        .lease = Some((value.clone(), Instant::now()));
    Ok(json!({ "lease": value }))
}

pub(crate) fn deliver(
    state: &AppState,
    pane: &str,
    payload: Value,
    live: impl FnOnce(Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let delivery: Delivery = serde_json::from_value(payload)
        .map_err(|e| format!("invalid hook.deliver payload: {e}"))?;
    if delivery.id.is_empty()
        || delivery.id.len() > 128
        || !delivery
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        return Err("invalid hook delivery id".into());
    }
    let notification: AdapterNotification =
        serde_json::from_value(delivery.notification.clone())
            .map_err(|e| format!("invalid hook notification: {e}"))?;
    let replaced = state.agent_by_pane(pane)?.is_some_and(|agent| {
        notification
            .agent_id
            .as_deref()
            .is_some_and(|id| id != agent.id)
            || notification
                .adapter_id
                .as_deref()
                .is_some_and(|id| id != agent.adapter)
    });
    // Do not allow the reconciliation path to bypass the normal agent scope check.
    if let Some(id) = notification.agent_id.as_deref()
        && let Some(agent) = state.agent(id)?
        && agent.pane_id.as_deref() != Some(pane)
    {
        return Err("control token is not authorized for that agent".into());
    }
    let pane_receipts = pane_receipts(state, pane)?;
    // Serialize retries within a pane without blocking other panes behind a
    // lifecycle handler that starts a queued turn or a fork.
    let mut receipts = pane_receipts
        .lock()
        .map_err(|_| "hook receipt lock poisoned")?;
    let duplicate = receipts.ids.contains(&delivery.id);
    let replay = delivery.replay || !live_lease(receipts.lease.as_ref(), delivery.lease.as_deref());
    if !duplicate {
        receipts.lease = None;
        if replaced {
            // Unlike legacy hook.notify, durable delivery must never reroute a
            // queued event from an exited process onto its replacement.
        } else if replay {
            // Only the end of a backlog describes its current observation.
            if delivery.latest {
                let snapshot = delivery
                    .snapshot
                    .map(serde_json::from_value::<AdapterNotification>)
                    .transpose()
                    .map_err(|e| format!("invalid hook snapshot: {e}"))?;
                let snapshot = snapshot.as_ref().unwrap_or(&notification);
                if snapshot.agent_id != notification.agent_id
                    || snapshot.adapter_id != notification.adapter_id
                {
                    return Err("hook snapshot belongs to another agent".into());
                }
                reconcile(state, pane, snapshot)?;
            }
        } else {
            live(delivery.notification)?;
        }
        receipts.ids.push_back(delivery.id.clone());
        while receipts.ids.len() > MAX_RECEIPTS {
            receipts.ids.pop_front();
        }
    }
    let _ = state.mutate_remote_connection(pane, |connection| {
        connection.hook_health = Some(RemoteHookHealth::Healthy);
        connection.hook_last_delivered_at = Some(crate::state::now_millis());
        connection.hook_error = None;
    });
    Ok(
        json!({ "notified": true, "id": delivery.id, "duplicate": duplicate, "replay": replay, "discarded": replaced }),
    )
}

fn reconcile(
    state: &AppState,
    pane: &str,
    notification: &AdapterNotification,
) -> Result<(), String> {
    let Some(agent) = state.agent_by_pane(pane)? else {
        // A delayed SessionStart cannot resurrect a process that has exited.
        return Ok(());
    };
    if notification
        .agent_id
        .as_deref()
        .is_some_and(|id| id != agent.id)
        || notification
            .adapter_id
            .as_deref()
            .is_some_and(|id| id != agent.adapter)
    {
        // Never apply an old process's backlog to its replacement in this pane.
        return Ok(());
    }
    let session = (!hook_payload_is_subagent(&notification.payload))
        .then(|| {
            ["session_id", "sessionId", "resource_id", "resourceId"]
                .iter()
                .find_map(|key| notification.payload.get(key).and_then(Value::as_str))
                .filter(|id| qmux_cli::transcript_stream::valid_session(id))
        })
        .flatten();
    if session.is_some_and(|session| agent.fork_point.as_deref() == Some(session)) {
        return Ok(());
    }
    let observation = (!hook_payload_is_subagent(&notification.payload))
        .then(|| hook_observation(&notification.event, &notification.payload))
        .flatten();
    // An authoritative Claude task registry also heals dropped SubagentStop
    // hooks. These are state-only mutations; no queued work is released.
    if agent.adapter == "claude"
        && observation == Some(HookObservation::Stop)
        && let Some(tasks) = notification
            .payload
            .get("background_tasks")
            .and_then(Value::as_array)
    {
        let active = tasks.iter().any(|task| {
            task.get("status")
                .and_then(Value::as_str)
                .is_none_or(|status| status.eq_ignore_ascii_case("running"))
        });
        state.set_agent_background_tasks_reported(&agent.id, active)?;
        if !active {
            state.clear_agent_subagents(&agent.id);
        }
    }
    let waiting_on_background = agent.adapter == "claude"
        && (state.agent_has_reported_background_tasks(&agent.id)?
            || state.agent_has_active_subagents(&agent.id)?);
    let status = observed_status(
        &agent.adapter,
        &notification.event,
        &notification.payload,
        observation,
        waiting_on_background,
    );
    if let Some(updated) = state.reconcile_remote_hook(pane, &agent.id, session, status)? {
        state.emit(QmuxEvent::new(
            "agent.updated",
            Some(pane.to_string()),
            Some(agent.id),
            json!({ "agent": updated, "recoveredHook": true }),
        ));
        // The transcript reader bounds remote paths and excludes historical
        // lifecycle markers from automation during catch-up.
        crate::remote_transcript::observe(state, pane, &notification.payload);
    }
    Ok(())
}

fn observed_status(
    adapter: &str,
    event: &str,
    payload: &Value,
    observation: Option<HookObservation>,
    waiting_on_background: bool,
) -> Option<AgentStatus> {
    if event == "UserPromptSubmit"
        && payload
            .get("prompt")
            .or_else(|| payload.get("input"))
            .and_then(Value::as_str)
            .is_some_and(crate::turn_queue::is_shell_escape_turn)
    {
        return None;
    }
    match observation? {
        HookObservation::Running => Some(AgentStatus::Running),
        HookObservation::AwaitingPermission => Some(AgentStatus::AwaitingPermission),
        HookObservation::AwaitingInput => Some(AgentStatus::AwaitingInput),
        // Codex Stop also fires between guardian jobs within a turn. Only
        // transcript completion can settle it.
        HookObservation::Stop if adapter == "codex" => None,
        HookObservation::Stop | HookObservation::IdlePrompt if waiting_on_background => {
            Some(AgentStatus::Running)
        }
        HookObservation::Stop | HookObservation::IdlePrompt | HookObservation::StopFailure => {
            Some(AgentStatus::Done)
        }
        HookObservation::SessionEnd => Some(AgentStatus::Idle),
        HookObservation::SessionStart => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_observations_respect_background_work_and_resolved_prompts() {
        for event in ["Stop", "Notification.idle_prompt"] {
            let observation = hook_observation(event, &Value::Null);
            assert_eq!(
                observed_status("claude", event, &Value::Null, observation, true),
                Some(AgentStatus::Running)
            );
            assert_eq!(
                observed_status("claude", event, &Value::Null, observation, false),
                Some(AgentStatus::Done)
            );
        }
        for event in [
            "PermissionDenied",
            "ElicitationResult",
            "PostToolUseFailure",
        ] {
            assert_eq!(
                observed_status(
                    "claude",
                    event,
                    &Value::Null,
                    hook_observation(event, &Value::Null),
                    false
                ),
                Some(AgentStatus::Running)
            );
        }
        assert_eq!(
            observed_status(
                "codex",
                "Stop",
                &Value::Null,
                Some(HookObservation::Stop),
                false
            ),
            None
        );
        assert_eq!(
            observed_status(
                "claude",
                "UserPromptSubmit",
                &json!({"prompt":"!pwd"}),
                Some(HookObservation::Running),
                false
            ),
            None
        );
    }

    #[test]
    fn desktop_monotonic_lease_rejects_delayed_or_unrelated_requests() {
        let current = ("nonce".to_string(), Instant::now());
        let expired = ("nonce".to_string(), Instant::now() - Duration::from_secs(3));
        assert!(live_lease(Some(&current), Some("nonce")));
        assert!(!live_lease(Some(&expired), Some("nonce")));
        assert!(!live_lease(Some(&current), Some("other")));
        assert!(!live_lease(None, Some("nonce")));
    }
}
