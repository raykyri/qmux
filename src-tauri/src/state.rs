mod credentials;
mod journal_state;
mod pane_lifecycle;
mod research_state;

use crate::adapters::MessageAnchor;
use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use crate::host::RemoteTmuxCommands;
use crate::journal;
use crate::journal::{
    JOURNAL_ACTIVITY_SOURCE_RANK, RESEARCH_ACTIVITY_SOURCE_RANK, RecentActivityCursor,
    RecentActivityItem, RecentActivityPage,
};
use crate::persistence::{self, PersistedState, STATE_VERSION};
use crate::remote_terminal::{RemoteAttachmentController, RemoteHistoryCheckpoint};
use crate::research::{
    self, CreateResearchDocumentRequest, CreateResearchTreeRequest, RecentResearchQuery,
    RecentResearchQueryCursor, RecentResearchQueryPage, ResearchBranchRemoval, ResearchHighlight,
    ResearchHighlightAnchor, ResearchNode, ResearchNodeCard, ResearchNodeContent, ResearchNodeKind,
    ResearchNodeOrigin, ResearchNodeStatus, ResearchPublicationProposal, ResearchRuntime,
    ResearchTree, ResearchTreeDetail, ResearchTreeSummary, UpdateResearchDocumentRequest,
    UpdateResearchDocumentResult,
};
use crate::scrollback::{bounded_undo_scrollback, read_pane_scrollback, remove_pane_scrollback};
use crate::thread_graph;
use crate::transcript::Turn;
use crate::workspace::{
    ActiveWorkspace, ActiveWorkspaceKind, AgentInfo, AgentStatus, GroupInfo, WorkspaceScope,
    group_recoverable_dir,
};
use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter};
use url::Url;

pub type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
pub type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
pub type SharedBacklog = Arc<Mutex<PaneBacklog>>;

pub struct HostPtyBackend {
    pub child: SharedChild,
    pub master: SharedMaster,
    pub writer: SharedWriter,
    pub backlog: SharedBacklog,
    /// The process/PTY is owned by qmux, but output is rendered by a native
    /// Ghostty host-managed surface instead of the webview renderer.
    pub native_surface: bool,
}

pub struct RemoteTmuxBackend {
    pub controller: Arc<RemoteAttachmentController>,
    pub history: Arc<RemoteHistoryCheckpoint>,
    pub writer: SharedWriter,
    pub backlog: SharedBacklog,
    pub commands: RemoteTmuxCommands,
    pub native_surface: bool,
}

impl RemoteTmuxBackend {
    pub fn new(
        controller: Arc<RemoteAttachmentController>,
        history: Arc<RemoteHistoryCheckpoint>,
        backlog: SharedBacklog,
        commands: RemoteTmuxCommands,
        native_surface: bool,
    ) -> Self {
        let writer = controller.stable_writer();
        Self {
            controller,
            history,
            writer,
            backlog,
            commands,
            native_surface,
        }
    }
}

pub enum PaneBackend {
    #[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
    HostPty(HostPtyBackend),
    RemoteTmux(RemoteTmuxBackend),
}

impl PaneBackend {
    fn writer(&self) -> Option<SharedWriter> {
        match self {
            Self::HostPty(backend) => Some(backend.writer.clone()),
            Self::RemoteTmux(backend) => Some(backend.writer.clone()),
        }
    }

    fn host_master(&self) -> Option<SharedMaster> {
        match self {
            Self::HostPty(backend) => Some(backend.master.clone()),
            Self::RemoteTmux(backend) => backend.controller.current_master(),
        }
    }

    fn host_child(&self) -> Option<SharedChild> {
        match self {
            Self::HostPty(backend) => Some(backend.child.clone()),
            Self::RemoteTmux(_) => None,
        }
    }

    fn backlog(&self) -> SharedBacklog {
        match self {
            Self::HostPty(backend) => backend.backlog.clone(),
            Self::RemoteTmux(backend) => backend.backlog.clone(),
        }
    }

    fn uses_native_surface(&self) -> bool {
        match self {
            Self::HostPty(backend) => backend.native_surface,
            Self::RemoteTmux(backend) => backend.native_surface,
        }
    }

    fn has_host_pty(&self) -> bool {
        matches!(self, Self::HostPty(_))
    }

    fn remote_control(
        &self,
    ) -> Option<(
        Arc<RemoteAttachmentController>,
        Arc<RemoteHistoryCheckpoint>,
        RemoteTmuxCommands,
    )> {
        match self {
            Self::HostPty(_) => None,
            Self::RemoteTmux(backend) => Some((
                backend.controller.clone(),
                backend.history.clone(),
                backend.commands.clone(),
            )),
        }
    }
}

/// Upper bound on a pane's reported working directory. Comfortably above any
/// real filesystem path (PATH_MAX is typically 1024–4096) while bounding what an
/// in-pane process can push into persisted state via the control socket.
const MAX_PANE_CWD_LEN: usize = 8192;

fn validate_workspace_path(label: &str, path: &str) -> Result<(), String> {
    if path.len() > MAX_PANE_CWD_LEN || path.chars().any(char::is_control) {
        return Err(format!("reported {label} is invalid; refusing to persist"));
    }
    if !std::path::Path::new(path).is_absolute() {
        return Err(format!(
            "reported {label} must be absolute; refusing to persist"
        ));
    }
    Ok(())
}

fn validate_reported_workspace(cwd: &str, workspace: &ActiveWorkspace) -> Result<(), String> {
    if workspace.cwd != cwd {
        return Err("reported workspace cwd does not match pane cwd".to_string());
    }
    validate_workspace_path("workspace cwd", &workspace.cwd)?;
    if let Some(root) = workspace.git_root.as_deref() {
        validate_workspace_path("Git root", root)?;
    }
    if workspace.branch.as_ref().is_some_and(|branch| {
        branch.len() > 4096 || branch.is_empty() || branch.chars().any(char::is_control)
    }) {
        return Err("reported Git branch is invalid; refusing to persist".to_string());
    }
    match workspace.kind {
        ActiveWorkspaceKind::Directory
            if workspace.git_root.is_some() || workspace.branch.is_some() =>
        {
            Err("directory workspace cannot contain Git metadata".to_string())
        }
        ActiveWorkspaceKind::GitCheckout
        | ActiveWorkspaceKind::MainCheckout
        | ActiveWorkspaceKind::LinkedWorktree
            if workspace.git_root.is_none() =>
        {
            Err("Git workspace is missing its root".to_string())
        }
        _ => Ok(()),
    }
}

/// Whether a freshly resolved shell workspace describes the same checkout scope
/// as another pane or agent workspace. Exact cwd matching lets a first successful
/// Git observation populate peers that do not have cached workspace metadata yet;
/// matching canonical checkout roots extends the refresh to sibling directories.
fn workspace_observation_matches(
    target_cwd: &str,
    target_workspace: Option<&ActiveWorkspace>,
    observed_cwd: &str,
    observed_workspace: &ActiveWorkspace,
) -> bool {
    if target_cwd == observed_cwd {
        return true;
    }
    match (
        target_workspace.and_then(|workspace| workspace.git_root.as_deref()),
        observed_workspace.git_root.as_deref(),
    ) {
        (Some(target_root), Some(observed_root)) => target_root == observed_root,
        _ => false,
    }
}

/// Retarget a checkout-wide observation to one pane or agent without replacing
/// adapter-specific provenance or qmux ownership metadata already attached to it.
fn propagated_workspace(
    observed: &ActiveWorkspace,
    current: Option<&ActiveWorkspace>,
    target_cwd: &str,
) -> ActiveWorkspace {
    let mut next = observed.clone();
    next.cwd = target_cwd.to_string();
    if let Some(current) = current {
        next.source = current.source;
        next.managed_by_qmux = current.managed_by_qmux;
    }
    next
}

/// Upper bound on the parsed transcript turns retained in memory per agent. The
/// store feeds the UI timeline on (re)connect and crash recovery; without a cap a
/// long session — or selecting a large transcript, which reparses the whole file —
/// grows unbounded, since each turn can carry full tool inputs/results. Once over
/// the cap the oldest turns are dropped (the live timeline still streams every new
/// turn to the frontend as it arrives).
const MAX_TURNS_PER_AGENT: usize = 200;

/// Depth of the closed-pane undo stack. Each entry can carry a full pane snapshot
/// (agent, turns, queued prompts, scrollback), so this bounds transient memory while
/// still letting a run of accidental closes be reopened one at a time. Oldest entries
/// are dropped past the cap. Transient — the stack is never persisted across restart.
const MAX_CLOSED_PANE_UNDO: usize = 25;

/// Per-snapshot cap on the scrollback an undo entry keeps resident. A closed
/// pane's durable log is deleted, so the snapshot is the only surviving copy and
/// the `MAX_CLOSED_PANE_UNDO`-deep stack could otherwise pin ~25× the full log
/// (up to the trim trigger each) in memory. The newest slice restores plenty of
/// context on reopen; the rest is a convenience buffer not worth the RAM.
const MAX_UNDO_SCROLLBACK_BYTES: usize = 1024 * 1024;

/// Upper bound on pending turns queued for a single agent. This is a safety
/// ceiling against unbounded growth (memory plus a larger `state.json` rewritten
/// on every persist), not an expected limit — enqueue past it returns an error the
/// UI surfaces rather than silently swallowing the turn.
const MAX_QUEUED_TURNS_PER_AGENT: usize = 500;

/// Upper bound on durable recent-session entries. This keeps the home list fast and
/// prevents the persisted state from growing forever across months of work.
const MAX_RECENT_SESSIONS: usize = 80;

/// Upper bound on artifact-tray entries per workspace group; the oldest entries
/// fall off first, so a long-running workspace can't grow state.json forever.
const MAX_ARTIFACTS_PER_GROUP: usize = 50;

/// How long the persister thread lets a burst of mutations settle before taking
/// its snapshot. Long enough to fold an agent's status-hook storm (or a window
/// resize) into one write, short enough that a crash loses at most a blink of
/// bookkeeping — pane content itself lives in the PTYs, not in state.json.
const PERSIST_DEBOUNCE: Duration = Duration::from_millis(200);

/// OSC titles can change continuously (progress counters, spinners, build
/// percentages). Keep the newest value in memory immediately, but only make
/// title-only activity dirty on this coarser cadence so a busy terminal does
/// not force a full state.json rewrite every few hundred milliseconds.
const LAST_OSC_TITLE_PERSIST_INTERVAL: Duration = Duration::from_secs(3);

/// Matches the frontend's display cap. OSC titles are untrusted terminal
/// output, so normalize and bound them before they enter persisted state.
const MAX_LAST_OSC_TITLE_CHARS: usize = 160;
const MAX_INTERFACE_DRAFT_KEY_BYTES: usize = 128;
const MAX_INTERFACE_DRAFT_VALUE_BYTES: usize = 12 * 1024 * 1024;
const MAX_INTERFACE_DRAFT_TOTAL_BYTES: usize = 32 * 1024 * 1024;

fn validate_interface_draft_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > MAX_INTERFACE_DRAFT_KEY_BYTES
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("invalid interface draft key".to_string());
    }
    Ok(())
}

const RECENT_SESSION_PREVIEW_MAX_CHARS: usize = 90;

/// How far a recent session's `last_active_at` must drift before a touch that
/// changes nothing else re-stamps it (see upsert_recent_session_for_agent_locked).
const RECENT_SESSION_TOUCH_COARSENESS_MS: u128 = 5_000;

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
    /// Whether durable scrollback has already been handed to this pane's native
    /// surface. `attach_pane` only releases `ready` after the whole attach
    /// succeeds, so a failed backlog flush makes the frontend retry the attach;
    /// without this flag the retry would replay the durable history a second
    /// time and double every restored line on screen. Set once the history is
    /// delivered, so retries skip replay and resume at the failed step.
    pub replayed: bool,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    config: QmuxConfig,
    pane_tokens: Mutex<HashMap<String, String>>,
    // Credentials exposed across an SSH reverse-forward. Kept distinct from local
    // pane tokens so the control socket can apply a remote-only command policy and
    // a compromised host never learns the stronger credential used by local hooks.
    remote_tokens: Mutex<HashMap<String, String>>,
    // Credentials injected only into interactive shell panes. Agent launches
    // strip them before exec, keeping cross-pane user control distinct from
    // the pane-scoped token inherited by hooks and MCP servers.
    user_tokens: Mutex<HashMap<String, String>>,
    // Separate read-only credentials used in file-preview URLs. Executable previews
    // get a narrower token for their exact source and correctly typed browser assets
    // beneath the pane's approved roots.
    file_tokens: Mutex<HashMap<String, String>>,
    exact_file_tokens: Mutex<HashMap<String, (String, std::path::PathBuf, bool)>>,
    // Exact, canonical files outside a pane's normal project roots that the
    // trusted UI explicitly granted to its preview. Codex inline visualizations
    // live under qmux's private workspace metadata, so granting the whole root
    // would expose unrelated panes and sessions to a leaked preview token.
    file_preview_grants: Mutex<HashMap<String, HashSet<std::path::PathBuf>>>,
    model: Mutex<Model>,
    // Coordinates the two short model mutations around an out-of-lock shell
    // workspace probe. Reports take this lock to reserve a revision and again
    // to commit/emit it, so a superseded probe can never publish stale cwd
    // metadata after a newer report.
    pane_cwd_commit_lock: Mutex<()>,
    transcript_tails: Mutex<HashMap<String, TranscriptTailRegistration>>,
    next_transcript_tail: AtomicU64,
    // A hook-reported transcript identity is only a candidate until the adapter
    // validates the backing transcript. Generations prevent an older validator
    // from committing after a newer SessionStart has superseded it.
    transcript_binding_candidates: Mutex<HashMap<String, TranscriptBindingCandidate>>,
    next_transcript_binding_candidate: AtomicU64,
    next_id: AtomicU64,
    #[cfg(feature = "desktop")]
    app_handle: Mutex<Option<AppHandle>>,
    event_sink: Mutex<Option<Arc<dyn Fn(QmuxEvent) + Send + Sync>>>,
    /// Reload-safe agent-completion lifecycle and the current sound preference.
    /// Kept outside Model: it is process-local UI behavior, not workspace data.
    completion_sound: Mutex<crate::completion_sound::CompletionSoundState>,
    // Persistence stays off until restore_session() runs so constructing a state
    // (notably in tests) never touches disk. Once enabled, model mutations mark
    // the state dirty and the persister thread snapshots it to
    // workspace_root/.qmux/state.json on a short debounce.
    persist_enabled: AtomicBool,
    // Serializes the whole snapshot->write->rename in persist() so concurrent
    // saves commit in snapshot order. Without it, a slower older snapshot's
    // rename can land after a newer one and clobber it, losing the last change
    // (or re-sending an already-drained queued turn) across a restart.
    persist_lock: Mutex<()>,
    // Serializes document snapshot replacement with highlight mutations and
    // follow-up prompt capture. Those operations span both the in-memory model
    // and a response-snapshot file, so the model lock alone cannot make them a
    // coherent revision boundary without holding it across fsync'd IO.
    research_document_lock: Mutex<()>,
    // Debounced persistence. Mutations only mark this dirty flag and wake the
    // dedicated writer thread, which coalesces a burst of mutations (agent
    // status hooks, transcript appends, resize storms) into one snapshot+write
    // instead of a full-state serialize+fsync per mutation — the snapshot clone
    // runs under the model lock, so synchronous persists lengthened every lock
    // hold the input path contends with. A clean exit still writes its final
    // snapshot synchronously via `finalize_persistence_for_exit`; what the
    // debounce trades away is at most the last window of changes on a crash.
    persist_dirty: Mutex<bool>,
    persist_wake: Condvar,
    persister_spawned: AtomicBool,
    // At most one coarse OSC-title persistence timer is live at a time. The
    // normal state persister still performs the eventual atomic snapshot;
    // this only delays the dirty mark for title-only activity.
    last_osc_title_persist_scheduled: AtomicBool,
    // Why restore_session had to fall back or drop entries, held until startup
    // surfaces it in a GUI dialog — a Finder launch never shows stderr, and a
    // silently discarded session looks like the app ate the user's tabs.
    recovery_warning: Mutex<Option<String>>,
    // The state-file bytes the startup preflight already read, handed to
    // restore_session so hydration doesn't read and parse the same file a
    // second time. Taken (and dropped) on first use.
    preflighted_state: Mutex<Option<Vec<u8>>>,
    exit_confirmed: AtomicBool,
    // Set before the final exit snapshot is taken. Reader threads can observe PTY
    // EOF while kill_all_panes tears processes down; those removals must preserve
    // the journals referenced by the frozen snapshot for the next launch.
    exit_teardown_started: AtomicBool,
    // Ephemeral loopback file-preview server port, set after it binds.
    file_server: Mutex<Option<u16>>,
    // (device, inode) of the control socket this process currently has bound,
    // recorded after each successful bind so exit cleanup can tell its own socket
    // apart from one a later instance bound at the same path (see
    // `owns_control_socket`).
    control_socket_identity: Mutex<Option<(u64, u64)>>,
    // Per-pane "send" locks. `write_pane` holds one across a whole paste+submit
    // sequence so two concurrent submits to the same pane can't interleave into one
    // merged turn across the inter-write delay. Kept separate from the raw writer
    // lock so live keystrokes are never blocked behind a submit. Reclaimed in
    // `remove_pane`.
    pane_send_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Live shell-launched agent jobs. Process ids, process groups, and terminal
    /// foreground ownership die with this app process, so none of this belongs in
    /// state.json; recovered shells register their freshly resumed job again.
    shell_agent_jobs: Mutex<HashMap<String, ShellAgentJob>>,
    /// UI-only drafts that must survive a WebKit document/process reload but
    /// not a full qmux restart. Kept outside Model so persistence snapshots
    /// never make them durable.
    interface_drafts: Mutex<HashMap<String, String>>,
}

