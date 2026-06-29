use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::persistence::{self, PersistedState, STATE_VERSION};
use crate::scrollback::{read_pane_scrollback, remove_pane_scrollback};
use crate::transcript::{Turn, read_transcript_meta};
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

/// Upper bound on the parsed transcript turns retained in memory per agent. The
/// store feeds the UI timeline on (re)connect and crash recovery; without a cap a
/// long session — or selecting a large transcript, which reparses the whole file —
/// grows unbounded, since each turn can carry full tool inputs/results. Once over
/// the cap the oldest turns are dropped (the live timeline still streams every new
/// turn to the frontend as it arrives).
const MAX_TURNS_PER_AGENT: usize = 200;

/// Upper bound on pending turns queued for a single agent. This is a safety
/// ceiling against unbounded growth (memory plus a larger `state.json` rewritten
/// on every persist), not an expected limit — enqueue past it returns an error the
/// UI surfaces rather than silently swallowing the turn.
const MAX_QUEUED_TURNS_PER_AGENT: usize = 500;

/// Upper bound on durable recent-session entries. This keeps the home list fast and
/// prevents the persisted state from growing forever across months of work.
const MAX_RECENT_SESSIONS: usize = 80;

const RECENT_SESSION_PREVIEW_MAX_CHARS: usize = 90;

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
    // Per-pane file-server tokens, distinct from the control-socket `pane_tokens`.
    // A browser-overlay URL carries one of these in its path, so the loopback file
    // server can resolve which pane the request is for and scope the served roots to
    // that pane only (see `pane_for_file_token` / `pane_file_roots`).
    file_tokens: Mutex<HashMap<String, String>>,
    model: Mutex<Model>,
    transcript_tails: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    app_handle: Mutex<Option<AppHandle>>,
    // Persistence stays off until restore_session() runs so constructing a state
    // (notably in tests) never touches disk. Once enabled, every model mutation
    // snapshots to workspace_root/.qmux/state.json.
    persist_enabled: AtomicBool,
    exit_confirmed: AtomicBool,
    // Loopback file-server port, set once at startup. The control socket pairs it with
    // a per-pane file token to build browser-overlay URLs.
    file_server: Mutex<Option<u16>>,
}

#[derive(Default)]
struct Model {
    panes: HashMap<String, PaneRuntime>,
    pane_order: Vec<String>,
    /// Sidebar nesting depth per pane (0 = root). Source of truth for the tab tree;
    /// `ordered_panes` stamps it onto each returned `PaneInfo`. Absent id == depth 0.
    pane_depth: HashMap<String, u16>,
    pane_splits: Vec<PaneSplitInfo>,
    groups: HashMap<String, GroupInfo>,
    group_order: Vec<String>,
    agents: HashMap<String, AgentInfo>,
    turns: HashMap<String, Vec<Turn>>,
    agent_turn_queues: HashMap<String, VecDeque<QueuedTurn>>,
    agent_send_tracking: HashMap<String, AgentSendTracking>,
    agent_drafts: HashMap<String, String>,
    recent_sessions: HashMap<String, RecentSessionInfo>,
    /// Agents whose currently-running (just-sent) queued turn requested a pause; when
    /// that turn finishes the agent enters paused mode. Transient (not persisted).
    agent_pending_pause: HashSet<String>,
    /// Agents whose user is actively typing (in the composer or terminal). While set,
    /// the queue is not auto-drained on idle, so a finishing turn can't spam a queued
    /// message into what the user is typing. Set/cleared by the frontend (debounced);
    /// transient (not persisted).
    agent_typing: HashSet<String>,
    /// Agents with a queued turn currently being drained (claimed and mid-send).
    /// Serializes draining per agent: a turn is claimed under the model lock and the
    /// agent id inserted here, so a concurrent drain trigger (idle hook, wait release,
    /// typing-clear, unpause, …) can't pop and send a second turn in the window before
    /// the first send marks the agent Running. Cleared once the send settles. Transient
    /// (not persisted).
    agent_draining: HashSet<String>,
    /// Agent-session resumes queued at restore, keyed by the recovered shell pane id;
    /// each is drained by that pane's respawn. Transient (not persisted).
    shell_agent_resumes: HashMap<String, ShellAgentResume>,
    /// The selected frontend tab, persisted so restarts return to the same place.
    /// The value is either a pane id or the frontend's Home tab sentinel.
    active_tab_id: Option<String>,
    /// One-entry undo stack for an explicitly closed tab. Transient: a closed tab can
    /// be restored during the current app run, but it is not resurrected after restart.
    last_closed_pane: Option<ClosedPaneSnapshot>,
}

/// A pending request to resume an agent session inside a recovered shell pane.
/// Captured during `restore_session` for a shell pane whose agent was still bound at
/// shutdown — the wrapper clears the binding when the agent process exits, so a
/// still-bound agent means it was running live — and consumed once by the pane's
/// respawn, which injects the adapter's resume command (`claude --resume <id>`,
/// `codex resume <id>`) into the new shell. Transient: never persisted.
#[derive(Clone, Debug)]
pub struct ShellAgentResume {
    pub adapter: String,
    pub session_id: String,
    /// The agent's original launch directory. Claude/Codex scope sessions by project
    /// dir, so the respawn must reopen here for `--resume` to resolve the session — and
    /// for the rebind to match — even if the pane's live cwd has since drifted via `cd`.
    pub cwd: String,
}

