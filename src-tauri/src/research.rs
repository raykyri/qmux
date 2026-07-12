use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const MAX_RESPONSE_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_RESPONSE_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
pub const DETACHED_RESEARCH_ARCHIVE_VERSION: u32 = 2;
const DETACHED_RESEARCH_DIR: &str = "research-v1";
const DETACHED_RESEARCH_PENDING_DIR: &str = "research-v1.pending";
const DETACHED_RESEARCH_MANIFEST: &str = "manifest.json";
const MAX_DETACHED_RESEARCH_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedResearchArchive {
    pub version: u32,
    #[serde(default)]
    pub archive_id: String,
    pub workspace: crate::workspace::GroupInfo,
    pub trees: Vec<ResearchTree>,
    pub nodes: Vec<ResearchNode>,
    pub exported_at: u128,
}

#[derive(Clone, Debug)]
pub struct DetachedResearchBundle {
    pub archive: DetachedResearchArchive,
    pub responses: HashMap<String, Vec<crate::transcript::Turn>>,
    pub pending: bool,
}

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
    /// The run agent's thread-graph record id. The agent record itself is
    /// pruned when the run's pane retires, so this is the only surviving link
    /// from a node to its thread record — tree removal uses it to reap the
    /// record and its on-disk graph snapshot, which would otherwise
    /// accumulate one dead entry per run forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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

fn detached_archive_parent(folder: &Path) -> PathBuf {
    folder.join(crate::persistence::STATE_DIR)
}

fn detached_archive_path(folder: &Path, pending: bool) -> PathBuf {
    detached_archive_parent(folder).join(if pending {
        DETACHED_RESEARCH_PENDING_DIR
    } else {
        DETACHED_RESEARCH_DIR
    })
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "refusing to use symlinked research archive path {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to inspect {}: {err}", path.display())),
    }
}

fn prepare_detached_archive_parent(folder: &Path) -> Result<PathBuf, String> {
    let parent = detached_archive_parent(folder);
    reject_symlink(&parent)?;
    let existed = parent.exists();
    fs::create_dir_all(&parent)
        .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    if !existed {
        let _ = fs::set_permissions(&parent, fs::Permissions::from_mode(0o700));
    }
    Ok(parent)
}

fn validate_detached_archive(archive: &DetachedResearchArchive) -> Result<(), String> {
    if archive.version != 1 && archive.version != DETACHED_RESEARCH_ARCHIVE_VERSION {
        return Err(format!(
            "unsupported detached research archive version {}",
            archive.version
        ));
    }
    if archive.workspace.scope != crate::workspace::WorkspaceScope::Research {
        return Err("detached research archive does not contain a Research workspace".to_string());
    }
    if archive.archive_id.is_empty()
        || !archive
            .archive_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("detached research archive has an invalid archive id".to_string());
    }
    let tree_by_id = archive
        .trees
        .iter()
        .map(|tree| (tree.id.as_str(), tree))
        .collect::<HashMap<_, _>>();
    if tree_by_id.len() != archive.trees.len() {
        return Err("detached research archive contains duplicate tree ids".to_string());
    }
    let node_by_id = archive
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    if node_by_id.len() != archive.nodes.len() {
        return Err("detached research archive contains duplicate node ids".to_string());
    }
    for tree in &archive.trees {
        if tree.workspace_id != archive.workspace.id {
            return Err(format!(
                "research tree {} belongs to a different workspace",
                tree.id
            ));
        }
        let root = node_by_id
            .get(tree.root_node_id.as_str())
            .ok_or_else(|| format!("research tree {} has no root node", tree.id))?;
        if root.tree_id != tree.id || root.parent_node_id.is_some() {
            return Err(format!(
                "research tree {} has an invalid root node",
                tree.id
            ));
        }
    }
    for node in &archive.nodes {
        let Some(tree) = tree_by_id.get(node.tree_id.as_str()) else {
            return Err(format!("research node {} has no owning tree", node.id));
        };
        if node.group_id != archive.workspace.id {
            return Err(format!(
                "research node {} belongs to a different workspace",
                node.id
            ));
        }
        if node.status.is_active() || node.pane_id.is_some() {
            return Err(format!(
                "research node {} still contains live runtime state",
                node.id
            ));
        }
        if let Some(parent_id) = node.parent_node_id.as_deref() {
            let parent = node_by_id
                .get(parent_id)
                .ok_or_else(|| format!("research node {} has no parent", node.id))?;
            if parent.tree_id != node.tree_id {
                return Err(format!("research node {} has a cross-tree parent", node.id));
            }
        }
        let mut cursor = node;
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(cursor.id.as_str()) {
                return Err(format!(
                    "research node {} belongs to a parent cycle",
                    node.id
                ));
            }
            if cursor.id == tree.root_node_id {
                break;
            }
            let parent_id = cursor.parent_node_id.as_deref().ok_or_else(|| {
                format!(
                    "research node {} is not connected to tree {} root",
                    node.id, tree.id
                )
            })?;
            cursor = node_by_id.get(parent_id).ok_or_else(|| {
                format!("research node {} has no parent", cursor.id)
            })?;
        }
    }
    Ok(())
}

