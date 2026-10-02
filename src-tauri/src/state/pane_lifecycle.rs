//! Pane removal and cleanup across model, credentials, jobs, and research.
//! AppState retains the same shared model and lock ownership.

use super::*;

impl AppState {
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
                .map(|pane| pane.info.group_id.clone());
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
                model.agent_draining.remove(&agent_id);
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
                // A turn claimed for delivery but not yet settled when the pane goes
                // away: roll it back to the front of the queue so it isn't lost (and so
                // the has_queue check below keeps the agent for restart recovery).
                if let Some(turn) = model.agent_inflight.remove(&agent_id) {
                    model
                        .agent_turn_queues
                        .entry(agent_id.clone())
                        .or_default()
                        .push_front(turn);
                }
                let has_queue = model
                    .agent_turn_queues
                    .get(&agent_id)
                    .is_some_and(|queue| !queue.is_empty());
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
                    // undo snapshot and re-homed on restore/restart.
                    let surviving_sibling = removed_group_id.as_deref().and_then(|group_id| {
                        model
                            .panes
                            .values()
                            .find(|pane| pane.info.group_id == group_id)
                            .map(|pane| pane.info.id.clone())
                    });
                    if let Some(agent) = model.agents.get_mut(&agent_id) {
                        agent.pane_id = None;
                        agent.orphaned_queue_pane_id =
                            Some(surviving_sibling.unwrap_or_else(|| pane_id.to_string()));
                        agent.status = AgentStatus::Idle;
                        agent.paused = true;
                    }
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