#[derive(Clone, Debug)]
pub struct ClosedPaneAgentSnapshot {
    pub agent: AgentInfo,
    pub turns: Vec<Turn>,
    pub queued_turns: Vec<QueuedTurn>,
    pub draft: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ClosedPaneSnapshot {
    pub pane: PaneInfo,
    pub group: Option<GroupInfo>,
    pub agent: Option<ClosedPaneAgentSnapshot>,
    pub orphaned_agents: Vec<ClosedPaneAgentSnapshot>,
    pub index: usize,
    pub scrollback: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSessionInfo {
    pub id: String,
    pub adapter: String,
    pub group_id: Option<String>,
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
    pub worktree_dir: String,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub parent_id: Option<String>,
    pub fork_point: Option<String>,
    pub root_session_id: Option<String>,
    pub preview: Option<String>,
    #[serde(default)]
    pub line_count: usize,
    pub last_active_at: u128,
    pub created_at: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentStatus>,
    #[serde(default)]
    pub missing: bool,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurnWait {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A queued turn: the text to send plus optional directives controlling when it
/// should send. Deserializes from either a bare string (the legacy persisted format)
/// or a `{ text, pauseAfter, waitFor }` object, so old state still loads.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub text: String,
    pub pause_after: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_for: Option<QueuedTurnWait>,
}

impl QueuedTurn {
    pub fn new(text: String) -> Self {
        Self {
            text,
            pause_after: false,
            wait_for: None,
        }
    }

    pub fn waiting(text: String, wait_for: QueuedTurnWait) -> Self {
        Self {
            text,
            pause_after: false,
            wait_for: Some(wait_for),
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
                #[serde(default, rename = "waitFor")]
                wait_for: Option<QueuedTurnWait>,
            },
        }
        Ok(match Repr::deserialize(deserializer)? {
            Repr::Text(text) => QueuedTurn {
                text,
                pause_after: false,
                wait_for: None,
            },
            Repr::Full {
                text,
                pause_after,
                wait_for,
            } => QueuedTurn {
                text,
                pause_after,
                wait_for,
            },
        })
    }
}

/// Result of [`AppState::claim_ready_agent_turn`].
pub enum AgentTurnClaim {
    /// A ready turn was claimed and popped; the agent is now marked draining. The caller
    /// must send it and then call [`AppState::finish_agent_drain`].
    Ready { turn: QueuedTurn, pending: usize },
    /// Another drain already holds this agent; the caller must not send or change status.
    Draining,
    /// Nothing is ready to send (empty queue or the front turn is still waiting).
    Idle,
}

/// Result of [`AppState::claim_next_turn_or_mark_idle`].
pub enum IdleAdvance {
    /// A ready turn was claimed; the agent is marked draining and the caller must send it.
    Sent { turn: QueuedTurn, pending: usize },
    /// Another drain owns the agent; the caller must leave its status untouched.
    Busy,
    /// Nothing was sent; the agent has been settled to `Done` under the lock.
    Idle,
}

fn enqueue_queued_turn_locked(
    model: &mut Model,
    agent_id: &str,
    turn: QueuedTurn,
) -> Result<usize, String> {
    let queue = model
        .agent_turn_queues
        .entry(agent_id.to_string())
        .or_default();
    if queue.len() >= MAX_QUEUED_TURNS_PER_AGENT {
        return Err(format!(
            "turn queue is full ({MAX_QUEUED_TURNS_PER_AGENT} pending turns); wait for the agent to drain before queueing more"
        ));
    }
    queue.push_back(turn);
    Ok(queue.len())
}

fn wait_target_label_locked(model: &Model, target: &AgentInfo) -> Option<String> {
    target
        .pane_id
        .as_deref()
        .and_then(|pane_id| model.panes.get(pane_id))
        .map(|pane| pane.info.title.clone())
        .or_else(|| target.branch.clone())
        .or_else(|| target.model.clone())
}

fn queued_turn_wait_is_resolved_locked(model: &Model, wait_for: &QueuedTurnWait) -> bool {
    let Some(target) = model.agents.get(&wait_for.agent_id) else {
        // The target agent is gone entirely (e.g. its pane closed and the agent was
        // pruned). There is nothing left to wait on, so release the waiter rather than
        // block it on a ghost forever.
        return true;
    };
    // A Failed target keeps its waiters blocked, on purpose: "run this after X
    // finishes" must not silently fire when X errored out instead of completing.
    // Likewise an agent parked awaiting input or a permission prompt has not finished
    // its work, so its waiters stay blocked until it actually goes idle/done. These are
    // checked before the pane fallbacks below so a Failed target blocks even if its pane
    // binding was cleared — only the agent genuinely going away (above) releases a wait
    // on a failed target.
    if matches!(
        target.status,
        AgentStatus::Failed | AgentStatus::AwaitingInput | AgentStatus::AwaitingPermission
    ) {
        return false;
    }
    let Some(pane_id) = target.pane_id.as_deref() else {
        return true;
    };
    if !model.panes.contains_key(pane_id) {
        return true;
    }
    if model
        .agent_turn_queues
        .get(&target.id)
        .is_some_and(|queue| !queue.is_empty())
    {
        return false;
    }
    matches!(target.status, AgentStatus::Done | AgentStatus::Idle)
}

/// Pops the front queued turn for `agent_id` if it is ready to send — the queue is
/// non-empty and the front turn either has no wait dependency or its dependency has
/// resolved. Returns the popped turn and the remaining pending count, or `None` when
/// nothing is ready. Does not touch the draining guard; callers that serialize draining
/// manage that separately. Operates on an already-locked model.
fn pop_ready_locked(model: &mut Model, agent_id: &str) -> Option<(QueuedTurn, usize)> {
    let front_wait = {
        let queue = model.agent_turn_queues.get(agent_id)?;
        let front = queue.front()?;
        front.wait_for.clone()
    };
    if let Some(wait_for) = &front_wait
        && !queued_turn_wait_is_resolved_locked(model, wait_for)
    {
        return None;
    }
    let queue = model.agent_turn_queues.get_mut(agent_id)?;
    let turn = queue.pop_front()?;
    let pending_count = queue.len();
    if queue.is_empty() {
        model.agent_turn_queues.remove(agent_id);
        if let Some(agent) = model.agents.get_mut(agent_id) {
            agent.orphaned_queue_pane_id = None;
        }
    }
    Some((turn, pending_count))
}

fn sanitize_active_tab_id(tab_id: Option<String>) -> Option<String> {
    tab_id.and_then(|id| {
        let trimmed = id.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn wait_dependency_would_cycle_locked(model: &Model, source: &str, target: &str) -> bool {
    let mut seen = HashSet::new();
    let mut stack = vec![target.to_string()];
    while let Some(agent_id) = stack.pop() {
        if agent_id == source {
            return true;
        }
        if !seen.insert(agent_id.clone()) {
            continue;
        }
        if let Some(queue) = model.agent_turn_queues.get(&agent_id) {
            for turn in queue {
                let Some(wait_for) = turn.wait_for.as_ref() else {
                    continue;
                };
                if wait_for.agent_id == source
                    || !queued_turn_wait_is_resolved_locked(model, wait_for)
                {
                    stack.push(wait_for.agent_id.clone());
                }
            }
        }
    }
    false
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
    pub skip_scrollback_restore: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub id: String,
    pub title: String,
    pub kind: PaneKind,
    pub agent_id: Option<String>,
    pub group_id: String,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSplitInfo {
    pub id: String,
    pub pane_ids: Vec<String>,
    #[serde(default)]
    pub sizes: HashMap<String, f64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub intent: HashMap<String, PaneSplitIntent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSplitIntent {
    pub kind: String,
    pub anchor_pane_id: String,
    pub position: String,
    pub source: String,
    #[serde(default)]
    pub created_at: f64,
}

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
                file_tokens: Mutex::new(HashMap::new()),
                model: Mutex::new(Model::default()),
                transcript_tails: Mutex::new(HashSet::new()),
                next_id: AtomicU64::new(1),
                app_handle: Mutex::new(None),
                persist_enabled: AtomicBool::new(false),
                exit_confirmed: AtomicBool::new(false),
                file_server: Mutex::new(None),
            }),
        }
    }

    /// Records the loopback file server's port + access token (set once at startup).
    pub fn set_file_server(&self, port: u16) {
        if let Ok(mut slot) = self.inner.file_server.lock() {
            *slot = Some(port);
        }
    }

    pub fn file_server_port(&self) -> Option<u16> {
        self.inner.file_server.lock().ok().and_then(|slot| *slot)
    }

    /// The directory a newly-created group opens in when the caller doesn't give an
    /// explicit path: the user's home directory, else the qmux process cwd. The home step
    /// keeps a Finder/Dock launch — whose process cwd is the filesystem root — from
    /// opening shells at `/`.
    pub fn default_open_dir(&self) -> std::path::PathBuf {
        if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from)
            && home.is_dir()
        {
            return home;
        }
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"))
    }

    /// The working directory a newly opened shell should inherit from `pane_id`: the
    /// live cwd of that pane when it is a shell whose directory still exists. Agent
    /// panes (rooted in a worktree) and stale or missing directories yield `None`, so
    /// the caller falls back to `default_open_dir`.
    pub fn inheritable_shell_cwd(&self, pane_id: &str) -> Option<std::path::PathBuf> {
        let model = self.inner.model.lock().ok()?;
        let pane = model.panes.get(pane_id)?;
        if !matches!(pane.info.kind, PaneKind::Shell) {
            return None;
        }
        let cwd = std::path::PathBuf::from(&pane.info.cwd);
        cwd.is_dir().then_some(cwd)
    }

    /// Whether shells should run as login shells (sourcing the user's login
    /// profile files). Persisted in preferences; defaults to on when unset so a
    /// fresh install matches how terminal emulators launch shells. Read on the
    /// spawn path — including startup recovery, which runs before the frontend
    /// reconnects — so the persisted choice survives a restart.
    pub fn use_login_shell(&self) -> bool {
        persistence::load_preferences(&self.inner.config.workspace_root)
            .ok()
            .and_then(|prefs| prefs.use_login_shell)
            .unwrap_or(true)
    }

    /// Returns the file-server token scoped to a single pane, minting one on first use.
    /// This token rides in the path of the browser-overlay URLs that pane opens, so the
    /// loopback file server can map a request back to its pane and serve only that
    /// pane's roots (`pane_file_roots`) — never the union of every pane's directories.
    /// It is deliberately separate from the pane's control-socket token (`pane_token`):
    /// it lands in URLs that flow through the frontend, so its only authority is reading
    /// files under the one pane's roots, not driving the control socket.
    pub fn pane_file_token(&self, pane_id: &str) -> Result<String, String> {
        let mut tokens = self
            .inner
            .file_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = tokens.get(pane_id) {
            return Ok(existing.clone());
        }
        let token = random_token()?;
        Ok(tokens.entry(pane_id.to_string()).or_insert(token).clone())
    }

    /// Resolves the pane a presented file-server token belongs to, if any.
    pub fn pane_for_file_token(&self, token: &str) -> Option<String> {
        let tokens = self
            .inner
            .file_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        tokens
            .iter()
            .find_map(|(pane_id, pane_token)| (pane_token == token).then(|| pane_id.clone()))
    }

    /// Roots a `browser.open` from a specific pane may reach: the workspace root, that
    /// pane's own working directory, and (if it has one) its agent's worktree — not the
    /// union of every pane's cwd. This keeps one pane from opening files under another
    /// pane's directory, so an in-pane process can only render files within its own
    /// working area.
    pub fn pane_file_roots(&self, pane_id: &str) -> Vec<std::path::PathBuf> {
        let mut roots = vec![self.inner.config.workspace_root.clone()];
        if let Ok(model) = self.inner.model.lock() {
            if let Some(pane) = model.panes.get(pane_id) {
                if let Some(group) = model.groups.get(&pane.info.group_id) {
                    roots.push(std::path::PathBuf::from(&group.dir));
                }
                roots.push(std::path::PathBuf::from(&pane.info.cwd));
            }
            for agent in model.agents.values() {
                if agent.pane_id.as_deref() == Some(pane_id) {
                    roots.push(std::path::PathBuf::from(&agent.worktree_dir));
                }
            }
        }
        roots
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
        let active_tab_id = sanitize_active_tab_id(persisted.active_tab_id.clone());
        let shell_pane_ids = persisted
            .panes
            .iter()
            .filter(|&pane| matches!(pane.kind, PaneKind::Shell))
            .map(|pane| pane.id.clone())
            .collect::<HashSet<_>>();
        let queued_agent_ids = persisted
            .queues
            .iter()
            .filter(|&(_agent_id, turns)| !turns.is_empty())
            .map(|(agent_id, _turns)| agent_id.clone())
            .collect::<HashSet<_>>();

        if let Ok(mut model) = self.inner.model.lock() {
            for group in persisted.groups {
                if !model.group_order.iter().any(|id| id == &group.id) {
                    model.group_order.push(group.id.clone());
                }
                model.groups.insert(group.id.clone(), group);
            }
            if !persisted.group_order.is_empty() {
                let mut seen = HashSet::new();
                model.group_order = persisted
                    .group_order
                    .into_iter()
                    .filter(|id| model.groups.contains_key(id) && seen.insert(id.clone()))
                    .collect();
                let mut missing = model
                    .groups
                    .keys()
                    .filter(|id| !seen.contains(*id))
                    .cloned()
                    .collect::<Vec<_>>();
                missing.sort();
                model.group_order.extend(missing);
            }
            for mut agent in persisted.agents {
                if let Some(pane_id) = agent
                    .pane_id
                    .clone()
                    .filter(|pane_id| shell_pane_ids.contains(pane_id))
                {
                    // The agent was still bound to its shell pane at shutdown, so it was
                    // running live (the wrapper detaches on the agent process exiting).
                    // Queue a resume for the pane's respawn when the session is still
                    // recoverable, before clearing the now-stale binding.
                    if let Some(resume) = shell_agent_resume(&agent) {
                        model.shell_agent_resumes.insert(pane_id.clone(), resume);
                    }
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
            for session in persisted.recent_sessions {
                if !session.id.trim().is_empty() {
                    model.recent_sessions.insert(session.id.clone(), session);
                }
            }
            model.active_tab_id = active_tab_id;
            model.pane_splits = persisted.pane_splits;
            let now = now_millis();
            let agents = model.agents.values().cloned().collect::<Vec<_>>();
            for agent in &agents {
                upsert_recent_session_for_agent_locked(&mut model, agent, now, false);
            }
            prune_recent_sessions_locked(&mut model);
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
                group_order: ordered_group_ids(&model),
                agents: model.agents.values().cloned().collect(),
                queues: model
                    .agent_turn_queues
                    .iter()
                    .map(|(agent_id, queue)| (agent_id.clone(), queue.iter().cloned().collect()))
                    .collect(),
                recent_sessions: recent_sessions_sorted(&model),
                drafts: model.agent_drafts.clone(),
                pane_splits: normalized_pane_splits(&model, model.pane_splits.clone(), false)
                    .unwrap_or_default(),
                active_tab_id: model.active_tab_id.clone(),
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
        if let Ok(handle) = self.inner.app_handle.lock()
            && let Some(app_handle) = handle.as_ref()
        {
            let _ = app_handle.emit("qmux-event", event);
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

    pub fn active_tab_id(&self) -> Result<Option<String>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.active_tab_id.clone())
    }

    pub fn set_active_tab_id(&self, tab_id: Option<String>) -> Result<(), String> {
        let tab_id = sanitize_active_tab_id(tab_id);
        let changed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model.active_tab_id == tab_id {
                false
            } else {
                model.active_tab_id = tab_id;
                true
            }
        };
        if changed {
            self.persist();
        }
        Ok(())
    }

    pub fn pane_splits(&self) -> Result<Vec<PaneSplitInfo>, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        normalize_pane_splits_locked(&mut model);
        Ok(model.pane_splits.clone())
    }

    pub fn set_pane_splits(
        &self,
        splits: Vec<PaneSplitInfo>,
    ) -> Result<Vec<PaneSplitInfo>, String> {
        let normalized = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.pane_splits = normalized_pane_splits(&model, splits, true)?;
            model.pane_splits.clone()
        };
        self.persist();
        Ok(normalized)
    }

    pub fn list_groups(&self) -> Result<Vec<GroupInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(ordered_groups(&model))
    }

