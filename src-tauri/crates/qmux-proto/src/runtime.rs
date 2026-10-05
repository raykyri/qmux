//! Private desktop/runtime protocol. This is deliberately separate from the
//! pane-scoped agent control protocol. Never inject its credential into a pane.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u32 = 1;
pub const MAX_REQUEST: usize = 4 * 1024 * 1024;
pub const MAX_RESPONSE: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub token: String,
    pub boot: Option<String>,
    pub operation: Operation,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Hello,
    Snapshot,
    Events { after: u64 },
    /// Each client has one outstanding mutation. Reconnect with the same boot,
    /// client id, sequence, and payload to retrieve its result without replay.
    Call { client: String, sequence: u64, method: String, args: Value },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub version: u32,
    pub boot: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}
