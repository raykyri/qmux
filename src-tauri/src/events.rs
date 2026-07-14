use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QmuxEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub pane_id: Option<String>,
    pub agent_id: Option<String>,
    pub payload: Value,
    pub timestamp: u128,
}

impl QmuxEvent {
    pub fn new(
        event_type: impl Into<String>,
        pane_id: Option<String>,
        agent_id: Option<String>,
        payload: Value,
    ) -> Self {
        Self {
            event_type: event_type.into(),
            pane_id,
            agent_id,
            payload,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
        }
    }

    pub fn pty_exit(pane_id: String, exit_code: Option<i32>) -> Self {
        Self::new(
            "pty.exit",
            Some(pane_id),
            None,
            json!({ "exitCode": exit_code }),
        )
    }

    pub fn pane_removed(pane_id: String) -> Self {
        Self::new(
            "pane.removed",
            Some(pane_id.clone()),
            None,
            json!({ "paneId": pane_id }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_removed_carries_the_authoritative_pane_id() {
        let event = QmuxEvent::pane_removed("pane-1".to_string());
        assert_eq!(event.event_type, "pane.removed");
        assert_eq!(event.pane_id.as_deref(), Some("pane-1"));
        assert_eq!(event.payload, json!({ "paneId": "pane-1" }));
    }
}
