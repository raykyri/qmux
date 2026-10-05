//! Research admission and execution shared by the desktop and background service.
use crate::adapters::{SpawnAgentRequest, agent_spawn as spawn_agent_pane, fork_agent_source};
use crate::pty::kill_pane;
use crate::research::{
    CreateResearchDocumentRequest, CreateResearchTreeRequest, ResearchNode, ResearchNodeContent,
    ResearchTreeDetail, UpdateResearchDocumentRequest, UpdateResearchDocumentResult,
};
use crate::state::AppState;
use crate::workspace::{
    AgentInfo, AgentStatus, GroupInfo, LaunchOrigin, validate_launch_workspace,
};
use crate::{adapters, events, persistence, research, research_runtime, workspace};

fn fail_research_launch(state: &AppState, node_id: &str, pane_id: &str, error: String) -> String {
    match kill_pane(state, pane_id.to_string()) {
        Ok(()) => state.clear_last_closed_pane_for_pane(pane_id),
        Err(cleanup_error) => {
            eprintln!("qmux: failed to clean up unbound research pane {pane_id}: {cleanup_error}");
        }
    }
    let _ = state.fail_research_node(node_id, error.clone());
    error
}

/// A research run the user settled (cancelled) while its launch was still in
/// flight keeps its outcome — binding never resurrects it — but the launch has
/// produced a live pane nothing will ever retire: research panes are hidden
/// from the tab strip and the Cancel control is gone once the node is settled.
/// Reclaim it here, mirroring cancellation's own pane teardown.
fn reclaim_settled_research_launch(state: &AppState, node: &research::ResearchNode, pane_id: &str) {
    if !node.status.is_terminal() {
        return;
    }
    match kill_pane(state, pane_id.to_string()) {
        Ok(()) => state.clear_last_closed_pane_for_pane(pane_id),
        Err(err) => {
            if state.pane_exists(pane_id).unwrap_or(false) {
                eprintln!("qmux: failed to reclaim settled research pane {pane_id}: {err}");
            }
        }
    }
}

/// Maps a research node's reasoning effort onto the launching adapter's own
/// launch-option key. Adapters without a reasoning-effort option launch with
/// their defaults.
fn research_launch_options(adapter: &str, effort: Option<&str>) -> serde_json::Value {
    match (adapter, effort) {
        ("claude", Some(effort)) => serde_json::json!({ "effort": effort }),
        ("codex", Some(effort)) => serde_json::json!({ "reasoningEffort": effort }),
        _ => serde_json::Value::Null,
    }
}

fn launch_research_execution(
    state: &AppState,
    node: &research::ResearchNode,
    workspace: &workspace::GroupInfo,
    prompt: String,
    fork_from: Option<&workspace::AgentInfo>,
) -> Result<research::ResearchNode, String> {
    let prompt = match persistence::load_preferences(&state.config().workspace_root) {
        Ok(preferences) => research::prompt_with_research_launch_instruction(
            prompt,
            preferences.research_launch_instruction.as_deref(),
        ),
        Err(err) => {
            let _ = state.fail_research_node(&node.id, err.clone());
            return Err(err);
        }
    };
    if research_runtime::should_use_research_sdk(state, &node.adapter) {
        let resume = fork_from.and_then(|agent| agent.session_id.clone());
        return research_runtime::launch(
            state,
            node,
            workspace,
            prompt,
            resume,
            fork_from.is_some(),
        );
    }
    launch_fresh_research_pane(
        state,
        &node.id,
        workspace,
        &node.adapter,
        node.model.clone(),
        node.effort.clone(),
        prompt,
    )
}

/// Launches a fresh (non-forked) agent run for an admitted research node and
/// binds the resulting pane. Shared by root-run creation and document
/// follow-ups. On failure the node is failed and any spawned pane reclaimed;
/// tree-level rollback stays with the caller.
fn launch_fresh_research_run(
    state: &AppState,
    node_id: &str,
    workspace: &workspace::GroupInfo,
    adapter: &str,
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
) -> Result<research::ResearchNode, String> {
    let _ = (adapter, model, effort);
    let node = state.research_node(node_id)?;
    launch_research_execution(state, &node, workspace, prompt, None)
}

