use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    pub dir: String,
    pub base_repo: Option<String>,
    pub base_ref: Option<String>,
    pub parent_id: Option<String>,
    pub created_at: u128,
    pub agents: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub group_id: String,
    pub adapter: String,
    pub worktree_dir: String,
    pub branch: Option<String>,
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orphaned_queue_pane_id: Option<String>,
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
    pub status: AgentStatus,
    pub model: Option<String>,
    pub parent_id: Option<String>,
    pub fork_point: Option<String>,
    pub root_session_id: Option<String>,
    /// True when the queue has paused after a pause-after turn finished; the backend
    /// stops auto-draining until the user unpauses.
    #[serde(default)]
    pub paused: bool,
    pub created_at: u128,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Starting,
    Running,
    AwaitingInput,
    AwaitingPermission,
    Done,
    #[serde(alias = "stopped")]
    Idle,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: Option<String>,
    pub base_repo: Option<String>,
    pub base_ref: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PrepareAgentWorkspaceRequest {
    pub group_id: Option<String>,
    pub base_repo: Option<String>,
    pub base_ref: Option<String>,
    pub adapter: String,
    pub model: Option<String>,
    /// When false, the agent runs directly in the base repository / cwd with no
    /// isolated git worktree (the default).
    pub use_worktree: bool,
}

pub fn create_group(state: &AppState, request: CreateGroupRequest) -> Result<GroupInfo, String> {
    let id = state.next_id("group");
    let dir = match request.name.as_deref() {
        // An explicitly requested name keeps the numeric-suffix collision policy.
        Some(name) => unique_group_dir(&state.config().workspace_root, name)?,
        // Otherwise generate a fresh, human-readable name, regenerating until one
        // doesn't collide with an existing worktree.
        None => unique_friendly_group_dir(&state.config().workspace_root)?,
    };
    fs::create_dir_all(dir.join(".qmux"))
        .map_err(|err| format!("failed to create group dir {}: {err}", dir.display()))?;

    let group = GroupInfo {
        id,
        name: dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("group")
            .to_string(),
        dir: dir.display().to_string(),
        base_repo: request.base_repo,
        base_ref: request.base_ref,
        parent_id: None,
        created_at: now_millis(),
        agents: Vec::new(),
    };

    write_group_manifest(&group)?;
    state.insert_group(group.clone())?;
    Ok(group)
}

pub fn prepare_agent_workspace(
    state: &AppState,
    request: PrepareAgentWorkspaceRequest,
) -> Result<AgentInfo, String> {
    let mut group = match request.group_id.as_deref() {
        Some(group_id) => state
            .group(group_id)?
            .ok_or_else(|| format!("group {group_id} was not found"))?,
        None => create_group(
            state,
            CreateGroupRequest {
                name: None,
                base_repo: request.base_repo.clone().or_else(default_base_repo),
                base_ref: request
                    .base_ref
                    .clone()
                    .or_else(|| Some("HEAD".to_string())),
            },
        )?,
    };

    let agent_id = state.next_id("agent");
    let agent_name = format!("agent-{}", group.agents.len() + 1);
    let base_repo = request
        .base_repo
        .or_else(|| group.base_repo.clone())
        .or_else(default_base_repo);
    let base_ref = request
        .base_ref
        .or_else(|| group.base_ref.clone())
        .unwrap_or_else(|| "HEAD".to_string());
    let mut branch = None;

    let worktree_dir = if request.use_worktree {
        // Isolated git worktree under the group dir (or a plain directory when the
        // base is not a git repo).
        let dir = PathBuf::from(&group.dir).join(&agent_name);
        match base_repo.as_deref().filter(|repo| is_git_repo(repo)) {
            Some(base_repo) => {
                let branch_name =
                    format!("qmux/{}/{}", sanitize_ref_segment(&group.name), agent_name);
                create_worktree(base_repo, &dir, &branch_name, &base_ref)?;
                branch = Some(branch_name);
            }
            None => {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!("failed to create agent directory {}: {err}", dir.display())
                })?;
            }
        }
        dir.display().to_string()
    } else {
        // Default: no worktree — the agent runs directly in the base repo / cwd.
        base_repo.unwrap_or_else(|| group.dir.clone())
    };

    let agent = AgentInfo {
        id: agent_id.clone(),
        group_id: group.id.clone(),
        adapter: request.adapter,
        worktree_dir,
        branch,
        pane_id: None,
        orphaned_queue_pane_id: None,
        session_id: None,
        transcript_path: None,
        status: AgentStatus::Starting,
        model: request.model,
        parent_id: None,
        fork_point: None,
        root_session_id: None,
        paused: false,
        created_at: now_millis(),
    };

    group.agents.push(agent_id);
    write_group_manifest(&group)?;
    state.update_group(group)?;
    state.insert_agent(agent.clone())?;
    Ok(agent)
}

