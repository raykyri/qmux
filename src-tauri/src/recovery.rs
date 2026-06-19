use crate::claude::respawn_agent_pane;
use crate::events::QmuxEvent;
use crate::pty::respawn_shell_pane;
use crate::state::{AppState, PaneInfo, PaneKind, PaneStatus};
use crate::workspace::mark_agent_failed;
use serde_json::json;

/// Recreates recoverable panes from persisted metadata after a restart.
///
/// Panes that were already finished before the previous shutdown
/// (exited/killed/failed) are skipped — they should stay closed, not resurrect.
/// Each remaining pane is respawned in place (same id); a failure is isolated so
/// one bad pane never blocks the rest. Failed agent respawns mark the agent as
/// failed so the UI surfaces a "needs relaunch" state.
pub fn respawn_session(state: &AppState, panes: Vec<PaneInfo>) {
    let mut recovered = 0_usize;
    let mut failed = 0_usize;

    for pane in panes {
        if matches!(
            pane.status,
            PaneStatus::Exited | PaneStatus::Killed | PaneStatus::Failed
        ) {
            continue;
        }

        let result = match pane.kind {
            PaneKind::Shell => respawn_shell_pane(state, &pane).map(|_| ()),
            PaneKind::Agent => respawn_agent_pane(state, &pane).map(|_| ()),
        };

        match result {
            Ok(()) => recovered += 1,
            Err(err) => {
                failed += 1;
                if let Some(agent_id) = pane.agent_id.as_deref() {
                    let _ = mark_agent_failed(state, agent_id);
                }
                state.emit(QmuxEvent::new(
                    "pane.recovery_failed",
                    Some(pane.id.clone()),
                    pane.agent_id.clone(),
                    json!({ "error": err, "title": pane.title, "kind": pane.kind }),
                ));
            }
        }
    }

    if recovered > 0 || failed > 0 {
        state.emit(QmuxEvent::new(
            "session.recovered",
            None,
            None,
            json!({ "recovered": recovered, "failed": failed }),
        ));
    }
}