struct TranscriptTailRegistration {
    generation: u64,
    observe_snapshot_workspace: bool,
    active: bool,
    /// Same-path replacements serialize their whole read loop through this
    /// gate. The new generation invalidates the old one immediately, then
    /// waits for it to finish before any turn or lifecycle mutation can race.
    gate: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TranscriptBindingCandidate {
    generation: u64,
    session_id: Option<String>,
    transcript_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellAgentJobState {
    Foreground,
    Backgrounded,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAgentJobInfo {
    pub job_id: String,
    pub agent_id: String,
    pub pane_id: String,
    pub state: ShellAgentJobState,
}

#[derive(Clone, Debug)]
pub(crate) struct ShellAgentJobTarget {
    pub job_id: String,
    pub supervisor_pid: u32,
}

#[derive(Clone, Debug)]
struct ShellAgentJob {
    info: ShellAgentJobInfo,
    supervisor_pid: u32,
    missing_samples: u8,
}

#[derive(Default)]
struct ActiveSubagents {
    identified: HashSet<String>,
    anonymous: usize,
}

#[derive(Clone, Debug)]
struct AgentForkBarrier {
    child_agent_id: String,
    ready: bool,
    resume_queue: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleasedAgentForkBarrier {
    pub source_agent_id: String,
    pub resume_queue: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FinishedAgentForkDispatch {
    pub ready: bool,
    pub resume_queue: bool,
}

impl ActiveSubagents {
    fn count(&self) -> usize {
        self.identified.len().saturating_add(self.anonymous)
    }

    fn is_empty(&self) -> bool {
        self.identified.is_empty() && self.anonymous == 0
    }
}

#[derive(Default)]
struct Model {
    panes: HashMap<String, PaneRuntime>,
    pane_order: Vec<String>,
    pane_splits: Vec<PaneSplitInfo>,
    groups: HashMap<String, GroupInfo>,
    group_order: Vec<String>,
    agents: HashMap<String, AgentInfo>,
    turns: HashMap<String, Vec<Turn>>,
    threads: HashMap<String, thread_graph::ThreadRecord>,
    thread_focus: HashMap<String, String>,
    research_trees: HashMap<String, ResearchTree>,
    research_tree_order: Vec<String>,
    research_nodes: HashMap<String, ResearchNode>,
    /// Client-authored grouping of research trees into folders (plus stars and
    /// collapsed flags). Persisted with the trees it references so the two can
    /// never drift; reconciled against the live tree set at load and scrubbed
    /// when a tree is removed.
    research_folders: research::ResearchFolderState,
    /// Client-authored journal feed (notes, links, hydrated tweets). Entries
    /// are opaque records here — the format lives in the frontend (see
    /// journal.rs module docs).
    journal: journal::JournalState,
    /// Persistent feed of `qmux send` notifications. Oldest first; capped by
    /// the notifications module. Distinct from the research Journal.
    notification_log: crate::user_notifications::NotificationLog,
    /// Pane ids with a backend retirement worker in flight. Transient and deduplicated.
    research_retiring_panes: HashSet<String>,
    agent_turn_queues: HashMap<String, VecDeque<QueuedTurn>>,
    /// Application-global prompt drafts (the home Drafts rail), oldest first.
    global_drafts: Vec<GlobalDraft>,
    /// A queued turn claimed for delivery but not yet confirmed on the PTY, per agent
    /// (at most one — `agent_draining` serializes drains). Popped out of the queue at
    /// claim and persisted here so a crash mid-delivery re-queues it on restart
    /// instead of losing it; cleared once the write lands. At-most-one per agent.
    agent_inflight: HashMap<String, QueuedTurn>,
    agent_send_tracking: HashMap<String, AgentSendTracking>,
    /// Monotonic per-agent counter bumped on every agent mutation and transcript
    /// write. Lets a watcher ask "did anything happen to this agent since I looked?"
    /// — the Esc-interrupt grace window uses it to stand down when hook or transcript
    /// activity proves the agent is still working. Transient (not persisted).
    agent_activity: HashMap<String, u64>,
    /// Monotonic per-agent counter bumped on every status hook/write, including writes
    /// that keep the same status. Unlike `agent_activity`, transcript writes do not
    /// touch this, so a delayed idle resolver can distinguish a new lifecycle hook from
    /// late transcript tailing. Transient (not persisted).
    agent_status_activity: HashMap<String, u64>,
    /// Adapter-reported background subagents still working for each parent.
    /// A parent Stop ends only its foreground turn while this is non-zero.
    /// Transient: hooks rebuild it for each running process.
    agent_active_subagents: HashMap<String, ActiveSubagents>,
    /// Agents whose most recent Stop reported still-running background tasks
    /// (Claude 2.1.145+ sends its live task registry on Stop). Unlike the
    /// hook-tracked subagent counter above, this snapshot is the only signal
    /// for background work that never emits Subagent hooks, and it must also
    /// hold the agent open at the idle-prompt boundary — otherwise the ~60s
    /// idle notification would settle Done and silently cancel the wait the
    /// Stop handler just established. Refreshed by every Stop that carries the
    /// field; cleared when a Stop reports no running tasks, on SessionEnd, and
    /// with the agent's other transient state. Transient (not persisted).
    agents_with_reported_background_tasks: HashSet<String>,
    /// Agents with an Esc-interrupt grace watch already in flight. Holding Esc (key
    /// repeat) fires `watch_agent_after_escape` per keystroke; this dedupes so a burst
    /// spawns one watcher thread, not dozens. Cleared when that thread resolves.
    /// Transient (not persisted).
    agent_escape_watch: HashSet<String>,
    /// `(agent_id, send_id)` pairs with a submit-confirmation watch already in
    /// flight. A drained queued/direct turn arms `watch_agent_after_queued_send` to
    /// recover a dropped Return; keying by the exact send means overlapping sends
    /// (a direct send shortly after a queued drain) each get their own confirmation
    /// instead of the second going unwatched, while re-arming the *same* send stays
    /// deduped. Cleared when the watcher thread resolves. Transient (not persisted).
    agent_submit_watch: HashSet<(String, u64)>,
    agent_drafts: HashMap<String, String>,
    recent_sessions: HashMap<String, RecentSessionInfo>,
    /// Files and loopback URLs surfaced from agent panes via `qmux open`, oldest
    /// first — the per-workspace artifact tray. Persisted; capped per group.
    artifacts: Vec<ArtifactInfo>,
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
    /// Source agents whose queue is held while a just-spawned native fork finishes
    /// adopting an independent session and accepts its launch prompt. Keyed by the
    /// source agent id, with the child agent id as the value. This is deliberately
    /// transient: it synchronizes two live PTYs, which cannot be adopted across an
    /// app restart. Persisting it would instead strand a restored source waiting for
    /// a startup hook the old child process can no longer deliver.
    agent_fork_barriers: HashMap<String, AgentForkBarrier>,
    /// Fresh direct sends that were safely queued while another dispatch still
    /// owned the source. A queued fork consumes this marker into its barrier so a
    /// send racing the pre-barrier spawn window resumes after the child is ready.
    /// Ordinary dispatch completion clears it. Transient (not persisted).
    agent_deferred_queue_resume: HashSet<String>,
    /// Agent-session resumes queued at restore, keyed by the recovered shell pane id;
    /// each is drained by that pane's respawn. Transient (not persisted).
    shell_agent_resumes: HashMap<String, ShellAgentResume>,
    /// The selected frontend tab, persisted so restarts return to the same place.
    /// The value is either a pane id or the frontend's Home tab sentinel.
    active_tab_id: Option<String>,
    /// Undo stack for explicitly closed tabs, most-recent last. Transient: closed tabs
    /// can be restored during the current app run (repeated undo reopens successive
    /// closes), but they are not resurrected after restart. Bounded by
    /// `MAX_CLOSED_PANE_UNDO`.
    closed_pane_stack: Vec<ClosedPaneSnapshot>,
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

/// One artifact-tray entry: a file or loopback URL a pane's agent (or its user,
/// while the agent was backgrounded) opened via `qmux open`. File artifacts keep
/// the canonical path — file-server URLs are minted per run and would go stale —
/// while URL artifacts keep the loopback URL itself.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    pub id: String,
    pub group_id: Option<String>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub created_at: u128,
}

/// Parses the only URL form the artifact tray accepts: a complete HTTP(S)
/// loopback URL. Returning the URL's canonical serialization both validates
/// ports/authorities and keeps equivalent explicit opens deduplicated.
pub(crate) fn canonical_loopback_artifact_url(raw: &str) -> Option<String> {
    if raw.trim() != raw
        || raw
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || raw.contains(['\\', '|'])
    {
        return None;
    }
    let parsed = Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.host_str()?;
    // `url` intentionally accepts legacy shortened IPv4 spellings such as
    // `127.0.0` and canonicalizes them to `127.0.0.0`. For artifact detection
    // that is indistinguishable from a truncated terminal redraw, so validate
    // the original authority host text as well as the parsed URL.
    let authority = raw.split_once("://")?.1.split(['/', '?', '#']).next()?;
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, value)| value);
    let host = if let Some(bracketed) = host_port.strip_prefix('[') {
        bracketed.split_once(']')?.0
    } else {
        host_port
            .split_once(':')
            .map_or(host_port, |(host, _)| host)
    };
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    loopback.then(|| parsed.to_string())
}

/// Normalizes a persisted or restored artifact to the current target policy.
/// File artifacts own only their path; URL artifacts must be complete loopback
/// URLs. `Some(changed)` means the entry is valid, while `None` drops it.
fn normalize_artifact_target(artifact: &mut ArtifactInfo) -> Option<bool> {
    let mut changed = false;
    if artifact
        .path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
    {
        changed = artifact.url.take().is_some();
        return Some(changed);
    }
    if artifact.path.take().is_some() {
        changed = true;
    }
    let raw = artifact.url.as_deref()?;
    let canonical = canonical_loopback_artifact_url(raw)?;
    if canonical != raw {
        artifact.url = Some(canonical);
        changed = true;
    }
    Some(changed)
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
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

#[derive(Clone, Copy, Debug, Default)]
pub struct ResearchWorkspaceDependencies {
    pub tree_count: usize,
    pub has_active_runs: bool,
    pub has_live_panes: bool,
}

#[derive(Clone, Debug, Default)]
struct AgentSendTracking {
    outstanding_sends: VecDeque<AgentOutstandingSend>,
    ups_seq: u64,
    next_send_id: u64,
}

/// Backstop lifetime for an outstanding send that never echoes a UserPromptSubmit.
///
/// The primary cleanup is the per-idle `clear_agent_outstanding_sends` in
/// `advance_after_idle`: every turn boundary wipes the tracking, so an abandoned or
/// hookless send (the user cleared the pasted text with Esc, a slash command the TUI
/// ran without hooks, …) is gone by the next idle. This TTL only bounds the window
/// *between* idles, for an agent that stays busy without ever going idle.
///
/// It must be generous. A steer or queued send can legitimately sit un-echoed for
/// minutes — the TUI buffers it until the current turn boundary (a long tool call),
/// or is momentarily unresponsive (large paste replay, an open modal) when a queued
/// turn is drained into it. Pruning such a live send too early disarms the
/// double-drain guard at `transcript.rs` (`agent_has_outstanding_send_source`),
/// letting a late transcript abort marker drain a second turn on top of the first.
/// Five minutes comfortably clears any realistic single-turn delay while still
/// reaping a truly dead entry.
const OUTSTANDING_SEND_TTL_MS: u128 = 5 * 60 * 1_000;

impl AgentSendTracking {
    fn prune_expired(&mut self, now_ms: u128) {
        self.outstanding_sends
            .retain(|send| now_ms.saturating_sub(send.sent_at_ms) <= OUTSTANDING_SEND_TTL_MS);
    }
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
    #[serde(default)]
    pub id: u64,
    pub text: String,
    pub sent_at_seq: u64,
    #[serde(default)]
    pub sent_at_ms: u128,
    pub source: AgentSendSource,
}

/// Debug-only view of a turn's delivery state. `QueuedTurn::possibly_pasted` is
/// intentionally absent from normal persistence/API serialization, but it is the
/// key signal when a retry will submit a bare Return instead of pasting again.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeliveryDebugTurn {
    pub id: String,
    pub text: String,
    pub pause_after: bool,
    pub wait_for: Option<QueuedTurnWait>,
    pub delivery: Option<QueuedTurnDelivery>,
    pub possibly_pasted: bool,
}

impl From<&QueuedTurn> for AgentDeliveryDebugTurn {
    fn from(turn: &QueuedTurn) -> Self {
        Self {
            id: turn.id.clone(),
            text: turn.text.clone(),
            pause_after: turn.pause_after,
            wait_for: turn.wait_for.clone(),
            delivery: turn.delivery.clone(),
            possibly_pasted: turn.possibly_pasted,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeliveryDebugInfo {
    pub typing: bool,
    pub draining: bool,
    pub pending_pause: bool,
    pub activity_revision: u64,
    pub status_revision: u64,
    pub queued_turns: Vec<AgentDeliveryDebugTurn>,
    pub inflight: Option<AgentDeliveryDebugTurn>,
    pub outstanding_sends: Vec<AgentOutstandingSend>,
    pub submit_watch_send_ids: Vec<u64>,
}

/// A prompt queued application-wide before it has an owner — the home view's
/// Drafts rail. Assigning one to an agent marks it consumed (kept for a while
/// as history) rather than deleting it, so an assignment that queues work is
/// still visible and a crash can never silently lose the text.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalDraft {
    pub id: String,
    pub text: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumed: Option<GlobalDraftConsumed>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalDraftConsumed {
    pub agent_id: String,
    pub at: u64,
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

/// Where a queued turn is delivered when it is reached. Absent on a turn means the
/// default: paste it into the owning agent's own pane. `Fork` resumes the source
/// session into a new forked pane launched with the turn text; `NewSession` starts
/// a fresh session of the same adapter in the source's directory. Either way the
/// source agent never runs the turn itself and stays idle.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum QueuedTurnDelivery {
    Fork {
        #[serde(default)]
        use_worktree: bool,
    },
    NewSession,
}

static QUEUED_TURN_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// A stable, unique identity for a queued turn. Two queued turns can share the
/// same text and differ only in pause/wait/delivery metadata; without an id,
/// mutations that identify a turn by index+text can act on the wrong one when
/// duplicates shift position, so every turn carries an opaque id used for the
/// optimistic-concurrency guards. Random by default; the counter fallback keeps
/// ids unique if the CSPRNG is momentarily unavailable (this runs inside
/// infallible constructors, so it must never fail).
fn new_queued_turn_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_ok() {
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        return format!("qturn-{hex}");
    }
    let seq = QUEUED_TURN_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("qturn-seq-{seq}")
}

/// A queued turn: an id, the text to send, plus optional directives controlling
/// when and where it should send. Deserializes from either a bare string (the
/// legacy persisted format) or a `{ text, pauseAfter, waitFor, delivery }`
/// object, so old state still loads; a turn persisted without an id is assigned
/// a fresh one on load.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub id: String,
    pub text: String,
    pub pause_after: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_for: Option<QueuedTurnWait>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<QueuedTurnDelivery>,
    /// Whether this turn's text may already be sitting in the pane's composer from
    /// a previous delivery attempt — a send whose paste landed but whose submit was
    /// never confirmed. Draining a tagged turn submits a bare Return instead of
    /// re-pasting, so a retry can never concatenate a second copy of the text onto
    /// the one already in the composer. The tag is process-local by design: it is
    /// never persisted, because the composer's contents do not survive an agent
    /// process restart, and a restored turn must re-paste normally.
    #[serde(skip)]
    pub possibly_pasted: bool,
}

impl QueuedTurn {
    pub fn new(text: String) -> Self {
        Self {
            id: new_queued_turn_id(),
            text,
            pause_after: false,
            wait_for: None,
            delivery: None,
            possibly_pasted: false,
        }
    }

    pub fn waiting(text: String, wait_for: QueuedTurnWait) -> Self {
        Self {
            id: new_queued_turn_id(),
            text,
            pause_after: false,
            wait_for: Some(wait_for),
            delivery: None,
            possibly_pasted: false,
        }
    }

    pub fn delivering(text: String, delivery: QueuedTurnDelivery) -> Self {
        Self {
            id: new_queued_turn_id(),
            text,
            pause_after: false,
            wait_for: None,
            delivery: Some(delivery),
            possibly_pasted: false,
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
                #[serde(default)]
                id: Option<String>,
                text: String,
                #[serde(default, rename = "pauseAfter")]
                pause_after: bool,
                #[serde(default, rename = "waitFor")]
                wait_for: Option<QueuedTurnWait>,
                #[serde(default)]
                delivery: Option<QueuedTurnDelivery>,
            },
        }
        Ok(match Repr::deserialize(deserializer)? {
            Repr::Text(text) => QueuedTurn {
                id: new_queued_turn_id(),
                text,
                pause_after: false,
                wait_for: None,
                delivery: None,
                possibly_pasted: false,
            },
            Repr::Full {
                id,
                text,
                pause_after,
                wait_for,
                delivery,
            } => QueuedTurn {
                // A turn persisted before turns had ids is migrated to a fresh
                // one; a stored id is preserved so it stays stable across loads.
                id: id.unwrap_or_else(new_queued_turn_id),
                text,
                pause_after,
                wait_for,
                delivery,
                // Deliberately never restored: the composer's contents do not
                // survive the agent process, so a loaded turn re-pastes normally.
                possibly_pasted: false,
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

/// Result of [`AppState::claim_next_turn_or_settle`].
pub enum IdleAdvance {
    /// A ready turn was claimed; the agent is marked draining and the caller must send it.
    Sent { turn: QueuedTurn, pending: usize },
    /// Another drain owns the agent; the caller must leave its status untouched.
    Busy,
    /// Nothing was sent; the agent has been settled to the requested ready status.
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

fn path_is_ancestor_or_equal(ancestor: &std::path::Path, descendant: &std::path::Path) -> bool {
    let ancestor = std::fs::canonicalize(ancestor).unwrap_or_else(|_| ancestor.to_path_buf());
    let descendant = std::fs::canonicalize(descendant).unwrap_or_else(|_| descendant.to_path_buf());
    descendant.starts_with(&ancestor)
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
    // A claimed turn is removed from the visible queue before its PTY send or child
    // spawn completes. Likewise, a queued fork leaves the source itself idle while
    // its child adopts a distinct session and accepts the launch prompt. Both are
    // unfinished target work: without these transient guards a waiter can observe the
    // misleading empty-queue + Done snapshot in either handoff window.
    if model.agent_draining.contains(&target.id)
        || model.agent_fork_barriers.contains_key(&target.id)
    {
        return false;
    }
    let Some(pane_id) = target.pane_id.as_deref() else {
        // The target has no pane (it was closed and parked). If it still carries an
        // orphaned queue, those turns are unfinished work: "run after X finishes its
        // queue" must stay blocked until that queue actually drains, not fire the moment
        // the pane closes. Only a parked target with an empty queue has nothing left to
        // finish, so it releases the waiter.
        return model
            .agent_turn_queues
            .get(&target.id)
            .is_none_or(|queue| queue.is_empty());
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

/// Grok's CLI brands OSC 0/2 titles with a trailing `" - grok"`. Strip it so
/// tab labels show the meaningful title alone. Case-insensitive; only the
/// suffix is removed.
fn strip_grok_terminal_title_suffix(title: &str) -> &str {
    const SUFFIX: &str = " - grok";
    let title = title.trim_end();
    if title.len() >= SUFFIX.len() {
        let split = title.len() - SUFFIX.len();
        if title.is_char_boundary(split) && title[split..].eq_ignore_ascii_case(SUFFIX) {
            return title[..split].trim_end();
        }
    }
    title
}

fn strip_opencode_terminal_title_prefix(title: &str) -> &str {
    title
        .strip_prefix("OC |")
        .map(str::trim_start)
        .unwrap_or(title)
}

fn sanitize_last_osc_title(raw_title: &str, adapter_id: Option<&str>) -> Option<String> {
    // Leave room for OpenCode's prefix and separator so removing them does not
    // shorten an otherwise valid 160-character title.
    let input_limit = if adapter_id == Some("opencode") {
        MAX_LAST_OSC_TITLE_CHARS + "OC | ".chars().count()
    } else {
        MAX_LAST_OSC_TITLE_CHARS
    };
    let mut title = String::new();
    let mut chars = 0_usize;
    let mut pending_space = false;
    let mut truncated = false;

    for ch in raw_title.chars() {
        if ch.is_control() || ch.is_whitespace() {
            if !title.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            if chars >= input_limit {
                truncated = true;
                break;
            }
            title.push(' ');
            chars += 1;
            pending_space = false;
        }
        if chars >= input_limit {
            truncated = true;
            break;
        }
        title.push(ch);
        chars += 1;
    }

    // OpenCode's branding is a prefix, so remove it before applying the length
    // cap. Otherwise a long title would retain the prefix after truncation.
    if adapter_id == Some("opencode") {
        let stripped = strip_opencode_terminal_title_prefix(&title);
        if stripped.len() != title.len() {
            title = stripped.to_string();
        }
    }

    if truncated {
        if title.ends_with(' ') {
            title.pop();
        }
        chars = title.chars().count();
        while chars >= MAX_LAST_OSC_TITLE_CHARS {
            title.pop();
            chars -= 1;
        }
        title.push('…');
    } else {
        // Strip after whitespace normalization so "Foo\t-\tgrok" still matches,
        // and before the empty check so a title that is only the branding
        // suffix becomes None.
        let stripped = strip_grok_terminal_title_suffix(&title);
        if stripped.len() != title.len() {
            title = stripped.to_string();
        }
    }

    (!title.is_empty()).then_some(title)
}

fn ensure_agent_thread_metadata(state: &AppState, model: &mut Model, agent: &mut AgentInfo) {
    let had_thread_id = agent
        .thread_id
        .as_deref()
        .is_some_and(|thread_id| !thread_id.trim().is_empty());
    if !had_thread_id {
        agent.thread_id = Some(state.next_id("thread"));
    }
    if agent
        .branch_id
        .as_deref()
        .is_none_or(|branch_id| branch_id.trim().is_empty())
    {
        agent.branch_id = Some(state.next_id("branch"));
    }
    if let (Some(thread_id), Some(branch_id)) = (&agent.thread_id, &agent.branch_id) {
        let default_focused_branch_id = model
            .thread_focus
            .get(thread_id)
            .cloned()
            .unwrap_or_else(|| branch_id.clone());
        model.threads.entry(thread_id.clone()).or_insert_with(|| {
            let workspace_root = &state.inner.config.workspace_root;
            let mut record = thread_graph::thread_record_for_agent(
                agent,
                &default_focused_branch_id,
                workspace_root,
            );
            // Builds that assigned agents thread ids before thread records
            // existed wrote graphs to <worktree>/.qmux/threads/<id>.json and
            // persisted no record, so the startup migration (which walks only
            // persisted records) never sees them. Minting a fresh global
            // record here would silently shadow that history behind an empty
            // graph — adopt the legacy worktree snapshot and migrate it into
            // global storage through the same machinery instead.
            if had_thread_id {
                let legacy_path = thread_graph::snapshot_path(&agent.worktree_dir, thread_id);
                if legacy_path.is_file() {
                    record.storage_root = agent.worktree_dir.clone();
                    record.snapshot_path = legacy_path.display().to_string();
                    if let Err(err) =
                        thread_graph::migrate_record_to_storage_root(&mut record, workspace_root)
                    {
                        // Keep the record pointed at the worktree copy: the
                        // history stays readable and the startup migration
                        // retries (and warns) on the next launch.
                        eprintln!(
                            "qmux: could not migrate legacy thread graph {}: {err}",
                            record.id
                        );
                    }
                }
            }
            record
        });
        model
            .thread_focus
            .entry(thread_id.clone())
            .or_insert_with(|| branch_id.clone());
    }
}

fn thread_store_for_agent_locked(
    model: &mut Model,
    agent: &AgentInfo,
    storage_root: &std::path::Path,
) -> (thread_graph::ThreadStore, bool) {
    let thread_id = thread_graph::agent_thread_id(agent);
    let branch_id = thread_graph::agent_branch_id(agent);
    let default_focused_branch_id = model
        .thread_focus
        .get(&thread_id)
        .cloned()
        .unwrap_or(branch_id);
    let existed = model.threads.contains_key(&thread_id);
    let record = model.threads.entry(thread_id).or_insert_with(|| {
        thread_graph::thread_record_for_agent(agent, &default_focused_branch_id, storage_root)
    });
    (
        thread_graph::ThreadStore::new(record.storage_root.clone()),
        !existed,
    )
}

fn migrate_thread_records_to_global(
    workspace_root: &std::path::Path,
    records: &mut HashMap<String, thread_graph::ThreadRecord>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    for record in records.values_mut() {
        if let Err(err) = thread_graph::migrate_record_to_storage_root(record, workspace_root) {
            warnings.push(format!("could not migrate thread {}: {err}", record.id));
        }
    }
    warnings
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

/// What a submit-confirmation watch observes when it re-checks a send it wrote to a
/// pane (see `check_agent_submit_watch`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitWatchStatus {
    /// The send's prompt-submit echo popped it, a later matching send superseded it,
    /// or an idle boundary cleared the tracking: the watch stands down.
    Confirmed,
    /// The send is still outstanding, but *some* UserPromptSubmit arrived after it
    /// was written — most likely this very turn submitting with text that failed
    /// the containment match (for example, a mangled paste). Recovery must stand down:
    /// a Return nudge or a requeue on top of a turn that actually started risks a
    /// duplicate, and a visible stall is the safer failure.
    StillPendingWithPromptActivity,
    /// The send is still outstanding and no prompt of any kind has been submitted
    /// since it was written: the turn shows no sign of having started.
    StillPending,
}

pub struct PaneRuntime {
    pub info: PaneInfo,
    pub backend: PaneBackend,
    /// Process-local revision for cwd/workspace observations. This is not part
    /// of PaneInfo because it only orders concurrent probes within one run.
    pub cwd_observation_seq: u64,
}

/// Durable coordinates for the tmux session that owns a remote pane.
///
/// The SSH connection is intentionally absent: connections are disposable,
/// while these names are the stable identity a new connection must attach to.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionIdentity {
    /// The snapshotted remote id from the pane's workspace group.
    pub remote_id: String,
    /// A qmux-specific tmux server, isolated from the user's default server.
    pub tmux_server: String,
    /// A collision-resistant session name persisted across qmux restarts.
    pub tmux_session: String,
    /// Owner-only remote directory containing generated files for this pane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_dir: Option<String>,
}

impl RemoteSessionIdentity {
    pub fn new(remote_id: &str, pane_id: &str) -> Result<Self, String> {
        if remote_id.trim().is_empty() {
            return Err("a remote session requires a remote id".to_string());
        }
        let mut nonce = [0_u8; 12];
        getrandom::getrandom(&mut nonce)
            .map_err(|err| format!("failed to generate remote session identity: {err}"))?;
        let nonce = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join("");
        let pane_slug = pane_id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                    ch
                } else {
                    '_'
                }
            })
            .take(40)
            .collect::<String>();
        let pane_slug = if pane_slug.is_empty() {
            "pane"
        } else {
            pane_slug.as_str()
        };
        Ok(Self {
            remote_id: remote_id.to_string(),
            tmux_server: "qmux".to_string(),
            tmux_session: format!("qmux-{pane_slug}-{nonce}"),
            support_dir: None,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteConnectionState {
    Connecting,
    Checking,
    Connected,
    Reconnecting,
    #[default]
    Disconnected,
    Failed,
}

/// Process-local connection health exposed with pane metadata. Persisted files
/// may contain the last observation, but restore always resets it to
/// `disconnected`; only a live attachment may claim a stronger state.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionInfo {
    pub state: RemoteConnectionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_started_at: Option<u128>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub startup_timings: std::collections::BTreeMap<String, u128>,
    #[serde(default)]
    pub hook_health: Option<RemoteHookHealth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub next_retry_at: Option<u128>,
    #[serde(default)]
    pub disconnected_at: Option<u128>,
    #[serde(default)]
    pub last_connected_at: Option<u128>,
    #[serde(default)]
    pub last_verified_at: Option<u128>,
    #[serde(default)]
    pub recovery_duration_ms: Option<u128>,
    #[serde(default)]
    pub recovery_action: Option<String>,
    #[serde(default)]
    pub session_exists: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteHookHealth {
    Checking,
    Healthy,
    AuthenticationFailed,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub id: String,
    pub title: String,
    /// Last title reported by OSC 0/2. Kept separate from `title`: the latter is
    /// the durable user/generated name and must continue to override terminal
    /// programs when it differs from the pane's default title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_osc_title: Option<String>,
    pub kind: PaneKind,
    pub agent_id: Option<String>,
    pub group_id: String,
    pub cwd: String,
    /// Display-only workspace observation for shell tabs (checkout kind, git
    /// root, branch), resolved with a single git invocation at spawn and on
    /// each shell prompt. Agent panes leave this unset: they carry their own
    /// live `AgentInfo.active_workspace` from transcript tailing instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_workspace: Option<ActiveWorkspace>,
    /// Present only for panes whose process is owned by qmux-managed tmux on a
    /// remote host. This identity, not a local ssh child pid, drives recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_session: Option<RemoteSessionIdentity>,
    /// Live attachment health for a remote pane. Local panes leave it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection: Option<RemoteConnectionInfo>,
    /// Client program and destination for a direct SSH/SFTP tab. Restart
    /// re-runs the client instead of a login shell. Absent for ordinary shells
    /// and qmux-managed remote panes. `sshTarget` accepts snapshots written by
    /// the original SSH-only implementation.
    #[serde(default, alias = "sshTarget", skip_serializing_if = "Option::is_none")]
    pub remote_client: Option<RemoteClient>,
    pub cols: u16,
    pub rows: u16,
    pub status: PaneStatus,
    /// Wall-clock millis when this pane was last focused. Stamped at spawn and on
    /// every activation (`touch_pane_active`); consulted to pick a group's
    /// most-recently-active shell pane when resolving a spawn cwd. `#[serde(default)]`
    /// so pre-existing persisted state loads as 0 ("least recent until first focus").
    #[serde(default)]
    pub last_active_at: u128,
    /// True for panes recreated from persisted state on restart. Set at respawn
    /// time only; the persisted value is never consulted when reloading.
    #[serde(default)]
    pub recovered: bool,
    /// Deprecated wire field retained so older persisted snapshots and clients can
    /// still deserialize pane records. New versions always return and persist zero.
    #[serde(default)]
    pub depth: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteClientProtocol {
    Ssh,
    Sftp,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClient {
    pub protocol: RemoteClientProtocol,
    pub target: String,
}

impl<'de> Deserialize<'de> for RemoteClient {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", untagged)]
        enum PersistedRemoteClient {
            Current {
                protocol: RemoteClientProtocol,
                target: String,
            },
            LegacySsh(String),
        }

        Ok(match PersistedRemoteClient::deserialize(deserializer)? {
            PersistedRemoteClient::Current { protocol, target } => Self { protocol, target },
            PersistedRemoteClient::LegacySsh(target) => Self {
                protocol: RemoteClientProtocol::Ssh,
                target,
            },
        })
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneSplitAxis {
    #[default]
    Vertical,
    Horizontal,
}

fn pane_split_axis_is_vertical(axis: &PaneSplitAxis) -> bool {
    matches!(axis, PaneSplitAxis::Vertical)
}

/// Depth ceiling for a persisted layout tree. A deeper tree is treated as
/// invalid so a corrupt file degrades to a flat split rather than recursing
/// without bound. Real layouts never approach this.
const MAX_PANE_SPLIT_DEPTH: usize = 16;

/// One node of a nested split's layout tree. `size` is the node's fraction of
/// its parent along the parent's axis; absent means an equal share.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum PaneSplitNode {
    #[serde(rename = "pane")]
    Pane {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<f64>,
    },
    #[serde(rename = "split")]
    Split {
        #[serde(default)]
        axis: PaneSplitAxis,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<f64>,
        children: Vec<PaneSplitNode>,
    },
}

impl PaneSplitNode {
    fn size(&self) -> Option<f64> {
        match self {
            Self::Pane { size, .. } | Self::Split { size, .. } => *size,
        }
    }

    fn with_size(self, size: Option<f64>) -> Self {
        match self {
            Self::Pane { pane_id, .. } => Self::Pane { pane_id, size },
            Self::Split { axis, children, .. } => Self::Split {
                axis,
                size,
                children,
            },
        }
    }

    fn collect_leaves(&self, out: &mut Vec<String>) {
        match self {
            Self::Pane { pane_id, .. } => out.push(pane_id.clone()),
            Self::Split { children, .. } => {
                for child in children {
                    child.collect_leaves(out);
                }
            }
        }
    }

    fn leaves(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.collect_leaves(&mut out);
        out
    }
}

fn valid_node_size(size: Option<f64>) -> Option<f64> {
    size.filter(|value| value.is_finite() && *value > 0.0)
}

/// Child fractions normalized to sum to 1, mirroring the frontend so both sides
/// derive the same flat `sizes` map from the same tree.
fn normalized_node_fractions(children: &[PaneSplitNode]) -> Vec<f64> {
    let clean = children
        .iter()
        .map(|child| valid_node_size(child.size()).unwrap_or(0.0))
        .collect::<Vec<_>>();
    let total = clean.iter().sum::<f64>();
    if total <= 0.0 {
        let share = if clean.is_empty() {
            1.0
        } else {
            1.0 / clean.len() as f64
        };
        return vec![share; clean.len()];
    }
    clean.iter().map(|value| value / total).collect()
}

/// Rejects a structurally broken node and drops sizes that are not positive
/// finite numbers. Membership and ordering are checked separately, against the
/// split's `pane_ids`.
fn sanitized_split_node(node: PaneSplitNode, depth: usize) -> Option<PaneSplitNode> {
    if depth > MAX_PANE_SPLIT_DEPTH {
        return None;
    }
    match node {
        PaneSplitNode::Pane { pane_id, size } => {
            if pane_id.trim().is_empty() {
                return None;
            }
            Some(PaneSplitNode::Pane {
                pane_id,
                size: valid_node_size(size),
            })
        }
        PaneSplitNode::Split {
            axis,
            size,
            children,
        } => {
            let count = children.len();
            let children = children
                .into_iter()
                .filter_map(|child| sanitized_split_node(child, depth + 1))
                .collect::<Vec<_>>();
            if children.len() != count {
                return None;
            }
            Some(PaneSplitNode::Split {
                axis,
                size: valid_node_size(size),
                children,
            })
        }
    }
}

/// Splices a same-axis child into its parent, scaling the grandchildren by the
/// child's own share. Collapsing a pruned branch can produce that shape, and one
/// layout must not have two representations.
fn merged_same_axis_children(
    axis: PaneSplitAxis,
    size: Option<f64>,
    children: Vec<PaneSplitNode>,
) -> PaneSplitNode {
    let nested = children.iter().any(
        |child| matches!(child, PaneSplitNode::Split { axis: child_axis, .. } if *child_axis == axis),
    );
    if !nested {
        return PaneSplitNode::Split {
            axis,
            size,
            children,
        };
    }
    let fractions = normalized_node_fractions(&children);
    let mut merged = Vec::new();
    for (index, child) in children.into_iter().enumerate() {
        match child {
            PaneSplitNode::Split {
                axis: child_axis,
                children: grandchildren,
                ..
            } if child_axis == axis => {
                let inner = normalized_node_fractions(&grandchildren);
                for (grand_index, grandchild) in grandchildren.into_iter().enumerate() {
                    merged.push(grandchild.with_size(Some(fractions[index] * inner[grand_index])));
                }
            }
            other => merged.push(other.with_size(Some(fractions[index]))),
        }
    }
    PaneSplitNode::Split {
        axis,
        size,
        children: merged,
    }
}

/// Drops leaves outside `keep`, removes emptied branches, collapses single-child
/// branches into their child, and merges same-axis nesting. This is what lets a
/// nested layout survive a pane exiting instead of reverting to flat.
fn pruned_split_node(
    node: PaneSplitNode,
    keep: &HashSet<String>,
    depth: usize,
) -> Option<PaneSplitNode> {
    if depth > MAX_PANE_SPLIT_DEPTH {
        return None;
    }
    match node {
        PaneSplitNode::Pane { pane_id, size } => {
            if keep.contains(&pane_id) {
                Some(PaneSplitNode::Pane { pane_id, size })
            } else {
                None
            }
        }
        PaneSplitNode::Split {
            axis,
            size,
            children,
        } => {
            let children = children
                .into_iter()
                .filter_map(|child| pruned_split_node(child, keep, depth + 1))
                .collect::<Vec<_>>();
            match children.len() {
                0 => None,
                // A collapsing branch hands its share of the grandparent to the
                // survivor, so the surrounding layout does not shift.
                1 => children
                    .into_iter()
                    .next()
                    .map(|child| child.with_size(size)),
                _ => Some(merged_same_axis_children(axis, size, children)),
            }
        }
    }
}

fn leaf_sizes_from_root(node: &PaneSplitNode, out: &mut HashMap<String, f64>) {
    let PaneSplitNode::Split { children, .. } = node else {
        return;
    };
    let fractions = normalized_node_fractions(children);
    for (index, child) in children.iter().enumerate() {
        match child {
            PaneSplitNode::Pane { pane_id, .. } => {
                out.insert(pane_id.clone(), fractions[index]);
            }
            other => leaf_sizes_from_root(other, out),
        }
    }
}

/// The pruned tree for a split whose flat membership is `pane_ids`, or None when
/// the stored tree cannot be trusted. Structural problems repair to flat rather
/// than failing the write: a frontend bug must not be able to make the whole
/// layout unpersistable.
///
/// The bool says whether the tree still needs storing. A tree whose children are
/// all panes is exactly a flat split, so `root` is dropped — but its axis and
/// leaf fractions are still the ones to keep, because collapsing a pruned branch
/// can turn columns into a stack.
fn normalized_split_root(
    root: Option<PaneSplitNode>,
    pane_ids: &[String],
) -> Option<(PaneSplitNode, bool)> {
    let sanitized = sanitized_split_node(root?, 0)?;
    let keep = pane_ids.iter().cloned().collect::<HashSet<_>>();
    let pruned = pruned_split_node(sanitized, &keep, 0)?.with_size(None);
    let PaneSplitNode::Split { ref children, .. } = pruned else {
        return None;
    };
    if children.len() < 2 || pruned.leaves() != pane_ids {
        return None;
    }
    let nested = children
        .iter()
        .any(|child| matches!(child, PaneSplitNode::Split { .. }));
    Some((pruned, nested))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSplitInfo {
    pub id: String,
    pub pane_ids: Vec<String>,
    #[serde(default)]
    pub sizes: HashMap<String, f64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub intent: HashMap<String, PaneSplitIntent>,
    #[serde(default, skip_serializing_if = "pane_split_axis_is_vertical")]
    pub axis: PaneSplitAxis,
    /// Nesting structure over `pane_ids`, present only when the layout is
    /// actually nested. The tree's in-order leaves always equal `pane_ids`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<PaneSplitNode>,
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

/// One entry in a `set_pane_layout` request. `depth` remains for rolling upgrade
/// compatibility, but nonzero values are no longer supported.
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
                remote_tokens: Mutex::new(HashMap::new()),
                user_tokens: Mutex::new(HashMap::new()),
                file_tokens: Mutex::new(HashMap::new()),
                exact_file_tokens: Mutex::new(HashMap::new()),
                file_preview_grants: Mutex::new(HashMap::new()),
                model: Mutex::new(Model::default()),
                pane_cwd_commit_lock: Mutex::new(()),
                transcript_tails: Mutex::new(HashMap::new()),
                next_transcript_tail: AtomicU64::new(1),
                transcript_binding_candidates: Mutex::new(HashMap::new()),
                next_transcript_binding_candidate: AtomicU64::new(1),
                next_id: AtomicU64::new(1),
                #[cfg(feature = "desktop")]
                app_handle: Mutex::new(None),
                event_sink: Mutex::new(None),
                completion_sound: Mutex::new(
                    crate::completion_sound::CompletionSoundState::default(),
                ),
                persist_enabled: AtomicBool::new(false),
                persist_lock: Mutex::new(()),
                research_document_lock: Mutex::new(()),
                persist_dirty: Mutex::new(false),
                persist_wake: Condvar::new(),
                persister_spawned: AtomicBool::new(false),
                last_osc_title_persist_scheduled: AtomicBool::new(false),
                recovery_warning: Mutex::new(None),
                preflighted_state: Mutex::new(None),
                exit_confirmed: AtomicBool::new(false),
                exit_teardown_started: AtomicBool::new(false),
                file_server: Mutex::new(None),
                control_socket_identity: Mutex::new(None),
                pane_send_locks: Mutex::new(HashMap::new()),
                shell_agent_jobs: Mutex::new(HashMap::new()),
                interface_drafts: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn register_shell_agent_job(
        &self,
        job_id: String,
        agent_id: String,
        pane_id: String,
        supervisor_pid: u32,
    ) -> Result<ShellAgentJobInfo, String> {
        if job_id.trim().is_empty() || supervisor_pid == 0 {
            return Err("shell agent job metadata is invalid".to_string());
        }
        let info = ShellAgentJobInfo {
            job_id: job_id.clone(),
            agent_id,
            pane_id,
            state: ShellAgentJobState::Foreground,
        };
        let mut jobs = self
            .inner
            .shell_agent_jobs
            .lock()
            .map_err(|_| "shell agent job lock poisoned".to_string())?;
        jobs.insert(
            job_id,
            ShellAgentJob {
                info: info.clone(),
                supervisor_pid,
                missing_samples: 0,
            },
        );
        Ok(info)
    }

    pub fn list_shell_agent_jobs(&self) -> Result<Vec<ShellAgentJobInfo>, String> {
        let jobs = self
            .inner
            .shell_agent_jobs
            .lock()
            .map_err(|_| "shell agent job lock poisoned".to_string())?;
        Ok(jobs.values().map(|job| job.info.clone()).collect())
    }

    pub(crate) fn shell_agent_job_targets(&self) -> Vec<ShellAgentJobTarget> {
        self.inner
            .shell_agent_jobs
            .lock()
            .map(|jobs| {
                jobs.values()
                    .map(|job| ShellAgentJobTarget {
                        job_id: job.info.job_id.clone(),
                        supervisor_pid: job.supervisor_pid,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn update_shell_agent_job_sample(
        &self,
        job_id: &str,
        state: ShellAgentJobState,
    ) -> Option<ShellAgentJobInfo> {
        let mut jobs = self.inner.shell_agent_jobs.lock().ok()?;
        let job = jobs.get_mut(job_id)?;
        job.missing_samples = 0;
        if job.info.state == state {
            return None;
        }
        job.info.state = state;
        Some(job.info.clone())
    }

    /// Records that a supervisor was absent from one successful process-table
    /// sample. Two consecutive misses are required before retiring it so a fork/exit
    /// race or a transiently incomplete `ps` result cannot detach a live primary.
    pub(crate) fn note_shell_agent_job_missing(&self, job_id: &str) -> Option<ShellAgentJobInfo> {
        let mut jobs = self.inner.shell_agent_jobs.lock().ok()?;
        let job = jobs.get_mut(job_id)?;
        job.missing_samples = job.missing_samples.saturating_add(1);
        if job.missing_samples < 2 {
            return None;
        }
        jobs.remove(job_id).map(|job| job.info)
    }

    pub fn unregister_shell_agent_job(
        &self,
        job_id: &str,
        agent_id: Option<&str>,
        pane_id: Option<&str>,
    ) -> Option<ShellAgentJobInfo> {
        let mut jobs = self.inner.shell_agent_jobs.lock().ok()?;
        let matches = jobs.get(job_id).is_some_and(|job| {
            agent_id.is_none_or(|agent_id| job.info.agent_id == agent_id)
                && pane_id.is_none_or(|pane_id| job.info.pane_id == pane_id)
        });
        matches
            .then(|| jobs.remove(job_id))
            .flatten()
            .map(|job| job.info)
    }

    pub fn unregister_shell_agent_jobs_for_pane(&self, pane_id: &str) -> Vec<ShellAgentJobInfo> {
        let Ok(mut jobs) = self.inner.shell_agent_jobs.lock() else {
            return Vec::new();
        };
        let job_ids = jobs
            .iter()
            .filter(|(_, job)| job.info.pane_id == pane_id)
            .map(|(job_id, _)| job_id.clone())
            .collect::<Vec<_>>();
        job_ids
            .into_iter()
            .filter_map(|job_id| jobs.remove(&job_id).map(|job| job.info))
            .collect()
    }

    pub fn set_file_server(&self, port: u16) {
        if let Ok(mut slot) = self.inner.file_server.lock() {
            *slot = Some(port);
        }
    }

    pub fn file_server_port(&self) -> Option<u16> {
        self.inner.file_server.lock().ok().and_then(|slot| *slot)
    }

    /// Records the (device, inode) of the control socket this process currently
    /// has bound. Updated after the initial bind and after each successful rebind.
    pub fn set_control_socket_identity(&self, device: u64, inode: u64) {
        if let Ok(mut slot) = self.inner.control_socket_identity.lock() {
            *slot = Some((device, inode));
        }
    }

    pub fn control_socket_identity(&self) -> Option<(u64, u64)> {
        self.inner
            .control_socket_identity
            .lock()
            .ok()
            .and_then(|slot| *slot)
    }

    pub fn clear_control_socket_identity(&self) {
        if let Ok(mut slot) = self.inner.control_socket_identity.lock() {
            *slot = None;
        }
    }

    /// Whether the file currently at the control socket path is still the one this
    /// process bound. False when another instance has since unlinked and re-bound the
    /// path (its socket must not be deleted out from under it on our exit), and false
    /// when the path is gone or was never recorded — there is nothing of ours to
    /// reclaim either way.
    pub fn owns_control_socket(&self) -> bool {
        let Ok(slot) = self.inner.control_socket_identity.lock() else {
            return false;
        };
        let Some((device, inode)) = *slot else {
            return false;
        };
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(&self.inner.config.socket_path)
            .map(|meta| meta.dev() == device && meta.ino() == inode)
            .unwrap_or(false)
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

    /// Empty, qmux-managed working directory used when the user has not chosen
    /// a project for research. It is deliberately separate from `.qmux`, which
    /// contains private state and terminal credentials.
    pub fn default_research_dir(&self) -> std::path::PathBuf {
        self.inner
            .config
            .workspace_root
            .join(".research")
            .join("default")
    }

    /// The working directory a newly opened shell should inherit from `pane_id`: the
    /// live cwd of that pane when it is a shell whose directory still exists. Agent
    /// panes (rooted in a worktree) and stale or missing directories yield `None`, so
    /// the caller falls back to `default_open_dir`.
    pub fn inheritable_shell_cwd(&self, pane_id: &str) -> Option<std::path::PathBuf> {
        self.inheritable_cwd(pane_id, true)
    }

    /// Live cwd of `pane_id` when that directory still exists, including agent
    /// panes. Used when a new tab should follow the current tab into a
    /// subdirectory of the target group.
    pub fn inheritable_pane_cwd(&self, pane_id: &str) -> Option<std::path::PathBuf> {
        self.inheritable_cwd(pane_id, false)
    }

    fn inheritable_cwd(&self, pane_id: &str, shells_only: bool) -> Option<std::path::PathBuf> {
        let model = self.inner.model.lock().ok()?;
        let pane = model.panes.get(pane_id)?;
        if shells_only && !matches!(pane.info.kind, PaneKind::Shell) {
            return None;
        }
        // A remote pane's cwd is a path on its group's host; the local is_dir
        // liveness probe below would silently discard it.
        let remote = model
            .groups
            .get(&pane.info.group_id)
            .is_some_and(GroupInfo::is_remote);
        let cwd = std::path::PathBuf::from(&pane.info.cwd);
        (remote || cwd.is_dir()).then_some(cwd)
    }

    /// Directory a newly opened shell in `group` should start in.
    ///
    /// Preference order:
    /// 1. `cwd_override` when it still exists
    /// 2. The current tab's live cwd when that directory is inside `group.dir`
    ///    (a tab that has `cd`'d into a subdirectory of the group)
    /// 3. The current tab's cwd when it is a shell in this group ("new tab here",
    ///    including when the shell has `cd`'d outside the group)
    /// 4. The group's most-recently-active shell
    /// 5. `group.dir`
    /// 6. The default open dir
    pub fn resolve_shell_spawn_cwd(
        &self,
        group: &GroupInfo,
        source_pane_id: Option<&str>,
        cwd_override: Option<&str>,
    ) -> Result<std::path::PathBuf, String> {
        if let Some(cwd) = cwd_override.map(str::trim).filter(|cwd| !cwd.is_empty()) {
            return group_recoverable_dir(group.remote.as_ref(), cwd)
                .ok_or_else(|| format!("shell working directory {cwd} does not exist"));
        }

        if let Some(cwd) = source_pane_id.and_then(|id| self.inheritable_pane_cwd(id))
            && path_is_ancestor_or_equal(std::path::Path::new(&group.dir), &cwd)
        {
            return Ok(cwd);
        }

        let same_group_shell = source_pane_id
            .filter(|&id| {
                self.pane_group_id(id)
                    .ok()
                    .flatten()
                    .is_some_and(|gid| gid == group.id)
            })
            .and_then(|id| self.inheritable_shell_cwd(id));
        Ok(same_group_shell
            .or_else(|| self.group_spawn_cwd(&group.id))
            .or_else(|| group_recoverable_dir(group.remote.as_ref(), &group.dir))
            .unwrap_or_else(|| self.default_open_dir()))
    }

    /// The advisory cwd for spawning into `group_id`: the live cwd of the group's
    /// most-recently-active shell pane. Groups are not directory-scoped, so this
    /// derives a sensible spawn directory from where work in the group actually is,
    /// rather than a stored group directory. Only shell panes with a still-existing
    /// cwd count (agent panes are rooted in worktrees; a stale dir is unusable), so
    /// an empty group — or one holding only agent panes — yields `None` and the
    /// caller falls back to `default_open_dir`. Ties on `last_active_at` (e.g. two
    /// panes stamped in the same millisecond) resolve arbitrarily; the recency
    /// signal is advisory.
    pub fn group_spawn_cwd(&self, group_id: &str) -> Option<std::path::PathBuf> {
        let model = self.inner.model.lock().ok()?;
        // A remote group's pane cwds live on its host; the local is_dir
        // liveness probe below would silently discard every one of them.
        let remote = model.groups.get(group_id).is_some_and(GroupInfo::is_remote);
        model
            .panes
            .values()
            .filter(|pane| pane.info.group_id == group_id)
            .filter(|pane| matches!(pane.info.kind, PaneKind::Shell))
            .filter_map(|pane| {
                let cwd = std::path::PathBuf::from(&pane.info.cwd);
                (remote || cwd.is_dir()).then_some((pane.info.last_active_at, cwd))
            })
            .max_by_key(|(last_active_at, _)| *last_active_at)
            .map(|(_, cwd)| cwd)
    }

    /// Stamps `pane_id` as the most-recently-focused pane. Called on every
    /// activation from the frontend, so it must stay cheap: it mutates in memory
    /// only and deliberately does not `persist()` (a disk write per focus would be a
    /// write storm) nor emit an event (nothing renders off this yet). The fresh
    /// timestamp rides along on the next persist triggered by other activity; losing
    /// the last few stamps to a crash only nudges the spawn-cwd heuristic.
    pub fn touch_pane_active(&self, pane_id: &str) {
        if let Ok(mut model) = self.inner.model.lock()
            && let Some(pane) = model.panes.get_mut(pane_id)
        {
            pane.info.last_active_at = now_millis();
        }
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

    pub fn config(&self) -> &QmuxConfig {
        &self.inner.config
    }

    /// Loads persisted metadata into the in-memory model and enables persistence.
    ///
    /// Groups, agents and queued turns are hydrated directly. Panes are *not*:
    /// their persisted runtimes are stale (the old PTYs died with the previous
    /// process), so the pane metadata is returned for the caller to respawn into
    /// fresh PTYs. Returns the recoverable pane infos in a stable order.
    /// Checks the persisted state file is readable before `restore_session`
    /// hydrates and enables saving. Returns `Err` with a user-facing message when
    /// the file exists but cannot be read, so startup can abort loudly instead of
    /// overwriting an intact session with an empty one. See
    /// [`persistence::preflight_state`].
    pub fn preflight_persisted_state(&self) -> Result<(), String> {
        let raw = persistence::preflight_state(&self.inner.config.workspace_root)?;
        // Keep the bytes for restore_session so hydration reuses this read
        // instead of re-reading and re-parsing the file.
        if let Ok(mut slot) = self.inner.preflighted_state.lock() {
            *slot = raw;
        }
        Ok(())
    }

    /// The warning produced while loading persisted state, if any, taken once so
    /// startup can show it in a GUI dialog.
    pub fn take_recovery_warning(&self) -> Option<String> {
        self.inner
            .recovery_warning
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    pub fn restore_session(&self) -> Vec<PaneInfo> {
        // Reuse the bytes preflight already read; when there was no preflight
        // (tests, or a first run with nothing on disk) this falls back to
        // reading the file itself.
        let preread = self
            .inner
            .preflighted_state
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        let outcome =
            persistence::load_with_diagnostics_from(&self.inner.config.workspace_root, preread);
        let source_version = outcome.source_version;
        let persistence_warning = outcome.warning.map(|warning| warning.message);
        let mut persisted = outcome.state;
        // Workspace migration allocates durable ids, so restore the allocator
        // before reconciliation rather than waiting until hydration completes.
        if persisted.next_id > self.inner.next_id.load(Ordering::Relaxed) {
            self.inner
                .next_id
                .store(persisted.next_id, Ordering::Relaxed);
        }
        let (mut research_reconciled, mut migration_warnings) =
            migrate_legacy_research_workspaces(self, &mut persisted);
        // Pane nesting was removed. Flatten the recovery snapshot before it is
        // returned for respawn; inserting the recovered runtimes persists the
        // normalized records during the normal recovery pass.
        for pane in &mut persisted.panes {
            pane.depth = 0;
            pane.remote_connection = pane.remote_session.as_ref().map(|_| RemoteConnectionInfo {
                last_connected_at: pane
                    .remote_connection
                    .as_ref()
                    .and_then(|connection| connection.last_connected_at),
                ..Default::default()
            });
        }
        if source_version == Some(2)
            && let Err(err) =
                persistence::backup_v2_state_for_migration(&self.inner.config.workspace_root)
        {
            migration_warnings.push(err);
        }
        // The tree owns future execution. Node group ids are retained only as
        // compatibility/provenance fields, so reconcile stale copies to the
        // authoritative workspace before any recovery launch can consult them.
        let tree_workspaces = persisted
            .research_trees
            .iter()
            .map(|(tree_id, tree)| (tree_id.clone(), tree.workspace_id.clone()))
            .collect::<HashMap<_, _>>();
        for node in persisted.research_nodes.values_mut() {
            if let Some(workspace_id) = tree_workspaces
                .get(&node.tree_id)
                .filter(|workspace_id| !workspace_id.trim().is_empty())
                && node.group_id != *workspace_id
            {
                node.group_id = workspace_id.clone();
                research_reconciled = true;
            }
        }
        // Structural reconciliation, iterated to a fixpoint: a node needs an
        // existing tree and an existing same-tree parent; a tree needs a root
        // node that is actually its own parentless root. Each removal can
        // invalidate further references (a dropped parent orphans its
        // descendants, a dropped root drops its tree, which drops the tree's
        // remaining nodes), so one pass is not enough.
        loop {
            let mut changed = false;
            let valid_tree_ids = persisted
                .research_trees
                .keys()
                .cloned()
                .collect::<HashSet<_>>();
            let node_tree_by_id = persisted
                .research_nodes
                .iter()
                .map(|(id, node)| (id.clone(), node.tree_id.clone()))
                .collect::<HashMap<_, _>>();
            persisted.research_nodes.retain(|_, node| {
                let tree_ok = valid_tree_ids.contains(&node.tree_id);
                let parent_ok = node
                    .parent_node_id
                    .as_ref()
                    .is_none_or(|parent_id| node_tree_by_id.get(parent_id) == Some(&node.tree_id));
                let keep = tree_ok && parent_ok;
                changed |= !keep;
                keep
            });
            let nodes = &persisted.research_nodes;
            persisted.research_trees.retain(|tree_id, tree| {
                let keep = !tree.workspace_id.trim().is_empty()
                    && nodes.get(&tree.root_node_id).is_some_and(|root| {
                        root.tree_id == *tree_id && root.parent_node_id.is_none()
                    });
                changed |= !keep;
                keep
            });
            research_reconciled |= changed;
            if !changed {
                break;
            }
        }
        // Research runs never survive a restart. Every pane in a Research
        // workspace is a one-shot hidden launch (shells and ordinary agents are
        // rejected there) whose interrupted turn died with the old process; a
        // recovered adapter resumes *Idle*, which the agent sync would read as
        // Complete and permanently snapshot a partial answer. Drop the panes
        // from recovery outright — respawning a hidden TUI only to reclaim it
        // buys nothing — and settle every still-active node as failed, since
        // nothing that could finish it remains.
        let research_group_ids = persisted
            .groups
            .iter()
            .filter(|group| group.scope == WorkspaceScope::Research)
            .map(|group| group.id.as_str())
            .collect::<HashSet<_>>();
        let dropped_research_pane_ids = persisted
            .panes
            .iter()
            .filter(|pane| research_group_ids.contains(pane.group_id.as_str()))
            .map(|pane| pane.id.clone())
            .collect::<HashSet<_>>();
        if !dropped_research_pane_ids.is_empty() {
            persisted
                .panes
                .retain(|pane| !dropped_research_pane_ids.contains(&pane.id));
            // Mirror remove_pane's agent reclamation for panes that will never
            // pass through it: a dropped pane's agent has nothing left to own
            // (research runs cannot hold queued turns — guarded anyway), and
            // keeping the record accumulated one dead AgentInfo in state.json
            // per interrupted run, with nothing that would ever reap it.
            let dropped_agent_ids = persisted
                .agents
                .iter()
                .filter(|agent| {
                    agent
                        .pane_id
                        .as_deref()
                        .is_some_and(|pane_id| dropped_research_pane_ids.contains(pane_id))
                        && persisted
                            .queues
                            .get(&agent.id)
                            .is_none_or(|turns| turns.is_empty())
                        && !persisted.inflight.contains_key(&agent.id)
                })
                .map(|agent| agent.id.clone())
                .collect::<HashSet<_>>();
            persisted
                .agents
                .retain(|agent| !dropped_agent_ids.contains(&agent.id));
            for agent in &mut persisted.agents {
                // Kept only because it still holds recoverable queued work.
                if agent
                    .pane_id
                    .as_deref()
                    .is_some_and(|pane_id| dropped_research_pane_ids.contains(pane_id))
                {
                    agent.pane_id = None;
                }
            }
            for group in &mut persisted.groups {
                group
                    .agents
                    .retain(|agent_id| !dropped_agent_ids.contains(agent_id));
            }
            for agent_id in &dropped_agent_ids {
                persisted.queues.remove(agent_id);
                persisted.drafts.remove(agent_id);
            }
            research_reconciled = true;
        }
        for node in persisted.research_nodes.values_mut() {
            // Also covers bindings to panes that were never persisted (crash
            // during multi-stage removal): either way the pane is gone, and a
            // stale binding would count the node as an active run forever.
            if node.pane_id.take().is_some() {
                research_reconciled = true;
            }
            if node.status.is_active()
                && node.runtime == ResearchRuntime::Sdk
                && let Ok(Some(snapshot)) = research::read_response_snapshot_with_revision(
                    &self.inner.config.workspace_root,
                    &node.id,
                )
                && let Some(outcome) = snapshot.outcome
                && outcome.status.is_terminal()
            {
                node.status = outcome.status;
                node.error = outcome.error;
                node.completed_at = Some(outcome.completed_at);
                node.response_snapshot_at
                    .get_or_insert(outcome.completed_at);
                research_reconciled = true;
            }
            if node.status.is_active() {
                node.status = ResearchNodeStatus::Failed;
                node.error =
                    Some("research run was interrupted before it could resume".to_string());
                node.completed_at = Some(now_millis());
                research_reconciled = true;
            }
        }
        let sdk_agent_ids = persisted
            .research_nodes
            .values()
            .filter_map(|node| node.agent_id.clone())
            .collect::<HashSet<_>>();
        let dropped_sdk_agent_ids = persisted
            .agents
            .iter()
            .filter(|agent| {
                agent.pane_id.is_none()
                    && sdk_agent_ids.contains(&agent.id)
                    && persisted
                        .queues
                        .get(&agent.id)
                        .is_none_or(|turns| turns.is_empty())
                    && !persisted.inflight.contains_key(&agent.id)
            })
            .map(|agent| agent.id.clone())
            .collect::<HashSet<_>>();
        if !dropped_sdk_agent_ids.is_empty() {
            persisted
                .agents
                .retain(|agent| !dropped_sdk_agent_ids.contains(&agent.id));
            for group in &mut persisted.groups {
                group
                    .agents
                    .retain(|agent_id| !dropped_sdk_agent_ids.contains(agent_id));
            }
            for agent_id in &dropped_sdk_agent_ids {
                persisted.queues.remove(agent_id);
                persisted.drafts.remove(agent_id);
            }
            research_reconciled = true;
        }
        // Snapshots for nodes the passes above dropped (or that a crash left
        // behind mid tree-removal) have no other reaper. Prune against the
        // surviving node set now that it is final — but never off a degraded
        // load: a corrupt state file reads as "no nodes", and pruning against
        // that would destroy every snapshot the user might still recover.
        if persistence_warning.is_none() {
            let surviving_research_node_ids = persisted
                .research_nodes
                .keys()
                .cloned()
                .collect::<HashSet<_>>();
            if let Err(err) = research::prune_response_snapshots(
                &self.inner.config.workspace_root,
                &surviving_research_node_ids,
            ) {
                eprintln!("qmux: {err}");
            }
        }
        migration_warnings.extend(migrate_thread_records_to_global(
            &self.inner.config.workspace_root,
            &mut persisted.threads,
        ));
        let recovery_warning = match (persistence_warning, migration_warnings.is_empty()) {
            (Some(warning), true) => Some(warning),
            (Some(warning), false) => {
                Some(format!("{warning}\n\n{}", migration_warnings.join("\n")))
            }
            (None, false) => Some(migration_warnings.join("\n")),
            (None, true) => None,
        };
        if let Some(warning) = recovery_warning {
            eprintln!("qmux: {warning}");
            if let Ok(mut slot) = self.inner.recovery_warning.lock() {
                *slot = Some(warning);
            }
        }
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
            // An in-flight turn (claimed pre-shutdown, delivery unconfirmed) is
            // re-queued below, so its agent counts as having pending work too.
            .chain(persisted.inflight.keys().cloned())
            .collect::<HashSet<_>>();

        let mut hydrated_agents = Vec::new();
        let mut hydrated_research_group_ids = Vec::new();
        let mut artifacts_reconciled = false;
        journal::normalize_journal_state(&mut persisted.journal);
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
            model.threads = persisted.threads;
            model.thread_focus = persisted.thread_focus;
            model.research_trees = persisted.research_trees;
            model.research_tree_order = persisted.research_tree_order;
            let normalized_research_order = ordered_research_tree_ids(&model);
            if normalized_research_order != model.research_tree_order {
                research_reconciled = true;
                model.research_tree_order = normalized_research_order;
            }
            model.research_nodes = persisted.research_nodes;
            // Reconcile the grouping against the authoritative tree set now, under
            // the model lock with every recovered tree present — the one place a
            // prune is safe. Membership/stars for trees that vanished while the app
            // was off (deleted elsewhere) drop here instead of on every refresh
            // against a possibly-incomplete navigation snapshot.
            model.research_folders = persisted.research_folders;
            model.journal = persisted.journal;
            model.notification_log = persisted.notification_log;
            let known_research_tree_ids =
                model.research_trees.keys().cloned().collect::<HashSet<_>>();
            research::reconcile_research_folder_state(
                &mut model.research_folders,
                &known_research_tree_ids,
            );
            for mut agent in persisted.agents {
                ensure_agent_thread_metadata(self, &mut model, &mut agent);
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
                    let has_queue = queued_agent_ids.contains(&agent.id);
                    agent.orphaned_queue_pane_id = has_queue.then_some(pane_id);
                    if has_queue {
                        agent.paused = true;
                    }
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
            // Re-queue any in-flight turn (claimed for delivery but not confirmed before
            // shutdown) at the front of its agent's queue, so it's re-delivered rather
            // than lost. A crash in the tiny window after delivery but before the record
            // cleared re-sends it — at-least-once, preferred over a silent drop. Live
            // in-flight state starts empty after restore.
            for (agent_id, turn) in persisted.inflight {
                model
                    .agent_turn_queues
                    .entry(agent_id)
                    .or_default()
                    .push_front(turn);
            }
            for (agent_id, draft) in persisted.drafts {
                // Drop drafts whose agent no longer exists so dead entries don't
                // accumulate in state.json across restarts. (Agents are hydrated above.)
                if !draft.trim().is_empty() && model.agents.contains_key(&agent_id) {
                    model.agent_drafts.insert(agent_id, draft);
                }
            }
            model.global_drafts = persisted.global_drafts;
            for session in persisted.recent_sessions {
                if !session.id.trim().is_empty() {
                    model.recent_sessions.insert(session.id.clone(), session);
                }
            }
            // Drop artifacts whose group is gone or whose legacy URL is not a
            // complete loopback target. The removed workspace-intelligence
            // scanner could persist external and redraw-truncated URLs; none of
            // those should survive hydration into the explicit artifact tray.
            model.artifacts = persisted
                .artifacts
                .into_iter()
                .filter_map(|mut artifact| {
                    let group_exists = artifact
                        .group_id
                        .as_ref()
                        .is_none_or(|group_id| model.groups.contains_key(group_id));
                    if !group_exists {
                        artifacts_reconciled = true;
                        return None;
                    }
                    match normalize_artifact_target(&mut artifact) {
                        Some(changed) => {
                            artifacts_reconciled |= changed;
                            Some(artifact)
                        }
                        None => {
                            artifacts_reconciled = true;
                            None
                        }
                    }
                })
                .collect();
            model.active_tab_id = active_tab_id;
            model.pane_splits = persisted.pane_splits;
            hydrated_agents = model.agents.values().cloned().collect::<Vec<_>>();
            hydrated_research_group_ids = model
                .groups
                .values()
                .filter(|group| group.scope == WorkspaceScope::Research)
                .map(|group| group.id.clone())
                .collect();
        }

        if let Ok(mut completion_sound) = self.inner.completion_sound.lock() {
            for group_id in hydrated_research_group_ids {
                completion_sound.mark_research_group(&group_id);
            }
        }

        // Backfill recent-session entries for the hydrated agents after the
        // hydrate lock is released: a cold entry's preview/line-count comes
        // from reading (and parsing the head of) its transcript file, and with
        // many recovered agents doing that under the model lock serialized
        // startup — and every early command — behind the file reads.
        let now = now_millis();
        for agent in &hydrated_agents {
            self.upsert_recent_session_for_agent(agent, now, false);
        }

        // Enable persistence only after hydration so loading does not rewrite the
        // file, but before respawn so respawned panes get persisted.
        self.inner.persist_enabled.store(true, Ordering::Relaxed);
        self.spawn_persister();
        if research_reconciled || artifacts_reconciled {
            // Migration/reconciliation may have changed durable workspace
            // relationships or discarded unsafe legacy artifacts. Commit the
            // normalized snapshot before recovery continues.
            self.persist_now();
        }

        persisted.panes
    }

    /// Records that the model changed and needs persisting. The write itself is
    /// debounced onto the persister thread (see `spawn_persister`); in tests it
    /// runs synchronously so state files can be asserted right after a mutation.
    /// Best-effort either way: a failed write is logged but never propagated, so
    /// it cannot break a mutation.
    fn persist(&self) {
        // Cheap early-out while persistence is disabled (hydration, bare test
        // states). The writer re-checks the flag under `persist_lock`, so this
        // unlocked read can never race `finalize_persistence_for_exit` into
        // clobbering the final snapshot — at worst a mutation made while
        // disabled marks nothing, which is today's behavior too.
        if !self.inner.persist_enabled.load(Ordering::Relaxed) {
            return;
        }
        if cfg!(test) {
            self.persist_now();
            return;
        }
        let mut dirty = self
            .inner
            .persist_dirty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *dirty = true;
        self.inner.persist_wake.notify_one();
    }

    /// Starts the background writer that turns dirty marks into debounced
    /// snapshots. Called once when persistence is enabled; a second call is a
    /// no-op. The thread parks on the condvar between bursts, so an idle app
    /// costs nothing.
    fn spawn_persister(&self) {
        if cfg!(test)
            || self
                .inner
                .persister_spawned
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return;
        }
        let state = self.clone();
        std::thread::spawn(move || {
            loop {
                {
                    let mut dirty = state
                        .inner
                        .persist_dirty
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    while !*dirty {
                        dirty = state
                            .inner
                            .persist_wake
                            .wait(dirty)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                    *dirty = false;
                }
                // Coalescing window: let the rest of the burst (status hooks,
                // transcript appends, a resize storm) land before snapshotting.
                std::thread::sleep(PERSIST_DEBOUNCE);
                // Absorb marks made during the window — the snapshot below will
                // include them, so they must not schedule another write.
                {
                    let mut dirty = state
                        .inner
                        .persist_dirty
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    *dirty = false;
                }
                state.persist_now();
            }
        });
    }

    /// Snapshots the model to disk when persistence is enabled.
    fn persist_now(&self) {
        // Hold the persist lock across snapshot + write + rename so concurrent
        // persists commit in snapshot order. The snapshot must be taken *inside*
        // the lock: otherwise two threads could snapshot as S1,S2 but acquire the
        // lock as 2,1 and rename S2 then S1. Recover from poisoning — a persist
        // that panicked mid-write left the on-disk file intact (temp-then-rename),
        // so the guard's data (nothing) is still fine to reuse.
        let _persist_guard = self
            .inner
            .persist_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Check the enabled flag *under the lock*, not before it. A persist that read
        // the flag before locking could pass the check, block on the lock while
        // `finalize_persistence_for_exit` writes the final snapshot and clears the
        // flag, then wake and snapshot a model that `kill_all_panes` has since
        // stripped — overwriting the final state with the tabs deleted. Reading the
        // flag here means such a persist observes the cleared flag and bails.
        if !self.inner.persist_enabled.load(Ordering::Relaxed) {
            return;
        }

        if let Err(err) = self.persist_snapshot_locked() {
            eprintln!("qmux: failed to persist session state: {err}");
        }
    }

    /// Snapshots the model and writes it to disk. Assumes the caller holds
    /// `persist_lock`; does not consult `persist_enabled`. Shared by `persist` (which
    /// gates on the flag) and `finalize_persistence_for_exit` (which writes the final
    /// snapshot before clearing the flag, both under the lock).
    fn persist_snapshot_locked(&self) -> Result<(), String> {
        let snapshot = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            PersistedState {
                // The lowest version whose readers understand every node kind
                // present, so sessions without conversation nodes stay
                // loadable by pre-conversations builds — same tiering as
                // research::detached_archive_version.
                version: if model
                    .research_nodes
                    .values()
                    .any(|node| node.kind == ResearchNodeKind::Conversation)
                {
                    STATE_VERSION
                } else {
                    persistence::STATE_VERSION_PRE_CONVERSATIONS
                },
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
                artifacts: model.artifacts.clone(),
                drafts: model.agent_drafts.clone(),
                global_drafts: model.global_drafts.clone(),
                inflight: model.agent_inflight.clone(),
                pane_splits: normalized_pane_splits(&model, model.pane_splits.clone(), false)
                    .unwrap_or_default(),
                active_tab_id: model.active_tab_id.clone(),
                threads: model.threads.clone(),
                thread_focus: model.thread_focus.clone(),
                research_trees: model.research_trees.clone(),
                research_tree_order: ordered_research_tree_ids(&model),
                research_nodes: model.research_nodes.clone(),
                research_folders: model.research_folders.clone(),
                journal: model.journal.clone(),
                notification_log: model.notification_log.clone(),
            }
        };
        persistence::save(&self.inner.config.workspace_root, &snapshot)
    }

    /// Called once when the process is really exiting, before exit-time pane
    /// teardown. Commits a final snapshot, then disables persistence for good:
    /// `kill_all_panes` is about to take down every pane's PTY, and each reader thread
    /// reacts to that EOF with the natural-exit `remove_pane` path. Left enabled, those
    /// removals race the dying process and rewrite state.json with the panes stripped
    /// out — quitting would erase the very tabs a relaunch should restore.
    ///
    /// The final snapshot and the flag clear happen together under `persist_lock`, so
    /// any other persist either ran fully before this (its snapshot superseded here) or
    /// blocks on the lock and, on waking, sees the cleared flag and bails — it can
    /// never commit a post-`kill_all_panes` snapshot over this one.
    pub fn finalize_persistence_for_exit(&self) {
        // Publish this before snapshotting. Once exit begins, a concurrent natural
        // EOF may remove a pane from the in-memory model at any point; preserving an
        // extra journal is harmless, while deleting the journal for a pane that made
        // it into the frozen snapshot would permanently lose its restored history.
        self.inner
            .exit_teardown_started
            .store(true, Ordering::SeqCst);
        let _persist_guard = self
            .inner
            .persist_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.inner.exit_confirmed.load(Ordering::Relaxed) {
            // A confirmed quit is a user cancellation, not a crash. Settle
            // active research before freezing state.json so restore agrees
            // with both the confirmation copy and the processes we terminate
            // immediately after this snapshot.
            let now = now_millis();
            let mut model = self
                .inner
                .model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut settled = Vec::new();
            let mut agent_ids = Vec::new();
            for node in model.research_nodes.values_mut() {
                if node.kind == ResearchNodeKind::Run && node.status.is_active() {
                    node.status = ResearchNodeStatus::Cancelled;
                    node.error = None;
                    node.completed_at = Some(now);
                    settled.push(node.tree_id.clone());
                    if let Some(agent_id) = node.agent_id.clone() {
                        agent_ids.push(agent_id);
                    }
                }
            }
            for agent_id in agent_ids {
                if let Some(agent) = model.agents.get_mut(&agent_id) {
                    agent.status = AgentStatus::Idle;
                }
            }
            for tree_id in settled {
                touch_research_tree_locked(&mut model, &tree_id, now);
            }
        }
        if let Err(err) = self.persist_snapshot_locked() {
            eprintln!("qmux: failed to persist final session state: {err}");
        }
        self.inner.persist_enabled.store(false, Ordering::Relaxed);
        // Thread-graph writes are debounced the same way state.json is; commit
        // anything still buffered so a clean quit never loses graph updates.
        thread_graph::flush_dirty_thread_graphs();
    }

    #[cfg(feature = "desktop")]
    pub fn attach_app(&self, app_handle: AppHandle) -> Result<(), String> {
        let mut handle = self
            .inner
            .app_handle
            .lock()
            .map_err(|_| "app handle lock poisoned".to_string())?;
        *handle = Some(app_handle);
        Ok(())
    }

    /// Clones the process app handle without holding the mutex across caller
    /// work. Native callbacks use this to schedule main-thread recovery after
    /// WebKit health probes time out.
    #[cfg(feature = "desktop")]
    pub fn app_handle(&self) -> Option<AppHandle> {
        self.inner
            .app_handle
            .lock()
            .ok()
            .and_then(|handle| handle.as_ref().cloned())
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
        let completion_sound_id = self
            .inner
            .completion_sound
            .lock()
            .ok()
            .and_then(|mut state| state.observe_event(&event));
        #[cfg(not(test))]
        if let Some(sound_id) = completion_sound_id
            && let Err(err) = crate::native_terminal::play_completion_sound(&sound_id)
        {
            eprintln!("qmux: failed to play completion sound: {err}");
        }
        #[cfg(test)]
        let _ = completion_sound_id;

        // Clone the handle under the lock but emit outside it. emit() serializes
        // the payload (turn.updated events carry whole turn arrays) and enqueues
        // the IPC; holding the mutex across that serialized every event in the
        // process behind one lock — including main-thread native-input callbacks
        // contending with transcript tails mid-serialize.
        let sink = self
            .inner
            .event_sink
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        if let Some(sink) = sink {
            sink(event);
        } else {
            #[cfg(feature = "desktop")]
            if let Some(app_handle) = self.app_handle() {
                let _ = app_handle.emit("qmux-event", event);
            }
        }
    }

    /// Replace the delivery endpoint without holding state locks during callbacks.
    pub fn set_event_sink(&self, sink: Option<Arc<dyn Fn(QmuxEvent) + Send + Sync>>) {
        *self
            .inner
            .event_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = sink;
    }

    pub fn set_completion_sound(&self, sound_id: &str) -> Result<(), String> {
        self.inner
            .completion_sound
            .lock()
            .map_err(|_| "completion sound lock poisoned".to_string())?
            .set_selected_id(sound_id)
    }

    pub fn mark_exit_confirmed(&self) {
        self.inner.exit_confirmed.store(true, Ordering::Relaxed);
    }

    pub fn should_confirm_exit(&self) -> bool {
        if self.inner.exit_confirmed.load(Ordering::Relaxed) {
            return false;
        }
        self.open_pane_count() > 0 || self.active_research_run_count() > 0
    }

    pub fn request_exit_confirmation(&self) {
        let pane_count = self.open_pane_count();
        let research_run_count = self.active_research_run_count();
        if pane_count == 0 && research_run_count == 0 {
            return;
        }
        self.emit(QmuxEvent::new(
            "app.exit_confirmation_requested",
            None,
            None,
            json!({
                "paneCount": pane_count,
                "researchRunCount": research_run_count,
            }),
        ));
    }

    fn active_research_run_count(&self) -> usize {
        self.inner
            .model
            .lock()
            .map(|model| {
                model
                    .research_nodes
                    .values()
                    .filter(|node| node.kind == ResearchNodeKind::Run && node.status.is_active())
                    .count()
            })
            .unwrap_or_default()
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
        self.emit(QmuxEvent::new(
            "pane.splits_changed",
            None,
            None,
            serde_json::json!({ "splits": normalized }),
        ));
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

    pub fn reorder_groups(&self, group_ids: Vec<String>) -> Result<Vec<GroupInfo>, String> {
        let groups = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if group_ids.len() != model.groups.len() {
                return Err("group order is stale; refresh before reordering".to_string());
            }

            let mut seen = HashSet::with_capacity(group_ids.len());
            for group_id in &group_ids {
                if !seen.insert(group_id.clone()) {
                    return Err("group order contains a duplicate group".to_string());
                }
                if !model.groups.contains_key(group_id) {
                    return Err(format!("group {group_id} was not found"));
                }
            }

            model.group_order = group_ids;
            ordered_groups(&model)
        };
        self.persist();
        Ok(groups)
    }

    pub fn list_research_workspaces(&self) -> Result<Vec<GroupInfo>, String> {
        Ok(self
            .list_groups()?
            .into_iter()
            .filter(|group| group.scope == WorkspaceScope::Research)
            .collect())
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

    /// Records an artifact-tray entry for `pane_id`, deduplicating on the target
    /// within the pane's group (a re-open bumps the entry to newest instead of
    /// duplicating it) and capping the group's tray at `MAX_ARTIFACTS_PER_GROUP`.
    /// Emits `artifact.added` carrying the entry plus any ids it displaced.
    pub fn record_artifact(
        &self,
        pane_id: &str,
        path: Option<String>,
        url: Option<String>,
    ) -> Result<ArtifactInfo, String> {
        let mut artifact = ArtifactInfo {
            id: self.next_id("artifact"),
            group_id: self.pane_group_id(pane_id)?,
            pane_id: pane_id.to_string(),
            path,
            url,
            created_at: now_millis(),
        };
        normalize_artifact_target(&mut artifact)
            .ok_or_else(|| "an artifact needs a valid path or loopback URL".to_string())?;
        let removed_ids = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let mut removed = Vec::new();
            model.artifacts.retain(|existing| {
                let duplicate = existing.group_id == artifact.group_id
                    && existing.path == artifact.path
                    && existing.url == artifact.url;
                if duplicate {
                    removed.push(existing.id.clone());
                }
                !duplicate
            });
            model.artifacts.push(artifact.clone());
            // The vec is oldest-first, so trimming a too-large group from the
            // front drops its oldest entries and can never evict the new one.
            let in_group = model
                .artifacts
                .iter()
                .filter(|entry| entry.group_id == artifact.group_id)
                .count();
            let mut to_drop = in_group.saturating_sub(MAX_ARTIFACTS_PER_GROUP);
            model.artifacts.retain(|entry| {
                if to_drop > 0 && entry.group_id == artifact.group_id {
                    to_drop -= 1;
                    removed.push(entry.id.clone());
                    return false;
                }
                true
            });
            removed
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "artifact.added",
            Some(pane_id.to_string()),
            None,
            serde_json::json!({ "artifact": artifact, "removedIds": removed_ids }),
        ));
        Ok(artifact)
    }

    pub fn list_artifacts(&self) -> Result<Vec<ArtifactInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.artifacts.clone())
    }

    pub fn artifact(&self, artifact_id: &str) -> Result<ArtifactInfo, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model
            .artifacts
            .iter()
            .find(|entry| entry.id == artifact_id)
            .cloned()
            .ok_or_else(|| format!("artifact {artifact_id} was not found"))
    }

    /// Removes an artifact-tray entry and returns it, so the tray's undo can
    /// restore it verbatim. Emits `artifact.removed`.
    pub fn remove_artifact(&self, artifact_id: &str) -> Result<ArtifactInfo, String> {
        let removed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let index = model
                .artifacts
                .iter()
                .position(|entry| entry.id == artifact_id)
                .ok_or_else(|| format!("artifact {artifact_id} was not found"))?;
            model.artifacts.remove(index)
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "artifact.removed",
            Some(removed.pane_id.clone()),
            None,
            serde_json::json!({ "id": removed.id }),
        ));
        Ok(removed)
    }

    /// Reinserts a previously removed artifact at its chronological position
    /// (tray undo). A duplicate id is a no-op so a double-undo can't clone rows.
    /// Emits `artifact.added`.
    pub fn restore_artifact(&self, mut artifact: ArtifactInfo) -> Result<(), String> {
        normalize_artifact_target(&mut artifact)
            .ok_or_else(|| "an artifact needs a valid path or loopback URL".to_string())?;
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model.artifacts.iter().any(|entry| entry.id == artifact.id) {
                return Ok(());
            }
            let index = model
                .artifacts
                .iter()
                .position(|entry| entry.created_at > artifact.created_at)
                .unwrap_or(model.artifacts.len());
            model.artifacts.insert(index, artifact.clone());
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "artifact.added",
            Some(artifact.pane_id.clone()),
            None,
            serde_json::json!({ "artifact": artifact, "removedIds": [] }),
        ));
        Ok(())
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

    pub fn home_turn_history(
        &self,
        agent_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<thread_graph::HomeTurnHistoryPage, String> {
        let (agent, record) = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let agent = model
                .agents
                .get(agent_id)
                .cloned()
                .ok_or_else(|| format!("agent not found: {agent_id}"))?;
            let thread_id = thread_graph::agent_thread_id(&agent);
            (agent, model.threads.get(&thread_id).cloned())
        };
        let Some(record) = record else {
            return Ok(thread_graph::HomeTurnHistoryPage {
                turns: Vec::new(),
                next_before: None,
            });
        };
        let store = thread_graph::ThreadStore::new(record.storage_root);
        let Some(graph) = store.read_thread(&record.id)? else {
            return Ok(thread_graph::HomeTurnHistoryPage {
                turns: Vec::new(),
                next_before: None,
            });
        };
        Ok(thread_graph::home_turn_history_page(
            &graph,
            &thread_graph::agent_branch_id(&agent),
            before,
            limit,
        ))
    }

    pub fn list_thread_graphs(&self) -> Result<Vec<thread_graph::ThreadGraph>, String> {
        let records = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.threads.values().cloned().collect::<Vec<_>>()
        };

        let mut graphs = Vec::new();
        for record in records {
            let store = thread_graph::ThreadStore::new(record.storage_root);
            if let Some(graph) = store.read_thread(&record.id)? {
                graphs.push(graph);
            }
        }
        Ok(graphs)
    }

    /// Reads a single thread's graph, so streaming turn activity can refresh just
    /// the affected thread instead of re-reading (and re-serializing) every graph
    /// in the workspace. Returns `None` for an unknown thread or one whose graph
    /// snapshot doesn't exist yet.
    pub fn thread_graph(
        &self,
        thread_id: &str,
    ) -> Result<Option<thread_graph::ThreadGraph>, String> {
        let record = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.threads.get(thread_id).cloned()
        };
        let Some(record) = record else {
            return Ok(None);
        };
        let store = thread_graph::ThreadStore::new(record.storage_root);
        store.read_thread(&record.id)
    }

    /// Snapshots the source side of a fork before the child process starts.
    /// The returned reference names immutable qmux-owned content, so it remains
    /// stable after either pane closes or the source transcript is rewritten.
    pub fn capture_conversation_history(
        &self,
        source: &AgentInfo,
        anchor: Option<&MessageAnchor>,
    ) -> Result<Option<thread_graph::ConversationHistoryRef>, String> {
        let (source, turns, store, created_record) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let source = model
                .agents
                .get(&source.id)
                .cloned()
                .unwrap_or_else(|| source.clone());
            if model
                .groups
                .get(&source.group_id)
                .is_some_and(|group| group.scope == WorkspaceScope::Research)
            {
                // Research runs deliberately use durable response snapshots
                // instead of terminal thread graphs. A follow-up fork must not
                // create otherwise-unreachable graph records for that scope.
                return Ok(None);
            }
            let turns = model.turns.get(&source.id).cloned().unwrap_or_default();
            let (store, created_record) = thread_store_for_agent_locked(
                &mut model,
                &source,
                &self.inner.config.workspace_root,
            );
            (source, turns, store, created_record)
        };
        let graph = match store.read_thread(&thread_graph::agent_thread_id(&source))? {
            Some(graph) => graph,
            None => store.replace_agent_branch_turns(&source, &turns)?,
        };
        if created_record {
            self.persist();
        }
        let snapshot_id = self.next_id("history");
        let snapshot = thread_graph::ConversationHistorySnapshot {
            id: snapshot_id.clone(),
            adapter: source.adapter.clone(),
            turns: thread_graph::conversation_history_turns(
                &graph,
                &source,
                anchor.and_then(|anchor| anchor.native_id.as_deref()),
                anchor.map(|anchor| anchor.source_index),
            ),
            previous_snapshot_id: graph
                .conversation_history
                .map(|history| history.snapshot_id),
        };
        // The snapshot is immutable and must be durable before a child can
        // reference it. A failed fork can leave an unreferenced snapshot, which
        // is safer than a live child whose history target never reached disk.
        thread_graph::write_conversation_history_snapshot(
            &self.inner.config.workspace_root,
            &snapshot,
        )?;
        Ok(Some(thread_graph::ConversationHistoryRef { snapshot_id }))
    }

    /// Attaches previously captured history to a child thread. The graph
    /// mutation flushes synchronously because no transcript event can recreate
    /// this user-visible lineage after a crash.
    pub fn record_conversation_history(
        &self,
        child: &AgentInfo,
        history: thread_graph::ConversationHistoryRef,
    ) -> Result<(), String> {
        let (child, store, created_record) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let child = model
                .agents
                .get(&child.id)
                .cloned()
                .unwrap_or_else(|| child.clone());
            let (store, created_record) = thread_store_for_agent_locked(
                &mut model,
                &child,
                &self.inner.config.workspace_root,
            );
            (child, store, created_record)
        };
        store.set_conversation_history(&child, history)?;
        if created_record {
            self.persist();
        }
        Ok(())
    }

    pub fn conversation_history_snapshot(
        &self,
        snapshot_id: &str,
    ) -> Result<Option<thread_graph::ConversationHistorySnapshot>, String> {
        thread_graph::read_conversation_history_snapshot(
            &self.inner.config.workspace_root,
            snapshot_id,
        )
    }

    pub fn notification_log(&self) -> Result<crate::user_notifications::NotificationLog, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.notification_log.clone())
    }

    pub fn append_notification_log(
        &self,
        entry: crate::user_notifications::NotificationLogEntry,
    ) -> Result<crate::user_notifications::NotificationLog, String> {
        let log = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            crate::user_notifications::record_log_entry(&mut model.notification_log, entry);
            model.notification_log.clone()
        };
        self.persist();
        Ok(log)
    }

    pub fn mark_notification_read(
        &self,
        id: &str,
    ) -> Result<crate::user_notifications::NotificationLog, String> {
        let log = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if let Some(entry) = model
                .notification_log
                .entries
                .iter_mut()
                .find(|entry| entry.id == id)
            {
                entry.read = true;
            }
            model.notification_log.clone()
        };
        self.persist();
        Ok(log)
    }

    pub fn mark_all_notifications_read(
        &self,
    ) -> Result<crate::user_notifications::NotificationLog, String> {
        let log = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            for entry in &mut model.notification_log.entries {
                entry.read = true;
            }
            model.notification_log.clone()
        };
        self.persist();
        Ok(log)
    }

    pub fn clear_notification(
        &self,
        id: &str,
    ) -> Result<crate::user_notifications::NotificationLog, String> {
        let log = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model
                .notification_log
                .entries
                .retain(|entry| entry.id != id);
            model.notification_log.clone()
        };
        self.persist();
        Ok(log)
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

    pub fn capture_last_closed_pane(&self, pane_id: &str) -> Result<(), String> {
        let mut snapshot = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            // A pane bound to a research node is reclaimed by research lifecycle
            // handling (settlement, cancellation, or failed-launch cleanup), so
            // it must not become a restorable "closed tab". Skipping the
            // capture here, rather than clearing it after kill_pane returns,
            // closes the window in which a restore request could still see it.
            if model
                .research_nodes
                .values()
                .any(|node| node.pane_id.as_deref() == Some(pane_id))
            {
                return Ok(());
            }
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
            pane.depth = 0;
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
                Ok(bytes) => bounded_undo_scrollback(&bytes, MAX_UNDO_SCROLLBACK_BYTES),
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
        model.closed_pane_stack.push(snapshot);
        // Drop the oldest closes once past the cap so the stack can't grow unbounded.
        let overflow = model
            .closed_pane_stack
            .len()
            .saturating_sub(MAX_CLOSED_PANE_UNDO);
        if overflow > 0 {
            model.closed_pane_stack.drain(0..overflow);
        }
        Ok(())
    }

    /// Pops the most recently closed pane for undo, or `None` when the stack is empty.
    pub fn take_last_closed_pane(&self) -> Result<Option<ClosedPaneSnapshot>, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.closed_pane_stack.pop())
    }

    /// Pushes a snapshot back onto the undo stack (used when a restore attempt fails, so
    /// the just-popped close remains reopenable).
    pub fn remember_last_closed_pane(&self, snapshot: ClosedPaneSnapshot) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.closed_pane_stack.push(snapshot);
        Ok(())
    }

    /// Drops any undo entry for `pane_id` — used when a close is aborted, so a stale
    /// snapshot can't be reopened. Pane ids are unique per run, so this matches at most
    /// one entry.
    pub fn clear_last_closed_pane_for_pane(&self, pane_id: &str) {
        if let Ok(mut model) = self.inner.model.lock() {
            model
                .closed_pane_stack
                .retain(|snapshot| snapshot.pane.id != pane_id);
        }
    }

    /// Drops any undo entry whose captured agent is `agent_id` — used when the agent is
    /// permanently gone, so its snapshot isn't offered for reopen.
    pub fn clear_last_closed_pane_for_agent(&self, agent_id: &str) {
        if let Ok(mut model) = self.inner.model.lock() {
            model.closed_pane_stack.retain(|snapshot| {
                snapshot
                    .agent
                    .as_ref()
                    .is_none_or(|agent_snapshot| agent_snapshot.agent.id != agent_id)
            });
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
            normalize_pane_splits_locked(&mut model);
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// Atomically replaces the flat sidebar tab order. The layout must list exactly
    /// the current panes (no missing/duplicate/unknown id). The legacy depth field
    /// must be zero.
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
            for entry in &layout {
                if !seen.insert(entry.pane_id.clone()) {
                    return Err("pane layout contains a duplicate pane".to_string());
                }
                if !model.panes.contains_key(&entry.pane_id) {
                    return Err(format!("pane {} was not found", entry.pane_id));
                }
                if entry.depth != 0 {
                    return Err("pane indentation is no longer supported".to_string());
                }
            }

            model.pane_order = layout.iter().map(|entry| entry.pane_id.clone()).collect();
            normalize_pane_splits_locked(&mut model);
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// Moves a plain shell tab into another terminal group, applying `layout` as the
    /// resulting flat tab order in the same locked mutation. Agent tabs are rejected: an
    /// agent's worktree, branch, and queue bookkeeping are bound to its group, and
    /// this move deliberately doesn't touch them. When the move empties the source
    /// group it is removed, mirroring the close-last-pane path.
    pub fn move_pane_to_group(
        &self,
        pane_id: &str,
        target_group_id: &str,
        layout: Vec<PaneLayoutEntry>,
    ) -> Result<Vec<PaneInfo>, String> {
        let (panes, removed_source_group_id) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let source_group_id = model
                .panes
                .get(pane_id)
                .map(|pane| pane.info.group_id.clone())
                .ok_or_else(|| format!("pane {pane_id} was not found"))?;
            if source_group_id == target_group_id {
                return Err(format!(
                    "pane {pane_id} is already in group {target_group_id}"
                ));
            }
            let source_scope = model.groups.get(&source_group_id).map(|group| group.scope);
            let target_scope = model
                .groups
                .get(target_group_id)
                .map(|group| group.scope)
                .ok_or_else(|| format!("group {target_group_id} was not found"))?;
            if source_scope != Some(WorkspaceScope::Terminal)
                || target_scope != WorkspaceScope::Terminal
            {
                return Err("tabs can only move between terminal groups".to_string());
            }

            let moved = model
                .panes
                .get(pane_id)
                .ok_or_else(|| format!("pane {pane_id} was not found"))?;
            if !matches!(moved.info.kind, PaneKind::Shell) || moved.info.agent_id.is_some() {
                return Err("agent tabs can't move to another group".to_string());
            }
            // Same validation as `set_pane_layout`, with the moved pane counted
            // against its prospective group.
            if layout.len() != model.panes.len() {
                return Err("pane layout is stale; refresh before updating".to_string());
            }
            let mut seen = HashSet::with_capacity(layout.len());
            for entry in &layout {
                if !seen.insert(entry.pane_id.clone()) {
                    return Err("pane layout contains a duplicate pane".to_string());
                }
                if !model.panes.contains_key(&entry.pane_id) {
                    return Err(format!("pane {} was not found", entry.pane_id));
                }
                if entry.depth != 0 {
                    return Err("pane indentation is no longer supported".to_string());
                }
            }

            if let Some(moved) = model.panes.get_mut(pane_id) {
                moved.info.group_id = target_group_id.to_string();
            }
            model.pane_order = layout.iter().map(|entry| entry.pane_id.clone()).collect();
            // A moved pane's split memberships can't survive the group change; the
            // normalizer drops it from any split it belonged to.
            normalize_pane_splits_locked(&mut model);
            let removed_source_group_id =
                remove_group_without_open_panes_locked(&mut model, &source_group_id, true)
                    .then_some(source_group_id);
            (ordered_panes(&model), removed_source_group_id)
        };
        self.persist();
        if let Some(group_id) = removed_source_group_id {
            self.emit(QmuxEvent::new(
                "group.removed",
                None,
                None,
                json!({ "groupId": group_id }),
            ));
        }
        Ok(panes)
    }

    /// Moves `pane_id` to sit immediately after `sibling_pane_id`.
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

            model.pane_order = ids;
            normalize_pane_splits_locked(&mut model);
            ordered_panes(&model)
        };
        self.persist();
        Ok(panes)
    }

    /// Finalizes the pane layout after session restore/respawn. Legacy persisted
    /// depths are intentionally discarded during hydration.
    pub fn normalize_pane_layout(&self) {
        {
            let Ok(mut model) = self.inner.model.lock() else {
                return;
            };
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

    /// Upserts an agent's recent-session entry, filling the preview/line-count
    /// from the transcript file when the cache has neither — with the disk read
    /// done *between* two short model-lock sections, never under one. Returns
    /// whether the stored entry changed. Best-effort bookkeeping: a poisoned
    /// model lock skips the upsert rather than propagating.
    fn upsert_recent_session_for_agent(&self, agent: &AgentInfo, now: u128, touch: bool) -> bool {
        let first = match self.inner.model.lock() {
            Ok(mut model) => upsert_recent_session_for_agent_locked(
                &mut model,
                agent,
                now,
                touch,
                RecentSessionMeta::CacheOnly,
            ),
            Err(_) => return false,
        };
        let mut changed = first.changed;
        if let Some(path) = first.wants_disk_meta {
            let (preview, line_count) =
                crate::transcript::read_transcript_meta(std::path::Path::new(&path));
            if (preview.is_some() || line_count > 0)
                && let Ok(mut model) = self.inner.model.lock()
            {
                changed |= upsert_recent_session_for_agent_locked(
                    &mut model,
                    agent,
                    now,
                    touch,
                    RecentSessionMeta::Loaded {
                        preview,
                        line_count,
                    },
                )
                .changed;
            }
        }
        if changed && let Ok(mut model) = self.inner.model.lock() {
            // The prune only matters after an insert grew the map; unchanged
            // upserts skip the sort-and-clone entirely.
            prune_recent_sessions_locked(&mut model);
        }
        changed
    }

    pub fn insert_agent(&self, mut agent: AgentInfo) -> Result<(), String> {
        let agent_for_sessions = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            ensure_agent_thread_metadata(self, &mut model, &mut agent);
            let agent_for_sessions = agent.clone();
            model.agents.insert(agent.id.clone(), agent);
            agent_for_sessions
        };
        self.upsert_recent_session_for_agent(&agent_for_sessions, now_millis(), true);
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
            if model
                .research_trees
                .values()
                .any(|tree| tree.workspace_id == group_id)
            {
                return Err("group is retained by a research tree".to_string());
            }
            remove_group_without_open_panes_locked(&mut model, group_id, false)
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

    pub fn update_agent(&self, mut agent: AgentInfo) -> Result<(), String> {
        let agent_for_sessions = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            ensure_agent_thread_metadata(self, &mut model, &mut agent);
            bump_agent_activity_locked(&mut model, &agent.id);
            let agent_for_sessions = agent.clone();
            model.agents.insert(agent.id.clone(), agent);
            agent_for_sessions
        };
        self.upsert_recent_session_for_agent(&agent_for_sessions, now_millis(), true);
        self.sync_research_node_from_agent(&agent_for_sessions)?;
        self.persist();
        Ok(())
    }

    /// Mutates an agent in place under the lock, applying `f` to the live entry and
    /// leaving every field `f` doesn't touch exactly as it stands. Unlike `update_agent`
    /// (which inserts a whole struct snapshot the caller read earlier, outside the lock),
    /// this can't clobber a field a concurrent writer set in the meantime — e.g. the
    /// `session_id` / `transcript_path` a freshly spawned agent's transcript validator
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
                    bump_agent_activity_locked(&mut model, agent_id);
                    Some(updated)
                }
                None => None,
            }
        };
        if let Some(agent) = updated.as_ref() {
            self.upsert_recent_session_for_agent(agent, now_millis(), true);
            self.sync_research_node_from_agent(agent)?;
            self.persist();
        }
        Ok(updated)
    }

    /// Registers a provisional transcript identity for an agent. Repeated hooks
    /// carrying the same candidate share the in-flight validator; a different
    /// candidate supersedes it and receives a new generation.
    pub(crate) fn begin_transcript_binding_candidate(
        &self,
        agent_id: &str,
        session_id: Option<&str>,
        transcript_path: Option<&str>,
    ) -> Result<Option<u64>, String> {
        let mut candidates = self
            .inner
            .transcript_binding_candidates
            .lock()
            .map_err(|_| "transcript binding candidate lock poisoned".to_string())?;
        if candidates.get(agent_id).is_some_and(|candidate| {
            candidate.session_id.as_deref() == session_id
                && (candidate.transcript_path.as_deref() == transcript_path
                    // A later lifecycle hook commonly repeats the same session id
                    // without the explicit path from SessionStart. Keep the richer
                    // validator instead of replacing it with directory discovery.
                    || candidate.transcript_path.is_some() && transcript_path.is_none())
        }) {
            return Ok(None);
        }
        let generation = self
            .inner
            .next_transcript_binding_candidate
            .fetch_add(1, Ordering::Relaxed);
        candidates.insert(
            agent_id.to_string(),
            TranscriptBindingCandidate {
                generation,
                session_id: session_id.map(ToOwned::to_owned),
                transcript_path: transcript_path.map(ToOwned::to_owned),
            },
        );
        Ok(Some(generation))
    }

    pub(crate) fn transcript_binding_candidate_is_current(
        &self,
        agent_id: &str,
        generation: u64,
    ) -> bool {
        self.inner
            .transcript_binding_candidates
            .lock()
            .ok()
            .and_then(|candidates| {
                candidates
                    .get(agent_id)
                    .map(|candidate| candidate.generation)
            })
            == Some(generation)
    }

    /// Atomically promotes a validated transcript candidate to the agent's
    /// canonical identity. Holding the candidate lock across the field-scoped
    /// model mutation prevents a superseding SessionStart from racing between
    /// the generation check and the commit.
    pub(crate) fn commit_transcript_binding_candidate(
        &self,
        agent_id: &str,
        generation: u64,
        session_id: &str,
        transcript_path: &str,
    ) -> Result<Option<AgentInfo>, String> {
        let mut candidates = self
            .inner
            .transcript_binding_candidates
            .lock()
            .map_err(|_| "transcript binding candidate lock poisoned".to_string())?;
        if candidates
            .get(agent_id)
            .map(|candidate| candidate.generation)
            != Some(generation)
        {
            return Ok(None);
        }
        let updated = self.mutate_agent(agent_id, |agent| {
            agent.session_id = Some(session_id.to_string());
            agent.transcript_path = Some(transcript_path.to_string());
        })?;
        if candidates
            .get(agent_id)
            .map(|candidate| candidate.generation)
            == Some(generation)
        {
            candidates.remove(agent_id);
        }
        Ok(updated)
    }

    pub(crate) fn clear_transcript_binding_candidate(&self, agent_id: &str, generation: u64) {
        if let Ok(mut candidates) = self.inner.transcript_binding_candidates.lock() {
            if candidates
                .get(agent_id)
                .map(|candidate| candidate.generation)
                == Some(generation)
            {
                candidates.remove(agent_id);
            }
        }
    }

    /// Records display-only workspace metadata only while the reporting tail
    /// still owns the agent's transcript binding. Git resolution happens
    /// outside this lock, so the binding must be rechecked here to prevent an
    /// old tail from winning a transcript-rotation race.
    pub fn set_agent_active_workspace_for_transcript(
        &self,
        agent_id: &str,
        transcript_path: &str,
        tail_generation: u64,
        workspace: ActiveWorkspace,
    ) -> Result<Option<AgentInfo>, String> {
        let updated = {
            let tail_key = format!("{agent_id}:{transcript_path}");
            let tails = self
                .inner
                .transcript_tails
                .lock()
                .map_err(|_| "transcript tail lock poisoned".to_string())?;
            if tails
                .get(&tail_key)
                .filter(|registration| registration.active)
                .map(|registration| registration.generation)
                != Some(tail_generation)
            {
                return Ok(None);
            }
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let Some(agent) = model.agents.get_mut(agent_id) else {
                return Ok(None);
            };
            if agent.transcript_path.as_deref() != Some(transcript_path)
                || agent.active_workspace.as_ref() == Some(&workspace)
            {
                return Ok(None);
            }
            agent.active_workspace = Some(workspace);
            agent.clone()
        };
        self.persist();
        Ok(Some(updated))
    }

    /// Reserves the Esc-interrupt grace watch for an agent, returning `true` when the
    /// caller should spawn the watcher and `false` when one is already in flight (so a
    /// held-Esc burst spawns a single thread). Best-effort: a poisoned lock returns
    /// `false`, skipping the watch rather than racing.
    pub fn begin_agent_escape_watch(&self, agent_id: &str) -> bool {
        let Ok(mut model) = self.inner.model.lock() else {
            return false;
        };
        model.agent_escape_watch.insert(agent_id.to_string())
    }

    /// Clears the Esc-interrupt grace watch reservation once the watcher thread
    /// resolves. Best-effort: a poisoned lock just leaves the entry, which only costs
    /// the next Esc burst its watch until the agent is next removed.
    pub fn end_agent_escape_watch(&self, agent_id: &str) {
        if let Ok(mut model) = self.inner.model.lock() {
            model.agent_escape_watch.remove(agent_id);
        }
    }

    /// Reserves the submit-confirmation watch for one exact send, returning `true` when
    /// the caller should spawn the watcher and `false` when that send is already being
    /// watched. Best-effort: a poisoned lock returns `false`, skipping the watch rather
    /// than racing.
    pub fn begin_agent_submit_watch(&self, agent_id: &str, send_id: u64) -> bool {
        let Ok(mut model) = self.inner.model.lock() else {
            return false;
        };
        model
            .agent_submit_watch
            .insert((agent_id.to_string(), send_id))
    }

    /// Clears a submit-confirmation watch reservation once its watcher thread
    /// resolves. Best-effort: a poisoned lock just leaves the entry, which only costs
    /// a re-arm of that exact send its watch until the agent is next removed.
    pub fn end_agent_submit_watch(&self, agent_id: &str, send_id: u64) {
        if let Ok(mut model) = self.inner.model.lock() {
            model
                .agent_submit_watch
                .remove(&(agent_id.to_string(), send_id));
        }
    }

    /// Field-scoped status write — a thin wrapper over [`AppState::mutate_agent`] that
    /// touches only `status`. Returns the updated agent, or `None` if it no longer
    /// exists.
    pub fn set_agent_status(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> Result<Option<AgentInfo>, String> {
        let (updated, status_changed) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            match model.agents.get_mut(agent_id) {
                Some(agent) => {
                    // Hooks re-assert the current status several times a second
                    // for a busy agent (PreToolUse/PostToolUse both map to
                    // Running). Only a real transition — or a material
                    // recent-session change — marks the state file dirty, so a
                    // streaming agent no longer keeps the debounced persister
                    // rewriting state.json for its whole run. The in-memory
                    // activity bumps still happen on every call; they feed the
                    // escape/idle watchers, not persistence.
                    let status_changed = agent.status != status;
                    agent.status = status;
                    let updated = agent.clone();
                    bump_agent_activity_locked(&mut model, agent_id);
                    bump_agent_status_activity_locked(&mut model, agent_id);
                    (Some(updated), status_changed)
                }
                None => (None, false),
            }
        };
        let (research_changed, session_changed) = match updated.as_ref() {
            Some(agent) => {
                let research_changed = self.sync_research_node_from_agent(agent)?;
                let session_changed =
                    self.upsert_recent_session_for_agent(agent, now_millis(), true);
                (research_changed, session_changed)
            }
            None => (false, false),
        };
        if status_changed || session_changed || research_changed {
            self.persist();
        }
        Ok(updated)
    }

    /// Records a background subagent starting under `agent_id`. The lifecycle
    /// bump also invalidates a delayed parent-Stop resolver that raced this hook.
    pub fn agent_subagent_started(
        &self,
        agent_id: &str,
        subagent_id: Option<&str>,
    ) -> Result<usize, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let active = model
            .agent_active_subagents
            .entry(agent_id.to_string())
            .or_default();
        match subagent_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => {
                active.identified.insert(id.to_string());
            }
            None => active.anonymous = active.anonymous.saturating_add(1),
        }
        let count = active.count();
        bump_agent_activity_locked(&mut model, agent_id);
        bump_agent_status_activity_locked(&mut model, agent_id);
        Ok(count)
    }

    /// Records one background subagent settling. Reaching zero does not finish
    /// the parent: it still needs a synthesis turn and a later parent Stop.
    ///
    /// Returns `Some(remaining)` when the stop matched tracked work, `None` for
    /// a stop with nothing tracked (late, duplicate, or never-started) so
    /// callers can leave the parent's status alone. Start/stop id asymmetry —
    /// one side of the pair carrying an id the other lacks — still settles one
    /// tracked subagent rather than leaving the counter wedged above zero.
    pub fn agent_subagent_stopped(
        &self,
        agent_id: &str,
        subagent_id: Option<&str>,
    ) -> Result<Option<usize>, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let remaining = match model.agent_active_subagents.get_mut(agent_id) {
            Some(active) => {
                match subagent_id.map(str::trim).filter(|id| !id.is_empty()) {
                    Some(id) => {
                        if !active.identified.remove(id) {
                            active.anonymous = active.anonymous.saturating_sub(1);
                        }
                    }
                    None => {
                        if active.anonymous > 0 {
                            active.anonymous -= 1;
                        } else if let Some(any) = active.identified.iter().next().cloned() {
                            // An anonymous stop still means one subagent settled;
                            // which tracked id it was is unknowable, so retire any.
                            active.identified.remove(&any);
                        }
                    }
                }
                Some(active.count())
            }
            None => None,
        };
        if remaining.is_none_or(|remaining| remaining == 0) {
            model.agent_active_subagents.remove(agent_id);
        }
        bump_agent_activity_locked(&mut model, agent_id);
        bump_agent_status_activity_locked(&mut model, agent_id);
        Ok(remaining)
    }

    pub fn agent_has_active_subagents(&self, agent_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agent_active_subagents
            .get(agent_id)
            .is_some_and(|active| !active.is_empty()))
    }

    pub fn clear_agent_subagents(&self, agent_id: &str) {
        if let Ok(mut model) = self.inner.model.lock() {
            model.agent_active_subagents.remove(agent_id);
        }
    }

    /// Records whether the agent's most recent Stop reported still-running
    /// background tasks, so the idle-prompt boundary can honor the same wait
    /// the Stop handler established (see the field's doc for lifecycle).
    pub fn set_agent_background_tasks_reported(
        &self,
        agent_id: &str,
        reported: bool,
    ) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if reported {
            model
                .agents_with_reported_background_tasks
                .insert(agent_id.to_string());
        } else {
            model.agents_with_reported_background_tasks.remove(agent_id);
        }
        Ok(())
    }

    pub fn agent_has_reported_background_tasks(&self, agent_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agents_with_reported_background_tasks
            .contains(agent_id))
    }

    /// Unconditional append, kept for tests: production tails go through
    /// [`Self::append_turn_for_transcript`] so a rebind can't splice a dead
    /// file's parse over the new timeline.
    #[cfg(test)]
    pub fn append_turn(&self, turn: Turn) -> Result<(), String> {
        self.append_turn_internal(turn, None).map(|_| ())
    }

    /// Tail-scoped append: applies only while `transcript_path` is still the
    /// agent's bound transcript, and reports whether it applied. A tail checks
    /// its binding at the top of each poll, but a rebind (rewind rotation, a
    /// session picker choice, recovery) can land between that check and this
    /// write — an unconditional write would splice the dead file's parse over
    /// the new tail's timeline. Checking under the model lock closes that race.
    pub fn append_turn_for_transcript(
        &self,
        turn: Turn,
        transcript_path: &str,
    ) -> Result<bool, String> {
        self.append_turn_internal(turn, Some(transcript_path))
    }

    fn append_turn_internal(
        &self,
        turn: Turn,
        bound_transcript_path: Option<&str>,
    ) -> Result<bool, String> {
        let (should_persist_state, agent_for_graph, graph_store) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let agent_id = turn.agent_id.clone();
            if let Some(bound_transcript_path) = bound_transcript_path {
                let still_bound = model.agents.get(&agent_id).is_some_and(|agent| {
                    agent.transcript_path.as_deref() == Some(bound_transcript_path)
                });
                if !still_bound {
                    return Ok(false);
                }
            }
            let is_user_turn = turn.role == "user";
            bump_agent_activity_locked(&mut model, &agent_id);
            let turns = model.turns.entry(agent_id.clone()).or_default();
            // Positional turn ids can be reused across a transcript rewrite or
            // rebind; the appended turn is the newest content for its id, so drop
            // any stale same-id entry rather than duplicating it mid-list.
            turns.retain(|existing| existing.id != turn.id);
            turns.push(turn.clone());
            if turns.len() > MAX_TURNS_PER_AGENT {
                let overflow = turns.len() - MAX_TURNS_PER_AGENT;
                turns.drain(..overflow);
            }
            let agent_for_graph = model.agents.get(&agent_id).cloned();
            let agent_is_research = agent_for_graph.as_ref().is_some_and(|agent| {
                model
                    .groups
                    .get(&agent.group_id)
                    .is_some_and(|group| group.scope == WorkspaceScope::Research)
            });
            let should_persist_recent = if is_user_turn && !agent_is_research {
                agent_for_graph.clone().is_some_and(|agent| {
                    // CacheOnly: the turn just appended supplies the in-memory
                    // preview/line-count, so the disk fallback has nothing to add
                    // — and this runs under the model lock.
                    upsert_recent_session_for_agent_locked(
                        &mut model,
                        &agent,
                        now_millis(),
                        true,
                        RecentSessionMeta::CacheOnly,
                    )
                    .changed
                })
            } else {
                false
            };
            let mut graph_store = None;
            let mut created_thread_record = false;
            if let Some(agent) = agent_for_graph.as_ref().filter(|_| !agent_is_research) {
                let (store, created) = thread_store_for_agent_locked(
                    &mut model,
                    agent,
                    &self.inner.config.workspace_root,
                );
                graph_store = Some(store);
                created_thread_record = created;
            }
            (
                should_persist_recent || created_thread_record,
                agent_for_graph,
                graph_store,
            )
        };
        if let (Some(agent), Some(store)) = (agent_for_graph, graph_store)
            && let Err(err) = store.append_turn_node(&agent, &turn)
        {
            eprintln!(
                "qmux: failed to append thread graph for agent {}: {err}",
                agent.id
            );
        }
        if should_persist_state {
            self.persist();
        }
        if let Some(agent) = self.agent(&turn.agent_id)?
            && self.sync_research_node_from_agent(&agent)?
        {
            self.persist();
        }
        Ok(true)
    }

    /// Unconditional replace, kept for tests: production tails go through
    /// [`Self::replace_turns_for_transcript`] (see there for the race).
    #[cfg(test)]
    pub fn replace_turns(&self, agent_id: &str, turns: Vec<Turn>) -> Result<(), String> {
        self.replace_turns_internal(agent_id, turns, None)
            .map(|_| ())
    }

    /// Tail-scoped replace: applies only while `transcript_path` is still the
    /// agent's bound transcript, and reports whether it applied. See
    /// [`Self::append_turn_for_transcript`] for the race this closes — for a
    /// replace the stakes are higher, since a stale tail's late full-window
    /// refresh would wholesale swap the new transcript's timeline for the dead
    /// file's parse.
    pub fn replace_turns_for_transcript(
        &self,
        agent_id: &str,
        transcript_path: &str,
        turns: Vec<Turn>,
    ) -> Result<bool, String> {
        self.replace_turns_internal(agent_id, turns, Some(transcript_path))
    }

    fn replace_turns_internal(
        &self,
        agent_id: &str,
        mut turns: Vec<Turn>,
        bound_transcript_path: Option<&str>,
    ) -> Result<bool, String> {
        let turns_for_graph = turns.clone();
        let (should_persist_state, agent_for_graph, graph_store) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if let Some(bound_transcript_path) = bound_transcript_path {
                let still_bound = model.agents.get(agent_id).is_some_and(|agent| {
                    agent.transcript_path.as_deref() == Some(bound_transcript_path)
                });
                if !still_bound {
                    return Ok(false);
                }
            }
            if turns.len() > MAX_TURNS_PER_AGENT {
                let overflow = turns.len() - MAX_TURNS_PER_AGENT;
                turns.drain(..overflow);
            }
            bump_agent_activity_locked(&mut model, agent_id);
            model.turns.insert(agent_id.to_string(), turns);
            let agent_for_graph = model.agents.get(agent_id).cloned();
            let agent_is_research = agent_for_graph.as_ref().is_some_and(|agent| {
                model
                    .groups
                    .get(&agent.group_id)
                    .is_some_and(|group| group.scope == WorkspaceScope::Research)
            });
            let should_persist_recent = !agent_is_research
                && agent_for_graph.clone().is_some_and(|agent| {
                    upsert_recent_session_for_agent_locked(
                        &mut model,
                        &agent,
                        now_millis(),
                        true,
                        RecentSessionMeta::CacheOnly,
                    )
                    .changed
                });
            let mut graph_store = None;
            let mut created_thread_record = false;
            if let Some(agent) = agent_for_graph.as_ref().filter(|_| !agent_is_research) {
                let (store, created) = thread_store_for_agent_locked(
                    &mut model,
                    agent,
                    &self.inner.config.workspace_root,
                );
                graph_store = Some(store);
                created_thread_record = created;
            }
            (
                should_persist_recent || created_thread_record,
                agent_for_graph,
                graph_store,
            )
        };
        if let (Some(agent), Some(store)) = (agent_for_graph, graph_store)
            && let Err(err) = store.replace_agent_branch_turns(&agent, &turns_for_graph)
        {
            eprintln!(
                "qmux: failed to write thread graph for agent {}: {err}",
                agent.id
            );
        }
        if should_persist_state {
            self.persist();
        }
        if let Some(agent) = self.agent(agent_id)?
            && self.sync_research_node_from_agent(&agent)?
        {
            self.persist();
        }
        Ok(true)
    }

    /// Test convenience: queues a plain text turn with no directives. Production
    /// callers build a [`QueuedTurn`] and use [`Self::enqueue_agent_queued_turn`].
    #[cfg(test)]
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

    /// Queues a fully-formed turn (text plus any pause/wait/delivery directives).
    pub fn enqueue_agent_queued_turn(
        &self,
        agent_id: &str,
        turn: QueuedTurn,
    ) -> Result<usize, String> {
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
        expected_id: Option<&str>,
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
            // The id is the authoritative identity: duplicate-text turns are
            // indistinguishable by text alone, so a shifted duplicate would pass
            // the text guard. Both are checked when supplied.
            if let Some(expected_id) = expected_id
                && turn.id != expected_id
            {
                return Err("queued turn changed; refresh before updating".to_string());
            }
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
        expected_id: Option<&str>,
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
            if let Some(expected_id) = expected_id
                && current.id != expected_id
            {
                return Err("queued turn changed; refresh before editing".to_string());
            }
            if let Some(expected_data) = expected_data
                && current.text != expected_data
            {
                return Err("queued turn changed; refresh before editing".to_string());
            }

            let removed = queue
                .remove(index)
                .ok_or_else(|| format!("queued turn {index} was not found"))?;
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
        expected_id: Option<&str>,
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
            if expected_id.is_some() || expected_data.is_some() {
                let current = queue
                    .get(from)
                    .ok_or_else(|| format!("queued turn {from} was not found"))?;
                if let Some(expected_id) = expected_id
                    && current.id != expected_id
                {
                    return Err("queued turn changed; refresh before reordering".to_string());
                }
                if let Some(expected_data) = expected_data
                    && current.text != expected_data
                {
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
            if model.agent_fork_barriers.contains_key(agent_id) {
                return Ok(AgentTurnClaim::Idle);
            }
            match pop_ready_locked(&mut model, agent_id) {
                Some((turn, pending)) => {
                    model.agent_draining.insert(agent_id.to_string());
                    // Keep a durable copy until delivery confirms, so a crash mid-send
                    // re-queues the turn on restart instead of dropping it.
                    model
                        .agent_inflight
                        .insert(agent_id.to_string(), turn.clone());
                    AgentTurnClaim::Ready { turn, pending }
                }
                None => return Ok(AgentTurnClaim::Idle),
            }
        };
        self.persist();
        Ok(claim)
    }

    /// The idle-handler variant of [`claim_ready_agent_turn`]: atomically decides, under
    /// the model lock, what an agent reaching a ready state should do. Returns `Busy`
    /// when another drain already owns the agent (the caller must not touch its status),
    /// `Sent` after claiming a ready turn for the caller to send, or `Idle` after settling
    /// the agent to `settled_status`. Crucially the typing check and status write happen
    /// under the same lock, so a racing `set_agent_typing(false)` that clears the flag and
    /// re-reads the status observes a ready state and drains the held turn — closing the
    /// lost-wakeup where it would otherwise see stale `Running`, skip its drain, and
    /// strand the queue.
    pub fn claim_next_turn_or_settle(
        &self,
        agent_id: &str,
        settled_status: AgentStatus,
    ) -> Result<IdleAdvance, String> {
        debug_assert!(matches!(
            settled_status,
            AgentStatus::AwaitingInput | AgentStatus::Done | AgentStatus::Idle
        ));
        let (outcome, settled_agent) = {
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
            if model.agent_fork_barriers.contains_key(agent_id) {
                let settled_agent = model.agents.get_mut(agent_id).map(|agent| {
                    agent.status = settled_status;
                    agent.clone()
                });
                (IdleAdvance::Idle, settled_agent)
            } else if model.agent_typing.contains(agent_id) {
                // User is mid-keystroke: hold the queue and settle atomically with
                // reading the typing flag (see the doc comment).
                let settled_agent = model.agents.get_mut(agent_id).map(|agent| {
                    agent.status = settled_status;
                    agent.clone()
                });
                (IdleAdvance::Idle, settled_agent)
            } else if let Some((turn, pending)) = pop_ready_locked(&mut model, agent_id) {
                model.agent_draining.insert(agent_id.to_string());
                // Durable copy until delivery confirms (see claim_ready_agent_turn).
                model
                    .agent_inflight
                    .insert(agent_id.to_string(), turn.clone());
                (IdleAdvance::Sent { turn, pending }, None)
            } else {
                let settled_agent = model.agents.get_mut(agent_id).map(|agent| {
                    agent.status = settled_status;
                    agent.clone()
                });
                (IdleAdvance::Idle, settled_agent)
            }
        };
        // The status write above must stay inside the queue/typing decision's lock.
        // Run the same post-write synchronization after releasing it so a background
        // research pane can react to a terminal status without waiting for another
        // transcript or focus-triggered update.
        if let Some(agent) = settled_agent.as_ref() {
            self.sync_research_node_from_agent(agent)?;
        }
        self.persist();
        Ok(outcome)
    }

    /// Clears the draining guard set by a successful claim, allowing the next drain to
    /// proceed. Returns whether a fresh direct send was queued while this owner was in
    /// flight; delivery owners that leave the source idle use that signal to avoid a
    /// lost wakeup. Best-effort: a poisoned lock just leaves the guard set, which fails
    /// safe (no further auto-drain) rather than risking a double-send.
    pub fn finish_agent_drain(&self, agent_id: &str) -> bool {
        if let Ok(mut model) = self.inner.model.lock() {
            model.agent_draining.remove(agent_id);
            return model.agent_deferred_queue_resume.remove(agent_id);
        }
        false
    }

    /// Reserves the draining guard for a direct (user-initiated) send, serializing it
    /// against queue drains through the same `agent_draining` flag. Returns `false`
    /// when a drain — or another direct send — already owns the agent, so the caller
    /// should queue behind it instead of writing a second turn into the same pane
    /// concurrently. Pair every `true` with [`finish_agent_drain`].
    pub fn begin_direct_send(&self, agent_id: &str) -> Result<bool, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if model.agent_draining.contains(agent_id)
            || model.agent_fork_barriers.contains_key(agent_id)
        {
            return Ok(false);
        }
        model.agent_draining.insert(agent_id.to_string());
        Ok(true)
    }

    /// Queues a direct send that lost the drain reservation race. Queue insertion and
    /// its wakeup marker are one model-lock transaction: a fork-ready hook cannot
    /// remove the barrier between those two operations, and a failed enqueue cannot
    /// accidentally turn manual send-next into automatic queue draining.
    pub fn enqueue_agent_queued_turn_after_direct_contention(
        &self,
        agent_id: &str,
        turn: QueuedTurn,
    ) -> Result<usize, String> {
        let len = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let len = enqueue_queued_turn_locked(&mut model, agent_id, turn)?;
            if let Some(barrier) = model.agent_fork_barriers.get_mut(agent_id) {
                barrier.resume_queue = true;
            } else if model.agent_draining.contains(agent_id) {
                // The contending owner may be between popping `/fork` and installing
                // its child barrier. begin_agent_fork_barrier consumes this marker.
                model
                    .agent_deferred_queue_resume
                    .insert(agent_id.to_string());
            }
            len
        };
        self.persist();
        Ok(len)
    }

    /// Installs the live fork barrier after the child process has spawned but before
    /// the source's ordinary drain guard is released. The readiness check and insert
    /// share the model lock with prompt-hook accounting, closing both orderings of the
    /// race: a fast child that accepted its prompt before spawn returned needs no
    /// barrier, while a later hook observes the inserted barrier and releases it.
    /// Returns whether the source is now blocked.
    pub fn begin_agent_fork_barrier(
        &self,
        source_agent_id: &str,
        child_agent_id: &str,
        resume_queue: bool,
    ) -> Result<bool, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        // The child id comes from the PaneInfo returned by the internal fork spawn,
        // never caller input. If its record has already vanished, the pane's teardown
        // won the race and the child process is dead; treating that as already safe
        // consumes the at-most-once fork instead of reporting an error that would
        // requeue and potentially spawn a duplicate.
        let Some(child) = model.agents.get(child_agent_id) else {
            return Ok(false);
        };
        let has_independent_session = child
            .session_id
            .as_deref()
            .zip(child.fork_point.as_deref())
            .is_some_and(|(session_id, fork_point)| session_id != fork_point);
        let accepted_initial_prompt = model
            .agent_send_tracking
            .get(child_agent_id)
            .is_some_and(|tracking| tracking.ups_seq > 0);
        if has_independent_session && accepted_initial_prompt {
            return Ok(false);
        }
        if let Some(existing) = model.agent_fork_barriers.get(source_agent_id) {
            if existing.child_agent_id == child_agent_id {
                return Ok(true);
            }
            return Err(format!(
                "agent {source_agent_id} is already waiting for forked agent {}",
                existing.child_agent_id
            ));
        }
        let resume_queue =
            resume_queue || model.agent_deferred_queue_resume.remove(source_agent_id);
        model.agent_fork_barriers.insert(
            source_agent_id.to_string(),
            AgentForkBarrier {
                child_agent_id: child_agent_id.to_string(),
                ready: false,
                resume_queue,
            },
        );
        Ok(true)
    }

    /// Drops a source-owned barrier when that source can no longer accept work (pane
    /// close, shell-agent detach, or replacement). The fork child may keep running,
    /// but there is no source input left to protect and no attached source queue that
    /// should be resumed when the child eventually reports readiness.
    pub fn cancel_agent_fork_barrier_for_source(
        &self,
        source_agent_id: &str,
    ) -> Result<bool, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.agent_deferred_queue_resume.remove(source_agent_id);
        Ok(model.agent_fork_barriers.remove(source_agent_id).is_some())
    }

    /// Atomically hands fork-dispatch ownership back after the child spawn has been
    /// fully recorded. A ready hook that arrived while the ordinary drain guard was
    /// held marks the barrier ready instead of removing it; this method then consumes
    /// it and tells the dispatching caller to continue. If readiness has not arrived,
    /// the barrier remains for the hook-side resume path.
    pub fn finish_agent_fork_dispatch(
        &self,
        source_agent_id: &str,
    ) -> Result<FinishedAgentForkDispatch, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.agent_draining.remove(source_agent_id);
        let (ready, resume_queue) = model
            .agent_fork_barriers
            .get(source_agent_id)
            .map(|barrier| (barrier.ready, barrier.resume_queue))
            .unwrap_or((true, false));
        if ready {
            model.agent_fork_barriers.remove(source_agent_id);
        }
        Ok(FinishedAgentForkDispatch {
            ready,
            resume_queue,
        })
    }

    pub fn agent_fork_barrier_active(&self, source_agent_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agent_fork_barriers.contains_key(source_agent_id))
    }

    /// Removes a barrier only when the child has both a distinct native-session id
    /// and at least one authenticated prompt-submit hook. Either signal alone is too
    /// early for native forks: startup may briefly report the source identity, while
    /// merely allocating the child session does not prove its launch prompt was
    /// accepted. Returns the source whose queue may now resume.
    pub fn take_ready_agent_fork_barrier(
        &self,
        child_agent_id: &str,
    ) -> Result<Option<ReleasedAgentForkBarrier>, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(source_agent_id) =
            model
                .agent_fork_barriers
                .iter()
                .find_map(|(source_agent_id, barrier)| {
                    (barrier.child_agent_id == child_agent_id).then(|| source_agent_id.clone())
                })
        else {
            return Ok(None);
        };
        let Some(child) = model.agents.get(child_agent_id) else {
            return Ok(None);
        };
        let has_independent_session = child
            .session_id
            .as_deref()
            .zip(child.fork_point.as_deref())
            .is_some_and(|(session_id, fork_point)| session_id != fork_point);
        let accepted_initial_prompt = model
            .agent_send_tracking
            .get(child_agent_id)
            .is_some_and(|tracking| tracking.ups_seq > 0);
        if !has_independent_session || !accepted_initial_prompt {
            return Ok(None);
        }
        if model.agent_draining.contains(&source_agent_id) {
            if let Some(barrier) = model.agent_fork_barriers.get_mut(&source_agent_id) {
                barrier.ready = true;
            }
            return Ok(None);
        }
        let barrier = model
            .agent_fork_barriers
            .remove(&source_agent_id)
            .expect("barrier located above");
        Ok(Some(ReleasedAgentForkBarrier {
            source_agent_id,
            resume_queue: barrier.resume_queue,
        }))
    }

    /// Releases the barrier after the child process has definitively exited. Once the
    /// process is dead it cannot read more source transcript, so resuming the source
    /// is safe even though child initialization never completed.
    pub fn abort_agent_fork_barrier(
        &self,
        child_agent_id: &str,
    ) -> Result<Option<ReleasedAgentForkBarrier>, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let source_agent_id =
            model
                .agent_fork_barriers
                .iter()
                .find_map(|(source_agent_id, barrier)| {
                    (barrier.child_agent_id == child_agent_id).then(|| source_agent_id.clone())
                });
        let Some(source_agent_id) = source_agent_id else {
            return Ok(None);
        };
        if model.agent_draining.contains(&source_agent_id) {
            let resume_queue = model
                .agent_fork_barriers
                .get_mut(&source_agent_id)
                .map(|barrier| {
                    // Use the same owner handoff as normal readiness. The abort-side
                    // resume attempt below observes the still-held drain guard and is a
                    // no-op; finish_agent_fork_dispatch then consumes this marker and
                    // lets its caller continue, closing the status-settlement race.
                    barrier.ready = true;
                    barrier.resume_queue
                })
                .unwrap_or(false);
            return Ok(Some(ReleasedAgentForkBarrier {
                source_agent_id,
                resume_queue,
            }));
        }
        Ok(model
            .agent_fork_barriers
            .remove(&source_agent_id)
            .map(|barrier| ReleasedAgentForkBarrier {
                source_agent_id,
                resume_queue: barrier.resume_queue,
            }))
    }

    /// Clears a delivered turn's in-flight record. Called once its bytes reach the PTY,
    /// so a crash before this leaves the turn in the persisted queue (via
    /// `restore_session`) to be re-delivered rather than lost.
    pub fn clear_agent_inflight(&self, agent_id: &str) {
        let changed = match self.inner.model.lock() {
            Ok(mut model) => model.agent_inflight.remove(agent_id).is_some(),
            Err(_) => false,
        };
        if changed {
            self.persist();
        }
    }

    /// Rolls a turn that failed to send back to the front of its queue and clears its
    /// in-flight record in one locked step, so the persisted snapshot never holds the
    /// same turn in both places (which would double-send it on restart).
    pub fn requeue_inflight_after_failed_drain(&self, agent_id: &str, turn: QueuedTurn) {
        let ok = match self.inner.model.lock() {
            Ok(mut model) => {
                model.agent_inflight.remove(agent_id);
                model
                    .agent_turn_queues
                    .entry(agent_id.to_string())
                    .or_default()
                    .push_front(turn);
                true
            }
            Err(_) => false,
        };
        if ok {
            self.persist();
        } else {
            eprintln!(
                "qmux: dropped queued turn for agent {agent_id} after failed re-queue (model lock poisoned)"
            );
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

    /// Snapshot of the transient machinery between an agent queue and its PTY.
    /// Exposed only to the opt-in in-app Debug panel; it does not mutate or clear
    /// tracking, so observing a missed submit cannot change its recovery behavior.
    pub fn agent_delivery_debug(&self, agent_id: &str) -> Result<AgentDeliveryDebugInfo, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if !model.agents.contains_key(agent_id) {
            return Err(format!("Agent {agent_id} was not found"));
        }
        let mut submit_watch_send_ids = model
            .agent_submit_watch
            .iter()
            .filter_map(|(id, send_id)| (id == agent_id).then_some(*send_id))
            .collect::<Vec<_>>();
        submit_watch_send_ids.sort_unstable();
        Ok(AgentDeliveryDebugInfo {
            typing: model.agent_typing.contains(agent_id),
            draining: model.agent_draining.contains(agent_id),
            pending_pause: model.agent_pending_pause.contains(agent_id),
            activity_revision: model
                .agent_activity
                .get(agent_id)
                .copied()
                .unwrap_or_default(),
            status_revision: model
                .agent_status_activity
                .get(agent_id)
                .copied()
                .unwrap_or_default(),
            queued_turns: model
                .agent_turn_queues
                .get(agent_id)
                .into_iter()
                .flatten()
                .map(AgentDeliveryDebugTurn::from)
                .collect(),
            inflight: model
                .agent_inflight
                .get(agent_id)
                .map(AgentDeliveryDebugTurn::from),
            outstanding_sends: model
                .agent_send_tracking
                .get(agent_id)
                .map(|tracking| tracking.outstanding_sends.iter().cloned().collect())
                .unwrap_or_default(),
            submit_watch_send_ids,
        })
    }

    /// Stores the agent's composer draft and snapshots it to disk. A trimmed-empty
    /// draft drops the entry so recovery never restores stray whitespace and the
    /// map does not grow an entry per cleared composer.
    /// The current millisecond wall clock, matching QmuxEvent timestamps.
    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    }

    pub fn global_drafts(&self) -> Result<Vec<GlobalDraft>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.global_drafts.clone())
    }

    /// Emits the full drafts list — the store is small and global, so every
    /// mutation broadcasts the whole truth instead of deltas.
    fn emit_global_drafts(&self, drafts: &[GlobalDraft]) {
        self.emit(QmuxEvent::new(
            "drafts.changed",
            None,
            None,
            json!({ "drafts": drafts }),
        ));
    }

    pub fn create_global_draft(&self, text: String) -> Result<GlobalDraft, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Draft text cannot be empty".to_string());
        }
        let draft = GlobalDraft {
            id: self.next_id("draft"),
            text: trimmed.to_string(),
            created_at: Self::now_millis(),
            consumed: None,
        };
        let drafts = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model.global_drafts.push(draft.clone());
            model.global_drafts.clone()
        };
        self.persist();
        self.emit_global_drafts(&drafts);
        Ok(draft)
    }

    pub fn update_global_draft(&self, draft_id: &str, text: String) -> Result<GlobalDraft, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Draft text cannot be empty".to_string());
        }
        let (draft, drafts) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let draft = model
                .global_drafts
                .iter_mut()
                .find(|draft| draft.id == draft_id)
                .ok_or_else(|| format!("Draft {draft_id} was not found"))?;
            if draft.consumed.is_some() {
                return Err("Draft was already assigned".to_string());
            }
            draft.text = trimmed.to_string();
            (draft.clone(), model.global_drafts.clone())
        };
        self.persist();
        self.emit_global_drafts(&drafts);
        Ok(draft)
    }

    pub fn delete_global_draft(&self, draft_id: &str) -> Result<Vec<GlobalDraft>, String> {
        let drafts = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let before = model.global_drafts.len();
            model.global_drafts.retain(|draft| draft.id != draft_id);
            if model.global_drafts.len() == before {
                return Err(format!("Draft {draft_id} was not found"));
            }
            model.global_drafts.clone()
        };
        self.persist();
        self.emit_global_drafts(&drafts);
        Ok(drafts)
    }

    /// Atomically claims a draft for assignment: marks it consumed only if it
    /// wasn't already, so two concurrent assigns can't both deliver the text.
    /// The claim happens before the submit; `unclaim_global_draft` rolls it
    /// back if the submit fails (the move_queued_agent_turn shape).
    pub fn claim_global_draft(
        &self,
        draft_id: &str,
        agent_id: &str,
    ) -> Result<GlobalDraft, String> {
        let (draft, drafts) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let draft = model
                .global_drafts
                .iter_mut()
                .find(|draft| draft.id == draft_id)
                .ok_or_else(|| format!("Draft {draft_id} was not found"))?;
            if draft.consumed.is_some() {
                return Err("Draft was already assigned".to_string());
            }
            draft.consumed = Some(GlobalDraftConsumed {
                agent_id: agent_id.to_string(),
                at: Self::now_millis(),
            });
            (draft.clone(), model.global_drafts.clone())
        };
        self.persist();
        self.emit_global_drafts(&drafts);
        Ok(draft)
    }

    pub fn unclaim_global_draft(&self, draft_id: &str) -> Result<(), String> {
        let drafts = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let Some(draft) = model
                .global_drafts
                .iter_mut()
                .find(|draft| draft.id == draft_id)
            else {
                return Ok(());
            };
            draft.consumed = None;
            model.global_drafts.clone()
        };
        self.persist();
        self.emit_global_drafts(&drafts);
        Ok(())
    }

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

    pub fn interface_draft(&self, key: &str) -> Result<Option<String>, String> {
        validate_interface_draft_key(key)?;
        let drafts = self
            .inner
            .interface_drafts
            .lock()
            .map_err(|_| "interface draft lock poisoned".to_string())?;
        Ok(drafts.get(key).cloned())
    }

    pub fn set_interface_draft(&self, key: &str, value: Option<String>) -> Result<(), String> {
        validate_interface_draft_key(key)?;
        if value
            .as_ref()
            .is_some_and(|value| value.len() > MAX_INTERFACE_DRAFT_VALUE_BYTES)
        {
            return Err(format!(
                "interface draft exceeds {} bytes",
                MAX_INTERFACE_DRAFT_VALUE_BYTES
            ));
        }
        let mut drafts = self
            .inner
            .interface_drafts
            .lock()
            .map_err(|_| "interface draft lock poisoned".to_string())?;
        let existing_bytes = drafts.get(key).map_or(0, String::len);
        let next_bytes = value.as_ref().map_or(0, String::len);
        let total_bytes = drafts
            .values()
            .map(String::len)
            .sum::<usize>()
            .saturating_sub(existing_bytes)
            .saturating_add(next_bytes);
        if total_bytes > MAX_INTERFACE_DRAFT_TOTAL_BYTES {
            return Err(format!(
                "interface drafts exceed {} bytes",
                MAX_INTERFACE_DRAFT_TOTAL_BYTES
            ));
        }
        if let Some(value) = value {
            drafts.insert(key.to_string(), value);
        } else {
            drafts.remove(key);
        }
        Ok(())
    }

    pub fn record_agent_send(
        &self,
        agent_id: &str,
        text: String,
        source: AgentSendSource,
    ) -> Result<u64, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let tracking = model
            .agent_send_tracking
            .entry(agent_id.to_string())
            .or_default();
        tracking.prune_expired(now_millis());
        tracking.next_send_id = tracking.next_send_id.wrapping_add(1).max(1);
        let send_id = tracking.next_send_id;
        tracking.outstanding_sends.push_back(AgentOutstandingSend {
            id: send_id,
            text,
            sent_at_seq: tracking.ups_seq,
            sent_at_ms: now_millis(),
            source,
        });
        Ok(send_id)
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
        tracking.prune_expired(now_millis());
        tracking.ups_seq = tracking.ups_seq.saturating_add(1);
        let outstanding_count = tracking.outstanding_sends.len();

        let Some(prompt) = prompt else {
            return Ok(AgentPromptSubmitMatch::MissingPrompt {
                outstanding_sends: outstanding_count,
            });
        };

        if tracking.outstanding_sends.is_empty() {
            return Ok(AgentPromptSubmitMatch::Untracked {
                actual: prompt.to_string(),
                outstanding_sends: 0,
            });
        }

        if let Some(index) = tracking
            .outstanding_sends
            .iter()
            .position(|send| prompts_match(prompt, &send.text))
        {
            let matched = tracking
                .outstanding_sends
                .remove(index)
                .expect("matching index checked above");
            drop(tracking.outstanding_sends.drain(..index));
            Ok(AgentPromptSubmitMatch::Matched {
                source: matched.source,
                outstanding_sends: tracking.outstanding_sends.len(),
            })
        } else {
            Ok(AgentPromptSubmitMatch::Mismatched {
                expected: tracking
                    .outstanding_sends
                    .front()
                    .expect("non-empty checked above")
                    .text
                    .clone(),
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

    // Rewinds recorded send times so tests can cross OUTSTANDING_SEND_TTL_MS without
    // sleeping through it.
    #[cfg(test)]
    pub fn age_agent_outstanding_sends(&self, agent_id: &str, by_ms: u128) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if let Some(tracking) = model.agent_send_tracking.get_mut(agent_id) {
            for send in &mut tracking.outstanding_sends {
                send.sent_at_ms = send.sent_at_ms.saturating_sub(by_ms);
            }
        }
        Ok(())
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

    /// Removes advisory send records matching `filter`, returning how many were
    /// dropped. Used at idle boundaries to reap hookless queued TUI commands that
    /// will never receive a prompt-submit echo and would otherwise block the queue.
    pub fn clear_agent_outstanding_sends_by<F>(
        &self,
        agent_id: &str,
        mut filter: F,
    ) -> Result<usize, String>
    where
        F: FnMut(&AgentOutstandingSend) -> bool,
    {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(tracking) = model.agent_send_tracking.get_mut(agent_id) else {
            return Ok(0);
        };
        tracking.prune_expired(now_millis());
        let before = tracking.outstanding_sends.len();
        tracking.outstanding_sends.retain(|send| !filter(send));
        Ok(before - tracking.outstanding_sends.len())
    }

    /// Current value of the agent's activity counter (see `Model::agent_activity`).
    /// An agent with no recorded activity reads as 0.
    pub fn agent_activity_seq(&self, agent_id: &str) -> Result<u64, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.agent_activity.get(agent_id).copied().unwrap_or(0))
    }

    pub fn agent_has_outstanding_send_source(
        &self,
        agent_id: &str,
        source: AgentSendSource,
    ) -> Result<bool, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .agent_send_tracking
            .get_mut(agent_id)
            .is_some_and(|tracking| {
                tracking.prune_expired(now_millis());
                tracking
                    .outstanding_sends
                    .iter()
                    .any(|send| send.source == source)
            }))
    }

    /// What a submit-confirmation watch should conclude about one exact send: gone
    /// (confirmed or superseded), still outstanding with prompt activity after it,
    /// or still outstanding with no prompt submitted since. The distinction matters
    /// because `match_agent_prompt_submit` only pops when the submitted prompt
    /// contains the sent text — a turn that submitted with mangled text leaves its
    /// record outstanding, and recovery must not treat that as "never started".
    pub fn check_agent_submit_watch(
        &self,
        agent_id: &str,
        send_id: u64,
    ) -> Result<SubmitWatchStatus, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(tracking) = model.agent_send_tracking.get_mut(agent_id) else {
            return Ok(SubmitWatchStatus::Confirmed);
        };
        tracking.prune_expired(now_millis());
        let Some(send) = tracking
            .outstanding_sends
            .iter()
            .find(|send| send.id == send_id)
        else {
            return Ok(SubmitWatchStatus::Confirmed);
        };
        if tracking.ups_seq > send.sent_at_seq {
            Ok(SubmitWatchStatus::StillPendingWithPromptActivity)
        } else {
            Ok(SubmitWatchStatus::StillPending)
        }
    }

    /// Reclaims a send that was written to a pane but never echoed a prompt submit:
    /// atomically removes the exact outstanding-send record and puts the turn back
    /// at the front of its agent's queue, returning the new queue snapshot. Returns
    /// `Ok(None)` — without touching the queue — when the record is already gone
    /// (its echo won the race, or an idle boundary cleared it), so a turn that did
    /// start can never be requeued into a duplicate. Callers should tag the turn
    /// `possibly_pasted` so its retry submits without re-pasting.
    pub fn requeue_unconfirmed_send(
        &self,
        agent_id: &str,
        send_id: u64,
        turn: QueuedTurn,
    ) -> Result<Option<Vec<QueuedTurn>>, String> {
        let queued_turns = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let Some(tracking) = model.agent_send_tracking.get_mut(agent_id) else {
                return Ok(None);
            };
            let Some(index) = tracking
                .outstanding_sends
                .iter()
                .position(|send| send.id == send_id)
            else {
                return Ok(None);
            };
            tracking.outstanding_sends.remove(index);
            let queue = model
                .agent_turn_queues
                .entry(agent_id.to_string())
                .or_default();
            queue.push_front(turn);
            queue.iter().cloned().collect::<Vec<_>>()
        };
        self.persist();
        Ok(Some(queued_turns))
    }

    /// Removes one exact advisory send record, used to roll back tracking when
    /// the pane write fails after the record was reserved but before delivery.
    pub fn remove_agent_outstanding_send_id(
        &self,
        agent_id: &str,
        send_id: u64,
    ) -> Result<bool, String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(tracking) = model.agent_send_tracking.get_mut(agent_id) else {
            return Ok(false);
        };
        let Some(index) = tracking
            .outstanding_sends
            .iter()
            .position(|send| send.id == send_id)
        else {
            return Ok(false);
        };
        tracking.outstanding_sends.remove(index);
        Ok(true)
    }

    pub fn mark_transcript_tail(
        &self,
        agent_id: &str,
        path: &str,
        observe_snapshot_workspace: bool,
    ) -> Result<Option<(u64, Arc<Mutex<()>>)>, String> {
        let key = format!("{agent_id}:{path}");
        let mut tails = self
            .inner
            .transcript_tails
            .lock()
            .map_err(|_| "transcript tail lock poisoned".to_string())?;
        let agent_prefix = format!("{agent_id}:");
        // One gate per agent serializes both same-file mode transitions and
        // transcript rotation. The old path may already be parsing when a hook
        // binds the new path; sharing its gate ensures every old model/lifecycle
        // side effect finishes before the replacement tail processes anything.
        let gate = tails
            .iter()
            .find(|(existing_key, _)| existing_key.starts_with(&agent_prefix))
            .map(|(_, registration)| registration.gate.clone())
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        for (other_key, registration) in tails.iter_mut() {
            if other_key.starts_with(&agent_prefix) && other_key != &key {
                registration.active = false;
            }
        }
        if tails.get(&key).is_some_and(|registration| {
            registration.active
                && registration.observe_snapshot_workspace == observe_snapshot_workspace
        }) {
            return Ok(None);
        }
        let generation = self
            .inner
            .next_transcript_tail
            .fetch_add(1, Ordering::Relaxed);
        tails.insert(
            key,
            TranscriptTailRegistration {
                generation,
                observe_snapshot_workspace,
                active: true,
                gate: gate.clone(),
            },
        );
        Ok(Some((generation, gate)))
    }

    pub fn transcript_tail_is_current(&self, agent_id: &str, path: &str, generation: u64) -> bool {
        let key = format!("{agent_id}:{path}");
        self.inner.transcript_tails.lock().ok().and_then(|tails| {
            tails
                .get(&key)
                .filter(|registration| registration.active)
                .map(|registration| registration.generation)
        }) == Some(generation)
    }

    /// Drops the marker for a tail that is stopping (its file rotated away, its
    /// agent went away, or a different transcript superseded it) so inactive
    /// registrations do not accumulate. A newer generation for the same key is
    /// preserved. Best-effort: a poisoned lock is ignored rather than propagated,
    /// since this only runs as a tail unwinds.
    pub fn clear_transcript_tail(&self, agent_id: &str, path: &str, generation: u64) {
        let key = format!("{agent_id}:{path}");
        if let Ok(mut tails) = self.inner.transcript_tails.lock() {
            if tails.get(&key).map(|registration| registration.generation) == Some(generation) {
                tails.remove(&key);
            }
        }
    }

    /// Whether a pane is currently registered, regardless of backend.
    pub fn pane_exists(&self, pane_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.contains_key(pane_id))
    }

    pub fn pane_writer(&self, pane_id: &str) -> Result<Option<SharedWriter>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .and_then(|pane| pane.backend.writer()))
    }

    pub fn pane_master(&self, pane_id: &str) -> Result<Option<SharedMaster>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .and_then(|pane| pane.backend.host_master()))
    }

    pub fn pane_child(&self, pane_id: &str) -> Result<Option<SharedChild>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .and_then(|pane| pane.backend.host_child()))
    }

    /// Snapshots every live pane's id and child handle. Used by the app-exit
    /// teardown to take down each pane's process tree, since quit bypasses the
    /// per-pane `kill_pane` path.
    pub fn all_pane_children(&self) -> Result<Vec<(String, SharedChild)>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .iter()
            .filter_map(|(pane_id, pane)| {
                pane.backend
                    .host_child()
                    .map(|child| (pane_id.clone(), child))
            })
            .collect())
    }

    /// Returns the per-pane send lock, minting one on first use. `write_pane` holds
    /// it across a paste+submit sequence so concurrent submits don't interleave. See
    /// the `pane_send_locks` field.
    pub fn pane_send_lock(&self, pane_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self
            .inner
            .pane_send_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.entry(pane_id.to_string()).or_default().clone()
    }

    pub fn pane_backlog(&self, pane_id: &str) -> Result<Option<SharedBacklog>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.backend.backlog()))
    }

    pub fn pane_is_native(&self, pane_id: &str) -> Result<Option<bool>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .map(|pane| pane.backend.uses_native_surface()))
    }

    pub fn pane_has_host_pty(&self, pane_id: &str) -> Result<Option<bool>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .map(|pane| pane.backend.has_host_pty()))
    }

    pub(crate) fn set_remote_launch_plan(
        &self,
        pane_id: &str,
        identity: RemoteSessionIdentity,
        commands: RemoteTmuxCommands,
    ) -> Result<(), String> {
        let mut model = self.inner.model.lock().map_err(|_| "model lock poisoned")?;
        let pane = model
            .panes
            .get_mut(pane_id)
            .ok_or("remote pane was closed")?;
        let PaneBackend::RemoteTmux(backend) = &mut pane.backend else {
            return Err("pane is not remote".into());
        };
        if pane
            .info
            .remote_session
            .as_ref()
            .map(|value| &value.tmux_session)
            != Some(&identity.tmux_session)
        {
            return Err("remote launch identity changed".into());
        }
        pane.info.remote_session = Some(identity);
        backend.commands = commands;
        drop(model);
        self.persist();
        Ok(())
    }

    pub fn pane_remote_control(
        &self,
        pane_id: &str,
    ) -> Result<
        Option<(
            Arc<RemoteAttachmentController>,
            Arc<RemoteHistoryCheckpoint>,
            RemoteTmuxCommands,
        )>,
        String,
    > {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .panes
            .get(pane_id)
            .and_then(|pane| pane.backend.remote_control()))
    }

    pub fn update_remote_connection(
        &self,
        pane_id: &str,
        state: RemoteConnectionState,
        message: Option<String>,
    ) -> Result<(), String> {
        self.mutate_remote_connection(pane_id, |connection| {
            connection.state = state;
            connection.message = message;
            connection.stage = None;
            connection.session_exists = None;
            connection.next_retry_at = None;
            if state != RemoteConnectionState::Connected {
                connection.disconnected_at.get_or_insert(now_millis());
            }
        })
    }

    pub fn mutate_remote_connection(
        &self,
        pane_id: &str,
        update: impl FnOnce(&mut RemoteConnectionInfo),
    ) -> Result<(), String> {
        let connection = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let pane = model
                .panes
                .get_mut(pane_id)
                .ok_or_else(|| format!("pane {pane_id} was not found"))?;
            if pane.info.remote_session.is_none() {
                return Err(format!("pane {pane_id} is not remote"));
            }
            let connection = pane
                .info
                .remote_connection
                .get_or_insert_with(Default::default);
            update(connection);
            connection.clone()
        };
        self.emit(QmuxEvent::new(
            "pane.remote_connection",
            Some(pane_id.to_string()),
            None,
            json!({ "connection": connection }),
        ));
        if connection.state == RemoteConnectionState::Connected {
            self.persist();
        }
        Ok(())
    }

    pub fn research_pane_accepts_input(&self, pane_id: &str) -> Result<Option<bool>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let Some(node) = model
            .research_nodes
            .values()
            .find(|node| node.pane_id.as_deref() == Some(pane_id))
        else {
            return Ok(None);
        };
        let allowed = node
            .agent_id
            .as_deref()
            .and_then(|agent_id| model.agents.get(agent_id))
            .is_some_and(|agent| {
                matches!(
                    agent.status,
                    AgentStatus::AwaitingPermission | AgentStatus::AwaitingInput
                )
            });
        Ok(Some(allowed))
    }

    /// Whether the agent is (or was) the run behind a research node. Research
    /// runs take exactly one prompt at launch; queued turns can never drain
    /// into them and would park the agent past pane retirement.
    pub fn agent_is_research_run(&self, agent_id: &str) -> Result<bool, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .research_nodes
            .values()
            .any(|node| node.agent_id.as_deref() == Some(agent_id)))
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
        self.update_pane_workspace_inner(pane_id, cwd, None)
    }

    /// Applies workspace metadata resolved by qmux-cli on the pane's host.
    /// Local panes continue to use the desktop's authoritative filesystem/Git
    /// probe; remote panes cannot be resolved against that filesystem and use
    /// this authenticated, display-only observation instead.
    pub fn update_pane_workspace(
        &self,
        pane_id: &str,
        cwd: String,
        workspace: ActiveWorkspace,
    ) -> Result<(), String> {
        self.update_pane_workspace_inner(pane_id, cwd, Some(workspace))
    }

    fn update_pane_workspace_inner(
        &self,
        pane_id: &str,
        cwd: String,
        reported_workspace: Option<ActiveWorkspace>,
    ) -> Result<(), String> {
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
        // A legitimate shell-integration report is always an existing absolute
        // directory; rejecting anything else keeps malformed values out of
        // persisted state and ensures recovery has a usable working directory.
        let candidate = std::path::Path::new(&cwd);
        if !candidate.is_absolute() {
            return Err("pane cwd must be an absolute path; refusing to persist".to_string());
        }
        let is_remote = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model
                .panes
                .get(pane_id)
                .and_then(|pane| model.groups.get(&pane.info.group_id))
                .is_some_and(GroupInfo::is_remote)
        };
        if !is_remote && !candidate.is_dir() {
            return Err("pane cwd is not an existing directory; refusing to persist".to_string());
        }
        if let Some(workspace) = reported_workspace.as_ref() {
            validate_reported_workspace(&cwd, workspace)?;
        }
        let (observation_seq, cwd_changed, is_shell) = {
            let _commit_guard = self
                .inner
                .pane_cwd_commit_lock
                .lock()
                .map_err(|_| "pane cwd commit lock poisoned".to_string())?;
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let Some(pane) = model.panes.get_mut(pane_id) else {
                return Ok(());
            };
            let cwd_changed = pane.info.cwd != cwd;
            let is_shell = matches!(pane.info.kind, PaneKind::Shell);
            if !cwd_changed && !is_shell {
                return Ok(());
            }
            pane.cwd_observation_seq = pane.cwd_observation_seq.wrapping_add(1);
            let observation_seq = pane.cwd_observation_seq;
            if cwd_changed {
                pane.info.cwd = cwd.clone();
                pane.info.active_workspace = None;
            }
            (observation_seq, cwd_changed, is_shell)
        };

        // Agent panes have no PaneInfo workspace observation, so an unchanged
        // cwd remains a no-op for them. Shell panes probe at every prompt: a
        // branch can change without the directory changing.
        // Resolve outside both short commit sections: git can invoke hooks or
        // otherwise take time, and must not pin the model or block other panes.
        let active_workspace = if !is_shell {
            None
        } else if is_remote {
            reported_workspace
        } else {
            crate::workspace::resolve_pane_workspace(&cwd)
        };

        let _commit_guard = self
            .inner
            .pane_cwd_commit_lock
            .lock()
            .map_err(|_| "pane cwd commit lock poisoned".to_string())?;
        let (pane_updates, agent_updates) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let reporter_changed = {
                let Some(pane) = model.panes.get_mut(pane_id) else {
                    return Ok(());
                };
                // A newer cwd/prompt report supersedes this probe even when it is
                // for the same directory. Never persist or emit its stale result.
                if pane.cwd_observation_seq != observation_seq || pane.info.cwd != cwd {
                    return Ok(());
                }
                let workspace_changed = is_shell && pane.info.active_workspace != active_workspace;
                if workspace_changed {
                    pane.info.active_workspace = active_workspace.clone();
                }
                cwd_changed || workspace_changed
            };

            let mut pane_updates = Vec::new();
            if reporter_changed && let Some(pane) = model.panes.get(pane_id) {
                pane_updates.push(pane.info.clone());
            }
            let mut agent_updates = Vec::new();

            // A successful shell observation is authoritative for the checkout,
            // not just the pane that happened to reach a prompt first. Refresh
            // other local shell panes and agents when they are in the exact same
            // directory or elsewhere under the same canonical checkout root.
            // `git_root` is the worktree top-level, deliberately not the common
            // Git directory: linked worktrees share the latter but have separate
            // HEADs and therefore must not exchange branch observations.
            if let Some(observed) = active_workspace.as_ref() {
                let remote_group_ids = model
                    .groups
                    .iter()
                    .filter(|(_, group)| group.is_remote())
                    .map(|(group_id, _)| group_id.clone())
                    .collect::<HashSet<_>>();

                for (peer_id, peer) in model.panes.iter_mut() {
                    if peer_id == pane_id
                        || !matches!(peer.info.kind, PaneKind::Shell)
                        || remote_group_ids.contains(&peer.info.group_id)
                        || !workspace_observation_matches(
                            &peer.info.cwd,
                            peer.info.active_workspace.as_ref(),
                            &cwd,
                            observed,
                        )
                    {
                        continue;
                    }
                    let next = propagated_workspace(
                        observed,
                        peer.info.active_workspace.as_ref(),
                        &peer.info.cwd,
                    );
                    if peer.info.active_workspace.as_ref() == Some(&next) {
                        continue;
                    }
                    peer.info.active_workspace = Some(next);
                    pane_updates.push(peer.info.clone());
                }

                for agent in model.agents.values_mut() {
                    if agent.pane_id.is_none() || remote_group_ids.contains(&agent.group_id) {
                        continue;
                    }
                    let agent_cwd = agent
                        .active_workspace
                        .as_ref()
                        .map(|workspace| workspace.cwd.as_str())
                        .unwrap_or(agent.worktree_dir.as_str());
                    if !workspace_observation_matches(
                        agent_cwd,
                        agent.active_workspace.as_ref(),
                        &cwd,
                        observed,
                    ) {
                        continue;
                    }
                    let mut next =
                        propagated_workspace(observed, agent.active_workspace.as_ref(), agent_cwd);
                    if agent.active_workspace.is_none() {
                        // Before an adapter reports its first command cwd, a
                        // locally launched agent may still be using its launch
                        // workspace. Preserve the ownership meaning normally
                        // assigned by record_agent_active_workspace.
                        next.managed_by_qmux = agent.branch.is_some()
                            && next.git_root.as_deref().is_some_and(|root| {
                                crate::adapters::same_dir(root, &agent.worktree_dir)
                            });
                    }
                    if agent.active_workspace.as_ref() == Some(&next) {
                        continue;
                    }
                    agent.active_workspace = Some(next);
                    agent_updates.push(agent.clone());
                }
            }

            (pane_updates, agent_updates)
        };
        if pane_updates.is_empty() && agent_updates.is_empty() {
            return Ok(());
        }

        self.persist();
        for pane in pane_updates {
            // Carry cwd and workspace together so the tab path, context-menu cwd,
            // branch, and worktree badge advance as one ordered observation.
            self.emit(QmuxEvent::new(
                "pane.cwd_changed",
                Some(pane.id.clone()),
                None,
                json!({
                    "paneId": pane.id,
                    "cwd": pane.cwd,
                    "activeWorkspace": pane.active_workspace,
                }),
            ));
        }
        for agent in agent_updates {
            self.emit(QmuxEvent::new(
                "agent.workspace_changed",
                agent.pane_id.clone(),
                Some(agent.id.clone()),
                json!({ "agent": agent }),
            ));
        }
        Ok(())
    }

    /// Records the newest OSC 0/2 title for a pane without changing its durable
    /// user/generated `title`. Live callers receive the normalized value so the
    /// event stream and the recovery snapshot use identical text.
    pub fn update_last_osc_title(
        &self,
        pane_id: &str,
        raw_title: &str,
    ) -> Result<Option<String>, String> {
        let (title, changed) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let adapter_id = model
                .panes
                .get(pane_id)
                .and_then(|pane| pane.info.agent_id.as_ref())
                .and_then(|agent_id| model.agents.get(agent_id))
                .map(|agent| agent.adapter.clone());
            let title = sanitize_last_osc_title(raw_title, adapter_id.as_deref());
            let Some(pane) = model.panes.get_mut(pane_id) else {
                // Native title callbacks can arrive after pane teardown. Treat
                // that as a harmless late delivery rather than surfacing an
                // error from the AppKit main thread.
                return Ok(title);
            };
            if pane.info.last_osc_title == title {
                (title, false)
            } else {
                pane.info.last_osc_title = title.clone();
                (title, true)
            }
        };
        if changed {
            self.schedule_last_osc_title_persist();
        }
        Ok(title)
    }

    fn schedule_last_osc_title_persist(&self) {
        if !self.inner.persist_enabled.load(Ordering::Relaxed) {
            return;
        }
        if cfg!(test) {
            self.persist_now();
            return;
        }
        if self
            .inner
            .last_osc_title_persist_scheduled
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let state = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(LAST_OSC_TITLE_PERSIST_INTERVAL);
            state
                .inner
                .last_osc_title_persist_scheduled
                .store(false, Ordering::SeqCst);
            // The ordinary persister adds its short coalescing window and owns
            // snapshot ordering. A clean exit may already have committed and
            // disabled persistence, in which case this is a no-op.
            state.persist();
        });
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