fn launch_fresh_research_pane(
    state: &AppState,
    node_id: &str,
    workspace: &workspace::GroupInfo,
    adapter: &str,
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
) -> Result<research::ResearchNode, String> {
    let options = research_launch_options(adapter, effort.as_deref());
    let spawn = SpawnAgentRequest {
        adapter_id: adapter.to_string(),
        prompt,
        group_id: Some(workspace.id.clone()),
        base_repo: Some(workspace.dir.clone()),
        base_ref: Some("HEAD".to_string()),
        cwd: None,
        model,
        initial_size: None,
        use_worktree: Some(false),
        options,
        parent_id: None,
        resume_session_id: None,
        fork_session: false,
    };
    match spawn_agent_pane(state, spawn) {
        Ok(pane) => {
            let association = pane
                .agent_id
                .as_deref()
                .and_then(|agent_id| state.agent(agent_id).ok().flatten())
                .ok_or_else(|| "research agent was not recorded after launch".to_string())
                .and_then(|agent| {
                    state
                        .bind_research_node_run(node_id, &agent, &pane.id)
                        .map(|node| (agent, node))
                });
            match association {
                Ok((agent, node)) => {
                    if node.status.is_terminal() {
                        // Cancelled while the spawn was in flight: the
                        // outcome stands and the pane is reclaimed, so
                        // there is nothing to announce.
                        reclaim_settled_research_launch(state, &node, &pane.id);
                    } else {
                        // Fresh spawns go through launch(), which emits no event
                        // (launcher spawns assume a frontend caller holds the
                        // pane). Nothing holds this one, so announce it or the
                        // pane never enters the frontend list: Background
                        // activity can't show it and "Open terminal" misses.
                        state.emit(events::QmuxEvent::new(
                            "agent.spawned",
                            Some(pane.id.clone()),
                            Some(agent.id.clone()),
                            serde_json::json!({
                                "agent": agent,
                                "pane": pane,
                                "source": "research",
                            }),
                        ));
                        state.schedule_research_startup_watchdog(agent.id.clone());
                    }
                    state.research_node(node_id)
                }
                Err(err) => Err(fail_research_launch(state, node_id, &pane.id, err)),
            }
        }
        Err(err) => {
            let _ = state.fail_research_node(node_id, err.clone());
            Err(err)
        }
    }
}

/// The tree is committed before its root run launches so a crash mid-launch is
/// recoverable, but a root that never launched holds nothing durable. Leaving
/// it behind on a launch failure accumulated dead entries the caller could not
/// even identify — the command returns the error, not the tree id — while the
/// dialog keeps the prompt for a retry. Best-effort: if the removal itself
/// fails, the failed tree remains visible (and removable) in the sidebar.
fn remove_unlaunched_research_tree(state: &AppState, tree_id: &str) {
    if let Err(err) = state.remove_research_tree(tree_id) {
        eprintln!("qmux: failed to remove unlaunched research tree {tree_id}: {err}");
    }
}