    pub fn list_agents(&self) -> Result<Vec<AgentInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agents.values().cloned().collect())
    }

    pub fn list_recent_sessions(&self, limit: usize) -> Result<Vec<RecentSessionInfo>, String> {
        let mut sessions = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            recent_sessions_sorted(&model)
                .into_iter()
                .map(|session| enrich_recent_session_locked(&model, session))
                .take(limit.min(MAX_RECENT_SESSIONS))
                .collect::<Vec<_>>()
        };

        for session in &mut sessions {
            session.missing = recent_session_missing(session);
        }
        Ok(sessions)
    }

    pub fn recent_session(&self, session_id: &str) -> Result<Option<RecentSessionInfo>, String> {
        let session = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model
                .recent_sessions
                .get(session_id)
                .cloned()
                .map(|session| enrich_recent_session_locked(&model, session))
        };
        Ok(session.map(|mut session| {
            session.missing = recent_session_missing(&session);
            session
        }))
    }

    /// Removes and returns the agent-session resume queued for `pane_id` at restore, if
    /// any. One-shot: consumed by the pane's respawn so a later relaunch of the same
    /// pane id never re-triggers it.
    pub fn take_shell_agent_resume(&self, pane_id: &str) -> Option<ShellAgentResume> {
        let mut model = self.inner.model.lock().ok()?;
        model.shell_agent_resumes.remove(pane_id)
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

    pub fn pane_group_id(&self, pane_id: &str) -> Result<Option<String>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .map(|runtime| runtime.info.group_id.clone()))
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

    pub fn pane_skips_scrollback_restore(&self, pane_id: &str) -> Result<Option<bool>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .map(|runtime| runtime.skip_scrollback_restore))
    }

    pub fn capture_last_closed_pane(&self, pane_id: &str) -> Result<(), String> {
        let mut snapshot = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let runtime = model
                .panes
                .get(pane_id)
                .ok_or_else(|| format!("pane {pane_id} was not found"))?;
            let ordered_ids = ordered_pane_ids(&model);
            let index = ordered_ids
                .iter()
                .position(|id| id == pane_id)
                .unwrap_or(ordered_ids.len());

            let mut pane = runtime.info.clone();
            pane.depth = model.pane_depth.get(pane_id).copied().unwrap_or(0);
            let group = model.groups.get(&pane.group_id).cloned();

            let group_pane_count = model
                .panes
                .values()
                .filter(|candidate| candidate.info.group_id == pane.group_id)
                .count();
            let closing_last_group_pane = group_pane_count == 1;
            let pane_agent_id = pane.agent_id.clone();
            let snapshot_agent = |agent: &AgentInfo| {
                let turns = model.turns.get(&agent.id).cloned().unwrap_or_default();
                let queued_turns = model
                    .agent_turn_queues
                    .get(&agent.id)
                    .map(|queue| queue.iter().cloned().collect())
                    .unwrap_or_default();
                let draft = model.agent_drafts.get(&agent.id).cloned();
                ClosedPaneAgentSnapshot {
                    agent: agent.clone(),
                    turns,
                    queued_turns,
                    draft,
                }
            };
            let agent = pane_agent_id
                .as_deref()
                .and_then(|agent_id| model.agents.get(agent_id))
                .or_else(|| {
                    model
                        .agents
                        .values()
                        .find(|agent| agent.pane_id.as_deref() == Some(pane_id))
                })
                .cloned()
                .map(|agent| snapshot_agent(&agent));
            let captured_agent_id = agent
                .as_ref()
                .map(|agent_snapshot| agent_snapshot.agent.id.as_str());
            let orphaned_agents = model
                .agents
                .values()
                .filter(|agent| Some(agent.id.as_str()) != captured_agent_id)
                .filter(|agent| {
                    agent.orphaned_queue_pane_id.as_deref() == Some(pane_id)
                        || (closing_last_group_pane
                            && agent.group_id == pane.group_id
                            && agent.pane_id.is_none())
                })
                // Only agents that still carry a queue are worth preserving across the
                // close: a queue-less one restores with no pane and no orphaned-queue
                // binding (see `restore_closed_pane_metadata`), an invisible, unreachable
                // agent. Such agents are pruned on close and stay resumable via recent
                // sessions instead.
                .filter(|agent| {
                    model
                        .agent_turn_queues
                        .get(&agent.id)
                        .is_some_and(|queue| !queue.is_empty())
                })
                .map(snapshot_agent)
                .collect();

            ClosedPaneSnapshot {
                pane,
                group,
                agent,
                orphaned_agents,
                index,
                scrollback: Vec::new(),
            }
        };

        snapshot.scrollback =
            match read_pane_scrollback(&self.inner.config.workspace_root, &snapshot.pane.id) {
                Ok(bytes) => bytes,
                Err(err) => {
                    eprintln!(
                        "qmux: failed to capture scrollback for closed pane {}: {err}",
                        snapshot.pane.id
                    );
                    Vec::new()
                }
            };

        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.last_closed_pane = Some(snapshot);
        Ok(())
    }

    pub fn take_last_closed_pane(&self) -> Result<Option<ClosedPaneSnapshot>, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.last_closed_pane.take())
    }

    pub fn remember_last_closed_pane(&self, snapshot: ClosedPaneSnapshot) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.last_closed_pane = Some(snapshot);
        Ok(())
    }

    pub fn clear_last_closed_pane_for_pane(&self, pane_id: &str) {
        if let Ok(mut model) = self.inner.model.lock()
            && model
                .last_closed_pane
                .as_ref()
                .is_some_and(|snapshot| snapshot.pane.id == pane_id)
        {
            model.last_closed_pane = None;
        }
    }

    pub fn clear_last_closed_pane_for_agent(&self, agent_id: &str) {
        if let Ok(mut model) = self.inner.model.lock()
            && model
                .last_closed_pane
                .as_ref()
                .and_then(|snapshot| snapshot.agent.as_ref())
                .is_some_and(|agent_snapshot| agent_snapshot.agent.id == agent_id)
        {
            model.last_closed_pane = None;
        }
    }

    pub fn restore_closed_pane_metadata(
        &self,
        snapshot: &ClosedPaneSnapshot,
    ) -> Result<(), String> {
        if matches!(snapshot.pane.kind, PaneKind::Agent) && snapshot.agent.is_none() {
            return Err(format!(
                "closed agent pane {} is missing its agent",
                snapshot.pane.id
            ));
        }

        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if !model.groups.contains_key(&snapshot.pane.group_id)
                && let Some(group) = snapshot.group.clone()
            {
                let group_id = group.id.clone();
                model.groups.insert(group_id.clone(), group);
                if !model.group_order.iter().any(|id| id == &group_id) {
                    model.group_order.push(group_id);
                }
            }
            model.shell_agent_resumes.remove(&snapshot.pane.id);

            if let Some(agent_snapshot) = &snapshot.agent {
                restore_closed_agent_snapshot_locked(
                    &mut model,
                    &snapshot.pane,
                    agent_snapshot,
                    matches!(snapshot.pane.kind, PaneKind::Agent),
                    matches!(snapshot.pane.kind, PaneKind::Shell),
                );
            }
            for agent_snapshot in &snapshot.orphaned_agents {
                restore_closed_agent_snapshot_locked(
                    &mut model,
                    &snapshot.pane,
                    agent_snapshot,
                    false,
                    false,
                );
            }
        }
        self.persist();
        Ok(())
    }

    pub fn place_restored_pane(
        &self,
        pane_id: &str,
        index: usize,
        depth: u16,
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

            let mut ids = ordered_pane_ids(&model);
            ids.retain(|id| id != pane_id);
            ids.insert(index.min(ids.len()), pane_id.to_string());
            model.pane_order = ids;
            if depth == 0 {
                model.pane_depth.remove(pane_id);
            } else {
                model.pane_depth.insert(pane_id.to_string(), depth);
            }
            normalize_pane_depths(&mut model);
            normalize_pane_splits_locked(&mut model);
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// True when `pane_id` is the only remaining pane in its group and that group still
    /// owns an agent with queued turns. Removing such a pane prunes the group's agents
    /// (closing the group with it), so a caller that does not first capture a close
    /// snapshot — the natural PTY-exit path, unlike `kill_pane` — would discard that
    /// pending work irrecoverably. Used to decide whether to snapshot before removal.
    pub fn closing_pane_would_strand_queued_work(&self, pane_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(group_id) = model
            .panes
            .get(pane_id)
            .map(|pane| pane.info.group_id.clone())
        else {
            return Ok(false);
        };
        let is_last_pane = !model
            .panes
            .values()
            .any(|other| other.info.id != pane_id && other.info.group_id == group_id);
        if !is_last_pane {
            return Ok(false);
        }
        let has_queued_work = model.agents.values().any(|agent| {
            agent.group_id == group_id
                && model
                    .agent_turn_queues
                    .get(&agent.id)
                    .is_some_and(|queue| !queue.is_empty())
        });
        Ok(has_queued_work)
    }

    pub fn remove_pane(&self, pane_id: &str) -> Result<(), String> {
        let removed_group_id = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let removed_group_id = model
                .panes
                .get(pane_id)
                .map(|pane| pane.info.group_id.clone());
            model.panes.remove(pane_id);
            model.pane_order.retain(|id| id != pane_id);

            // The pane is gone for good (kill or PTY EOF — never a respawn), so reclaim
            // the agent it owned and its per-agent state, which would otherwise live for
            // the rest of the process. Always drop the purely-runtime tracking; if the
            // agent has no queued turns, drop it entirely (its transcript tail then
            // self-stops, since `tail_should_continue` is false once the agent is gone).
            // An agent with queued turns is kept so its queue stays restart-recoverable
            // via the orphaned-queue panel.
            if let Some(agent_id) = model
                .agents
                .values()
                .find(|agent| agent.pane_id.as_deref() == Some(pane_id))
                .map(|agent| agent.id.clone())
            {
                if let Some(agent) = model.agents.get(&agent_id).cloned() {
                    upsert_recent_session_for_agent_locked(&mut model, &agent, now_millis(), true);
                }
                clear_recent_session_binding_locked(&mut model, Some(&agent_id), Some(pane_id));
                model.agent_typing.remove(&agent_id);
                model.agent_pending_pause.remove(&agent_id);
                model.agent_draining.remove(&agent_id);
                model.agent_send_tracking.remove(&agent_id);
                let has_queue = model
                    .agent_turn_queues
                    .get(&agent_id)
                    .is_some_and(|queue| !queue.is_empty());
                if !has_queue {
                    model.agents.remove(&agent_id);
                    model.turns.remove(&agent_id);
                    model.agent_drafts.remove(&agent_id);
                    model.agent_turn_queues.remove(&agent_id);
                }
            }

            // Re-level any children orphaned by the removal so the tree stays valid
            // (a closed parent must not leave its children at an unreachable depth).
            normalize_pane_depths(&mut model);
            normalize_pane_splits_locked(&mut model);
            removed_group_id
                .filter(|group_id| remove_group_without_open_panes_locked(&mut model, group_id))
        };
        // The pane's control-socket token is captured by its in-pane process as
        // QMUX_TOKEN; once the pane is gone for good it can never legitimately be used
        // again, so drop it rather than leave a live credential resolving (via
        // `pane_for_token`) to a pane that no longer exists. Separate lock from `model`.
        if let Ok(mut tokens) = self.inner.pane_tokens.lock() {
            tokens.remove(pane_id);
        }
        // The pane's file-server token can never be used again once the pane is gone
        // (it resolves only via `pane_for_file_token`), so reclaim it rather than let
        // a live credential outlive the pane it scopes. Separate lock from `model`.
        if let Ok(mut tokens) = self.inner.file_tokens.lock() {
            tokens.remove(pane_id);
        }
        if let Err(err) = remove_pane_scrollback(&self.inner.config.workspace_root, pane_id) {
            eprintln!("qmux: failed to remove scrollback for pane {pane_id}: {err}");
        }
        self.persist();
        if let Some(group_id) = removed_group_id {
            self.emit(QmuxEvent::new(
                "group.removed",
                None,
                None,
                json!({ "groupId": group_id }),
            ));
        }
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
            normalize_pane_splits_locked(&mut model);
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
            let mut prev_depth_by_group: HashMap<String, u16> = HashMap::new();
            for entry in &layout {
                if !seen.insert(entry.pane_id.clone()) {
                    return Err("pane layout contains a duplicate pane".to_string());
                }
                let Some(pane) = model.panes.get(&entry.pane_id) else {
                    return Err(format!("pane {} was not found", entry.pane_id));
                };
                if entry.depth > MAX_PANE_DEPTH {
                    return Err(format!(
                        "pane depth {} exceeds the maximum of {MAX_PANE_DEPTH}",
                        entry.depth
                    ));
                }
                let group_id = pane.info.group_id.clone();
                let ceiling = prev_depth_by_group
                    .get(&group_id)
                    .map_or(0, |prev| prev + 1);
                if entry.depth > ceiling {
                    return Err(
                        "pane layout is not a valid tree (a depth skips a level)".to_string()
                    );
                }
                prev_depth_by_group.insert(group_id, entry.depth);
            }

            model.pane_order = layout.iter().map(|entry| entry.pane_id.clone()).collect();
            model.pane_depth = layout
                .iter()
                .filter(|entry| entry.depth != 0)
                .map(|entry| (entry.pane_id.clone(), entry.depth))
                .collect();
            normalize_pane_splits_locked(&mut model);
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
            normalize_pane_splits_locked(&mut model);
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// Moves `pane_id` to sit immediately after `sibling_pane_id` at the same depth
    /// (a sibling, not a child), then re-levels the tree. Used when a fork should
    /// appear as a new tab right after the session it forked from.
    pub fn place_pane_after(
        &self,
        pane_id: &str,
        sibling_pane_id: &str,
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
            if !model.panes.contains_key(sibling_pane_id) {
                return Err(format!("pane {sibling_pane_id} was not found"));
            }

            let mut ids = ordered_pane_ids(&model);
            ids.retain(|id| id != pane_id);
            let sibling_index = ids
                .iter()
                .position(|id| id == sibling_pane_id)
                .ok_or_else(|| format!("pane {sibling_pane_id} was not found"))?;
            ids.insert(sibling_index + 1, pane_id.to_string());

            let sibling_depth = model.pane_depth.get(sibling_pane_id).copied().unwrap_or(0);
            model.pane_order = ids;
            model.pane_depth.insert(pane_id.to_string(), sibling_depth);
            normalize_pane_depths(&mut model);
            normalize_pane_splits_locked(&mut model);
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
            normalize_pane_splits_locked(&mut model);
        }
        self.persist();
    }

    pub fn insert_group_after(
        &self,
        group: GroupInfo,
        after_group_id: Option<&str>,
    ) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let group_id = group.id.clone();
            let is_new = !model.groups.contains_key(&group_id);
            model.groups.insert(group_id.clone(), group);
            if is_new {
                model.group_order.retain(|id| id != &group_id);
                if let Some(after_group_id) = after_group_id
                    && let Some(index) =
                        model.group_order.iter().position(|id| id == after_group_id)
                {
                    model.group_order.insert(index + 1, group_id);
                } else {
                    model.group_order.push(group_id);
                }
            }
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
            let now = now_millis();
            upsert_recent_session_for_agent_locked(&mut model, &agent, now, true);
            prune_recent_sessions_locked(&mut model);
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
            if !model.group_order.iter().any(|id| id == &group.id) {
                model.group_order.push(group.id.clone());
            }
            model.groups.insert(group.id.clone(), group);
        }
        self.persist();
        Ok(())
    }

    pub fn remove_group(&self, group_id: &str) -> Result<(), String> {
        let removed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model
                .panes
                .values()
                .any(|pane| pane.info.group_id == group_id)
            {
                return Err("group still has open panes".to_string());
            }
            remove_group_without_open_panes_locked(&mut model, group_id)
        };
        if removed {
            self.persist();
            self.emit(QmuxEvent::new(
                "group.removed",
                None,
                None,
                json!({ "groupId": group_id }),
            ));
        }
        Ok(())
    }

    pub fn update_agent(&self, agent: AgentInfo) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let now = now_millis();
            upsert_recent_session_for_agent_locked(&mut model, &agent, now, true);
            prune_recent_sessions_locked(&mut model);
            model.agents.insert(agent.id.clone(), agent);
        }
        self.persist();
        Ok(())
    }

    /// Mutates an agent in place under the lock, applying `f` to the live entry and
    /// leaving every field `f` doesn't touch exactly as it stands. Unlike `update_agent`
    /// (which inserts a whole struct snapshot the caller read earlier, outside the lock),
    /// this can't clobber a field a concurrent writer set in the meantime — e.g. the
    /// `session_id` / `transcript_path` a freshly spawned agent's SessionStart hook
    /// records on another thread while `attach_agent_pane` is binding its pane. Returns
    /// the updated agent, or `None` if it no longer exists.
    pub fn mutate_agent<F>(&self, agent_id: &str, f: F) -> Result<Option<AgentInfo>, String>
    where
        F: FnOnce(&mut AgentInfo),
    {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            match model.agents.get_mut(agent_id) {
                Some(agent) => {
                    f(agent);
                    let updated = agent.clone();
                    let now = now_millis();
                    upsert_recent_session_for_agent_locked(&mut model, &updated, now, true);
                    prune_recent_sessions_locked(&mut model);
                    Some(updated)
                }
                None => None,
            }
        };
        if updated.is_some() {
            self.persist();
        }
        Ok(updated)
    }

    /// Field-scoped status write — a thin wrapper over [`AppState::mutate_agent`] that
    /// touches only `status`. Returns the updated agent, or `None` if it no longer
    /// exists.
    pub fn set_agent_status(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> Result<Option<AgentInfo>, String> {
        self.mutate_agent(agent_id, |agent| agent.status = status)
    }

    pub fn append_turn(&self, turn: Turn) -> Result<(), String> {
        let should_persist_recent = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let agent_id = turn.agent_id.clone();
            let is_user_turn = turn.role == "user";
            let turns = model.turns.entry(agent_id.clone()).or_default();
            turns.push(turn);
            if turns.len() > MAX_TURNS_PER_AGENT {
                let overflow = turns.len() - MAX_TURNS_PER_AGENT;
                turns.drain(..overflow);
            }
            if is_user_turn {
                model.agents.get(&agent_id).cloned().is_some_and(|agent| {
                    upsert_recent_session_for_agent_locked(&mut model, &agent, now_millis(), true)
                })
            } else {
                false
            }
        };
        if should_persist_recent {
            self.persist();
        }
        Ok(())
    }

    pub fn replace_turns(&self, agent_id: &str, mut turns: Vec<Turn>) -> Result<(), String> {
        let should_persist_recent = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if turns.len() > MAX_TURNS_PER_AGENT {
                let overflow = turns.len() - MAX_TURNS_PER_AGENT;
                turns.drain(..overflow);
            }
            model.turns.insert(agent_id.to_string(), turns);
            model.agents.get(agent_id).cloned().is_some_and(|agent| {
                upsert_recent_session_for_agent_locked(&mut model, &agent, now_millis(), true)
            })
        };
        if should_persist_recent {
            self.persist();
        }
        Ok(())
    }

    pub fn enqueue_agent_turn(&self, agent_id: &str, data: String) -> Result<usize, String> {
        self.enqueue_agent_queued_turn(agent_id, QueuedTurn::new(data))
    }

    pub fn enqueue_agent_wait_turn_with_target_label(
        &self,
        agent_id: &str,
        data: String,
        wait_for_agent_id: &str,
        wait_for_pane_id: Option<&str>,
        wait_for_label: Option<&str>,
    ) -> Result<usize, String> {
        if agent_id == wait_for_agent_id {
            return Err("a queued turn cannot wait on its own agent".to_string());
        }

        let len = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;

            if !model.agents.contains_key(agent_id) {
                return Err(format!("agent {agent_id} was not found"));
            }
            let target = model
                .agents
                .get(wait_for_agent_id)
                .ok_or_else(|| format!("agent {wait_for_agent_id} was not found"))?;
            if wait_dependency_would_cycle_locked(&model, agent_id, wait_for_agent_id) {
                return Err("that wait would create a queue dependency cycle".to_string());
            }

            let supplied_label = wait_for_pane_id.and_then(|pane_id| {
                if target.pane_id.as_deref() != Some(pane_id) {
                    return None;
                }
                wait_for_label
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
                    .map(ToString::to_string)
            });
            let label = supplied_label.or_else(|| wait_target_label_locked(&model, target));
            let wait_for = QueuedTurnWait {
                agent_id: wait_for_agent_id.to_string(),
                pane_id: target.pane_id.clone(),
                label,
            };
            enqueue_queued_turn_locked(&mut model, agent_id, QueuedTurn::waiting(data, wait_for))?
        };
        self.persist();
        Ok(len)
    }

    fn enqueue_agent_queued_turn(&self, agent_id: &str, turn: QueuedTurn) -> Result<usize, String> {
        let len = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            enqueue_queued_turn_locked(&mut model, agent_id, turn)?
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
            if let Some(expected_text) = expected_text
                && turn.text != expected_text
            {
                return Err("queued turn changed; refresh before updating".to_string());
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
    ) -> Result<(QueuedTurn, Vec<QueuedTurn>), String> {
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
            if let Some(expected_data) = expected_data
                && current.text != expected_data
            {
                return Err("queued turn changed; refresh before editing".to_string());
            }

            let removed = queue
                .remove(index)
                .ok_or_else(|| format!("queued turn {index} was not found"))?;
            if index == 0
                && removed
                    .wait_for
                    .as_ref()
                    .is_some_and(|wait_for| wait_for.agent_id != agent_id)
                && let Some(next) = queue.front_mut()
            {
                next.wait_for = removed.wait_for.clone();
            }
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

    /// Claims the next ready queued turn for draining, marking the agent as draining so
    /// no concurrent trigger can claim a second turn until [`finish_agent_drain`] runs.
    /// Returns [`AgentTurnClaim::Draining`] when another drain already holds the agent,
    /// [`AgentTurnClaim::Idle`] when nothing is ready, else [`AgentTurnClaim::Ready`]
    /// with the popped turn. The check-and-claim is atomic under the model lock, which
    /// is what prevents the double-send race.
    pub fn claim_ready_agent_turn(&self, agent_id: &str) -> Result<AgentTurnClaim, String> {
        let claim = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model.agent_draining.contains(agent_id) {
                return Ok(AgentTurnClaim::Draining);
            }
            match pop_ready_locked(&mut model, agent_id) {
                Some((turn, pending)) => {
                    model.agent_draining.insert(agent_id.to_string());
                    AgentTurnClaim::Ready { turn, pending }
                }
                None => return Ok(AgentTurnClaim::Idle),
            }
        };
        self.persist();
        Ok(claim)
    }

    /// The idle-handler variant of [`claim_ready_agent_turn`]: atomically decides, under
    /// the model lock, what an agent going idle should do. Returns `Busy` when another
    /// drain already owns the agent (the caller must not touch its status); `Sent` after
    /// claiming a ready turn for the caller to send; or `Idle` after settling the agent
    /// to `Done`. Crucially the typing check and the `Done` write happen under the same
    /// lock, so a racing `set_agent_typing(false)` that clears the flag and re-reads the
    /// status observes `Done` and drains the held turn — closing the lost-wakeup where
    /// it would otherwise see a stale `Running`, skip its drain, and strand the queue.
    pub fn claim_next_turn_or_mark_idle(&self, agent_id: &str) -> Result<IdleAdvance, String> {
        let outcome = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model.agent_draining.contains(agent_id) {
                // Another drain is mid-send; it owns the status transition. Leave the
                // agent untouched (do not persist) so we can't clobber its Running.
                return Ok(IdleAdvance::Busy);
            }
            if model.agent_typing.contains(agent_id) {
                // User is mid-keystroke: hold the queue and settle to idle, atomically
                // with reading the typing flag (see the doc comment).
                if let Some(agent) = model.agents.get_mut(agent_id) {
                    agent.status = AgentStatus::Done;
                }
                IdleAdvance::Idle
            } else if let Some((turn, pending)) = pop_ready_locked(&mut model, agent_id) {
                model.agent_draining.insert(agent_id.to_string());
                IdleAdvance::Sent { turn, pending }
            } else {
                if let Some(agent) = model.agents.get_mut(agent_id) {
                    agent.status = AgentStatus::Done;
                }
                IdleAdvance::Idle
            }
        };
        self.persist();
        Ok(outcome)
    }

    /// Clears the draining guard set by a successful claim, allowing the next drain to
    /// proceed. Best-effort: a poisoned lock just leaves the guard set, which fails safe
    /// (no further auto-drain) rather than risking a double-send.
    pub fn finish_agent_drain(&self, agent_id: &str) {
        if let Ok(mut model) = self.inner.model.lock() {
            model.agent_draining.remove(agent_id);
        }
    }

    /// Test-only direct pop of the next ready turn (no draining guard), used to assert
    /// wait-resolution semantics without the serialized-drain bookkeeping.
    #[cfg(test)]
    pub fn pop_ready_agent_turn(
        &self,
        agent_id: &str,
    ) -> Result<Option<(QueuedTurn, usize)>, String> {
        let popped = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            match pop_ready_locked(&mut model, agent_id) {
                Some(result) => result,
                None => return Ok(None),
            }
        };
        self.persist();
        Ok(Some(popped))
    }

    pub fn agents_with_front_wait_for(&self, target_agent_id: &str) -> Result<Vec<String>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agent_turn_queues
            .iter()
            .filter_map(|(agent_id, queue)| {
                let waits_for_target = queue
                    .front()
                    .and_then(|turn| turn.wait_for.as_ref())
                    .is_some_and(|wait| wait.agent_id == target_agent_id);
                waits_for_target.then(|| agent_id.clone())
            })
            .collect())
    }

    pub fn prepend_agent_turn(&self, agent_id: &str, turn: QueuedTurn) -> Result<usize, String> {
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
            queue.push_front(turn);
            queue.len()
        };
        self.persist();
        Ok(len)
    }

    /// Inserts a turn into an agent's queue at `index` (clamped to the queue length),
    /// returning the new length. Used to roll a moved turn back to its original spot
    /// when handing it to another agent fails (preserving its queue directives).
    pub fn insert_agent_turn_at(
        &self,
        agent_id: &str,
        index: usize,
        turn: QueuedTurn,
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
            queue.insert(at, turn);
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

    /// Records whether the user is actively typing for an agent; while set, the idle
    /// handler holds off auto-draining the queue.
    pub fn set_agent_typing(&self, agent_id: &str, typing: bool) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if typing {
            model.agent_typing.insert(agent_id.to_string());
        } else {
            model.agent_typing.remove(agent_id);
        }
        Ok(())
    }

    pub fn agent_is_typing(&self, agent_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agent_typing.contains(agent_id))
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

    pub fn agent_has_outstanding_send_source(
        &self,
        agent_id: &str,
        source: AgentSendSource,
    ) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agent_send_tracking
            .get(agent_id)
            .is_some_and(|tracking| {
                tracking
                    .outstanding_sends
                    .iter()
                    .any(|send| send.source == source)
            }))
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
        // The cwd becomes a file-server root (see `pane_file_roots`), so only accept
        // a value that names a real directory. A legitimate shell-integration report
        // is always an existing absolute directory; rejecting anything else keeps a
        // malformed or non-existent path (or a plain file) from being installed as a
        // servable root. (This intentionally does not constrain *which* directory —
        // panes legitimately run in arbitrary project dirs outside the workspace.)
        let candidate = std::path::Path::new(&cwd);
        if !candidate.is_absolute() {
            return Err("pane cwd must be an absolute path; refusing to persist".to_string());
        }
        if !candidate.is_dir() {
            return Err("pane cwd is not an existing directory; refusing to persist".to_string());
        }
        let changed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            match model.panes.get_mut(pane_id) {
                Some(pane) if pane.info.cwd != cwd => {
                    pane.info.cwd = cwd.clone();
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist();
            // Persisting alone makes the cwd survive a restart, but the live UI only
            // learns a pane's cwd at spawn and on a full pane-list refetch. Without
            // this event a tab's shown directory (and the context-menu working dir)
            // would stay pinned to the spawn-time cwd for the rest of the session,
            // only catching up on the next full load (e.g. a restart). Emit a
            // surgical update so each tab tracks the directory it is actually in.
            self.emit(QmuxEvent::new(
                "pane.cwd_changed",
                Some(pane_id.to_string()),
                None,
                json!({ "paneId": pane_id, "cwd": cwd }),
            ));
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

    pub fn set_pane_recovered(&self, pane_id: &str, recovered: bool) -> Result<(), String> {
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
            pane.info.recovered = recovered;
        }
        self.persist();
        Ok(())
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

/// Builds a resume request for an agent that was bound to a shell pane at shutdown,
/// when its session is still resumable. Requires a non-empty session id and skips a
/// session whose recorded transcript file no longer exists, since resuming a deleted
/// session would just error out in the new shell.
fn shell_agent_resume(agent: &AgentInfo) -> Option<ShellAgentResume> {
    let session_id = agent
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    if let Some(transcript_path) = agent.transcript_path.as_deref()
        && !std::path::Path::new(transcript_path).exists()
    {
        return None;
    }
    Some(ShellAgentResume {
        adapter: agent.adapter.clone(),
        session_id: session_id.to_string(),
        cwd: agent.worktree_dir.clone(),
    })
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

pub(crate) fn recent_session_key(
    adapter: &str,
    session_id: Option<&str>,
    transcript_path: Option<&str>,
) -> Option<String> {
    if let Some(session_id) = session_id.map(str::trim).filter(|id| !id.is_empty()) {
        return Some(format!("{adapter}:session:{session_id}"));
    }
    transcript_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| format!("{adapter}:transcript:{path}"))
}

fn agent_recent_session_key(agent: &AgentInfo) -> Option<String> {
    recent_session_key(
        &agent.adapter,
        agent.session_id.as_deref(),
        agent.transcript_path.as_deref(),
    )
}

fn upsert_recent_session_for_agent_locked(
    model: &mut Model,
    agent: &AgentInfo,
    now: u128,
    touch: bool,
) -> bool {
    let Some(key) = agent_recent_session_key(agent) else {
        return false;
    };

    if agent
        .session_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty())
        && let Some(transcript_path) = agent.transcript_path.as_deref()
        && let Some(transcript_key) =
            recent_session_key(&agent.adapter, None, Some(transcript_path))
        && transcript_key != key
    {
        model.recent_sessions.remove(&transcript_key);
    }

    let existing = model.recent_sessions.get(&key).cloned();
    let turns = model.turns.get(&agent.id);
    let turn_preview = turns.and_then(|turns| first_user_turn_preview(turns));
    let mut line_count = turns.map(Vec::len).unwrap_or(0);
    let mut preview = turn_preview.or_else(|| {
        existing
            .as_ref()
            .and_then(|session| session.preview.clone())
    });

    if (preview.is_none() || line_count == 0)
        && let Some(transcript_path) = agent.transcript_path.as_deref()
    {
        let (disk_preview, disk_line_count) =
            read_transcript_meta(std::path::Path::new(transcript_path));
        if preview.is_none() {
            preview = disk_preview;
        }
        if line_count == 0 {
            line_count = disk_line_count;
        }
    }

    if line_count == 0 {
        line_count = existing
            .as_ref()
            .map(|session| session.line_count)
            .unwrap_or(0);
    }

    let created_at = existing
        .as_ref()
        .map(|session| session.created_at)
        .unwrap_or(agent.created_at);
    let last_active_at = if touch {
        now
    } else {
        existing
            .as_ref()
            .map(|session| session.last_active_at)
            .unwrap_or(agent.created_at)
    };

    let next = RecentSessionInfo {
        id: key.clone(),
        adapter: agent.adapter.clone(),
        group_id: Some(agent.group_id.clone()),
        session_id: agent.session_id.clone(),
        transcript_path: agent.transcript_path.clone(),
        worktree_dir: agent.worktree_dir.clone(),
        branch: agent.branch.clone(),
        model: agent.model.clone(),
        parent_id: agent.parent_id.clone(),
        fork_point: agent.fork_point.clone(),
        root_session_id: agent.root_session_id.clone(),
        preview,
        line_count,
        last_active_at,
        created_at,
        pane_id: agent.pane_id.clone(),
        agent_id: Some(agent.id.clone()),
        status: Some(agent.status),
        missing: false,
    };

    if existing.as_ref() == Some(&next) {
        return false;
    }
    model.recent_sessions.insert(key, next);
    true
}

fn clear_recent_session_binding_locked(
    model: &mut Model,
    agent_id: Option<&str>,
    pane_id: Option<&str>,
) {
    for session in model.recent_sessions.values_mut() {
        if agent_id.is_some_and(|agent_id| session.agent_id.as_deref() == Some(agent_id))
            || pane_id.is_some_and(|pane_id| session.pane_id.as_deref() == Some(pane_id))
        {
            session.agent_id = None;
            session.pane_id = None;
            session.status = None;
        }
    }
}

fn enrich_recent_session_locked(
    model: &Model,
    mut session: RecentSessionInfo,
) -> RecentSessionInfo {
    session.agent_id = None;
    session.pane_id = None;
    session.status = None;

    if let Some(agent) = model
        .agents
        .values()
        .find(|agent| recent_session_matches_agent(&session, agent) && agent.pane_id.is_some())
        .or_else(|| {
            model
                .agents
                .values()
                .find(|agent| recent_session_matches_agent(&session, agent))
        })
    {
        session.agent_id = Some(agent.id.clone());
        session.pane_id = agent.pane_id.clone();
        session.status = Some(agent.status);
        session.worktree_dir = agent.worktree_dir.clone();
        session.branch = agent.branch.clone();
        session.model = agent.model.clone();
    }

    session
}

fn recent_session_matches_agent(session: &RecentSessionInfo, agent: &AgentInfo) -> bool {
    if session.adapter != agent.adapter {
        return false;
    }
    match (session.session_id.as_deref(), agent.session_id.as_deref()) {
        (Some(left), Some(right)) if !left.trim().is_empty() && left == right => return true,
        _ => {}
    }
    match (
        session.transcript_path.as_deref(),
        agent.transcript_path.as_deref(),
    ) {
        (Some(left), Some(right)) if !left.trim().is_empty() && left == right => true,
        _ => false,
    }
}

fn recent_session_missing(session: &RecentSessionInfo) -> bool {
    if session.pane_id.is_some() {
        return false;
    }
    if !std::path::Path::new(&session.worktree_dir).is_dir() {
        return true;
    }
    session
        .transcript_path
        .as_deref()
        .is_some_and(|path| !std::path::Path::new(path).is_file())
}

fn recent_sessions_sorted(model: &Model) -> Vec<RecentSessionInfo> {
    let mut sessions = model.recent_sessions.values().cloned().collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        right
            .last_active_at
            .cmp(&left.last_active_at)
            .then(right.created_at.cmp(&left.created_at))
            .then(left.id.cmp(&right.id))
    });
    sessions
}

