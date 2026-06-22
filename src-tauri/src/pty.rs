use crate::adapters::{ShellCommandIntegration, adapter_registry};
use crate::events::QmuxEvent;
use crate::scrollback::append_pane_scrollback;
use crate::state::{
    AppState, PaneInfo, PaneKind, PaneRuntime, PaneStatus, SharedBacklog, SharedChild,
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Deserialize;
use std::env;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const SUBMIT_KEY: &[u8] = b"\r";
const SUBMIT_KEY_DELAY: Duration = Duration::from_millis(15);
const DEFAULT_PTY_COLS: u16 = 100;
const DEFAULT_PTY_ROWS: u16 = 24;
const MIN_INITIAL_COLS: u16 = 20;
const MIN_INITIAL_ROWS: u16 = 5;
const MAX_INITIAL_COLS: u16 = 500;
const MAX_INITIAL_ROWS: u16 = 200;
/// Cap on PTY output buffered before the frontend attaches. Only a prompt (or a
/// recovered pane's startup banner) is ever expected here; the cap just bounds a
/// pathological pre-attach burst, keeping the most recent bytes.
const BACKLOG_CAP: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InitialPaneSize {
    pub cols: u16,
    pub rows: u16,
}

pub struct PtySpawnSpec {
    pub pane_id: Option<String>,
    pub agent_id: Option<String>,
    pub kind: PaneKind,
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub envs: Vec<(String, String)>,
    pub initial_size: Option<InitialPaneSize>,
    pub recovered: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneWriteOptions {
    pub pane_id: String,
    pub data: String,
    pub paste: bool,
    pub submit: bool,
}

pub fn spawn_shell_pane(
    state: &AppState,
    initial_size: Option<InitialPaneSize>,
) -> Result<PaneInfo, String> {
    let cwd = env::current_dir().map_err(|err| format!("failed to read cwd: {err}"))?;
    let pane_id = state.next_id("pane");
    spawn_pty(
        state,
        shell_spawn_spec(state, pane_id, cwd, initial_size, false)?,
    )
}

/// Recreates a previously persisted shell pane: same pane id (so UI mappings and
/// queues keep lining up), reopened in its last-known cwd when that still exists,
/// at its persisted geometry. Marked recovered so the UI can label it.
pub fn respawn_shell_pane(state: &AppState, pane: &PaneInfo) -> Result<PaneInfo, String> {
    let cwd = recoverable_dir(&pane.cwd)
        .or_else(|| env::current_dir().ok())
        .ok_or_else(|| "no usable working directory for recovered shell".to_string())?;
    let initial_size = Some(InitialPaneSize {
        cols: pane.cols,
        rows: pane.rows,
    });
    spawn_pty(
        state,
        shell_spawn_spec(state, pane.id.clone(), cwd, initial_size, true)?,
    )
}

/// Builds the spawn spec for a shell pane, including adapter wrapper-function
/// injection. Shared by fresh spawns and recovery respawns so both stay in sync.
fn shell_spawn_spec(
    state: &AppState,
    pane_id: String,
    cwd: PathBuf,
    initial_size: Option<InitialPaneSize>,
    recovered: bool,
) -> Result<PtySpawnSpec, String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut envs = shell_pane_envs(state, &pane_id)?;
    let mut args = Vec::new();

    let shell_commands = adapter_registry(state.config()).shell_commands();
    match agent_shell_function_injection(&shell, &pane_id, &shell_commands) {
        Ok(Some(injection)) => {
            args = injection.args;
            envs.extend(injection.envs);
            envs.push(("QMUX_AGENT_FUNCTIONS".to_string(), "1".to_string()));
        }
        Ok(None) => {
            envs.push((
                "QMUX_AGENT_FUNCTIONS".to_string(),
                "unsupported".to_string(),
            ));
        }
        Err(err) => {
            envs.push(("QMUX_AGENT_FUNCTIONS".to_string(), "failed".to_string()));
            envs.push(("QMUX_AGENT_FUNCTIONS_ERROR".to_string(), err));
        }
    }

    Ok(PtySpawnSpec {
        pane_id: Some(pane_id),
        agent_id: None,
        kind: PaneKind::Shell,
        title: "Shell".to_string(),
        program: shell,
        args,
        cwd,
        envs,
        initial_size,
        recovered,
    })
}

/// Returns the path only when it still resolves to a directory, so recovery can
/// fall back gracefully when a persisted cwd or worktree has since been removed.
pub fn recoverable_dir(path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    path.is_dir().then_some(path)
}

pub fn qmux_pane_envs(state: &AppState, pane_id: &str) -> Result<Vec<(String, String)>, String> {
    let mut envs = vec![
        ("QMUX_PANE_ID".to_string(), pane_id.to_string()),
        (
            "QMUX_SOCK".to_string(),
            state.config().socket_path.display().to_string(),
        ),
        ("QMUX_TOKEN".to_string(), state.pane_token(pane_id)?),
        (
            "QMUX_WORKSPACE_ROOT".to_string(),
            state.config().workspace_root.display().to_string(),
        ),
    ];
    // Expose the qmux executable so in-pane tooling (e.g. the fork skill) can call it
    // without depending on `qmux` being on PATH. Best-effort: omitted if unresolved.
    if let Ok(exe) = std::env::current_exe() {
        envs.push(("QMUX_CLI".to_string(), exe.display().to_string()));
    }
    Ok(envs)
}

fn shell_pane_envs(state: &AppState, pane_id: &str) -> Result<Vec<(String, String)>, String> {
    let mut envs = qmux_pane_envs(state, pane_id)?;
    envs.push(("QMUX_SHELL_INTEGRATION".to_string(), "1".to_string()));
    Ok(envs)
}

struct ShellFunctionInjection {
    args: Vec<String>,
    envs: Vec<(String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShellKind {
    Bash,
    Zsh,
    Unsupported,
}

/// Per-pane scratch directory holding generated shell rc files. The location is
/// derived purely from the pane id so teardown can find it without consulting
/// pane state.
fn shell_integration_dir(pane_id: &str) -> PathBuf {
    env::temp_dir().join("qmux-shell-init").join(pane_id)
}

/// Creates the per-pane shell integration directory restricted to the owning
/// user. The shared parent is locked to `0o700` first so other local accounts
/// cannot pre-create (or symlink) a pane's subdirectory and redirect the rc
/// files we are about to write; the per-pane dir is then created `0o700` too so
/// its generated scripts are never world-readable in a shared /tmp.
fn create_shell_integration_dir(pane_id: &str) -> Result<PathBuf, String> {
    let parent = env::temp_dir().join("qmux-shell-init");
    fs::create_dir_all(&parent).map_err(|err| {
        format!(
            "failed to create shell integration root {}: {err}",
            parent.display()
        )
    })?;
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).map_err(|err| {
        format!(
            "failed to restrict shell integration root {}: {err}",
            parent.display()
        )
    })?;

    let root = parent.join(pane_id);
    fs::create_dir_all(&root).map_err(|err| {
        format!(
            "failed to create shell integration dir {}: {err}",
            root.display()
        )
    })?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|err| {
        format!(
            "failed to restrict shell integration dir {}: {err}",
            root.display()
        )
    })?;
    Ok(root)
}

/// Removes a pane's shell integration scratch directory on teardown. Best
/// effort: a missing directory (non-shell pane, or one that never spawned a
/// supported shell) is expected and ignored.
fn remove_shell_integration_dir(pane_id: &str) {
    let root = shell_integration_dir(pane_id);
    match fs::remove_dir_all(&root) {
        Ok(()) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            // A stale scratch dir is non-fatal and not worth surfacing to the UI.
            eprintln!(
                "qmux: failed to clean up shell integration dir {}: {err}",
                root.display()
            );
        }
    }
}