pub fn attach_agent_pane(
    state: &AppState,
    agent_id: &str,
    pane_id: String,
) -> Result<AgentInfo, String> {
    for previous in state.list_agents()? {
        if previous.id != agent_id && previous.pane_id.as_deref() == Some(&pane_id) {
            let has_queue = !state.list_agent_turn_queue(&previous.id)?.is_empty();
            let orphaned_queue_pane_id = has_queue.then(|| pane_id.clone());
            let detached = state.mutate_agent(&previous.id, |agent| {
                agent.pane_id = None;
                agent.orphaned_queue_pane_id = orphaned_queue_pane_id;
                agent.status = AgentStatus::Idle;
            })?;
            if let Some(detached) = detached {
                state.emit(crate::events::QmuxEvent::new(
                    "agent.detached",
                    Some(pane_id.clone()),
                    Some(detached.id.clone()),
                    serde_json::json!({
                        "agent": detached,
                        "replacementAgentId": agent_id,
                    }),
                ));
            }
        }
    }

    // Field-scoped mutation, not a full-struct `update_agent`: a freshly spawned agent's
    // SessionStart hook may be recording its session_id / transcript_path on another
    // thread right now, and a stale-snapshot write here would race it and wipe them. Only
    // touch the pane-binding fields.
    state
        .mutate_agent(agent_id, |agent| {
            agent.pane_id = Some(pane_id);
            agent.orphaned_queue_pane_id = None;
            agent.status = AgentStatus::Running;
        })?
        .ok_or_else(|| format!("agent {agent_id} was not found"))
}

/// Detaches whatever agent is currently bound to `pane_id` (if any), reverting the
/// pane to a plain shell. Used when a shell-launched agent's *process* exits but its
/// host shell — and so the pane — lives on: there is no `pty.exit` to reap the agent
/// in that case, so without this the agent would linger bound to the pane and the tab
/// would keep showing its last status (e.g. a freshly launched, never-used agent's
/// synthetic "Awaiting input") indefinitely. Mirrors the rebind detach in
/// `attach_agent_pane`: the binding is cleared and the agent goes Idle, but an agent
/// with queued turns keeps them parked as an orphaned queue so they stay
/// restart-recoverable. Emits `agent.detached` with the updated agent and returns it;
/// a no-op (`Ok(None)`) when no agent owns the pane.
pub fn detach_pane_agent(state: &AppState, pane_id: &str) -> Result<Option<AgentInfo>, String> {
    let Some(current) = state.agent_by_pane(pane_id)? else {
        return Ok(None);
    };
    let has_queue = !state.list_agent_turn_queue(&current.id)?.is_empty();
    let orphaned_queue_pane_id = has_queue.then(|| pane_id.to_string());
    let detached = state.mutate_agent(&current.id, |agent| {
        agent.pane_id = None;
        agent.orphaned_queue_pane_id = orphaned_queue_pane_id;
        agent.status = AgentStatus::Idle;
    })?;
    if let Some(detached) = &detached {
        state.emit(crate::events::QmuxEvent::new(
            "agent.detached",
            Some(pane_id.to_string()),
            Some(detached.id.clone()),
            serde_json::json!({ "agent": detached }),
        ));
    }
    Ok(detached)
}