fn prune_recent_sessions_locked(model: &mut Model) {
    let keep = recent_sessions_sorted(model)
        .into_iter()
        .take(MAX_RECENT_SESSIONS)
        .map(|session| session.id)
        .collect::<HashSet<_>>();
    model
        .recent_sessions
        .retain(|session_id, _session| keep.contains(session_id));
}

fn first_user_turn_preview(turns: &[Turn]) -> Option<String> {
    turns
        .iter()
        .filter(|turn| turn.role == "user")
        .find_map(|turn| {
            turn.blocks.iter().find_map(|block| match block {
                crate::transcript::TurnBlock::Text { text } => preview_text(text),
                _ => None,
            })
        })
}

fn preview_text(raw: &str) -> Option<String> {
    let normalized = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return None;
    }
    let chars = normalized.chars().collect::<Vec<_>>();
    if chars.len() <= RECENT_SESSION_PREVIEW_MAX_CHARS {
        return Some(normalized);
    }
    Some(
        chars
            .into_iter()
            .take(RECENT_SESSION_PREVIEW_MAX_CHARS.saturating_sub(3))
            .collect::<String>()
            .trim_end()
            .to_string()
            + "...",
    )
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

fn ordered_group_ids(model: &Model) -> Vec<String> {
    let mut ids = Vec::with_capacity(model.groups.len());
    let mut seen = HashSet::with_capacity(model.groups.len());

    for group_id in &model.group_order {
        if model.groups.contains_key(group_id) && seen.insert(group_id.clone()) {
            ids.push(group_id.clone());
        }
    }

    let mut missing_from_order = model
        .groups
        .keys()
        .filter(|group_id| !seen.contains(*group_id))
        .cloned()
        .collect::<Vec<_>>();
    missing_from_order.sort();
    ids.extend(missing_from_order);
    ids
}

