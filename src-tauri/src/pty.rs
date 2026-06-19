use crate::events::QmuxEvent;
use crate::state::{AppState, PaneInfo, PaneKind, PaneRuntime, PaneStatus, SharedChild};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

pub struct PtySpawnSpec {
    pub pane_id: Option<String>,
    pub agent_id: Option<String>,
    pub kind: PaneKind,
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub envs: Vec<(String, String)>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneWriteOptions {
    pub pane_id: String,
    pub data: String,
    pub paste: bool,
    pub submit: bool,
}

pub fn spawn_shell_pane(state: &AppState) -> Result<PaneInfo, String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let cwd = env::current_dir().map_err(|err| format!("failed to read cwd: {err}"))?;
    spawn_pty(
        state,
        PtySpawnSpec {
            pane_id: None,
            agent_id: None,
            kind: PaneKind::Shell,
            title: "Shell".to_string(),
            program: shell,
            args: Vec::new(),
            cwd,
            envs: Vec::new(),
        },
    )
}

pub fn spawn_pty(state: &AppState, spec: PtySpawnSpec) -> Result<PaneInfo, String> {
    let pane_id = spec.pane_id.unwrap_or_else(|| state.next_id("pane"));
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to open PTY: {err}"))?;

    let mut command = CommandBuilder::new(spec.program);
    command.args(spec.args);
    command.cwd(spec.cwd.clone());
    for (key, value) in spec.envs {
        command.env(key, value);
    }

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("failed to clone PTY reader: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("failed to open PTY writer: {err}"))?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("failed to spawn PTY command: {err}"))?;

    drop(pair.slave);

    let child = Arc::new(Mutex::new(child));
    let master = Arc::new(Mutex::new(pair.master));
    let writer = Arc::new(Mutex::new(writer));

    let pane = PaneInfo {
        id: pane_id.clone(),
        title: spec.title,
        kind: spec.kind,
        agent_id: spec.agent_id,
        cwd: spec.cwd.display().to_string(),
        cols: 100,
        rows: 24,
        status: PaneStatus::Running,
    };

    let runtime = PaneRuntime {
        info: pane.clone(),
        child: child.clone(),
        master,
        writer,
    };

    state.insert_pane(runtime)?;
    start_reader_thread(state.clone(), pane_id, reader);

    Ok(pane)
}

pub fn write_pane(state: &AppState, options: PaneWriteOptions) -> Result<(), String> {
    let writer = state
        .pane_writer(&options.pane_id)?
        .ok_or_else(|| format!("pane {} was not found", options.pane_id))?;
    let mut writer = writer
        .lock()
        .map_err(|_| format!("pane {} writer lock poisoned", options.pane_id))?;

    if options.paste {
        writer
            .write_all(b"\x1b[200~")
            .map_err(|err| format!("failed to write paste start: {err}"))?;
        writer
            .write_all(options.data.as_bytes())
            .map_err(|err| format!("failed to write paste data: {err}"))?;
        writer
            .write_all(b"\x1b[201~")
            .map_err(|err| format!("failed to write paste end: {err}"))?;
        if options.submit {
            writer
                .write_all(b"\r")
                .map_err(|err| format!("failed to submit paste: {err}"))?;
        }
    } else {
        writer
            .write_all(options.data.as_bytes())
            .map_err(|err| format!("failed to write to pane: {err}"))?;
    }

    writer
        .flush()
        .map_err(|err| format!("failed to flush pane input: {err}"))
}

pub fn resize_pane(state: &AppState, pane_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let master = state
        .pane_master(&pane_id)?
        .ok_or_else(|| format!("pane {pane_id} was not found"))?;
    let mut master = master
        .lock()
        .map_err(|_| format!("pane {pane_id} master lock poisoned"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to resize pane {pane_id}: {err}"))?;
    state.update_pane_size(&pane_id, cols, rows)
}

pub fn kill_pane(state: &AppState, pane_id: String) -> Result<(), String> {
    let child = state
        .pane_child(&pane_id)?
        .ok_or_else(|| format!("pane {pane_id} was not found"))?;
    kill_child(&pane_id, child)?;
    state.mark_pane_status(&pane_id, PaneStatus::Killed)
}

fn start_reader_thread(state: AppState, pane_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&buffer[..count]).to_string();
                    state.emit(QmuxEvent::pty_data(pane_id.clone(), data));
                }
                Err(err) => {
                    state.emit(QmuxEvent::new(
                        "pty.read_error",
                        Some(pane_id.clone()),
                        None,
                        serde_json::json!({ "error": err.to_string() }),
                    ));
                    break;
                }
            }
        }
        let _ = state.mark_pane_status(&pane_id, PaneStatus::Exited);
        state.emit(QmuxEvent::pty_exit(pane_id, None));
    });
}

fn kill_child(pane_id: &str, child: SharedChild) -> Result<(), String> {
    let mut child = child
        .lock()
        .map_err(|_| format!("pane {pane_id} child lock poisoned"))?;

    if let Some(pid) = child.process_id() {
        let group = format!("-{}", pid);
        let _ = std::process::Command::new("/bin/kill")
            .arg("-TERM")
            .arg(&group)
            .status();
    }

    child
        .kill()
        .map_err(|err| format!("failed to kill pane {pane_id}: {err}"))
}