fn agent_shell_function_injection(
    shell: &str,
    pane_id: &str,
    shell_commands: &[ShellCommandIntegration],
) -> Result<Option<ShellFunctionInjection>, String> {
    let shell_kind = shell_kind(shell);
    if matches!(shell_kind, ShellKind::Unsupported) {
        return Ok(None);
    }

    let qmux_cli = env::current_exe()
        .map_err(|err| format!("failed to resolve qmux executable for shell integration: {err}"))?;
    let root = create_shell_integration_dir(pane_id)?;

    match shell_kind {
        ShellKind::Zsh => {
            let zdotdir = root.join("zsh");
            fs::create_dir_all(&zdotdir).map_err(|err| {
                format!(
                    "failed to create zsh integration dir {}: {err}",
                    zdotdir.display()
                )
            })?;
            let rcfile = zdotdir.join(".zshrc");
            fs::write(&rcfile, zsh_init_script(&qmux_cli, shell_commands)).map_err(|err| {
                format!(
                    "failed to write zsh integration file {}: {err}",
                    rcfile.display()
                )
            })?;
            let mut envs = vec![("ZDOTDIR".to_string(), zdotdir.display().to_string())];
            if let Some(zdotdir) = original_zdotdir() {
                envs.push(("QMUX_ORIGINAL_ZDOTDIR".to_string(), zdotdir));
            }
            Ok(Some(ShellFunctionInjection {
                args: vec!["-i".to_string()],
                envs,
            }))
        }
        ShellKind::Bash => {
            let rcfile = root.join("bashrc");
            fs::write(&rcfile, bash_init_script(&qmux_cli, shell_commands)).map_err(|err| {
                format!(
                    "failed to write bash integration file {}: {err}",
                    rcfile.display()
                )
            })?;
            let mut envs = Vec::new();
            if let Some(bashrc) = original_bashrc() {
                envs.push(("QMUX_ORIGINAL_BASHRC".to_string(), bashrc));
            }
            Ok(Some(ShellFunctionInjection {
                args: vec![
                    "--rcfile".to_string(),
                    rcfile.display().to_string(),
                    "-i".to_string(),
                ],
                envs,
            }))
        }
        ShellKind::Unsupported => Ok(None),
    }
}

