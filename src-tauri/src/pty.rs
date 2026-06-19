use crate::events::QmuxEvent;
use crate::state::{AppState, PaneInfo, PaneKind, PaneRuntime, PaneStatus, SharedChild};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Deserialize;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const SUBMIT_KEY: &[u8] = b"\r";
const SUBMIT_KEY_DELAY: Duration = Duration::from_millis(15);

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
    let pane_id = state.next_id("pane");
    let mut envs = shell_pane_envs(state, &pane_id);
    let mut args = Vec::new();

    match claude_shell_function_injection(&shell, &pane_id) {
        Ok(Some(injection)) => {
            args = injection.args;
            envs.extend(injection.envs);
            envs.push(("QMUX_CLAUDE_FUNCTION".to_string(), "1".to_string()));
        }
        Ok(None) => {
            envs.push((
                "QMUX_CLAUDE_FUNCTION".to_string(),
                "unsupported".to_string(),
            ));
        }
        Err(err) => {
            envs.push(("QMUX_CLAUDE_FUNCTION".to_string(), "failed".to_string()));
            envs.push(("QMUX_CLAUDE_FUNCTION_ERROR".to_string(), err));
        }
    }

    spawn_pty(
        state,
        PtySpawnSpec {
            pane_id: Some(pane_id),
            agent_id: None,
            kind: PaneKind::Shell,
            title: "Shell".to_string(),
            program: shell,
            args,
            cwd,
            envs,
        },
    )
}

pub fn qmux_pane_envs(state: &AppState, pane_id: &str) -> Vec<(String, String)> {
    vec![
        ("QMUX_PANE_ID".to_string(), pane_id.to_string()),
        (
            "QMUX_SOCK".to_string(),
            state.config().socket_path.display().to_string(),
        ),
        ("QMUX_TOKEN".to_string(), state.token().to_string()),
        (
            "QMUX_WORKSPACE_ROOT".to_string(),
            state.config().workspace_root.display().to_string(),
        ),
    ]
}

fn shell_pane_envs(state: &AppState, pane_id: &str) -> Vec<(String, String)> {
    let mut envs = qmux_pane_envs(state, pane_id);
    envs.push(("QMUX_SHELL_INTEGRATION".to_string(), "1".to_string()));
    envs
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

fn claude_shell_function_injection(
    shell: &str,
    pane_id: &str,
) -> Result<Option<ShellFunctionInjection>, String> {
    let shell_kind = shell_kind(shell);
    if matches!(shell_kind, ShellKind::Unsupported) {
        return Ok(None);
    }

    let qmux_cli = env::current_exe()
        .map_err(|err| format!("failed to resolve qmux executable for shell integration: {err}"))?;
    let root = env::temp_dir().join("qmux-shell-init").join(pane_id);
    fs::create_dir_all(&root).map_err(|err| {
        format!(
            "failed to create shell integration dir {}: {err}",
            root.display()
        )
    })?;

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
            fs::write(&rcfile, zsh_init_script(&qmux_cli)).map_err(|err| {
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
            fs::write(&rcfile, bash_init_script(&qmux_cli)).map_err(|err| {
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

fn zsh_init_script(qmux_cli: &Path) -> String {
    format!(
        r#"# Generated by qmux. Do not edit.
if [ -n "${{QMUX_ORIGINAL_ZDOTDIR:-}}" ]; then
  export ZDOTDIR="$QMUX_ORIGINAL_ZDOTDIR"
  if [ -r "$ZDOTDIR/.zshrc" ]; then
    source "$ZDOTDIR/.zshrc"
  fi
fi
unalias claude 2>/dev/null || true
claude() {{
  {} claude "$@"
}}
"#,
        shell_quote(qmux_cli)
    )
}

fn bash_init_script(qmux_cli: &Path) -> String {
    format!(
        r#"# Generated by qmux. Do not edit.
if [ -n "${{QMUX_ORIGINAL_BASHRC:-}}" ] && [ -r "$QMUX_ORIGINAL_BASHRC" ]; then
  . "$QMUX_ORIGINAL_BASHRC"
fi
unalias claude 2>/dev/null || true
claude() {{
  {} claude "$@"
}}
"#,
        shell_quote(qmux_cli)
    )
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

    write_pane_input(&mut *writer, &options, SUBMIT_KEY_DELAY)
}

fn write_pane_input<W: Write + ?Sized>(
    writer: &mut W,
    options: &PaneWriteOptions,
    submit_key_delay: Duration,
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
        .map_err(|err| format!("failed to flush pane input: {err}"))?;

    if options.submit {
        if !submit_key_delay.is_zero() {
            thread::sleep(submit_key_delay);
        }
        writer
            .write_all(SUBMIT_KEY)
            .map_err(|err| format!("failed to submit pane input: {err}"))?;
        writer
            .flush()
            .map_err(|err| format!("failed to flush pane submit key: {err}"))?;
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
    state.mark_pane_status(&pane_id, PaneStatus::Killed)
}

fn start_reader_thread(state: AppState, pane_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    state.emit(QmuxEvent::pty_data(pane_id.clone(), &buffer[..count]));
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
        terminate_descendants(pid);
        let group = format!("-{}", pid);
        let _ = Command::new("/bin/kill").arg("-TERM").arg(&group).status();
    }

    child
        .kill()
        .map_err(|err| format!("failed to kill pane {pane_id}: {err}"))
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
    use crate::config::QmuxConfig;
    use std::io;
    use std::path::PathBuf;

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
            claude_binary: "claude".to_string(),
        })
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
    fn init_scripts_define_claude_function_through_qmux() {
        let qmux_cli = PathBuf::from("/Applications/qmux app/qmux");

        let zsh_script = zsh_init_script(&qmux_cli);
        let bash_script = bash_init_script(&qmux_cli);

        for script in [zsh_script, bash_script] {
            assert!(script.contains("claude() {"));
            assert!(script.contains("'/Applications/qmux app/qmux' claude \"$@\""));
            assert!(script.contains("unalias claude"));
        }
    }

    #[test]
    fn base_qmux_envs_include_pane_socket_token_and_workspace() {
        let state = test_state();
        let envs = qmux_pane_envs(&state, "pane-123");

        assert_eq!(
            env_value(&envs, "QMUX_PANE_ID"),
            Some("pane-123".to_string())
        );
        assert_eq!(
            env_value(&envs, "QMUX_SOCK"),
            Some("/tmp/qmux.sock".to_string())
        );
        assert_eq!(
            env_value(&envs, "QMUX_TOKEN"),
            Some(state.token().to_string())
        );
        assert_eq!(
            env_value(&envs, "QMUX_WORKSPACE_ROOT"),
            Some("/tmp/qmux-workspaces".to_string())
        );
    }

    #[test]
    fn shell_pane_envs_enable_shell_integration() {
        let state = test_state();
        let envs = shell_pane_envs(&state, "pane-123");

        assert_eq!(
            env_value(&envs, "QMUX_SHELL_INTEGRATION"),
            Some("1".to_string())
        );
        assert!(env_value(&envs, "QMUX_AGENT_ID").is_none());
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
}