pub fn now_millis() -> u128 {
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

/// Where `upsert_recent_session_for_agent_locked` may take a preview/line-count
/// fallback from when neither the in-memory turns nor the cached entry have one.
enum RecentSessionMeta {
    /// Never touch the disk. Callers inside long-lived lock scopes use this;
    /// the returned `wants_disk_meta` tells them (via
    /// `AppState::upsert_recent_session_for_agent`) that a read would help.
    CacheOnly,
    /// Transcript meta the caller read from disk *outside* the model lock.
    Loaded {
        preview: Option<String>,
        line_count: usize,
    },
}

struct RecentSessionUpsert {
    changed: bool,
    /// The transcript path worth reading for preview/line-count, set only in
    /// `CacheOnly` mode when the cache had neither.
    wants_disk_meta: Option<String>,
}

impl RecentSessionUpsert {
    fn unchanged() -> Self {
        Self {
            changed: false,
            wants_disk_meta: None,
        }
    }
}

fn upsert_recent_session_for_agent_locked(
    model: &mut Model,
    agent: &AgentInfo,
    now: u128,
    touch: bool,
    meta: RecentSessionMeta,
) -> RecentSessionUpsert {
    if model
        .groups
        .get(&agent.group_id)
        .is_some_and(|group| group.scope == WorkspaceScope::Research)
    {
        return RecentSessionUpsert::unchanged();
    }
    let Some(key) = agent_recent_session_key(agent) else {
        return RecentSessionUpsert::unchanged();
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
    let has_live_turns = turns.is_some_and(|turns| !turns.is_empty());
    let mut line_count = turns.map(Vec::len).unwrap_or(0);
    let mut preview = if has_live_turns {
        turns.and_then(|turns| first_user_turn_preview(turns))
    } else {
        existing
            .as_ref()
            .and_then(|session| session.preview.clone())
    };

    // Prefer the line count cached on the previous recent-session entry before
    // considering the disk. An actively-growing session keeps its turns in
    // memory (line_count above), so the on-disk fallback below only serves cold
    // sessions whose files aren't changing — making the cached count a faithful
    // substitute.
    if line_count == 0 {
        line_count = existing
            .as_ref()
            .map(|session| session.line_count)
            .unwrap_or(0);
    }

    // This runs under the model lock, so the transcript file is never read
    // here: reading and parsing a whole (possibly cold, possibly huge) JSONL
    // would stall every other thread — including main-thread input handling —
    // behind that I/O. Callers either supply meta they read outside the lock
    // (`Loaded`) or get the path back and re-enter with the data
    // (`AppState::upsert_recent_session_for_agent`).
    let mut wants_disk_meta = None;
    if (!has_live_turns && preview.is_none() || line_count == 0)
        && let Some(transcript_path) = agent.transcript_path.as_deref()
    {
        match &meta {
            RecentSessionMeta::CacheOnly => {
                wants_disk_meta = Some(transcript_path.to_string());
            }
            RecentSessionMeta::Loaded {
                preview: disk_preview,
                line_count: disk_line_count,
            } => {
                if !has_live_turns && preview.is_none() {
                    preview = disk_preview.clone();
                }
                if line_count == 0 {
                    line_count = *disk_line_count;
                }
            }
        }
    }

    let created_at = existing
        .as_ref()
        .map(|session| session.created_at)
        .unwrap_or(agent.created_at);
    let previous_active_at = existing
        .as_ref()
        .map(|session| session.last_active_at)
        .unwrap_or(agent.created_at);
    let last_active_at = if touch { now } else { previous_active_at };

    let next = RecentSessionInfo {
        id: key.clone(),
        adapter: agent.adapter.clone(),
        group_id: Some(agent.group_id.clone()),
        session_id: agent.session_id.clone(),
        transcript_path: agent.transcript_path.clone(),
        worktree_dir: agent.worktree_dir.clone(),
        branch: agent.branch.clone(),
        model: agent.model.clone(),
        effort: agent.effort.clone(),
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
        return RecentSessionUpsert {
            changed: false,
            wants_disk_meta,
        };
    }
    // Coarsen pure re-touches. A busy agent's hooks re-touch its session
    // several times a second for the whole run; each fresh `last_active_at`
    // made the entry differ, marked the state file dirty, and kept the
    // debounced persister rewriting (and fsyncing) state.json every window
    // for the duration. When nothing but the activity stamp moved, only
    // re-stamp once it has drifted by the coarseness — recency ordering
    // (Home, spawn-cwd inheritance) is unaffected by a few seconds of slack,
    // and any real change (status, transcript, preview) still lands with a
    // fresh stamp immediately via the comparison below.
    if touch
        && let Some(existing) = existing.as_ref()
        && now.saturating_sub(previous_active_at) < RECENT_SESSION_TOUCH_COARSENESS_MS
    {
        let comparable = RecentSessionInfo {
            last_active_at: previous_active_at,
            ..next.clone()
        };
        if *existing == comparable {
            return RecentSessionUpsert {
                changed: false,
                wants_disk_meta,
            };
        }
    }
    model.recent_sessions.insert(key, next);
    RecentSessionUpsert {
        changed: true,
        wants_disk_meta,
    }
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
    matches!(
        (
        session.transcript_path.as_deref(),
        agent.transcript_path.as_deref(),
        ),
        (Some(left), Some(right)) if !left.trim().is_empty() && left == right
    )
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
        .filter(|turn| turn.role == "user" && research::turn_is_in_active_context(turn))
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
/// panes missing from it (sorted by id for determinism).
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

/// The durable Research sidebar order. Older state files have no explicit
/// vector, so missing ids fall back to the legacy updated-at order once, then
/// hydration persists that normalized result.
fn ordered_research_tree_ids(model: &Model) -> Vec<String> {
    let mut ids = Vec::with_capacity(model.research_trees.len());
    let mut seen = HashSet::with_capacity(model.research_trees.len());

    for tree_id in &model.research_tree_order {
        if model.research_trees.contains_key(tree_id) && seen.insert(tree_id.clone()) {
            ids.push(tree_id.clone());
        }
    }

    let mut missing = model
        .research_trees
        .values()
        .filter(|tree| !seen.contains(&tree.id))
        .collect::<Vec<_>>();
    missing.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then(left.id.cmp(&right.id))
    });
    ids.extend(missing.into_iter().map(|tree| tree.id.clone()));
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
        if has_queue {
            agent.paused = true;
        }
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
        upsert_recent_session_for_agent_locked(
            model,
            &agent,
            now_millis(),
            true,
            RecentSessionMeta::CacheOnly,
        );
    }
    model.agents.remove(agent_id);
    model.turns.remove(agent_id);
    model.agent_turn_queues.remove(agent_id);
    model.agent_drafts.remove(agent_id);
    model.agent_typing.remove(agent_id);
    model.agent_pending_pause.remove(agent_id);
    model.agent_draining.remove(agent_id);
    model.agent_fork_barriers.remove(agent_id);
    model.agent_deferred_queue_resume.remove(agent_id);
    model.agent_send_tracking.remove(agent_id);
    model.agent_activity.remove(agent_id);
    model.agent_status_activity.remove(agent_id);
    model.agent_active_subagents.remove(agent_id);
    model.agent_escape_watch.remove(agent_id);
    model
        .agent_submit_watch
        .retain(|(watched_agent, _)| watched_agent != agent_id);
    clear_recent_session_binding_locked(model, Some(agent_id), None);
}

