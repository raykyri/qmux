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

    pub fn pty_data(pane_id: String, data: String) -> Self {
        Self::new("pty.data", Some(pane_id), None, json!({ "data": data }))
    }

    pub fn pty_exit(pane_id: String, exit_code: Option<i32>) -> Self {
        Self::new(
            "pty.exit",
            Some(pane_id),
            None,
            json!({ "exitCode": exit_code }),
        )
    }
}