pub fn mark_agent_spawn_failed(
    state: &AppState,
    agent_id: &str,
    reserved_pane_id: &str,
) -> Result<AgentInfo, String> {
    state
        .mutate_agent(agent_id, |agent| {
            if agent.pane_id.as_deref() == Some(reserved_pane_id) {
                agent.pane_id = None;
                agent.orphaned_queue_pane_id = None;
            }
            agent.status = AgentStatus::Failed;
        })?
        .ok_or_else(|| format!("agent {agent_id} was not found"))
}

pub fn mark_agent_failed(state: &AppState, agent_id: &str) -> Result<AgentInfo, String> {
    let mut agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    agent.status = AgentStatus::Failed;
    state.update_agent(agent.clone())?;
    Ok(agent)
}

pub fn acknowledge_agent(
    state: &AppState,
    agent_id: &str,
    include_failed: bool,
) -> Result<AgentInfo, String> {
    let mut agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    if matches!(agent.status, AgentStatus::Done)
        || (include_failed && matches!(agent.status, AgentStatus::Failed))
    {
        agent.status = AgentStatus::Idle;
        state.update_agent(agent.clone())?;
        state.emit(crate::events::QmuxEvent::new(
            "agent.acknowledged",
            agent.pane_id.clone(),
            Some(agent.id.clone()),
            serde_json::json!({ "agent": agent.clone() }),
        ));
    }
    Ok(agent)
}

pub fn clear_agent_working_status(state: &AppState, agent_id: &str) -> Result<AgentInfo, String> {
    let agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    if !matches!(agent.status, AgentStatus::Starting | AgentStatus::Running) {
        return Ok(agent);
    }
    // Treat a manual clear as the agent having gone idle and route it through the same
    // completion path the adapters use, instead of blindly forcing a fresh Idle. Forcing
    // Idle leaves a queued turn stranded (the next idle that would have drained it never
    // fires), drops pending-pause handling, and persists a "ready to send" status that
    // sends the user's next turn straight into the process rather than queuing it.
    // advance_after_idle drains a queued turn, honors a pending pause / active typing, and
    // lands on Done (or Running if a turn drained) with field-scoped writes.
    crate::turn_queue::advance_after_idle(state, agent_id)?;
    let agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    state.emit(crate::events::QmuxEvent::new(
        "agent.working_status_cleared",
        agent.pane_id.clone(),
        Some(agent.id.clone()),
        serde_json::json!({ "agent": agent.clone() }),
    ));
    Ok(agent)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub has_changes: bool,
    pub changed_files: usize,
}

#[derive(Clone, Debug)]
pub struct CapturedWorktreeRemoval {
    run_dir: String,
    worktree_dir: String,
    branch: String,
}

/// Reports whether an agent's git worktree has uncommitted changes — staged,
/// unstaged, or untracked — so closing a tab can warn before that work is gone.
pub fn agent_worktree_status(state: &AppState, agent_id: &str) -> Result<WorktreeStatus, String> {
    let agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    let dir = agent.worktree_dir;

    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .arg("status")
        .arg("--porcelain")
        .output()
        .map_err(|err| format!("failed to run git status in {dir}: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git status failed in {dir}: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let changed_files = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    Ok(WorktreeStatus {
        has_changes: changed_files > 0,
        changed_files,
    })
}

/// Removes an agent's git worktree with `--force`, discarding any uncommitted
/// changes, then soft-deletes its branch (`git branch -d`). Because `-d` only
/// removes a fully-merged branch, any committed-but-unmerged work is preserved —
/// git refuses and the branch is kept. Runs from the group's base repository so
/// git is never asked to remove the worktree it is standing in.
pub fn remove_agent_worktree(state: &AppState, agent_id: &str) -> Result<(), String> {
    let agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    let removal = capture_agent_worktree_removal(state, &agent)?;
    remove_captured_worktree(removal)?;
    state.clear_last_closed_pane_for_agent(agent_id);
    Ok(())
}

