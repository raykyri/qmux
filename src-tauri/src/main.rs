mod adapters;
mod cli;
mod config;
mod connection_limit;
mod control_socket;
mod events;
mod file_server;
mod launch_path;
mod menu_bar;
mod persistence;
mod pty;
mod recovery;
mod scrollback;
mod show_hide_shortcut;
mod sleep;
mod state;
mod title_generation;
mod transcript;
mod turn_queue;
mod workspace;

use adapters::{
    SpawnAgentRequest, SpawnClaudeRequest, agent_fork as fork_agent_pane,
    agent_spawn as spawn_agent_pane,
};
use config::{QmuxConfig, RuntimeConfig};
use control_socket::start_control_socket;
use menu_bar::menu_bar_update;
use pty::{
    InitialPaneSize, PaneActivity, PaneWriteOptions, attach_pane, close_worktree_pane, kill_pane,
    pane_activity as inspect_pane_activity, resize_pane, spawn_shell_pane, write_pane,
};
use show_hide_shortcut::{
    show_hide_shortcut_capture_set, show_hide_shortcut_get, show_hide_shortcut_set,
};
use sleep::SleepGuard;
use state::{AppState, PaneInfo, PaneLayoutEntry, PaneSplitInfo, QueuedTurn, RecentSessionInfo};
use tauri::Manager;
use transcript::{
    TranscriptOption, Turn, list_agent_transcripts as list_agent_transcript_options,
    set_agent_transcript as repoint_agent_transcript,
};
use turn_queue::{
    MoveQueuedAgentTurnRequest, MoveQueuedAgentTurnResult, QueueDeliveryAgentTurnRequest,
    QueueWaitAgentTurnRequest, RemoveQueuedAgentTurnRequest, RemoveQueuedAgentTurnResult,
    ReorderQueuedAgentTurnRequest, ReorderQueuedAgentTurnResult, SendNextQueuedAgentTurnResult,
    SubmitAgentTurnRequest, SubmitAgentTurnResult, move_queued_agent_turn,
    queue_delivery_agent_turn, queue_wait_agent_turn, remove_queued_agent_turn,
    reorder_queued_agent_turn, send_next_queued_agent_turn, set_agent_typing, submit_agent_turn,
    unpause_agent,
};
use workspace::{
    AgentInfo, CreateGroupRequest, GroupInfo, WorktreeStatus, acknowledge_agent,
    agent_worktree_status, clear_agent_working_status, create_group, remove_agent_worktree,
    rename_group, set_group_collapsed, set_group_dir,
};

/// Menu id for the Quit item we substitute for the native predefined one (see
/// `customize_app_menu`).
#[cfg(desktop)]
const QUIT_MENU_ID: &str = "qmux-quit";

