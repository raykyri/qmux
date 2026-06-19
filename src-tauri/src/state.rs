use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::transcript::Turn;
use crate::workspace::{AgentInfo, GroupInfo};
use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
pub type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    config: QmuxConfig,
    pane_tokens: Mutex<HashMap<String, String>>,
    model: Mutex<Model>,
    transcript_tails: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    app_handle: Mutex<Option<AppHandle>>,
}

#[derive(Default)]
struct Model {
    panes: HashMap<String, PaneRuntime>,
    groups: HashMap<String, GroupInfo>,
    agents: HashMap<String, AgentInfo>,
    turns: HashMap<String, Vec<Turn>>,
    agent_turn_queues: HashMap<String, VecDeque<String>>,
}

pub struct PaneRuntime {
    pub info: PaneInfo,
    pub child: SharedChild,
    pub master: SharedMaster,
    pub writer: SharedWriter,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub id: String,
    pub title: String,
    pub kind: PaneKind,
    pub agent_id: Option<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: PaneStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneKind {
    Shell,
    Agent,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneStatus {
    Starting,
    Running,
    Exited,
    Killed,
    Failed,
}

impl AppState {
    pub fn new(config: QmuxConfig) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                config,
                pane_tokens: Mutex::new(HashMap::new()),
                model: Mutex::new(Model::default()),
                transcript_tails: Mutex::new(HashSet::new()),
                next_id: AtomicU64::new(1),
                app_handle: Mutex::new(None),
            }),
        }
    }

    pub fn config(&self) -> &QmuxConfig {
        &self.inner.config
    }

    /// Returns the control-socket token scoped to a single pane, minting one on first
    /// use. Each pane gets its own unguessable token so a process running in one pane
    /// cannot drive another pane (or the control plane) through the socket.
    pub fn pane_token(&self, pane_id: &str) -> String {
        let mut tokens = self
            .inner
            .pane_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        tokens
            .entry(pane_id.to_string())
            .or_insert_with(random_token)
            .clone()
    }

    /// Resolves the pane a presented control token is authorized for, if any.
    pub fn pane_for_token(&self, token: &str) -> Option<String> {
        let tokens = self
            .inner
            .pane_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        tokens
            .iter()
            .find_map(|(pane_id, pane_token)| (pane_token == token).then(|| pane_id.clone()))
    }

    pub fn attach_app(&self, app_handle: AppHandle) -> Result<(), String> {
        let mut handle = self
            .inner
            .app_handle
            .lock()
            .map_err(|_| "app handle lock poisoned".to_string())?;
        *handle = Some(app_handle);
        Ok(())
    }

    pub fn next_id(&self, prefix: &str) -> String {
        let seq = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        format!("{prefix}-{millis}-{seq}")
    }

    pub fn emit(&self, event: QmuxEvent) {
        if let Ok(handle) = self.inner.app_handle.lock() {
            if let Some(app_handle) = handle.as_ref() {
                let _ = app_handle.emit("qmux-event", event);
            }
        }
    }

    pub fn list_panes(&self) -> Result<Vec<PaneInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.values().map(|pane| pane.info.clone()).collect())
    }

    pub fn list_groups(&self) -> Result<Vec<GroupInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.groups.values().cloned().collect())
    }

    pub fn list_agents(&self) -> Result<Vec<AgentInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agents.values().cloned().collect())
    }

    pub fn list_turns(&self, agent_id: Option<&str>) -> Result<Vec<Turn>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if let Some(agent_id) = agent_id {
            Ok(model.turns.get(agent_id).cloned().unwrap_or_default())
        } else {
            Ok(model
                .turns
                .values()
                .flat_map(|turns| turns.iter().cloned())
                .collect())
        }
    }

    pub fn group(&self, group_id: &str) -> Result<Option<GroupInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.groups.get(group_id).cloned())
    }

    pub fn agent(&self, agent_id: &str) -> Result<Option<AgentInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agents.get(agent_id).cloned())
    }

    pub fn agent_by_pane(&self, pane_id: &str) -> Result<Option<AgentInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agents
            .values()
            .find(|agent| agent.pane_id.as_deref() == Some(pane_id))
            .cloned())
    }

    pub fn insert_pane(&self, pane: PaneRuntime) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.panes.insert(pane.info.id.clone(), pane);
        Ok(())
    }

    pub fn insert_group(&self, group: GroupInfo) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.groups.insert(group.id.clone(), group);
        Ok(())
    }

    pub fn insert_agent(&self, agent: AgentInfo) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.agents.insert(agent.id.clone(), agent);
        Ok(())
    }

    pub fn update_group(&self, group: GroupInfo) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.groups.insert(group.id.clone(), group);
        Ok(())
    }

    pub fn update_agent(&self, agent: AgentInfo) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.agents.insert(agent.id.clone(), agent);
        Ok(())
    }

    pub fn append_turn(&self, turn: Turn) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model
            .turns
            .entry(turn.agent_id.clone())
            .or_default()
            .push(turn);
        Ok(())
    }

    pub fn replace_turns(&self, agent_id: &str, turns: Vec<Turn>) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.turns.insert(agent_id.to_string(), turns);
        Ok(())
    }

    pub fn enqueue_agent_turn(&self, agent_id: &str, data: String) -> Result<usize, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let queue = model
            .agent_turn_queues
            .entry(agent_id.to_string())
            .or_default();
        queue.push_back(data);
        Ok(queue.len())
    }

    pub fn list_agent_turn_queue(&self, agent_id: &str) -> Result<Vec<String>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agent_turn_queues
            .get(agent_id)
            .map(|queue| queue.iter().cloned().collect())
            .unwrap_or_default())
    }

    pub fn remove_agent_turn_queue_item(
        &self,
        agent_id: &str,
        index: usize,
        expected_data: Option<&str>,
    ) -> Result<(String, Vec<String>), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;

        let (removed, queued_turns, is_empty) = {
            let queue = model
                .agent_turn_queues
                .get_mut(agent_id)
                .ok_or_else(|| format!("agent {agent_id} does not have queued turns"))?;
            let current = queue
                .get(index)
                .ok_or_else(|| format!("queued turn {index} was not found"))?;
            if let Some(expected_data) = expected_data {
                if current != expected_data {
                    return Err("queued turn changed; refresh before editing".to_string());
                }
            }

            let removed = queue
                .remove(index)
                .ok_or_else(|| format!("queued turn {index} was not found"))?;
            let queued_turns = queue.iter().cloned().collect::<Vec<_>>();
            (removed, queued_turns, queue.is_empty())
        };

        if is_empty {
            model.agent_turn_queues.remove(agent_id);
        }

        Ok((removed, queued_turns))
    }

    pub fn pop_agent_turn(&self, agent_id: &str) -> Result<Option<(String, usize)>, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(queue) = model.agent_turn_queues.get_mut(agent_id) else {
            return Ok(None);
        };
        let Some(data) = queue.pop_front() else {
            return Ok(None);
        };
        let pending_count = queue.len();
        if queue.is_empty() {
            model.agent_turn_queues.remove(agent_id);
        }
        Ok(Some((data, pending_count)))
    }

    pub fn prepend_agent_turn(&self, agent_id: &str, data: String) -> Result<usize, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let queue = model
            .agent_turn_queues
            .entry(agent_id.to_string())
            .or_default();
        queue.push_front(data);
        Ok(queue.len())
    }

    pub fn mark_transcript_tail(&self, agent_id: &str, path: &str) -> Result<bool, String> {
        let key = format!("{agent_id}:{path}");
        let mut tails = self
            .inner
            .transcript_tails
            .lock()
            .map_err(|_| "transcript tail lock poisoned".to_string())?;
        Ok(tails.insert(key))
    }

    pub fn pane_writer(&self, pane_id: &str) -> Result<Option<SharedWriter>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.writer.clone()))
    }

    pub fn pane_master(&self, pane_id: &str) -> Result<Option<SharedMaster>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.master.clone()))
    }

    pub fn pane_child(&self, pane_id: &str) -> Result<Option<SharedChild>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.child.clone()))
    }

    pub fn update_pane_size(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let pane = model
            .panes
            .get_mut(pane_id)
            .ok_or_else(|| format!("pane {pane_id} was not found"))?;
        pane.info.cols = cols;
        pane.info.rows = rows;
        Ok(())
    }

    pub fn mark_pane_status(&self, pane_id: &str, status: PaneStatus) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if let Some(pane) = model.panes.get_mut(pane_id) {
            pane.info.status = status;
        }
        Ok(())
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        // /dev/urandom is effectively always available on macOS; degrade to a
        // time/pid-mixed value rather than emitting an all-zero token if it is not,
        // so the socket is never left guarded by a constant secret.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let pid = u128::from(std::process::id());
        let mixed = nanos ^ pid.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        bytes[..16].copy_from_slice(&mixed.to_le_bytes());
        bytes[16..].copy_from_slice(&nanos.to_le_bytes());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
