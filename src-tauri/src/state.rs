use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::persistence::{self, PersistedState, STATE_VERSION};
use crate::transcript::Turn;
use crate::workspace::{AgentInfo, AgentStatus, GroupInfo};
use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
pub type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
pub type SharedBacklog = Arc<Mutex<PaneBacklog>>;

/// Upper bound on a pane's reported working directory. Comfortably above any
/// real filesystem path (PATH_MAX is typically 1024–4096) while bounding what an
/// in-pane process can push into persisted state via the control socket.
const MAX_PANE_CWD_LEN: usize = 8192;

/// Holds PTY output produced before the webview's listener is attached.
///
/// A pane's reader thread starts emitting the instant the process spawns, but on
/// a cold start (and for panes recovered before the UI exists) that happens
/// before the frontend has registered its `qmux-event` listener, so the very
/// first prompt would be emitted into the void and lost. Until `ready` flips —
/// the frontend signals this via `pane_attach` once its listener is live — the
/// reader buffers here instead of emitting.
#[derive(Default)]
pub struct PaneBacklog {
    pub ready: bool,
    pub buffer: Vec<u8>,
}

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
    exit_confirmed: AtomicBool,
}

#[derive(Default)]
struct Model {
    panes: HashMap<String, PaneRuntime>,
    pane_order: Vec<String>,
    /// Sidebar nesting depth per pane (0 = root). Source of truth for the tab tree;
    /// `ordered_panes` stamps it onto each returned `PaneInfo`. Absent id == depth 0.
    pane_depth: HashMap<String, u16>,
    groups: HashMap<String, GroupInfo>,
    agents: HashMap<String, AgentInfo>,
    turns: HashMap<String, Vec<Turn>>,
    agent_turn_queues: HashMap<String, VecDeque<QueuedTurn>>,
    agent_send_tracking: HashMap<String, AgentSendTracking>,
    agent_drafts: HashMap<String, String>,
    /// Agents whose currently-running (just-sent) queued turn requested a pause; when
    /// that turn finishes the agent enters paused mode. Transient (not persisted).
    agent_pending_pause: HashSet<String>,
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

/// A queued turn: the text to send plus whether the queue should pause once this
/// turn's agent work finishes. Deserializes from either a bare string (the legacy
/// persisted format) or a `{ text, pauseAfter }` object, so old state still loads.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub text: String,
    pub pause_after: bool,
}

impl QueuedTurn {
    pub fn new(text: String) -> Self {
        Self {
            text,
            pause_after: false,
        }
    }
}

impl<'de> Deserialize<'de> for QueuedTurn {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Text(String),
            Full {
                text: String,
                #[serde(default, rename = "pauseAfter")]
                pause_after: bool,
            },
        }
        Ok(match Repr::deserialize(deserializer)? {
            Repr::Text(text) => QueuedTurn {
                text,
                pause_after: false,
            },
            Repr::Full { text, pause_after } => QueuedTurn { text, pause_after },
        })
    }
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
    pub backlog: SharedBacklog,
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
    /// Sidebar nesting depth (0 = root). Stamped from `Model.pane_depth` by
    /// `ordered_panes`; persisted so the tree survives a restart.
    #[serde(default)]
    pub depth: u16,
}

/// Hard cap on nesting depth so a deep chain can never make the sidebar unusable.
/// Mirrored by `MAX_PANE_DEPTH` in the frontend's pane-tree helpers.
pub const MAX_PANE_DEPTH: u16 = 8;