/// Reworks the default menu so close/quit requests reach our confirmation flow:
///
/// - Strips the native "Close Window" items (⌘W on macOS, Alt+F4 elsewhere) so the
///   webview receives ⌘W itself; the frontend then routes ⌘W to close the active pane.
/// - On macOS, replaces the predefined "Quit" item with our own ⌘Q item. The native
///   item is hard-wired to Cocoa's `terminate:` selector, which tao does not intercept
///   (it implements `applicationWillTerminate:` but not `applicationShouldTerminate:`),
///   so ⌘Q would terminate the process instantly — bypassing both the `CloseRequested`
///   and `ExitRequested` handlers and quitting without confirmation even while agents
///   are running. Our replacement emits a `MenuEvent` we handle in `on_menu_event`.
///
/// Every other default item is preserved — notably the Edit menu that wires up ⌘C/⌘V/⌘A.
#[cfg(desktop)]
fn customize_app_menu(app: &tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    use tauri::menu::MenuItemBuilder;
    use tauri::menu::{Menu, MenuItemKind};

    let menu = Menu::default(app.handle())?;
    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        for (index, sub_item) in submenu.items()?.into_iter().enumerate() {
            let MenuItemKind::Predefined(predefined) = &sub_item else {
                continue;
            };
            // Match against the (mnemonic-stripped) label so platform copies line up.
            let label = predefined.text().unwrap_or_default().replace('&', "");
            if label == "Close Window" || label == "Close" {
                submenu.remove(predefined)?;
                continue;
            }
            // The macOS predefined Quit reads "Quit <app>"; preserve its label and
            // slot, but back it with our own handler instead of `terminate:`.
            #[cfg(target_os = "macos")]
            if label.starts_with("Quit") {
                let replacement = MenuItemBuilder::with_id(QUIT_MENU_ID, &label)
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                submenu.remove(predefined)?;
                submenu.insert(&replacement, index)?;
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

/// Handles the custom Quit menu item, routing it through the same exit-confirmation
/// flow as the window close button instead of terminating immediately.
#[cfg(desktop)]
fn handle_app_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if event.id().as_ref() != QUIT_MENU_ID {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        app.exit(0);
        return;
    };
    if state.should_confirm_exit() {
        state.request_exit_confirmation();
    } else {
        app.exit(0);
    }
}

#[tauri::command]
fn get_runtime_config(state: tauri::State<'_, AppState>) -> RuntimeConfig {
    let mut runtime = state.config().runtime();
    // Surface the live file-server port so the frontend can identify token-bearing
    // file-server URLs and always sandbox them (see `isFileServerUrl`).
    runtime.file_server_port = state.file_server_port();
    runtime
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

#[tauri::command]
fn active_tab_get(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    state.active_tab_id()
}

#[tauri::command]
fn active_tab_set(state: tauri::State<'_, AppState>, tab_id: Option<String>) -> Result<(), String> {
    state.set_active_tab_id(tab_id)
}

/// Surfaces a fatal startup error in a native dialog, for GUI (Finder/Dock)
/// launches that have no terminal to show the `eprintln`. Best-effort: if
/// `osascript` fails the message is still on stderr for a terminal launch.
#[cfg(target_os = "macos")]
fn notify_fatal_startup(message: &str) {
    // AppleScript string literals escape backslash and double-quote; embedded
    // newlines are fine inside the quoted literal.
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display dialog \"{escaped}\" with title \"qmux\" buttons {{\"Quit\"}} default button \"Quit\" with icon stop"
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status();
}

#[cfg(not(target_os = "macos"))]
fn notify_fatal_startup(_message: &str) {}

/// Surfaces a non-fatal startup warning (persisted state moved aside, entries
/// dropped during recovery) in a native dialog without blocking startup.
/// Best-effort: the message is already on stderr for terminal launches.
#[cfg(target_os = "macos")]
fn notify_startup_warning(message: &str) {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display dialog \"{escaped}\" with title \"qmux\" buttons {{\"OK\"}} default button \"OK\" with icon caution"
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

#[cfg(not(target_os = "macos"))]
fn notify_startup_warning(_message: &str) {}

/// Shows the native folder chooser in-process and returns the selected path, or
/// `None` when the user cancels. Blocks the calling thread, so callers must be
/// `#[tauri::command(async)]` (the panel itself is dispatched to the main thread
/// by the plugin).
fn pick_folder_dialog(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut dialog = app
        .dialog()
        .file()
        .set_title("Select the group directory");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    match dialog.blocking_pick_folder() {
        Some(path) => path
            .into_path()
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|err| format!("folder chooser returned an unusable path: {err}")),
        None => Ok(None),
    }
}

/// Opens a URL in the user's default external browser (or mail client). Only
/// http(s)/mailto are accepted; the URL is passed as a single argv to the OS opener
/// (no shell), so it can't trigger arbitrary scheme handlers or shell injection.
#[tauri::command]
fn open_external_url(state: tauri::State<'_, AppState>, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("refusing to open a non-http(s)/mailto URL externally".to_string());
    }
    // Never hand a token-bearing file-server URL to the OS opener: the default browser
    // would load it as a normal same-origin document (leaking the token into history and
    // to any local process) and could then read every sibling file under the pane's
    // roots. Legit loopback dev-server URLs on any *other* port still open externally.
    if let Some(port) = state.file_server_port()
        && is_file_server_url(&url, port)
    {
        return Err(
            "refusing to open a file-server URL externally (would leak the access token)"
                .to_string(),
        );
    }
    open_in_os_browser(&url)
}

/// Whether `url` is a loopback URL on the file server's port — i.e. a token-bearing
/// URL that must never leave the sandboxed overlay. Matches the frontend's
/// `isFileServerUrl` port check; done with prefix comparison to avoid a URL-parsing
/// dependency, mirroring the hand-rolled parsing in file_server.rs.
fn is_file_server_url(url: &str, port: u16) -> bool {
    url.starts_with(&format!("http://127.0.0.1:{port}/"))
        || url.starts_with(&format!("http://localhost:{port}/"))
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
fn list_recent_sessions(
    state: tauri::State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<RecentSessionInfo>, String> {
    state.list_recent_sessions(limit.unwrap_or(12))
}

#[tauri::command]
fn recent_session_resume(
    state: tauri::State<'_, AppState>,
    session_id: String,
    initial_size: Option<InitialPaneSize>,
) -> Result<PaneInfo, String> {
    recovery::resume_recent_session(&state, &session_id, initial_size)
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
fn group_remove(state: tauri::State<'_, AppState>, group_id: String) -> Result<(), String> {
    state.remove_group(&group_id)
}

#[tauri::command]
fn group_rename(
    state: tauri::State<'_, AppState>,
    group_id: String,
    name: Option<String>,
) -> Result<GroupInfo, String> {
    rename_group(&state, &group_id, name)
}

#[tauri::command]
fn group_reorder(
    state: tauri::State<'_, AppState>,
    group_ids: Vec<String>,
) -> Result<Vec<GroupInfo>, String> {
    state.reorder_groups(group_ids)
}

#[tauri::command]
fn group_set_collapsed(
    state: tauri::State<'_, AppState>,
    group_id: String,
    collapsed: bool,
) -> Result<GroupInfo, String> {
    set_group_collapsed(&state, &group_id, collapsed)
}

#[tauri::command(async)]
fn group_create_pick(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    after_group_id: Option<String>,
) -> Result<Option<GroupInfo>, String> {
    match pick_folder_dialog(&app)? {
        Some(path) => create_group(
            &state,
            CreateGroupRequest {
                name: None,
                dir: Some(path),
                after_group_id,
                base_repo: None,
                base_ref: None,
            },
        )
        .map(Some),
        None => Ok(None),
    }
}

#[tauri::command(async)]
fn group_pick_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    group_id: String,
) -> Result<Option<GroupInfo>, String> {
    match pick_folder_dialog(&app)? {
        Some(path) => set_group_dir(&state, &group_id, path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn spawn_shell(
    state: tauri::State<'_, AppState>,
    initial_size: Option<InitialPaneSize>,
    source_pane_id: Option<String>,
    group_id: Option<String>,
) -> Result<PaneInfo, String> {
    spawn_shell_pane(
        &state,
        initial_size,
        source_pane_id.as_deref(),
        group_id.as_deref(),
    )
}

#[tauri::command]
fn use_login_shell_set(state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut preferences =
        persistence::load_preferences(&state.config().workspace_root).unwrap_or_default();
    preferences.use_login_shell = Some(enabled);
    persistence::save_preferences(&state.config().workspace_root, &preferences)
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

/// Forks the session in `pane_id` into a new tab and resumes it. `nest` places the
/// fork as a child of the source; otherwise it lands as a sibling immediately after
/// it. When `prompt` is set, it is submitted as the fork's launch message.
#[tauri::command]
fn agent_fork(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    use_worktree: bool,
    nest: bool,
    prompt: Option<String>,
) -> Result<PaneInfo, String> {
    fork_agent_pane(&state, &pane_id, use_worktree, nest, prompt)
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
/// Recovered agent resumes opt out because their pre-attach backlog is a fresh TUI
/// repaint, and replaying old raw TUI bytes first can leave the active prompt with
/// stale cell attributes.
#[tauri::command]
fn pane_scrollback(state: tauri::State<'_, AppState>, pane_id: String) -> Result<String, String> {
    match state.pane_skips_scrollback_restore(&pane_id)? {
        Some(true) => return Ok(String::new()),
        Some(false) => {}
        None => return Err(format!("pane {pane_id} was not found")),
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
fn pane_activity(
    state: tauri::State<'_, AppState>,
    pane_id: String,
) -> Result<PaneActivity, String> {
    inspect_pane_activity(&state, pane_id)
}

#[tauri::command]
fn pane_kill(state: tauri::State<'_, AppState>, pane_id: String) -> Result<(), String> {
    kill_pane(&state, pane_id)
}

/// Records that `pane_id` is now the focused pane. Fired by the frontend whenever
/// the active pane changes; feeds the recency signal that `group_spawn_cwd` uses to
/// pick a spawn directory. Best-effort and cheap (in-memory stamp, no persist).
#[tauri::command]
fn pane_activate(state: tauri::State<'_, AppState>, pane_id: String) {
    state.touch_pane_active(&pane_id);
}

#[tauri::command]
fn pane_restore_last_closed(state: tauri::State<'_, AppState>) -> Result<Option<PaneInfo>, String> {
    recovery::restore_last_closed_pane(&state)
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
fn pane_place_after(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    sibling_pane_id: String,
) -> Result<Vec<PaneInfo>, String> {
    state.place_pane_after(&pane_id, &sibling_pane_id)
}

#[tauri::command]
fn pane_splits_get(state: tauri::State<'_, AppState>) -> Result<Vec<PaneSplitInfo>, String> {
    state.pane_splits()
}

#[tauri::command]
fn pane_splits_set(
    state: tauri::State<'_, AppState>,
    splits: Vec<PaneSplitInfo>,
) -> Result<Vec<PaneSplitInfo>, String> {
    state.set_pane_splits(splits)
}

#[tauri::command]
fn agent_submit_turn(
    state: tauri::State<'_, AppState>,
    request: SubmitAgentTurnRequest,
) -> Result<SubmitAgentTurnResult, String> {
    submit_agent_turn(&state, request)
}

#[tauri::command]
fn agent_queue_wait_turn(
    state: tauri::State<'_, AppState>,
    request: QueueWaitAgentTurnRequest,
) -> Result<SubmitAgentTurnResult, String> {
    queue_wait_agent_turn(&state, request)
}

#[tauri::command]
fn agent_queue_delivery_turn(
    state: tauri::State<'_, AppState>,
    request: QueueDeliveryAgentTurnRequest,
) -> Result<SubmitAgentTurnResult, String> {
    queue_delivery_agent_turn(&state, request)
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
fn agent_clear_working_status(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<AgentInfo, String> {
    clear_agent_working_status(&state, &agent_id)
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
fn worktree_close_pane(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    delete_worktree: bool,
) -> Result<(), String> {
    close_worktree_pane(&state, &agent_id, delete_worktree)
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

#[tauri::command(async)]
async fn generate_foundation_tab_title(message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        title_generation::generate_foundation_title(&message)
    })
    .await
    .map_err(|err| format!("Apple Foundation Models task failed: {err}"))?
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
        // Registered first so a duplicate launch exits before setup() can steal the
        // control socket and respawn the persisted session alongside the running
        // instance. Instances are deduped per app identifier and user session; the
        // second launch hands off to this callback in the surviving process, which
        // just surfaces the existing window. (CLI subcommands returned above and
        // never get here, so `qmux open` etc. are unaffected.)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(show_hide_shortcut::handle_global_shortcut)
                .build(),
        )
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
        .on_menu_event(handle_app_menu_event)
        .setup({
            let state = state.clone();
            move |app| {
                state
                    .attach_app(app.handle().clone())
                    .map_err(std::io::Error::other)?;
                // Best-effort: if the menu tweak fails, ⌘W keeps its default
                // (window-closing) behavior and ⌘Q its instant-quit behavior rather
                // than aborting startup.
                if let Err(err) = customize_app_menu(app) {
                    eprintln!("qmux: failed to customize app menu: {err}");
                }
                if let Err(err) = menu_bar::init(app.handle()) {
                    eprintln!("qmux: failed to initialize menu bar icon: {err}");
                }
                app.manage(show_hide_shortcut::ShowHideShortcutState::default());
                show_hide_shortcut::init(app.handle(), &state.config().workspace_root);
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
                // Refuse to continue if the saved session exists but can't be read:
                // starting empty here would let the first save overwrite it with
                // nothing and no backup. Abort loudly (terminal + GUI) so a relaunch
                // after fixing the transient cause restores the session intact.
                if let Err(err) = state.preflight_persisted_state() {
                    eprintln!("\nqmux: {err}\n");
                    notify_fatal_startup(&err);
                    std::process::exit(1);
                }
                // Sweep scratch files stranded by earlier processes that were killed
                // mid-save (most commonly the final persist racing process exit).
                persistence::remove_stale_tmp_files(&state.config().workspace_root);
                // Restore persisted groups/agents/queues, then respawn recoverable
                // panes into fresh PTYs before the command handlers go live so the
                // webview's first list_panes() already sees the recovered session.
                let recovered_panes = state.restore_session();
                // Recovery fell back to an empty session (state discarded to a .bak)
                // or dropped entries: say so in a dialog, since a Finder launch never
                // shows stderr and silent session loss looks like qmux ate the tabs.
                if let Some(warning) = state.take_recovery_warning() {
                    notify_startup_warning(&warning);
                }
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
            active_tab_get,
            active_tab_set,
            open_external_url,
            list_claude_skills,
            list_panes,
            list_groups,
            list_agents,
            list_recent_sessions,
            recent_session_resume,
            list_turns,
            list_agent_turn_queue,
            list_agent_transcripts,
            set_agent_transcript,
            group_create,
            group_remove,
            group_rename,
            group_reorder,
            group_set_collapsed,
            group_create_pick,
            group_pick_dir,
            spawn_shell,
            use_login_shell_set,
            agent_spawn,
            spawn_claude,
            agent_fork,
            pane_write,
            pane_attach,
            pane_scrollback,
            pane_resize,
            pane_activity,
            pane_kill,
            pane_activate,
            pane_restore_last_closed,
            pane_rename,
            pane_reorder,
            pane_set_layout,
            pane_place_after,
            pane_splits_get,
            pane_splits_set,
            agent_submit_turn,
            agent_queue_wait_turn,
            agent_queue_delivery_turn,
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
            agent_clear_working_status,
            worktree_status,
            worktree_remove,
            worktree_close_pane,
            app_confirm_exit,
            app_set_prevent_sleep,
            generate_foundation_tab_title,
            menu_bar_update,
            show_hide_shortcut_get,
            show_hide_shortcut_set,
            show_hide_shortcut_capture_set,
        ])
        .build(tauri::generate_context!())
        .expect("error while building qmux")
        .run(move |_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. }
                if code != Some(tauri::RESTART_EXIT_CODE) && exit_state.should_confirm_exit() =>
            {
                api.prevent_exit();
                exit_state.request_exit_confirmation();
            }
            // The process is really terminating now (exit confirmed, or nothing to
            // confirm). Take down every pane's process tree so agent-spawned
            // descendants don't survive as orphans past quit.
            tauri::RunEvent::Exit => {
                // Freeze the on-disk session before touching the panes: killing them
                // makes every reader thread see PTY EOF and run the natural-exit
                // remove_pane path, and any of those persists that win the race with
                // process death would save the session with its tabs deleted.
                exit_state.finalize_persistence_for_exit();
                pty::kill_all_panes(&exit_state);
                // Reclaim the control socket on a clean exit rather than leaving the
                // file for the next launch's stale-socket cleanup — but only while the
                // path still points at the socket this process bound. If another
                // instance (e.g. a differently-configured build sharing the socket
                // path) has re-bound it since, deleting the file would sever every
                // `qmux` CLI caller from that live instance.
                if exit_state.owns_control_socket() {
                    let _ = std::fs::remove_file(&exit_state.config().socket_path);
                }
            }
            _ => {}
        });
}
