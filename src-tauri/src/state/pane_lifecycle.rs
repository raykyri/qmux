//! Pane removal and cleanup across model, credentials, jobs, and research.
//! AppState retains the same shared model and lock ownership.

use super::*;

impl AppState {
    /// Undoes `insert_pane` for a spawn that failed before the pane went live (native
    /// surface creation failed). `remove_pane` is the "closed for good" transition: it
    /// prunes a queue-less bound agent, deletes durable scrollback and removes a group
    /// left without open panes. None of that is right for a pane that never started —
    /// during startup recovery the group's other panes are simply not respawned yet, so
    /// that cascade dropped every agent in the workspace, and the caller's
    /// `mark_agent_failed` / `mark_agent_spawn_failed` then found no agent to mark.
    /// This only forgets the runtime and the credentials minted for it.
    pub fn abort_pane_spawn(&self, pane_id: &str) -> Result<(), String> {
        let removed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let removed = model.panes.remove(pane_id).is_some();
            model.pane_order.retain(|id| id != pane_id);
            // During recovery, saved splits can refer to panes that have not
            // respawned yet. Pruning against this partial model would discard
            // unrelated layouts; startup normalizes once all respawns finish.
            if removed && !self.startup_restoring() {
                normalize_pane_splits_locked(&mut model);
            }
            removed
        };
        if !removed {
            return Ok(());
        }
        self.revoke_pane_credentials(pane_id);
        self.persist();
        // insert_pane does not announce the pane, but a concurrent listPanes()
        // refresh may have; the frontend handles a redundant removal as a no-op.
        self.emit(QmuxEvent::pane_removed(pane_id.to_string()));
        Ok(())
    }

    pub fn remove_pane(&self, pane_id: &str) -> Result<(), String> {
        // Cancel network helpers before removing the runtime; a late recovery
        // must not install a new attachment into a closing pane.
        if let Some((controller, _, _)) = self.pane_remote_control(pane_id)? {
            controller.cancel_recovery();
        }
        // The bound agent's identity and status at the moment the pane went
        // away, captured before the pruning below rewrites or removes the
        // record. The research detach at the end of this function needs it to
        // tell a finished run (process exits at end of turn) from a crashed
        // one; reading the model there is too late.
        let mut departing_agent: Option<(String, AgentStatus, bool)> = None;
        let removed_group_id = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let removed_group_id = model
                .panes
                .get(pane_id)
                .map(|pane| pane.info.group_id.clone())
                .or_else(|| {
                    model
                        .recovery_panes
                        .iter()
                        .find(|pane| pane.id == pane_id)
                        .map(|pane| pane.group_id.clone())
                });
            model.recovery_panes.retain(|pane| pane.id != pane_id);
            model.panes.remove(pane_id);
            model.pane_order.retain(|id| id != pane_id);
            model.research_retiring_panes.remove(pane_id);

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
                    let has_active_subagents = model
                        .agent_active_subagents
                        .get(&agent.id)
                        .is_some_and(|active| !active.is_empty());
                    departing_agent = Some((agent.id.clone(), agent.status, has_active_subagents));
                    upsert_recent_session_for_agent_locked(
                        &mut model,
                        &agent,
                        now_millis(),
                        true,
                        RecentSessionMeta::CacheOnly,
                    );
                }
                clear_recent_session_binding_locked(&mut model, Some(&agent_id), Some(pane_id));
                model.agent_typing.remove(&agent_id);
                model.agent_pending_pause.remove(&agent_id);
                if !model.agent_queue_claims.contains_key(&agent_id) {
                    model.agent_draining.remove(&agent_id);
                }
                model.agent_fork_barriers.remove(&agent_id);
                model.agent_deferred_queue_resume.remove(&agent_id);
                model.agent_send_tracking.remove(&agent_id);
                model.agent_activity.remove(&agent_id);
                model.agent_status_activity.remove(&agent_id);
                model.agent_active_subagents.remove(&agent_id);
                model
                    .agents_with_reported_background_tasks
                    .remove(&agent_id);
                model.agent_escape_watch.remove(&agent_id);
                model
                    .agent_submit_watch
                    .retain(|(watched_agent, _)| watched_agent != &agent_id);
                // A live sender retains ownership until it reports its outcome.
                // Keep plain delivery durable in inflight for restart recovery;
                // do not expose a second movable copy while the write is pending.
                // New-pane dispatch may have cleared that durable record already,
                // but its live claim still keeps the parked agent until settlement.
                if !model.agent_queue_claims.contains_key(&agent_id)
                    && let Some(turn) = model.agent_inflight.remove(&agent_id)
                {
                    let queue = model.agent_turn_queues.entry(agent_id.clone()).or_default();
                    if !queue.iter().any(|queued| queued.id == turn.id) {
                        queue.push_front(turn);
                    }
                }
                let has_queue = model
                    .agent_turn_queues
                    .get(&agent_id)
                    .is_some_and(|queue| !queue.is_empty())
                    || model.agent_queue_claims.contains_key(&agent_id);
                if !has_queue {
                    model.agents.remove(&agent_id);
                    model.turns.remove(&agent_id);
                    model.agent_drafts.remove(&agent_id);
                    model.agent_turn_queues.remove(&agent_id);
                } else {
                    // Kept for restart recovery via the orphaned-queue panel. Park it
                    // the same way `detach_pane_agent` and
                    // `restore_closed_agent_snapshot_locked` do: detach from the
                    // now-removed pane and mark idle. Leaving `pane_id` pointing at the
                    // dead pane (and status Running) both misrepresents the agent to the
                    // panel/recovery and keeps its transcript tail polling the
                    // now-static/deleted file for the rest of the process — the tail
                    // stops once the agent is gone, rotates its transcript, or (now) is
                    // parked like this.
                    //
                    // Bind the orphaned queue to a still-open pane in the same group when
                    // one exists, so it stays visible in that group's recovered-queue
                    // panel. Binding it to the just-closed (dead) pane id — as before —
                    // left it matching no live surface while siblings stayed open, so it
                    // silently vanished from the UI. When this was the group's last pane,
                    // keep the dead id: the queue is then captured into the closed-pane
                    // undo snapshot. Last-pane closure still removes the group and its
                    // queues; it does not promise restart recovery.
                    let surviving_sibling = removed_group_id.as_deref().and_then(|group_id| {
                        model
                            .panes
                            .values()
                            .find(|pane| pane.info.group_id == group_id)
                            .map(|pane| pane.info.id.clone())
                    });
                    let home = surviving_sibling.unwrap_or_else(|| pane_id.to_string());
                    park_agent_locked(&mut model, &agent_id, &home);
                }
            }

            normalize_pane_splits_locked(&mut model);
            removed_group_id.filter(|group_id| {
                remove_group_without_open_panes_locked(&mut model, group_id, true)
            })
        };
        self.revoke_pane_credentials(pane_id);
        for info in self.unregister_shell_agent_jobs_for_pane(pane_id) {
            crate::shell_jobs::emit_job_removed(self, &info);
        }
        if let Err(err) = self.detach_research_pane_inner(
            pane_id,
            departing_agent
                .as_ref()
                .map(|(agent_id, status, active)| (agent_id.as_str(), *status, *active)),
        ) {
            eprintln!("qmux: failed to detach research pane {pane_id}: {err}");
        }
        if !self.inner.exit_teardown_started.load(Ordering::SeqCst)
            && let Err(err) = remove_pane_scrollback(&self.inner.config.workspace_root, pane_id)
        {
            eprintln!("qmux: failed to remove scrollback for pane {pane_id}: {err}");
        }
        self.persist();
        self.emit(QmuxEvent::pane_removed(pane_id.to_string()));
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
}
