//! Research documents, runs, imports, and synchronization with terminal agents.
//! AppState retains the same shared model and lock ownership.

use super::*;

impl AppState {
    pub fn list_research_trees(&self) -> Result<Vec<ResearchTreeSummary>, String> {
        self.list_research_trees_with_archived(false)
    }

    pub fn list_research_trees_with_archived(
        &self,
        include_archived: bool,
    ) -> Result<Vec<ResearchTreeSummary>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let mut summaries = model
            .research_trees
            .values()
            .filter(|tree| include_archived || tree.archived_at.is_none())
            .map(|tree| {
                let nodes = model
                    .research_nodes
                    .values()
                    .filter(|node| node.tree_id == tree.id);
                fn merge(left: Option<u128>, right: Option<u128>) -> Option<u128> {
                    match (left, right) {
                        (Some(left), Some(right)) => Some(left.max(right)),
                        (None, right) => right,
                        (left, None) => left,
                    }
                }
                let (
                    running_count,
                    failed_count,
                    completed_count,
                    cancelled_count,
                    latest_settlement,
                    latest_failure,
                ) = nodes.fold((0, 0, 0, 0, None::<u128>, None::<u128>), |counts, node| {
                    let failed = node.status == ResearchNodeStatus::Failed;
                    (
                        counts.0 + usize::from(node.status.is_active()),
                        counts.1 + usize::from(failed),
                        counts.2 + usize::from(node.status == ResearchNodeStatus::Complete),
                        counts.3 + usize::from(node.status == ResearchNodeStatus::Cancelled),
                        merge(counts.4, node.completed_at),
                        if failed {
                            merge(counts.5, node.completed_at)
                        } else {
                            counts.5
                        },
                    )
                });
                let unseen = |settled_at: Option<u128>| {
                    settled_at.is_some_and(|settled_at| {
                        tree.last_viewed_at
                            .is_none_or(|last_viewed_at| settled_at > last_viewed_at)
                    })
                };
                ResearchTreeSummary {
                    id: tree.id.clone(),
                    title: tree.title.clone(),
                    root_node_id: tree.root_node_id.clone(),
                    kind: model
                        .research_nodes
                        .get(&tree.root_node_id)
                        .map(|root| root.kind)
                        .unwrap_or_default(),
                    workspace_id: tree.workspace_id.clone(),
                    running_count,
                    failed_count,
                    completed_count,
                    cancelled_count,
                    updated_at: tree.updated_at,
                    archived_at: tree.archived_at,
                    has_unseen_update: unseen(latest_settlement),
                    // Viewing the tree acknowledges the failure; the lifetime
                    // failed_count stays for detail displays but must not brand
                    // the sidebar forever.
                    has_unseen_failure: unseen(latest_failure),
                }
            })
            .collect::<Vec<_>>();
        let order = ordered_research_tree_ids(&model)
            .into_iter()
            .enumerate()
            .map(|(index, tree_id)| (tree_id, index))
            .collect::<HashMap<_, _>>();
        summaries.sort_by_key(|summary| order.get(&summary.id).copied().unwrap_or(usize::MAX));
        Ok(summaries)
    }

    /// Reorders exactly one visible Research sidebar section. Replacing only
    /// that folder/status subsequence leaves hidden archived trees and other
    /// folders at their existing positions in the master order.
    pub fn reorder_research_trees(
        &self,
        workspace_id: &str,
        archived: bool,
        tree_ids: Vec<String>,
    ) -> Result<(), String> {
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let expected = ordered_research_tree_ids(&model)
                .into_iter()
                .filter(|tree_id| {
                    model.research_trees.get(tree_id).is_some_and(|tree| {
                        tree.workspace_id == workspace_id && tree.archived_at.is_some() == archived
                    })
                })
                .collect::<Vec<_>>();
            if tree_ids.len() != expected.len() {
                return Err("research tree order is stale; refresh before reordering".to_string());
            }
            let expected_ids = expected.iter().cloned().collect::<HashSet<_>>();
            let mut seen = HashSet::with_capacity(tree_ids.len());
            for tree_id in &tree_ids {
                if !seen.insert(tree_id.clone()) {
                    return Err("research tree order contains a duplicate tree".to_string());
                }
                if !expected_ids.contains(tree_id) {
                    return Err(format!(
                        "research tree {tree_id} is not in the requested sidebar section"
                    ));
                }
            }
            if tree_ids == expected {
                return Ok(());
            }

            let mut replacements = tree_ids.into_iter();
            let mut next_order = ordered_research_tree_ids(&model);
            for tree_id in &mut next_order {
                let replace = model.research_trees.get(tree_id).is_some_and(|tree| {
                    tree.workspace_id == workspace_id && tree.archived_at.is_some() == archived
                });
                if replace {
                    *tree_id = replacements.next().expect("validated replacement count");
                }
            }
            model.research_tree_order = next_order;
        }
        self.persist();
        Ok(())
    }

    pub fn research_folders(&self) -> Result<research::ResearchFolderState, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.research_folders.clone())
    }

    /// Replaces the stored grouping with a client-supplied one. Structural
    /// normalization only (dedupe, drop membership/collapsed that point at
    /// folders not in the payload) — it deliberately does NOT prune by tree
    /// existence. Tree-existence reconciliation belongs at load and at actual
    /// tree removal, under the authoritative tree set; pruning here against a
    /// caller that momentarily sees fewer trees is exactly the loss this work
    /// removes. Returns the normalized state the frontend should adopt.
    pub fn set_research_folders(
        &self,
        mut folders: research::ResearchFolderState,
    ) -> Result<research::ResearchFolderState, String> {
        research::normalize_research_folder_state(&mut folders);
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model.research_folders == folders {
                return Ok(folders);
            }
            model.research_folders = folders.clone();
        }
        self.persist();
        Ok(folders)
    }

    pub fn list_research_activity(&self) -> Result<Vec<ResearchNode>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let mut nodes = model
            .research_nodes
            .values()
            // Queued launch-in-flight nodes are active even before a pane is
            // bound. Keep them visible to exit cancellation and activity UI.
            .filter(|node| node.pane_id.is_some() || node.status.is_active())
            .cloned()
            .collect::<Vec<_>>();
        nodes.sort_by_key(|node| (node.created_at, node.id.clone()));
        Ok(nodes)
    }

    pub fn list_recent_research_queries(
        &self,
        limit: usize,
        before: Option<RecentResearchQueryCursor>,
    ) -> Result<RecentResearchQueryPage, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let mut nodes = model
            .research_nodes
            .values()
            .filter(|node| {
                node.kind.is_run()
                    && model.research_trees.contains_key(&node.tree_id)
                    && before.as_ref().is_none_or(|cursor| {
                        node.created_at < cursor.created_at
                            || (node.created_at == cursor.created_at && node.id < cursor.node_id)
                    })
            })
            .collect::<Vec<_>>();
        nodes.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        let page_size = limit.clamp(1, 100);
        let has_more = nodes.len() > page_size;
        nodes.truncate(page_size);
        let items = nodes
            .into_iter()
            .map(RecentResearchQuery::from)
            .collect::<Vec<_>>();
        let next_cursor = has_more.then(|| {
            let last = items.last().expect("a non-empty limited page");
            RecentResearchQueryCursor {
                created_at: last.created_at,
                node_id: last.node_id.clone(),
            }
        });
        Ok(RecentResearchQueryPage { items, next_cursor })
    }

    pub fn research_tree(&self, tree_id: &str) -> Result<ResearchTreeDetail, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let tree = model
            .research_trees
            .get(tree_id)
            .cloned()
            .ok_or_else(|| format!("research tree {tree_id} was not found"))?;
        let mut nodes = model
            .research_nodes
            .values()
            .filter(|node| node.tree_id == tree_id)
            .cloned()
            .collect::<Vec<_>>();
        nodes.sort_by_key(|node| (node.created_at, node.id.clone()));
        Ok(ResearchTreeDetail { tree, nodes })
    }

    pub fn research_node(&self, node_id: &str) -> Result<ResearchNode, String> {
        self.inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?
            .research_nodes
            .get(node_id)
            .cloned()
            .ok_or_else(|| format!("research node {node_id} was not found"))
    }

    /// Prompts of the node's ancestor chain, nearest parent first, for
    /// response-boundary matching against replayed forked history.
    pub fn research_node_ancestor_prompts(&self, node_id: &str) -> Result<Vec<String>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let node = model
            .research_nodes
            .get(node_id)
            .ok_or_else(|| format!("research node {node_id} was not found"))?;
        Ok(research::ancestor_prompts(node, |id| {
            model.research_nodes.get(id)
        }))
    }

    pub fn research_node_content(&self, node_id: &str) -> Result<ResearchNodeContent, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let node = model
            .research_nodes
            .get(node_id)
            .cloned()
            .ok_or_else(|| format!("research node {node_id} was not found"))?;
        let ancestor_prompts = research::ancestor_prompts(&node, |id| model.research_nodes.get(id));
        let turns = node
            .agent_id
            .as_deref()
            .and_then(|agent_id| model.turns.get(agent_id))
            .map(|turns| {
                research::response_turns(
                    turns,
                    node.prompt_native_id.as_deref(),
                    &node.prompt,
                    &ancestor_prompts,
                )
            })
            .unwrap_or_default();
        let mut children = model
            .research_nodes
            .values()
            .filter(|child| child.parent_node_id.as_deref() == Some(node_id))
            .map(|child| ResearchNodeCard {
                id: child.id.clone(),
                prompt: child.prompt.clone(),
                response_preview: child.response_preview.clone(),
                status: child.status,
                created_at: child.created_at,
            })
            .collect::<Vec<_>>();
        children.sort_by_key(|child| (child.created_at, child.id.clone()));
        Ok(ResearchNodeContent {
            node,
            turns,
            children,
            source_error: None,
            response_revision: None,
        })
    }

    /// A caller-provided title, trimmed, or the fallback when absent or
    /// blank. One owner for the idiom every research creator shares.
    pub(super) fn resolved_research_title(
        provided: Option<String>,
        fallback: impl FnOnce() -> String,
    ) -> String {
        provided
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(fallback)
    }

    /// Admits a new root research tree under the model lock: resolves the run
    /// directory from the durable workspace record (never from the caller),
    /// requires Research scope, and inserts the tree at the top of the
    /// sidebar order. Shared by every root creator — runs, documents, and
    /// conversation exports — so admission semantics cannot drift between
    /// them. Persisting and eventing stay with the caller, which may have a
    /// snapshot to reclaim on failure first.
    pub(super) fn admit_research_root(
        &self,
        tree: &ResearchTree,
        node: &mut ResearchNode,
    ) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let workspace = model
            .groups
            .get(&node.group_id)
            .ok_or_else(|| format!("research workspace {} was not found", node.group_id))?;
        if workspace.scope != WorkspaceScope::Research {
            return Err("research requires a Research-scoped workspace".to_string());
        }
        node.worktree_dir = workspace.dir.clone();
        model.research_tree_order.retain(|id| id != &tree.id);
        model.research_tree_order.insert(0, tree.id.clone());
        model.research_trees.insert(tree.id.clone(), tree.clone());
        model.research_nodes.insert(node.id.clone(), node.clone());
        Ok(())
    }

    pub fn create_research_tree(
        &self,
        request: CreateResearchTreeRequest,
    ) -> Result<ResearchTreeDetail, String> {
        let prompt = request.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("research prompt cannot be empty".to_string());
        }
        if request.adapter.trim().is_empty() {
            return Err("research adapter cannot be empty".to_string());
        }
        if !crate::adapters::adapter_supports_research(&self.inner.config, &request.adapter) {
            return Err(format!(
                "'{}' is not a supported research agent",
                request.adapter
            ));
        }
        if request.group_id.trim().is_empty() {
            return Err("research workspace cannot be empty".to_string());
        }
        let tree_id = self.next_id("research");
        let node_id = self.next_id("research-node");
        let now = now_millis();
        let title =
            Self::resolved_research_title(request.title, || research::default_title(&prompt));
        let tree = ResearchTree {
            id: tree_id.clone(),
            title,
            root_node_id: node_id.clone(),
            workspace_id: request.group_id.clone(),
            created_at: now,
            updated_at: now,
            archived_at: None,
            last_viewed_at: Some(now),
        };
        let mut node = ResearchNode {
            id: node_id.clone(),
            tree_id: tree_id.clone(),
            parent_node_id: None,
            publication_proposal: None,
            query_anchor: None,
            inline: false,
            prompt,
            title: None,
            response_preview: None,
            adapter: request.adapter,
            model: request.model,
            effort: request.effort,
            group_id: request.group_id,
            worktree_dir: String::new(),
            native_session_id: None,
            transcript_path: None,
            prompt_native_id: None,
            agent_id: None,
            pane_id: None,
            runtime: crate::research::ResearchRuntime::Pane,
            thread_id: None,
            kind: ResearchNodeKind::Run,
            origin: None,
            status: ResearchNodeStatus::Queued,
            error: None,
            response_snapshot_at: None,
            created_at: now,
            started_at: None,
            completed_at: None,
            highlights: Vec::new(),
        };
        self.admit_research_root(&tree, &mut node)?;
        self.persist();
        self.emit(QmuxEvent::new(
            "research.tree.created",
            None,
            None,
            json!({ "tree": tree, "node": node }),
        ));
        self.research_tree(&tree_id)
    }

    /// Creates a document as a single-node research tree: the root node is the
    /// document, its markdown persisted through the same response-snapshot
    /// pipeline as run responses. Nothing launches — the node is born
    /// `Complete` with its snapshot already durable, so viewers, archives, and
    /// pruning treat it exactly like a settled run. The caller must hold the
    /// research workspace-mutation guard, matching `create_research_tree`.
    pub fn create_research_document(
        &self,
        request: CreateResearchDocumentRequest,
    ) -> Result<ResearchTreeDetail, String> {
        let markdown = request.markdown.trim().to_string();
        research::validate_document_markdown(&markdown)?;
        if request.group_id.trim().is_empty() {
            return Err("research workspace cannot be empty".to_string());
        }
        let title = Self::resolved_research_title(request.title, || {
            research::document_default_title(&markdown)
        });
        let tree_id = self.next_id("research");
        let node_id = self.next_id("research-node");
        let now = now_millis();
        let turns = vec![research::document_turn(&node_id, &markdown)];
        // Durable content lands before the records that point at it: a crash
        // here strands only an orphan snapshot, which prune_response_snapshots
        // reclaims. The reverse order would commit a document whose body never
        // existed. The verified write keeps the records from ever pointing at
        // a snapshot that did not round-trip.
        research::write_response_snapshot_verified(
            &self.inner.config.workspace_root,
            &node_id,
            &turns,
        )?;
        let tree = ResearchTree {
            id: tree_id.clone(),
            title,
            root_node_id: node_id.clone(),
            workspace_id: request.group_id.clone(),
            created_at: now,
            updated_at: now,
            archived_at: None,
            last_viewed_at: Some(now),
        };
        let mut node = ResearchNode {
            id: node_id.clone(),
            tree_id: tree_id.clone(),
            parent_node_id: None,
            publication_proposal: None,
            query_anchor: None,
            inline: false,
            prompt: String::new(),
            title: None,
            response_preview: research::response_preview(&turns, None, "", &[]),
            adapter: String::new(),
            model: None,
            effort: None,
            group_id: request.group_id,
            worktree_dir: String::new(),
            native_session_id: None,
            transcript_path: None,
            prompt_native_id: None,
            agent_id: None,
            pane_id: None,
            runtime: crate::research::ResearchRuntime::Pane,
            thread_id: None,
            kind: ResearchNodeKind::Document,
            origin: None,
            status: ResearchNodeStatus::Complete,
            error: None,
            response_snapshot_at: Some(now),
            created_at: now,
            started_at: None,
            completed_at: Some(now),
            highlights: Vec::new(),
        };
        if let Err(err) = self.admit_research_root(&tree, &mut node) {
            // Nothing references the snapshot yet; reclaim it now rather than
            // waiting for the next structural prune.
            let _ = research::remove_response_snapshot(&self.inner.config.workspace_root, &node_id);
            return Err(err);
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "research.tree.created",
            None,
            None,
            json!({ "tree": tree, "node": node }),
        ));
        self.research_tree(&tree_id)
    }

    /// Stage one of exporting a terminal pane's conversation to research:
    /// read and sanitize the source and make the verified snapshot durable,
    /// all without the research workspace-mutation guard — the transcript
    /// read and snapshot write are the slow parts and need no exclusion
    /// against folder mutations. The terminal is left untouched; this is a
    /// copy, not a move, so repeating the export creates another independent
    /// tree. A prepared export whose commit never happens strands only an
    /// orphan snapshot, which prune_response_snapshots reclaims.
    pub fn prepare_pane_export(
        &self,
        pane_id: &str,
    ) -> Result<research::PreparedPaneExport, String> {
        let agent = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let pane = model
                .panes
                .get(pane_id)
                .ok_or_else(|| format!("pane {pane_id} was not found"))?;
            // Research runs live in Research-scoped groups, and their hidden
            // panes must not round-trip back into a conversation node. The
            // scope check runs under the same lock as the pane lookup, so it
            // also covers the launch-to-bind window in which a research
            // run's node does not yet name its agent.
            let scope = model
                .groups
                .get(&pane.info.group_id)
                .map(|group| group.scope);
            if scope != Some(WorkspaceScope::Terminal) {
                return Err("only terminal panes can be exported to research".to_string());
            }
            // A pane owns an agent either by launch (pane.info.agent_id, set
            // when the pane spawned as an agent pane) or by adoption (a
            // shell pane whose `claude`/`codex` process was recovered — only
            // agent.pane_id records that binding). The frontend offers the
            // export for both, so both must resolve here.
            let agent = pane
                .info
                .agent_id
                .as_deref()
                .and_then(|agent_id| model.agents.get(agent_id))
                .or_else(|| {
                    model
                        .agents
                        .values()
                        .find(|agent| agent.pane_id.as_deref() == Some(pane_id))
                })
                .cloned()
                .ok_or_else(|| "only agent panes can be exported to research".to_string())?;
            agent
        };
        // Transcript-preferred source: the file is the complete native
        // record, while the in-memory timeline can be a truncated live view.
        // Only a file that has vanished falls back to that view — read
        // failures, including the too-large-to-snapshot guard, surface
        // instead of silently exporting a partial conversation as complete.
        let (mut source_turns, source_stable) = match agent.transcript_path.as_deref() {
            Some(path) if std::path::Path::new(path).exists() => {
                self.transcript_turns_with_stability(&agent, path)?
            }
            _ => {
                let model = self
                    .inner
                    .model
                    .lock()
                    .map_err(|_| "model lock poisoned".to_string())?;
                (
                    model.turns.get(&agent.id).cloned().unwrap_or_default(),
                    true,
                )
            }
        };
        // The busy check runs after the (slow) source read so the status is
        // as fresh as it can be: a stale Running would silently drop a
        // delivered final exchange, a stale settled status would export a
        // half-streamed one.
        let status = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            model
                .agents
                .get(&agent.id)
                .map(|agent| agent.status)
                .ok_or_else(|| "the pane closed while the export was running".to_string())?
        };
        if status.is_at_rest() {
            // An at-rest agent's transcript must parse identically twice —
            // the adapter may still be flushing its final records (the same
            // reason snapshot_research_response demands a stable read).
            if !source_stable {
                return Err(
                    "the conversation is still being written; try the export again in a moment"
                        .to_string(),
                );
            }
        } else {
            // A busy agent's in-flight exchange is half-streamed and must not
            // persist as delivered content; instability in the trailing
            // records is cut away with it.
            match research::completed_exchange_boundary(&source_turns) {
                Some(0) => {
                    return Err(
                        "the conversation's only exchange is still in progress; wait for the answer to finish before exporting"
                            .to_string(),
                    );
                }
                Some(boundary) => source_turns.truncate(boundary),
                None => {}
            }
        }
        let tree_id = self.next_id("research");
        let node_id = self.next_id("research-node");
        let turns = research::conversation_export_turns(&node_id, &source_turns)?;
        drop(source_turns);
        let prompt = research::conversation_prompt(&turns);
        let response_preview = research::conversation_preview(&turns);
        // Durable content lands before the records that point at it, same as
        // create_research_document; the verified write keeps the records from
        // ever pointing at a snapshot that did not round-trip.
        research::write_response_snapshot_verified(
            &self.inner.config.workspace_root,
            &node_id,
            &turns,
        )?;
        Ok(research::PreparedPaneExport {
            tree_id,
            node_id,
            prompt,
            response_preview,
            adapter: agent.adapter,
            model: agent.model,
            effort: agent.effort,
            agent_created_at: agent.created_at,
        })
    }

    /// Reads the transcript until two consecutive parses agree, reporting
    /// whether they did. Bounded: a source that keeps changing (a streaming
    /// agent) comes back unstable rather than looping, and the caller
    /// decides — an at-rest agent must retry, a busy one truncates the
    /// unstable tail with the in-flight exchange.
    pub(super) fn transcript_turns_with_stability(
        &self,
        agent: &AgentInfo,
        path: &str,
    ) -> Result<(Vec<Turn>, bool), String> {
        let mut previous =
            research::load_transcript_turns(&self.inner.config, &agent.adapter, &agent.id, path)?;
        for _ in 0..3 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let current = research::load_transcript_turns(
                &self.inner.config,
                &agent.adapter,
                &agent.id,
                path,
            )?;
            if current == previous {
                return Ok((current, true));
            }
            previous = current;
        }
        Ok((previous, false))
    }

    /// Stage two: admits the prepared export as a Complete conversation tree.
    /// The caller must hold the research workspace-mutation guard, matching
    /// `create_research_document`. On admission failure the prepared snapshot
    /// is reclaimed.
    pub fn commit_pane_export(
        &self,
        prepared: &research::PreparedPaneExport,
        group_id: String,
        title: Option<String>,
    ) -> Result<ResearchTreeDetail, String> {
        if group_id.trim().is_empty() {
            self.discard_pane_export(prepared);
            return Err("research workspace cannot be empty".to_string());
        }
        let now = now_millis();
        let title =
            Self::resolved_research_title(title, || research::default_title(&prepared.prompt));
        let tree = ResearchTree {
            id: prepared.tree_id.clone(),
            title,
            root_node_id: prepared.node_id.clone(),
            workspace_id: group_id.clone(),
            created_at: now,
            updated_at: now,
            archived_at: None,
            last_viewed_at: Some(now),
        };
        let mut node = ResearchNode {
            id: prepared.node_id.clone(),
            tree_id: prepared.tree_id.clone(),
            parent_node_id: None,
            publication_proposal: None,
            query_anchor: None,
            inline: false,
            prompt: prepared.prompt.clone(),
            title: None,
            response_preview: prepared.response_preview.clone(),
            adapter: prepared.adapter.clone(),
            model: prepared.model.clone(),
            effort: prepared.effort.clone(),
            group_id,
            worktree_dir: String::new(),
            native_session_id: None,
            transcript_path: None,
            prompt_native_id: None,
            agent_id: None,
            pane_id: None,
            runtime: crate::research::ResearchRuntime::Pane,
            thread_id: None,
            kind: ResearchNodeKind::Conversation,
            origin: Some(ResearchNodeOrigin::TerminalExport),
            status: ResearchNodeStatus::Complete,
            error: None,
            response_snapshot_at: Some(now),
            created_at: now,
            started_at: Some(prepared.agent_created_at.min(now)),
            completed_at: Some(now),
            highlights: Vec::new(),
        };
        if let Err(err) = self.admit_research_root(&tree, &mut node) {
            self.discard_pane_export(prepared);
            return Err(err);
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "research.tree.created",
            None,
            None,
            json!({ "tree": tree, "node": node }),
        ));
        self.research_tree(&tree.id)
    }

    /// Reclaims a prepared export whose records never committed (validation
    /// or admission failed after the snapshot landed).
    pub fn discard_pane_export(&self, prepared: &research::PreparedPaneExport) {
        let _ = research::remove_response_snapshot(
            &self.inner.config.workspace_root,
            &prepared.node_id,
        );
    }

    /// Replaces a root document's durable Markdown in place. Existing child
    /// runs are intentionally untouched: their agents already received a copy
    /// of the document in their launch prompt. A body replacement invalidates
    /// every highlight on this node because anchors are revision-bound; a
    /// title-only edit preserves both the snapshot and its highlights.
    pub fn update_research_document(
        &self,
        request: UpdateResearchDocumentRequest,
    ) -> Result<UpdateResearchDocumentResult, String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let markdown = request.markdown.trim().to_string();
        research::validate_document_markdown(&markdown)?;

        let (current_node, current_tree) = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get(&request.node_id)
                .cloned()
                .ok_or_else(|| format!("research node {} was not found", request.node_id))?;
            let tree = model
                .research_trees
                .get(&node.tree_id)
                .cloned()
                .ok_or_else(|| format!("research tree {} was not found", node.tree_id))?;
            (node, tree)
        };
        if current_node.kind != ResearchNodeKind::Document
            || current_node.parent_node_id.is_some()
            || current_tree.root_node_id != current_node.id
        {
            return Err("only root research documents can be edited".to_string());
        }
        if current_tree.archived_at.is_some() {
            return Err("restore archived research before editing its document".to_string());
        }
        if current_tree.title != request.expected_title {
            return Err(
                "the document title changed while you were editing; reopen the editor and try again"
                    .to_string(),
            );
        }

        let current_snapshot = research::read_response_snapshot_with_revision(
            &self.inner.config.workspace_root,
            &current_node.id,
        )?
        .ok_or_else(|| "the document's content is unavailable".to_string())?;
        if current_snapshot.revision != request.expected_response_revision {
            return Err(
                "the document changed while you were editing; reopen the editor and try again"
                    .to_string(),
            );
        }
        let current_markdown = research::document_markdown_from_turns(&current_snapshot.turns)
            .ok_or_else(|| "the document's content is unavailable".to_string())?;
        let title = request
            .title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| research::document_default_title(&markdown));
        let markdown_changed = current_markdown != markdown;
        if markdown_changed {
            let expected_highlight_ids = request
                .expected_highlight_ids
                .iter()
                .map(String::as_str)
                .collect::<HashSet<_>>();
            let current_highlight_ids = current_node
                .highlights
                .iter()
                .map(|highlight| highlight.id.as_str())
                .collect::<HashSet<_>>();
            if current_highlight_ids != expected_highlight_ids {
                return Err(
                    "the document's highlights changed while you were editing; reopen the editor and try again"
                        .to_string(),
                );
            }
        }
        let (turns, response_revision) = if markdown_changed {
            let turns = vec![research::document_turn(&current_node.id, &markdown)];
            let revision = research::response_revision(&turns)?;
            // The file commit is atomic. Nothing in the model changes if it
            // fails, so the old document, title, and highlights remain valid.
            research::write_response_snapshot(
                &self.inner.config.workspace_root,
                &current_node.id,
                &turns,
            )?;
            (Some(turns), revision)
        } else {
            (None, current_snapshot.revision)
        };

        let now = now_millis();
        let (tree, node, removed_highlight_count) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get_mut(&current_node.id)
                .ok_or_else(|| format!("research node {} was not found", current_node.id))?;
            let removed = if let Some(turns) = turns.as_deref() {
                let removed = node.highlights.len();
                node.highlights.clear();
                node.response_preview = research::response_preview(turns, None, "", &[]);
                node.response_snapshot_at = Some(
                    node.response_snapshot_at
                        .map_or(now, |previous| now.max(previous.saturating_add(1))),
                );
                removed
            } else {
                0
            };
            let node = node.clone();
            let tree = model
                .research_trees
                .get_mut(&current_tree.id)
                .ok_or_else(|| format!("research tree {} was not found", current_tree.id))?;
            tree.title = title;
            tree.updated_at = now.max(tree.updated_at.saturating_add(1));
            (tree.clone(), node, removed)
        };
        // The response snapshot above is already durable. Persist its matching
        // title, revision timestamp, and cleared-highlight metadata before the
        // command returns instead of leaving a debounce-sized crash window in
        // which state.json still describes the previous document.
        self.persist_now();
        self.emit(QmuxEvent::new(
            "research.document.updated",
            None,
            None,
            json!({
                "tree": tree,
                "node": node,
                "responseRevision": response_revision,
                "markdownChanged": markdown_changed,
                "removedHighlightCount": removed_highlight_count,
            }),
        ));
        Ok(UpdateResearchDocumentResult {
            tree,
            node,
            response_revision,
            markdown_changed,
            removed_highlight_count,
        })
    }

    /// Captures one coherent document version for a new direct follow-up. The
    /// returned launch prompt owns its Markdown string, so releasing the lock
    /// before the agent spawn cannot let a later edit rewrite that child.
    pub fn research_document_followup_prompt(
        &self,
        node_id: &str,
        question: &str,
    ) -> Result<String, String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let (node, title) = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get(node_id)
                .cloned()
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let tree = model
                .research_trees
                .get(&node.tree_id)
                .ok_or_else(|| format!("research tree {} was not found", node.tree_id))?;
            (node, tree.title.clone())
        };
        if node.kind != ResearchNodeKind::Document {
            return Err("the research node is not a document".to_string());
        }
        let turns = research::read_response_snapshot(&self.inner.config.workspace_root, node_id)?
            .ok_or_else(|| "the document's content is unavailable".to_string())?;
        let markdown = research::document_markdown_from_turns(&turns)
            .ok_or_else(|| "the document's content is unavailable".to_string())?;
        research::document_followup_prompt(&title, markdown, question)
    }

    /// The launch prompt for a follow-up on an exported conversation: the
    /// serialized conversation rides along as context, since exports are
    /// severed from their source session and there is nothing to fork.
    /// Conversation snapshots are immutable, so unlike documents no editor
    /// lock is needed to capture a coherent version.
    ///
    /// A targeted ask's quoted passage is wrapped around `prompt` here rather
    /// than by the caller: the passage is conversation content, so it must
    /// carry the same tag neutralization as the serialized turns it travels
    /// with, and keeping that choice next to the serializer is what stops a
    /// caller from reaching for the verbatim [`research::query_followup_prompt`]
    /// the other node kinds use.
    pub fn research_conversation_followup_prompt(
        &self,
        node_id: &str,
        prompt: &str,
        query_anchor: Option<&ResearchHighlightAnchor>,
    ) -> Result<String, String> {
        let (node, title) = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get(node_id)
                .cloned()
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let tree = model
                .research_trees
                .get(&node.tree_id)
                .ok_or_else(|| format!("research tree {} was not found", node.tree_id))?;
            (node, tree.title.clone())
        };
        if node.kind != ResearchNodeKind::Conversation {
            return Err("the research node is not an exported conversation".to_string());
        }
        let turns = research::read_response_snapshot(&self.inner.config.workspace_root, node_id)?
            .ok_or_else(|| "the conversation's content is unavailable".to_string())?;
        let question = match query_anchor {
            Some(anchor) => research::conversation_query_followup_prompt(&anchor.exact, prompt),
            None => prompt.to_string(),
        };
        research::conversation_followup_prompt(&title, &turns, &question)
    }

    pub fn create_research_child(
        &self,
        parent_node_id: &str,
        prompt: String,
        query_anchor: Option<ResearchHighlightAnchor>,
        inline: bool,
    ) -> Result<ResearchNode, String> {
        if let Some(anchor) = &query_anchor {
            research::validate_highlight_anchor(anchor)?;
        }
        self.create_research_child_with_options(parent_node_id, prompt, None, query_anchor, inline)
    }

    pub fn create_research_child_for_proposal(
        &self,
        parent_node_id: &str,
        prompt: String,
        proposal: ResearchPublicationProposal,
    ) -> Result<ResearchNode, String> {
        if !(8..=128).contains(&proposal.publication_id.len())
            || !proposal
                .publication_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || proposal.comment_id == 0
        {
            return Err("publication proposal reference is invalid".to_string());
        }
        // Accepted community proposals are always branches: an inline slot is
        // the owner's conversation to continue, not a contribution target.
        self.create_research_child_with_options(parent_node_id, prompt, Some(proposal), None, false)
    }

    pub(super) fn create_research_child_with_options(
        &self,
        parent_node_id: &str,
        prompt: String,
        publication_proposal: Option<ResearchPublicationProposal>,
        query_anchor: Option<ResearchHighlightAnchor>,
        inline: bool,
    ) -> Result<ResearchNode, String> {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("research prompt cannot be empty".to_string());
        }
        let node_id = self.next_id("research-node");
        let now = now_millis();
        let node = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let parent = model
                .research_nodes
                .get(parent_node_id)
                .cloned()
                .ok_or_else(|| format!("research node {parent_node_id} was not found"))?;
            let tree = model
                .research_trees
                .get(&parent.tree_id)
                .cloned()
                .ok_or_else(|| format!("research tree {} was not found", parent.tree_id))?;
            if tree.archived_at.is_some() {
                return Err("restore archived research before creating a follow-up".to_string());
            }
            if parent.status != ResearchNodeStatus::Complete {
                return Err("research follow-ups require a completed parent response".to_string());
            }
            // One inline follow-up per answer, whatever its status — a failed
            // or cancelled continuation stays visible in the thread until it
            // is deliberately removed, which reopens the slot. Checked inside
            // the model lock so two concurrent submissions cannot both pass.
            if inline
                && model.research_nodes.values().any(|node| {
                    node.parent_node_id.as_deref() == Some(parent_node_id) && node.inline
                })
            {
                return Err("this answer already has an inline follow-up".to_string());
            }
            // A document has no session to fork — its follow-ups launch fresh
            // runs on the default adapter, so only run parents need the
            // checkpoint (and only they carry an adapter to inherit).
            let (adapter, parent_model, parent_effort) = match parent.kind {
                ResearchNodeKind::Document => (
                    crate::adapters::default_fork_adapter(&self.inner.config)?,
                    None,
                    None,
                ),
                // An exported conversation is severed from its session by
                // design, so its follow-ups also launch fresh runs, with
                // the serialized conversation as context. The source
                // terminal's adapter carries over when it can fork —
                // children are run nodes whose own follow-ups branch —
                // else the default fork-capable adapter takes over.
                ResearchNodeKind::Conversation => {
                    // An anchored quote is admitted here; the launch path sends
                    // it through `conversation_query_followup_prompt` so it
                    // carries the same tag neutralization as the serialized
                    // turns it travels with.
                    if crate::adapters::adapter_supports_research(
                        &self.inner.config,
                        &parent.adapter,
                    ) {
                        (parent.adapter, parent.model, parent.effort)
                    } else {
                        (
                            crate::adapters::default_fork_adapter(&self.inner.config)?,
                            None,
                            None,
                        )
                    }
                }
                ResearchNodeKind::Run => {
                    if parent.native_session_id.is_none() {
                        return Err(
                            "research follow-ups require a recorded parent checkpoint".to_string()
                        );
                    }
                    (parent.adapter, parent.model, parent.effort)
                }
            };
            let workspace = model
                .groups
                .get(&tree.workspace_id)
                .ok_or_else(|| format!("research workspace {} was not found", tree.workspace_id))?;
            if workspace.scope != WorkspaceScope::Research {
                return Err("research requires a Research-scoped workspace".to_string());
            }
            let node = ResearchNode {
                id: node_id.clone(),
                tree_id: parent.tree_id.clone(),
                parent_node_id: Some(parent.id),
                publication_proposal,
                query_anchor,
                inline,
                prompt,
                title: None,
                response_preview: None,
                adapter,
                model: parent_model,
                effort: parent_effort,
                group_id: workspace.id.clone(),
                worktree_dir: workspace.dir.clone(),
                native_session_id: None,
                transcript_path: None,
                prompt_native_id: None,
                agent_id: None,
                pane_id: None,
                runtime: crate::research::ResearchRuntime::Pane,
                thread_id: None,
                kind: ResearchNodeKind::Run,
                origin: None,
                status: ResearchNodeStatus::Queued,
                error: None,
                response_snapshot_at: None,
                created_at: now,
                started_at: None,
                completed_at: None,
                highlights: Vec::new(),
            };
            model.research_nodes.insert(node_id, node.clone());
            touch_research_tree_locked(&mut model, &node.tree_id, now);
            node
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.created",
            None,
            None,
            json!({ "node": node }),
        ));
        Ok(node)
    }

    pub fn bind_research_node_run(
        &self,
        node_id: &str,
        agent: &AgentInfo,
        pane_id: &str,
    ) -> Result<ResearchNode, String> {
        let node = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node_snapshot = model
                .research_nodes
                .get(node_id)
                .cloned()
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            // Documents and exported conversations are snapshot-only by
            // contract — a conversation in particular is severed from its
            // source session, and binding a live agent here would hand the
            // shared read paths live-looking pointers the kind promises it
            // does not have.
            if node_snapshot.kind != ResearchNodeKind::Run {
                return Err(format!(
                    "research node {node_id} is not a run and cannot bind a live agent"
                ));
            }
            let tree = model
                .research_trees
                .get(&node_snapshot.tree_id)
                .ok_or_else(|| format!("research tree {} was not found", node_snapshot.tree_id))?;
            let workspace = model
                .groups
                .get(&tree.workspace_id)
                .ok_or_else(|| format!("research workspace {} was not found", tree.workspace_id))?;
            if workspace.scope != WorkspaceScope::Research || agent.group_id != workspace.id {
                return Err("research launch did not use the tree's current workspace".to_string());
            }
            // An instantly-exiting process (missing binary, adapter arg error)
            // can EOF and run the whole remove_pane teardown before the launch
            // path gets here. That teardown's research detach found nothing
            // bound — this bind hadn't happened — so binding the dead pane id
            // now would create a run nothing ever settles or unbinds: a
            // phantom "active" node that pins its tree (blocking
            // archive/remove and folder changes) until the user cancels it by
            // hand or restarts. Checked under the same model lock remove_pane
            // takes, so either the pane is still present (and its later detach
            // will observe this binding), or it is gone for good and the run
            // must settle here.
            let pane_exists = model.panes.contains_key(pane_id);
            let has_active_subagents = model
                .agent_active_subagents
                .get(&agent.id)
                .is_some_and(|active| !active.is_empty());
            let node = model
                .research_nodes
                .get_mut(node_id)
                .expect("research node was checked above");
            node.agent_id = Some(agent.id.clone());
            // Recorded whether or not the pane survived: the run's agent
            // minted its thread record during launch either way, and tree
            // removal reaps that record through this link.
            node.thread_id = agent.thread_id.clone();
            node.native_session_id = agent.session_id.clone();
            node.transcript_path = agent.transcript_path.clone();
            let now = now_millis();
            node.started_at.get_or_insert(now);
            if pane_exists {
                node.pane_id = Some(pane_id.to_string());
                // Launch and cancellation race: the user can settle a Queued node
                // while its spawn is still in flight. Binding must still record the
                // pane and agent — the caller reclaims them — but a settled outcome
                // is monotonic and the bind must not resurrect the run.
                if !node.status.is_terminal() {
                    node.status = research_status_for_agent(agent.status, has_active_subagents);
                    node.error = None;
                    if node.status.is_terminal() {
                        node.completed_at.get_or_insert(now);
                    }
                }
            } else if node.status.is_active() {
                // Mirror detach_research_pane's settle for the teardown that
                // already ran: the agent snapshot was captured after the spawn,
                // so Done/Idle means the run finished before its pane closed.
                if matches!(agent.status, AgentStatus::Done | AgentStatus::Idle)
                    && !has_active_subagents
                {
                    node.status = ResearchNodeStatus::Complete;
                } else {
                    node.status = ResearchNodeStatus::Failed;
                    node.error = Some("Research process exited before completion".to_string());
                }
                node.completed_at = Some(now);
            }
            let node = node.clone();
            touch_research_tree_locked(&mut model, &node.tree_id, now);
            node
        };
        if let Ok(mut completion_sound) = self.inner.completion_sound.lock() {
            completion_sound.mark_research_agent(&agent.id);
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.updated",
            Some(pane_id.to_string()),
            Some(agent.id.clone()),
            json!({ "node": node }),
        ));
        self.maybe_schedule_research_retirement(&node);
        Ok(node)
    }

    pub fn bind_research_node_harness(
        &self,
        node_id: &str,
        agent: &AgentInfo,
    ) -> Result<ResearchNode, String> {
        let node = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node_snapshot = model
                .research_nodes
                .get(node_id)
                .cloned()
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            if node_snapshot.kind != ResearchNodeKind::Run {
                return Err(format!(
                    "research node {node_id} is not a run and cannot bind a live agent"
                ));
            }
            let tree = model
                .research_trees
                .get(&node_snapshot.tree_id)
                .ok_or_else(|| format!("research tree {} was not found", node_snapshot.tree_id))?;
            let workspace = model
                .groups
                .get(&tree.workspace_id)
                .ok_or_else(|| format!("research workspace {} was not found", tree.workspace_id))?;
            if workspace.scope != WorkspaceScope::Research || agent.group_id != workspace.id {
                return Err("research launch did not use the tree's current workspace".to_string());
            }
            let now = now_millis();
            let node = model
                .research_nodes
                .get_mut(node_id)
                .expect("research node was checked above");
            node.agent_id = Some(agent.id.clone());
            node.thread_id = agent.thread_id.clone();
            node.native_session_id = agent.session_id.clone();
            node.transcript_path = agent.transcript_path.clone();
            node.pane_id = None;
            node.runtime = ResearchRuntime::Sdk;
            node.started_at.get_or_insert(now);
            if !node.status.is_terminal() {
                node.status = ResearchNodeStatus::Starting;
                node.error = None;
            }
            let node = node.clone();
            touch_research_tree_locked(&mut model, &node.tree_id, now);
            node
        };
        if let Ok(mut completion_sound) = self.inner.completion_sound.lock() {
            completion_sound.mark_research_agent(&agent.id);
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.updated",
            None,
            Some(agent.id.clone()),
            json!({ "node": node }),
        ));
        self.emit(QmuxEvent::new(
            "agent.updated",
            None,
            Some(agent.id.clone()),
            json!({ "agent": agent }),
        ));
        Ok(node)
    }

    pub fn append_harness_turn(&self, turn: Turn) -> Result<(), String> {
        self.append_turn_internal(turn, None).map(|_| ())
    }

    pub fn record_research_sdk_session(
        &self,
        node_id: &str,
        agent_id: &str,
        session_id: Option<String>,
        transcript_path: Option<String>,
    ) -> Result<(), String> {
        let agent = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if let Some(agent) = model.agents.get_mut(agent_id) {
                if let Some(session_id) = session_id.clone() {
                    agent.session_id = Some(session_id);
                }
                if let Some(transcript_path) = transcript_path.clone() {
                    agent.transcript_path = Some(transcript_path);
                }
                if agent.status == AgentStatus::Starting {
                    agent.status = AgentStatus::Running;
                }
            }
            let now = now_millis();
            let tree_id = if let Some(node) = model.research_nodes.get_mut(node_id) {
                if let Some(session_id) = session_id {
                    node.native_session_id = Some(session_id);
                }
                if let Some(transcript_path) = transcript_path {
                    node.transcript_path = Some(transcript_path);
                }
                if !node.status.is_terminal() {
                    node.status = ResearchNodeStatus::Running;
                    node.error = None;
                }
                Some(node.tree_id.clone())
            } else {
                None
            };
            if let Some(tree_id) = tree_id {
                touch_research_tree_locked(&mut model, &tree_id, now);
            }
            model.agents.get(agent_id).cloned()
        };
        self.persist();
        if let Some(agent) = agent {
            self.emit(QmuxEvent::new(
                "agent.updated",
                None,
                Some(agent.id.clone()),
                json!({ "agent": agent }),
            ));
        }
        if let Ok(node) = self.research_node(node_id) {
            self.emit(QmuxEvent::new(
                "research.node.updated",
                None,
                Some(agent_id.to_string()),
                json!({ "node": node }),
            ));
        }
        Ok(())
    }

    pub fn finish_research_sdk_run(
        &self,
        node_id: &str,
        agent_id: &str,
        success: bool,
        error: Option<String>,
    ) -> Result<(), String> {
        let now = now_millis();
        let requested_status = if success {
            ResearchNodeStatus::Complete
        } else if error.is_some() {
            ResearchNodeStatus::Failed
        } else {
            ResearchNodeStatus::Cancelled
        };
        let durable_outcome = self
            .research_node(node_id)
            .ok()
            .filter(|node| node.status.is_terminal())
            .map(|node| research::ResearchRunOutcome {
                status: node.status,
                error: node.error,
                completed_at: node.completed_at.unwrap_or(now),
            })
            .unwrap_or(research::ResearchRunOutcome {
                status: requested_status,
                error,
                completed_at: now,
            });
        let snapshot_error = self
            .snapshot_research_sdk_response(node_id, &durable_outcome)
            .err();
        let effective_success =
            durable_outcome.status == ResearchNodeStatus::Complete && snapshot_error.is_none();
        let effective_error = snapshot_error
            .as_ref()
            .map(|err| format!("research finished, but its response could not be preserved: {err}"))
            .or_else(|| durable_outcome.error.clone());
        let (node, agent) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if let Some(agent) = model.agents.get_mut(agent_id) {
                agent.status = if effective_success {
                    AgentStatus::Done
                } else if effective_error.is_some() {
                    AgentStatus::Failed
                } else {
                    AgentStatus::Idle
                };
            }
            let agent = model.agents.get(agent_id).cloned();
            let tree_id = if let Some(node) = model.research_nodes.get_mut(node_id)
                && !node.status.is_terminal()
            {
                if snapshot_error.is_some() {
                    node.status = ResearchNodeStatus::Failed;
                    node.error = effective_error;
                } else {
                    node.status = durable_outcome.status;
                    node.error = durable_outcome.error.clone();
                }
                node.completed_at
                    .get_or_insert(durable_outcome.completed_at);
                Some(node.tree_id.clone())
            } else {
                None
            };
            if let Some(tree_id) = tree_id {
                touch_research_tree_locked(&mut model, &tree_id, now);
            }
            let node = model.research_nodes.get(node_id).cloned();
            (node, agent)
        };
        self.persist();
        if let Some(agent) = agent {
            self.emit(QmuxEvent::new(
                if effective_success {
                    "agent.done"
                } else {
                    "agent.updated"
                },
                None,
                Some(agent.id.clone()),
                json!({ "agent": agent }),
            ));
        }
        if let Some(node) = node {
            self.emit(QmuxEvent::new(
                "research.node.updated",
                None,
                Some(agent_id.to_string()),
                json!({ "node": node }),
            ));
        }
        if snapshot_error.is_none() {
            self.prune_agent(agent_id);
            Ok(())
        } else {
            // Retain the pane-less agent and its live turns for this process
            // lifetime. Retry can reclaim it once the runtime session is gone.
            Err(snapshot_error.expect("snapshot error was checked above"))
        }
    }

    pub(super) fn snapshot_research_sdk_response(
        &self,
        node_id: &str,
        outcome: &research::ResearchRunOutcome,
    ) -> Result<(), String> {
        let content = self.research_node_content(node_id)?;
        let ancestor_prompts = self
            .research_node_ancestor_prompts(node_id)
            .unwrap_or_default();
        let mut selected_turns = None;
        if content.node.transcript_path.is_some()
            && let Ok(turns) = research::load_transcript_response(
                &self.inner.config,
                &content.node,
                &ancestor_prompts,
            )
            && research::has_active_assistant_turn(&turns)
            && turns.len() >= content.turns.len()
        {
            selected_turns = Some(turns);
        }
        if selected_turns.is_none() && research::has_active_assistant_turn(&content.turns) {
            selected_turns = Some(content.turns.clone());
        }
        if selected_turns.is_none() && outcome.status == ResearchNodeStatus::Complete {
            for delay_ms in [250_u64, 500, 1000] {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                let node = self.research_node(node_id)?;
                if let Ok(turns) =
                    research::load_transcript_response(&self.inner.config, &node, &ancestor_prompts)
                    && research::has_active_assistant_turn(&turns)
                {
                    selected_turns = Some(turns);
                    break;
                }
            }
        }
        let turns = selected_turns.unwrap_or(content.turns);
        research::write_research_run_outcome_snapshot_verified(
            &self.inner.config.workspace_root,
            node_id,
            &turns,
            outcome,
        )?;
        self.mark_research_response_snapshotted(node_id)?;
        Ok(())
    }

    pub fn prune_agent(&self, agent_id: &str) {
        {
            let mut model = match self.inner.model.lock() {
                Ok(model) => model,
                Err(_) => return,
            };
            prune_agent_locked(&mut model, agent_id);
        }
        self.persist();
        // Payload-less agent.updated makes the frontend refetch listAgents()
        // so pane-less SDK agents leave the React array (and the wake lock)
        // after prune. Pane agents already leave via pane.removed.
        self.emit(QmuxEvent::new(
            "agent.updated",
            None,
            Some(agent_id.to_string()),
            json!({}),
        ));
    }

    /// Arms the pre-session watchdog for a just-launched research run. Agent
    /// status is entirely hook-driven, and a CLI blocked on startup UI that
    /// predates its session — a workspace-trust dialog, a login prompt, an
    /// update gate — fires no hooks at all, so the agent would sit `Starting`
    /// forever while the research pane's read-only policy keeps the user from
    /// answering the very prompt it is stuck on. If the agent is still
    /// pre-session after the delay, flag it `AwaitingInput`: the pane's
    /// keyboard unlocks and the node stays live, and the first real hook
    /// moves the status on as usual. Deliberately adapter-agnostic — every
    /// harness wedges the same way here and gets the same recovery.
    pub fn schedule_research_startup_watchdog(&self, agent_id: String) {
        // Long enough that a healthy launch has bound its native session id
        // (SessionStart on a fresh spawn, the first turn's hook payload on a
        // fork); a false flag only unlocks the pane early and heals on the
        // next hook.
        const RESEARCH_STARTUP_WATCHDOG_DELAY_MS: u64 = 10_000;
        let state = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(
                RESEARCH_STARTUP_WATCHDOG_DELAY_MS,
            ));
            match state.flag_stalled_research_startup(&agent_id) {
                Ok(Some(agent)) => {
                    // Mirrors the hook pipeline's event shape (type + attached
                    // agent) so the frontend applies the status surgically.
                    state.emit(QmuxEvent::new(
                        "agent.awaiting_input",
                        agent.pane_id.clone(),
                        Some(agent.id.clone()),
                        json!({ "agent": agent, "source": "research-startup-watchdog" }),
                    ));
                }
                Ok(None) => {}
                Err(err) => {
                    eprintln!("qmux: research startup watchdog for {agent_id} failed: {err}");
                }
            }
        });
    }

    /// The watchdog's check-and-flip. Returns the updated agent when the run
    /// was still pre-session and got flagged `AwaitingInput`; `None` when it
    /// moved on, settled, or lost its pane (exit teardown owns that outcome).
    ///
    /// Pre-session has two observed signatures, so both flag:
    /// - `Starting`: no lifecycle hook has landed at all.
    /// - `Running` with no bound session: Claude fires `UserPromptSubmit`
    ///   for a launch-argument prompt even while startup UI (the
    ///   workspace-trust dialog) still blocks the session, so the status
    ///   promotes while `SessionStart` never delivers a session id. Every
    ///   adapter binds the session id within seconds on a healthy launch
    ///   (forks heal theirs from the first turn's hook payload), so
    ///   session-less `Running` this long after spawn means startup UI is
    ///   blocking — and a rare false flag only unlocks the pane early and
    ///   heals on the next hook.
    ///
    /// The check and the status write share one model lock so a hook racing
    /// this flip cannot have its fresher status stomped back to
    /// `AwaitingInput`.
    pub(crate) fn flag_stalled_research_startup(
        &self,
        agent_id: &str,
    ) -> Result<Option<AgentInfo>, String> {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node_live = model.research_nodes.values().any(|node| {
                node.agent_id.as_deref() == Some(agent_id) && !node.status.is_terminal()
            });
            if !node_live {
                return Ok(None);
            }
            let stalled = model.agents.get(agent_id).is_some_and(|agent| {
                let presession = match agent.status {
                    AgentStatus::Starting => true,
                    AgentStatus::Running => agent.session_id.is_none(),
                    _ => false,
                };
                presession
                    && agent
                        .pane_id
                        .as_deref()
                        .is_some_and(|pane_id| model.panes.contains_key(pane_id))
            });
            if !stalled {
                return Ok(None);
            }
            let agent = model
                .agents
                .get_mut(agent_id)
                .expect("agent was checked above");
            agent.status = AgentStatus::AwaitingInput;
            let updated = agent.clone();
            bump_agent_activity_locked(&mut model, agent_id);
            bump_agent_status_activity_locked(&mut model, agent_id);
            updated
        };
        // No recent-session upsert on purpose: research sessions are excluded
        // from the recents pool, and this is not real agent activity anyway.
        self.sync_research_node_from_agent(&updated)?;
        self.persist();
        Ok(Some(updated))
    }

    pub fn research_workspace_for_node(&self, node_id: &str) -> Result<GroupInfo, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let node = model
            .research_nodes
            .get(node_id)
            .ok_or_else(|| format!("research node {node_id} was not found"))?;
        let tree = model
            .research_trees
            .get(&node.tree_id)
            .ok_or_else(|| format!("research tree {} was not found", node.tree_id))?;
        let workspace = model
            .groups
            .get(&tree.workspace_id)
            .ok_or_else(|| format!("research workspace {} was not found", tree.workspace_id))?;
        if workspace.scope != WorkspaceScope::Research {
            return Err("research requires a Research-scoped workspace".to_string());
        }
        validate_research_workspace_available(workspace)?;
        Ok(workspace.clone())
    }

    pub fn fail_research_node(&self, node_id: &str, error: String) -> Result<ResearchNode, String> {
        let node = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            // Failure settles an active run (and may refine the error on one
            // that already failed), but a Complete or Cancelled outcome the
            // user can already see must not be rewritten by a late launch
            // cleanup racing that settlement.
            if node.status.is_terminal() && node.status != ResearchNodeStatus::Failed {
                return Ok(node.clone());
            }
            let now = now_millis();
            node.status = ResearchNodeStatus::Failed;
            node.error = Some(error);
            node.completed_at = Some(now);
            let node = node.clone();
            touch_research_tree_locked(&mut model, &node.tree_id, now);
            node
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.updated",
            node.pane_id.clone(),
            node.agent_id.clone(),
            json!({ "node": node }),
        ));
        Ok(node)
    }

    /// User-driven cancellation of an active run: settles the node as
    /// `Cancelled` and reclaims its pane. Also reclaims a still-bound pane on
    /// an already-settled node (a kill that failed on a previous cancel), so
    /// a stuck binding cannot pin the tree forever.
    pub fn cancel_research_node(&self, node_id: &str) -> Result<ResearchNode, String> {
        let (node, pane_id, runtime) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let active = node.status.is_active();
            let runtime = node.runtime;
            if !active && node.pane_id.is_none() {
                let sdk_still_stopping = runtime == ResearchRuntime::Sdk
                    && crate::research_runtime::session_registered(node_id);
                if !sdk_still_stopping {
                    return Err("research run is not active".to_string());
                }
            }
            if active {
                node.status = ResearchNodeStatus::Cancelled;
                node.error = None;
                node.completed_at = Some(now_millis());
            }
            let pane_id = node.pane_id.clone();
            let node = node.clone();
            touch_research_tree_locked(&mut model, &node.tree_id, now_millis());
            (node, pane_id, runtime)
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.updated",
            node.pane_id.clone(),
            node.agent_id.clone(),
            json!({ "node": node }),
        ));
        if runtime == ResearchRuntime::Sdk {
            crate::research_runtime::interrupt_session(&node.id);
        }
        if let Some(pane_id) = pane_id {
            // The pane detach path clears the binding; a Cancelled node is
            // already settled, so detach leaves its status alone.
            if let Err(err) = crate::pty::kill_pane(self, pane_id.clone()) {
                if self.pane_exists(&pane_id).unwrap_or(false) {
                    // Keep the Cancelled outcome monotonic, but report the partial
                    // failure. The UI keeps cancellation available while pane_id
                    // remains bound, so the user can retry instead of leaving an
                    // invisible process that pins the tree until restart.
                    return Err(format!(
                        "research was cancelled, but its terminal could not be closed: {err}"
                    ));
                }
                // The pane record no longer exists, so no EOF/teardown is left
                // to run the detach for us. Clear the binding here — this is
                // the reclaim path the doc comment above promises — or the
                // settled node keeps counting as an active run (blocking
                // archive/remove and folder changes) until restart.
                if let Err(err) = self.detach_research_pane(&pane_id) {
                    eprintln!("qmux: failed to detach research pane {pane_id}: {err}");
                }
            }
        }
        self.research_node(node_id)
    }

    /// Resets a settled (Failed or Cancelled) run back to `Queued` in place —
    /// same node id, same launch inputs — so the retry command can relaunch it
    /// through the ordinary launch machinery.
    ///
    /// The reset must happen before the relaunch, not after: terminal statuses
    /// are monotonic, so `bind_research_node_run` and
    /// `sync_research_node_from_agent` refuse to write a fresh run's status
    /// over a Failed/Cancelled node, and `maybe_schedule_research_retirement`
    /// retires the pane of any Failed node it sees. A relaunch without this
    /// reset would therefore bind a pane the node's terminal status
    /// immediately orphans.
    pub fn reset_research_node_for_retry(&self, node_id: &str) -> Result<ResearchNode, String> {
        if self
            .research_node(node_id)
            .is_ok_and(|node| node.runtime == ResearchRuntime::Sdk && node.status.is_terminal())
        {
            crate::research_runtime::wait_for_session_stop(
                node_id,
                crate::claude_sdk::INTERRUPT_GRACE + std::time::Duration::from_secs(1),
            );
        }
        let node = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get(node_id)
                .cloned()
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let tree = model
                .research_trees
                .get(&node.tree_id)
                .ok_or_else(|| format!("research tree {} was not found", node.tree_id))?;
            if tree.archived_at.is_some() {
                return Err("restore archived research before retrying a run".to_string());
            }
            if !matches!(
                node.status,
                ResearchNodeStatus::Failed | ResearchNodeStatus::Cancelled
            ) {
                return Err("only failed or cancelled runs can be retried".to_string());
            }
            // A still-bound live pane means the old run's process may still be
            // holding on (a cancel whose kill failed). Mirror the
            // cancellation-needs-retry stance: the user resolves the pane
            // first, so two processes never race to settle one node.
            if let Some(pane_id) = node.pane_id.as_deref() {
                if model.panes.contains_key(pane_id) {
                    return Err(
                        "the previous run still has a terminal open; close the run's terminal first"
                            .to_string(),
                    );
                }
            }
            if crate::research_runtime::session_registered(node_id) {
                return Err("the previous run is still stopping; wait and retry".to_string());
            }
            // A retry must never be allowed to inherit a response or stderr log
            // from the previous attempt. Keep the node terminal if cleanup fails.
            research::remove_response_snapshot(&self.inner.config.workspace_root, node_id)?;
            if let Some(agent_id) = node.agent_id.as_deref()
                && model.agents.contains_key(agent_id)
            {
                if node.runtime == ResearchRuntime::Sdk {
                    prune_agent_locked(&mut model, agent_id);
                } else {
                    return Err("the previous run is still stopping; wait and retry".to_string());
                }
            }
            let now = now_millis();
            let node = model
                .research_nodes
                .get_mut(node_id)
                .expect("research node was checked above");
            node.status = ResearchNodeStatus::Queued;
            node.error = None;
            node.completed_at = None;
            node.started_at = None;
            node.agent_id = None;
            node.pane_id = None;
            node.thread_id = None;
            node.native_session_id = None;
            node.transcript_path = None;
            node.prompt_native_id = None;
            node.response_preview = None;
            node.response_snapshot_at = None;
            node.runtime = ResearchRuntime::Pane;
            let node = node.clone();
            touch_research_tree_locked(&mut model, &node.tree_id, now);
            node
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.updated",
            None,
            None,
            json!({ "node": node }),
        ));
        Ok(node)
    }

    pub fn active_research_node_for_pane(
        &self,
        pane_id: &str,
    ) -> Result<Option<ResearchNode>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model
            .research_nodes
            .values()
            .find(|node| node.pane_id.as_deref() == Some(pane_id) && node.status.is_active())
            .cloned())
    }

    pub fn close_pane_for_user(&self, pane_id: &str) -> Result<(), String> {
        if let Some(node) = self.active_research_node_for_pane(pane_id)? {
            self.cancel_research_node(&node.id).map(|_| ())
        } else {
            crate::pty::kill_pane(self, pane_id.to_string())
        }
    }

    /// Records a native-surface user close before its delegate removes the pane.
    /// The delegate already owns teardown, so this settles only the node and lets
    /// the ordinary remove path clear runtime bindings without rewriting it Failed.
    pub fn settle_research_pane_cancelled(&self, pane_id: &str) -> Result<bool, String> {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node_id = model
                .research_nodes
                .values()
                .find(|node| node.pane_id.as_deref() == Some(pane_id) && node.status.is_active())
                .map(|node| node.id.clone());
            node_id.and_then(|node_id| {
                let now = now_millis();
                let node = model.research_nodes.get_mut(&node_id)?;
                node.status = ResearchNodeStatus::Cancelled;
                node.error = None;
                node.completed_at = Some(now);
                let node = node.clone();
                touch_research_tree_locked(&mut model, &node.tree_id, now);
                Some(node)
            })
        };
        let Some(node) = updated else {
            return Ok(false);
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.updated",
            node.pane_id.clone(),
            node.agent_id.clone(),
            json!({ "node": node }),
        ));
        Ok(true)
    }

    pub fn detach_research_pane(&self, pane_id: &str) -> Result<Option<ResearchNode>, String> {
        self.detach_research_pane_inner(pane_id, None)
    }

    /// `removed_agent` carries the bound agent's id and status as captured by
    /// `remove_pane` before it pruned the record: by the time the detach runs
    /// on the teardown path the agent is already gone from the model (and on
    /// the kept-for-queue path its status has been parked Idle), so reading
    /// the live record here could never see the real end-of-turn status.
    pub(super) fn detach_research_pane_inner(
        &self,
        pane_id: &str,
        removed_agent: Option<(&str, AgentStatus, bool)>,
    ) -> Result<Option<ResearchNode>, String> {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node_id = model
                .research_nodes
                .values()
                .find(|node| node.pane_id.as_deref() == Some(pane_id))
                .map(|node| node.id.clone());
            node_id.and_then(|node_id| {
                let now = now_millis();
                // An adapter whose process exits the moment its turn ends can
                // race its own Done notification: the pane teardown lands here
                // while the node is still nominally active. If the agent has
                // already reported end-of-turn, the run *finished* — settling
                // it Failed would brand a delivered answer, and monotonic
                // terminal statuses would keep it branded forever.
                let agent_finished = model
                    .research_nodes
                    .get(&node_id)
                    .and_then(|node| node.agent_id.as_deref())
                    .and_then(|agent_id| {
                        removed_agent
                            .filter(|(removed_id, _, _)| *removed_id == agent_id)
                            .map(|(_, status, active)| (status, active))
                            .or_else(|| {
                                model.agents.get(agent_id).map(|agent| {
                                    let active = model
                                        .agent_active_subagents
                                        .get(agent_id)
                                        .is_some_and(|active| !active.is_empty());
                                    (agent.status, active)
                                })
                            })
                    })
                    .is_some_and(|(status, active)| {
                        matches!(status, AgentStatus::Done | AgentStatus::Idle) && !active
                    });
                let node = model.research_nodes.get_mut(&node_id)?;
                node.pane_id = None;
                if node.status.is_active() {
                    if agent_finished {
                        node.status = ResearchNodeStatus::Complete;
                    } else {
                        node.status = ResearchNodeStatus::Failed;
                        node.error = Some("Research process exited before completion".to_string());
                    }
                    node.completed_at = Some(now);
                }
                let node = node.clone();
                touch_research_tree_locked(&mut model, &node.tree_id, now);
                Some(node)
            })
        };
        if let Some(node) = &updated {
            self.persist();
            self.emit(QmuxEvent::new(
                "research.node.updated",
                None,
                None,
                json!({ "node": node }),
            ));
        }
        Ok(updated)
    }

    pub fn rename_research_tree(
        &self,
        tree_id: &str,
        title: String,
    ) -> Result<ResearchTree, String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("research title cannot be empty".to_string());
        }
        let tree = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let tree = model
                .research_trees
                .get_mut(tree_id)
                .ok_or_else(|| format!("research tree {tree_id} was not found"))?;
            tree.title = title;
            tree.updated_at = now_millis();
            tree.clone()
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.tree.updated",
            None,
            None,
            json!({ "tree": tree }),
        ));
        Ok(tree)
    }

    pub fn set_research_node_title(
        &self,
        node_id: &str,
        title: String,
    ) -> Result<ResearchNode, String> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("research node title cannot be empty".to_string());
        }
        let node = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            node.title = Some(title);
            node.clone()
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.updated",
            None,
            None,
            json!({ "node": node }),
        ));
        Ok(node)
    }

    pub fn create_research_highlight(
        &self,
        node_id: &str,
        anchor: ResearchHighlightAnchor,
    ) -> Result<ResearchHighlight, String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        research::validate_highlight_anchor(&anchor)?;
        self.research_node(node_id)?;
        let snapshot = research::read_response_snapshot_with_revision(
            &self.inner.config.workspace_root,
            node_id,
        )?
        .ok_or_else(|| {
            "research highlights require a durable full response snapshot".to_string()
        })?;
        if snapshot.revision != anchor.response_revision {
            return Err("the research response changed; select the text again".to_string());
        }

        let mut highlight = ResearchHighlight {
            id: self.next_id("research-highlight"),
            anchor,
            created_at: now_millis(),
        };
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let total_bytes = model
                .research_nodes
                .values()
                .flat_map(|node| node.highlights.iter())
                .fold(0usize, |total, highlight| {
                    total.saturating_add(research::highlight_storage_bytes(highlight))
                });
            while model
                .research_nodes
                .values()
                .any(|node| node.highlights.iter().any(|saved| saved.id == highlight.id))
            {
                highlight.id = self.next_id("research-highlight");
            }
            let added_bytes = research::highlight_storage_bytes(&highlight);
            if total_bytes.saturating_add(added_bytes)
                > research::MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL
            {
                return Err("qmux contains too much saved research highlight data".to_string());
            }
            let node = model
                .research_nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let mut next_highlights = node.highlights.clone();
            next_highlights.push(highlight.clone());
            research::validate_highlight_collection(&next_highlights)?;
            node.highlights.push(highlight.clone());
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "research.highlight.created",
            None,
            None,
            json!({ "nodeId": node_id, "highlight": highlight }),
        ));
        Ok(highlight)
    }

    pub fn remove_research_highlight(
        &self,
        node_id: &str,
        highlight_id: &str,
    ) -> Result<ResearchHighlight, String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let removed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let index = node
                .highlights
                .iter()
                .position(|highlight| highlight.id == highlight_id)
                .ok_or_else(|| format!("research highlight {highlight_id} was not found"))?;
            node.highlights.remove(index)
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.highlight.removed",
            None,
            None,
            json!({ "nodeId": node_id, "highlightId": highlight_id }),
        ));
        Ok(removed)
    }

    pub fn remove_research_highlights(
        &self,
        node_id: &str,
        highlight_ids: &[String],
    ) -> Result<Vec<ResearchHighlight>, String> {
        if highlight_ids.len() > research::MAX_RESEARCH_HIGHLIGHTS_PER_NODE {
            return Err(format!(
                "cannot remove more than {} research highlights at once",
                research::MAX_RESEARCH_HIGHLIGHTS_PER_NODE
            ));
        }
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let requested = highlight_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let removed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let mut removed = Vec::new();
            node.highlights.retain(|highlight| {
                if requested.contains(highlight.id.as_str()) {
                    removed.push(highlight.clone());
                    false
                } else {
                    true
                }
            });
            removed
        };
        if removed.is_empty() {
            return Ok(removed);
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "research.highlights.removed",
            None,
            None,
            json!({
                "nodeId": node_id,
                "highlightIds": removed.iter().map(|highlight| &highlight.id).collect::<Vec<_>>(),
            }),
        ));
        Ok(removed)
    }

    pub fn mark_research_tree_viewed(&self, tree_id: &str) -> Result<ResearchTree, String> {
        let (tree, changed) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let latest_settlement = model
                .research_nodes
                .values()
                .filter(|node| node.tree_id == tree_id)
                .filter_map(|node| node.completed_at)
                .max();
            let tree = model
                .research_trees
                .get_mut(tree_id)
                .ok_or_else(|| format!("research tree {tree_id} was not found"))?;
            let changed = latest_settlement.is_some_and(|settled_at| {
                tree.last_viewed_at
                    .is_none_or(|last_viewed_at| settled_at > last_viewed_at)
            });
            if changed {
                let viewed_at = now_millis().max(latest_settlement.unwrap_or_default());
                tree.last_viewed_at = Some(viewed_at);
            }
            (tree.clone(), changed)
        };
        if changed {
            self.persist();
        }
        Ok(tree)
    }

    pub fn archive_research_tree(&self, tree_id: &str) -> Result<ResearchTree, String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let tree = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model
                .research_nodes
                .values()
                .any(|node| node.tree_id == tree_id && research_node_has_live_execution(node))
            {
                return Err("cannot archive research while it has active runs".to_string());
            }
            let tree = model
                .research_trees
                .get_mut(tree_id)
                .ok_or_else(|| format!("research tree {tree_id} was not found"))?;
            if tree.archived_at.is_none() {
                let now = now_millis();
                tree.archived_at = Some(now);
                tree.last_viewed_at = Some(now);
            }
            tree.clone()
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.tree.archived",
            None,
            None,
            json!({ "tree": tree }),
        ));
        Ok(tree)
    }

    pub fn restore_research_tree(&self, tree_id: &str) -> Result<ResearchTree, String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let tree = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let tree = model
                .research_trees
                .get_mut(tree_id)
                .ok_or_else(|| format!("research tree {tree_id} was not found"))?;
            tree.archived_at = None;
            tree.last_viewed_at = Some(now_millis());
            tree.clone()
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.tree.restored",
            None,
            None,
            json!({ "tree": tree }),
        ));
        Ok(tree)
    }

    pub fn remove_research_tree(&self, tree_id: &str) -> Result<(), String> {
        let _document_guard = self
            .inner
            .research_document_lock
            .lock()
            .map_err(|_| "research document lock poisoned".to_string())?;
        let (removed, removed_node_ids, reaped_thread_records) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model
                .research_nodes
                .values()
                .any(|node| node.tree_id == tree_id && research_node_has_live_execution(node))
            {
                return Err("cannot remove a research tree while it has active runs".to_string());
            }
            let stopped_sdk_agents = model
                .research_nodes
                .values()
                .filter(|node| {
                    node.tree_id == tree_id
                        && node.runtime == ResearchRuntime::Sdk
                        && node.pane_id.is_none()
                })
                .filter_map(|node| node.agent_id.clone())
                .collect::<Vec<_>>();
            for agent_id in stopped_sdk_agents {
                prune_agent_locked(&mut model, &agent_id);
            }
            let node_ids = model
                .research_nodes
                .values()
                .filter(|node| node.tree_id == tree_id)
                .map(|node| node.id.clone())
                .collect::<Vec<_>>();
            // Each run minted a thread record (and an on-disk graph snapshot)
            // via the ordinary agent machinery, and nothing else ever reaps
            // them once the run's agent is pruned — deleting the tree is the
            // last point where the node still links run to record. Skip any
            // record a live agent still references (a pane teardown may be
            // settling concurrently); it is re-reaped only if its tree is
            // removed again, so erring towards keeping is safe.
            let thread_ids = model
                .research_nodes
                .values()
                .filter(|node| node.tree_id == tree_id)
                .filter_map(|node| node.thread_id.clone())
                .filter(|thread_id| {
                    !model
                        .agents
                        .values()
                        .any(|agent| agent.thread_id.as_deref() == Some(thread_id))
                })
                .collect::<Vec<_>>();
            let removed = model.research_trees.remove(tree_id).is_some();
            let mut reaped_records = Vec::new();
            if removed {
                model.research_tree_order.retain(|id| id != tree_id);
                // The grouping must not outlive the tree: drop its membership and
                // star, and prune a folder left with no members. Doing it here
                // keeps the persisted grouping clean without the per-refresh prune.
                research::remove_trees_from_research_folders(
                    &mut model.research_folders,
                    &HashSet::from([tree_id.to_string()]),
                );
                model
                    .research_nodes
                    .retain(|_, node| node.tree_id != tree_id);
                for thread_id in &thread_ids {
                    if let Some(record) = model.threads.remove(thread_id) {
                        reaped_records.push(record);
                    }
                    model.thread_focus.remove(thread_id);
                }
            }
            // A research tree references its durable workspace; it does not own
            // it. Other trees may use the same directory, so deleting a tree
            // never deletes the workspace record or anything in that directory.
            (removed, node_ids, reaped_records)
        };
        if !removed {
            return Err(format!("research tree {tree_id} was not found"));
        }
        self.persist();
        self.emit(QmuxEvent::new(
            "research.tree.removed",
            None,
            None,
            json!({ "treeId": tree_id }),
        ));
        for node_id in removed_node_ids {
            if let Err(err) =
                research::remove_response_snapshot(&self.inner.config.workspace_root, &node_id)
            {
                eprintln!("qmux: failed to remove research response {node_id}: {err}");
            }
        }
        // Best-effort: the graph snapshots are unreachable once their records
        // are gone, and a leftover file is only clutter.
        for record in reaped_thread_records {
            let path = std::path::Path::new(&record.snapshot_path);
            if let Err(err) = std::fs::remove_file(path)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!(
                    "qmux: failed to remove research thread graph {}: {err}",
                    record.snapshot_path
                );
            }
        }
        Ok(())
    }

    pub fn remove_research_branch(&self, node_id: &str) -> Result<ResearchBranchRemoval, String> {
        let (removal, removed_node_ids, reaped_thread_records) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let target = model
                .research_nodes
                .get(node_id)
                .cloned()
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let tree = model
                .research_trees
                .get(&target.tree_id)
                .ok_or_else(|| format!("research tree {} was not found", target.tree_id))?;
            if tree.root_node_id == target.id || target.parent_node_id.is_none() {
                return Err(
                    "the root research cannot be deleted as a branch; delete the research instead"
                        .to_string(),
                );
            }

            let mut subtree_ids = HashSet::from([target.id.clone()]);
            loop {
                let descendants = model
                    .research_nodes
                    .values()
                    .filter(|node| {
                        node.tree_id == target.tree_id
                            && node
                                .parent_node_id
                                .as_ref()
                                .is_some_and(|parent_id| subtree_ids.contains(parent_id))
                            && !subtree_ids.contains(&node.id)
                    })
                    .map(|node| node.id.clone())
                    .collect::<Vec<_>>();
                if descendants.is_empty() {
                    break;
                }
                subtree_ids.extend(descendants);
            }

            if model.research_nodes.values().any(|node| {
                subtree_ids.contains(&node.id) && research_node_has_live_execution(node)
            }) {
                return Err("cannot delete a research branch while it has active runs".to_string());
            }

            let stopped_sdk_agents = model
                .research_nodes
                .values()
                .filter(|node| {
                    subtree_ids.contains(&node.id)
                        && node.runtime == ResearchRuntime::Sdk
                        && node.pane_id.is_none()
                })
                .filter_map(|node| node.agent_id.clone())
                .collect::<Vec<_>>();
            for agent_id in stopped_sdk_agents {
                prune_agent_locked(&mut model, &agent_id);
            }

            let thread_ids = model
                .research_nodes
                .values()
                .filter(|node| subtree_ids.contains(&node.id))
                .filter_map(|node| node.thread_id.clone())
                .filter(|thread_id| {
                    !model
                        .agents
                        .values()
                        .any(|agent| agent.thread_id.as_deref() == Some(thread_id))
                })
                .collect::<HashSet<_>>();
            let mut removed_node_ids = subtree_ids.into_iter().collect::<Vec<_>>();
            removed_node_ids.sort_by_key(|id| {
                model
                    .research_nodes
                    .get(id)
                    .map(|node| (node.created_at, node.id.clone()))
            });
            model
                .research_nodes
                .retain(|id, _| !removed_node_ids.contains(id));
            let reaped_thread_records = thread_ids
                .into_iter()
                .filter_map(|thread_id| {
                    model.thread_focus.remove(&thread_id);
                    model.threads.remove(&thread_id)
                })
                .collect::<Vec<_>>();
            touch_research_tree_locked(&mut model, &target.tree_id, now_millis());
            (
                ResearchBranchRemoval {
                    tree_id: target.tree_id,
                    parent_node_id: target.parent_node_id.expect("non-root target has a parent"),
                    removed_node_ids: removed_node_ids.clone(),
                },
                removed_node_ids,
                reaped_thread_records,
            )
        };
        self.persist();
        self.emit(QmuxEvent::new(
            "research.node.removed",
            None,
            None,
            json!({
                "treeId": removal.tree_id,
                "parentNodeId": removal.parent_node_id,
                "removedNodeIds": removal.removed_node_ids,
            }),
        ));
        for node_id in removed_node_ids {
            if let Err(err) =
                research::remove_response_snapshot(&self.inner.config.workspace_root, &node_id)
            {
                eprintln!("qmux: failed to remove research response {node_id}: {err}");
            }
        }
        for record in reaped_thread_records {
            let path = std::path::Path::new(&record.snapshot_path);
            if let Err(err) = std::fs::remove_file(path)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!(
                    "qmux: failed to remove research thread graph {}: {err}",
                    record.snapshot_path
                );
            }
        }
        Ok(removal)
    }

    pub fn group(&self, group_id: &str) -> Result<Option<GroupInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.groups.get(group_id).cloned())
    }

    pub fn research_workspace_dependencies(
        &self,
        workspace_id: &str,
    ) -> Result<ResearchWorkspaceDependencies, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let tree_ids = model
            .research_trees
            .values()
            .filter(|tree| tree.workspace_id == workspace_id)
            .map(|tree| tree.id.as_str())
            .collect::<HashSet<_>>();
        Ok(ResearchWorkspaceDependencies {
            tree_count: tree_ids.len(),
            has_active_runs: model.research_nodes.values().any(|node| {
                tree_ids.contains(node.tree_id.as_str()) && research_node_has_live_execution(node)
            }),
            has_live_panes: model
                .panes
                .values()
                .any(|pane| pane.info.group_id == workspace_id),
        })
    }

    pub fn detached_research_archive(
        &self,
        workspace_id: &str,
    ) -> Result<research::DetachedResearchArchive, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let mut workspace = model
            .groups
            .get(workspace_id)
            .filter(|group| group.scope == WorkspaceScope::Research)
            .cloned()
            .ok_or_else(|| format!("research workspace {workspace_id} was not found"))?;
        // managed_dir is installation-local bookkeeping and is deleted after
        // detach. Runtime agent membership must not cross an import boundary.
        workspace.managed_dir.clear();
        workspace.agents.clear();
        workspace.imported_research_archive_id = None;
        let mut trees = model
            .research_trees
            .values()
            .filter(|tree| tree.workspace_id == workspace_id)
            .cloned()
            .collect::<Vec<_>>();
        trees.sort_by_key(|tree| (tree.created_at, tree.id.clone()));
        let tree_ids = trees
            .iter()
            .map(|tree| tree.id.as_str())
            .collect::<HashSet<_>>();
        let tree_order = ordered_research_tree_ids(&model)
            .into_iter()
            .filter(|tree_id| tree_ids.contains(tree_id.as_str()))
            .collect::<Vec<_>>();
        let mut nodes = model
            .research_nodes
            .values()
            .filter(|node| tree_ids.contains(node.tree_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        nodes.sort_by_key(|node| (node.created_at, node.id.clone()));
        // Carry the grouping for this workspace's trees so an import restores the
        // folders too. Scope to this workspace's folders and to membership whose
        // tree actually travels in the archive; stars/collapsed are per-install
        // view state and stay behind.
        let mut folders = model
            .research_folders
            .folders
            .iter()
            .filter(|folder| folder.workspace_id == workspace_id)
            .cloned()
            .collect::<Vec<_>>();
        folders.sort_by(|left, right| left.id.cmp(&right.id));
        let folder_ids = folders
            .iter()
            .map(|folder| folder.id.as_str())
            .collect::<HashSet<_>>();
        let membership = model
            .research_folders
            .membership
            .iter()
            .filter(|(tree_id, folder_id)| {
                tree_ids.contains(tree_id.as_str()) && folder_ids.contains(folder_id.as_str())
            })
            .map(|(tree_id, folder_id)| (tree_id.clone(), folder_id.clone()))
            .collect::<HashMap<_, _>>();
        Ok(research::DetachedResearchArchive {
            version: research::detached_archive_version(&nodes),
            archive_id: research::new_detached_research_archive_id()?,
            workspace,
            trees,
            tree_order,
            folders,
            membership,
            nodes,
            exported_at: now_millis(),
        })
    }

    /// Removes a Research workspace and all of its durable records after its
    /// portable archive has been verified. The checked persistence barrier is
    /// the commit point: on failure the in-memory records are restored and the
    /// caller leaves the pending folder archive in place for a safe retry.
    pub fn commit_research_workspace_detach(
        &self,
        workspace_id: &str,
        expected: &research::DetachedResearchArchive,
    ) -> Result<Vec<String>, String> {
        let _persist_guard = self
            .inner
            .persist_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (
            workspace,
            trees,
            nodes,
            group_order,
            research_tree_order,
            research_folders,
            recent_sessions,
            reaped_thread_records,
        ) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model
                .panes
                .values()
                .any(|pane| pane.info.group_id == workspace_id)
            {
                return Err("research folder still has live terminals".to_string());
            }
            let workspace = model
                .groups
                .get(workspace_id)
                .filter(|group| group.scope == WorkspaceScope::Research)
                .cloned()
                .ok_or_else(|| format!("research workspace {workspace_id} was not found"))?;
            let tree_ids = model
                .research_trees
                .values()
                .filter(|tree| tree.workspace_id == workspace_id)
                .map(|tree| tree.id.clone())
                .collect::<HashSet<_>>();
            let active = model.research_nodes.values().any(|node| {
                tree_ids.contains(&node.tree_id) && research_node_has_live_execution(node)
            });
            if active {
                return Err("research folder still has active runs".to_string());
            }
            if model
                .agents
                .values()
                .any(|agent| agent.group_id == workspace_id)
            {
                return Err("research folder still has a live agent record".to_string());
            }
            let mut current_workspace = workspace.clone();
            current_workspace.managed_dir.clear();
            current_workspace.agents.clear();
            current_workspace.imported_research_archive_id = None;
            let mut current_trees = tree_ids
                .iter()
                .filter_map(|id| model.research_trees.get(id).cloned())
                .collect::<Vec<_>>();
            current_trees.sort_by_key(|tree| (tree.created_at, tree.id.clone()));
            let current_tree_ids = current_trees
                .iter()
                .map(|tree| tree.id.as_str())
                .collect::<HashSet<_>>();
            let current_tree_order = ordered_research_tree_ids(&model)
                .into_iter()
                .filter(|tree_id| current_tree_ids.contains(tree_id.as_str()))
                .collect::<Vec<_>>();
            let mut current_nodes = model
                .research_nodes
                .values()
                .filter(|node| current_tree_ids.contains(node.tree_id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            current_nodes.sort_by_key(|node| (node.created_at, node.id.clone()));
            if current_workspace != expected.workspace
                || current_trees != expected.trees
                || (!expected.tree_order.is_empty() && current_tree_order != expected.tree_order)
                || current_nodes != expected.nodes
            {
                return Err(
                    "research changed while its folder archive was being prepared; try removing the folder again"
                        .to_string(),
                );
            }
            let trees = tree_ids
                .iter()
                .filter_map(|id| {
                    model
                        .research_trees
                        .remove(id)
                        .map(|tree| (id.clone(), tree))
                })
                .collect::<Vec<_>>();
            let research_tree_order = model.research_tree_order.clone();
            model
                .research_tree_order
                .retain(|tree_id| !tree_ids.contains(tree_id));
            // The workspace's folders leave with it: scrub its trees' membership
            // and stars, then drop any of its folders that remain (an empty one
            // had no member to carry it out). Snapshot first for the rollback.
            let research_folders = model.research_folders.clone();
            research::remove_trees_from_research_folders(&mut model.research_folders, &tree_ids);
            research::remove_research_workspace_folders(&mut model.research_folders, workspace_id);
            let node_ids = model
                .research_nodes
                .values()
                .filter(|node| tree_ids.contains(&node.tree_id))
                .map(|node| node.id.clone())
                .collect::<HashSet<_>>();
            let nodes = node_ids
                .iter()
                .filter_map(|id| {
                    model
                        .research_nodes
                        .remove(id)
                        .map(|node| (id.clone(), node))
                })
                .collect::<Vec<_>>();
            // Folder detach bypasses remove_research_tree, so reap the same
            // installation-local thread records here before the nodes carrying
            // their ids disappear. Preserve anything a live agent still uses.
            // Keep removed focus entries alongside the records so a failed
            // persistence commit can restore the model exactly.
            let thread_ids = nodes
                .iter()
                .filter_map(|(_, node)| node.thread_id.clone())
                .filter(|thread_id| {
                    !model
                        .agents
                        .values()
                        .any(|agent| agent.thread_id.as_deref() == Some(thread_id))
                })
                .collect::<HashSet<_>>();
            let reaped_thread_records = thread_ids
                .into_iter()
                .map(|thread_id| {
                    let record = model.threads.remove(&thread_id);
                    let focus = model.thread_focus.remove(&thread_id);
                    (thread_id, record, focus)
                })
                .collect::<Vec<_>>();
            let agent_ids = nodes
                .iter()
                .filter_map(|(_, node)| node.agent_id.clone())
                .collect::<HashSet<_>>();
            let session_ids = nodes
                .iter()
                .filter_map(|(_, node)| node.native_session_id.clone())
                .collect::<HashSet<_>>();
            let transcript_paths = nodes
                .iter()
                .filter_map(|(_, node)| node.transcript_path.clone())
                .collect::<HashSet<_>>();
            let recent_sessions = model.recent_sessions.clone();
            model.recent_sessions.retain(|_, session| {
                !session
                    .agent_id
                    .as_ref()
                    .is_some_and(|id| agent_ids.contains(id))
                    && !session
                        .session_id
                        .as_ref()
                        .is_some_and(|id| session_ids.contains(id))
                    && !session
                        .transcript_path
                        .as_ref()
                        .is_some_and(|path| transcript_paths.contains(path))
            });
            let group_order = model.group_order.clone();
            model.groups.remove(workspace_id);
            model.group_order.retain(|id| id != workspace_id);
            (
                workspace,
                trees,
                nodes,
                group_order,
                research_tree_order,
                research_folders,
                recent_sessions,
                reaped_thread_records,
            )
        };

        let persist_result = if self.inner.persist_enabled.load(Ordering::Relaxed) {
            self.persist_snapshot_locked()
        } else {
            Ok(())
        };
        if let Err(err) = persist_result {
            if let Ok(mut model) = self.inner.model.lock() {
                model.groups.insert(workspace.id.clone(), workspace);
                model.group_order = group_order;
                model.research_tree_order = research_tree_order;
                model.research_folders = research_folders;
                for (id, tree) in trees {
                    model.research_trees.insert(id, tree);
                }
                for (id, node) in nodes {
                    model.research_nodes.insert(id, node);
                }
                for (thread_id, record, focus) in reaped_thread_records {
                    if let Some(record) = record {
                        model.threads.insert(thread_id.clone(), record);
                    }
                    if let Some(focus) = focus {
                        model.thread_focus.insert(thread_id, focus);
                    }
                }
                model.recent_sessions = recent_sessions;
            }
            return Err(format!("failed to commit global research detach: {err}"));
        }
        let node_ids = nodes.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        self.emit(QmuxEvent::new(
            "group.removed",
            None,
            None,
            json!({ "groupId": workspace_id }),
        ));
        // Best-effort after the durable commit: the records are unreachable,
        // and a leftover graph file is only disk clutter.
        for (_, record, _) in reaped_thread_records {
            let Some(record) = record else {
                continue;
            };
            let path = std::path::Path::new(&record.snapshot_path);
            if let Err(err) = std::fs::remove_file(path)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!(
                    "qmux: failed to remove detached research thread graph {}: {err}",
                    record.snapshot_path
                );
            }
        }
        Ok(node_ids)
    }

    pub fn import_detached_research(
        &self,
        workspace: GroupInfo,
        tree_order: Vec<String>,
        mut trees: Vec<ResearchTree>,
        folders: Vec<research::ResearchFolder>,
        membership: HashMap<String, String>,
        mut nodes: Vec<ResearchNode>,
        responses: HashMap<String, Vec<Turn>>,
    ) -> Result<GroupInfo, String> {
        // Imported nodes bypass create_research_child's one-inline-child
        // check; repair the slot invariant here so a tampered archive cannot
        // admit a permanently occupied slot the viewer cannot free.
        research::normalize_inline_slots(&mut nodes);
        // Import rewrites response JSON with this build's serializer. Retarget
        // anchors to those exact bytes so a schema-preserving app upgrade does
        // not make otherwise valid portable highlights disappear.
        for node in &mut nodes {
            let Some(turns) = responses.get(&node.id) else {
                continue;
            };
            let revision = research::response_revision(turns)?;
            for highlight in &mut node.highlights {
                highlight.anchor.response_revision = revision.clone();
            }
        }
        let incoming_highlight_bytes = nodes
            .iter()
            .flat_map(|node| node.highlights.iter())
            .fold(0usize, |total, highlight| {
                total.saturating_add(research::highlight_storage_bytes(highlight))
            });
        let (tree_ids_in_use, mut node_ids_in_use, folder_ids_in_use) = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let existing_highlight_bytes = model
                .research_nodes
                .values()
                .flat_map(|node| node.highlights.iter())
                .fold(0usize, |total, highlight| {
                    total.saturating_add(research::highlight_storage_bytes(highlight))
                });
            if existing_highlight_bytes.saturating_add(incoming_highlight_bytes)
                > research::MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL
            {
                return Err(
                    "import would exceed qmux's research highlight storage limit".to_string(),
                );
            }
            (
                model.research_trees.keys().cloned().collect::<HashSet<_>>(),
                model.research_nodes.keys().cloned().collect::<HashSet<_>>(),
                model
                    .research_folders
                    .folders
                    .iter()
                    .map(|folder| folder.id.clone())
                    .collect::<HashSet<_>>(),
            )
        };
        for node in &nodes {
            if !matches!(
                research::read_response_snapshot(&self.inner.config.workspace_root, &node.id),
                Ok(None)
            ) {
                node_ids_in_use.insert(node.id.clone());
            }
        }
        let source_tree_order = if tree_order.is_empty() {
            let mut legacy_order = trees.iter().collect::<Vec<_>>();
            legacy_order.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then(left.id.cmp(&right.id))
            });
            legacy_order
                .into_iter()
                .map(|tree| tree.id.clone())
                .collect::<Vec<_>>()
        } else {
            tree_order
        };
        let mut tree_map = HashMap::new();
        let mut reserved_tree_ids = tree_ids_in_use;
        for tree in &trees {
            let id = if reserved_tree_ids.insert(tree.id.clone()) {
                tree.id.clone()
            } else {
                loop {
                    let candidate = self.next_id("research");
                    if reserved_tree_ids.insert(candidate.clone()) {
                        break candidate;
                    }
                }
            };
            tree_map.insert(tree.id.clone(), id);
        }
        let imported_tree_order = source_tree_order
            .iter()
            .filter_map(|tree_id| tree_map.get(tree_id).cloned())
            .collect::<Vec<_>>();
        // Remap folder ids the same way trees are: keep the archive's id unless
        // it collides with a local folder, then mint a fresh one. Folders are
        // re-homed onto the imported workspace, and membership is retargeted
        // through both id maps. Membership whose tree or folder didn't survive
        // the archive is dropped rather than dangling.
        let mut folder_map = HashMap::new();
        let mut reserved_folder_ids = folder_ids_in_use;
        let mut imported_folders = Vec::with_capacity(folders.len());
        for folder in folders {
            let id = if reserved_folder_ids.insert(folder.id.clone()) {
                folder.id.clone()
            } else {
                loop {
                    let candidate = self.next_id("research-folder");
                    if reserved_folder_ids.insert(candidate.clone()) {
                        break candidate;
                    }
                }
            };
            folder_map.insert(folder.id.clone(), id.clone());
            imported_folders.push(research::ResearchFolder {
                id,
                name: folder.name,
                workspace_id: workspace.id.clone(),
            });
        }
        let imported_membership = membership
            .into_iter()
            .filter_map(|(tree_id, folder_id)| {
                Some((
                    tree_map.get(&tree_id)?.clone(),
                    folder_map.get(&folder_id)?.clone(),
                ))
            })
            .collect::<Vec<_>>();
        let mut node_map = HashMap::new();
        let mut reserved_node_ids = node_ids_in_use;
        for node in &nodes {
            let id = if reserved_node_ids.insert(node.id.clone()) {
                node.id.clone()
            } else {
                loop {
                    let candidate = self.next_id("research-node");
                    if reserved_node_ids.insert(candidate.clone()) {
                        break candidate;
                    }
                }
            };
            node_map.insert(node.id.clone(), id);
        }
        for tree in &mut trees {
            tree.id = tree_map[&tree.id].clone();
            tree.root_node_id = node_map
                .get(&tree.root_node_id)
                .cloned()
                .ok_or_else(|| "research archive root node mapping is incomplete".to_string())?;
            tree.workspace_id = workspace.id.clone();
        }
        for node in &mut nodes {
            let old_id = node.id.clone();
            node.id = node_map[&old_id].clone();
            node.tree_id = tree_map
                .get(&node.tree_id)
                .cloned()
                .ok_or_else(|| "research archive tree mapping is incomplete".to_string())?;
            node.parent_node_id =
                node.parent_node_id
                    .as_ref()
                    .map(|id| {
                        node_map.get(id).cloned().ok_or_else(|| {
                            "research archive parent mapping is incomplete".to_string()
                        })
                    })
                    .transpose()?;
            node.group_id = workspace.id.clone();
            node.worktree_dir = workspace.dir.clone();
            // Runtime bindings never survive a detach/import boundary. Keeping
            // an old agent id could accidentally bind a restored follow-up to
            // an unrelated live agent whose installation-local id collides.
            node.pane_id = None;
            node.agent_id = None;
            node.transcript_path = None;
            // Thread records and their graph snapshots are installation-local
            // and are not part of the portable archive. Retaining a foreign id
            // could make later tree removal delete an unrelated local record
            // whose generated id happens to collide.
            node.thread_id = None;
            // Only responses that actually travelled in the archive get
            // written back below; a node imported without one must not keep
            // a snapshot stamp claiming a durable answer exists.
            if !responses.contains_key(&old_id) {
                node.response_snapshot_at = None;
            }
        }

        let mut written_node_ids = Vec::new();
        let write_result = (|| -> Result<(), String> {
            for (old_id, turns) in responses {
                let Some(new_id) = node_map.get(&old_id) else {
                    continue;
                };
                research::write_response_snapshot(
                    &self.inner.config.workspace_root,
                    new_id,
                    &turns,
                )?;
                written_node_ids.push(new_id.clone());
            }
            Ok(())
        })();
        if let Err(err) = write_result {
            for node_id in written_node_ids {
                let _ =
                    research::remove_response_snapshot(&self.inner.config.workspace_root, &node_id);
            }
            return Err(err);
        }
        let _persist_guard = self
            .inner
            .persist_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let insert_result = (|| -> Result<(), String> {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model.groups.contains_key(&workspace.id) {
                return Err(format!("workspace {} already exists", workspace.id));
            }
            model.group_order.push(workspace.id.clone());
            model.groups.insert(workspace.id.clone(), workspace.clone());
            model
                .research_tree_order
                .extend(imported_tree_order.iter().cloned());
            for tree in &trees {
                model.research_trees.insert(tree.id.clone(), tree.clone());
            }
            for node in &nodes {
                model.research_nodes.insert(node.id.clone(), node.clone());
            }
            model
                .research_folders
                .folders
                .extend(imported_folders.iter().cloned());
            for (tree_id, folder_id) in &imported_membership {
                model
                    .research_folders
                    .membership
                    .insert(tree_id.clone(), folder_id.clone());
            }
            Ok(())
        })();
        if let Err(err) = insert_result {
            for node_id in written_node_ids {
                let _ =
                    research::remove_response_snapshot(&self.inner.config.workspace_root, &node_id);
            }
            return Err(err);
        }
        let persist_result = if self.inner.persist_enabled.load(Ordering::Relaxed) {
            self.persist_snapshot_locked()
        } else {
            Ok(())
        };
        if let Err(err) = persist_result {
            if let Ok(mut model) = self.inner.model.lock() {
                model.groups.remove(&workspace.id);
                model.group_order.retain(|id| id != &workspace.id);
                model
                    .research_tree_order
                    .retain(|id| !imported_tree_order.contains(id));
                let imported_folder_ids = imported_folders
                    .iter()
                    .map(|folder| folder.id.as_str())
                    .collect::<HashSet<_>>();
                model
                    .research_folders
                    .folders
                    .retain(|folder| !imported_folder_ids.contains(folder.id.as_str()));
                for (tree_id, _) in &imported_membership {
                    model.research_folders.membership.remove(tree_id);
                }
                for tree in &trees {
                    model.research_trees.remove(&tree.id);
                }
                for node in &nodes {
                    model.research_nodes.remove(&node.id);
                }
            }
            for node_id in written_node_ids {
                let _ =
                    research::remove_response_snapshot(&self.inner.config.workspace_root, &node_id);
            }
            return Err(format!("failed to commit imported research: {err}"));
        }
        self.emit(QmuxEvent::new(
            "group.created",
            None,
            None,
            json!({ "group": workspace.clone() }),
        ));
        Ok(workspace)
    }

    pub(super) fn sync_research_node_from_agent(&self, agent: &AgentInfo) -> Result<bool, String> {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node_id = model
                .research_nodes
                .values()
                .find(|node| node.agent_id.as_deref() == Some(&agent.id))
                .map(|node| node.id.clone());
            let Some(node_id) = node_id else {
                return Ok(false);
            };
            let (node_prompt, existing_prompt_id) = model
                .research_nodes
                .get(&node_id)
                .map(|node| (node.prompt.clone(), node.prompt_native_id.clone()))
                .expect("node exists");
            let ancestor_prompts = model
                .research_nodes
                .get(&node_id)
                .map(|node| research::ancestor_prompts(node, |id| model.research_nodes.get(id)))
                .unwrap_or_default();
            let (prompt_id, preview) = model.turns.get(&agent.id).map_or((None, None), |turns| {
                let prompt_id = research::prompt_native_id(turns, &node_prompt);
                let preview = research::response_preview(
                    turns,
                    prompt_id.as_deref().or(existing_prompt_id.as_deref()),
                    &node_prompt,
                    &ancestor_prompts,
                );
                (prompt_id, preview)
            });
            let has_active_subagents = model
                .agent_active_subagents
                .get(&agent.id)
                .is_some_and(|active| !active.is_empty());
            let now = now_millis();
            let node = model.research_nodes.get_mut(&node_id).expect("node exists");
            let before = node.clone();
            node.native_session_id = agent.session_id.clone();
            node.transcript_path = agent.transcript_path.clone();
            if agent.thread_id.is_some() {
                node.thread_id = agent.thread_id.clone();
            }
            // A sync is built from an agent snapshot taken under a previously
            // released lock, so it can land after pane teardown already ran
            // detach_research_pane. Rewriting pane_id would re-bind the dead
            // pane to a settled node — a state nothing clears until restart,
            // and one that pins the tree (archive/remove/folder ops treat a
            // bound pane as an active run). Terminal nodes keep whatever
            // binding teardown left them; the checkpoint fields above still
            // flow, since the native session id and transcript path trail the
            // Complete status by design.
            if !node.status.is_terminal() {
                node.pane_id = agent.pane_id.clone();
            }
            if prompt_id.is_some() {
                node.prompt_native_id = prompt_id;
            }
            if preview.is_some() {
                node.response_preview = preview;
            }
            // Hooks and transcript tailing deliver agent events asynchronously,
            // so a generic Running/Idle update can arrive after the run has
            // settled — most visibly after a user cancellation, where rewriting
            // the status would resurrect the run and let the pane teardown
            // re-settle it as Failed. Terminal outcomes stay as written.
            if !node.status.is_terminal() {
                node.status = research_status_for_agent(agent.status, has_active_subagents);
                if node.status.is_terminal() && node.completed_at.is_none() {
                    node.completed_at = Some(now);
                }
            }
            let changed = *node != before;
            // Recency (and with it the sidebar sort) moves only on lifecycle
            // transitions. Preview/session churn arrives several times a
            // second while streaming, and bumping updated_at for each made
            // concurrently-running trees swap positions under the cursor.
            let lifecycle_changed =
                node.status != before.status || node.completed_at != before.completed_at;
            let node = node.clone();
            if lifecycle_changed {
                touch_research_tree_locked(&mut model, &node.tree_id, now);
            }
            changed.then_some(node)
        };
        let changed = updated.is_some();
        if let Some(node) = updated {
            self.maybe_schedule_research_retirement(&node);
            self.emit(QmuxEvent::new(
                "research.node.updated",
                node.pane_id.clone(),
                node.agent_id.clone(),
                json!({ "node": node }),
            ));
        }
        Ok(changed)
    }

    pub(super) fn maybe_schedule_research_retirement(&self, node: &ResearchNode) {
        let Some(pane_id) = node.pane_id.clone() else {
            return;
        };
        if !matches!(
            node.status,
            ResearchNodeStatus::Complete | ResearchNodeStatus::Failed
        ) {
            return;
        }
        if node.status == ResearchNodeStatus::Complete
            && node
                .agent_id
                .as_deref()
                .is_some_and(|agent_id| self.agent_has_active_subagents(agent_id).unwrap_or(false))
        {
            return;
        }
        let scheduled = self
            .inner
            .model
            .lock()
            .map(|mut model| {
                model.panes.contains_key(&pane_id)
                    && model.research_retiring_panes.insert(pane_id.clone())
            })
            .unwrap_or(false);
        if !scheduled {
            return;
        }
        let state = self.clone();
        let node_id = node.id.clone();
        std::thread::spawn(move || {
            let mut last_error = None;
            let mut last_candidate = None;
            for attempt in 0..5_u32 {
                // The first delay lets the adapter flush its final lifecycle record;
                // later delays provide bounded recovery from transient file/process races.
                let delay_ms = 250_u64.saturating_mul(1_u64 << attempt).min(4_000);
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                let current_node = state.research_node(&node_id).ok();
                let still_settled = current_node.as_ref().is_some_and(|node| {
                    matches!(
                        node.status,
                        ResearchNodeStatus::Complete | ResearchNodeStatus::Failed
                    )
                });
                let active_subagents = current_node
                    .as_ref()
                    .filter(|node| node.status == ResearchNodeStatus::Complete)
                    .and_then(|node| node.agent_id.as_deref())
                    .is_some_and(|agent_id| {
                        state.agent_has_active_subagents(agent_id).unwrap_or(false)
                    });
                if !still_settled || active_subagents {
                    if let Ok(mut model) = state.inner.model.lock() {
                        model.research_retiring_panes.remove(&pane_id);
                    }
                    return;
                }
                // Re-read per attempt rather than capturing at schedule time:
                // the native checkpoint (session id / transcript path) usually
                // trails the Complete status by a beat, and a fresh read lets a
                // late checkpoint feed the snapshot. Waiting for it *before*
                // scheduling leaked the hidden pane forever when it never
                // arrived; now the pane retires after the bounded retries and
                // the snapshot falls back to the live turns, so the answer
                // stays viewable even though follow-ups remain blocked.
                let should_snapshot = state
                    .research_node(&node_id)
                    .map(|node| node.status == ResearchNodeStatus::Complete)
                    .unwrap_or(false);
                if should_snapshot {
                    if let Err(err) =
                        state.snapshot_research_response(&node_id, &mut last_candidate)
                    {
                        last_error = Some(format!("snapshot failed: {err}"));
                        // Keep the pane alive while retries remain — the snapshot
                        // wants the live turns — but a deterministic failure (e.g.
                        // a response over the snapshot size cap) would otherwise
                        // skip kill_pane on every attempt and nothing re-triggers
                        // retirement once the flag is cleared. On the last attempt
                        // reclaim the pane anyway; the adapter transcript remains
                        // as the viewing fallback.
                        if attempt < 4 {
                            continue;
                        }
                        eprintln!(
                            "qmux: retiring research pane {pane_id} without a response snapshot: {err}"
                        );
                    }
                }
                match crate::pty::kill_pane(&state, pane_id.clone()) {
                    Ok(()) => {
                        // Automated retirement is not a user close and must not be undoable.
                        state.clear_last_closed_pane_for_pane(&pane_id);
                        return;
                    }
                    Err(err) => {
                        if !state.pane_exists(&pane_id).unwrap_or(true) {
                            return;
                        }
                        last_error = Some(format!("pane close failed: {err}"));
                    }
                }
            }
            eprintln!(
                "qmux: failed to retire settled research pane {pane_id} after retries: {}",
                last_error.unwrap_or_else(|| "unknown error".to_string())
            );
            if let Ok(mut model) = state.inner.model.lock() {
                model.research_retiring_panes.remove(&pane_id);
            }
        });
    }

    /// Writes the node's durable response snapshot once the response is actually
    /// final. The agent reporting Done only means its lifecycle ended — the
    /// adapter may still be flushing transcript records — so a successfully
    /// *parsed* response is not yet a *complete* one. Two guards close that gap:
    /// the response must contain an assistant turn (an empty or prompt-only
    /// tail is never a finished answer), and it must read back identically on
    /// two consecutive attempts (`last_candidate` carries the previous read
    /// across the caller's retry loop). Either failure returns `Err` so the
    /// retry loop backs off and re-reads instead of committing a partial
    /// response as the permanent snapshot.
    pub(super) fn snapshot_research_response(
        &self,
        node_id: &str,
        last_candidate: &mut Option<Vec<Turn>>,
    ) -> Result<(), String> {
        if research::read_response_snapshot(&self.inner.config.workspace_root, node_id)?.is_some() {
            self.mark_research_response_snapshotted(node_id)?;
            return Ok(());
        }
        let content = self.research_node_content(node_id)?;
        let ancestor_prompts = self
            .research_node_ancestor_prompts(node_id)
            .unwrap_or_default();
        let turns = research::load_transcript_response(
            &self.inner.config,
            &content.node,
            &ancestor_prompts,
        )
        .or_else(|_| {
            (!content.turns.is_empty())
                .then_some(content.turns)
                .ok_or_else(|| "completed research response is not available yet".to_string())
        })?;
        if !research::has_active_assistant_turn(&turns) {
            *last_candidate = Some(turns);
            return Err("research response has no assistant turn yet".to_string());
        }
        if last_candidate.as_ref() != Some(&turns) {
            *last_candidate = Some(turns);
            return Err("research response has not settled yet".to_string());
        }
        research::write_response_snapshot(&self.inner.config.workspace_root, node_id, &turns)?;
        self.mark_research_response_snapshotted(node_id)
    }

    /// Records that the node's durable snapshot exists and announces it. The
    /// node was typically marked Complete *before* the adapter finished
    /// flushing, so a viewer that fetched content on the status transition may
    /// hold a truncated response; the stamped update is its refetch signal.
    pub(super) fn mark_research_response_snapshotted(&self, node_id: &str) -> Result<(), String> {
        let updated = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            if node.response_snapshot_at.is_some() {
                None
            } else {
                node.response_snapshot_at = Some(now_millis());
                Some(node.clone())
            }
        };
        if let Some(node) = updated {
            self.persist();
            self.emit(QmuxEvent::new(
                "research.node.updated",
                node.pane_id.clone(),
                node.agent_id.clone(),
                json!({ "node": node }),
            ));
        }
        Ok(())
    }
}
