mod adapters;
mod cli;
mod config;
mod control_socket;
mod dictation_cache;
mod events;
mod file_server;
mod launch_path;
mod persistence;
mod pty;
mod recovery;
mod scrollback;
mod sleep;
mod state;
mod transcript;
mod turn_queue;
mod workspace;

use adapters::{
    SpawnAgentRequest, SpawnClaudeRequest, agent_fork as fork_agent_pane,
    agent_spawn as spawn_agent_pane,
};
use config::{QmuxConfig, RuntimeConfig};
use control_socket::start_control_socket;
use pty::{
    InitialPaneSize, PaneWriteOptions, attach_pane, kill_pane, resize_pane, spawn_shell_pane,
    write_pane,
};
use sleep::SleepGuard;
use state::{AppState, PaneInfo, PaneLayoutEntry, QueuedTurn};
use tauri::Manager;
use transcript::{
    TranscriptOption, Turn, list_agent_transcripts as list_agent_transcript_options,
    set_agent_transcript as repoint_agent_transcript,
};
use turn_queue::{
    MoveQueuedAgentTurnRequest, MoveQueuedAgentTurnResult, RemoveQueuedAgentTurnRequest,
    RemoveQueuedAgentTurnResult, ReorderQueuedAgentTurnRequest, ReorderQueuedAgentTurnResult,
    SendNextQueuedAgentTurnResult, SubmitAgentTurnRequest, SubmitAgentTurnResult,
    move_queued_agent_turn, remove_queued_agent_turn, reorder_queued_agent_turn,
    send_next_queued_agent_turn, set_agent_typing, submit_agent_turn, unpause_agent,
};
use workspace::{
    AgentInfo, CreateGroupRequest, GroupInfo, WorktreeStatus, acknowledge_agent,
    agent_worktree_status, create_group, remove_agent_worktree,
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
fn launcher_adapter_preference_get(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(persistence::load_preferences(&state.config().workspace_root)?.launcher_adapter_id)
}

#[tauri::command]
fn launcher_adapter_preference_set(
    state: tauri::State<'_, AppState>,
    adapter_id: String,
) -> Result<(), String> {
    if !state
        .config()
        .runtime()
        .adapters
        .iter()
        .any(|adapter| adapter.id == adapter_id)
    {
        return Err(format!("unknown agent adapter '{adapter_id}'"));
    }

    let mut preferences =
        persistence::load_preferences(&state.config().workspace_root).unwrap_or_default();
    preferences.launcher_adapter_id = Some(adapter_id);
    persistence::save_preferences(&state.config().workspace_root, &preferences)
}

/// Opens a URL in the user's default external browser (or mail client). Only
/// http(s)/mailto are accepted; the URL is passed as a single argv to the OS opener
/// (no shell), so it can't trigger arbitrary scheme handlers or shell injection.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("refusing to open a non-http(s)/mailto URL externally".to_string());
    }
    open_in_os_browser(&url)
}

#[tauri::command]
fn dictation_cache_metadata(
    app: tauri::AppHandle,
    request: String,
) -> Result<Option<dictation_cache::DictationCacheMetadata>, String> {
    dictation_cache::metadata(app, request)
}

#[tauri::command]
fn dictation_cache_read(
    app: tauri::AppHandle,
    request: String,
    offset: u64,
    length: u64,
) -> Result<String, String> {
    dictation_cache::read_chunk(app, request, offset, length)
}

#[tauri::command]
fn dictation_cache_put_start(
    app: tauri::AppHandle,
    request: String,
    headers: Vec<dictation_cache::DictationCacheHeader>,
) -> Result<(), String> {
    dictation_cache::put_start(app, request, headers)
}

#[tauri::command]
fn dictation_cache_put_chunk(
    app: tauri::AppHandle,
    request: String,
    data_base64: String,
) -> Result<(), String> {
    dictation_cache::put_chunk(app, request, data_base64)
}

#[tauri::command]
fn dictation_cache_put_finish(app: tauri::AppHandle, request: String) -> Result<(), String> {
    dictation_cache::put_finish(app, request)
}

#[tauri::command]
fn dictation_cache_delete(app: tauri::AppHandle, request: String) -> Result<bool, String> {
    dictation_cache::delete(app, request)
}