fn ordered_groups(model: &Model) -> Vec<GroupInfo> {
    ordered_group_ids(model)
        .into_iter()
        .filter_map(|group_id| model.groups.get(&group_id).cloned())
        .collect()
}

fn restore_closed_agent_snapshot_locked(
    model: &mut Model,
    pane: &PaneInfo,
    agent_snapshot: &ClosedPaneAgentSnapshot,
    attach_to_pane: bool,
    queue_shell_resume: bool,
) {
    let mut agent = agent_snapshot.agent.clone();
    if attach_to_pane {
        agent.pane_id = Some(pane.id.clone());
        agent.orphaned_queue_pane_id = None;
    } else {
        let has_queue = !agent_snapshot.queued_turns.is_empty();
        agent.pane_id = None;
        agent.orphaned_queue_pane_id = has_queue.then(|| pane.id.clone());
        agent.status = AgentStatus::Idle;
    }

    if queue_shell_resume && let Some(resume) = shell_agent_resume(&agent) {
        model.shell_agent_resumes.insert(pane.id.clone(), resume);
    }

    let agent_id = agent.id.clone();
    model.agents.insert(agent_id.clone(), agent);
    if agent_snapshot.turns.is_empty() {
        model.turns.remove(&agent_id);
    } else {
        model
            .turns
            .insert(agent_id.clone(), agent_snapshot.turns.clone());
    }
    if agent_snapshot.queued_turns.is_empty() {
        model.agent_turn_queues.remove(&agent_id);
    } else {
        model.agent_turn_queues.insert(
            agent_id.clone(),
            agent_snapshot.queued_turns.iter().cloned().collect(),
        );
    }
    match agent_snapshot
        .draft
        .clone()
        .filter(|draft| !draft.trim().is_empty())
    {
        Some(draft) => {
            model.agent_drafts.insert(agent_id, draft);
        }
        None => {
            model.agent_drafts.remove(&agent_id);
        }
    }
}

fn prune_agent_locked(model: &mut Model, agent_id: &str) {
    if let Some(agent) = model.agents.get(agent_id).cloned() {
        upsert_recent_session_for_agent_locked(model, &agent, now_millis(), true);
    }
    model.agents.remove(agent_id);
    model.turns.remove(agent_id);
    model.agent_turn_queues.remove(agent_id);
    model.agent_drafts.remove(agent_id);
    model.agent_typing.remove(agent_id);
    model.agent_pending_pause.remove(agent_id);
    model.agent_draining.remove(agent_id);
    model.agent_send_tracking.remove(agent_id);
    clear_recent_session_binding_locked(model, Some(agent_id), None);
}

fn remove_group_without_open_panes_locked(model: &mut Model, group_id: &str) -> bool {
    if model
        .panes
        .values()
        .any(|pane| pane.info.group_id == group_id)
    {
        return false;
    }

    let agent_ids = model
        .agents
        .values()
        .filter(|agent| agent.group_id == group_id)
        .map(|agent| agent.id.clone())
        .collect::<Vec<_>>();
    let pruned_agents = !agent_ids.is_empty();
    for agent_id in agent_ids {
        prune_agent_locked(model, &agent_id);
    }
    let removed = model.groups.remove(group_id).is_some();
    let order_len_before = model.group_order.len();
    model.group_order.retain(|id| id != group_id);
    removed || pruned_agents || order_len_before != model.group_order.len()
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

    let mut prev_depth_by_group: HashMap<String, u16> = HashMap::new();
    for id in ids.iter() {
        let group_id = model
            .panes
            .get(id)
            .map(|pane| pane.info.group_id.clone())
            .unwrap_or_default();
        let raw = model.pane_depth.get(id).copied().unwrap_or(0);
        let ceiling = prev_depth_by_group
            .get(&group_id)
            .map_or(0, |prev| (prev + 1).min(MAX_PANE_DEPTH));
        let depth = raw.min(ceiling);
        if depth == 0 {
            model.pane_depth.remove(id);
        } else {
            model.pane_depth.insert(id.clone(), depth);
        }
        prev_depth_by_group.insert(group_id, depth);
    }
}

fn normalize_pane_splits_locked(model: &mut Model) {
    model.pane_splits =
        normalized_pane_splits(model, model.pane_splits.clone(), false).unwrap_or_default();
}