/// Launches the run for an admitted (Queued) research child from its parent's
/// kind: document and conversation parents launch fresh runs that carry their
/// content as prompt context; run parents fork the parent's native session.
/// Shared by the fork command and retry, which relaunches a reset child
/// through the same dispatch. Every failure path settles the child as Failed
/// (reclaiming any spawned pane) before returning the error, exactly as the
/// fork command always did.
fn launch_research_child_run(
    state: &AppState,
    parent: &ResearchNode,
    workspace: &GroupInfo,
    child: &ResearchNode,
) -> Result<ResearchNode, String> {
    // A highlight-targeted follow-up sends the quoted passage with the
    // question. Only the sent prompt carries the quote — the child's
    // displayed prompt stays the bare question, which boundary matching
    // still finds as a normalized substring of the sent prompt.
    let question = match &child.query_anchor {
        Some(anchor) => research::query_followup_prompt(&anchor.exact, &child.prompt),
        None => child.prompt.clone(),
    };
    // Exhaustive on purpose: each kind must pick its launch path
    // explicitly, so a new kind (or lifting a refusal in
    // create_research_child) forces a decision here instead of falling
    // into the session-fork branch without a checkpoint.
    match parent.kind {
        research::ResearchNodeKind::Document => {
            // A document has no session to fork. Its follow-up launches a
            // fresh run whose prompt carries the document as context; the
            // child's displayed prompt stays the bare question (the
            // response boundary still matches it as a substring of the
            // sent prompt).
            let launch_prompt = state.research_document_followup_prompt(&parent.id, &question);
            let launch_prompt = match launch_prompt {
                Ok(launch_prompt) => launch_prompt,
                Err(err) => {
                    let _ = state.fail_research_node(&child.id, err.clone());
                    return Err(err);
                }
            };
            return launch_fresh_research_run(
                state,
                &child.id,
                workspace,
                &child.adapter,
                child.model.clone(),
                child.effort.clone(),
                launch_prompt,
            );
        }
        research::ResearchNodeKind::Conversation => {
            // An exported conversation is severed from its source session
            // — there is nothing to fork. Its follow-up launches a fresh
            // run whose prompt carries the serialized conversation as
            // context; the child's displayed prompt stays the bare
            // question (the response boundary still matches it as a
            // substring of the sent prompt).
            //
            // The bare prompt and the anchor go in unwrapped: an anchored
            // quote is conversation content, so the conversation prompt
            // builder wraps it itself with the tag neutralization the
            // serialized turns get, rather than taking the verbatim
            // `question` the other kinds share.
            let launch_prompt = state.research_conversation_followup_prompt(
                &parent.id,
                &child.prompt,
                child.query_anchor.as_ref(),
            );
            let launch_prompt = match launch_prompt {
                Ok(launch_prompt) => launch_prompt,
                Err(err) => {
                    let _ = state.fail_research_node(&child.id, err.clone());
                    return Err(err);
                }
            };
            return launch_fresh_research_run(
                state,
                &child.id,
                workspace,
                &child.adapter,
                child.model.clone(),
                child.effort.clone(),
                launch_prompt,
            );
        }
        research::ResearchNodeKind::Run => {}
    }
    let live_source = parent
        .agent_id
        .as_deref()
        .and_then(|agent_id| state.agent(agent_id).ok().flatten());
    let mut source = match live_source {
        Some(source) => source,
        None => {
            let session_id = match parent.native_session_id.clone() {
                Some(session_id) => session_id,
                None => {
                    let err =
                        "the parent research session has no native session id to fork".to_string();
                    let _ = state.fail_research_node(&child.id, err.clone());
                    return Err(err);
                }
            };
            AgentInfo {
                id: parent
                    .agent_id
                    .clone()
                    .unwrap_or_else(|| format!("research-source-{}", parent.id)),
                group_id: parent.group_id.clone(),
                adapter: parent.adapter.clone(),
                worktree_dir: parent.worktree_dir.clone(),
                branch: None,
                active_workspace: None,
                pane_id: None,
                orphaned_queue_pane_id: None,
                session_id: Some(session_id.clone()),
                transcript_path: parent.transcript_path.clone(),
                status: AgentStatus::Done,
                model: parent.model.clone(),
                effort: parent.effort.clone(),
                approval_mode: None,
                parent_id: None,
                fork_point: None,
                root_session_id: Some(session_id),
                thread_id: None,
                branch_id: None,
                native_leaf_id: None,
                paused: false,
                created_at: parent.created_at,
            }
        }
    };
    // Native checkpoints come from the parent run, but execution ownership
    // and cwd always come from the tree's current durable workspace.
    source.group_id = workspace.id.clone();
    source.worktree_dir = workspace.dir.clone();
    // The follow-up runs at the child's (inherited) effort, applied by the
    // adapter's fork path the same way `model` is re-applied.
    source.effort = child.effort.clone();
    if research_runtime::should_use_research_sdk(state, &child.adapter) {
        return launch_research_execution(state, child, workspace, question, Some(&source));
    }
    let question = match persistence::load_preferences(&state.config().workspace_root) {
        Ok(preferences) => research::prompt_with_research_launch_instruction(
            question,
            preferences.research_launch_instruction.as_deref(),
        ),
        Err(err) => {
            let _ = state.fail_research_node(&child.id, err.clone());
            return Err(err);
        }
    };
    match fork_agent_source(state, &source, false, Some(&question)) {
        Ok(pane) => {
            let association = pane
                .agent_id
                .as_deref()
                .and_then(|agent_id| state.agent(agent_id).ok().flatten())
                .ok_or_else(|| "forked research agent was not recorded".to_string())
                .and_then(|agent| state.bind_research_node_run(&child.id, &agent, &pane.id));
            match association {
                Ok(node) if node.status.is_terminal() => {
                    // Cancelled while the fork was in flight: keep the
                    // settled outcome, reclaim the fresh pane, and hand
                    // back the node as it stands after the teardown.
                    reclaim_settled_research_launch(state, &node, &pane.id);
                    state.research_node(&child.id)
                }
                Ok(node) => {
                    // Forks usually land in an already-trusted directory,
                    // but login/update gates are just as hook-invisible as
                    // the trust dialog — arm the same startup watchdog as
                    // fresh runs.
                    if let Some(agent_id) = node.agent_id.clone() {
                        state.schedule_research_startup_watchdog(agent_id);
                    }
                    Ok(node)
                }
                Err(err) => Err(fail_research_launch(state, &child.id, &pane.id, err)),
            }
        }
        Err(err) => {
            let _ = state.fail_research_node(&child.id, err.clone());
            Err(err)
        }
    }
}

