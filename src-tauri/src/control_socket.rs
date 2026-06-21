use crate::adapters::{
    AdapterNotification, PrepareShellAgentLaunchRequest, PrepareShellClaudeLaunchRequest,
    agent_fork, agent_prepare_shell_launch, ingest_adapter_notification,
};
use crate::events::QmuxEvent;
use crate::pty::{PaneWriteOptions, write_pane};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::thread;
use std::time::Duration;

const CONTROL_SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    token: String,
    command: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    ok: bool,
    data: Value,
    error: Option<String>,
}

pub fn start_control_socket(state: AppState) -> Result<(), String> {
    let socket_path = state.config().socket_path.clone();

    // Restrict the socket's parent directory to the owning user *before* binding.
    // With the directory untraversable by other accounts, the socket is never
    // reachable by them even during the brief window between bind() and the
    // explicit chmod below, and no other user can pre-create the socket path.
    // Config sets this best-effort at startup; enforce it strictly here so we
    // fail loudly rather than expose the control plane on a world-traversable dir.
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create socket dir {}: {err}", parent.display()))?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|err| format!("failed to restrict socket dir {}: {err}", parent.display()))?;
    }

    // Remove any stale socket unconditionally; a missing path is not an error.
    // Probing with exists() first would open a time-of-check/time-of-use window.
    match fs::remove_file(&socket_path) {
        Ok(()) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "failed to remove stale socket {}: {err}",
                socket_path.display()
            ));
        }
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

fn handle_client(state: AppState, stream: UnixStream) {
    handle_client_with_timeout(state, stream, CONTROL_SOCKET_READ_TIMEOUT);
}