fn normalized_pane_splits(
    model: &Model,
    splits: Vec<PaneSplitInfo>,
    strict: bool,
) -> Result<Vec<PaneSplitInfo>, String> {
    let ordered = ordered_panes(model);
    let mut pane_positions: HashMap<String, (String, usize)> = HashMap::new();
    let mut group_indexes: HashMap<String, usize> = HashMap::new();
    for pane in ordered {
        let index = group_indexes.entry(pane.group_id.clone()).or_default();
        pane_positions.insert(pane.id, (pane.group_id, *index));
        *index += 1;
    }

    let mut result = Vec::new();
    let mut used_panes = HashSet::new();
    let mut used_split_ids = HashSet::new();

    for split in splits {
        let id = split.id.trim().to_string();
        if id.is_empty() {
            if strict {
                return Err("pane split id cannot be empty".to_string());
            }
            continue;
        }
        if used_split_ids.contains(&id) {
            if strict {
                return Err(format!("pane split {id} is duplicated"));
            }
            continue;
        }

        let mut pane_ids = Vec::new();
        let mut local_seen = HashSet::new();
        for pane_id in split.pane_ids {
            if !local_seen.insert(pane_id.clone()) {
                if strict {
                    return Err(format!("pane split {id} contains duplicate pane {pane_id}"));
                }
                continue;
            }
            if !pane_positions.contains_key(&pane_id) {
                if strict {
                    return Err(format!("pane split {id} references missing pane {pane_id}"));
                }
                continue;
            }
            if used_panes.contains(&pane_id) {
                if strict {
                    return Err(format!("pane {pane_id} appears in multiple splits"));
                }
                continue;
            }
            pane_ids.push(pane_id);
        }

        if pane_ids.len() < 2 {
            continue;
        }

        let Some((group_id, _)) = pane_positions.get(&pane_ids[0]).cloned() else {
            continue;
        };
        if pane_ids
            .iter()
            .any(|pane_id| pane_positions.get(pane_id).map(|(group, _)| group) != Some(&group_id))
        {
            if strict {
                return Err(format!("pane split {id} spans multiple groups"));
            }
            continue;
        }

        pane_ids.sort_by_key(|pane_id| {
            pane_positions
                .get(pane_id)
                .map(|(_, index)| *index)
                .unwrap_or(usize::MAX)
        });
        let contiguous = pane_ids.windows(2).all(|pair| {
            let Some((_, left)) = pane_positions.get(&pair[0]) else {
                return false;
            };
            let Some((_, right)) = pane_positions.get(&pair[1]) else {
                return false;
            };
            *right == *left + 1
        });
        if !contiguous {
            if strict {
                return Err(format!("pane split {id} must contain adjacent tabs"));
            }
            continue;
        }

        for pane_id in &pane_ids {
            used_panes.insert(pane_id.clone());
        }
        used_split_ids.insert(id.clone());
        let pane_id_set = pane_ids.iter().cloned().collect::<HashSet<_>>();
        let sizes = split
            .sizes
            .into_iter()
            .filter(|(pane_id, size)| {
                pane_id_set.contains(pane_id) && size.is_finite() && *size > 0.0
            })
            .collect();
        let intent = split
            .intent
            .into_iter()
            .filter(|(pane_id, entry)| {
                pane_id_set.contains(pane_id)
                    && entry.kind == "inserted-relative"
                    && pane_id != &entry.anchor_pane_id
                    && pane_id_set.contains(&entry.anchor_pane_id)
                    && matches!(entry.position.as_str(), "above" | "below")
                    && matches!(
                        entry.source.as_str(),
                        "command" | "join" | "drag-half" | "drag-divider"
                    )
                    && entry.created_at.is_finite()
                    && entry.created_at >= 0.0
            })
            .collect();

        result.push(PaneSplitInfo {
            id,
            pane_ids,
            sizes,
            intent,
        });
    }

    Ok(result)
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
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, OpencodeAdapterConfig,
    };
    use crate::persistence::PersistedState;
    use crate::scrollback::append_pane_scrollback;
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
                opencode: OpencodeAdapterConfig {
                    binary: Some("opencode".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: std::path::PathBuf::new(),
            opencode_plugin_dir: std::path::PathBuf::new(),
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
            name_override: None,
            dir: "/tmp/work".to_string(),
            managed_dir: "/tmp/qmux-workspaces/group-1".to_string(),
            base_repo: Some("/tmp/repo".to_string()),
            base_ref: Some("HEAD".to_string()),
            parent_id: None,
            created_at: 1,
            collapsed: false,
            agents: vec!["agent-1".to_string()],
        }
    }

    fn sample_pane(id: &str, agent_id: Option<&str>) -> PaneInfo {
        PaneInfo {
            id: id.to_string(),
            title: "Shell".to_string(),
            kind: PaneKind::Shell,
            agent_id: agent_id.map(ToString::to_string),
            group_id: "group-1".to_string(),
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
            skip_scrollback_restore: false,
        }
    }

    fn sample_user_turn(agent_id: &str, text: &str) -> Turn {
        Turn {
            id: format!("{agent_id}-0"),
            agent_id: agent_id.to_string(),
            session_id: Some("session-abc".to_string()),
            role: "user".to_string(),
            blocks: vec![crate::transcript::TurnBlock::Text {
                text: text.to_string(),
            }],
            source_index: 0,
        }
    }

    fn enqueue_wait_turn(
        state: &AppState,
        agent_id: &str,
        data: &str,
        wait_for_agent_id: &str,
    ) -> Result<usize, String> {
        state.enqueue_agent_wait_turn_with_target_label(
            agent_id,
            data.to_string(),
            wait_for_agent_id,
            None,
            None,
        )
    }

    #[test]
    fn recent_session_round_trips_through_persistence() {
        let workspace = temp_workspace();
        let transcript_path = workspace.join("session-abc.jsonl");
        std::fs::write(
            &transcript_path,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Plan recent session history"}]}}"#,
        )
        .unwrap();
        let config = test_config(workspace.clone());

        {
            let state = AppState::new(config.clone());
            state.restore_session();
            let mut agent = sample_agent("agent-1");
            agent.worktree_dir = workspace.display().to_string();
            agent.transcript_path = Some(transcript_path.display().to_string());
            state.insert_agent(agent).unwrap();
            state
                .replace_turns(
                    "agent-1",
                    vec![sample_user_turn("agent-1", "Plan recent session history")],
                )
                .unwrap();

            let sessions = state.list_recent_sessions(10).unwrap();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].session_id.as_deref(), Some("session-abc"));
            assert_eq!(
                sessions[0].preview.as_deref(),
                Some("Plan recent session history")
            );
        }

        let state = AppState::new(config);
        state.restore_session();
        let sessions = state.list_recent_sessions(10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].preview.as_deref(),
            Some("Plan recent session history")
        );
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn closing_agent_pane_keeps_recent_session_without_live_binding() {
        let workspace = temp_workspace();
        let transcript_path = workspace.join("session-abc.jsonl");
        std::fs::write(&transcript_path, "{}\n").unwrap();
        let state = AppState::new(test_config(workspace.clone()));
        state.restore_session();

        let mut agent = sample_agent("agent-1");
        agent.worktree_dir = workspace.display().to_string();
        agent.transcript_path = Some(transcript_path.display().to_string());
        agent.pane_id = Some("pane-1".to_string());
        state.insert_agent(agent).unwrap();
        state
            .replace_turns(
                "agent-1",
                vec![sample_user_turn("agent-1", "Keep me in Home")],
            )
            .unwrap();

        let mut pane = sample_pane_runtime("pane-1");
        pane.info.kind = PaneKind::Agent;
        pane.info.agent_id = Some("agent-1".to_string());
        pane.info.cwd = workspace.display().to_string();
        state.insert_pane(pane).unwrap();

        state.remove_pane("pane-1").unwrap();
        assert!(state.agent("agent-1").unwrap().is_none());

        let sessions = state.list_recent_sessions(10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].pane_id, None);
        assert_eq!(sessions[0].agent_id, None);
        assert_eq!(sessions[0].preview.as_deref(), Some("Keep me in Home"));
        std::fs::remove_dir_all(workspace).unwrap();
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
            let (data, pending) = state.pop_ready_agent_turn("agent-1").unwrap().unwrap();
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
    fn queued_wait_turn_waits_until_target_is_done() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        source.pane_id = Some("source-pane".to_string());
        let mut target = sample_agent("target");
        target.status = AgentStatus::Running;
        target.pane_id = Some("target-pane".to_string());
        let mut target_pane = sample_pane_runtime("target-pane");
        target_pane.info.agent_id = Some("target".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();
        state.insert_pane(target_pane).unwrap();

        enqueue_wait_turn(&state, "source", "after target", "target").unwrap();
        assert!(state.pop_ready_agent_turn("source").unwrap().is_none());

        state
            .set_agent_status("target", AgentStatus::AwaitingInput)
            .unwrap();
        assert!(state.pop_ready_agent_turn("source").unwrap().is_none());

        state
            .set_agent_status("target", AgentStatus::AwaitingPermission)
            .unwrap();
        assert!(state.pop_ready_agent_turn("source").unwrap().is_none());

        state.set_agent_status("target", AgentStatus::Done).unwrap();
        let (turn, pending) = state.pop_ready_agent_turn("source").unwrap().unwrap();
        assert_eq!(turn.text, "after target");
        assert_eq!(pending, 0);
    }

    #[test]
    fn queued_wait_turn_blocks_later_turns_until_target_is_done() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        source.pane_id = Some("source-pane".to_string());
        let mut target = sample_agent("target");
        target.status = AgentStatus::Running;
        target.pane_id = Some("target-pane".to_string());
        let mut target_pane = sample_pane_runtime("target-pane");
        target_pane.info.agent_id = Some("target".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();
        state.insert_pane(target_pane).unwrap();

        enqueue_wait_turn(&state, "source", "after target", "target").unwrap();
        state
            .enqueue_agent_turn("source", "then this".to_string())
            .unwrap();

        assert!(state.pop_ready_agent_turn("source").unwrap().is_none());

        state.set_agent_status("target", AgentStatus::Done).unwrap();
        let (first, first_pending) = state.pop_ready_agent_turn("source").unwrap().unwrap();
        assert_eq!(first.text, "after target");
        assert_eq!(first_pending, 1);

        let (second, second_pending) = state.pop_ready_agent_turn("source").unwrap().unwrap();
        assert_eq!(second.text, "then this");
        assert_eq!(second_pending, 0);
    }

    #[test]
    fn removing_front_wait_turn_moves_wait_to_next_turn() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        source.pane_id = Some("source-pane".to_string());
        let mut target = sample_agent("target");
        target.status = AgentStatus::Running;
        target.pane_id = Some("target-pane".to_string());
        let mut target_pane = sample_pane_runtime("target-pane");
        target_pane.info.agent_id = Some("target".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();
        state.insert_pane(target_pane).unwrap();

        enqueue_wait_turn(&state, "source", "remove me", "target").unwrap();
        state
            .enqueue_agent_turn("source", "keep waiting".to_string())
            .unwrap();

        let (removed, queued) = state
            .remove_agent_turn_queue_item("source", 0, Some("remove me"))
            .unwrap();
        assert_eq!(removed.text, "remove me");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].text, "keep waiting");
        let propagated_wait = queued[0].wait_for.as_ref().unwrap();
        assert_eq!(propagated_wait.agent_id, "target");

        assert!(state.pop_ready_agent_turn("source").unwrap().is_none());

        state.set_agent_status("target", AgentStatus::Done).unwrap();
        let (turn, pending) = state.pop_ready_agent_turn("source").unwrap().unwrap();
        assert_eq!(turn.text, "keep waiting");
        assert_eq!(pending, 0);
    }

    #[test]
    fn queued_wait_turn_waits_for_target_queue_after_target_is_done() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        source.pane_id = Some("source-pane".to_string());
        let mut target = sample_agent("target");
        target.status = AgentStatus::Done;
        target.pane_id = Some("target-pane".to_string());
        let mut target_pane = sample_pane_runtime("target-pane");
        target_pane.info.agent_id = Some("target".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();
        state.insert_pane(target_pane).unwrap();

        state
            .enqueue_agent_turn("target", "target queued".to_string())
            .unwrap();
        enqueue_wait_turn(&state, "source", "after target", "target").unwrap();

        assert!(state.pop_ready_agent_turn("source").unwrap().is_none());

        let (target_turn, target_pending) = state.pop_ready_agent_turn("target").unwrap().unwrap();
        assert_eq!(target_turn.text, "target queued");
        assert_eq!(target_pending, 0);

        let (source_turn, source_pending) = state.pop_ready_agent_turn("source").unwrap().unwrap();
        assert_eq!(source_turn.text, "after target");
        assert_eq!(source_pending, 0);
    }

    #[test]
    fn queued_wait_turn_uses_supplied_label_when_target_pane_matches() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        let mut target = sample_agent("target");
        target.status = AgentStatus::Running;
        target.pane_id = Some("target-pane".to_string());
        let mut target_pane = sample_pane_runtime("target-pane");
        target_pane.info.title = "Shell".to_string();
        target_pane.info.agent_id = Some("target".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();
        state.insert_pane(target_pane).unwrap();

        state
            .enqueue_agent_wait_turn_with_target_label(
                "source",
                "after target".to_string(),
                "target",
                Some("target-pane"),
                Some("Dynamic terminal title"),
            )
            .unwrap();

        let queued = state.agent_queued_turns("source").unwrap();
        let wait_for = queued[0].wait_for.as_ref().unwrap();
        assert_eq!(wait_for.label.as_deref(), Some("Dynamic terminal title"));
    }

    #[test]
    fn queued_wait_turn_ignores_supplied_label_when_target_pane_is_stale() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        let mut target = sample_agent("target");
        target.status = AgentStatus::Running;
        target.pane_id = Some("target-pane".to_string());
        let mut target_pane = sample_pane_runtime("target-pane");
        target_pane.info.title = "Backend title".to_string();
        target_pane.info.agent_id = Some("target".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();
        state.insert_pane(target_pane).unwrap();

        state
            .enqueue_agent_wait_turn_with_target_label(
                "source",
                "after target".to_string(),
                "target",
                Some("stale-pane"),
                Some("Dynamic terminal title"),
            )
            .unwrap();

        let queued = state.agent_queued_turns("source").unwrap();
        let wait_for = queued[0].wait_for.as_ref().unwrap();
        assert_eq!(wait_for.label.as_deref(), Some("Backend title"));
    }

    #[test]
    fn queued_wait_turn_resolves_when_target_pane_is_gone() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        let mut target = sample_agent("target");
        target.status = AgentStatus::Running;
        target.pane_id = Some("missing-pane".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();

        enqueue_wait_turn(&state, "source", "after close", "target").unwrap();
        let (turn, pending) = state.pop_ready_agent_turn("source").unwrap().unwrap();
        assert_eq!(turn.text, "after close");
        assert_eq!(pending, 0);
    }

    #[test]
    fn queued_wait_turn_blocks_when_target_failed() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut source = sample_agent("source");
        source.status = AgentStatus::Done;
        source.pane_id = Some("source-pane".to_string());
        let mut target = sample_agent("target");
        target.status = AgentStatus::Failed;
        target.pane_id = Some("target-pane".to_string());
        let mut target_pane = sample_pane_runtime("target-pane");
        target_pane.info.agent_id = Some("target".to_string());
        state.insert_agent(source).unwrap();
        state.insert_agent(target).unwrap();
        state.insert_pane(target_pane).unwrap();

        enqueue_wait_turn(&state, "source", "after target", "target").unwrap();

        // A failed target intentionally keeps its waiters blocked.
        assert!(state.pop_ready_agent_turn("source").unwrap().is_none());
    }

    #[test]
    fn claim_ready_agent_turn_serializes_concurrent_drains() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_agent(sample_agent("agent-1")).unwrap();
        state
            .enqueue_agent_turn("agent-1", "first".to_string())
            .unwrap();
        state
            .enqueue_agent_turn("agent-1", "second".to_string())
            .unwrap();

        // First claim pops the front turn and marks the agent draining.
        match state.claim_ready_agent_turn("agent-1").unwrap() {
            AgentTurnClaim::Ready { turn, .. } => assert_eq!(turn.text, "first"),
            _ => panic!("expected the first turn to be claimed"),
        }
        // A concurrent claim is refused while the first drain is in flight, even though
        // "second" is itself ready — this is what prevents the double-send.
        assert!(matches!(
            state.claim_ready_agent_turn("agent-1").unwrap(),
            AgentTurnClaim::Draining
        ));
        // Finishing the first drain lets the next one proceed.
        state.finish_agent_drain("agent-1");
        match state.claim_ready_agent_turn("agent-1").unwrap() {
            AgentTurnClaim::Ready { turn, .. } => assert_eq!(turn.text, "second"),
            _ => panic!("expected the second turn to be claimed"),
        }
    }

    #[test]
    fn claim_next_turn_or_mark_idle_holds_for_typing_then_drains() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_agent(sample_agent("agent-1")).unwrap();
        state
            .enqueue_agent_turn("agent-1", "queued".to_string())
            .unwrap();
        state.set_agent_typing("agent-1", true).unwrap();

        // While the user is typing the idle advance settles to Done and holds the queue,
        // setting the status atomically with reading the typing flag.
        assert!(matches!(
            state.claim_next_turn_or_mark_idle("agent-1").unwrap(),
            IdleAdvance::Idle
        ));
        assert!(matches!(
            state.agent("agent-1").unwrap().unwrap().status,
            AgentStatus::Done
        ));
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["queued".to_string()]
        );

        // Once typing clears, the next advance claims the held turn instead of stalling.
        state.set_agent_typing("agent-1", false).unwrap();
        match state.claim_next_turn_or_mark_idle("agent-1").unwrap() {
            IdleAdvance::Sent { turn, .. } => assert_eq!(turn.text, "queued"),
            _ => panic!("expected the held turn to drain once typing cleared"),
        }
    }

    #[test]
    fn queued_wait_turn_rejects_dependency_cycles() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut agent_a = sample_agent("agent-a");
        agent_a.pane_id = Some("pane-a".to_string());
        let mut agent_b = sample_agent("agent-b");
        agent_b.pane_id = Some("pane-b".to_string());
        let mut pane_a = sample_pane_runtime("pane-a");
        pane_a.info.agent_id = Some("agent-a".to_string());
        let mut pane_b = sample_pane_runtime("pane-b");
        pane_b.info.agent_id = Some("agent-b".to_string());
        state.insert_agent(agent_a).unwrap();
        state.insert_agent(agent_b).unwrap();
        state.insert_pane(pane_a).unwrap();
        state.insert_pane(pane_b).unwrap();

        enqueue_wait_turn(&state, "agent-a", "wait a", "agent-b").unwrap();
        let err = enqueue_wait_turn(&state, "agent-b", "wait b", "agent-a").unwrap_err();
        assert!(err.contains("cycle"));
    }

    #[test]
    fn queued_wait_turn_rejects_cycle_through_idle_target_queue() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        let mut agent_a = sample_agent("agent-a");
        agent_a.status = AgentStatus::Done;
        agent_a.pane_id = Some("pane-a".to_string());
        let mut agent_b = sample_agent("agent-b");
        agent_b.status = AgentStatus::Done;
        agent_b.pane_id = Some("pane-b".to_string());
        let mut pane_a = sample_pane_runtime("pane-a");
        pane_a.info.agent_id = Some("agent-a".to_string());
        let mut pane_b = sample_pane_runtime("pane-b");
        pane_b.info.agent_id = Some("agent-b".to_string());
        state.insert_agent(agent_a).unwrap();
        state.insert_agent(agent_b).unwrap();
        state.insert_pane(pane_a).unwrap();
        state.insert_pane(pane_b).unwrap();

        enqueue_wait_turn(&state, "agent-b", "wait for a", "agent-a").unwrap();
        let err = enqueue_wait_turn(&state, "agent-a", "wait for b", "agent-b").unwrap_err();
        assert!(err.contains("cycle"));
    }

    #[test]
    fn queued_wait_turn_round_trips_through_persistence() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        {
            let state = AppState::new(config.clone());
            assert!(state.restore_session().is_empty());
            let mut source = sample_agent("source");
            source.status = AgentStatus::Done;
            let mut target = sample_agent("target");
            target.status = AgentStatus::Running;
            target.pane_id = Some("target-pane".to_string());
            let mut target_pane = sample_pane_runtime("target-pane");
            target_pane.info.title = "Target pane".to_string();
            target_pane.info.agent_id = Some("target".to_string());
            state.insert_agent(source).unwrap();
            state.insert_agent(target).unwrap();
            state.insert_pane(target_pane).unwrap();
            enqueue_wait_turn(&state, "source", "persisted wait", "target").unwrap();
        }

        let state = AppState::new(config);
        state.restore_session();
        let queued = state.agent_queued_turns("source").unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].text, "persisted wait");
        let wait_for = queued[0].wait_for.as_ref().unwrap();
        assert_eq!(wait_for.agent_id, "target");
        assert_eq!(wait_for.label.as_deref(), Some("Target pane"));
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
    fn pane_splits_require_adjacent_tabs_and_prune_on_layout_change() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-3")).unwrap();

        let invalid = state
            .set_pane_splits(vec![PaneSplitInfo {
                id: "split-a".to_string(),
                pane_ids: vec!["pane-1".to_string(), "pane-3".to_string()],
                sizes: HashMap::new(),
                intent: HashMap::new(),
            }])
            .unwrap_err();
        assert!(invalid.contains("adjacent"));

        let splits = state
            .set_pane_splits(vec![PaneSplitInfo {
                id: "split-a".to_string(),
                pane_ids: vec!["pane-1".to_string(), "pane-2".to_string()],
                sizes: HashMap::from([("pane-1".to_string(), 0.4), ("pane-2".to_string(), 0.6)]),
                intent: HashMap::new(),
            }])
            .unwrap();
        assert_eq!(splits.len(), 1);
        assert_eq!(splits[0].pane_ids, vec!["pane-1", "pane-2"]);
        assert_eq!(splits[0].sizes.get("pane-1"), Some(&0.4));

        state
            .set_pane_layout(layout(&[("pane-1", 0), ("pane-3", 0), ("pane-2", 0)]))
            .unwrap();

        assert!(state.pane_splits().unwrap().is_empty());
    }

    #[test]
    fn pane_splits_preserve_valid_intent_and_prune_stale_intent() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));

        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-3")).unwrap();

        let splits = state
            .set_pane_splits(vec![PaneSplitInfo {
                id: "split-a".to_string(),
                pane_ids: vec![
                    "pane-1".to_string(),
                    "pane-2".to_string(),
                    "pane-3".to_string(),
                ],
                sizes: HashMap::new(),
                intent: HashMap::from([
                    (
                        "pane-2".to_string(),
                        PaneSplitIntent {
                            kind: "inserted-relative".to_string(),
                            anchor_pane_id: "pane-1".to_string(),
                            position: "below".to_string(),
                            source: "command".to_string(),
                            created_at: 1.0,
                        },
                    ),
                    (
                        "pane-3".to_string(),
                        PaneSplitIntent {
                            kind: "inserted-relative".to_string(),
                            anchor_pane_id: "pane-missing".to_string(),
                            position: "below".to_string(),
                            source: "drag-half".to_string(),
                            created_at: 2.0,
                        },
                    ),
                ]),
            }])
            .unwrap();

        assert_eq!(splits.len(), 1);
        assert_eq!(
            splits[0].intent.get("pane-2"),
            Some(&PaneSplitIntent {
                kind: "inserted-relative".to_string(),
                anchor_pane_id: "pane-1".to_string(),
                position: "below".to_string(),
                source: "command".to_string(),
                created_at: 1.0,
            })
        );
        assert!(!splits[0].intent.contains_key("pane-3"));
    }

    #[test]
    fn update_pane_cwd_rejects_untrusted_values() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();

        // A normal path (an existing absolute directory) is accepted and stored.
        let real_dir = std::env::temp_dir().display().to_string();
        state.update_pane_cwd("pane-1", real_dir.clone()).unwrap();
        assert_eq!(state.list_panes().unwrap()[0].cwd, real_dir);

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
        // A non-existent path and a relative path are rejected (an installed
        // file-server root must be a real, absolute directory).
        assert!(
            state
                .update_pane_cwd("pane-1", "/no/such/qmux/dir/at/all".to_string())
                .is_err()
        );
        assert!(
            state
                .update_pane_cwd("pane-1", "relative/dir".to_string())
                .is_err()
        );
        assert_eq!(state.list_panes().unwrap()[0].cwd, real_dir);
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
    fn capture_last_closed_pane_records_layout_agent_state_and_scrollback() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace.clone()));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        let mut pane_2 = sample_pane_runtime("pane-2");
        pane_2.info.kind = PaneKind::Agent;
        pane_2.info.agent_id = Some("agent-1".to_string());
        state.insert_pane(pane_2).unwrap();
        state.insert_pane(sample_pane_runtime("pane-3")).unwrap();
        state
            .set_pane_layout(layout(&[("pane-1", 0), ("pane-2", 1), ("pane-3", 1)]))
            .unwrap();
        let mut agent = sample_agent("agent-1");
        agent.pane_id = Some("pane-2".to_string());
        state.insert_agent(agent).unwrap();
        state
            .enqueue_agent_turn("agent-1", "later".to_string())
            .unwrap();
        state
            .set_agent_draft("agent-1", "draft text".to_string())
            .unwrap();
        append_pane_scrollback(&workspace, "pane-2", b"old output").unwrap();

        state.capture_last_closed_pane("pane-2").unwrap();

        let snapshot = state.take_last_closed_pane().unwrap().unwrap();
        assert_eq!(snapshot.pane.id, "pane-2");
        assert_eq!(snapshot.pane.depth, 1);
        assert_eq!(snapshot.group.as_ref().map(|group| group.id.as_str()), None);
        assert_eq!(snapshot.index, 1);
        assert_eq!(snapshot.scrollback, b"old output");
        let agent = snapshot.agent.unwrap();
        assert_eq!(agent.agent.id, "agent-1");
        assert_eq!(agent.queued_turns.len(), 1);
        assert_eq!(agent.queued_turns[0].text, "later");
        assert_eq!(agent.draft.as_deref(), Some("draft text"));
    }

    #[test]
    fn capture_last_group_pane_records_orphaned_agents_for_restore() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();
        let mut agent = sample_agent("agent-1");
        agent.pane_id = None;
        agent.orphaned_queue_pane_id = Some("pane-7".to_string());
        state.insert_agent(agent).unwrap();
        state
            .enqueue_agent_turn("agent-1", "recover me".to_string())
            .unwrap();

        state.capture_last_closed_pane("pane-7").unwrap();

        let snapshot = state.take_last_closed_pane().unwrap().unwrap();
        assert!(snapshot.agent.is_none());
        assert_eq!(snapshot.orphaned_agents.len(), 1);
        assert_eq!(snapshot.orphaned_agents[0].agent.id, "agent-1");
        assert_eq!(
            snapshot.orphaned_agents[0].queued_turns[0].text,
            "recover me"
        );
        assert_eq!(
            snapshot.group.as_ref().map(|group| group.id.as_str()),
            Some("group-1")
        );
    }

    #[test]
    fn capture_last_group_pane_skips_queueless_orphaned_agents() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();
        // A pane-less sibling with no queue: restoring it would only resurrect an
        // invisible, unreachable agent, so it must not be captured.
        let mut idle_sibling = sample_agent("agent-1");
        idle_sibling.pane_id = None;
        state.insert_agent(idle_sibling).unwrap();

        state.capture_last_closed_pane("pane-7").unwrap();

        let snapshot = state.take_last_closed_pane().unwrap().unwrap();
        assert!(snapshot.orphaned_agents.is_empty());
    }

    #[test]
    fn closing_pane_would_strand_queued_work_only_for_last_pane_with_a_queue() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();
        state.insert_agent(sample_agent("agent-1")).unwrap();

        // Last pane, but no queued work yet.
        assert!(
            !state
                .closing_pane_would_strand_queued_work("pane-7")
                .unwrap()
        );

        // Last pane with a queued agent: closing it would strand the queue.
        state
            .enqueue_agent_turn("agent-1", "later".to_string())
            .unwrap();
        assert!(
            state
                .closing_pane_would_strand_queued_work("pane-7")
                .unwrap()
        );

        // A sibling pane keeps the group alive, so nothing is stranded.
        state.insert_pane(sample_pane_runtime("pane-8")).unwrap();
        assert!(
            !state
                .closing_pane_would_strand_queued_work("pane-7")
                .unwrap()
        );
    }

    #[test]
    fn restore_closed_pane_metadata_reinserts_pruned_agent_and_layout() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        let mut pane_2 = sample_pane_runtime("pane-2");
        pane_2.info.kind = PaneKind::Agent;
        pane_2.info.agent_id = Some("agent-1".to_string());
        state.insert_pane(pane_2).unwrap();
        state.insert_pane(sample_pane_runtime("pane-3")).unwrap();
        state
            .set_pane_layout(layout(&[("pane-1", 0), ("pane-2", 1), ("pane-3", 1)]))
            .unwrap();
        let mut agent = sample_agent("agent-1");
        agent.pane_id = Some("pane-2".to_string());
        state.insert_agent(agent).unwrap();
        state
            .set_agent_draft("agent-1", "draft text".to_string())
            .unwrap();
        state.capture_last_closed_pane("pane-2").unwrap();
        let snapshot = state.take_last_closed_pane().unwrap().unwrap();

        state.remove_pane("pane-2").unwrap();
        assert!(state.agent("agent-1").unwrap().is_none());

        state.restore_closed_pane_metadata(&snapshot).unwrap();
        let mut restored_pane = sample_pane_runtime("pane-2");
        restored_pane.info = snapshot.pane.clone();
        state.insert_pane(restored_pane).unwrap();
        state
            .place_restored_pane(&snapshot.pane.id, snapshot.index, snapshot.pane.depth)
            .unwrap();

        assert_eq!(
            id_depths(&state.list_panes().unwrap()),
            vec![
                ("pane-1".to_string(), 0),
                ("pane-2".to_string(), 1),
                ("pane-3".to_string(), 1),
            ]
        );
        let restored_agent = state.agent("agent-1").unwrap().unwrap();
        assert_eq!(restored_agent.pane_id.as_deref(), Some("pane-2"));
        assert_eq!(
            state.agent_draft("agent-1").unwrap().as_deref(),
            Some("draft text")
        );
    }

    #[test]
    fn remove_pane_prunes_its_idle_agent_and_runtime_state() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();
        state.insert_agent(sample_agent("agent-1")).unwrap();
        state.set_agent_typing("agent-1", true).unwrap();
        state.mark_agent_pending_pause("agent-1").unwrap();

        state.remove_pane("pane-7").unwrap();

        // The closed pane's agent (no queued turns) is reclaimed with its runtime state.
        assert!(state.agent("agent-1").unwrap().is_none());
        assert!(!state.agent_is_typing("agent-1").unwrap());
    }

    #[test]
    fn remove_pane_keeps_queued_agent_while_sibling_pane_remains() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-8")).unwrap();
        state.insert_agent(sample_agent("agent-1")).unwrap();
        state
            .enqueue_agent_turn("agent-1", "later".to_string())
            .unwrap();

        state.remove_pane("pane-7").unwrap();

        // Kept so the queue stays restart-recoverable via the orphaned-queue panel.
        assert!(state.agent("agent-1").unwrap().is_some());
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["later".to_string()]
        );
    }

    #[test]
    fn remove_group_removes_empty_group() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();

        state.remove_group("group-1").unwrap();

        assert!(state.list_groups().unwrap().is_empty());
    }

    #[test]
    fn remove_pane_removes_group_when_last_pane_closes() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();

        state.remove_pane("pane-7").unwrap();

        assert!(state.list_groups().unwrap().is_empty());
    }

    #[test]
    fn remove_pane_keeps_group_when_sibling_panes_remain() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();

        state.remove_pane("pane-1").unwrap();
        assert_eq!(state.list_groups().unwrap().len(), 1);
        state.remove_pane("pane-2").unwrap();

        assert!(state.list_groups().unwrap().is_empty());
    }

    #[test]
    fn restore_closed_pane_metadata_recreates_removed_group() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();
        state.capture_last_closed_pane("pane-7").unwrap();
        let snapshot = state.take_last_closed_pane().unwrap().unwrap();

        state.remove_pane("pane-7").unwrap();
        assert!(state.list_groups().unwrap().is_empty());

        state.restore_closed_pane_metadata(&snapshot).unwrap();
        assert_eq!(state.list_groups().unwrap()[0].id, "group-1");
    }

    #[test]
    fn last_agent_pane_close_removes_group_and_restore_recreates_it() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        let mut pane = sample_pane_runtime("pane-7");
        pane.info.kind = PaneKind::Agent;
        pane.info.agent_id = Some("agent-1".to_string());
        state.insert_pane(pane).unwrap();
        state.insert_agent(sample_agent("agent-1")).unwrap();
        state
            .enqueue_agent_turn("agent-1", "queued restore".to_string())
            .unwrap();
        state.capture_last_closed_pane("pane-7").unwrap();
        let snapshot = state.take_last_closed_pane().unwrap().unwrap();

        state.remove_pane("pane-7").unwrap();

        assert!(state.list_groups().unwrap().is_empty());
        assert!(state.agent("agent-1").unwrap().is_none());

        state.restore_closed_pane_metadata(&snapshot).unwrap();
        let mut restored_pane = sample_pane_runtime("pane-7");
        restored_pane.info = snapshot.pane.clone();
        state.insert_pane(restored_pane).unwrap();
        state
            .place_restored_pane(&snapshot.pane.id, snapshot.index, snapshot.pane.depth)
            .unwrap();

        assert_eq!(state.list_groups().unwrap()[0].id, "group-1");
        let restored_agent = state.agent("agent-1").unwrap().unwrap();
        assert_eq!(restored_agent.pane_id.as_deref(), Some("pane-7"));
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["queued restore".to_string()]
        );
    }

    #[test]
    fn last_pane_close_prunes_orphaned_agents_and_restore_rehydrates_them() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();
        let mut agent = sample_agent("agent-1");
        agent.pane_id = None;
        agent.orphaned_queue_pane_id = Some("pane-7".to_string());
        state.insert_agent(agent).unwrap();
        state
            .enqueue_agent_turn("agent-1", "queued restore".to_string())
            .unwrap();
        state.capture_last_closed_pane("pane-7").unwrap();
        let snapshot = state.take_last_closed_pane().unwrap().unwrap();

        state.remove_pane("pane-7").unwrap();

        assert!(state.list_groups().unwrap().is_empty());
        assert!(state.agent("agent-1").unwrap().is_none());

        state.restore_closed_pane_metadata(&snapshot).unwrap();
        let mut restored_pane = sample_pane_runtime("pane-7");
        restored_pane.info = snapshot.pane.clone();
        state.insert_pane(restored_pane).unwrap();
        state
            .place_restored_pane(&snapshot.pane.id, snapshot.index, snapshot.pane.depth)
            .unwrap();

        assert_eq!(state.list_groups().unwrap()[0].id, "group-1");
        let restored_agent = state.agent("agent-1").unwrap().unwrap();
        assert_eq!(restored_agent.pane_id, None);
        assert_eq!(
            restored_agent.orphaned_queue_pane_id.as_deref(),
            Some("pane-7")
        );
        assert_eq!(
            state.list_agent_turn_queue("agent-1").unwrap(),
            vec!["queued restore".to_string()]
        );
    }

    #[test]
    fn remove_group_refuses_open_panes_but_prunes_recoverable_agents() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_pane(sample_pane_runtime("pane-7")).unwrap();

        assert_eq!(
            state.remove_group("group-1").unwrap_err(),
            "group still has open panes"
        );
        let state = AppState::new(test_config(temp_workspace()));
        state.insert_group_after(sample_group(), None).unwrap();
        state.insert_agent(sample_agent("agent-1")).unwrap();
        state.remove_group("group-1").unwrap();
        assert!(state.list_groups().unwrap().is_empty());
        assert!(state.agent("agent-1").unwrap().is_none());
    }

    #[test]
    fn remove_group_prunes_agents_when_group_row_is_already_missing_and_persists() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        {
            let state = AppState::new(config.clone());
            state.restore_session();
            state.insert_agent(sample_agent("agent-1")).unwrap();

            state.remove_group("group-1").unwrap();

            assert!(state.agent("agent-1").unwrap().is_none());
        }

        let state = AppState::new(config);
        state.restore_session();
        assert!(state.agent("agent-1").unwrap().is_none());
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn pane_file_roots_are_scoped_to_the_requesting_pane() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
        state.insert_pane(sample_pane_runtime("pane-2")).unwrap();
        // update_pane_cwd requires a real directory, so create two to stand in for
        // each pane's working directory.
        let proj_a = std::env::temp_dir().join("qmux-test-proj-a");
        let proj_b = std::env::temp_dir().join("qmux-test-proj-b");
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::create_dir_all(&proj_b).unwrap();
        state
            .update_pane_cwd("pane-1", proj_a.display().to_string())
            .unwrap();
        state
            .update_pane_cwd("pane-2", proj_b.display().to_string())
            .unwrap();

        // A pane's browser-open roots include its own cwd but not another pane's.
        let roots = state.pane_file_roots("pane-1");
        assert!(roots.iter().any(|r| r == proj_a.as_path()));
        assert!(!roots.iter().any(|r| r == proj_b.as_path()));
    }

    #[test]
    fn pane_file_token_round_trips_and_is_reclaimed_on_close() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();

        let token = state.pane_file_token("pane-1").unwrap();
        // Stable across calls and resolvable back to its own pane.
        assert_eq!(state.pane_file_token("pane-1").unwrap(), token);
        assert_eq!(state.pane_for_file_token(&token).as_deref(), Some("pane-1"));
        // A different pane gets a different token, distinct from the control token.
        assert_ne!(state.pane_file_token("pane-2").unwrap(), token);
        assert_ne!(state.pane_token("pane-1").unwrap(), token);

        // Closing the pane reclaims the token so a live file credential can't outlive
        // the pane it scopes.
        state.remove_pane("pane-1").unwrap();
        assert!(state.pane_for_file_token(&token).is_none());
    }

    #[test]
    fn remove_pane_reclaims_its_control_token() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        state.insert_pane(sample_pane_runtime("pane-1")).unwrap();

        let token = state.pane_token("pane-1").unwrap();
        assert_eq!(state.pane_for_token(&token).as_deref(), Some("pane-1"));

        // The captured QMUX_TOKEN must not outlive its pane.
        state.remove_pane("pane-1").unwrap();
        assert!(state.pane_for_token(&token).is_none());
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
    fn mutate_agent_only_touches_fields_the_closure_writes() {
        let workspace = temp_workspace();
        let state = AppState::new(test_config(workspace));
        let agent = AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/x".to_string(),
            branch: None,
            pane_id: None,
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Starting,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
            created_at: 1,
        };
        state.insert_agent(agent).unwrap();

        // Two interleaved field-scoped writers on a freshly spawned agent: the
        // SessionStart hook records the session id/transcript, then attach_agent_pane
        // binds the pane. Because each only writes its own fields, neither clobbers the
        // other — the bug a full-struct update_agent (read snapshot, write it back) had.
        state
            .mutate_agent("agent-1", |agent| {
                agent.session_id = Some("sess-1".to_string());
                agent.transcript_path = Some("/tmp/a.jsonl".to_string());
                agent.status = AgentStatus::Running;
            })
            .unwrap()
            .expect("agent exists");
        let bound = state
            .mutate_agent("agent-1", |agent| {
                agent.pane_id = Some("pane-1".to_string());
                agent.status = AgentStatus::Running;
            })
            .unwrap()
            .expect("agent exists");

        assert_eq!(bound.pane_id.as_deref(), Some("pane-1"));
        assert_eq!(bound.session_id.as_deref(), Some("sess-1"));
        assert_eq!(bound.transcript_path.as_deref(), Some("/tmp/a.jsonl"));

        // A missing agent yields None and never persists.
        assert!(
            state
                .mutate_agent("missing", |agent| agent.paused = true)
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
    fn restore_captures_a_one_shot_resume_for_a_live_shell_agent() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        // A transcript on disk marks the session as still resumable.
        let transcript = workspace.join("session-abc.jsonl");
        std::fs::write(&transcript, b"{}\n").unwrap();
        let mut agent = sample_agent("agent-1");
        agent.branch = None;
        agent.transcript_path = Some(transcript.display().to_string());

        let persisted = PersistedState {
            next_id: 99,
            groups: vec![sample_group()],
            // The agent is still bound to its shell pane (it was running at shutdown).
            agents: vec![agent],
            panes: vec![sample_pane("pane-7", None)],
            ..PersistedState::default()
        };
        crate::persistence::save(&workspace, &persisted).unwrap();

        let state = AppState::new(config);
        state.restore_session();

        let resume = state
            .take_shell_agent_resume("pane-7")
            .expect("a resume was captured for the live shell agent");
        assert_eq!(resume.adapter, "claude");
        assert_eq!(resume.session_id, "session-abc");
        // One-shot: a later relaunch of the same pane id never re-triggers the resume.
        assert!(state.take_shell_agent_resume("pane-7").is_none());
    }

    #[test]
    fn restore_skips_resume_when_the_session_transcript_is_gone() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        // sample_agent points at a transcript that does not exist; resuming it would
        // only error in the new shell, so no resume should be captured.
        let persisted = PersistedState {
            next_id: 99,
            groups: vec![sample_group()],
            agents: vec![sample_agent("agent-1")],
            panes: vec![sample_pane("pane-7", None)],
            ..PersistedState::default()
        };
        crate::persistence::save(&workspace, &persisted).unwrap();

        let state = AppState::new(config);
        state.restore_session();

        assert!(state.take_shell_agent_resume("pane-7").is_none());
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
    fn active_tab_round_trips_through_persistence() {
        let workspace = temp_workspace();
        let config = test_config(workspace.clone());

        {
            let state = AppState::new(config.clone());
            assert!(state.restore_session().is_empty());
            state.insert_pane(sample_pane_runtime("pane-1")).unwrap();
            state.insert_pane(sample_pane_runtime("pane-2")).unwrap();

            state
                .set_active_tab_id(Some(" pane-2 ".to_string()))
                .unwrap();
            assert_eq!(state.active_tab_id().unwrap().as_deref(), Some("pane-2"));

            let saved = crate::persistence::load_with_diagnostics(&workspace).state;
            assert_eq!(saved.active_tab_id.as_deref(), Some("pane-2"));
        }

        let state = AppState::new(config);
        state.restore_session();
        assert_eq!(state.active_tab_id().unwrap().as_deref(), Some("pane-2"));

        state.set_active_tab_id(Some("   ".to_string())).unwrap();
        assert_eq!(state.active_tab_id().unwrap(), None);
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
