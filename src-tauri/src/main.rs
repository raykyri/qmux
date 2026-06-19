mod claude;
mod cli;
mod config;
mod control_socket;
mod events;
mod pty;
mod state;

use claude::{SpawnClaudeRequest, spawn_claude_pane};
use config::{QmuxConfig, RuntimeConfig};
use control_socket::start_control_socket;
use pty::{PaneWriteOptions, kill_pane, resize_pane, spawn_shell_pane, write_pane};
use state::{AppState, PaneInfo};
use tauri::Manager;

#[tauri::command]
fn get_runtime_config(state: tauri::State<'_, AppState>) -> RuntimeConfig {
    state.config().runtime()
}

#[tauri::command]
fn list_panes(state: tauri::State<'_, AppState>) -> Result<Vec<PaneInfo>, String> {
    state.list_panes()
}

#[tauri::command]
fn spawn_shell(state: tauri::State<'_, AppState>) -> Result<PaneInfo, String> {
    spawn_shell_pane(&state)
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

    tauri::Builder::default()
        .setup({
            let state = state.clone();
            move |app| {
                state
                    .attach_app(app.handle().clone())
                    .map_err(std::io::Error::other)?;
                start_control_socket(state.clone()).map_err(std::io::Error::other)?;
                app.manage(state.clone());
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_config,
            list_panes,
            spawn_shell,
            spawn_claude,
            pane_write,
            pane_resize,
            pane_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running qmux");
}