/// One entry in a `set_pane_layout` request: a pane and its target nesting depth,
/// in sidebar order.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLayoutEntry {
    pub pane_id: String,
    pub depth: u16,
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
                exit_confirmed: AtomicBool::new(false),
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
        let outcome = persistence::load_with_diagnostics(&self.inner.config.workspace_root);
        if let Some(warning) = outcome.warning.as_ref() {
            eprintln!("qmux: {}", warning.message);
        }
        let persisted = outcome.state;
        let shell_pane_ids = persisted
            .panes
            .iter()
            .filter_map(|pane| matches!(pane.kind, PaneKind::Shell).then(|| pane.id.clone()))
            .collect::<HashSet<_>>();
        let queued_agent_ids = persisted
            .queues
            .iter()
            .filter_map(|(agent_id, turns)| (!turns.is_empty()).then(|| agent_id.clone()))
            .collect::<HashSet<_>>();

        if let Ok(mut model) = self.inner.model.lock() {
            for group in persisted.groups {
                model.groups.insert(group.id.clone(), group);
            }
            for mut agent in persisted.agents {
                if let Some(pane_id) = agent
                    .pane_id
                    .clone()
                    .filter(|pane_id| shell_pane_ids.contains(pane_id))
                {
                    agent.pane_id = None;
                    agent.status = AgentStatus::Idle;
                    agent.orphaned_queue_pane_id =
                        queued_agent_ids.contains(&agent.id).then_some(pane_id);
                } else if !queued_agent_ids.contains(&agent.id) {
                    agent.orphaned_queue_pane_id = None;
                }
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
            // Seed nesting depth from the persisted panes. Panes are re-inserted by
            // the respawn pass that follows; depths for panes that don't come back
            // (e.g. already-exited panes) are pruned by the post-respawn normalize.
            for pane in &persisted.panes {
                if pane.depth != 0 {
                    model.pane_depth.insert(pane.id.clone(), pane.depth);
                }
            }
        }

        // Keep id allocation monotonic across restarts so reused ids never alias.
        if persisted.next_id > self.inner.next_id.load(Ordering::Relaxed) {
            self.inner
                .next_id
                .store(persisted.next_id, Ordering::Relaxed);
        }

        // Enable persistence only after hydration so loading does not rewrite the
        // file, but before respawn so respawned panes get persisted.
        self.inner.persist_enabled.store(true, Ordering::Relaxed);

        persisted.panes
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
                panes: ordered_panes(&model),
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
    pub fn pane_token(&self, pane_id: &str) -> Result<String, String> {
        let mut tokens = self
            .inner
            .pane_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = tokens.get(pane_id) {
            return Ok(existing.clone());
        }
        // Mint outside the entry API so a CSPRNG failure returns an error to this one
        // call rather than panicking inside or_insert_with and aborting the whole
        // app (killing every running agent and unsaved draft).
        let token = random_token()?;
        Ok(tokens.entry(pane_id.to_string()).or_insert(token).clone())
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

    pub fn mark_exit_confirmed(&self) {
        self.inner.exit_confirmed.store(true, Ordering::Relaxed);
    }

    pub fn should_confirm_exit(&self) -> bool {
        if self.inner.exit_confirmed.load(Ordering::Relaxed) {
            return false;
        }
        self.open_pane_count() > 0
    }

    pub fn request_exit_confirmation(&self) {
        let pane_count = self.open_pane_count();
        if pane_count == 0 {
            return;
        }
        self.emit(QmuxEvent::new(
            "app.exit_confirmation_requested",
            None,
            None,
            json!({ "paneCount": pane_count }),
        ));
    }

    fn open_pane_count(&self) -> usize {
        self.inner
            .model
            .lock()
            .map(|model| {
                model
                    .panes
                    .values()
                    .filter(|pane| {
                        matches!(pane.info.status, PaneStatus::Starting | PaneStatus::Running)
                    })
                    .count()
            })
            .unwrap_or_default()
    }

    pub fn list_panes(&self) -> Result<Vec<PaneInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(ordered_panes(&model))
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
            let pane_id = pane.info.id.clone();
            let is_new = !model.panes.contains_key(&pane_id);
            model.panes.insert(pane_id.clone(), pane);
            if is_new && !model.pane_order.iter().any(|id| id == &pane_id) {
                model.pane_order.push(pane_id);
            }
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
            model.pane_order.retain(|id| id != pane_id);
            // Re-level any children orphaned by the removal so the tree stays valid
            // (a closed parent must not leave its children at an unreachable depth).
            normalize_pane_depths(&mut model);
        }
        self.persist();
        Ok(())
    }

    pub fn reorder_panes(&self, pane_ids: Vec<String>) -> Result<Vec<PaneInfo>, String> {
        let panes = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if pane_ids.len() != model.panes.len() {
                return Err("pane order is stale; refresh before reordering".to_string());
            }

            let mut seen = HashSet::with_capacity(pane_ids.len());
            for pane_id in &pane_ids {
                if !seen.insert(pane_id.clone()) {
                    return Err("pane order contains a duplicate pane".to_string());
                }
                if !model.panes.contains_key(pane_id) {
                    return Err(format!("pane {pane_id} was not found"));
                }
            }

            model.pane_order = pane_ids;
            // A bare reorder can move a nested pane to a position its depth no longer
            // fits (e.g. a child to the top), so re-level depths to stay a valid tree.
            normalize_pane_depths(&mut model);
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// Atomically replaces the full sidebar tab tree: order + nesting depth. The
    /// `layout` must list exactly the current panes (no missing/duplicate/unknown id)
    /// and form a valid tree (first depth 0; each depth <= previous + 1; capped at
    /// `MAX_PANE_DEPTH`). Every structural tab operation — reorder, indent, outdent,
    /// nest — is expressed as one of these layouts so a multi-pane indent applies in
    /// a single locked mutation.
    pub fn set_pane_layout(&self, layout: Vec<PaneLayoutEntry>) -> Result<Vec<PaneInfo>, String> {
        let panes = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if layout.len() != model.panes.len() {
                return Err("pane layout is stale; refresh before updating".to_string());
            }

            let mut seen = HashSet::with_capacity(layout.len());
            let mut prev_depth: Option<u16> = None;
            for entry in &layout {
                if !seen.insert(entry.pane_id.clone()) {
                    return Err("pane layout contains a duplicate pane".to_string());
                }
                if !model.panes.contains_key(&entry.pane_id) {
                    return Err(format!("pane {} was not found", entry.pane_id));
                }
                if entry.depth > MAX_PANE_DEPTH {
                    return Err(format!(
                        "pane depth {} exceeds the maximum of {MAX_PANE_DEPTH}",
                        entry.depth
                    ));
                }
                let ceiling = prev_depth.map_or(0, |prev| prev + 1);
                if entry.depth > ceiling {
                    return Err(
                        "pane layout is not a valid tree (a depth skips a level)".to_string()
                    );
                }
                prev_depth = Some(entry.depth);
            }

            model.pane_order = layout.iter().map(|entry| entry.pane_id.clone()).collect();
            model.pane_depth = layout
                .iter()
                .filter(|entry| entry.depth != 0)
                .map(|entry| (entry.pane_id.clone(), entry.depth))
                .collect();
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// Moves `pane_id` to sit immediately after `parent_pane_id` at one level deeper
    /// (its first child), then re-levels the tree. Used when a fork should appear
    /// nested under the session it forked from.
    pub fn nest_pane_under(
        &self,
        pane_id: &str,
        parent_pane_id: &str,
    ) -> Result<Vec<PaneInfo>, String> {
        let panes = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if !model.panes.contains_key(pane_id) {
                return Err(format!("pane {pane_id} was not found"));
            }
            if !model.panes.contains_key(parent_pane_id) {
                return Err(format!("pane {parent_pane_id} was not found"));
            }

            let mut ids = ordered_pane_ids(&model);
            ids.retain(|id| id != pane_id);
            let parent_index = ids
                .iter()
                .position(|id| id == parent_pane_id)
                .ok_or_else(|| format!("pane {parent_pane_id} was not found"))?;
            ids.insert(parent_index + 1, pane_id.to_string());

            let parent_depth = model.pane_depth.get(parent_pane_id).copied().unwrap_or(0);
            let new_depth = (parent_depth + 1).min(MAX_PANE_DEPTH);
            model.pane_order = ids;
            model.pane_depth.insert(pane_id.to_string(), new_depth);
            normalize_pane_depths(&mut model);
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// Clamps persisted nesting depths to a valid tree over the panes that actually
    /// exist. Called once after session restore/respawn, since some persisted panes
    /// (already-exited ones) are intentionally not recreated.
    pub fn normalize_pane_layout(&self) {
        {
            let Ok(mut model) = self.inner.model.lock() else {
                return;
            };
            normalize_pane_depths(&mut model);
        }
        self.persist();
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

    /// Updates only an agent's status under the lock, leaving every other field as it
    /// stands. Unlike `update_agent` (which writes a whole struct snapshot), this
    /// can't clobber fields a concurrent writer just set — e.g. the `session_id` /
    /// `transcript_path` a freshly spawned fork's SessionStart hook records. Returns
    /// the updated agent, or `None` if it no longer exists.
    pub fn set_agent_status(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> Result<Option<AgentInfo>, String> {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            match model.agents.get_mut(agent_id) {
                Some(agent) => {
                    agent.status = status;
                    Some(agent.clone())
                }
                None => None,
            }
        };
        if updated.is_some() {
            self.persist();
        }
        Ok(updated)
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
            queue.push_back(QueuedTurn::new(data));
            queue.len()
        };
        self.persist();
        Ok(len)
    }

    /// Queued turn texts only — used by the drain path, expected-data matching, and
    /// tests. The structured view (with pause flags) is `agent_queued_turns`.
    pub fn list_agent_turn_queue(&self, agent_id: &str) -> Result<Vec<String>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agent_turn_queues
            .get(agent_id)
            .map(|queue| queue.iter().map(|turn| turn.text.clone()).collect())
            .unwrap_or_default())
    }

    /// Structured queued turns (text + pause flag) for events, command results, and
    /// the frontend.
    pub fn agent_queued_turns(&self, agent_id: &str) -> Result<Vec<QueuedTurn>, String> {
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

    /// Toggles the pause-after-send flag on a single queued turn, guarding against a
    /// stale index with the expected text. Returns the updated structured queue.
    pub fn set_queued_turn_pause(
        &self,
        agent_id: &str,
        index: usize,
        pause_after: bool,
        expected_text: Option<&str>,
    ) -> Result<Vec<QueuedTurn>, String> {
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
            let turn = queue
                .get_mut(index)
                .ok_or_else(|| format!("queued turn {index} was not found"))?;
            if let Some(expected_text) = expected_text {
                if turn.text != expected_text {
                    return Err("queued turn changed; refresh before updating".to_string());
                }
            }
            turn.pause_after = pause_after;
            queue.iter().cloned().collect::<Vec<_>>()
        };
        self.persist();
        Ok(queued_turns)
    }

    pub fn remove_agent_turn_queue_item(
        &self,
        agent_id: &str,
        index: usize,
        expected_data: Option<&str>,
    ) -> Result<(String, Vec<QueuedTurn>), String> {
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
                if current.text != expected_data {
                    return Err("queued turn changed; refresh before editing".to_string());
                }
            }

            let removed = queue
                .remove(index)
                .ok_or_else(|| format!("queued turn {index} was not found"))?
                .text;
            let queued_turns = queue.iter().cloned().collect::<Vec<_>>();
            (removed, queued_turns, queue.is_empty())
        };

        if is_empty {
            model.agent_turn_queues.remove(agent_id);
            if let Some(agent) = model.agents.get_mut(agent_id) {
                agent.orphaned_queue_pane_id = None;
            }
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
    ) -> Result<Vec<QueuedTurn>, String> {
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
                if current.text != expected_data {
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

    pub fn pop_agent_turn(&self, agent_id: &str) -> Result<Option<(QueuedTurn, usize)>, String> {
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
                if let Some(agent) = model.agents.get_mut(agent_id) {
                    agent.orphaned_queue_pane_id = None;
                }
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
            queue.push_front(QueuedTurn::new(data));
            queue.len()
        };
        self.persist();
        Ok(len)
    }

    /// Inserts a turn into an agent's queue at `index` (clamped to the queue length),
    /// returning the new length. Used to roll a moved turn back to its original spot
    /// when handing it to another agent fails.
    pub fn insert_agent_turn_at(
        &self,
        agent_id: &str,
        index: usize,
        data: String,
    ) -> Result<usize, String> {
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
            let at = index.min(queue.len());
            queue.insert(at, QueuedTurn::new(data));
            queue.len()
        };
        self.persist();
        Ok(len)
    }

    /// Sets an agent's paused flag without disturbing its other fields (a field-scoped
    /// write, so a concurrent hook update can't clobber it). Returns the updated agent.
    pub fn set_agent_paused(
        &self,
        agent_id: &str,
        paused: bool,
    ) -> Result<Option<AgentInfo>, String> {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            match model.agents.get_mut(agent_id) {
                Some(agent) => {
                    agent.paused = paused;
                    Some(agent.clone())
                }
                None => None,
            }
        };
        if updated.is_some() {
            self.persist();
        }
        Ok(updated)
    }

    /// Marks that the agent's currently-running queued turn requested a pause; the
    /// agent enters paused mode when that turn finishes (see `take_agent_pending_pause`).
    pub fn mark_agent_pending_pause(&self, agent_id: &str) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.agent_pending_pause.insert(agent_id.to_string());
        Ok(())
    }

    /// Consumes the pending-pause marker, returning whether one was set.
    pub fn take_agent_pending_pause(&self, agent_id: &str) -> Result<bool, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agent_pending_pause.remove(agent_id))
    }

    pub fn agent_is_paused(&self, agent_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agents
            .get(agent_id)
            .map(|agent| agent.paused)
            .unwrap_or(false))
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

    // Only the test suite inspects the full outstanding-send queue; production
    // code reads the count via match_agent_prompt_submit and clears it via
    // clear_agent_outstanding_sends. Gated to keep it out of the release binary.
    #[cfg(test)]
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

    /// Drops the marker for a tail that is stopping (its file rotated away or its
    /// agent went away) so the same `(agent_id, path)` can be tailed again if the
    /// agent ever returns to that file. Best-effort: a poisoned lock is ignored
    /// rather than propagated, since this only runs as a tail unwinds.
    pub fn clear_transcript_tail(&self, agent_id: &str, path: &str) {
        let key = format!("{agent_id}:{path}");
        if let Ok(mut tails) = self.inner.transcript_tails.lock() {
            tails.remove(&key);
        }
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

    pub fn pane_backlog(&self, pane_id: &str) -> Result<Option<SharedBacklog>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.backlog.clone()))
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
        // This value arrives over the control socket from in-pane shell
        // integration, so treat it as untrusted: reject control characters
        // (newlines, NULs, escape sequences) and absurd lengths before letting
        // it into persisted state and the UI. A legitimate working directory
        // never contains them.
        if cwd.len() > MAX_PANE_CWD_LEN {
            return Err(format!(
                "pane cwd exceeds {MAX_PANE_CWD_LEN} bytes; refusing to persist"
            ));
        }
        if cwd.chars().any(|ch| ch.is_control()) {
            return Err("pane cwd contains control characters; refusing to persist".to_string());
        }
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

    pub fn rename_pane(&self, pane_id: &str, title: String) -> Result<PaneInfo, String> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("tab name cannot be empty".to_string());
        }
        let info = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let pane = model
                .panes
                .get_mut(pane_id)
                .ok_or_else(|| format!("pane {pane_id} was not found"))?;
            pane.info.title = title;
            pane.info.clone()
        };
        self.persist();
        Ok(info)
    }

    #[cfg(test)]
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