fn shell_kind(shell: &str) -> ShellKind {
    match Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
    {
        "bash" => ShellKind::Bash,
        "zsh" => ShellKind::Zsh,
        _ => ShellKind::Unsupported,
    }
}

fn zsh_init_script(qmux_cli: &Path, shell_commands: &[ShellCommandIntegration]) -> String {
    let cli = shell_quote(qmux_cli);
    let qmux_function = shell_qmux_function(&cli);
    let agent_functions = shell_agent_functions(&cli, shell_commands);
    format!(
        r#"# Generated by qmux. Do not edit.
if [ -n "${{QMUX_ORIGINAL_ZDOTDIR:-}}" ]; then
  export ZDOTDIR="$QMUX_ORIGINAL_ZDOTDIR"
  if [ -r "$ZDOTDIR/.zshrc" ]; then
    source "$ZDOTDIR/.zshrc"
  fi
fi
{qmux_function}
{agent_functions}
if [ -n "${{QMUX_PANE_ID:-}}" ]; then
  typeset -g __qmux_last_pwd=""
  __qmux_report_cwd() {{
    if [ "$PWD" != "$__qmux_last_pwd" ]; then
      __qmux_last_pwd="$PWD"
      {cli} cwd >/dev/null 2>&1
    fi
  }}
  autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __qmux_report_cwd
fi
"#,
    )
}

fn bash_init_script(qmux_cli: &Path, shell_commands: &[ShellCommandIntegration]) -> String {
    let cli = shell_quote(qmux_cli);
    let qmux_function = shell_qmux_function(&cli);
    let agent_functions = shell_agent_functions(&cli, shell_commands);
    format!(
        r#"# Generated by qmux. Do not edit.
if [ -n "${{QMUX_ORIGINAL_BASHRC:-}}" ] && [ -r "$QMUX_ORIGINAL_BASHRC" ]; then
  . "$QMUX_ORIGINAL_BASHRC"
fi
{qmux_function}
{agent_functions}
if [ -n "${{QMUX_PANE_ID:-}}" ]; then
  __qmux_last_pwd=""
  __qmux_report_cwd() {{
    if [ "$PWD" != "$__qmux_last_pwd" ]; then
      __qmux_last_pwd="$PWD"
      {cli} cwd >/dev/null 2>&1
    fi
  }}
  case "$PROMPT_COMMAND" in
    *__qmux_report_cwd*) ;;
    *) PROMPT_COMMAND="__qmux_report_cwd${{PROMPT_COMMAND:+; $PROMPT_COMMAND}}" ;;
  esac
fi
"#,
    )
}