fn handle_client_with_timeout(state: AppState, mut stream: UnixStream, read_timeout: Duration) {
    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(err) => {
            let _ = write_response(&mut stream, Err(format!("failed to clone socket: {err}")));
            return;
        }
    };
    if let Err(err) = reader_stream.set_read_timeout(Some(read_timeout)) {
        let _ = write_response(
            &mut stream,
            Err(format!("failed to set socket read timeout: {err}")),
        );
        return;
    }
    let reader = BufReader::new(reader_stream);

    for line in reader.lines() {
        let result = match line {
            Ok(line) => handle_line(&state, &line),
            Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return;
            }
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
        "agent.prepare_shell_launch" => {
            let launch = serde_json::from_value::<PrepareShellAgentLaunchRequest>(request.payload)
                .map_err(|err| format!("invalid agent.prepare_shell_launch payload: {err}"))?;
            ensure_pane_scope(&authed_pane, &launch.pane_id)?;
            let prepared = agent_prepare_shell_launch(state, launch)?;
            serde_json::to_value(prepared)
                .map_err(|err| format!("failed to encode prepared agent launch: {err}"))
        }
        "claude.prepare_shell_launch" => {
            let launch = serde_json::from_value::<PrepareShellClaudeLaunchRequest>(request.payload)
                .map_err(|err| format!("invalid claude.prepare_shell_launch payload: {err}"))?;
            ensure_pane_scope(&authed_pane, &launch.pane_id)?;
            let prepared = agent_prepare_shell_launch(
                state,
                PrepareShellAgentLaunchRequest {
                    adapter_id: "claude".to_string(),
                    pane_id: launch.pane_id,
                    cwd: launch.cwd,
                    args: launch.args,
                },
            )?;
            let settings_path = prepared
                .args
                .windows(2)
                .find_map(|args| (args[0] == "--settings").then(|| args[1].clone()))
                .ok_or_else(|| "prepared Claude launch did not include --settings".to_string())?;
            Ok(json!({
                "claudeBinary": prepared.binary,
                "cwd": prepared.cwd,
                "settingsPath": settings_path,
                "envs": prepared.envs,
            }))
        }
        "hook.notify" => {
            let mut notification = serde_json::from_value::<AdapterNotification>(request.payload)
                .map_err(|err| format!("invalid hook.notify payload: {err}"))?;
            // Bind the notification to the authenticated pane regardless of what the
            // caller claims, so hook status can only be reported for its own pane.
            notification.pane_id = Some(authed_pane.clone());
            if let Some(agent_id) = notification.agent_id.as_deref() {
                ensure_agent_scope(state, &authed_pane, agent_id)?;
            }
            let outcome = ingest_adapter_notification(state, notification)?;
            for event in outcome.into_events() {
                state.emit(event);
            }
            Ok(json!({ "notified": true }))
        }
        "agent.fork" => {
            #[derive(Debug, Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ForkPayload {
                #[serde(default)]
                use_worktree: bool,
            }
            let payload = serde_json::from_value::<ForkPayload>(request.payload)
                .map_err(|err| format!("invalid agent.fork payload: {err}"))?;
            // The one spawn the control plane allows: it forks ONLY the authenticated
            // pane's own session (the source is resolved from the token, not the
            // payload), so a token can never spawn off another pane's session. This is
            // the same authority the user already has acting in their own terminal.
            let pane = agent_fork(state, &authed_pane, payload.use_worktree)?;
            serde_json::to_value(pane).map_err(|err| format!("failed to encode forked pane: {err}"))
        }
        "browser.open" => {
            #[derive(Debug, Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct BrowserOpen {
                target: String,
                #[serde(default)]
                cwd: Option<String>,
            }
            let payload = serde_json::from_value::<BrowserOpen>(request.payload)
                .map_err(|err| format!("invalid browser.open payload: {err}"))?;
            // Resolve to a renderable URL: http(s) passes through (CSP gates it to
            // loopback); a file is validated under an allowed root and served via the
            // loopback file server. The overlay binds to the calling pane. `sandbox` is
            // true for served files so the overlay loads them in an opaque origin (the
            // served URL carries the access token, so its scripts must not be able to
            // read other files back); passthrough URLs are not sandboxed.
            let (url, sandbox) = resolve_browser_target(
                state,
                &authed_pane,
                payload.target.trim(),
                payload.cwd.as_deref(),
            )?;
            state.emit(QmuxEvent::new(
                "browser.open",
                Some(authed_pane.clone()),
                None,
                json!({ "url": url, "sandbox": sandbox }),
            ));
            Ok(json!({ "url": url, "sandbox": sandbox }))
        }
        // Other agent spawning and turn queueing are management operations that belong
        // to the trusted GUI (Tauri commands), not to processes holding a pane token.
        other => Err(format!("unknown control command '{other}'")),
    }
}