pub fn capture_agent_worktree_removal(
    state: &AppState,
    agent: &AgentInfo,
) -> Result<CapturedWorktreeRemoval, String> {
    let Some(branch) = agent.branch.clone() else {
        return Err(format!("agent {} is not in a git worktree", agent.id));
    };
    let worktree_dir = agent.worktree_dir.clone();

    let run_dir = state
        .group(&agent.group_id)?
        .and_then(|group| group.base_repo)
        .filter(|repo| is_git_repo(repo))
        .unwrap_or_else(|| worktree_dir.clone());

    Ok(CapturedWorktreeRemoval {
        run_dir,
        worktree_dir,
        branch,
    })
}

pub fn remove_captured_worktree(removal: CapturedWorktreeRemoval) -> Result<(), String> {
    let CapturedWorktreeRemoval {
        run_dir,
        worktree_dir,
        branch,
    } = removal;

    let output = Command::new("git")
        .arg("-C")
        .arg(&run_dir)
        .arg("worktree")
        .arg("remove")
        .arg("--force")
        .arg(&worktree_dir)
        .output()
        .map_err(|err| format!("failed to run git worktree remove: {err}"))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree remove failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Best-effort: the worktree is gone, so the branch can be soft-deleted. A
    // declined delete (unmerged commits) or a git error is logged, not fatal —
    // the worktree removal the user confirmed has already succeeded.
    match soft_delete_branch(&run_dir, &branch) {
        Ok(true) => {}
        Ok(false) => eprintln!("qmux: kept branch {branch}: not fully merged"),
        Err(err) => eprintln!("qmux: {err}"),
    }

    Ok(())
}

/// Soft-deletes `branch` in the repository at `run_dir`. Returns `Ok(true)` if
/// the branch was removed, `Ok(false)` if git declined because it is not fully
/// merged, or `Err` if git could not be run.
fn soft_delete_branch(run_dir: &str, branch: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(run_dir)
        .arg("branch")
        .arg("-d")
        .arg(branch)
        .output()
        .map_err(|err| format!("failed to run git branch -d {branch}: {err}"))?;
    Ok(output.status.success())
}

fn default_base_repo() -> Option<String> {
    env::current_dir()
        .ok()
        .map(|path| path.display().to_string())
}

/// A friendly, human-readable name for a new group / worktree, e.g.
/// "brave-otter" (two hyphenated words). Falls back to a timestamped name only
/// if generation somehow yields nothing, which the bundled word lists make
/// unreachable in practice.
fn default_group_name() -> String {
    names::Generator::default()
        .next()
        .unwrap_or_else(|| format!("group-{}", now_millis()))
}

/// Allocates a directory under `root` named with a freshly generated friendly
/// name, regenerating on collision so a new worktree never reuses the name of an
/// existing one.
fn unique_friendly_group_dir(root: &Path) -> Result<PathBuf, String> {
    let mut generator = names::Generator::default();
    for _ in 0..1000 {
        let Some(name) = generator.next() else { break };
        let candidate = root.join(sanitize_path_segment(&name));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    // Pathological case (every generated name collided): fall back to numeric
    // suffixing to guarantee forward progress.
    unique_group_dir(root, &default_group_name())
}

fn unique_group_dir(root: &Path, requested_name: &str) -> Result<PathBuf, String> {
    let base = sanitize_path_segment(requested_name);
    for index in 0..1000 {
        let name = if index == 0 {
            base.clone()
        } else {
            format!("{base}-{index}")
        };
        let candidate = root.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "failed to allocate a unique group directory under {}",
        root.display()
    ))
}

fn sanitize_path_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        default_group_name()
    } else {
        sanitized
    }
}

fn sanitize_ref_segment(value: &str) -> String {
    sanitize_path_segment(value)
}