/// Bumps the per-agent activity counter; see `Model::agent_activity`.
fn bump_agent_activity_locked(model: &mut Model, agent_id: &str) {
    let seq = model
        .agent_activity
        .entry(agent_id.to_string())
        .or_insert(0);
    *seq = seq.wrapping_add(1);
}

/// Bumps the per-agent status/lifecycle counter; see `Model::agent_status_activity`.
fn bump_agent_status_activity_locked(model: &mut Model, agent_id: &str) {
    let seq = model
        .agent_status_activity
        .entry(agent_id.to_string())
        .or_insert(0);
    *seq = seq.wrapping_add(1);
}

/// Every research-node mutation is a tree mutation for ordering/recency
/// purposes; failure and detachment paths previously skipped this, leaving
/// `updated_at` stale exactly when a tree last changed by failing.
fn touch_research_tree_locked(model: &mut Model, tree_id: &str, now: u128) {
    if let Some(tree) = model.research_trees.get_mut(tree_id) {
        tree.updated_at = now;
    }
}

/// Splits research-owned panes and agents out of the ordinary groups used by
/// the original research implementation. The migration runs for version-2
/// state and for version-3 snapshots written by the short-lived transitional
/// build where scope existed but research still referenced Terminal groups.
fn migrate_legacy_research_workspaces(
    state: &AppState,
    persisted: &mut PersistedState,
) -> (bool, Vec<String>) {
    let mut changed = drop_research_recent_sessions(persisted);
    let mut warnings = Vec::new();

    // Backfill tree ownership from its root node before deciding which groups
    // need to split. A missing root is handled by structural reconciliation.
    for tree in persisted.research_trees.values_mut() {
        if tree.workspace_id.trim().is_empty()
            && let Some(root) = persisted.research_nodes.get(&tree.root_node_id)
        {
            tree.workspace_id = root.group_id.clone();
            changed = true;
        }
    }

    let group_scope = persisted
        .groups
        .iter()
        .map(|group| (group.id.clone(), group.scope))
        .collect::<HashMap<_, _>>();
    let mut legacy_group_ids = persisted
        .research_trees
        .values()
        .filter_map(|tree| {
            (group_scope.get(&tree.workspace_id) != Some(&WorkspaceScope::Research))
                .then_some(tree.workspace_id.clone())
        })
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    legacy_group_ids.sort();
    legacy_group_ids.dedup();

    for legacy_group_id in legacy_group_ids {
        let tree_ids = persisted
            .research_trees
            .values()
            .filter(|tree| tree.workspace_id == legacy_group_id)
            .map(|tree| tree.id.clone())
            .collect::<HashSet<_>>();
        let source_index = persisted
            .groups
            .iter()
            .position(|group| group.id == legacy_group_id);
        let legacy_dir = source_index
            .map(|index| persisted.groups[index].dir.clone())
            .or_else(|| {
                persisted
                    .research_trees
                    .values()
                    .filter(|tree| tree_ids.contains(&tree.id))
                    .filter_map(|tree| persisted.research_nodes.get(&tree.root_node_id))
                    .map(|root| root.worktree_dir.clone())
                    .find(|dir| !dir.trim().is_empty())
            });
        let Some(legacy_dir) = legacy_dir else {
            warnings.push(format!(
                "research workspace migration could not recover a folder for legacy group {legacy_group_id}"
            ));
            continue;
        };
        let source = source_index
            .map(|index| persisted.groups[index].clone())
            .unwrap_or_else(|| {
                let name = std::path::Path::new(&legacy_dir)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or("Recovered")
                    .to_string();
                GroupInfo {
                    id: legacy_group_id.clone(),
                    name,
                    name_override: Some("Recovered Research".to_string()),
                    dir: legacy_dir.clone(),
                    managed_dir: String::new(),
                    base_repo: None,
                    base_ref: Some("HEAD".to_string()),
                    parent_id: None,
                    created_at: now_millis(),
                    collapsed: false,
                    scope: WorkspaceScope::Terminal,
                    imported_research_archive_id: None,
                    remote: None,
                    agents: Vec::new(),
                }
            });
        let dir_key = research_workspace_dir_key(&legacy_dir);
        let existing_research_group = persisted
            .groups
            .iter()
            .find(|group| {
                group.scope == WorkspaceScope::Research
                    && research_workspace_dir_key(&group.dir) == dir_key
            })
            .cloned();
        let created_research_group = existing_research_group.is_none();
        let mut research_group = match existing_research_group {
            Some(group) => group,
            None => match crate::workspace::clone_group_record_for_scope(
                state,
                &source,
                WorkspaceScope::Research,
            ) {
                Ok(group) => group,
                Err(err) => {
                    warnings.push(format!(
                        "could not isolate legacy research group {legacy_group_id}: {err}"
                    ));
                    continue;
                }
            },
        };

        let research_pane_ids = persisted
            .research_nodes
            .values()
            .filter(|node| tree_ids.contains(&node.tree_id))
            .filter_map(|node| node.pane_id.clone())
            .collect::<HashSet<_>>();
        let research_agent_ids = persisted
            .research_nodes
            .values()
            .filter(|node| tree_ids.contains(&node.tree_id))
            .filter_map(|node| node.agent_id.clone())
            .collect::<HashSet<_>>();
        research_group
            .agents
            .extend(research_agent_ids.iter().cloned());
        research_group.agents.sort();
        research_group.agents.dedup();
        let mut updated_source = source_index.map(|index| persisted.groups[index].clone());
        if let Some(source) = &mut updated_source {
            source
                .agents
                .retain(|agent_id| !research_agent_ids.contains(agent_id));
        }
        if let Err(err) = crate::workspace::write_group_manifest(&research_group) {
            warnings.push(format!(
                "could not finish migrated research workspace {}: {err}",
                research_group.id
            ));
            if created_research_group {
                let _ = std::fs::remove_dir_all(&research_group.managed_dir);
            }
            continue;
        }
        if let Some(source) = &updated_source
            && let Err(err) = crate::workspace::write_group_manifest(source)
        {
            warnings.push(format!(
                "could not update legacy terminal workspace {legacy_group_id}: {err}"
            ));
            if created_research_group {
                let _ = std::fs::remove_dir_all(&research_group.managed_dir);
            } else if let Some(original) = persisted
                .groups
                .iter()
                .find(|group| group.id == research_group.id)
            {
                let _ = crate::workspace::write_group_manifest(original);
            }
            continue;
        }

        let research_group_id = research_group.id.clone();
        for tree in persisted.research_trees.values_mut() {
            if tree.workspace_id == legacy_group_id {
                tree.workspace_id = research_group_id.clone();
            }
        }
        for node in persisted.research_nodes.values_mut() {
            if tree_ids.contains(&node.tree_id) {
                node.group_id = research_group_id.clone();
            }
        }
        for pane in &mut persisted.panes {
            if pane.group_id == legacy_group_id && research_pane_ids.contains(&pane.id) {
                pane.group_id = research_group_id.clone();
                pane.depth = 0;
            }
        }
        for agent in &mut persisted.agents {
            if agent.group_id == legacy_group_id && research_agent_ids.contains(&agent.id) {
                agent.group_id = research_group_id.clone();
            }
        }
        if let Some(index) = persisted
            .groups
            .iter()
            .position(|group| group.id == research_group_id)
        {
            persisted.groups[index] = research_group;
        } else {
            let insert_index = source_index.map_or(persisted.groups.len(), |index| index + 1);
            persisted.groups.insert(insert_index, research_group);
            if let Some(order_index) = persisted
                .group_order
                .iter()
                .position(|id| id == &legacy_group_id)
            {
                persisted
                    .group_order
                    .insert(order_index + 1, research_group_id.clone());
            } else {
                persisted.group_order.push(research_group_id.clone());
            }
        }
        if let (Some(index), Some(source)) = (source_index, updated_source) {
            persisted.groups[index] = source;
        }
        let source_still_used = persisted
            .panes
            .iter()
            .any(|pane| pane.group_id == legacy_group_id)
            || persisted
                .agents
                .iter()
                .any(|agent| agent.group_id == legacy_group_id);
        if !source_still_used {
            persisted.groups.retain(|group| group.id != legacy_group_id);
            persisted.group_order.retain(|id| id != &legacy_group_id);
        }
        changed = true;
    }

    // Split groups are viewport constructs and cannot span modes. Drop only the
    // invalid split; the normal layout reconciliation keeps all valid siblings.
    let pane_group = persisted
        .panes
        .iter()
        .map(|pane| (pane.id.clone(), pane.group_id.clone()))
        .collect::<HashMap<_, _>>();
    let scope_by_group = persisted
        .groups
        .iter()
        .map(|group| (group.id.clone(), group.scope))
        .collect::<HashMap<_, _>>();
    let split_count = persisted.pane_splits.len();
    persisted.pane_splits.retain(|split| {
        let mut scopes = split.pane_ids.iter().filter_map(|pane_id| {
            pane_group
                .get(pane_id)
                .and_then(|group_id| scope_by_group.get(group_id))
        });
        let first = scopes.next();
        first.is_none_or(|first| scopes.all(|scope| scope == first))
    });
    changed |= persisted.pane_splits.len() != split_count;

    (changed, warnings)
}