fn shell_agent_functions(cli: &str, shell_commands: &[ShellCommandIntegration]) -> String {
    shell_commands
        .iter()
        .map(|command| {
            // After the agent process exits, detach it from this pane so the tab reverts
            // to a plain shell. The agent's `exec`d process owns the foreground while it
            // runs, so the shell only reaches the detach once it has exited (whether via
            // ctrl-c, /exit, or a crash) — covering the case where a never-used agent's
            // synthetic "awaiting input" status would otherwise stick to the tab forever.
            // `$?` is preserved so the wrapper is transparent to the caller's exit code.
            format!(
                "unalias {name} 2>/dev/null || true\n{name}() {{\n  {cli} agent-exec {adapter} \"$@\"\n  local __qmux_status=$?\n  {cli} agent-detach >/dev/null 2>&1\n  return $__qmux_status\n}}",
                name = command.command_name,
                adapter = command.adapter_id,
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Defines `qmux` as a passthrough to the bundled CLI so the user can run subcommands
/// (e.g. `qmux open <file>` to load a file in the browser overlay) from the shell
/// prompt without `qmux` being on PATH — mirroring the injected agent functions.
fn shell_qmux_function(cli: &str) -> String {
    format!("unalias qmux 2>/dev/null || true\nqmux() {{\n  {cli} \"$@\"\n}}")
}

fn original_zdotdir() -> Option<String> {
    env::var("ZDOTDIR").ok().or_else(|| env::var("HOME").ok())
}

fn original_bashrc() -> Option<String> {
    env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".bashrc").display().to_string())
}

fn shell_quote(path: &Path) -> String {
    let raw = path.display().to_string();
    format!("'{}'", raw.replace('\'', "'\\''"))
}

fn resolved_initial_size(initial_size: Option<InitialPaneSize>) -> InitialPaneSize {
    let size = initial_size.unwrap_or(InitialPaneSize {
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS,
    });

    InitialPaneSize {
        cols: size.cols.clamp(MIN_INITIAL_COLS, MAX_INITIAL_COLS),
        rows: size.rows.clamp(MIN_INITIAL_ROWS, MAX_INITIAL_ROWS),
    }
}

pub fn spawn_pty(state: &AppState, spec: PtySpawnSpec) -> Result<PaneInfo, String> {
    let pane_id = spec.pane_id.unwrap_or_else(|| state.next_id("pane"));
    let initial_size = resolved_initial_size(spec.initial_size);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: initial_size.rows,
            cols: initial_size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to open PTY: {err}"))?;

    let mut command = CommandBuilder::new(spec.program);
    command.args(spec.args);
    command.cwd(spec.cwd.clone());
    if let Some(path) = crate::launch_path::child_path() {
        command.env("PATH", path);
    }
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
    let backlog: SharedBacklog = Arc::new(Mutex::new(Default::default()));

    let pane = PaneInfo {
        id: pane_id.clone(),
        title: spec.title,
        kind: spec.kind,
        agent_id: spec.agent_id,
        cwd: spec.cwd.display().to_string(),
        cols: initial_size.cols,
        rows: initial_size.rows,
        status: PaneStatus::Running,
        recovered: spec.recovered,
        // Real depth is stamped from Model.pane_depth by ordered_panes; the runtime
        // copy is never consulted for it.
        depth: 0,
    };

    let runtime = PaneRuntime {
        info: pane.clone(),
        child: child.clone(),
        master,
        writer,
        backlog: backlog.clone(),
    };

    state.insert_pane(runtime)?;
    start_reader_thread(state.clone(), pane_id, reader, backlog);

    Ok(pane)
}

/// Marks a pane's frontend listener as live and flushes any output buffered
/// before it attached. Called once per pane, after the webview registers its
/// `qmux-event` listener, so the cold-start prompt is never lost to a startup
/// race. The buffered bytes are emitted before `ready` releases the reader to
/// emit live, preserving output order.
pub fn attach_pane(state: &AppState, pane_id: String) -> Result<(), String> {
    let backlog = state
        .pane_backlog(&pane_id)?
        .ok_or_else(|| format!("pane {pane_id} was not found"))?;
    let mut backlog = backlog
        .lock()
        .map_err(|_| format!("pane {pane_id} backlog lock poisoned"))?;
    if !backlog.ready {
        backlog.ready = true;
        if !backlog.buffer.is_empty() {
            let pending = std::mem::take(&mut backlog.buffer);
            record_scrollback(state, &pane_id, &pending);
            state.emit(QmuxEvent::pty_data(pane_id, &pending));
        }
    }
    Ok(())
}

pub fn write_pane(state: &AppState, options: PaneWriteOptions) -> Result<(), String> {
    let writer = state
        .pane_writer(&options.pane_id)?
        .ok_or_else(|| format!("pane {} was not found", options.pane_id))?;

    // Write the data (and paste markers) under the lock, then release it before the
    // submit-key delay. The delay gives a TUI a beat to ingest a pasted turn before
    // Return lands; holding the per-pane writer lock across that 15ms sleep would
    // stall every other write to the same pane (live keystrokes, the next queued
    // turn) behind it. The bracketed-paste body stays atomic within the first
    // locked section; only the trailing Return is sent in a second short section.
    {
        let mut writer = writer
            .lock()
            .map_err(|_| format!("pane {} writer lock poisoned", options.pane_id))?;
        write_pane_data(&mut *writer, &options)?;
    }

    if options.submit {
        if !SUBMIT_KEY_DELAY.is_zero() {
            thread::sleep(SUBMIT_KEY_DELAY);
        }
        let mut writer = writer
            .lock()
            .map_err(|_| format!("pane {} writer lock poisoned", options.pane_id))?;
        write_pane_submit(&mut *writer)?;
    }

    Ok(())
}

fn write_pane_data<W: Write + ?Sized>(
    writer: &mut W,
    options: &PaneWriteOptions,
) -> Result<(), String> {
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
    } else {
        writer
            .write_all(options.data.as_bytes())
            .map_err(|err| format!("failed to write to pane: {err}"))?;
    }

    writer
        .flush()
        .map_err(|err| format!("failed to flush pane input: {err}"))
}

fn write_pane_submit<W: Write + ?Sized>(writer: &mut W) -> Result<(), String> {
    writer
        .write_all(SUBMIT_KEY)
        .map_err(|err| format!("failed to submit pane input: {err}"))?;
    writer
        .flush()
        .map_err(|err| format!("failed to flush pane submit key: {err}"))
}

/// Composes the data and submit-key writes for tests, mirroring `write_pane`'s
/// sequencing without the per-pane lock handling. `submit_key_delay` lets a test
/// skip the inter-write sleep.
#[cfg(test)]
fn write_pane_input<W: Write + ?Sized>(
    writer: &mut W,
    options: &PaneWriteOptions,
    submit_key_delay: Duration,
) -> Result<(), String> {
    write_pane_data(writer, options)?;
    if options.submit {
        if !submit_key_delay.is_zero() {
            thread::sleep(submit_key_delay);
        }
        write_pane_submit(writer)?;
    }
    Ok(())
}

pub fn resize_pane(state: &AppState, pane_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let master = state
        .pane_master(&pane_id)?
        .ok_or_else(|| format!("pane {pane_id} was not found"))?;
    let master = master
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
    state.remove_pane(&pane_id)
}

fn start_reader_thread(
    state: AppState,
    pane_id: String,
    mut reader: Box<dyn Read + Send>,
    backlog: SharedBacklog,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let chunk = &buffer[..count];
                    // Hold the backlog lock only long enough to decide; emitting
                    // live happens after releasing it. `attach_pane` flips `ready`
                    // (and drains the buffer) under the same lock, so no chunk is
                    // ever both buffered and emitted, and order is preserved.
                    let live = match backlog.lock() {
                        Ok(mut backlog) => {
                            if backlog.ready {
                                true
                            } else {
                                append_capped(&mut backlog.buffer, chunk);
                                false
                            }
                        }
                        Err(_) => true,
                    };
                    if live {
                        record_scrollback(&state, &pane_id, chunk);
                        state.emit(QmuxEvent::pty_data(pane_id.clone(), chunk));
                    }
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
        // The PTY hit EOF, so the child has exited (or is about to). Reap it before
        // dropping the handle so it does not linger as a zombie occupying a PID slot
        // for the life of the qmux process, and report its real exit code rather
        // than a blanket `None`. A pane killed via `kill_pane` is already reaped and
        // removed there, so this returns None and emits the exit with no code.
        let exit_code = reap_pane_child(&state, &pane_id);
        if let Err(err) = state.remove_pane(&pane_id) {
            // A failure here (e.g. a poisoned model lock) leaves a dead pane in
            // state; log it so the stale entry has a trace rather than vanishing.
            eprintln!("qmux: failed to remove exited pane {pane_id}: {err}");
        }
        remove_shell_integration_dir(&pane_id);
        state.emit(QmuxEvent::pty_exit(pane_id, exit_code));
    });
}