pub fn write_detached_research_pending(
    folder: &Path,
    archive: &DetachedResearchArchive,
    responses: &HashMap<String, Vec<crate::transcript::Turn>>,
) -> Result<(), String> {
    validate_detached_archive(archive)?;
    let parent = prepare_detached_archive_parent(folder)?;
    let final_path = detached_archive_path(folder, false);
    let pending_path = detached_archive_path(folder, true);
    reject_symlink(&final_path)?;
    reject_symlink(&pending_path)?;
    if final_path.exists() {
        return Err(format!(
            "{} already contains a detached research archive",
            folder.display()
        ));
    }
    if pending_path.exists() {
        if let Ok(existing) = read_detached_research_from_path(&pending_path, true)
            && existing.archive.workspace.id != archive.workspace.id
        {
            return Err(format!(
                "{} contains pending research for a different workspace",
                folder.display()
            ));
        }
        fs::remove_dir_all(&pending_path).map_err(|err| {
            format!(
                "failed to replace incomplete research archive {}: {err}",
                pending_path.display()
            )
        })?;
    }
    let responses_dir = pending_path.join("responses");
    fs::create_dir_all(&responses_dir)
        .map_err(|err| format!("failed to create {}: {err}", responses_dir.display()))?;
    let _ = fs::set_permissions(&pending_path, fs::Permissions::from_mode(0o700));
    let _ = fs::set_permissions(&responses_dir, fs::Permissions::from_mode(0o700));
    let valid_node_ids = archive
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<HashSet<_>>();
    for (node_id, turns) in responses {
        if !valid_node_ids.contains(node_id.as_str()) {
            return Err(format!(
                "response {node_id} has no node in the research archive"
            ));
        }
        let raw = serde_json::to_vec(turns)
            .map_err(|err| format!("failed to encode response {node_id}: {err}"))?;
        if raw.len() > MAX_RESPONSE_SNAPSHOT_BYTES {
            return Err(format!(
                "research response {node_id} is too large to detach safely"
            ));
        }
        let path = responses_dir.join(validated_snapshot_file_name(node_id)?);
        crate::persistence::write_synced(&path, &raw)
            .map_err(|err| format!("failed to write {}: {err}", path.display()))?;
    }
    let manifest = serde_json::to_vec_pretty(archive)
        .map_err(|err| format!("failed to encode detached research archive: {err}"))?;
    if manifest.len() as u64 > MAX_DETACHED_RESEARCH_MANIFEST_BYTES {
        return Err("detached research manifest is too large to write safely".to_string());
    }
    let manifest_path = pending_path.join(DETACHED_RESEARCH_MANIFEST);
    crate::persistence::write_synced(&manifest_path, &manifest)
        .map_err(|err| format!("failed to write {}: {err}", manifest_path.display()))?;
    if let Ok(dir) = fs::File::open(&pending_path) {
        let _ = dir.sync_all();
    }
    if let Ok(dir) = fs::File::open(&parent) {
        let _ = dir.sync_all();
    }
    // Read the complete pending bundle back before global state is allowed to change.
    let verified = read_detached_research_from_path(&pending_path, true)?;
    if verified.archive != *archive || verified.responses != *responses {
        return Err("detached research archive verification failed".to_string());
    }
    Ok(())
}

