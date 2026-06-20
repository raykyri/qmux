mod claude;
mod cli;
mod config;
mod control_socket;
mod events;
mod hooks;
mod persistence;
mod pty;
mod recovery;
mod state;
mod transcript;
mod turn_queue;
mod workspace;

use claude::{SpawnClaudeRequest, spawn_claude_pane};
use config::{QmuxConfig, RuntimeConfig};
use control_socket::start_control_socket;
use pty::{
    InitialPaneSize, PaneWriteOptions, kill_pane, resize_pane, spawn_shell_pane, write_pane,
};
use state::{AppState, PaneInfo};
use tauri::Manager;
use transcript::Turn;
use turn_queue::{
    RemoveQueuedAgentTurnRequest, RemoveQueuedAgentTurnResult, ReorderQueuedAgentTurnRequest,
    ReorderQueuedAgentTurnResult, SubmitAgentTurnRequest, SubmitAgentTurnResult,
    remove_queued_agent_turn, reorder_queued_agent_turn, submit_agent_turn,
};
use workspace::{
    AgentInfo, CreateGroupRequest, GroupInfo, WorktreeStatus, agent_worktree_status, create_group,
    remove_agent_worktree,
};

/// Strips the native "Close Window" items (⌘W on macOS, Alt+F4 elsewhere) out of
/// the default menu so the webview receives ⌘W itself instead of the OS closing
/// the window; the frontend then routes ⌘W to close the active pane. Every other
/// default item is preserved — notably the Edit menu that wires up ⌘C/⌘V/⌘A.
#[cfg(desktop)]
fn route_window_close_to_frontend(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemKind};

    let menu = Menu::default(app.handle())?;
    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        for sub_item in submenu.items()? {
            if let MenuItemKind::Predefined(predefined) = &sub_item {
                // Match the close item by its (mnemonic-stripped) label so both the
                // File and Window submenu copies are removed across platforms.
                let label = predefined.text().unwrap_or_default().replace('&', "");
                if label == "Close Window" || label == "Close" {
                    submenu.remove(predefined)?;
                }
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
fn get_runtime_config(state: tauri::State<'_, AppState>) -> RuntimeConfig {
    state.config().runtime()
}

#[tauri::command]
fn list_panes(state: tauri::State<'_, AppState>) -> Result<Vec<PaneInfo>, String> {
    state.list_panes()
}

#[tauri::command]
fn list_groups(state: tauri::State<'_, AppState>) -> Result<Vec<GroupInfo>, String> {
    state.list_groups()
}

#[tauri::command]
fn list_agents(state: tauri::State<'_, AppState>) -> Result<Vec<AgentInfo>, String> {
    state.list_agents()
}

#[tauri::command]
fn list_turns(
    state: tauri::State<'_, AppState>,
    agent_id: Option<String>,
) -> Result<Vec<Turn>, String> {
    state.list_turns(agent_id.as_deref())
}

#[tauri::command]
fn list_agent_turn_queue(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<Vec<String>, String> {
    state.list_agent_turn_queue(&agent_id)
}

#[tauri::command]
fn group_create(
    state: tauri::State<'_, AppState>,
    request: CreateGroupRequest,
) -> Result<GroupInfo, String> {
    create_group(&state, request)
}

#[tauri::command]
fn spawn_shell(
    state: tauri::State<'_, AppState>,
    initial_size: Option<InitialPaneSize>,
) -> Result<PaneInfo, String> {
    spawn_shell_pane(&state, initial_size)
}

#[tauri::command]
fn spawn_claude(
    state: tauri::State<'_, AppState>,
    request: SpawnClaudeRequest,
) -> Result<PaneInfo, String> {
    spawn_claude_pane(&state, request)
}

#[tauri::command]
fn pane_write(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    data: String,
    paste: bool,
    submit: bool,
) -> Result<(), String> {
    write_pane(
        &state,
        PaneWriteOptions {
            pane_id,
            data,
            paste,
            submit,
        },
    )
}

#[tauri::command]
fn pane_resize(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    resize_pane(&state, pane_id, cols, rows)
}

#[tauri::command]
fn pane_kill(state: tauri::State<'_, AppState>, pane_id: String) -> Result<(), String> {
    kill_pane(&state, pane_id)
}

#[tauri::command]
fn pane_rename(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    title: String,
) -> Result<PaneInfo, String> {
    state.rename_pane(&pane_id, title)
}

#[tauri::command]
fn agent_submit_turn(
    state: tauri::State<'_, AppState>,
    request: SubmitAgentTurnRequest,
) -> Result<SubmitAgentTurnResult, String> {
    submit_agent_turn(&state, request)
}

#[tauri::command]
fn agent_remove_queued_turn(
    state: tauri::State<'_, AppState>,
    request: RemoveQueuedAgentTurnRequest,
) -> Result<RemoveQueuedAgentTurnResult, String> {
    remove_queued_agent_turn(&state, request)
}

#[tauri::command]
fn agent_reorder_queued_turn(
    state: tauri::State<'_, AppState>,
    request: ReorderQueuedAgentTurnRequest,
) -> Result<ReorderQueuedAgentTurnResult, String> {
    reorder_queued_agent_turn(&state, request)
}

#[tauri::command]
fn agent_set_draft(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    draft: String,
) -> Result<(), String> {
    state.set_agent_draft(&agent_id, draft)
}

#[tauri::command]
fn agent_get_draft(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<Option<String>, String> {
    state.agent_draft(&agent_id)
}

#[tauri::command]
fn worktree_status(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<WorktreeStatus, String> {
    agent_worktree_status(&state, &agent_id)
}

#[tauri::command]
fn worktree_remove(state: tauri::State<'_, AppState>, agent_id: String) -> Result<(), String> {
    remove_agent_worktree(&state, &agent_id)
}

#[tauri::command]
fn app_confirm_exit(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.mark_exit_confirmed();
    app.exit(0);
    Ok(())
}

fn main() {
    match cli::run_cli_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }

    let config = QmuxConfig::load().unwrap_or_else(|err| {
        eprintln!("{err}");
        std::process::exit(1);
    });
    let state = AppState::new(config);

    let exit_state = state.clone();

    tauri::Builder::default()
        .on_window_event({
            let state = state.clone();
            move |_window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if state.should_confirm_exit() {
                        api.prevent_close();
                        state.request_exit_confirmation();
                    }
                }
            }
        })
        .setup({
            let state = state.clone();
            move |app| {
                state
                    .attach_app(app.handle().clone())
                    .map_err(std::io::Error::other)?;
                // Best-effort: if the menu tweak fails, ⌘W keeps its default
                // (window-closing) behavior rather than aborting startup.
                if let Err(err) = route_window_close_to_frontend(app) {
                    eprintln!("qmux: failed to reroute window close shortcut: {err}");
                }
                // On macOS, give the window an NSVisualEffectView so the sidebar can
                // read as a native, translucent source list (Finder/Mail/Xcode). The
                // frontend paints the content panes opaque and leaves the sidebar
                // column transparent, so the material only shows through there.
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{NSVisualEffectMaterial, apply_vibrancy};
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(err) =
                            apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None)
                        {
                            eprintln!("qmux: failed to apply window vibrancy: {err}");
                        }
                    }
                }
                start_control_socket(state.clone()).map_err(std::io::Error::other)?;
                // Restore persisted groups/agents/queues, then respawn recoverable
                // panes into fresh PTYs before the command handlers go live so the
                // webview's first list_panes() already sees the recovered session.
                let recovered_panes = state.restore_session();
                recovery::respawn_session(&state, recovered_panes);
                app.manage(state.clone());
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_config,
            list_panes,
            list_groups,
            list_agents,
            list_turns,
            list_agent_turn_queue,
            group_create,
            spawn_shell,
            spawn_claude,
            pane_write,
            pane_resize,
            pane_kill,
            pane_rename,
            agent_submit_turn,
            agent_remove_queued_turn,
            agent_reorder_queued_turn,
            agent_set_draft,
            agent_get_draft,
            worktree_status,
            worktree_remove,
            app_confirm_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building qmux")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code != Some(tauri::RESTART_EXIT_CODE) && exit_state.should_confirm_exit() {
                    api.prevent_exit();
                    exit_state.request_exit_confirmation();
                }
            }
        });
}
