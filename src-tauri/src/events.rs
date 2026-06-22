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

    pub fn pty_data(pane_id: String, data: &[u8]) -> Self {
        // Encode the raw PTY bytes as base64 rather than a JSON array of integers.
        // An integer array inflates this hottest-path payload ~4-6x and forces the
        // frontend to rebuild a Uint8Array element by element; a base64 string is
        // compact and decodes in one step (atob) on the other side.
        Self::new(
            "pty.data",
            Some(pane_id),
            None,
            json!({ "dataBase64": base64_encode(data) }),
        )
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

/// Standard base64 (RFC 4648) encoder. Hand-rolled to keep PTY streaming free of
/// an extra dependency; the frontend decodes the result with `atob`.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(ALPHABET[b0 >> 2] as char);
        out.push(ALPHABET[((b0 & 0b11) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((b1 & 0b1111) << 2) | (b2 >> 6)] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[b2 & 0b111111] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_data_payload_encodes_bytes_as_base64() {
        let event = QmuxEvent::pty_data("pane-1".to_string(), &[0xf0, 0x9f]);

        assert_eq!(event.payload, json!({ "dataBase64": "8J8=" }));
    }

    #[test]
    fn base64_encode_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
