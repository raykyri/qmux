//! Shared, side-effect-free hook classification for outbox snapshots and desktop
//! reconciliation. Applying an observation must never execute lifecycle actions.
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookObservation {
    SessionStart,
    Running,
    AwaitingPermission,
    AwaitingInput,
    Stop,
    IdlePrompt,
    StopFailure,
    SessionEnd,
}

pub fn hook_payload_is_subagent(payload: &Value) -> bool {
    payload.get("agent_id").is_some() || payload.get("agentId").is_some()
}

pub fn hook_observation(event: &str, payload: &Value) -> Option<HookObservation> {
    use HookObservation::*;
    Some(match event {
        "SessionStart" | "sessionStart" => SessionStart,
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
        | "PermissionDenied" | "ElicitationResult" | "PreCompact" | "PostCompact" => Running,
        "PermissionRequest" | "Notification.permission_prompt" => AwaitingPermission,
        "Elicitation" | "Notification.elicitation_dialog" => AwaitingInput,
        "Notification.idle_prompt" => IdlePrompt,
        "Stop" => Stop,
        "StopFailure" => StopFailure,
        "SessionEnd" => SessionEnd,
        event if event.starts_with("Notification") => {
            if contains(payload, "permission_prompt") {
                AwaitingPermission
            } else if contains(payload, "idle_prompt") {
                IdlePrompt
            } else {
                // Claude's generic notification and elicitation_dialog both
                // require attention, matching normal adapter ingestion.
                AwaitingInput
            }
        }
        _ => return None,
    })
}

fn contains(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(value) => value.contains(needle),
        Value::Array(values) => values.iter().any(|value| contains(value, needle)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(needle) || contains(value, needle)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn blocking_and_resolved_events_share_the_snapshot_vocabulary() {
        for event in [
            "PermissionDenied",
            "ElicitationResult",
            "PostToolUseFailure",
            "PreCompact",
            "PostCompact",
        ] {
            assert_eq!(
                hook_observation(event, &Value::Null),
                Some(HookObservation::Running)
            );
        }
        assert_eq!(
            hook_observation(
                "Notification",
                &json!({"notification_type":"permission_prompt"})
            ),
            Some(HookObservation::AwaitingPermission)
        );
        assert_eq!(
            hook_observation("Notification.idle_prompt", &Value::Null),
            Some(HookObservation::IdlePrompt)
        );
        assert_eq!(
            hook_observation("Elicitation", &Value::Null),
            Some(HookObservation::AwaitingInput)
        );
        assert_eq!(hook_observation("SubagentStop", &Value::Null), None);
    }
}