#[cfg(target_os = "macos")]
fn open_in_os_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open externally: {err}"))
}

#[cfg(target_os = "linux")]
fn open_in_os_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open externally: {err}"))
}

#[cfg(target_os = "windows")]
fn open_in_os_browser(url: &str) -> Result<(), String> {
    // Avoid `cmd /C start`: Rust quotes argv by MSVCRT rules, but cmd.exe re-parses
    // `&|<>^` outside double quotes, so a URL like https://x/?a=1&b=2 would be split
    // (and the tail run as a separate command). Invoke the protocol handler directly
    // via rundll32 — no shell is involved, so the URL reaches the handler intact.
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open externally: {err}"))
}

#[tauri::command]
fn list_claude_skills(state: tauri::State<'_, AppState>) -> Vec<adapters::claude::ClaudeSkill> {
    adapters::claude::list_skills(state.config())
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
) -> Result<Vec<QueuedTurn>, String> {
    state.agent_queued_turns(&agent_id)
}

#[tauri::command]
fn list_agent_transcripts(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<Vec<TranscriptOption>, String> {
    list_agent_transcript_options(&state, &agent_id)
}

#[tauri::command]
fn set_agent_transcript(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    path: Option<String>,
) -> Result<AgentInfo, String> {
    repoint_agent_transcript(&state, &agent_id, path.as_deref())
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
fn agent_spawn(
    state: tauri::State<'_, AppState>,
    request: SpawnAgentRequest,
) -> Result<PaneInfo, String> {
    spawn_agent_pane(&state, request)
}

#[tauri::command]
fn spawn_claude(
    state: tauri::State<'_, AppState>,
    request: SpawnClaudeRequest,
) -> Result<PaneInfo, String> {
    spawn_agent_pane(&state, request.into_agent_request())
}

/// Forks the Claude session in `pane_id` into a new tab and resumes it. `nest`
/// places the fork as a child of the source; otherwise it lands as a sibling
/// immediately after it.
#[tauri::command]
fn agent_fork(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    use_worktree: bool,
    nest: bool,
) -> Result<PaneInfo, String> {
    fork_agent_pane(&state, &pane_id, use_worktree, nest)
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

/// Signals that the webview's listener for `pane_id` is live, flushing any
/// output the pane produced before the frontend was ready to receive it.
#[tauri::command]
fn pane_attach(state: tauri::State<'_, AppState>, pane_id: String) -> Result<(), String> {
    attach_pane(&state, pane_id)
}

/// Returns the durable terminal output captured before this pane's current
/// frontend attach. The frontend replays it into xterm before `pane_attach`, so
/// recovered panes show their prior scrollback followed by fresh process output.
#[tauri::command]
fn pane_scrollback(state: tauri::State<'_, AppState>, pane_id: String) -> Result<String, String> {
    if state.pane_writer(&pane_id)?.is_none() {
        return Err(format!("pane {pane_id} was not found"));
    }
    scrollback::pane_scrollback_base64(&state.config().workspace_root, &pane_id)
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
fn pane_reorder(
    state: tauri::State<'_, AppState>,
    pane_ids: Vec<String>,
) -> Result<Vec<PaneInfo>, String> {
    state.reorder_panes(pane_ids)
}

#[tauri::command]
fn pane_set_layout(
    state: tauri::State<'_, AppState>,
    items: Vec<PaneLayoutEntry>,
) -> Result<Vec<PaneInfo>, String> {
    state.set_pane_layout(items)
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
fn agent_move_queued_turn(
    state: tauri::State<'_, AppState>,
    request: MoveQueuedAgentTurnRequest,
) -> Result<MoveQueuedAgentTurnResult, String> {
    move_queued_agent_turn(&state, request)
}

#[tauri::command]
fn agent_send_next_queued_turn(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<SendNextQueuedAgentTurnResult, String> {
    send_next_queued_agent_turn(&state, &agent_id)
}

#[tauri::command]
fn agent_set_queued_turn_pause(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    index: usize,
    pause_after: bool,
    expected_data: Option<String>,
) -> Result<Vec<QueuedTurn>, String> {
    let queued_turns =
        state.set_queued_turn_pause(&agent_id, index, pause_after, expected_data.as_deref())?;
    if let Some(agent) = state.agent(&agent_id)? {
        state.emit(events::QmuxEvent::new(
            "agent.queued_turn_reordered",
            agent.pane_id.clone(),
            Some(agent.id),
            serde_json::json!({
                "pendingTurns": queued_turns.len(),
                "queuedTurns": queued_turns.clone(),
            }),
        ));
    }
    Ok(queued_turns)
}

#[tauri::command]
fn agent_unpause(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<SendNextQueuedAgentTurnResult, String> {
    unpause_agent(&state, &agent_id)
}

#[tauri::command]
fn agent_set_typing(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    typing: bool,
) -> Result<SendNextQueuedAgentTurnResult, String> {
    set_agent_typing(&state, &agent_id, typing)
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
fn agent_acknowledge(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    include_failed: bool,
) -> Result<AgentInfo, String> {
    acknowledge_agent(&state, &agent_id, include_failed)
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
fn app_confirm_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.mark_exit_confirmed();
    app.exit(0);
    Ok(())
}

/// Arms or releases the macOS wake lock. The frontend calls this whenever its
/// "prevent sleep" setting or the set of running agents changes.
#[tauri::command]
fn app_set_prevent_sleep(guard: tauri::State<'_, SleepGuard>, active: bool) -> Result<(), String> {
    guard.set_active(active)
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
                if let tauri::WindowEvent::CloseRequested { api, .. } = event
                    && state.should_confirm_exit()
                {
                    api.prevent_close();
                    state.request_exit_confirmation();
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
                    if let Some(window) = app.get_webview_window("main")
                        && let Err(err) =
                            apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None)
                    {
                        eprintln!("qmux: failed to apply window vibrancy: {err}");
                    }
                }
                start_control_socket(state.clone()).map_err(std::io::Error::other)?;
                // Loopback static server for the browser overlay. Best-effort: if it
                // can't bind, the app still runs (file:// opens just won't work).
                match file_server::start_file_server(state.clone()) {
                    Ok(info) => state.set_file_server(info.port),
                    Err(err) => eprintln!("qmux: failed to start file server: {err}"),
                }
                // Restore persisted groups/agents/queues, then respawn recoverable
                // panes into fresh PTYs before the command handlers go live so the
                // webview's first list_panes() already sees the recovered session.
                let recovered_panes = state.restore_session();
                recovery::respawn_session(&state, recovered_panes);
                // Re-level persisted nesting now that we know which panes actually
                // came back (exited panes are not respawned).
                state.normalize_pane_layout();
                app.manage(state.clone());
                app.manage(SleepGuard::default());
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_config,
            launcher_adapter_preference_get,
            launcher_adapter_preference_set,
            open_external_url,
            dictation_cache_metadata,
            dictation_cache_read,
            dictation_cache_put_start,
            dictation_cache_put_chunk,
            dictation_cache_put_finish,
            dictation_cache_delete,
            list_claude_skills,
            list_panes,
            list_groups,
            list_agents,
            list_turns,
            list_agent_turn_queue,
            list_agent_transcripts,
            set_agent_transcript,
            group_create,
            spawn_shell,
            agent_spawn,
            spawn_claude,
            agent_fork,
            pane_write,
            pane_attach,
            pane_scrollback,
            pane_resize,
            pane_kill,
            pane_rename,
            pane_reorder,
            pane_set_layout,
            agent_submit_turn,
            agent_remove_queued_turn,
            agent_reorder_queued_turn,
            agent_move_queued_turn,
            agent_send_next_queued_turn,
            agent_set_queued_turn_pause,
            agent_unpause,
            agent_set_typing,
            agent_set_draft,
            agent_get_draft,
            agent_acknowledge,
            worktree_status,
            worktree_remove,
            app_confirm_exit,
            app_set_prevent_sleep,
        ])
        .build(tauri::generate_context!())
        .expect("error while building qmux")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                && code != Some(tauri::RESTART_EXIT_CODE)
                && exit_state.should_confirm_exit()
            {
                api.prevent_exit();
                exit_state.request_exit_confirmation();
            }
        });
}