/// Waits on a pane's child so the exited process is reaped (no zombie) and returns
/// its exit code. Best-effort: a pane already removed (e.g. by `kill_pane`) or a
/// poisoned child lock yields `None`.
fn reap_pane_child(state: &AppState, pane_id: &str) -> Option<i32> {
    let child = state.pane_child(pane_id).ok().flatten()?;
    let mut child = child.lock().ok()?;
    child.wait().ok().map(|status| status.exit_code() as i32)
}

/// Appends to the pre-attach backlog, dropping the oldest bytes once it exceeds
/// the cap so a runaway pre-attach burst can't grow unbounded.
fn append_capped(buffer: &mut Vec<u8>, chunk: &[u8]) {
    buffer.extend_from_slice(chunk);
    if buffer.len() > BACKLOG_CAP {
        let overflow = buffer.len() - BACKLOG_CAP;
        buffer.drain(..overflow);
    }
}

fn record_scrollback(state: &AppState, pane_id: &str, chunk: &[u8]) {
    if let Err(err) = append_pane_scrollback(&state.config().workspace_root, pane_id, chunk) {
        eprintln!("qmux: failed to record scrollback for pane {pane_id}: {err}");
    }
}

fn kill_child(pane_id: &str, child: SharedChild) -> Result<(), String> {
    let mut child = child
        .lock()
        .map_err(|_| format!("pane {pane_id} child lock poisoned"))?;

    if child
        .try_wait()
        .map_err(|err| format!("failed to inspect pane {pane_id}: {err}"))?
        .is_some()
    {
        return Ok(());
    }

    if let Some(pid) = child.process_id() {
        // Signal the whole process group first. The group id is the session
        // leader's pid, which we still hold open via `child`, so it can't be
        // recycled out from under us — unlike the individual descendant pids
        // below. Delivering the group signal up front also begins tearing the tree
        // down before we enumerate it, shrinking the window in which an enumerated
        // descendant could exit and have its pid reused by an unrelated process
        // before we signal it.
        let group = format!("-{}", pid);
        let _ = Command::new("/bin/kill").arg("-TERM").arg(&group).status();
        // Best-effort backstop for descendants that escaped the group (e.g. via
        // setsid). This walks live pids, so it is inherently subject to pid reuse
        // and is intentionally secondary to the group signal above.
        terminate_descendants(pid);
    }

    match child.kill() {
        Ok(()) => {
            // Reap the just-killed child while we still hold its handle, so it does
            // not become a zombie. The kill above signals it; wait collects it.
            let _ = child.wait();
            Ok(())
        }
        Err(err) => {
            if child
                .try_wait()
                .map_err(|wait_err| format!("failed to inspect pane {pane_id}: {wait_err}"))?
                .is_some()
            {
                Ok(())
            } else {
                Err(format!("failed to kill pane {pane_id}: {err}"))
            }
        }
    }
}