pub fn create_research_tree(
    state: &AppState,
    request: CreateResearchTreeRequest,
) -> Result<ResearchTreeDetail, String> {
    // Probe before inserting a tree or reserving an agent. The frontend
    // performs the same preflight before creating a default workspace, but
    // this backend guard also covers stale UI state and direct IPC callers.
    adapters::ensure_adapter_ready_for_research(state.config(), &request.adapter)?;
    // Admission holds the workspace-mutation guard so a concurrent folder
    // removal can't slip between validation and the node insert —
    // the spawn itself runs unguarded (it's slow, and the Queued node
    // already marks the workspace busy).
    let detail = {
        let _guard = workspace::lock_research_workspace_mutations()?;
        validate_launch_workspace(&state, Some(&request.group_id), LaunchOrigin::Research)?;
        state.create_research_tree(request)?
    };
    let root = detail
        .nodes
        .first()
        .cloned()
        .ok_or_else(|| "new research tree has no root node".to_string())?;
    let workspace = match state.research_workspace_for_node(&root.id) {
        Ok(workspace) => workspace,
        Err(err) => {
            let _ = state.fail_research_node(&root.id, err.clone());
            remove_unlaunched_research_tree(&state, &detail.tree.id);
            return Err(err);
        }
    };
    match launch_fresh_research_run(
        &state,
        &root.id,
        &workspace,
        &root.adapter,
        root.model.clone(),
        root.effort.clone(),
        root.prompt.clone(),
    ) {
        Ok(_) => state.research_tree(&detail.tree.id),
        Err(err) => {
            remove_unlaunched_research_tree(&state, &detail.tree.id);
            Err(err)
        }
    }
}

pub fn create_research_document(
    state: &AppState,
    request: CreateResearchDocumentRequest,
) -> Result<ResearchTreeDetail, String> {
    // Same admission as create_research_tree: the insert must be atomic
    // with the workspace checks or a concurrent folder removal could
    // detach the workspace out from under the new records. There is no
    // run to launch, so admission is the whole command.
    let _guard = workspace::lock_research_workspace_mutations()?;
    validate_launch_workspace(&state, Some(&request.group_id), LaunchOrigin::Research)?;
    state.create_research_document(request)
}

pub fn export_pane_to_research(
    state: &AppState,
    request: research::ExportPaneToResearchRequest,
) -> Result<ResearchTreeDetail, String> {
    // The slow work — transcript reads, sanitization, the snapshot write
    // — runs unguarded, like create_research_tree's spawn: only
    // admission needs atomicity with workspace mutations, and a failure
    // after prepare strands at most an orphan snapshot.
    let prepared = state.prepare_pane_export(&request.pane_id)?;
    let committed = {
        let _guard = workspace::lock_research_workspace_mutations()?;
        validate_launch_workspace(&state, Some(&request.group_id), LaunchOrigin::Research)
            .and_then(|_| state.commit_pane_export(&prepared, request.group_id, request.title))
    };
    if committed.is_err() {
        // Redundant after a commit-side admission failure (the removal is
        // idempotent), but validation failures never reach commit.
        state.discard_pane_export(&prepared);
    }
    committed
}

pub fn update_research_document(
    state: &AppState,
    request: UpdateResearchDocumentRequest,
) -> Result<UpdateResearchDocumentResult, String> {
    let _workspace_guard = workspace::lock_research_workspace_mutations()?;
    state.update_research_document(request)
}