/// Turns an `open` target into a URL the browser overlay can load, plus whether the
/// overlay should sandbox it. http(s) URLs pass through unchanged and unsandboxed
/// (covering localhost dev servers; the webview CSP restricts which actually render).
/// Anything else is treated as a file path: resolved against `cwd` when relative,
/// required to live under one of the requesting pane's own roots (not the global
/// union — so a pane can't open another pane's directory), served through the loopback
/// file server, and flagged `sandbox = true` (its URL carries the file-server token).
fn resolve_browser_target(
    state: &AppState,
    authed_pane: &str,
    target: &str,
    cwd: Option<&str>,
) -> Result<(String, bool), String> {
    if target.is_empty() {
        return Err("nothing to open".to_string());
    }
    if target.starts_with("http://") || target.starts_with("https://") {
        return Ok((target.to_string(), false));
    }

    let requested = {
        let path = std::path::Path::new(target);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            let base = cwd.ok_or_else(|| {
                "cannot resolve a relative path without a working directory".to_string()
            })?;
            std::path::Path::new(base).join(path)
        }
    };

    let roots = state.pane_file_roots(authed_pane);
    let canonical =
        crate::file_server::resolve_under_roots(&requested, &roots).ok_or_else(|| {
            format!(
                "'{target}' was not found under this pane's working directory and cannot be opened"
            )
        })?;
    let (port, token) = state
        .file_server_info()
        .ok_or_else(|| "the file server is not running".to_string())?;
    Ok((crate::file_server::file_url(port, &token, &canonical), true))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, QmuxConfig};
    use crate::workspace::{AgentInfo, AgentStatus};
    use std::io::Read;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_state() -> AppState {
        AppState::new(QmuxConfig {
            workspace_root: temp_dir(),
            socket_path: PathBuf::from("/tmp/qmux-control-test.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: std::path::PathBuf::new(),
        })
    }

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-control-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn agent_bound_to(pane_id: &str) -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/agent-1".to_string(),
            branch: None,
            pane_id: Some(pane_id.to_string()),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Running,
            model: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            paused: false,
            created_at: 0,
        }
    }

    fn request_line(token: &str, command: &str, payload: Value) -> String {
        json!({ "token": token, "command": command, "payload": payload }).to_string()
    }

    #[test]
    fn handle_line_rejects_an_unknown_token() {
        let state = test_state();
        let err = handle_line(&state, &request_line("nope", "ping", Value::Null)).unwrap_err();
        assert!(
            err.contains("invalid QMUX_TOKEN"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn handle_line_accepts_ping_from_a_valid_token() {
        let state = test_state();
        let token = state.pane_token("pane-1").unwrap();
        let data = handle_line(&state, &request_line(&token, "ping", Value::Null)).unwrap();
        assert_eq!(data, json!({ "status": "ok" }));
    }

    #[test]
    fn pane_write_rejects_a_cross_pane_token() {
        let state = test_state();
        // pane-1's token must not be able to drive pane-2.
        let token = state.pane_token("pane-1").unwrap();
        let payload = json!({ "paneId": "pane-2", "data": "x", "paste": false, "submit": false });
        let err = handle_line(&state, &request_line(&token, "pane.write", payload)).unwrap_err();
        assert!(
            err.contains("not authorized for that pane"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn hook_notify_rejects_a_token_for_another_agents_pane() {
        let state = test_state();
        // The agent lives in pane-2, but the caller presents pane-1's token.
        state.insert_agent(agent_bound_to("pane-2")).unwrap();
        let token = state.pane_token("pane-1").unwrap();
        let payload = json!({ "event": "Stop", "agentId": "agent-1", "payload": Value::Null });
        let err = handle_line(&state, &request_line(&token, "hook.notify", payload)).unwrap_err();
        assert!(
            err.contains("not authorized for that agent"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn handle_line_rejects_an_unknown_command() {
        let state = test_state();
        let token = state.pane_token("pane-1").unwrap();
        let err = handle_line(&state, &request_line(&token, "bogus", Value::Null)).unwrap_err();
        assert!(
            err.contains("unknown control command"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn partial_request_times_out_server_reader() {
        let state = test_state();
        let (mut client, server) = UnixStream::pair().unwrap();
        let (done_tx, done_rx) = mpsc::channel();

        thread::spawn(move || {
            handle_client_with_timeout(state, server, Duration::from_millis(50));
            done_tx.send(()).unwrap();
        });

        client.write_all(b"{").unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("server reader should exit after the read timeout");

        let mut buf = [0_u8; 1];
        assert_eq!(client.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn complete_request_still_receives_response() {
        let state = test_state();
        let token = state.pane_token("pane-1").unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        let (done_tx, done_rx) = mpsc::channel();

        thread::spawn(move || {
            handle_client_with_timeout(state, server, Duration::from_secs(1));
            done_tx.send(()).unwrap();
        });

        let request = json!({
            "token": token,
            "command": "ping",
            "payload": Value::Null,
        });
        serde_json::to_writer(&mut client, &request).unwrap();
        client.write_all(b"\n").unwrap();
        client.flush().unwrap();

        let mut response = String::new();
        BufReader::new(client.try_clone().unwrap())
            .read_line(&mut response)
            .unwrap();
        let response = serde_json::from_str::<ControlResponse>(&response).unwrap();
        assert!(response.ok);
        assert_eq!(response.data, json!({ "status": "ok" }));

        drop(client);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("server reader should exit after the client closes");
    }
}
