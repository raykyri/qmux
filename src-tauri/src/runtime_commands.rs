//! Transport-neutral execution commands. UI-only actions (dialogs, focus,
//! window geometry, clipboard and native presentation) stay in the desktop.
use crate::{adapters, pty, state::AppState, turn_queue, workspace};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("invalid {name}: {e}"))
}
fn value(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

pub(crate) fn is_read_only(method: &str) -> bool {
    matches!(
        method,
        "list_panes"
            | "list_groups"
            | "list_agents"
            | "list_turns"
            | "list_thread_graphs"
            | "get_thread_graph"
            | "list_agent_turn_queue"
            | "list_global_drafts"
            | "agent_delivery_debug"
            | "pane_activity"
            | "terminal_attachment"
            | "terminal_capture"
            | "get_research_node_content"
    )
}

pub fn dispatch(state: &AppState, method: &str, args: Value) -> Result<Value, String> {
    if !args.is_object() {
        return Err("runtime command arguments must be an object".into());
    }
    match method {
        "create_research_tree" => value(crate::research_service::create_research_tree(
            state,
            arg(&args, "request")?,
        )?),
        "create_research_document" => value(crate::research_service::create_research_document(
            state,
            arg(&args, "request")?,
        )?),
        "export_pane_to_research" => value(crate::research_service::export_pane_to_research(
            state,
            arg(&args, "request")?,
        )?),
        "update_research_document" => value(crate::research_service::update_research_document(
            state,
            arg(&args, "request")?,
        )?),
        "get_research_node_content" => value(crate::research_service::get_research_node_content(
            state,
            arg(&args, "nodeId")?,
        )?),
        "fork_research_node" => value(crate::research_service::fork_research_node(
            state,
            arg(&args, "parentNodeId")?,
            arg(&args, "prompt")?,
            arg(&args, "publicationProposal")?,
            arg(&args, "queryAnchor")?,
            arg(&args, "inline")?,
        )?),
        "retry_research_node" => value(crate::research_service::retry_research_node(
            state,
            arg(&args, "nodeId")?,
        )?),
        "cancel_research_node" => {
            value(state.cancel_research_node(&arg::<String>(&args, "nodeId")?)?)
        }
        "list_panes" => value(state.list_panes()?),
        "list_groups" => value(state.list_groups()?),
        "list_agents" => value(state.list_agents()?),
        "list_turns" => {
            value(state.list_turns(arg::<Option<String>>(&args, "agentId")?.as_deref())?)
        }
        "list_thread_graphs" => value(state.list_thread_graphs()?),
        "get_thread_graph" => value(state.thread_graph(&arg::<String>(&args, "threadId")?)?),
        "list_agent_turn_queue" => {
            value(state.agent_queued_turns(&arg::<String>(&args, "agentId")?)?)
        }
        "list_global_drafts" => value(state.global_drafts()?),
        "create_global_draft" => value(state.create_global_draft(arg(&args, "text")?)?),
        "update_global_draft" => value(
            state.update_global_draft(&arg::<String>(&args, "draftId")?, arg(&args, "text")?)?,
        ),
        "delete_global_draft" => {
            value(state.delete_global_draft(&arg::<String>(&args, "draftId")?)?)
        }
        "assign_global_draft" => value(turn_queue::assign_global_draft(
            state,
            arg(&args, "request")?,
        )?),
        "group_create" => value(workspace::create_group(state, arg(&args, "request")?)?),
        "group_rename" => value(workspace::rename_group(
            state,
            &arg::<String>(&args, "groupId")?,
            arg(&args, "name")?,
        )?),
        "group_reorder" => value(state.reorder_groups(arg(&args, "groupIds")?)?),
        "group_set_collapsed" => value(workspace::set_group_collapsed(
            state,
            &arg::<String>(&args, "groupId")?,
            arg(&args, "collapsed")?,
        )?),
        "spawn_shell" => value(pty::spawn_shell_pane_at(
            state,
            arg(&args, "initialSize")?,
            arg::<Option<String>>(&args, "sourcePaneId")?.as_deref(),
            arg::<Option<String>>(&args, "groupId")?.as_deref(),
            arg::<Option<String>>(&args, "cwd")?.as_deref(),
        )?),
        "agent_spawn" => {
            let request: adapters::SpawnAgentRequest = arg(&args, "request")?;
            workspace::validate_launch_workspace(
                state,
                request.group_id.as_deref(),
                workspace::LaunchOrigin::Terminal,
            )?;
            value(adapters::agent_spawn(state, request)?)
        }
        "agent_submit_turn" => value(turn_queue::submit_agent_turn(
            state,
            arg(&args, "request")?,
        )?),
        "agent_queue_wait_turn" => value(turn_queue::queue_wait_agent_turn(
            state,
            arg(&args, "request")?,
        )?),
        "agent_queue_delivery_turn" => value(turn_queue::queue_delivery_agent_turn(
            state,
            arg(&args, "request")?,
        )?),
        "agent_remove_queued_turn" => value(turn_queue::remove_queued_agent_turn(
            state,
            arg(&args, "request")?,
        )?),
        "agent_reorder_queued_turn" => value(turn_queue::reorder_queued_agent_turn(
            state,
            arg(&args, "request")?,
        )?),
        "agent_move_queued_turn" => value(turn_queue::move_queued_agent_turn(
            state,
            arg(&args, "request")?,
        )?),
        "agent_send_next_queued_turn" => value(turn_queue::send_next_queued_agent_turn(
            state,
            &arg::<String>(&args, "agentId")?,
        )?),
        "agent_unpause" => value(turn_queue::unpause_agent(
            state,
            &arg::<String>(&args, "agentId")?,
        )?),
        "agent_delivery_debug" => {
            value(state.agent_delivery_debug(&arg::<String>(&args, "agentId")?)?)
        }
        "pane_write" => value(pty::write_pane(state, arg(&args, "options")?)?),
        "pane_resize" => value(pty::resize_pane(
            state,
            arg(&args, "paneId")?,
            arg(&args, "cols")?,
            arg(&args, "rows")?,
        )?),
        "pane_activity" => value(pty::pane_activity(state, arg(&args, "paneId")?)?),
        "pane_kill" => value(pty::kill_pane(state, arg(&args, "paneId")?)?),
        "terminal_attachment" => {
            let id: String = arg(&args, "paneId")?;
            let terminal = state
                .persistent_terminal(&id)?
                .ok_or("pane has no persistent local terminal")?;
            let (program, arguments) = terminal.attachment();
            Ok(json!({"program": program, "args": arguments}))
        }
        "terminal_capture" => {
            let id: String = arg(&args, "paneId")?;
            let terminal = state
                .persistent_terminal(&id)?
                .ok_or("pane has no persistent local terminal")?;
            value(terminal.capture(arg::<Option<bool>>(&args, "history")?.unwrap_or(false))?)
        }
        _ => Err(format!("unsupported runtime command: {method}")),
    }
}
