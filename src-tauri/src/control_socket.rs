use crate::claude::{SpawnClaudeRequest, spawn_claude_pane};
use crate::events::QmuxEvent;
use crate::hooks::{HookNotification, ingest_hook_notification};
use crate::pty::{PaneWriteOptions, write_pane};
use crate::state::AppState;
use crate::turn_queue::{SubmitAgentTurnRequest, submit_agent_turn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
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
    if request.token != state.token() {
        return Err("invalid QMUX_TOKEN".to_string());
    }

    match request.command.as_str() {
        "ping" => Ok(json!({ "status": "ok" })),
        "pane.write" => {
            let options = serde_json::from_value::<PaneWriteOptions>(request.payload)
                .map_err(|err| format!("invalid pane.write payload: {err}"))?;
            write_pane(state, options)?;
            Ok(json!({ "written": true }))
        }
        "agent.spawn" => {
            let spawn = serde_json::from_value::<SpawnClaudeRequest>(request.payload)
                .map_err(|err| format!("invalid agent.spawn payload: {err}"))?;
            let pane = spawn_claude_pane(state, spawn)?;
            serde_json::to_value(pane).map_err(|err| format!("failed to encode pane: {err}"))
        }
        "agent.submit_turn" => {
            let submit = serde_json::from_value::<SubmitAgentTurnRequest>(request.payload)
                .map_err(|err| format!("invalid agent.submit_turn payload: {err}"))?;
            let result = submit_agent_turn(state, submit)?;
            serde_json::to_value(result)
                .map_err(|err| format!("failed to encode submit result: {err}"))
        }
        "hook.notify" => {
            let notification = serde_json::from_value::<HookNotification>(request.payload)
                .map_err(|err| format!("invalid hook.notify payload: {err}"))?;
            let event = ingest_hook_notification(state, notification)?;
            state.emit(event);
            Ok(json!({ "notified": true }))
        }
        other => Err(format!("unknown control command '{other}'")),
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
