use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_RESPONSE_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_RESPONSE_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTree {
    pub id: String,
    pub title: String,
    pub root_node_id: String,
    /// Durable Research-scoped workspace used by every run in this tree.
    #[serde(default)]
    pub workspace_id: String,
    pub created_at: u128,
    pub updated_at: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_viewed_at: Option<u128>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResearchNodeStatus {
    Queued,
    Starting,
    Running,
    Complete,
    Failed,
    Cancelled,
}

impl ResearchNodeStatus {
    /// A run that is still expected to produce a result (and may hold a pane).
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Starting | Self::Running)
    }

    /// A settled outcome. Terminal statuses are monotonic: native hooks and
    /// transcript tailing deliver agent events asynchronously, so a delayed
    /// generic update must never resurrect or rewrite an explicit outcome.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Complete | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchNode {
    pub id: String,
    pub tree_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_node_id: Option<String>,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_preview: Option<String>,
    pub adapter: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub group_id: String,
    pub worktree_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub status: ResearchNodeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// When the durable response snapshot landed. The completion status can
    /// precede the final transcript flush, so viewers use this changing as
    /// their signal to refetch content they may have read too early.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_snapshot_at: Option<u128>,
    pub created_at: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u128>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResearchTreeRequest {
    pub prompt: String,
    pub title: Option<String>,
    pub adapter: String,
    pub model: Option<String>,
    /// The run directory is derived from this workspace's durable record, never
    /// accepted from the caller: the group is the workspace the user actually
    /// picked, and a stale or fabricated directory would silently run the
    /// research agent somewhere else.
    #[serde(rename = "workspaceId", alias = "groupId")]
    pub group_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTreeSummary {
    pub id: String,
    pub title: String,
    pub root_node_id: String,
    pub workspace_id: String,
    pub running_count: usize,
    pub failed_count: usize,
    pub completed_count: usize,
    pub cancelled_count: usize,
    pub updated_at: u128,
    pub archived_at: Option<u128>,
    pub has_unseen_update: bool,
    /// A failure settled after the tree was last viewed. Unlike `failed_count`
    /// (a lifetime total that can never be cleared without deleting the tree),
    /// this is an attention flag: viewing the tree acknowledges it.
    pub has_unseen_failure: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTreeDetail {
    pub tree: ResearchTree,
    pub nodes: Vec<ResearchNode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchNodeCard {
    pub id: String,
    pub prompt: String,
    pub response_preview: Option<String>,
    pub status: ResearchNodeStatus,
    pub created_at: u128,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchNodeContent {
    pub node: ResearchNode,
    pub turns: Vec<crate::transcript::Turn>,
    pub children: Vec<ResearchNodeCard>,
    /// Why `turns` is empty for a finished node (snapshot missing and the
    /// adapter transcript unreadable). Lets the UI explain the gap instead of
    /// failing the whole request, which would leave nothing viewable at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_error: Option<String>,
}

const RESPONSE_SNAPSHOT_DIR: &str = "research-responses";

fn validated_snapshot_file_name(node_id: &str) -> Result<String, String> {
    if node_id.is_empty()
        || !node_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid research node id for response snapshot".to_string());
    }
    Ok(format!("{node_id}.json"))
}

/// Snapshots live under the owner-protected `.qmux` state directory like every
/// other durable prompt/response artifact — not loose in the workspace root.
fn response_snapshot_path(workspace_root: &Path, node_id: &str) -> Result<PathBuf, String> {
    Ok(workspace_root
        .join(crate::persistence::STATE_DIR)
        .join(RESPONSE_SNAPSHOT_DIR)
        .join(validated_snapshot_file_name(node_id)?))
}

/// Pre-`.qmux` location. Read (and removed) as a fallback so snapshots written
/// by earlier builds of the research branch stay viewable.
fn legacy_response_snapshot_path(workspace_root: &Path, node_id: &str) -> Result<PathBuf, String> {
    Ok(workspace_root
        .join(RESPONSE_SNAPSHOT_DIR)
        .join(validated_snapshot_file_name(node_id)?))
}

fn read_snapshot_file(path: &Path) -> Result<Option<Vec<crate::transcript::Turn>>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("failed to open {}: {err}", path.display())),
    };
    // Writes cap snapshots at MAX_RESPONSE_SNAPSHOT_BYTES; refuse to load
    // anything larger (a foreign or corrupted file) instead of buffering an
    // unbounded blob into memory. The bounded read also covers a file that
    // grows between the stat and the read.
    let expected = file
        .metadata()
        .map_err(|err| format!("failed to stat {}: {err}", path.display()))?
        .len();
    if expected > MAX_RESPONSE_SNAPSHOT_BYTES as u64 {
        return Err(format!(
            "research response snapshot {} is too large to load safely",
            path.display()
        ));
    }
    let mut raw = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(file, MAX_RESPONSE_SNAPSHOT_BYTES as u64 + 1),
        &mut raw,
    )
    .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    if raw.len() > MAX_RESPONSE_SNAPSHOT_BYTES {
        return Err(format!(
            "research response snapshot {} is too large to load safely",
            path.display()
        ));
    }
    serde_json::from_slice(&raw)
        .map(Some)
        .map_err(|err| format!("failed to decode {}: {err}", path.display()))
}

