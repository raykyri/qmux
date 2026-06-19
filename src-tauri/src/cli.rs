use serde_json::{Value, json};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;

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
            request(
                "hook.notify",
                json!({
                    "event": event,
                    "paneId": env::var("QMUX_PANE_ID").ok(),
                    "payload": payload,
                }),
            )?;
            Ok(true)
        }
        "pane-write" => {
            let pane_id = args
                .next()
                .ok_or_else(|| "usage: qmux pane-write <pane-id> <text>".to_string())?;
            let data = args.collect::<Vec<_>>().join(" ");
            request(
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
        "ping" => {
            request("ping", json!({}))?;
            Ok(true)
        }
        "help" | "--help" | "-h" => {
            println!("usage: qmux [ping|notify|pane-write]");
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn request(command: &str, payload: Value) -> Result<(), String> {
    let socket_path = env::var("QMUX_SOCK").map_err(|_| "QMUX_SOCK is not set".to_string())?;
    let token = env::var("QMUX_TOKEN").map_err(|_| "QMUX_TOKEN is not set".to_string())?;
    let mut stream = UnixStream::connect(&socket_path)
        .map_err(|err| format!("failed to connect to {socket_path}: {err}"))?;
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
    println!("{}", response.trim_end());
    Ok(())
}

fn parse_payload(input: &str) -> Value {
    if input.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(input).unwrap_or_else(|_| Value::String(input.to_string()))
    }
}
