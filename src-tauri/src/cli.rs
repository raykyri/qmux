use serde::Deserialize;
use serde_json::{Value, json};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    ok: bool,
    data: Value,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedAgentLaunch {
    binary: String,
    cwd: String,
    args: Vec<String>,
    envs: Vec<PreparedLaunchEnv>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedLaunchEnv {
    key: String,
    value: String,
}

pub fn run_cli_if_requested() -> Result<bool, String> {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        return Ok(false);
    };

    match command.as_str() {
        "notify" => {
            let event = args
                .next()
                .ok_or_else(|| "usage: qmux notify <event>".to_string())?;
            let mut stdin = String::new();
            std::io::stdin()
                .read_to_string(&mut stdin)
                .map_err(|err| format!("failed to read stdin: {err}"))?;
            let payload = parse_payload(&stdin);
            request_silent(
                "hook.notify",
                json!({
                    "event": event,
                    "paneId": env::var("QMUX_PANE_ID").ok(),
                    "agentId": env::var("QMUX_AGENT_ID").ok(),
                    "payload": payload,
                }),
            )?;
            Ok(true)
        }
        "cwd" => {
            // Reports the shell pane's current directory so a restart can reopen it
            // where the user left off. The server binds the update to the pane that
            // owns the presented token, so the claimed paneId is advisory only.
            let cwd = env::current_dir()
                .map_err(|err| format!("failed to read current directory: {err}"))?;
            request_silent(
                "pane.set_cwd",
                json!({
                    "paneId": env::var("QMUX_PANE_ID").ok(),
                    "cwd": cwd.display().to_string(),
                }),
            )?;
            Ok(true)
        }
        "pane-write" => {
            let pane_id = args
                .next()
                .ok_or_else(|| "usage: qmux pane-write <pane-id> <text>".to_string())?;
            let data = args.collect::<Vec<_>>().join(" ");
            request_and_print(
                "pane.write",
                json!({
                    "paneId": pane_id,
                    "data": data,
                    "paste": true,
                    "submit": true,
                }),
            )?;
            Ok(true)
        }
        "agent-exec" => {
            let adapter_id = args
                .next()
                .ok_or_else(|| "usage: qmux agent-exec <adapter-id> [args...]".to_string())?;
            run_agent_exec(adapter_id, args.collect())?;
            Ok(true)
        }
        "claude" => {
            run_agent_exec("claude".to_string(), args.collect())?;
            Ok(true)
        }
        "codex" => {
            run_agent_exec("codex".to_string(), args.collect())?;
            Ok(true)
        }
        "ping" => {
            request_and_print("ping", json!({}))?;
            Ok(true)
        }
        "help" | "--help" | "-h" => {
            println!("usage: qmux [ping|notify|pane-write|cwd|agent-exec|claude|codex]");
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn run_agent_exec(adapter_id: String, args: Vec<String>) -> Result<(), String> {
    let pane_id = env::var("QMUX_PANE_ID")
        .map_err(|_| "QMUX_PANE_ID is not set; run this from a qmux shell pane".to_string())?;
    let cwd = env::current_dir()
        .map_err(|err| format!("failed to read current directory for agent launch: {err}"))?;
    let launch = request_value(
        "agent.prepare_shell_launch",
        json!({
            "adapterId": adapter_id,
            "paneId": pane_id,
            "cwd": cwd.display().to_string(),
            "args": args,
        }),
    )?;
    let launch = serde_json::from_value::<PreparedAgentLaunch>(launch)
        .map_err(|err| format!("invalid prepared agent launch response: {err}"))?;

    let mut command = Command::new(&launch.binary);
    command.args(launch.args).current_dir(&launch.cwd);
    for env in launch.envs {
        command.env(env.key, env.value);
    }

    let err = command.exec();
    Err(format!(
        "failed to launch agent binary '{}': {err}",
        launch.binary
    ))
}

fn request_silent(command: &str, payload: Value) -> Result<(), String> {
    request(command, payload).map(|_| ())
}

fn request_and_print(command: &str, payload: Value) -> Result<(), String> {
    let response = request(command, payload)?;
    println!("{response}");
    Ok(())
}

fn request_value(command: &str, payload: Value) -> Result<Value, String> {
    let raw = request(command, payload)?;
    let response = serde_json::from_str::<ControlResponse>(&raw)
        .map_err(|err| format!("invalid qmux response: {err}"))?;
    if response.ok {
        Ok(response.data)
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "qmux request failed".to_string()))
    }
}

fn request(command: &str, payload: Value) -> Result<String, String> {
    let socket_path = env::var("QMUX_SOCK").map_err(|_| "QMUX_SOCK is not set".to_string())?;
    let token = env::var("QMUX_TOKEN").map_err(|_| "QMUX_TOKEN is not set".to_string())?;
    let mut stream = UnixStream::connect(&socket_path)
        .map_err(|err| format!("failed to connect to {socket_path}: {err}"))?;
    let timeout = Some(Duration::from_secs(2));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let request = json!({
        "token": token,
        "command": command,
        "payload": payload,
    });

    serde_json::to_writer(&mut stream, &request)
        .map_err(|err| format!("failed to encode request: {err}"))?;
    stream
        .write_all(b"\n")
        .map_err(|err| format!("failed to send request: {err}"))?;
    stream
        .flush()
        .map_err(|err| format!("failed to flush request: {err}"))?;

    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|err| format!("failed to read response: {err}"))?;
    Ok(response.trim_end().to_string())
}

fn parse_payload(input: &str) -> Value {
    if input.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(input).unwrap_or_else(|_| Value::String(input.to_string()))
    }
}