pub fn get_research_node_content(
    state: &AppState,
    node_id: String,
) -> Result<ResearchNodeContent, String> {
    let mut content = state.research_node_content(&node_id)?;
    // A corrupt or oversized snapshot must not wedge the node: fall back to
    // the transcript exactly as if no snapshot existed, keeping the read
    // failure only as diagnostic context if nothing else is viewable.
    let snapshot_error = match research::read_response_snapshot_with_revision(
        &state.config().workspace_root,
        &node_id,
    ) {
        Ok(Some(snapshot)) => {
            content.response_revision = Some(snapshot.revision);
            content.turns = snapshot.turns;
            return Ok(content);
        }
        Ok(None) => None,
        Err(err) => {
            eprintln!("qmux: unreadable research response snapshot {node_id}: {err}");
            Some(err)
        }
    };
    if content.node.transcript_path.is_some()
        && matches!(
            content.node.status,
            research::ResearchNodeStatus::Complete
                | research::ResearchNodeStatus::Failed
                | research::ResearchNodeStatus::Cancelled
        )
    {
        let ancestor_prompts = state
            .research_node_ancestor_prompts(&node_id)
            .unwrap_or_default();
        match research::load_transcript_response(state.config(), &content.node, &ancestor_prompts) {
            Ok(turns) => content.turns = turns,
            // No snapshot, no live turns, and the adapter transcript is
            // unreadable: return the node with the failure recorded rather
            // than erroring, which would wedge the workspace on a retry
            // loop that can never succeed and hide the node entirely.
            Err(err) if content.turns.is_empty() => {
                content.source_error = Some(match snapshot_error {
                    Some(snapshot_error) => format!("{snapshot_error}; {err}"),
                    None => err,
                });
            }
            Err(_) => {}
        }
    } else if content.turns.is_empty() {
        content.source_error = snapshot_error;
    }
    Ok(content)
}

pub fn fork_research_node(
    state: &AppState,
    parent_node_id: String,
    prompt: String,
    publication_proposal: Option<research::ResearchPublicationProposal>,
    query_anchor: Option<research::ResearchHighlightAnchor>,
    inline: Option<bool>,
) -> Result<ResearchNode, String> {
    let inline = inline.unwrap_or(false);

    if inline && publication_proposal.is_some() {
        return Err("community proposals become branches, not inline follow-ups".to_string());
    }
    // Same admission guard as create_research_tree: the Queued child must
    // be admitted atomically with the workspace checks, or a concurrent
    // folder removal could invalidate its workspace before the fork.
    let (parent, workspace, child) = {
        let _guard = workspace::lock_research_workspace_mutations()?;
        let parent = state.research_node(&parent_node_id)?;
        let workspace = state.research_workspace_for_node(&parent_node_id)?;
        validate_launch_workspace(&state, Some(&workspace.id), LaunchOrigin::Research)?;
        let child = match publication_proposal {
            Some(proposal) => {
                state.create_research_child_for_proposal(&parent_node_id, prompt, proposal)?
            }
            None => state.create_research_child(&parent_node_id, prompt, query_anchor, inline)?,
        };
        (parent, workspace, child)
    };
    launch_research_child_run(&state, &parent, &workspace, &child)
}

pub fn retry_research_node(
    state: &AppState,
    node_id: String,
) -> Result<ResearchTreeDetail, String> {
    // Same admission guard as create/fork: the node must flip back to
    // Queued atomically with the workspace checks, or a concurrent folder
    // removal could invalidate its workspace before the relaunch. The
    // reset itself refuses anything that is not a settled Failed/Cancelled
    // run (or that still holds a live pane), so a double-click cannot
    // relaunch twice.
    let node = {
        let _guard = workspace::lock_research_workspace_mutations()?;
        let node = state.research_node(&node_id)?;
        validate_launch_workspace(&state, Some(&node.group_id), LaunchOrigin::Research)?;
        state.reset_research_node_for_retry(&node_id)?
    };
    // Failures past this point must settle the re-queued node: leaving it
    // Queued would pin the tree as an active run nothing ever finishes.
    let workspace = match state.research_workspace_for_node(&node_id) {
        Ok(workspace) => workspace,
        Err(err) => {
            let _ = state.fail_research_node(&node_id, err.clone());
            return Err(err);
        }
    };
    let launch = match node.parent_node_id.as_deref() {
        None => launch_fresh_research_run(
            &state,
            &node.id,
            &workspace,
            &node.adapter,
            node.model.clone(),
            node.effort.clone(),
            node.prompt.clone(),
        ),
        Some(parent_id) => {
            let parent = match state.research_node(parent_id) {
                Ok(parent) => parent,
                Err(err) => {
                    let _ = state.fail_research_node(&node.id, err.clone());
                    return Err(err);
                }
            };
            // The original fork required a completed parent; a parent that
            // has since been re-run (or whose checkpoint regressed) cannot
            // anchor the relaunch.
            if parent.status != research::ResearchNodeStatus::Complete {
                let err = "research follow-ups require a completed parent response".to_string();
                let _ = state.fail_research_node(&node.id, err.clone());
                return Err(err);
            }
            launch_research_child_run(&state, &parent, &workspace, &node)
        }
    };
    launch?;
    state.research_tree(&node.tree_id)
}