pub fn read_response_snapshot(
    workspace_root: &Path,
    node_id: &str,
) -> Result<Option<Vec<crate::transcript::Turn>>, String> {
    if let Some(turns) = read_snapshot_file(&response_snapshot_path(workspace_root, node_id)?)? {
        return Ok(Some(turns));
    }
    read_snapshot_file(&legacy_response_snapshot_path(workspace_root, node_id)?)
}

pub fn write_response_snapshot(
    workspace_root: &Path,
    node_id: &str,
    turns: &[crate::transcript::Turn],
) -> Result<(), String> {
    let path = response_snapshot_path(workspace_root, node_id)?;
    let parent = path.parent().expect("snapshot path has a parent");
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    // Owner-only, matching the `.qmux` state dir it lives in (responses carry
    // prompt text). Best-effort on an existing directory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    let raw = serde_json::to_vec(turns)
        .map_err(|err| format!("failed to encode research response: {err}"))?;
    if raw.len() > MAX_RESPONSE_SNAPSHOT_BYTES {
        return Err("research response is too large to render safely".to_string());
    }
    // Same atomic-commit discipline as state.json: fsync'd 0600 temp file,
    // rename into place, then fsync the directory so the swap survives a
    // crash. The temp name carries the pid so a stale temp from a dead writer
    // can never be renamed over a live snapshot by accident.
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    crate::persistence::write_synced(&temp, &raw)
        .map_err(|err| format!("failed to write {}: {err}", temp.display()))?;
    std::fs::rename(&temp, &path).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!("failed to commit {}: {err}", path.display())
    })?;
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Removes response snapshots (current and legacy locations) whose node no
/// longer exists. Structural reconciliation and crash-interrupted tree
/// removal can drop nodes without their snapshot files, and nothing else
/// ever revisits those files. Only touches names this module writes:
/// `<node-id>.json` with the writer-enforced id charset.
pub fn prune_response_snapshots(
    workspace_root: &Path,
    valid_node_ids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    for dir in [
        workspace_root
            .join(crate::persistence::STATE_DIR)
            .join(RESPONSE_SNAPSHOT_DIR),
        workspace_root.join(RESPONSE_SNAPSHOT_DIR),
    ] {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("failed to list {}: {err}", dir.display())),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(node_id) = name.strip_suffix(".json") else {
                continue;
            };
            if validated_snapshot_file_name(node_id).is_err() || valid_node_ids.contains(node_id) {
                continue;
            }
            if let Err(err) = std::fs::remove_file(&path)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!(
                    "qmux: failed to prune stale research response {}: {err}",
                    path.display()
                );
            }
        }
    }
    Ok(())
}

pub fn remove_response_snapshot(workspace_root: &Path, node_id: &str) -> Result<(), String> {
    for path in [
        response_snapshot_path(workspace_root, node_id)?,
        legacy_response_snapshot_path(workspace_root, node_id)?,
    ] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("failed to remove {}: {err}", path.display())),
        }
    }
    Ok(())
}

pub fn load_transcript_response(
    config: &crate::config::QmuxConfig,
    node: &ResearchNode,
) -> Result<Vec<crate::transcript::Turn>, String> {
    let path = node
        .transcript_path
        .as_deref()
        .ok_or_else(|| "research node has no transcript path".to_string())?;
    let file = std::fs::File::open(path)
        .map_err(|err| format!("failed to open research transcript {path}: {err}"))?;
    let transcript_bytes = file
        .metadata()
        .map_err(|err| format!("failed to stat research transcript {path}: {err}"))?
        .len();
    if transcript_bytes > MAX_RESPONSE_SOURCE_BYTES {
        return Err(format!(
            "research transcript {path} is too large to snapshot safely"
        ));
    }
    let bounded = std::io::Read::take(file, MAX_RESPONSE_SOURCE_BYTES + 1);
    let lines = std::io::BufRead::lines(std::io::BufReader::new(bounded))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read research transcript {path}: {err}"))?;
    let registry = crate::adapters::adapter_registry(config);
    let adapter = registry.get(&node.adapter)?;
    let turns =
        adapter.resolve_transcript_turns(node.agent_id.as_deref().unwrap_or(&node.id), 0, &lines);
    Ok(response_turns(
        &turns,
        node.prompt_native_id.as_deref(),
        &node.prompt,
    ))
}