fn research_workspace_dir_key(dir: &str) -> std::path::PathBuf {
    let path = std::path::PathBuf::from(dir);
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn drop_research_recent_sessions(persisted: &mut PersistedState) -> bool {
    let agent_ids = persisted
        .research_nodes
        .values()
        .filter_map(|node| node.agent_id.clone())
        .collect::<HashSet<_>>();
    let pane_ids = persisted
        .research_nodes
        .values()
        .filter_map(|node| node.pane_id.clone())
        .collect::<HashSet<_>>();
    let session_ids = persisted
        .research_nodes
        .values()
        .filter_map(|node| node.native_session_id.clone())
        .collect::<HashSet<_>>();
    let transcript_paths = persisted
        .research_nodes
        .values()
        .filter_map(|node| node.transcript_path.clone())
        .collect::<HashSet<_>>();
    let before = persisted.recent_sessions.len();
    persisted.recent_sessions.retain(|session| {
        !session
            .agent_id
            .as_ref()
            .is_some_and(|id| agent_ids.contains(id))
            && !session
                .pane_id
                .as_ref()
                .is_some_and(|id| pane_ids.contains(id))
            && !session
                .session_id
                .as_ref()
                .is_some_and(|id| session_ids.contains(id))
            && !session
                .transcript_path
                .as_ref()
                .is_some_and(|path| transcript_paths.contains(path))
    });
    before != persisted.recent_sessions.len()
}

/// Adapter contract this mapping (and research completion as a whole) depends
/// on: a research-capable adapter must report `Done`/`Idle` at end-of-turn
/// while its process stays alive, and must report subagent start/stop boundaries
/// when foreground idleness can coexist with background work. An adapter that instead *rests* at
/// `AwaitingInput` after a normal turn would leave its nodes Researching…
/// forever (no completion, no snapshot, no retirement, no follow-ups); one
/// whose process exits on completion relies on `detach_research_pane`'s
/// agent-finished check to settle Complete instead of Failed.
fn research_node_has_live_execution(node: &ResearchNode) -> bool {
    node.pane_id.is_some()
        || node.status.is_active()
        || (node.runtime == ResearchRuntime::Sdk
            && crate::research_runtime::session_registered(&node.id))
}

fn research_status_for_agent(
    status: AgentStatus,
    has_active_subagents: bool,
) -> ResearchNodeStatus {
    match status {
        AgentStatus::Starting => ResearchNodeStatus::Starting,
        // AwaitingInput is a mid-turn pause (elicitation / clarifying question),
        // not completion: the adapters return to Running once the user answers,
        // so the node must stay live or retirement would kill the waiting agent.
        AgentStatus::Running | AgentStatus::AwaitingPermission | AgentStatus::AwaitingInput => {
            ResearchNodeStatus::Running
        }
        AgentStatus::Done | AgentStatus::Idle if has_active_subagents => {
            ResearchNodeStatus::Running
        }
        AgentStatus::Done | AgentStatus::Idle => ResearchNodeStatus::Complete,
        AgentStatus::Failed => ResearchNodeStatus::Failed,
    }
}

fn validate_research_workspace_available(workspace: &GroupInfo) -> Result<(), String> {
    let dir = std::path::Path::new(&workspace.dir);
    if !dir.is_dir() {
        return Err(format!(
            "research folder '{}' is unavailable; restore it at that path before launching another run for '{}'",
            workspace.dir,
            workspace
                .name_override
                .as_deref()
                .unwrap_or(&workspace.name)
        ));
    }
    Ok(())
}

fn remove_group_without_open_panes_locked(
    model: &mut Model,
    group_id: &str,
    preserve_research: bool,
) -> bool {
    if model
        .panes
        .values()
        .any(|pane| pane.info.group_id == group_id)
    {
        return false;
    }

    if preserve_research
        && model
            .groups
            .get(group_id)
            .is_some_and(|group| group.scope == WorkspaceScope::Research)
    {
        return false;
    }

    // Legacy safeguard: after workspace migration every research node should
    // reference a Research-scoped group, but keep old or partially recovered
    // state from losing its launch context.
    if model
        .research_trees
        .values()
        .any(|tree| tree.workspace_id == group_id)
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
                info.depth = 0;
                info
            })
        })
        .collect()
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
        // A nested tree owns the geometry: `axis` mirrors its root — so a
        // collapse can flip the split from columns to rows — and `sizes` is
        // derived from its leaves, keeping the flat fallback plausible for a
        // build that predates nesting.
        let tree = normalized_split_root(split.root, &pane_ids);
        let axis = match &tree {
            Some((PaneSplitNode::Split { axis, .. }, _)) => *axis,
            _ => split.axis,
        };
        let sizes = match &tree {
            Some((node, _)) => {
                let mut derived = HashMap::new();
                leaf_sizes_from_root(node, &mut derived);
                derived
            }
            None => split
                .sizes
                .into_iter()
                .filter(|(pane_id, size)| {
                    pane_id_set.contains(pane_id) && size.is_finite() && *size > 0.0
                })
                .collect(),
        };
        let root = tree.and_then(|(node, nested)| nested.then_some(node));
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
            axis,
            root,
        });
    }

    Ok(result)
}

fn prompts_match(actual: &str, expected: &str) -> bool {
    let actual = normalize_prompt(actual);
    let expected = normalize_prompt(expected);
    actual == expected || (!expected.is_empty() && actual.contains(&expected))
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
mod tests;