pub fn new_detached_research_archive_id() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    let mut last_error = None;
    for _ in 0..3 {
        match getrandom::getrandom(&mut bytes) {
            Ok(()) => {
                return Ok(bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect())
            }
            Err(err) => last_error = Some(err),
        }
    }
    Err(format!(
        "OS CSPRNG unavailable; cannot identify detached research archive: {}",
        last_error
            .map(|err| err.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

pub fn commit_detached_research(folder: &Path) -> Result<(), String> {
    let parent = prepare_detached_archive_parent(folder)?;
    let pending = detached_archive_path(folder, true);
    let final_path = detached_archive_path(folder, false);
    reject_symlink(&pending)?;
    reject_symlink(&final_path)?;
    if final_path.exists() {
        return Err(format!(
            "research archive {} already exists",
            final_path.display()
        ));
    }
    fs::rename(&pending, &final_path).map_err(|err| {
        format!(
            "failed to commit detached research archive {}: {err}",
            final_path.display()
        )
    })?;
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn read_detached_research_from_path(
    archive_path: &Path,
    pending: bool,
) -> Result<DetachedResearchBundle, String> {
    reject_symlink(archive_path)?;
    let manifest_path = archive_path.join(DETACHED_RESEARCH_MANIFEST);
    reject_symlink(&manifest_path)?;
    let file = fs::File::open(&manifest_path)
        .map_err(|err| format!("failed to open {}: {err}", manifest_path.display()))?;
    if file
        .metadata()
        .map_err(|err| format!("failed to inspect {}: {err}", manifest_path.display()))?
        .len()
        > MAX_DETACHED_RESEARCH_MANIFEST_BYTES
    {
        return Err(format!(
            "detached research manifest {} is too large",
            manifest_path.display()
        ));
    }
    let mut raw = Vec::new();
    file.take(MAX_DETACHED_RESEARCH_MANIFEST_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|err| format!("failed to read {}: {err}", manifest_path.display()))?;
    if raw.len() as u64 > MAX_DETACHED_RESEARCH_MANIFEST_BYTES {
        return Err(format!(
            "detached research manifest {} is too large",
            manifest_path.display()
        ));
    }
    let mut archive: DetachedResearchArchive = serde_json::from_slice(&raw)
        .map_err(|err| format!("failed to decode {}: {err}", manifest_path.display()))?;
    if archive.version == 1 && archive.archive_id.is_empty() {
        let digest = Sha256::digest(&raw);
        archive.archive_id = format!(
            "legacy-{}",
            digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
    }
    validate_detached_archive(&archive)?;
    let mut responses = HashMap::new();
    let responses_dir = archive_path.join("responses");
    reject_symlink(&responses_dir)?;
    for node in &archive.nodes {
        let path = responses_dir.join(validated_snapshot_file_name(&node.id)?);
        reject_symlink(&path)?;
        let Some(turns) = read_snapshot_file(&path)? else {
            continue;
        };
        responses.insert(node.id.clone(), turns);
    }
    Ok(DetachedResearchBundle {
        archive,
        responses,
        pending,
    })
}

pub fn read_detached_research(folder: &Path) -> Result<Option<DetachedResearchBundle>, String> {
    let parent = detached_archive_parent(folder);
    reject_symlink(&parent)?;
    let final_path = detached_archive_path(folder, false);
    if final_path.exists() {
        return read_detached_research_from_path(&final_path, false).map(Some);
    }
    let pending = detached_archive_path(folder, true);
    if pending.exists() {
        return read_detached_research_from_path(&pending, true).map(Some);
    }
    Ok(None)
}

pub fn remove_detached_research(folder: &Path, pending: bool) -> Result<(), String> {
    let archive_path = detached_archive_path(folder, pending);
    reject_symlink(&archive_path)?;
    match fs::remove_dir_all(&archive_path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "failed to remove imported research archive {}: {err}",
                archive_path.display()
            ));
        }
    }
    if let Ok(dir) = fs::File::open(detached_archive_parent(folder)) {
        let _ = dir.sync_all();
    }
    Ok(())
}

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
            // Scratch files stranded by a writer that died between
            // write_synced and rename (`<node>.json.<pid>.tmp`) can never be
            // renamed into place, and nothing else revisits them — at up to
            // 16MB each they are worse than clutter. Same pid-liveness
            // contract as persistence::remove_stale_tmp_files.
            if let Some(rest) = name.strip_suffix(".tmp") {
                if let Some((base, pid)) = rest.rsplit_once('.')
                    && base.ends_with(".json")
                    && let Ok(pid) = pid.parse::<u32>()
                    && pid != std::process::id()
                    && !crate::persistence::process_is_alive(pid)
                {
                    let _ = std::fs::remove_file(&path);
                }
                continue;
            }
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

// Both matchers take the prompt already normalized: they run once per turn
// while scanning a transcript, and normalizing the (potentially long) prompt
// inside them re-allocated it for every turn scanned — on every hook-driven
// agent event, under the model lock.
fn turn_matches_normalized_prompt(turn: &crate::transcript::Turn, expected: &str) -> bool {
    if turn.role != "user" {
        return false;
    }
    !expected.is_empty()
        && turn.blocks.iter().any(|block| {
            matches!(block, crate::transcript::TurnBlock::Text { text }
                if normalized_text(text) == expected)
        })
}

fn turn_contains_normalized_prompt(turn: &crate::transcript::Turn, expected: &str) -> bool {
    if turn.role != "user" {
        return false;
    }
    !expected.is_empty()
        && turn.blocks.iter().any(|block| {
            matches!(block, crate::transcript::TurnBlock::Text { text }
                if normalized_text(text).contains(expected))
        })
}

pub fn prompt_native_id(turns: &[crate::transcript::Turn], prompt: &str) -> Option<String> {
    let expected = normalized_text(prompt);
    turns
        .iter()
        .rfind(|turn| turn_matches_normalized_prompt(turn, &expected))
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

/// Index of the last turn that delimits this node's prompt, if any; the
/// node's response is everything after it.
fn response_boundary(
    turns: &[crate::transcript::Turn],
    prompt_native_id: Option<&str>,
    prompt: &str,
) -> Option<usize> {
    let expected = normalized_text(prompt);
    turns
        .iter()
        .rposition(|turn| {
            prompt_native_id.is_some_and(|id| turn_native_id(turn) == Some(id))
                || turn_matches_normalized_prompt(turn, &expected)
        })
        .or_else(|| {
            turns
                .iter()
                .rposition(|turn| turn_contains_normalized_prompt(turn, &expected))
        })
        // Adapter prompt rewriting can defeat both text matches, and a forked
        // session's transcript replays every ancestor exchange, so "no match"
        // must not mean "show everything" — that renders and persists ancestor
        // conversations as this node's response. The last user turn carrying
        // prompt text is the safest remaining boundary: replayed history always
        // ends with this node's own prompt, and research runs accept no later
        // user prompts. Only a transcript with no user prompt at all — nothing
        // inherited to leak — falls through to the full transcript.
        .or_else(|| turns.iter().rposition(turn_has_prompt_text))
}

pub fn response_turns(
    turns: &[crate::transcript::Turn],
    prompt_native_id: Option<&str>,
    prompt: &str,
) -> Vec<crate::transcript::Turn> {
    let boundary = response_boundary(turns, prompt_native_id, prompt);
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
    // Borrows rather than going through response_turns: this runs on every
    // hook-driven agent event under the model lock, and cloning the whole
    // response tail (tool-result payloads included) to extract a 220-char
    // preview added lock-hold latency for the lifetime of a streaming run.
    let start = response_boundary(turns, prompt_native_id, prompt).map_or(0, |index| index + 1);
    let text = turns[start..]
        .iter()
        .filter(|turn| turn.role != "user")
        .flat_map(|turn| turn.blocks.iter())
        .find_map(|block| match block {
            crate::transcript::TurnBlock::Text { text } if !text.trim().is_empty() => {
                Some(text.as_str())
            }
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

    fn sample_detached_archive(folder: &Path) -> DetachedResearchArchive {
        let tree = ResearchTree {
            id: "research-1".to_string(),
            title: "Portable research".to_string(),
            root_node_id: "research-node-1".to_string(),
            workspace_id: "group-1".to_string(),
            created_at: 1,
            updated_at: 2,
            archived_at: None,
            last_viewed_at: Some(2),
        };
        let node = ResearchNode {
            id: "research-node-1".to_string(),
            tree_id: tree.id.clone(),
            parent_node_id: None,
            prompt: "Question".to_string(),
            response_preview: Some("Answer".to_string()),
            adapter: "claude".to_string(),
            model: None,
            group_id: "group-1".to_string(),
            worktree_dir: folder.display().to_string(),
            native_session_id: Some("session-1".to_string()),
            transcript_path: None,
            prompt_native_id: None,
            agent_id: Some("agent-1".to_string()),
            pane_id: None,
            thread_id: None,
            status: ResearchNodeStatus::Complete,
            error: None,
            response_snapshot_at: Some(2),
            created_at: 1,
            started_at: Some(1),
            completed_at: Some(2),
        };
        DetachedResearchArchive {
            version: DETACHED_RESEARCH_ARCHIVE_VERSION,
            archive_id: "archive-1".to_string(),
            workspace: crate::workspace::GroupInfo {
                id: "group-1".to_string(),
                name: "project".to_string(),
                name_override: None,
                dir: folder.display().to_string(),
                managed_dir: String::new(),
                base_repo: None,
                base_ref: Some("HEAD".to_string()),
                parent_id: None,
                created_at: 1,
                collapsed: false,
                scope: crate::workspace::WorkspaceScope::Research,
                imported_research_archive_id: None,
                agents: Vec::new(),
            },
            trees: vec![tree],
            nodes: vec![node],
            exported_at: 3,
        }
    }

    #[test]
    fn detached_archive_pending_and_committed_forms_round_trip() {
        let folder = temp_workspace();
        let archive = sample_detached_archive(&folder);
        let responses =
            HashMap::from([("research-node-1".to_string(), vec![sample_turn("turn-1")])]);

        write_detached_research_pending(&folder, &archive, &responses).unwrap();
        let pending = read_detached_research(&folder).unwrap().unwrap();
        assert!(pending.pending);
        assert_eq!(pending.archive.trees.len(), 1);
        assert_eq!(pending.responses["research-node-1"][0].id, "turn-1");

        commit_detached_research(&folder).unwrap();
        let committed = read_detached_research(&folder).unwrap().unwrap();
        assert!(!committed.pending);
        assert_eq!(committed.archive.nodes.len(), 1);
        remove_detached_research(&folder, false).unwrap();
        assert!(read_detached_research(&folder).unwrap().is_none());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn detached_archive_rejects_disconnected_and_cyclic_nodes() {
        let folder = temp_workspace();
        let mut archive = sample_detached_archive(&folder);
        let mut disconnected = archive.nodes[0].clone();
        disconnected.id = "research-node-2".to_string();
        disconnected.parent_node_id = None;
        archive.nodes.push(disconnected);
        let error = validate_detached_archive(&archive).unwrap_err();
        assert!(error.contains("not connected"), "{error}");

        archive.nodes[1].parent_node_id = Some("research-node-3".to_string());
        let mut cyclic = archive.nodes[1].clone();
        cyclic.id = "research-node-3".to_string();
        cyclic.parent_node_id = Some("research-node-2".to_string());
        archive.nodes.push(cyclic);
        let error = validate_detached_archive(&archive).unwrap_err();
        assert!(error.contains("parent cycle"), "{error}");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn detached_archive_retry_preserves_foreign_pending_archive() {
        let folder = temp_workspace();
        let first = sample_detached_archive(&folder);
        let responses = HashMap::from([(
            first.nodes[0].id.clone(),
            vec![sample_turn("turn-1")],
        )]);
        write_detached_research_pending(&folder, &first, &responses).unwrap();

        let mut second = first.clone();
        second.archive_id = "archive-2".to_string();
        second.workspace.id = "group-2".to_string();
        second.trees[0].workspace_id = "group-2".to_string();
        second.nodes[0].group_id = "group-2".to_string();
        let error = write_detached_research_pending(&folder, &second, &responses).unwrap_err();

        assert!(error.contains("different workspace"), "{error}");
        let preserved = read_detached_research(&folder).unwrap().unwrap();
        assert_eq!(preserved.archive.archive_id, first.archive_id);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn detached_archive_version_one_without_id_gets_stable_legacy_identity() {
        let folder = temp_workspace();
        let mut archive = sample_detached_archive(&folder);
        archive.version = 1;
        let mut manifest = serde_json::to_value(&archive).unwrap();
        manifest
            .as_object_mut()
            .unwrap()
            .remove("archiveId");
        let pending = detached_archive_path(&folder, true);
        std::fs::create_dir_all(pending.join("responses")).unwrap();
        crate::persistence::write_synced(
            &pending.join(DETACHED_RESEARCH_MANIFEST),
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let first = read_detached_research(&folder).unwrap().unwrap();
        let second = read_detached_research(&folder).unwrap().unwrap();
        assert!(first.archive.archive_id.starts_with("legacy-"));
        assert_eq!(first.archive.archive_id, second.archive.archive_id);
        std::fs::remove_dir_all(folder).unwrap();
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