fn normalized_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn turn_native_id(turn: &crate::transcript::Turn) -> Option<&str> {
    turn.native_message_id
        .as_deref()
        .or(turn.native_id.as_deref())
}

fn turn_matches_prompt(turn: &crate::transcript::Turn, prompt: &str) -> bool {
    if turn.role != "user" {
        return false;
    }
    let expected = normalized_text(prompt);
    !expected.is_empty()
        && turn.blocks.iter().any(|block| {
            matches!(block, crate::transcript::TurnBlock::Text { text }
                if normalized_text(text) == expected)
        })
}

fn turn_contains_prompt(turn: &crate::transcript::Turn, prompt: &str) -> bool {
    if turn.role != "user" {
        return false;
    }
    let expected = normalized_text(prompt);
    !expected.is_empty()
        && turn.blocks.iter().any(|block| {
            matches!(block, crate::transcript::TurnBlock::Text { text }
                if normalized_text(text).contains(&expected))
        })
}

pub fn prompt_native_id(turns: &[crate::transcript::Turn], prompt: &str) -> Option<String> {
    turns
        .iter()
        .rfind(|turn| turn_matches_prompt(turn, prompt))
        .and_then(turn_native_id)
        .map(str::to_string)
}

fn turn_has_prompt_text(turn: &crate::transcript::Turn) -> bool {
    turn.role == "user"
        && turn.blocks.iter().any(|block| {
            matches!(block, crate::transcript::TurnBlock::Text { text }
                if !text.trim().is_empty())
        })
}

pub fn response_turns(
    turns: &[crate::transcript::Turn],
    prompt_native_id: Option<&str>,
    prompt: &str,
) -> Vec<crate::transcript::Turn> {
    let boundary = turns
        .iter()
        .rposition(|turn| {
            prompt_native_id.is_some_and(|id| turn_native_id(turn) == Some(id))
                || turn_matches_prompt(turn, prompt)
        })
        .or_else(|| {
            turns
                .iter()
                .rposition(|turn| turn_contains_prompt(turn, prompt))
        })
        // Adapter prompt rewriting can defeat both text matches, and a forked
        // session's transcript replays every ancestor exchange, so "no match"
        // must not mean "show everything" — that renders and persists ancestor
        // conversations as this node's response. The last user turn carrying
        // prompt text is the safest remaining boundary: replayed history always
        // ends with this node's own prompt, and research runs accept no later
        // user prompts. Only a transcript with no user prompt at all — nothing
        // inherited to leak — falls through to the full transcript.
        .or_else(|| turns.iter().rposition(turn_has_prompt_text));
    turns
        .iter()
        .skip(boundary.map_or(0, |index| index + 1))
        .cloned()
        .collect()
}

pub fn response_preview(
    turns: &[crate::transcript::Turn],
    prompt_native_id: Option<&str>,
    prompt: &str,
) -> Option<String> {
    let text = response_turns(turns, prompt_native_id, prompt)
        .into_iter()
        .filter(|turn| turn.role != "user")
        .flat_map(|turn| turn.blocks)
        .find_map(|block| match block {
            crate::transcript::TurnBlock::Text { text } if !text.trim().is_empty() => Some(text),
            _ => None,
        })?;
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let preview = chars.by_ref().take(220).collect::<String>();
    Some(if chars.next().is_some() {
        format!("{}…", preview.trim_end())
    } else {
        preview
    })
}