fn terminate_descendants(pid: u32) {
    for child_pid in child_process_ids(pid) {
        terminate_descendants(child_pid);
        let _ = Command::new("/bin/kill")
            .arg("-TERM")
            .arg(child_pid.to_string())
            .status();
    }
}

fn child_process_ids(pid: u32) -> Vec<u32> {
    let output = Command::new("/usr/bin/pgrep")
        .arg("-P")
        .arg(pid.to_string())
        .output();

    match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, OpencodeAdapterConfig, QmuxConfig,
    };
    use crate::scrollback::read_pane_scrollback;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct RecordingWriter {
        bytes: Vec<u8>,
        flush_offsets: Vec<usize>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flush_offsets.push(self.bytes.len());
            Ok(())
        }
    }

    fn write_options(data: &str, paste: bool, submit: bool) -> PaneWriteOptions {
        PaneWriteOptions {
            pane_id: "pane-1".to_string(),
            data: data.to_string(),
            paste,
            submit,
        }
    }

    fn test_state() -> AppState {
        AppState::new(QmuxConfig {
            workspace_root: PathBuf::from("/tmp/qmux-workspaces"),
            socket_path: PathBuf::from("/tmp/qmux.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
                opencode: OpencodeAdapterConfig {
                    binary: Some("opencode".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: std::path::PathBuf::new(),
            opencode_plugin_dir: std::path::PathBuf::new(),
        })
    }

    fn test_state_with_workspace(workspace_root: PathBuf) -> AppState {
        AppState::new(QmuxConfig {
            workspace_root,
            socket_path: PathBuf::from("/tmp/qmux.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
                opencode: OpencodeAdapterConfig {
                    binary: Some("opencode".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: std::path::PathBuf::new(),
            opencode_plugin_dir: std::path::PathBuf::new(),
        })
    }

    fn temp_workspace() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("qmux-pty-scrollback-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env_value(envs: &[(String, String)], key: &str) -> Option<String> {
        envs.iter()
            .find_map(|(env_key, value)| (env_key == key).then(|| value.clone()))
    }

    #[test]
    fn shell_kind_detects_supported_shells_by_basename() {
        assert_eq!(shell_kind("/bin/zsh"), ShellKind::Zsh);
        assert_eq!(shell_kind("/opt/homebrew/bin/bash"), ShellKind::Bash);
        assert_eq!(shell_kind("/opt/homebrew/bin/fish"), ShellKind::Unsupported);
    }

    #[test]
    fn init_scripts_define_agent_functions_through_qmux() {
        let qmux_cli = PathBuf::from("/Applications/qmux app/qmux");
        let shell_commands = [
            ShellCommandIntegration {
                command_name: "codex",
                adapter_id: "codex",
            },
            ShellCommandIntegration {
                command_name: "claude",
                adapter_id: "claude",
            },
        ];

        let zsh_script = zsh_init_script(&qmux_cli, &shell_commands);
        let bash_script = bash_init_script(&qmux_cli, &shell_commands);

        for script in [zsh_script, bash_script] {
            assert!(script.contains("codex() {"));
            assert!(script.contains("'/Applications/qmux app/qmux' agent-exec codex \"$@\""));
            assert!(script.contains("unalias codex"));
            assert!(script.contains("claude() {"));
            assert!(script.contains("'/Applications/qmux app/qmux' agent-exec claude \"$@\""));
            assert!(script.contains("unalias claude"));
            // After the agent exits, the wrapper detaches it from the pane (preserving
            // the agent's exit code) so the tab stops showing a stale agent status.
            assert!(script.contains("'/Applications/qmux app/qmux' agent-detach"));
            assert!(script.contains("local __qmux_status=$?"));
            assert!(script.contains("return $__qmux_status"));
            // `qmux` itself is a passthrough so `qmux open <file>` works at the prompt
            // without qmux being on PATH.
            assert!(script.contains("unalias qmux"));
            assert!(script.contains("qmux() {"));
            assert!(script.contains("'/Applications/qmux app/qmux' \"$@\""));
            // Shell integration reports cwd changes so restarts reopen the last dir.
            assert!(script.contains("'/Applications/qmux app/qmux' cwd"));
            assert!(script.contains("__qmux_report_cwd"));
        }
    }

    #[test]
    fn base_qmux_envs_include_pane_socket_token_and_workspace() {
        let state = test_state();
        let envs = qmux_pane_envs(&state, "pane-123").expect("envs mint a token");

        assert_eq!(
            env_value(&envs, "QMUX_PANE_ID"),
            Some("pane-123".to_string())
        );
        assert_eq!(
            env_value(&envs, "QMUX_SOCK"),
            Some("/tmp/qmux.sock".to_string())
        );
        let token = env_value(&envs, "QMUX_TOKEN").expect("pane token env is present");
        assert_eq!(token, state.pane_token("pane-123").unwrap());
        assert_eq!(token.len(), 64);
        assert_ne!(
            state.pane_token("pane-123").unwrap(),
            state.pane_token("other-pane").unwrap()
        );
        assert_eq!(
            env_value(&envs, "QMUX_WORKSPACE_ROOT"),
            Some("/tmp/qmux-workspaces".to_string())
        );
    }

    #[test]
    fn shell_pane_envs_enable_shell_integration() {
        let state = test_state();
        let envs = shell_pane_envs(&state, "pane-123").expect("envs mint a token");

        assert_eq!(
            env_value(&envs, "QMUX_SHELL_INTEGRATION"),
            Some("1".to_string())
        );
        assert!(env_value(&envs, "QMUX_AGENT_ID").is_none());
    }

    #[test]
    fn initial_pty_size_defaults_to_legacy_geometry() {
        assert_eq!(
            resolved_initial_size(None),
            InitialPaneSize {
                cols: DEFAULT_PTY_COLS,
                rows: DEFAULT_PTY_ROWS
            }
        );
    }

    #[test]
    fn initial_pty_size_is_clamped_to_safe_bounds() {
        assert_eq!(
            resolved_initial_size(Some(InitialPaneSize { cols: 1, rows: 1 })),
            InitialPaneSize {
                cols: MIN_INITIAL_COLS,
                rows: MIN_INITIAL_ROWS
            }
        );
        assert_eq!(
            resolved_initial_size(Some(InitialPaneSize {
                cols: u16::MAX,
                rows: u16::MAX
            })),
            InitialPaneSize {
                cols: MAX_INITIAL_COLS,
                rows: MAX_INITIAL_ROWS
            }
        );
    }

    #[test]
    fn submit_after_bracketed_paste_flushes_before_return() {
        let mut writer = RecordingWriter::default();
        let options = write_options("turn text", true, true);

        write_pane_input(&mut writer, &options, Duration::ZERO).unwrap();

        let pasted = b"\x1b[200~turn text\x1b[201~";
        assert_eq!(writer.bytes, b"\x1b[200~turn text\x1b[201~\r");
        assert_eq!(writer.flush_offsets, vec![pasted.len(), pasted.len() + 1]);
    }

    #[test]
    fn submit_after_plain_write_sends_return_after_text() {
        let mut writer = RecordingWriter::default();
        let options = write_options("y", false, true);

        write_pane_input(&mut writer, &options, Duration::ZERO).unwrap();

        assert_eq!(writer.bytes, b"y\r");
        assert_eq!(writer.flush_offsets, vec![1, 2]);
    }

    fn spawn_test_pty(state: &AppState, pane_id: &str, args: Vec<String>) -> PaneInfo {
        spawn_pty(
            state,
            PtySpawnSpec {
                pane_id: Some(pane_id.to_string()),
                agent_id: None,
                kind: PaneKind::Shell,
                title: "test".to_string(),
                program: "/bin/sh".to_string(),
                args,
                cwd: std::env::temp_dir(),
                envs: Vec::new(),
                initial_size: None,
                recovered: false,
            },
        )
        .expect("spawning a test PTY")
    }

    #[test]
    fn reader_thread_reaps_and_removes_pane_after_child_exits() {
        let state = test_state();
        let pane = spawn_test_pty(
            &state,
            "pane-exit",
            vec!["-c".to_string(), "exit 0".to_string()],
        );

        // The child exits immediately; the reader thread should observe EOF, reap the
        // child (no zombie), and remove the pane from state.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while state.pane_child(&pane.id).unwrap().is_some() {
            assert!(
                std::time::Instant::now() < deadline,
                "pane was not removed after the child exited"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn kill_pane_terminates_a_running_child_and_removes_it() {
        let state = test_state();
        let pane = spawn_test_pty(
            &state,
            "pane-kill",
            vec!["-c".to_string(), "sleep 30".to_string()],
        );
        assert!(state.pane_child(&pane.id).unwrap().is_some());

        kill_pane(&state, pane.id.clone()).expect("killing the pane");
        assert!(
            state.pane_child(&pane.id).unwrap().is_none(),
            "pane should be gone after kill_pane"
        );
    }

    #[test]
    fn pre_attach_output_is_recorded_only_when_attach_flushes_it() {
        let workspace = temp_workspace();
        let state = test_state_with_workspace(workspace.clone());
        let pane = spawn_test_pty(
            &state,
            "pane-scrollback",
            vec![
                "-c".to_string(),
                "printf 'restored\\n'; sleep 5".to_string(),
            ],
        );

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let backlog = state
                .pane_backlog(&pane.id)
                .unwrap()
                .expect("pane has backlog");
            let has_output = backlog
                .lock()
                .unwrap()
                .buffer
                .windows("restored".len())
                .any(|window| window == b"restored");
            if has_output {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "pane did not buffer pre-attach output"
            );
            thread::sleep(Duration::from_millis(20));
        }

        assert!(
            read_pane_scrollback(&workspace, &pane.id)
                .unwrap()
                .is_empty(),
            "pre-attach output must not be visible in the durable log before replay"
        );

        attach_pane(&state, pane.id.clone()).expect("attaching pane flushes backlog");
        let restored = read_pane_scrollback(&workspace, &pane.id).unwrap();
        assert!(
            restored
                .windows("restored".len())
                .any(|window| window == b"restored"),
            "attach should record the flushed backlog"
        );

        kill_pane(&state, pane.id.clone()).expect("cleanup test pane");
        assert!(
            read_pane_scrollback(&workspace, &pane.id)
                .unwrap()
                .is_empty(),
            "closing a pane should remove its scrollback log"
        );
    }

    #[test]
    fn append_capped_keeps_recent_bytes_under_cap() {
        let mut buffer = Vec::new();
        append_capped(&mut buffer, b"hello");
        append_capped(&mut buffer, b" world");
        assert_eq!(buffer, b"hello world");
    }

    #[test]
    fn append_capped_drops_oldest_when_over_cap() {
        let mut buffer = Vec::new();
        let first = vec![b'a'; BACKLOG_CAP];
        append_capped(&mut buffer, &first);
        append_capped(&mut buffer, b"tail");

        assert_eq!(buffer.len(), BACKLOG_CAP);
        // The oldest bytes were dropped to make room; the most recent bytes win.
        assert_eq!(&buffer[buffer.len() - 4..], b"tail");
        assert_eq!(buffer[0], b'a');
    }
}