fn is_git_repo(path: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn create_worktree(
    base_repo: &str,
    worktree_dir: &Path,
    branch: &str,
    base_ref: &str,
) -> Result<(), String> {
    // base_ref arrives from the frontend. Resolve it to a real commit first so an
    // option-looking value (e.g. "--detach") can't be interpreted by git as a flag
    // rather than a starting point. `--end-of-options` keeps a ref beginning with
    // "-" from being parsed as an option by rev-parse itself.
    verify_base_ref(base_repo, base_ref)?;

    let output = Command::new("git")
        .arg("-C")
        .arg(base_repo)
        .arg("worktree")
        .arg("add")
        .arg("-b")
        .arg(branch)
        // Stop option parsing before the user-influenced positional arguments so
        // neither the worktree path nor the ref can be mistaken for a flag.
        .arg("--")
        .arg(worktree_dir)
        .arg(base_ref)
        .output()
        .map_err(|err| format!("failed to run git worktree add: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git worktree add failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Verifies that `base_ref` resolves to a commit in `base_repo`, rejecting values
/// that don't (including option-looking input). `--end-of-options` ensures a ref
/// starting with "-" is treated as a revision rather than a flag.
fn verify_base_ref(base_repo: &str, base_ref: &str) -> Result<(), String> {
    let resolved = Command::new("git")
        .arg("-C")
        .arg(base_repo)
        .arg("rev-parse")
        .arg("--verify")
        .arg("--quiet")
        .arg("--end-of-options")
        .arg(format!("{base_ref}^{{commit}}"))
        .output()
        .map_err(|err| format!("failed to verify base ref: {err}"))?;

    if resolved.status.success() {
        Ok(())
    } else {
        Err(format!("base ref '{base_ref}' did not resolve to a commit"))
    }
}

fn write_group_manifest(group: &GroupInfo) -> Result<(), String> {
    let manifest_path = PathBuf::from(&group.dir).join(".qmux/group.json");
    let raw = serde_json::to_string_pretty(group)
        .map_err(|err| format!("failed to encode group manifest: {err}"))?;
    fs::write(&manifest_path, raw)
        .map_err(|err| format!("failed to write {}: {err}", manifest_path.display()))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, OpencodeAdapterConfig, QmuxConfig,
    };

    fn test_state() -> AppState {
        AppState::new(QmuxConfig {
            workspace_root: PathBuf::from("/tmp/qmux-workspace-tests"),
            socket_path: PathBuf::from("/tmp/qmux-workspace-tests.sock"),
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
        })
    }

    fn sample_agent(id: &str, pane_id: Option<&str>, status: AgentStatus) -> AgentInfo {
        AgentInfo {
            id: id.to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/qmux-workspace-tests".to_string(),
            branch: None,
            pane_id: pane_id.map(ToString::to_string),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
            created_at: 1,
        }
    }

    #[test]
    fn attach_agent_pane_detaches_previous_agent_for_same_pane() {
        let state = test_state();
        state
            .insert_agent(sample_agent(
                "agent-old",
                Some("pane-1"),
                AgentStatus::Running,
            ))
            .unwrap();
        state
            .insert_agent(sample_agent("agent-new", None, AgentStatus::Starting))
            .unwrap();
        state
            .enqueue_agent_turn("agent-old", "old queued turn".to_string())
            .unwrap();

        let attached = attach_agent_pane(&state, "agent-new", "pane-1".to_string()).unwrap();

        assert_eq!(attached.pane_id.as_deref(), Some("pane-1"));
        assert!(matches!(attached.status, AgentStatus::Running));
        let old = state.agent("agent-old").unwrap().expect("old agent exists");
        assert_eq!(old.pane_id, None);
        assert_eq!(old.orphaned_queue_pane_id.as_deref(), Some("pane-1"));
        assert!(matches!(old.status, AgentStatus::Idle));
        assert_eq!(
            state.list_agent_turn_queue("agent-old").unwrap(),
            vec!["old queued turn".to_string()]
        );
    }

    #[test]
    fn attach_agent_pane_preserves_session_id_and_transcript() {
        // attach binds the pane via a field-scoped write, so the session id/transcript a
        // freshly spawned agent's SessionStart hook records on another thread survive —
        // attach never touches those fields. (The clobber it guards against is a
        // concurrent interleaving, which a single-threaded test can't reproduce; this
        // asserts the structural invariant that attach only writes pane-binding fields.)
        let state = test_state();
        let mut spawned = sample_agent("agent-new", None, AgentStatus::Starting);
        spawned.session_id = Some("sess-xyz".to_string());
        spawned.transcript_path = Some("/tmp/new.jsonl".to_string());
        state.insert_agent(spawned).unwrap();

        let attached = attach_agent_pane(&state, "agent-new", "pane-1".to_string()).unwrap();

        assert_eq!(attached.pane_id.as_deref(), Some("pane-1"));
        assert!(matches!(attached.status, AgentStatus::Running));
        assert_eq!(attached.session_id.as_deref(), Some("sess-xyz"));
        assert_eq!(attached.transcript_path.as_deref(), Some("/tmp/new.jsonl"));
    }

    #[test]
    fn detach_pane_agent_reverts_pane_to_plain_shell() {
        // A shell-launched agent may still be carrying a prompt/notification status:
        // once the agent process exits, detaching clears the pane binding and drops it
        // to Idle so the tab stops advertising a stale status.
        let state = test_state();
        state
            .insert_agent(sample_agent(
                "agent-shell",
                Some("pane-1"),
                AgentStatus::AwaitingInput,
            ))
            .unwrap();

        let detached = detach_pane_agent(&state, "pane-1")
            .unwrap()
            .expect("an agent was bound to the pane");

        assert_eq!(detached.id, "agent-shell");
        assert_eq!(detached.pane_id, None);
        assert!(matches!(detached.status, AgentStatus::Idle));
        let stored = state
            .agent("agent-shell")
            .unwrap()
            .expect("agent still exists");
        assert_eq!(stored.pane_id, None);
        assert!(matches!(stored.status, AgentStatus::Idle));
    }

    #[test]
    fn detach_pane_agent_parks_queued_turns_as_orphaned() {
        // An agent with queued turns must stay restart-recoverable, so detaching parks its
        // queue as an orphaned queue on the pane rather than discarding it.
        let state = test_state();
        state
            .insert_agent(sample_agent(
                "agent-shell",
                Some("pane-1"),
                AgentStatus::Running,
            ))
            .unwrap();
        state
            .enqueue_agent_turn("agent-shell", "queued turn".to_string())
            .unwrap();

        let detached = detach_pane_agent(&state, "pane-1").unwrap().unwrap();

        assert_eq!(detached.pane_id, None);
        assert_eq!(detached.orphaned_queue_pane_id.as_deref(), Some("pane-1"));
        assert_eq!(
            state.list_agent_turn_queue("agent-shell").unwrap(),
            vec!["queued turn".to_string()]
        );
    }

    #[test]
    fn clear_agent_working_status_only_clears_running_states() {
        let state = test_state();
        state
            .insert_agent(sample_agent(
                "agent-running",
                Some("pane-1"),
                AgentStatus::Running,
            ))
            .unwrap();
        state
            .insert_agent(sample_agent(
                "agent-starting",
                Some("pane-2"),
                AgentStatus::Starting,
            ))
            .unwrap();
        state
            .insert_agent(sample_agent(
                "agent-waiting",
                Some("pane-3"),
                AgentStatus::AwaitingInput,
            ))
            .unwrap();

        let running = clear_agent_working_status(&state, "agent-running").unwrap();
        let starting = clear_agent_working_status(&state, "agent-starting").unwrap();
        let waiting = clear_agent_working_status(&state, "agent-waiting").unwrap();

        // Working states are routed through the idle completion path, so with no queued
        // turn they land on Done (a finished status), not a fresh Idle. A non-working
        // state (AwaitingInput) is left untouched.
        assert!(matches!(running.status, AgentStatus::Done));
        assert!(matches!(starting.status, AgentStatus::Done));
        assert!(matches!(waiting.status, AgentStatus::AwaitingInput));
        assert!(matches!(
            state.agent("agent-running").unwrap().unwrap().status,
            AgentStatus::Done
        ));
        assert!(matches!(
            state.agent("agent-starting").unwrap().unwrap().status,
            AgentStatus::Done
        ));
        assert!(matches!(
            state.agent("agent-waiting").unwrap().unwrap().status,
            AgentStatus::AwaitingInput
        ));
    }

    #[test]
    fn detach_pane_agent_is_a_noop_for_an_unowned_pane() {
        let state = test_state();
        assert!(detach_pane_agent(&state, "pane-empty").unwrap().is_none());
    }

    #[test]
    fn mark_agent_spawn_failed_clears_reserved_pane_binding() {
        let state = test_state();
        let mut agent = sample_agent("agent-new", Some("pane-1"), AgentStatus::Running);
        agent.orphaned_queue_pane_id = Some("pane-1".to_string());
        agent.session_id = Some("sess-xyz".to_string());
        state.insert_agent(agent).unwrap();

        let failed = mark_agent_spawn_failed(&state, "agent-new", "pane-1").unwrap();

        assert_eq!(failed.pane_id, None);
        assert_eq!(failed.orphaned_queue_pane_id, None);
        assert!(matches!(failed.status, AgentStatus::Failed));
        assert_eq!(failed.session_id.as_deref(), Some("sess-xyz"));
    }

    #[test]
    fn stopped_status_deserializes_as_idle() {
        let status: AgentStatus = serde_json::from_str("\"stopped\"").unwrap();
        assert!(matches!(status, AgentStatus::Idle));
    }

    #[test]
    fn default_group_name_is_a_human_readable_hyphenated_name() {
        // Sample several times since generation is random.
        for _ in 0..50 {
            let name = default_group_name();
            let words: Vec<&str> = name.split('-').collect();
            // Hyphenated words (typically two: adjective-noun), each a non-empty
            // run of lowercase letters — not the old "group-<millis>" form.
            assert!(words.len() >= 2, "expected a hyphenated name, got {name:?}");
            assert!(
                words
                    .iter()
                    .all(|word| !word.is_empty() && word.chars().all(|ch| ch.is_ascii_lowercase())),
                "unexpected friendly name {name:?}"
            );
            assert!(
                !name.starts_with("group-"),
                "name should not use the group- prefix: {name:?}"
            );
        }
    }

    fn branch_exists(repo: &Path, branch: &str) -> bool {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["branch", "--list", branch])
            .output()
            .expect("git branch --list runs");
        !String::from_utf8_lossy(&output.stdout).trim().is_empty()
    }

    #[test]
    fn soft_delete_branch_removes_merged_keeps_unmerged() {
        let repo = std::env::temp_dir().join(format!("qmux-branch-{}", now_millis()));
        fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().to_string();

        let git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };

        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "qmux test"]);
        git(&["commit", "--allow-empty", "-m", "init"]);

        // A branch at HEAD is fully merged, so the soft delete removes it.
        git(&["branch", "merged"]);
        assert_eq!(soft_delete_branch(&repo_str, "merged"), Ok(true));
        assert!(!branch_exists(&repo, "merged"));

        // A branch with its own commit is not merged into main, so git declines
        // and the branch (and its committed work) is preserved.
        git(&["checkout", "-b", "feature"]);
        git(&["commit", "--allow-empty", "-m", "work"]);
        git(&["checkout", "main"]);
        assert_eq!(soft_delete_branch(&repo_str, "feature"), Ok(false));
        assert!(branch_exists(&repo, "feature"));

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn unique_friendly_group_dir_skips_existing_worktrees() {
        let root = std::env::temp_dir().join(format!("qmux-friendly-{}", now_millis()));
        fs::create_dir_all(&root).unwrap();

        // Occupy a directory, then assert the allocator never hands it back.
        let taken = unique_friendly_group_dir(&root).unwrap();
        fs::create_dir_all(&taken).unwrap();
        for _ in 0..20 {
            let next = unique_friendly_group_dir(&root).unwrap();
            assert_ne!(next, taken, "allocator returned an existing worktree dir");
            assert!(!next.exists());
        }

        fs::remove_dir_all(&root).ok();
    }
}
