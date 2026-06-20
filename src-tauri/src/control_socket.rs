use crate::claude::{PrepareShellClaudeLaunchRequest, prepare_shell_claude_launch};
use crate::events::QmuxEvent;
use crate::hooks::{HookNotification, ingest_hook_notification};
use crate::pty::{PaneWriteOptions, write_pane};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::thread;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    token: String,
    command: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    ok: bool,
    data: Value,
    error: Option<String>,
}

pub fn start_control_socket(state: AppState) -> Result<(), String> {
    let socket_path = state.config().socket_path.clone();
    if socket_path.exists() {
        fs::remove_file(&socket_path).map_err(|err| {
            format!(
                "failed to remove stale socket {}: {err}",
                socket_path.display()
            )
        })?;
    }

    let listener = UnixListener::bind(&socket_path)
        .map_err(|err| format!("failed to bind socket {}: {err}", socket_path.display()))?;

    // Restrict the socket to the owning user so the per-pane token is not the only thing
    // standing between other local accounts and the control plane.
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)).map_err(|err| {
        format!(
            "failed to restrict socket permissions {}: {err}",
            socket_path.display()
        )
    })?;

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let state = state.clone();
                    thread::spawn(move || handle_client(state, stream));
                }
                Err(err) => {
                    state.emit(QmuxEvent::new(
                        "socket.error",
                        None,
                        None,
                        json!({ "error": err.to_string() }),
                    ));
                }
            }
        }
    });

    Ok(())
}

fn handle_client(state: AppState, mut stream: UnixStream) {
    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(err) => {
            let _ = write_response(&mut stream, Err(format!("failed to clone socket: {err}")));
            return;
        }
    };
    let reader = BufReader::new(reader_stream);

    for line in reader.lines() {
        let result = match line {
            Ok(line) => handle_line(&state, &line),
            Err(err) => Err(format!("failed to read socket request: {err}")),
        };

        if write_response(&mut stream, result).is_err() {
            return;
        }
    }
}

fn handle_line(state: &AppState, line: &str) -> Result<Value, String> {
    let request: ControlRequest =
        serde_json::from_str(line).map_err(|err| format!("invalid control request: {err}"))?;
    // A control token authorizes exactly one pane. Resolving it here means every
    // command below acts only on the caller's own pane: a process in one pane cannot
    // write to, or impersonate hooks for, any other pane.
    let authed_pane = state
        .pane_for_token(&request.token)
        .ok_or_else(|| "invalid QMUX_TOKEN".to_string())?;

    match request.command.as_str() {
        "ping" => Ok(json!({ "status": "ok" })),
        "pane.write" => {
            let options = serde_json::from_value::<PaneWriteOptions>(request.payload)
                .map_err(|err| format!("invalid pane.write payload: {err}"))?;
            ensure_pane_scope(&authed_pane, &options.pane_id)?;
            write_pane(state, options)?;
            Ok(json!({ "written": true }))
        }
        "pane.set_cwd" => {
            #[derive(Debug, Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SetCwdPayload {
                cwd: String,
            }
            let payload = serde_json::from_value::<SetCwdPayload>(request.payload)
                .map_err(|err| format!("invalid pane.set_cwd payload: {err}"))?;
            // Bind the cwd update to the authenticated pane regardless of any claimed
            // paneId, mirroring hook.notify's scoping.
            state.update_pane_cwd(&authed_pane, payload.cwd)?;
            Ok(json!({ "updated": true }))
        }
        "claude.prepare_shell_launch" => {
            let launch = serde_json::from_value::<PrepareShellClaudeLaunchRequest>(request.payload)
                .map_err(|err| format!("invalid claude.prepare_shell_launch payload: {err}"))?;
            ensure_pane_scope(&authed_pane, &launch.pane_id)?;
            let prepared = prepare_shell_claude_launch(state, launch)?;
            serde_json::to_value(prepared)
                .map_err(|err| format!("failed to encode prepared Claude launch: {err}"))
        }
        "hook.notify" => {
            let mut notification = serde_json::from_value::<HookNotification>(request.payload)
                .map_err(|err| format!("invalid hook.notify payload: {err}"))?;
            // Bind the notification to the authenticated pane regardless of what the
            // caller claims, so hook status can only be reported for its own pane.
            notification.pane_id = Some(authed_pane.clone());
            if let Some(agent_id) = notification.agent_id.as_deref() {
                ensure_agent_scope(state, &authed_pane, agent_id)?;
            }
            let event = ingest_hook_notification(state, notification)?;
            state.emit(event);
            Ok(json!({ "notified": true }))
        }
        // Spawning agents and queueing turns are management operations that belong to the
        // trusted GUI (Tauri commands), not to processes holding a pane token.
        other => Err(format!("unknown control command '{other}'")),
    }
}

fn ensure_pane_scope(authed_pane: &str, requested_pane: &str) -> Result<(), String> {
    if authed_pane == requested_pane {
        Ok(())
    } else {
        Err("control token is not authorized for that pane".to_string())
    }
}

fn ensure_agent_scope(state: &AppState, authed_pane: &str, agent_id: &str) -> Result<(), String> {
    let agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    if agent.pane_id.as_deref() == Some(authed_pane) {
        Ok(())
    } else {
        Err("control token is not authorized for that agent".to_string())
    }
}

fn write_response(stream: &mut UnixStream, result: Result<Value, String>) -> std::io::Result<()> {
    let response = match result {
        Ok(data) => ControlResponse {
            ok: true,
            data,
            error: None,
        },
        Err(error) => ControlResponse {
            ok: false,
            data: Value::Null,
            error: Some(error),
        },
    };
    serde_json::to_writer(&mut *stream, &response)?;
    stream.write_all(b"\n")?;
    stream.flush()
}
