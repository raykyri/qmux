use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::persistence::{self, PersistedState, STATE_VERSION};
use crate::transcript::Turn;
use crate::workspace::{AgentInfo, GroupInfo};
use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    // Persistence stays off until restore_session() runs so constructing a state
    // (notably in tests) never touches disk. Once enabled, every model mutation
    // snapshots to workspace_root/.qmux/state.json.
    persist_enabled: AtomicBool,
}

#[derive(Default)]
struct Model {
    panes: HashMap<String, PaneRuntime>,
    groups: HashMap<String, GroupInfo>,
    agents: HashMap<String, AgentInfo>,
    turns: HashMap<String, Vec<Turn>>,
    agent_turn_queues: HashMap<String, VecDeque<String>>,
    agent_send_tracking: HashMap<String, AgentSendTracking>,
    agent_drafts: HashMap<String, String>,
}

#[derive(Clone, Debug, Default)]
struct AgentSendTracking {
    outstanding_sends: VecDeque<AgentOutstandingSend>,
    ups_seq: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSendSource {
    DirectSend,
    QueuedTurn,
    Steer,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutstandingSend {
    pub text: String,
    pub sent_at_seq: u64,
    pub source: AgentSendSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum AgentPromptSubmitMatch {
    Matched {
        source: AgentSendSource,
        outstanding_sends: usize,
    },
    Mismatched {
        expected: String,
        actual: String,
        outstanding_sends: usize,
    },
    Untracked {
        actual: String,
        outstanding_sends: usize,
    },
    MissingPrompt {
        outstanding_sends: usize,
    },
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
    /// True for panes recreated from persisted state on restart. Set at respawn
    /// time only; the persisted value is never consulted when reloading.
    #[serde(default)]
    pub recovered: bool,
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
                persist_enabled: AtomicBool::new(false),
            }),
        }
    }

    pub fn config(&self) -> &QmuxConfig {
        &self.inner.config
    }

    /// Loads persisted metadata into the in-memory model and enables persistence.
    ///
    /// Groups, agents and queued turns are hydrated directly. Panes are *not*:
    /// their persisted runtimes are stale (the old PTYs died with the previous
    /// process), so the pane metadata is returned for the caller to respawn into
    /// fresh PTYs. Returns the recoverable pane infos in a stable order.
    pub fn restore_session(&self) -> Vec<PaneInfo> {
        let persisted = persistence::load(&self.inner.config.workspace_root);

        if let Ok(mut model) = self.inner.model.lock() {
            for group in persisted.groups {
                model.groups.insert(group.id.clone(), group);
            }
            for agent in persisted.agents {
                model.agents.insert(agent.id.clone(), agent);
            }
            for (agent_id, turns) in persisted.queues {
                if !turns.is_empty() {
                    model
                        .agent_turn_queues
                        .insert(agent_id, turns.into_iter().collect());
                }
            }
            for (agent_id, draft) in persisted.drafts {
                if !draft.trim().is_empty() {
                    model.agent_drafts.insert(agent_id, draft);
                }
            }
        }

        // Keep id allocation monotonic across restarts so reused ids never alias.
        if persisted.next_id > self.inner.next_id.load(Ordering::Relaxed) {
            self.inner.next_id.store(persisted.next_id, Ordering::Relaxed);
        }

        // Enable persistence only after hydration so loading does not rewrite the
        // file, but before respawn so respawned panes get persisted.
        self.inner.persist_enabled.store(true, Ordering::Relaxed);

        let mut panes = persisted.panes;
        panes.sort_by(|a, b| a.id.cmp(&b.id));
        panes
    }

    /// Snapshots the model to disk when persistence is enabled. Best-effort: a
    /// failed write is logged but never propagated, so it cannot break a mutation.
    fn persist(&self) {
        if !self.inner.persist_enabled.load(Ordering::Relaxed) {
            return;
        }

        let snapshot = {
            let Ok(model) = self.inner.model.lock() else {
                return;
            };
            PersistedState {
                version: STATE_VERSION,
                next_id: self.inner.next_id.load(Ordering::Relaxed),
                panes: model.panes.values().map(|pane| pane.info.clone()).collect(),
                groups: model.groups.values().cloned().collect(),
                agents: model.agents.values().cloned().collect(),
                queues: model
                    .agent_turn_queues
                    .iter()
                    .map(|(agent_id, queue)| (agent_id.clone(), queue.iter().cloned().collect()))
                    .collect(),
                drafts: model.agent_drafts.clone(),
            }
        };

        if let Err(err) = persistence::save(&self.inner.config.workspace_root, &snapshot) {
            eprintln!("qmux: failed to persist session state: {err}");
        }
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
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.panes.insert(pane.info.id.clone(), pane);
        }
        self.persist();
        Ok(())
    }

    pub fn remove_pane(&self, pane_id: &str) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.panes.remove(pane_id);
        }
        self.persist();
        Ok(())
    }

    pub fn insert_group(&self, group: GroupInfo) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.groups.insert(group.id.clone(), group);
        }
        self.persist();
        Ok(())
    }

    pub fn insert_agent(&self, agent: AgentInfo) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.agents.insert(agent.id.clone(), agent);
        }
        self.persist();
        Ok(())
    }

    pub fn update_group(&self, group: GroupInfo) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.groups.insert(group.id.clone(), group);
        }
        self.persist();
        Ok(())
    }

    pub fn update_agent(&self, agent: AgentInfo) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.agents.insert(agent.id.clone(), agent);
        }
        self.persist();
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
        let len = {
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
            queue.len()
        };
        self.persist();
        Ok(len)
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

        drop(model);
        self.persist();
        Ok((removed, queued_turns))
    }

    pub fn reorder_agent_turn_queue_item(
        &self,
        agent_id: &str,
        from: usize,
        to: usize,
        expected_data: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let queued_turns = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let queue = model
                .agent_turn_queues
                .get_mut(agent_id)
                .ok_or_else(|| format!("agent {agent_id} does not have queued turns"))?;
            let len = queue.len();
            if from >= len || to >= len {
                return Err(format!("queued turn index out of range (len {len})"));
            }
            if let Some(expected_data) = expected_data {
                let current = queue
                    .get(from)
                    .ok_or_else(|| format!("queued turn {from} was not found"))?;
                if current != expected_data {
                    return Err("queued turn changed; refresh before reordering".to_string());
                }
            }
            let moved = queue
                .remove(from)
                .ok_or_else(|| format!("queued turn {from} was not found"))?;
            queue.insert(to, moved);
            queue.iter().cloned().collect::<Vec<_>>()
        };
        self.persist();
        Ok(queued_turns)
    }

    pub fn pop_agent_turn(&self, agent_id: &str) -> Result<Option<(String, usize)>, String> {
        let popped = {
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
            (data, pending_count)
        };
        self.persist();
        Ok(Some(popped))
    }

    pub fn prepend_agent_turn(&self, agent_id: &str, data: String) -> Result<usize, String> {
        let len = {
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
            queue.len()
        };
        self.persist();
        Ok(len)
    }

    /// Stores the agent's composer draft and snapshots it to disk. A trimmed-empty
    /// draft drops the entry so recovery never restores stray whitespace and the
    /// map does not grow an entry per cleared composer.
    pub fn set_agent_draft(&self, agent_id: &str, draft: String) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if draft.trim().is_empty() {
                model.agent_drafts.remove(agent_id);
            } else {
                model.agent_drafts.insert(agent_id.to_string(), draft);
            }
        }
        self.persist();
        Ok(())
    }

    pub fn agent_draft(&self, agent_id: &str) -> Result<Option<String>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agent_drafts.get(agent_id).cloned())
    }

    pub fn record_agent_send(
        &self,
        agent_id: &str,
        text: String,
        source: AgentSendSource,
    ) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let tracking = model
            .agent_send_tracking
            .entry(agent_id.to_string())
            .or_default();
        tracking.outstanding_sends.push_back(AgentOutstandingSend {
            text,
            sent_at_seq: tracking.ups_seq,
            source,
        });
        Ok(())
    }

    pub fn match_agent_prompt_submit(
        &self,
        agent_id: &str,
        prompt: Option<&str>,
    ) -> Result<AgentPromptSubmitMatch, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let tracking = model
            .agent_send_tracking
            .entry(agent_id.to_string())
            .or_default();
        tracking.ups_seq = tracking.ups_seq.saturating_add(1);
        let outstanding_count = tracking.outstanding_sends.len();

        let Some(prompt) = prompt else {
            return Ok(AgentPromptSubmitMatch::MissingPrompt {
                outstanding_sends: outstanding_count,
            });
        };

        let Some(front) = tracking.outstanding_sends.front() else {
            return Ok(AgentPromptSubmitMatch::Untracked {
                actual: prompt.to_string(),
                outstanding_sends: 0,
            });
        };

        if prompts_match(prompt, &front.text) {
            let matched = tracking
                .outstanding_sends
                .pop_front()
                .expect("front checked above");
            Ok(AgentPromptSubmitMatch::Matched {
                source: matched.source,
                outstanding_sends: tracking.outstanding_sends.len(),
            })
        } else {
            Ok(AgentPromptSubmitMatch::Mismatched {
                expected: front.text.clone(),
                actual: prompt.to_string(),
                outstanding_sends: outstanding_count,
            })
        }
    }

    pub fn outstanding_agent_sends(
        &self,
        agent_id: &str,
    ) -> Result<Vec<AgentOutstandingSend>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agent_send_tracking
            .get(agent_id)
            .map(|tracking| tracking.outstanding_sends.iter().cloned().collect())
            .unwrap_or_default())
    }

    pub fn clear_agent_outstanding_sends(&self, agent_id: &str) -> Result<usize, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(tracking) = model.agent_send_tracking.get_mut(agent_id) else {
            return Ok(0);
        };
        let cleared = tracking.outstanding_sends.len();
        tracking.outstanding_sends.clear();
        Ok(cleared)
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
        {
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
        }
        self.persist();
        Ok(())
    }

    /// Updates a pane's last-known working directory, reported by shell
    /// integration on directory changes so a restarted shell reopens where it
    /// left off rather than at its spawn-time cwd. No-op for unknown panes.
    pub fn update_pane_cwd(&self, pane_id: &str, cwd: String) -> Result<(), String> {
        let changed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            match model.panes.get_mut(pane_id) {
                Some(pane) if pane.info.cwd != cwd => {
                    pane.info.cwd = cwd;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist();
        }
        Ok(())
    }

    pub fn mark_pane_status(&self, pane_id: &str, status: PaneStatus) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if let Some(pane) = model.panes.get_mut(pane_id) {
                pane.info.status = status;
            }
        }
        self.persist();
        Ok(())
    }
}