pub fn default_title(prompt: &str) -> String {
    const MAX_CHARS: usize = 72;
    let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let title = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{}…", title.trim_end())
    } else if title.is_empty() {
        "Untitled research".to_string()
    } else {
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-research-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_turn(id: &str) -> crate::transcript::Turn {
        crate::transcript::Turn {
            id: id.to_string(),
            agent_id: "agent-1".to_string(),
            session_id: None,
            role: "assistant".to_string(),
            blocks: vec![crate::transcript::TurnBlock::Text {
                text: "Answer".to_string(),
            }],
            source_index: 0,
            status: None,
            status_reason: None,
            native_id: None,
            parent_native_id: None,
            native_message_id: None,
        }
    }

    #[test]
    fn snapshots_live_under_the_protected_state_dir_and_round_trip() {
        let workspace = temp_workspace();
        write_response_snapshot(&workspace, "node-1", &[sample_turn("turn-1")]).unwrap();

        let path = workspace
            .join(crate::persistence::STATE_DIR)
            .join(RESPONSE_SNAPSHOT_DIR)
            .join("node-1.json");
        assert!(path.exists());
        // Owner-only file and directory, like the rest of the state dir.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(file_mode & 0o077, 0, "snapshot must be owner-only");
        }

        let turns = read_response_snapshot(&workspace, "node-1").unwrap().unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].id, "turn-1");

        remove_response_snapshot(&workspace, "node-1").unwrap();
        assert!(read_response_snapshot(&workspace, "node-1").unwrap().is_none());
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn legacy_snapshot_location_is_still_readable_and_removable() {
        let workspace = temp_workspace();
        let legacy_dir = workspace.join(RESPONSE_SNAPSHOT_DIR);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("node-1.json"),
            serde_json::to_vec(&[sample_turn("legacy-turn")]).unwrap(),
        )
        .unwrap();

        let turns = read_response_snapshot(&workspace, "node-1").unwrap().unwrap();
        assert_eq!(turns[0].id, "legacy-turn");

        remove_response_snapshot(&workspace, "node-1").unwrap();
        assert!(read_response_snapshot(&workspace, "node-1").unwrap().is_none());
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn oversized_snapshot_files_are_refused_instead_of_buffered() {
        let workspace = temp_workspace();
        let dir = workspace
            .join(crate::persistence::STATE_DIR)
            .join(RESPONSE_SNAPSHOT_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        // A sparse file over the cap: only its size matters to the guard.
        let file = std::fs::File::create(dir.join("node-1.json")).unwrap();
        file.set_len(MAX_RESPONSE_SNAPSHOT_BYTES as u64 + 1).unwrap();
        drop(file);

        let err = read_response_snapshot(&workspace, "node-1").unwrap_err();
        assert!(err.contains("too large"), "{err}");
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn title_normalizes_and_truncates_prompts() {
        assert_eq!(default_title("  a   short\nquestion  "), "a short question");
        let title = default_title(&"x".repeat(80));
        assert_eq!(title.chars().count(), 73);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn response_content_starts_after_the_matching_prompt_and_keeps_tool_results() {
        use crate::transcript::{Turn, TurnBlock};
        let turn = |id: &str, role: &str, text: &str| Turn {
            id: id.to_string(),
            agent_id: "agent-1".to_string(),
            session_id: None,
            role: role.to_string(),
            blocks: vec![TurnBlock::Text {
                text: text.to_string(),
            }],
            source_index: 0,
            status: None,
            status_reason: None,
            native_id: None,
            parent_native_id: None,
            native_message_id: None,
        };
        let mut tool_result = turn("tool-result", "user", "Tool output");
        tool_result.blocks = vec![TurnBlock::ToolResult {
            tool_use_id: Some("tool-1".to_string()),
            content: serde_json::json!("Tool output"),
            is_error: false,
        }];
        let turns = vec![
            turn("old-user", "user", "Old question"),
            turn("old-answer", "assistant", "Old answer"),
            turn("new-user", "user", "New question"),
            turn("working", "assistant", "Working"),
            tool_result,
            turn("new-answer", "assistant", "New answer"),
        ];
        let visible = response_turns(&turns, None, "New question");
        assert_eq!(visible.len(), 3);
        assert_eq!(visible[0].id, "working");
        assert_eq!(visible[1].id, "tool-result");
        assert_eq!(
            response_preview(&turns, None, "New question").as_deref(),
            Some("Working")
        );
    }

    #[test]
    fn unmatched_prompt_never_exposes_the_inherited_transcript() {
        use crate::transcript::{Turn, TurnBlock};
        let turn = |id: &str, role: &str, text: &str| Turn {
            id: id.to_string(),
            agent_id: "agent-1".to_string(),
            session_id: None,
            role: role.to_string(),
            blocks: vec![TurnBlock::Text {
                text: text.to_string(),
            }],
            source_index: 0,
            status: None,
            status_reason: None,
            native_id: None,
            parent_native_id: None,
            native_message_id: None,
        };
        // A forked session replays the ancestor exchange, then the adapter
        // rewrote the child prompt so neither the exact nor the substring
        // match can find it. The boundary must still fall on the last user
        // prompt — never on index zero, which would render the ancestor
        // conversation as this node's response.
        let turns = vec![
            turn("ancestor-user", "user", "Ancestor question"),
            turn("ancestor-answer", "assistant", "Ancestor answer"),
            turn("child-user", "user", "[wrapped] follow-up (rewritten)"),
            turn("child-answer", "assistant", "Child answer"),
        ];
        let visible = response_turns(&turns, None, "Original follow-up");
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "child-answer");
        assert_eq!(
            response_preview(&turns, None, "Original follow-up").as_deref(),
            Some("Child answer")
        );

        // A transcript with no user prompt at all has nothing inherited to
        // leak; the whole transcript remains visible.
        let assistant_only = vec![turn("only-answer", "assistant", "Answer")];
        assert_eq!(
            response_turns(&assistant_only, None, "Original follow-up").len(),
            1
        );
    }
}