/// The effective sidebar order: every live pane id, `pane_order` first, then any
/// panes missing from it (sorted by id for determinism). Shared by `ordered_panes`
/// and depth normalization so they always agree on ordering.
fn ordered_pane_ids(model: &Model) -> Vec<String> {
    let mut ids = Vec::with_capacity(model.panes.len());
    let mut seen = HashSet::with_capacity(model.panes.len());

    for pane_id in &model.pane_order {
        if model.panes.contains_key(pane_id) && seen.insert(pane_id.clone()) {
            ids.push(pane_id.clone());
        }
    }

    let mut missing_from_order = model
        .panes
        .keys()
        .filter(|pane_id| !seen.contains(*pane_id))
        .cloned()
        .collect::<Vec<_>>();
    missing_from_order.sort();
    ids.extend(missing_from_order);

    ids
}

fn ordered_panes(model: &Model) -> Vec<PaneInfo> {
    ordered_pane_ids(model)
        .into_iter()
        .filter_map(|pane_id| {
            model.panes.get(&pane_id).map(|pane| {
                let mut info = pane.info.clone();
                info.depth = model.pane_depth.get(&pane_id).copied().unwrap_or(0);
                info
            })
        })
        .collect()
}

/// Clamps `pane_depth` to the validity invariant along the effective order (first
/// pane depth 0; each depth <= previous + 1; capped at `MAX_PANE_DEPTH`) and drops
/// entries for panes that no longer exist. Idempotent. This is what re-levels
/// orphaned children when their parent pane is removed.
fn normalize_pane_depths(model: &mut Model) {
    let ids = ordered_pane_ids(model);
    let id_set: HashSet<&String> = ids.iter().collect();
    model.pane_depth.retain(|id, _| id_set.contains(id));

    let mut prev_depth: u16 = 0;
    for (index, id) in ids.iter().enumerate() {
        let raw = model.pane_depth.get(id).copied().unwrap_or(0);
        let ceiling = if index == 0 {
            0
        } else {
            (prev_depth + 1).min(MAX_PANE_DEPTH)
        };
        let depth = raw.min(ceiling);
        if depth == 0 {
            model.pane_depth.remove(id);
        } else {
            model.pane_depth.insert(id.clone(), depth);
        }
        prev_depth = depth;
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

fn random_token() -> Result<String, String> {
    // 256 bits from the OS CSPRNG (getentropy/getrandom on macOS and Linux). A
    // failure here is rare (no secure entropy source) but can be transient in some
    // sandboxes, so retry a few times before giving up. We never fall back to a
    // predictable time/pid-derived secret that would leave the control socket
    // guessable; instead the error propagates so a single pane fails to launch
    // rather than the whole process aborting.
    let mut bytes = [0u8; 32];
    let mut last_err = None;
    for _ in 0..3 {
        match getrandom::getrandom(&mut bytes) {
            Ok(()) => return Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect()),
            Err(err) => last_err = Some(err),
        }
    }
    Err(format!(
        "OS CSPRNG unavailable; cannot mint a control token: {}",
        last_err
            .map(|err| err.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig};
    use crate::persistence::PersistedState;
    use crate::workspace::AgentStatus;
    use portable_pty::{Child, ChildKiller, ExitStatus, PtySize, native_pty_system};
    use std::io;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

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
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: std::path::PathBuf::new(),
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
            orphaned_queue_pane_id: None,
            session_id: Some("session-abc".to_string()),
            transcript_path: Some("/tmp/transcript.jsonl".to_string()),
            status: AgentStatus::Running,
            model: Some("opus".to_string()),
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
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
            depth: 0,
        }
    }

    #[derive(Debug)]
    struct FakeChild;

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(FakeChild)
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    fn sample_pane_runtime(id: &str) -> PaneRuntime {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        drop(pair.slave);

        PaneRuntime {
            info: sample_pane(id, None),
            child: Arc::new(Mutex::new(Box::new(FakeChild))),
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(Box::new(io::sink()))),
            backlog: Default::default(),
        }
    }

    #[test]
    fn queued_turn_pause_flag_and_pending_pause() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state
            .enqueue_agent_turn("agent-1", "a".to_string())
            .unwrap();
        state
            .enqueue_agent_turn("agent-1", "b".to_string())
            .unwrap();

        let items = state
            .set_queued_turn_pause("agent-1", 1, true, Some("b"))
            .unwrap();
        assert!(!items[0].pause_after);
        assert!(items[1].pause_after);
        // The text list is unaffected by the flag.
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );

        // A stale expected-text guards against editing the wrong item.
        assert!(
            state
                .set_queued_turn_pause("agent-1", 1, false, Some("wrong"))
                .is_err()
        );

        // Pending-pause is a one-shot marker.
        assert!(!state.take_agent_pending_pause("agent-1").unwrap());
        state.mark_agent_pending_pause("agent-1").unwrap();
        assert!(state.take_agent_pending_pause("agent-1").unwrap());
        assert!(!state.take_agent_pending_pause("agent-1").unwrap());
    }

    #[test]
    fn queue_mutations_round_trip_through_persistence() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        // First process: build up a queue through enqueue/remove with persistence on.
        {
            let state = AppState::new(config.clone());
            assert!(state.restore_session().is_empty());
            state
                .enqueue_agent_turn("agent-1", "first".to_string())
                .unwrap();
            state
                .enqueue_agent_turn("agent-1", "second".to_string())
                .unwrap();
            state
                .enqueue_agent_turn("agent-1", "third".to_string())
                .unwrap();
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
            assert_eq!(data.text, "first");
            assert_eq!(pending, 1);
            data.text
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
    fn panes_list_in_inserted_order() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        state.insert_pane(sample_pane_runtime("pane-b")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-a")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-c")).unwrap();

        assert_eq!(
            state
                .list_panes()
                .unwrap()
                .into_iter()
                .map(|pane| pane.id)
                .collect::<Vec<_>>(),
            vec![
                "pane-b".to_string(),
                "pane-a".to_string(),
                "pane-c".to_string()
            ]
        );
    }

    #[test]
    fn update_pane_cwd_rejects_untrusted_values() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();

        // A normal path is accepted and stored.
        state
            .update_pane_cwd("pane-1", "/Users/me/project".to_string())
            .unwrap();
        assert_eq!(
            state.list_panes().unwrap()[0].cwd,
            "/Users/me/project".to_string()
        );

        // Control characters (here a newline) are rejected and leave the stored
        // value untouched.
        assert!(
            state
                .update_pane_cwd("pane-1", "/tmp/evil\nmalicious".to_string())
                .is_err()
        );
        // An oversized value is rejected too.
        assert!(
            state
                .update_pane_cwd("pane-1", "/".repeat(MAX_PANE_CWD_LEN + 1))
                .is_err()
        );
        assert_eq!(
            state.list_panes().unwrap()[0].cwd,
            "/Users/me/project".to_string()
        );
    }

    #[test]
    fn exit_confirmation_counts_only_live_panes() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut starting = sample_pane_runtime("pane-starting");
        starting.info.status = PaneStatus::Starting;
        state.insert_pane(starting).unwrap();
        assert!(state.should_confirm_exit());

        state
            .mark_pane_status("pane-starting", PaneStatus::Exited)
            .unwrap();
        assert!(!state.should_confirm_exit());

        state
            .insert_pane(sample_pane_runtime("pane-running"))
            .unwrap();
        assert!(state.should_confirm_exit());

        state
            .mark_pane_status("pane-running", PaneStatus::Killed)
            .unwrap();
        assert!(!state.should_confirm_exit());

        state
            .insert_pane(sample_pane_runtime("pane-failed"))
            .unwrap();
        state
            .mark_pane_status("pane-failed", PaneStatus::Failed)
            .unwrap();
        assert!(!state.should_confirm_exit());
    }

    #[test]
    fn pane_reorder_round_trips_through_persistence() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        {
            let state = AppState::new(config.clone());
            assert!(state.restore_session().is_empty());
            state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
            state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
            state.insert_pane(sample_pane_runtime("pane-3")).unwrap();

            let reordered = state
                .reorder_panes(vec![
                    "pane-3".to_string(),
                    "pane-1".to_string(),
                    "pane-2".to_string(),
                ])
                .unwrap();
            assert_eq!(
                reordered
                    .into_iter()
                    .map(|pane| pane.id)
                    .collect::<Vec<_>>(),
                vec![
                    "pane-3".to_string(),
                    "pane-1".to_string(),
                    "pane-2".to_string()
                ]
            );
        }

        let state = AppState::new(config);
        let recovered = state.restore_session();
        assert_eq!(
            recovered
                .into_iter()
                .map(|pane| pane.id)
                .collect::<Vec<_>>(),
            vec![
                "pane-3".to_string(),
                "pane-1".to_string(),
                "pane-2".to_string()
            ]
        );
    }

    #[test]
    fn pane_reorder_rejects_stale_or_duplicate_orders() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();

        let duplicate = state
            .reorder_panes(vec!["pane-1".to_string(), "pane-1".to_string()])
            .unwrap_err();
        assert!(duplicate.contains("duplicate"));

        let stale = state.reorder_panes(vec!["pane-1".to_string()]).unwrap_err();
        assert!(stale.contains("stale"));
    }

    fn layout(items: &[(&str, u16)]) -> Vec<PaneLayoutEntry> {
        items
            .iter()
            .map(|(id, depth)| PaneLayoutEntry {
                pane_id: id.to_string(),
                depth: *depth,
            })
            .collect()
    }

    fn id_depths(panes: &[PaneInfo]) -> Vec<(String, u16)> {
        panes
            .iter()
            .map(|pane| (pane.id.clone(), pane.depth))
            .collect()
    }

    #[test]
    fn set_pane_layout_applies_and_round_trips_depth() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        {
            let state = AppState::new(config.clone());
            assert!(state.restore_session().is_empty());
            state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
            state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
            state.insert_pane(sample_pane_runtime("pane-3")).unwrap();

            let panes = state
                .set_pane_layout(layout(&[("pane-3", 0), ("pane-1", 1), ("pane-2", 2)]))
                .unwrap();
            assert_eq!(
                id_depths(&panes),
                vec![
                    ("pane-3".to_string(), 0),
                    ("pane-1".to_string(), 1),
                    ("pane-2".to_string(), 2),
                ]
            );
        }

        // Depth and order survive a restart via the persisted pane list.
        let state = AppState::new(config);
        let recovered = state.restore_session();
        assert_eq!(
            id_depths(&recovered),
            vec![
                ("pane-3".to_string(), 0),
                ("pane-1".to_string(), 1),
                ("pane-2".to_string(), 2),
            ]
        );
    }

    #[test]
    fn set_pane_layout_rejects_invalid_layouts() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();

        // The first pane must be at the root.
        assert!(
            state
                .set_pane_layout(layout(&[("pane-1", 1), ("pane-2", 1)]))
                .unwrap_err()
                .contains("valid tree")
        );
        // A depth may not skip a level.
        assert!(
            state
                .set_pane_layout(layout(&[("pane-1", 0), ("pane-2", 2)]))
                .unwrap_err()
                .contains("valid tree")
        );
        // Depth is capped.
        assert!(
            state
                .set_pane_layout(layout(&[("pane-1", 0), ("pane-2", MAX_PANE_DEPTH + 1)]))
                .unwrap_err()
                .contains("maximum")
        );
        // Membership must match the live panes exactly.
        assert!(
            state
                .set_pane_layout(layout(&[("pane-1", 0), ("pane-1", 0)]))
                .unwrap_err()
                .contains("duplicate")
        );
        assert!(
            state
                .set_pane_layout(layout(&[("pane-1", 0)]))
                .unwrap_err()
                .contains("stale")
        );
    }

    #[test]
    fn remove_pane_relevels_orphaned_children() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-3")).unwrap();
        state
            .set_pane_layout(layout(&[("pane-1", 0), ("pane-2", 1), ("pane-3", 2)]))
            .unwrap();

        // Closing the root parent promotes its subtree so the tree stays valid.
        state.remove_pane("pane-1").unwrap();
        assert_eq!(
            id_depths(&state.list_panes().unwrap()),
            vec![("pane-2".to_string(), 0), ("pane-3".to_string(), 1)]
        );
    }

    #[test]
    fn nest_pane_under_moves_and_indents_beneath_parent() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-3")).unwrap();

        // Nest the last pane under the first; it moves directly after it at depth 1.
        let panes = state.nest_pane_under("pane-3", "pane-1").unwrap();
        assert_eq!(
            id_depths(&panes),
            vec![
                ("pane-1".to_string(), 0),
                ("pane-3".to_string(), 1),
                ("pane-2".to_string(), 0),
            ]
        );

        // Nesting under a deeper parent indents one further (a child of the child).
        let panes = state.nest_pane_under("pane-2", "pane-3").unwrap();
        assert_eq!(
            id_depths(&panes),
            vec![
                ("pane-1".to_string(), 0),
                ("pane-3".to_string(), 1),
                ("pane-2".to_string(), 2),
            ]
        );
    }

    #[test]
    fn set_agent_status_preserves_other_fields() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        let mut agent = AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/x".to_string(),
            branch: None,
            pane_id: Some("pane-1".to_string()),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Starting,
            model: None,
            parent_id: Some("agent-0".to_string()),
            fork_point: Some("sess-src".to_string()),
            root_session_id: Some("sess-src".to_string()),
            paused: false,
            created_at: 1,
        };
        state.insert_agent(agent.clone()).unwrap();

        // Simulate the spawned fork's SessionStart landing: it records the new
        // session id and transcript on the agent.
        agent.session_id = Some("sess-fork".to_string());
        agent.transcript_path = Some("/tmp/fork.jsonl".to_string());
        agent.status = AgentStatus::Running;
        state.update_agent(agent).unwrap();

        // The post-attach status reset must not wipe what SessionStart just wrote.
        let updated = state
            .set_agent_status("agent-1", AgentStatus::AwaitingInput)
            .unwrap()
            .expect("agent exists");
        assert!(matches!(updated.status, AgentStatus::AwaitingInput));
        assert_eq!(updated.session_id.as_deref(), Some("sess-fork"));
        assert_eq!(updated.transcript_path.as_deref(), Some("/tmp/fork.jsonl"));
        assert_eq!(updated.parent_id.as_deref(), Some("agent-0"));

        assert!(
            state
                .set_agent_status("missing", AgentStatus::Idle)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn reorder_panes_renormalizes_depth() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-3")).unwrap();
        state
            .set_pane_layout(layout(&[("pane-1", 0), ("pane-2", 1), ("pane-3", 0)]))
            .unwrap();

        // Moving the nested child to the front would leave it at depth 1 with no
        // parent above; the reorder must re-level it to a valid tree.
        let panes = state
            .reorder_panes(vec![
                "pane-2".to_string(),
                "pane-1".to_string(),
                "pane-3".to_string(),
            ])
            .unwrap();
        assert_eq!(
            id_depths(&panes),
            vec![
                ("pane-2".to_string(), 0),
                ("pane-1".to_string(), 0),
                ("pane-3".to_string(), 0),
            ]
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
            queues: HashMap::from([(
                "agent-1".to_string(),
                vec![QueuedTurn::new("queued turn".to_string())],
            )]),
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
        assert_eq!(agent.pane_id, None);
        assert_eq!(agent.orphaned_queue_pane_id.as_deref(), Some("pane-7"));
        assert!(matches!(agent.status, AgentStatus::Idle));
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["queued turn".to_string()]
        );
        state
            .remove_agent_turn_queue_item("agent-1", 0, Some("queued turn"))
            .unwrap();
        let agent = state.agent("agent-1").unwrap().expect("agent restored");
        assert_eq!(agent.orphaned_queue_pane_id, None);

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
        state
            .enqueue_agent_turn("agent-1", "ghost".to_string())
            .unwrap();
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