fn prompts_match(actual: &str, expected: &str) -> bool {
    let actual = normalize_prompt(actual);
    let expected = normalize_prompt(expected);
    actual == expected
}

fn normalize_prompt(prompt: &str) -> String {
    prompt.split_whitespace().collect::<Vec<_>>().join(" ")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::PersistedState;
    use crate::workspace::AgentStatus;
    use std::path::PathBuf;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_workspace() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-state-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_config(workspace_root: PathBuf) -> QmuxConfig {
        QmuxConfig {
            workspace_root,
            socket_path: PathBuf::from("/tmp/qmux-test.sock"),
            claude_binary: "claude".to_string(),
        }
    }

    fn sample_agent(id: &str) -> AgentInfo {
        AgentInfo {
            id: id.to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/work/agent-1".to_string(),
            branch: Some("qmux/group-1/agent-1".to_string()),
            pane_id: Some("pane-7".to_string()),
            session_id: Some("session-abc".to_string()),
            transcript_path: Some("/tmp/transcript.jsonl".to_string()),
            status: AgentStatus::Running,
            model: Some("opus".to_string()),
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            created_at: 1,
        }
    }

    fn sample_group() -> GroupInfo {
        GroupInfo {
            id: "group-1".to_string(),
            name: "group-1".to_string(),
            dir: "/tmp/work".to_string(),
            base_repo: Some("/tmp/repo".to_string()),
            base_ref: Some("HEAD".to_string()),
            parent_id: None,
            created_at: 1,
            agents: vec!["agent-1".to_string()],
        }
    }

    fn sample_pane(id: &str, agent_id: Option<&str>) -> PaneInfo {
        PaneInfo {
            id: id.to_string(),
            title: "Shell".to_string(),
            kind: PaneKind::Shell,
            agent_id: agent_id.map(ToString::to_string),
            cwd: "/tmp/work/agent-1".to_string(),
            cols: 132,
            rows: 43,
            status: PaneStatus::Running,
            recovered: false,
        }
    }

    #[test]
    fn queue_mutations_round_trip_through_persistence() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        // First process: build up a queue through enqueue/remove with persistence on.
        {
            let state = AppState::new(config.clone());
            assert!(state.restore_session().is_empty());
            state.enqueue_agent_turn("agent-1", "first".to_string()).unwrap();
            state.enqueue_agent_turn("agent-1", "second".to_string()).unwrap();
            state.enqueue_agent_turn("agent-1", "third".to_string()).unwrap();
            // Drop "second" from the middle.
            state
                .remove_agent_turn_queue_item("agent-1", 1, Some("second"))
                .unwrap();
        }

        // Second process: the surviving queue order must reload intact.
        let popped = {
            let state = AppState::new(config.clone());
            state.restore_session();
            assert_eq!(
                state.list_agent_turn_queue("agent-1").unwrap(),
                vec!["first".to_string(), "third".to_string()]
            );
            let (data, pending) = state.pop_agent_turn("agent-1").unwrap().unwrap();
            assert_eq!(data, "first");
            assert_eq!(pending, 1);
            data
        };
        assert_eq!(popped, "first");

        // Third process: the pop must also have been persisted.
        let state = AppState::new(config);
        state.restore_session();
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["third".to_string()]
        );
    }

    #[test]
    fn restore_rehydrates_metadata_but_not_pane_runtimes() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        // Stand in for a previous process having persisted a full session.
        let persisted = PersistedState {
            next_id: 99,
            groups: vec![sample_group()],
            agents: vec![sample_agent("agent-1")],
            panes: vec![sample_pane("pane-7", Some("agent-1"))],
            queues: HashMap::from([("agent-1".to_string(), vec!["queued turn".to_string()])]),
            ..PersistedState::default()
        };
        crate::persistence::save(&workspace, &persisted).unwrap();

        let state = AppState::new(config);
        let recovered = state.restore_session();

        // Pane metadata is returned for respawning, with fields intact...
        assert_eq!(recovered.len(), 1);
        let pane = &recovered[0];
        assert_eq!(pane.id, "pane-7");
        assert_eq!(pane.cwd, "/tmp/work/agent-1");
        assert_eq!(pane.cols, 132);
        assert_eq!(pane.rows, 43);

        // ...but the stale runtime is NOT trusted: no live pane exists until respawn.
        assert!(state.list_panes().unwrap().is_empty());
        assert!(state.pane_writer("pane-7").unwrap().is_none());

        // Groups, agents and queues are hydrated directly into the live model.
        assert_eq!(state.list_groups().unwrap().len(), 1);
        let agent = state.agent("agent-1").unwrap().expect("agent restored");
        assert_eq!(agent.session_id.as_deref(), Some("session-abc"));
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["queued turn".to_string()]
        );

        // next_id is advanced past the persisted high-water mark so ids never alias.
        assert!(state.next_id("pane").starts_with("pane-"));
        let raw = state.next_id("pane");
        let seq: u64 = raw.rsplit('-').next().unwrap().parse().unwrap();
        assert!(seq >= 99, "expected next_id >= persisted high-water mark");
    }

    #[test]
    fn persistence_stays_off_until_restore() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        // Without restore_session(), mutations must not touch disk (keeps tests and
        // ad-hoc AppState construction hermetic).
        let state = AppState::new(config);
        state.enqueue_agent_turn("agent-1", "ghost".to_string()).unwrap();
        assert!(!crate::persistence::state_path(&workspace).exists());
    }

    #[test]
    fn agent_draft_round_trips_and_clears_through_persistence() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        // First process: stash a draft for one agent.
        {
            let state = AppState::new(config.clone());
            assert!(state.restore_session().is_empty());
            state
                .set_agent_draft("agent-1", "half-written thought".to_string())
                .unwrap();
        }

        // Second process: the draft reloads from disk and a trimmed-empty value
        // clears it (so recovery never restores stray whitespace).
        {
            let state = AppState::new(config.clone());
            state.restore_session();
            assert_eq!(
                state.agent_draft("agent-1").unwrap().as_deref(),
                Some("half-written thought")
            );
            state.set_agent_draft("agent-1", "   ".to_string()).unwrap();
            assert_eq!(state.agent_draft("agent-1").unwrap(), None);
        }

        // Third process: the clear was persisted too.
        let state = AppState::new(config);
        state.restore_session();
        assert_eq!(state.agent_draft("agent-1").unwrap(), None);
    }
}
