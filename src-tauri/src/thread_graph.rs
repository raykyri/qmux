use crate::transcript::{Turn, TurnBlock, TurnStatus, TurnStatusReason};
use crate::workspace::AgentInfo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGraph {
    pub version: u32,
    pub thread_id: String,
    pub focused_branch_id: String,
    pub next_created_order: u64,
    pub root_turn_ids: Vec<String>,
    pub branches: HashMap<String, ThreadBranch>,
    pub nodes: HashMap<String, ThreadNode>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBranch {
    pub id: String,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_branch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_from_turn_id: Option<String>,
    pub head_turn_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by_actor_id: Option<String>,
    pub created_at: u64,
    pub status: ThreadBranchStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadBranchStatus {
    Active,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ThreadNode {
    #[serde(rename = "turn")]
    Turn(TurnNode),
    #[serde(rename = "handoff")]
    Handoff(HandoffNode),
    #[serde(rename = "branchStart")]
    BranchStart(BranchStartNode),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnNode {
    #[serde(flatten)]
    pub base: BaseThreadNode,
    pub turn: ThreadTurnContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeTurnRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffNode {
    #[serde(flatten)]
    pub base: BaseThreadNode,
    pub handoff: HandoffPayload,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStartNode {
    #[serde(flatten)]
    pub base: BaseThreadNode,
    pub branch_start: BranchStartPayload,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseThreadNode {
    pub id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub parent_turn_ids: Vec<String>,
    pub participant: ThreadParticipant,
    pub created_at: u64,
    pub created_order: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<TurnStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<TurnStatusReason>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnContent {
    pub role: String,
    pub blocks: Vec<TurnBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_index: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadParticipant {
    pub kind: ThreadParticipantKind,
    pub actor_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadParticipantKind {
    User,
    Assistant,
    Qmux,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffPayload {
    pub source_agent_id: String,
    pub source_adapter: String,
    pub source_branch_id: String,
    pub source_turn_id: String,
    pub target_agent_id: String,
    pub target_adapter: String,
    pub target_branch_id: String,
    pub context_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStartPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_branch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_turn_id: Option<String>,
    pub target_branch_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTurnRef {
    pub adapter: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_message_id: Option<String>,
    pub source_index: usize,
}

impl ThreadGraph {
    pub fn empty_for_agent(agent: &AgentInfo) -> Self {
        let thread_id = agent_thread_id(agent);
        let branch_id = agent_branch_id(agent);
        let mut branches = HashMap::new();
        branches.insert(
            branch_id.clone(),
            ThreadBranch {
                id: branch_id.clone(),
                thread_id: thread_id.clone(),
                parent_branch_id: None,
                base_turn_id: None,
                created_from_turn_id: None,
                head_turn_ids: Vec::new(),
                label: None,
                created_by_agent_id: Some(agent.id.clone()),
                created_by_actor_id: Some(agent.id.clone()),
                created_at: agent_created_at(agent),
                status: ThreadBranchStatus::Active,
            },
        );
        Self {
            version: 1,
            thread_id,
            focused_branch_id: branch_id,
            next_created_order: 0,
            root_turn_ids: Vec::new(),
            branches,
            nodes: HashMap::new(),
        }
    }
}

pub fn agent_thread_id(agent: &AgentInfo) -> String {
    agent
        .thread_id
        .clone()
        .unwrap_or_else(|| format!("thread-{}", agent.id))
}

pub fn agent_branch_id(agent: &AgentInfo) -> String {
    agent
        .branch_id
        .clone()
        .unwrap_or_else(|| format!("branch-{}", agent.id))
}

pub fn snapshot_path(worktree_dir: &str, thread_id: &str) -> PathBuf {
    Path::new(worktree_dir)
        .join(".qmux")
        .join("threads")
        .join(format!("{thread_id}.json"))
}

pub fn read_snapshot(worktree_dir: &str, thread_id: &str) -> Result<Option<ThreadGraph>, String> {
    let path = snapshot_path(worktree_dir, thread_id);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(format!(
                "failed to read thread graph {}: {err}",
                path.display()
            ));
        }
    };
    serde_json::from_str::<ThreadGraph>(&raw)
        .map(Some)
        .map_err(|err| format!("invalid thread graph {}: {err}", path.display()))
}

pub fn write_snapshot(worktree_dir: &str, graph: &ThreadGraph) -> Result<(), String> {
    let path = snapshot_path(worktree_dir, &graph.thread_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create thread graph dir {}: {err}",
                parent.display()
            )
        })?;
    }
    let raw = serde_json::to_vec_pretty(graph)
        .map_err(|err| format!("failed to encode thread graph {}: {err}", path.display()))?;
    atomic_write_owner_only(&path, &raw)
}

pub fn replace_agent_turns_snapshot(agent: &AgentInfo, turns: &[Turn]) -> Result<(), String> {
    let graph = materialize_agent_graph(agent, turns);
    write_snapshot(&agent.worktree_dir, &graph)
}

pub fn append_agent_turn_snapshot(agent: &AgentInfo, turn: &Turn) -> Result<(), String> {
    let thread_id = agent_thread_id(agent);
    let mut graph = read_snapshot(&agent.worktree_dir, &thread_id)?
        .unwrap_or_else(|| ThreadGraph::empty_for_agent(agent));
    let branch_id = agent_branch_id(agent);
    ensure_branch(&mut graph, agent, &branch_id);
    if let Some(existing) = graph.nodes.get(&turn.id) {
        let mut node = turn_node_from_turn(agent, turn, Vec::new(), 0);
        if let ThreadNode::Turn(existing) = existing {
            node.base.parent_turn_ids = existing.base.parent_turn_ids.clone();
            node.base.created_at = existing.base.created_at;
            node.base.created_order = existing.base.created_order;
        }
        graph.nodes.insert(turn.id.clone(), ThreadNode::Turn(node));
        return write_snapshot(&agent.worktree_dir, &graph);
    }
    let parent_turn_ids = graph
        .branches
        .get(&branch_id)
        .map(|branch| branch.head_turn_ids.clone())
        .unwrap_or_default();
    let created_order = graph.next_created_order;
    graph.next_created_order = graph.next_created_order.saturating_add(1);
    if graph.root_turn_ids.is_empty() {
        graph.root_turn_ids.push(turn.id.clone());
    }
    graph.nodes.insert(
        turn.id.clone(),
        ThreadNode::Turn(turn_node_from_turn(
            agent,
            turn,
            parent_turn_ids,
            created_order,
        )),
    );
    if let Some(branch) = graph.branches.get_mut(&branch_id) {
        branch.head_turn_ids = vec![turn.id.clone()];
    }
    write_snapshot(&agent.worktree_dir, &graph)
}

pub fn materialize_agent_graph(agent: &AgentInfo, turns: &[Turn]) -> ThreadGraph {
    let mut graph = ThreadGraph::empty_for_agent(agent);
    let branch_id = agent_branch_id(agent);
    let mut previous_turn_id: Option<String> = None;
    for (created_order, turn) in turns.iter().enumerate() {
        let parent_turn_ids = previous_turn_id.iter().cloned().collect::<Vec<_>>();
        graph.nodes.insert(
            turn.id.clone(),
            ThreadNode::Turn(turn_node_from_turn(
                agent,
                turn,
                parent_turn_ids,
                created_order as u64,
            )),
        );
        if graph.root_turn_ids.is_empty() {
            graph.root_turn_ids.push(turn.id.clone());
        }
        previous_turn_id = Some(turn.id.clone());
    }
    if let Some(branch) = graph.branches.get_mut(&branch_id) {
        branch.head_turn_ids = previous_turn_id.into_iter().collect();
    }
    graph.next_created_order = turns.len() as u64;
    graph
}

fn ensure_branch(graph: &mut ThreadGraph, agent: &AgentInfo, branch_id: &str) {
    if graph.branches.contains_key(branch_id) {
        graph.focused_branch_id = branch_id.to_string();
        return;
    }
    graph.branches.insert(
        branch_id.to_string(),
        ThreadBranch {
            id: branch_id.to_string(),
            thread_id: graph.thread_id.clone(),
            parent_branch_id: None,
            base_turn_id: None,
            created_from_turn_id: None,
            head_turn_ids: Vec::new(),
            label: None,
            created_by_agent_id: Some(agent.id.clone()),
            created_by_actor_id: Some(agent.id.clone()),
            created_at: agent_created_at(agent),
            status: ThreadBranchStatus::Active,
        },
    );
    graph.focused_branch_id = branch_id.to_string();
}

fn turn_node_from_turn(
    agent: &AgentInfo,
    turn: &Turn,
    parent_turn_ids: Vec<String>,
    created_order: u64,
) -> TurnNode {
    TurnNode {
        base: BaseThreadNode {
            id: turn.id.clone(),
            thread_id: agent_thread_id(agent),
            branch_id: agent_branch_id(agent),
            parent_turn_ids,
            participant: participant_for_turn(agent, turn),
            created_at: agent_created_at(agent),
            created_order,
            status: turn.status,
            status_reason: turn.status_reason,
        },
        turn: ThreadTurnContent {
            role: turn.role.clone(),
            blocks: turn.blocks.clone(),
            source_index: Some(turn.source_index),
        },
        native: Some(NativeTurnRef {
            adapter: agent.adapter.clone(),
            agent_id: agent.id.clone(),
            session_id: turn.session_id.clone().or_else(|| agent.session_id.clone()),
            transcript_path: agent.transcript_path.clone(),
            native_id: turn.native_id.clone(),
            parent_native_id: turn.parent_native_id.clone(),
            native_message_id: turn.native_message_id.clone(),
            source_index: turn.source_index,
        }),
    }
}

fn participant_for_turn(agent: &AgentInfo, turn: &Turn) -> ThreadParticipant {
    if turn.role == "user" {
        ThreadParticipant {
            kind: ThreadParticipantKind::User,
            actor_id: "local-user".to_string(),
            adapter: None,
            agent_id: None,
            label: Some("You".to_string()),
        }
    } else {
        ThreadParticipant {
            kind: ThreadParticipantKind::Assistant,
            actor_id: agent.id.clone(),
            adapter: Some(agent.adapter.clone()),
            agent_id: Some(agent.id.clone()),
            label: Some(adapter_label(&agent.adapter).to_string()),
        }
    }
}

fn adapter_label(adapter: &str) -> &str {
    match adapter {
        "claude" => "Claude",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "grok" => "Grok",
        _ => "Agent",
    }
}

fn agent_created_at(agent: &AgentInfo) -> u64 {
    agent.created_at.min(u64::MAX as u128) as u64
}

fn atomic_write_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("thread graph path {} has no parent", path.display()))?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let tmp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("thread"),
        pid,
        seq
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|err| format!("failed to create {}: {err}", tmp.display()))?;
    file.write_all(bytes)
        .map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    file.write_all(b"\n")
        .map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    file.sync_all()
        .map_err(|err| format!("failed to sync {}: {err}", tmp.display()))?;
    drop(file);
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
        .map_err(|err| format!("failed to set permissions on {}: {err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| format!("failed to replace {}: {err}", path.display()))?;
    let _ = OpenOptions::new()
        .read(true)
        .open(parent)
        .and_then(|dir| dir.sync_all());
    Ok(())
}

#[allow(dead_code)]
fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::TurnBlock;
    use crate::workspace::AgentStatus;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn sample_agent(worktree_dir: String) -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "codex".to_string(),
            worktree_dir,
            branch: None,
            pane_id: None,
            orphaned_queue_pane_id: None,
            session_id: Some("session-1".to_string()),
            transcript_path: Some("/tmp/codex-session.jsonl".to_string()),
            status: AgentStatus::Done,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            thread_id: Some("thread-1".to_string()),
            branch_id: Some("branch-1".to_string()),
            paused: false,
            created_at: 123,
        }
    }

    fn sample_turn(id: &str, role: &str, source_index: usize) -> Turn {
        Turn {
            id: id.to_string(),
            agent_id: "agent-1".to_string(),
            session_id: None,
            role: role.to_string(),
            blocks: vec![TurnBlock::Text {
                text: format!("{role} text"),
            }],
            source_index,
            status: None,
            status_reason: None,
            native_id: Some(format!("native-{id}")),
            parent_native_id: None,
            native_message_id: None,
        }
    }

    fn temp_worktree(prefix: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}-{seq}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn materialize_wraps_turns_in_created_order() {
        let agent = sample_agent("/tmp/qmux-thread-graph".to_string());
        let turns = vec![
            sample_turn("turn-1", "user", 0),
            sample_turn("turn-2", "assistant", 1),
        ];

        let graph = materialize_agent_graph(&agent, &turns);

        assert_eq!(graph.thread_id, "thread-1");
        assert_eq!(graph.focused_branch_id, "branch-1");
        assert_eq!(graph.next_created_order, 2);
        assert_eq!(graph.root_turn_ids, vec!["turn-1"]);
        let branch = graph.branches.get("branch-1").unwrap();
        assert_eq!(branch.head_turn_ids, vec!["turn-2"]);

        let Some(ThreadNode::Turn(first)) = graph.nodes.get("turn-1") else {
            panic!("missing first turn node");
        };
        assert_eq!(first.base.parent_turn_ids, Vec::<String>::new());
        assert_eq!(first.base.created_order, 0);
        assert_eq!(first.base.participant.kind, ThreadParticipantKind::User);
        assert_eq!(first.base.participant.label.as_deref(), Some("You"));

        let Some(ThreadNode::Turn(second)) = graph.nodes.get("turn-2") else {
            panic!("missing second turn node");
        };
        assert_eq!(second.base.parent_turn_ids, vec!["turn-1"]);
        assert_eq!(second.base.created_order, 1);
        assert_eq!(
            second.base.participant.kind,
            ThreadParticipantKind::Assistant
        );
        assert_eq!(second.base.participant.label.as_deref(), Some("Codex"));
        assert_eq!(
            second
                .native
                .as_ref()
                .and_then(|native| native.session_id.as_deref()),
            Some("session-1")
        );
    }

    #[test]
    fn snapshot_round_trips_owner_only_graph() {
        let worktree = temp_worktree("qmux-thread-graph-roundtrip");
        let agent = sample_agent(worktree.display().to_string());
        let turns = vec![sample_turn("turn-1", "user", 0)];

        replace_agent_turns_snapshot(&agent, &turns).unwrap();

        let path = snapshot_path(&agent.worktree_dir, "thread-1");
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "snapshot must be owner-only");

        let graph = read_snapshot(&agent.worktree_dir, "thread-1")
            .unwrap()
            .expect("snapshot exists");
        assert_eq!(graph.nodes.len(), 1);
        assert!(graph.nodes.contains_key("turn-1"));

        fs::remove_dir_all(worktree).unwrap();
    }

    #[test]
    fn duplicate_append_preserves_graph_position() {
        let worktree = temp_worktree("qmux-thread-graph-append");
        let agent = sample_agent(worktree.display().to_string());
        let first = sample_turn("turn-1", "user", 0);
        let second = sample_turn("turn-2", "assistant", 1);
        append_agent_turn_snapshot(&agent, &first).unwrap();
        append_agent_turn_snapshot(&agent, &second).unwrap();

        let mut updated = second.clone();
        updated.blocks = vec![TurnBlock::Text {
            text: "updated text".to_string(),
        }];
        append_agent_turn_snapshot(&agent, &updated).unwrap();

        let graph = read_snapshot(&agent.worktree_dir, "thread-1")
            .unwrap()
            .expect("snapshot exists");
        let Some(ThreadNode::Turn(node)) = graph.nodes.get("turn-2") else {
            panic!("missing updated turn");
        };
        assert_eq!(node.base.parent_turn_ids, vec!["turn-1"]);
        assert_eq!(node.base.created_order, 1);
        assert_eq!(graph.next_created_order, 2);
        match node.turn.blocks.as_slice() {
            [TurnBlock::Text { text }] => assert_eq!(text, "updated text"),
            blocks => panic!("unexpected blocks: {blocks:?}"),
        }

        fs::remove_dir_all(worktree).unwrap();
    }
}
