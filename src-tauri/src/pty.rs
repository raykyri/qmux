use crate::adapters::{ShellCommandIntegration, adapter_registry};
use crate::events::QmuxEvent;
use crate::scrollback::append_pane_scrollback;
use crate::state::{
    AppState, PaneBackend, PaneInfo, PaneKind, PaneRuntime, PaneStatus, SharedBacklog, SharedChild,
    ShellAgentResume,
};
use crate::turn_queue::release_waiters_for_agent;
use crate::workspace::{
    CreateGroupRequest, capture_agent_worktree_removal, create_group, remove_captured_worktree,
};
use portable_pty::PtySize;
#[cfg(any(not(target_os = "macos"), test))]
use portable_pty::{CommandBuilder, native_pty_system};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
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
/// Cap on PTY output buffered before the frontend attaches. Recovered agent TUIs
/// can repaint a large transcript before the webview replays durable scrollback
/// and calls `pane_attach`; keeping the full repaint preserves SGR/background
/// state that later bytes in the same draw rely on.
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
const BACKLOG_CAP: usize = 8 * 1024 * 1024;

/// How often the per-pane child watcher checks whether the direct child (shell or
/// agent) has exited. Cheap — a non-blocking `try_wait` under the child lock — so
/// a couple of seconds keeps a stuck pane's "Running" state from lingering long
/// without meaningful cost.
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
const CHILD_WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// How many watch intervals between refreshes of a pane's descendant-pid
/// snapshot (both the portable watcher's fallback list and the native process
/// tree). Descendants that outlive their shell (dev servers, `sleep &`) are
/// long-lived, so a coarse ~16s refresh catches them while keeping the
/// `pgrep` walk off the steady-state path.
const DESCENDANT_REFRESH_TICKS: u32 = 8;

const NATIVE_PROCESS_TERM_GRACE: Duration = Duration::from_millis(400);

#[derive(Clone, Debug)]
struct TrackedProcess {
    pid: u32,
    start_signature: String,
}

#[derive(Clone, Debug)]
struct NativeProcessTree {
    root: TrackedProcess,
    descendants: HashMap<u32, TrackedProcess>,
}

static NATIVE_PROCESS_TREES: OnceLock<Mutex<HashMap<String, NativeProcessTree>>> = OnceLock::new();

static CLOSING_NATIVE_PANES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InitialPaneSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneActivity {
    pub kind: PaneActivityKind,
    pub process_count: usize,
    pub process_summary: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneActivityKind {
    Idle,
    RunningProcess,
}

impl PaneActivity {
    fn idle() -> Self {
        Self {
            kind: PaneActivityKind::Idle,
            process_count: 0,
            process_summary: None,
        }
    }

    fn running_process(process_count: usize, process_summary: Option<String>) -> Self {
        Self {
            kind: PaneActivityKind::RunningProcess,
            process_count,
            process_summary,
        }
    }
}

pub struct PtySpawnSpec {
    pub pane_id: Option<String>,
    pub agent_id: Option<String>,
    pub group_id: String,
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
    source_pane_id: Option<&str>,
    group_id: Option<&str>,
) -> Result<PaneInfo, String> {
    // A user-opened shell inherits the focused shell's current directory when one is
    // given and still valid (matching how terminal emulators open a "new tab here");
    // otherwise it opens in the target group directory / home, never the bare `/` a
    // Finder/Dock launch inherits as its cwd.
    let source_group_id = source_pane_id.and_then(|id| state.pane_group_id(id).ok().flatten());
    let group = match group_id.or(source_group_id.as_deref()) {
        Some(group_id) => state
            .group(group_id)?
            .ok_or_else(|| format!("group {group_id} was not found"))?,
        None => create_group(
            state,
            CreateGroupRequest {
                name: None,
                dir: None,
                after_group_id: None,
                base_repo: None,
                base_ref: None,
            },
        )?,
    };
    // Inherit the focused shell's cwd only when it belongs to the group we are
    // spawning into ("new tab here"). When opening into a group from *outside* it,
    // derive the cwd from that group's own most-recently-active shell pane instead
    // of the foreign pane the user happened to be in. A brand-new group has no shell
    // panes yet, so fall back to its creation-time seed dir (`group.dir`) — the
    // directory the group was opened for — before the default home dir; otherwise the
    // first terminal would land in ~ and every sibling would copy that.
    let cwd = source_pane_id
        .filter(|&id| {
            state
                .pane_group_id(id)
                .ok()
                .flatten()
                .is_some_and(|gid| gid == group.id)
        })
        .and_then(|id| state.inheritable_shell_cwd(id))
        .or_else(|| state.group_spawn_cwd(&group.id))
        .or_else(|| recoverable_dir(&group.dir))
        .unwrap_or_else(|| state.default_open_dir());
    let pane_id = state.next_id("pane");
    spawn_pty(
        state,
        shell_spawn_spec(state, pane_id, group.id, cwd, initial_size, false, None)?,
    )
}

/// Recreates a previously persisted shell pane: same pane id (so UI mappings and
/// queues keep lining up), reopened in its last-known cwd when that still exists,
/// at its persisted geometry. Marked recovered so the UI can label it.
pub fn respawn_shell_pane(state: &AppState, pane: &PaneInfo) -> Result<PaneInfo, String> {
    // A queued resume rebinds the agent that was live in this pane at shutdown. Its
    // session is keyed to the original launch dir (Claude/Codex scope sessions by project
    // dir), and the resume command runs in whatever cwd this shell reopens in, so reopen
    // there rather than the pane's last cwd — which `cd` may have moved away from since
    // launch (`update_pane_cwd` tracks the live directory). Reopening at the drifted cwd
    // would both fail to resolve the session and miss the agent rebind, minting a
    // duplicate on every restart. The hint is taken (drained) either way so it can't
    // linger and fire on a later relaunch of the same pane id; the resume only proceeds
    // when that original dir still exists.
    let resume = state.take_shell_agent_resume(&pane.id);
    let resume_dir = resume
        .as_ref()
        .and_then(|resume| recoverable_dir(&resume.cwd));
    // A recovered shell whose last dir was deleted between sessions reopens near the
    // group's other work (its most-recently-active shell pane), else the group's
    // creation-time seed dir, else the default dir / home rather than the bare `/` a
    // Finder/Dock launch inherits. During startup recovery siblings may not be
    // respawned yet, in which case group_spawn_cwd yields None and the seed/default
    // apply.
    let group_seed_dir = state
        .group(&pane.group_id)
        .ok()
        .flatten()
        .and_then(|group| recoverable_dir(&group.dir));
    let cwd = resume_dir
        .clone()
        .or_else(|| recoverable_dir(&pane.cwd))
        .or_else(|| state.group_spawn_cwd(&pane.group_id))
        .or(group_seed_dir)
        .unwrap_or_else(|| state.default_open_dir());
    let resume_command = resume
        .filter(|_| resume_dir.is_some())
        .and_then(|resume| shell_resume_command(state, &resume));
    let initial_size = Some(InitialPaneSize {
        cols: pane.cols,
        rows: pane.rows,
    });
    spawn_pty(
        state,
        shell_spawn_spec(
            state,
            pane.id.clone(),
            pane.group_id.clone(),
            cwd,
            initial_size,
            true,
            resume_command,
        )?,
    )
}

/// Resolves the shell command that resumes a captured agent session through its
/// adapter's injected wrapper (e.g. `claude --resume <id>`). `None` when the adapter
/// has no resume command.
fn shell_resume_command(state: &AppState, resume: &ShellAgentResume) -> Option<String> {
    adapter_registry(state.config())
        .get(&resume.adapter)
        .ok()?
        .shell_resume_command(&resume.session_id)
}

/// The shell for new panes: `$SHELL` when set (terminal launches), else the
/// user's login shell from the password database (GUI launches don't inherit
/// `SHELL`), else a platform default.
fn pane_shell() -> String {
    if let Ok(shell) = env::var("SHELL")
        && !shell.trim().is_empty()
    {
        return shell;
    }
    if let Some(shell) = passwd_login_shell() {
        return shell;
    }
    let fallback = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    };
    fallback.to_string()
}

/// Reads the current user's login shell from the password database via the
/// reentrant `getpwuid_r` (pane spawns can run concurrently on command threads).
fn passwd_login_shell() -> Option<String> {
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = [0 as libc::c_char; 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || pwd.pw_shell.is_null() {
        return None;
    }
    let shell = unsafe { std::ffi::CStr::from_ptr(pwd.pw_shell) }
        .to_str()
        .ok()?
        .trim();
    (!shell.is_empty()).then(|| shell.to_string())
}

/// Builds the spawn spec for a shell pane, including adapter wrapper-function
/// injection. Shared by fresh spawns and recovery respawns so both stay in sync.
fn shell_spawn_spec(
    state: &AppState,
    pane_id: String,
    group_id: String,
    cwd: PathBuf,
    initial_size: Option<InitialPaneSize>,
    recovered: bool,
    resume_command: Option<String>,
) -> Result<PtySpawnSpec, String> {
    let shell = pane_shell();
    let mut envs = shell_pane_envs(state, &pane_id)?;
    let mut args = Vec::new();

    let shell_commands = adapter_registry(state.config()).shell_commands();
    let login_shell = state.use_login_shell();
    match agent_shell_function_injection(
        &shell,
        &pane_id,
        &shell_commands,
        resume_command.as_deref(),
        login_shell,
    ) {
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
        group_id,
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
    resume_command: Option<&str>,
    login_shell: bool,
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
            fs::write(
                &rcfile,
                zsh_init_script(&qmux_cli, shell_commands, resume_command, login_shell),
            )
            .map_err(|err| {
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
            fs::write(
                &rcfile,
                bash_init_script(&qmux_cli, shell_commands, resume_command, login_shell),
            )
            .map_err(|err| {
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

fn zsh_init_script(
    qmux_cli: &Path,
    shell_commands: &[ShellCommandIntegration],
    resume_command: Option<&str>,
    login_shell: bool,
) -> String {
    let cli = shell_quote(qmux_cli);
    let qmux_function = shell_qmux_function(&cli);
    let agent_functions = shell_agent_functions(&cli, shell_commands);
    let resume = shell_resume_startup(resume_command);
    // A login shell also sources the user's .zprofile (before .zshrc) and .zlogin
    // (after), matching zsh's login startup order. We source these ourselves rather
    // than passing `-l`: ZDOTDIR is redirected to the per-pane integration dir during
    // early startup, so zsh's own login-file lookup would miss the user's copies.
    // Sourcing here, after ZDOTDIR is restored, loads the right files and keeps bash
    // and zsh behaving identically.
    let user_config = if login_shell {
        r#"  if [ -r "$ZDOTDIR/.zprofile" ]; then
    source "$ZDOTDIR/.zprofile"
  fi
  if [ -r "$ZDOTDIR/.zshrc" ]; then
    source "$ZDOTDIR/.zshrc"
  fi
  if [ -r "$ZDOTDIR/.zlogin" ]; then
    source "$ZDOTDIR/.zlogin"
  fi"#
    } else {
        r#"  if [ -r "$ZDOTDIR/.zshrc" ]; then
    source "$ZDOTDIR/.zshrc"
  fi"#
    };
    format!(
        r#"# Generated by qmux. Do not edit.
if [ -n "${{QMUX_ORIGINAL_ZDOTDIR:-}}" ]; then
  __qmux_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$QMUX_ORIGINAL_ZDOTDIR"
  # /etc/zshrc ran while ZDOTDIR was the per-pane integration dir, so on macOS
  # HISTFILE points at a scratch file that is deleted with the pane. Re-derive
  # it from the restored ZDOTDIR; the user's .zshrc below can still override.
  case "${{HISTFILE:-}}" in
    "$__qmux_zdotdir"/*) HISTFILE="$ZDOTDIR/.zsh_history" ;;
  esac
  unset __qmux_zdotdir
{user_config}
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
{resume}"#,
    )
}

fn bash_init_script(
    qmux_cli: &Path,
    shell_commands: &[ShellCommandIntegration],
    resume_command: Option<&str>,
    login_shell: bool,
) -> String {
    let cli = shell_quote(qmux_cli);
    let qmux_function = shell_qmux_function(&cli);
    let agent_functions = shell_agent_functions(&cli, shell_commands);
    let resume = shell_resume_startup(resume_command);
    // A login shell sources the first existing of the user's login profile files —
    // the same set, in the same order, a real `bash -l` consults — which by
    // convention pulls in ~/.bashrc itself. We can't pass `--login` because bash
    // ignores `--rcfile` (where our integration lives) for login shells, so we
    // reproduce the login file lookup here instead. A non-login shell sources
    // ~/.bashrc directly, as bash does for interactive non-login shells.
    let user_config = if login_shell {
        r#"for __qmux_login_rc in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__qmux_login_rc" ]; then
    . "$__qmux_login_rc"
    break
  fi
done
unset __qmux_login_rc"#
    } else {
        r#"if [ -n "${QMUX_ORIGINAL_BASHRC:-}" ] && [ -r "$QMUX_ORIGINAL_BASHRC" ]; then
  . "$QMUX_ORIGINAL_BASHRC"
fi"#
    };
    format!(
        r#"# Generated by qmux. Do not edit.
{user_config}
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
{resume}"#,
    )
}

/// A trailing line that re-runs an agent's resume command in a recovered shell. It
/// goes through the injected `claude`/`codex` wrapper defined above, so the resumed
/// session is tracked exactly like a fresh in-shell launch and the shell drops back to
/// a normal prompt once it exits. Empty when there is nothing to resume.
fn shell_resume_startup(resume_command: Option<&str>) -> String {
    match resume_command {
        Some(command) => format!("{command}\n"),
        None => String::new(),
    }
}

fn shell_agent_functions(cli: &str, shell_commands: &[ShellCommandIntegration]) -> String {
    shell_commands
        .iter()
        .map(|command| {
            // `agent-exec` supervises the real adapter process and detaches only after
            // wait() observes a true exit. Keeping cleanup out of this shell function is
            // important for job control: a stopped/backgrounded foreground job can hand
            // control back to the shell before it has exited.
            format!(
                "unalias {name} 2>/dev/null || true\n{name}() {{\n  {cli} agent-exec {adapter} \"$@\"\n}}",
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
    shell_quote_str(&path.display().to_string())
}

fn shell_quote_str(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
    #[cfg(all(target_os = "macos", not(test)))]
    {
        spawn_native_pty(state, spec)
    }
    #[cfg(any(not(target_os = "macos"), test))]
    {
        spawn_portable_pty(state, spec)
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn spawn_native_pty(state: &AppState, spec: PtySpawnSpec) -> Result<PaneInfo, String> {
    let pane_id = spec.pane_id.unwrap_or_else(|| state.next_id("pane"));
    let initial_size = resolved_initial_size(spec.initial_size);
    let launcher = create_native_launcher(&pane_id, &spec.program, &spec.args, &spec.envs)?;
    let pane = PaneInfo {
        id: pane_id.clone(),
        title: spec.title,
        kind: spec.kind,
        agent_id: spec.agent_id,
        group_id: spec.group_id,
        cwd: spec.cwd.display().to_string(),
        cols: initial_size.cols,
        rows: initial_size.rows,
        status: PaneStatus::Running,
        last_active_at: crate::state::now_millis(),
        recovered: spec.recovered,
        depth: 0,
    };
    state.insert_pane(PaneRuntime {
        info: pane.clone(),
        backend: PaneBackend::Native { root_pid: None },
    })?;

    if let Err(err) =
        crate::native_terminal::create(&pane_id, &launcher.display().to_string(), Some(&pane.cwd))
    {
        let _ = state.remove_pane(&pane_id);
        remove_shell_integration_dir(&pane_id);
        return Err(err);
    }
    Ok(pane)
}

#[cfg(all(target_os = "macos", not(test)))]
fn create_native_launcher(
    pane_id: &str,
    program: &str,
    args: &[String],
    envs: &[(String, String)],
) -> Result<PathBuf, String> {
    let root = create_shell_integration_dir(pane_id)?;
    let launcher = root.join("launch");
    let qmux_cli = env::current_exe()
        .map_err(|err| format!("failed to resolve qmux executable for native launcher: {err}"))?;
    let mut script = String::from("#!/bin/sh\n");

    let mut launch_envs = base_child_envs();
    launch_envs.extend(envs.iter().cloned());
    for (key, value) in launch_envs {
        if key.is_empty()
            || !key.bytes().enumerate().all(|(index, byte)| {
                byte == b'_'
                    || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
            })
        {
            return Err(format!(
                "invalid environment variable name for pane {pane_id}: {key}"
            ));
        }
        script.push_str("export ");
        script.push_str(&key);
        script.push('=');
        script.push_str(&shell_quote_str(&value));
        script.push('\n');
    }
    // Report the shell's PID over the control socket; without it, descendant
    // teardown and close-time activity detection are silently disabled for the
    // pane's entire lifetime. A single attempt can race app startup before the
    // socket listens, so retry briefly — the shell still launches if every
    // attempt fails.
    script.push_str("for _ in 1 2 3 4 5; do\n  if ");
    script.push_str(&shell_quote(&qmux_cli));
    script.push_str(" pane-pid \"$$\" >/dev/null 2>&1; then break; fi\n  sleep 0.2\ndone\nexec ");
    script.push_str(&shell_quote_str(program));
    for arg in args {
        script.push(' ');
        script.push_str(&shell_quote_str(arg));
    }
    script.push('\n');

    fs::write(&launcher, script).map_err(|err| {
        format!(
            "failed to write native terminal launcher {}: {err}",
            launcher.display()
        )
    })?;
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).map_err(|err| {
        format!(
            "failed to make native terminal launcher executable {}: {err}",
            launcher.display()
        )
    })?;
    Ok(launcher)
}

/// The base environment shared by both pane backends: the resolved child PATH,
/// 24-bit color capability, and a UTF-8 locale backfill. TERM is deliberately
/// not set here — Ghostty names its own terminal for native panes, while the
/// portable backend injects one itself (below).
fn base_child_envs() -> Vec<(String, String)> {
    let mut envs = Vec::new();
    if let Some(path) = crate::launch_path::child_path() {
        envs.push(("PATH".to_string(), path));
    }
    envs.push(("COLORTERM".to_string(), "truecolor".to_string()));
    // Backfill a UTF-8 locale only when one wasn't inherited — a GUI launch
    // gets no LANG, defaulting programs to the C locale and breaking Unicode,
    // while a deliberately-set locale from a dev shell is left untouched.
    if env::var_os("LANG").is_none() {
        envs.push(("LANG".to_string(), "en_US.UTF-8".to_string()));
    }
    envs
}

#[cfg(any(not(target_os = "macos"), test))]
fn spawn_portable_pty(state: &AppState, spec: PtySpawnSpec) -> Result<PaneInfo, String> {
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
    for (key, value) in base_child_envs() {
        command.env(key, value);
    }
    // Describe the renderer to the child rather than inheriting the outer
    // terminal's TERM. A Finder/Dock-launched app inherits launchd's bare
    // environment with no TERM at all (breaking color), and even when launched
    // from a terminal the inherited TERM names *that* emulator, not this
    // backend. Every real terminal emulator sets this itself for the same
    // reason; the portable renderer is xterm-256color-compatible.
    command.env("TERM", "xterm-256color");
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
        group_id: spec.group_id,
        cwd: spec.cwd.display().to_string(),
        cols: initial_size.cols,
        rows: initial_size.rows,
        status: PaneStatus::Running,
        // A freshly spawned pane is immediately the group's most-recent, so the next
        // spawn into the group inherits its cwd even before the frontend's activation
        // stamp round-trips. Every real pane (shell and agent) flows through here.
        last_active_at: crate::state::now_millis(),
        recovered: spec.recovered,
        // Real depth is stamped from Model.pane_depth by ordered_panes; the runtime
        // copy is never consulted for it.
        depth: 0,
    };

    let runtime = PaneRuntime {
        info: pane.clone(),
        backend: PaneBackend::Portable {
            child: child.clone(),
            master,
            writer,
            backlog: backlog.clone(),
        },
    };

    state.insert_pane(runtime)?;
    // Capture the direct child's pid for the watcher before handing the child to
    // the reader/watcher threads; the watcher uses it to reach descendants that
    // outlive a naturally-exiting shell.
    let root_pid = child.lock().ok().and_then(|guard| guard.process_id());
    start_reader_thread(state.clone(), pane_id.clone(), reader, backlog);
    start_child_watcher(state.clone(), pane_id, child, root_pid);

    Ok(pane)
}

/// Marks a pane's frontend listener as live and flushes any output buffered
/// before it attached. Called once per pane, after the webview registers its
/// `qmux-event` listener, so the cold-start prompt is never lost to a startup
/// race. The buffered bytes are emitted before `ready` releases the reader to
/// emit live, preserving output order.
pub fn attach_pane(state: &AppState, pane_id: String) -> Result<(), String> {
    if state.pane_is_native(&pane_id)? == Some(true) {
        return Ok(());
    }
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
    if state.pane_is_native(&options.pane_id)? == Some(true) {
        if !options.submit {
            // Lock-free single call; the bridge hops to the main thread itself.
            return dispatch_native_pane_input(state, &options);
        }
        // Submit sequences hold the per-pane send lock across bridge calls that
        // each need the main thread (`DispatchQueue.main.sync`), plus the
        // submit-key delay. Running that on a background thread deadlocks: a
        // synchronous Tauri command contending for the same pane's lock parks
        // the main thread, and the background holder's main-thread hop then
        // never runs. Execute the whole locked sequence on the main thread
        // instead — the main thread only ever runs the sequence inline (never
        // waits on another holder, since no other thread takes a native pane's
        // send lock anymore), and background callers park on the reply channel
        // while holding no locks at all.
        let state_on_main = state.clone();
        return state.run_on_main_thread_blocking(move || {
            dispatch_native_pane_input(&state_on_main, &options)
        })?;
    }
    let writer = state
        .pane_writer(&options.pane_id)?
        .ok_or_else(|| format!("pane {} was not found", options.pane_id))?;

    // Write the data (and paste markers) under the writer lock, then release it before
    // the submit-key delay. The bracketed-paste body stays atomic within this first
    // locked section; only the trailing Return is sent in a second short section, so
    // live keystrokes aren't stalled behind the delay.
    write_pane_sequenced(
        state,
        &options,
        |options| {
            let mut writer = writer
                .lock()
                .map_err(|_| format!("pane {} writer lock poisoned", options.pane_id))?;
            write_pane_data(&mut *writer, options)
        },
        || {
            let mut writer = writer
                .lock()
                .map_err(|_| format!("pane {} writer lock poisoned", options.pane_id))?;
            write_pane_submit(&mut *writer)
        },
    )
}

/// Binds the shared native sequencing to the concrete bridge calls for
/// `options.pane_id`.
fn dispatch_native_pane_input(state: &AppState, options: &PaneWriteOptions) -> Result<(), String> {
    write_native_pane_input(
        state,
        options,
        |data| crate::native_terminal::send_text(&options.pane_id, data),
        |data| crate::native_terminal::paste_approved_text(&options.pane_id, data),
        || crate::native_terminal::submit(&options.pane_id),
    )
}

fn write_native_pane_input(
    state: &AppState,
    options: &PaneWriteOptions,
    send_text: impl FnOnce(&str) -> Result<(), String>,
    paste_approved_text: impl FnOnce(&str) -> Result<(), String>,
    submit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    write_pane_sequenced(
        state,
        options,
        |options| write_native_pane_data(options, send_text, paste_approved_text),
        submit,
    )
}

/// Routes native-pane payloads through Ghostty's matching input API. Paste
/// framing is terminal state, not ordinary text: Ghostty must generate it via
/// its approved clipboard action so TUIs interpret the boundary instead of
/// receiving a literal `[200~... [201~` string.
fn write_native_pane_data(
    options: &PaneWriteOptions,
    send_text: impl FnOnce(&str) -> Result<(), String>,
    paste_approved_text: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    if options.paste {
        let data = strip_bracketed_paste_markers(&options.data);
        paste_approved_text(&data)
    } else {
        send_text(&options.data)
    }
}

/// The submit sequencing shared by both pane backends, parameterized over how
/// bytes reach the terminal: emit the payload, then after a short delay the
/// trailing Return, then arm the escape watch.
fn write_pane_sequenced(
    state: &AppState,
    options: &PaneWriteOptions,
    emit_data: impl FnOnce(&PaneWriteOptions) -> Result<(), String>,
    emit_submit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    // A submit is a multi-write sequence — paste body, a short delay, then Return —
    // so two submits racing to the same pane could interleave as `…A……B…\r\r`,
    // merging both turns onto one line and dropping a Return. Hold the per-pane
    // *send* lock across the whole sequence so submits serialize against each
    // other; keystrokes (submit=false) skip it and stay unblocked. Recover from
    // poisoning — the lock guards ordering only. `send_lock` is bound first so it
    // outlives the guard that borrows it.
    let send_lock = options
        .submit
        .then(|| state.pane_send_lock(&options.pane_id));
    let _send_guard = send_lock
        .as_deref()
        .map(|lock| lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));

    emit_data(options)?;

    if options.submit {
        if !SUBMIT_KEY_DELAY.is_zero() {
            thread::sleep(SUBMIT_KEY_DELAY);
        }
        emit_submit()?;
    }

    // A lone Esc keystroke (exactly ESC — arrow keys and other sequences arrive as
    // longer chunks) typed into a working agent's pane is the TUI's interrupt key,
    // and an interrupt during the thinking phase emits no hook and no transcript
    // line. Watch the agent so its Running status can't stick forever.
    if !options.paste && !options.submit && options.data == "\x1b" {
        crate::workspace::watch_agent_after_escape(state, &options.pane_id);
    }

    Ok(())
}

/// Removes embedded bracketed-paste markers from paste-mode payload data.
///
/// The paste boundary must be unforgeable: an embedded `ESC[201~` in the data
/// would terminate the bracketed paste early, so the receiving program (shell,
/// agent TUI) treats everything after it as *typed* input rather than pasted
/// text — turning attacker-controlled paste/turn content into command
/// injection. We strip the end marker (the standard terminal defense) and the
/// start marker too so the framing stays well-formed. Borrows unchanged in the
/// common case where no markers are present.
///
/// Stripping runs to a fixed point: a single non-overlapping `replace` pass can
/// leave a fresh marker behind when the input nests them (e.g. `\x1b[201\x1b[201~~`
/// collapses to a live `\x1b[201~`), so we repeat until no marker remains.
pub(crate) fn strip_bracketed_paste_markers(data: &str) -> Cow<'_, str> {
    if !data.contains("\x1b[200~") && !data.contains("\x1b[201~") {
        return Cow::Borrowed(data);
    }
    let mut cleaned = data.replace("\x1b[200~", "").replace("\x1b[201~", "");
    while cleaned.contains("\x1b[200~") || cleaned.contains("\x1b[201~") {
        cleaned = cleaned.replace("\x1b[200~", "").replace("\x1b[201~", "");
    }
    Cow::Owned(cleaned)
}

fn write_pane_data<W: Write + ?Sized>(
    writer: &mut W,
    options: &PaneWriteOptions,
) -> Result<(), String> {
    if options.paste {
        let data = strip_bracketed_paste_markers(&options.data);
        writer
            .write_all(b"\x1b[200~")
            .map_err(|err| format!("failed to write paste start: {err}"))?;
        writer
            .write_all(data.as_bytes())
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
    if state.pane_is_native(&pane_id)? == Some(true) {
        return state.update_pane_size(&pane_id, cols, rows);
    }
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

pub fn pane_activity(state: &AppState, pane_id: String) -> Result<PaneActivity, String> {
    // Validate the pane id against the model before inspecting the child handle. Process
    // inspection below is best-effort, but a genuinely missing pane is still a caller error.
    if !state.list_panes()?.iter().any(|pane| pane.id == pane_id) {
        return Err(format!("pane {pane_id} was not found"));
    }

    if state.pane_is_native(&pane_id)? == Some(true) {
        let Some(root_pid) = state.native_pane_pid(&pane_id)? else {
            return Ok(PaneActivity::idle());
        };
        let processes = running_descendant_processes(root_pid);
        return if processes.is_empty() {
            Ok(PaneActivity::idle())
        } else {
            Ok(PaneActivity::running_process(
                processes.len(),
                processes.first().map(|process| process.name.clone()),
            ))
        };
    }

    let child = state
        .pane_child(&pane_id)?
        .ok_or_else(|| format!("pane {pane_id} was not found"))?;
    let root_pid = {
        let mut child = child
            .lock()
            .map_err(|_| format!("pane {pane_id} child lock poisoned"))?;

        if child
            .try_wait()
            .map_err(|err| format!("failed to inspect pane {pane_id}: {err}"))?
            .is_some()
        {
            return Ok(PaneActivity::idle());
        }

        child.process_id()
    };

    let Some(root_pid) = root_pid else {
        return Ok(PaneActivity::idle());
    };
    let processes = running_descendant_processes(root_pid);
    if processes.is_empty() {
        Ok(PaneActivity::idle())
    } else {
        Ok(PaneActivity::running_process(
            processes.len(),
            processes.first().map(|process| process.name.clone()),
        ))
    }
}

/// Starts a lightweight descendant snapshotter once the native launcher reports
/// the PID that Ghostty owns. The snapshot retains processes that later detach or
/// become reparented, while the start signature prevents a recycled PID from being
/// signalled during a much later pane close.
pub fn track_native_pane_process(state: AppState, pane_id: String, root_pid: u32) {
    let Some(root) = tracked_process(root_pid) else {
        return;
    };
    let mut tree = NativeProcessTree {
        root,
        descendants: HashMap::new(),
    };
    merge_live_descendants(&mut tree);
    if let Ok(mut trees) = native_process_trees().lock() {
        trees.insert(pane_id.clone(), tree);
    }

    thread::spawn(move || {
        let mut tick: u32 = 0;
        loop {
            thread::sleep(CHILD_WATCH_INTERVAL);
            tick = tick.wrapping_add(1);
            if state.native_pane_pid(&pane_id).ok().flatten() != Some(root_pid) {
                break;
            }
            let root_alive = process_matches(
                native_process_trees()
                    .lock()
                    .ok()
                    .and_then(|trees| trees.get(&pane_id).map(|tree| tree.root.clone()))
                    .as_ref(),
            );
            // The root-liveness probe above is a proc_pidinfo syscall, so it can
            // run every tick; the descendant walk spawns a `pgrep` per tree node
            // and is gated to the coarse refresh, matching the portable watcher.
            // Teardown accuracy doesn't depend on this cadence: the close path
            // re-merges via take_native_process_tree before signalling.
            if tick.is_multiple_of(DESCENDANT_REFRESH_TICKS)
                && let Ok(mut trees) = native_process_trees().lock()
                && let Some(tree) = trees.get_mut(&pane_id)
                && tree.root.pid == root_pid
            {
                merge_live_descendants(tree);
            }
            if !root_alive {
                break;
            }
        }
    });
}

pub fn kill_pane(state: &AppState, pane_id: String) -> Result<(), String> {
    if state.pane_is_native(&pane_id)? == Some(true) {
        return kill_native_pane(state, pane_id);
    }
    let child = state
        .pane_child(&pane_id)?
        .ok_or_else(|| format!("pane {pane_id} was not found"))?;
    let pane_agent_id = state.agent_by_pane(&pane_id)?.map(|agent| agent.id);
    if let Err(err) = state.capture_last_closed_pane(&pane_id) {
        eprintln!("qmux: failed to capture closed pane {pane_id}: {err}");
    }
    if let Err(err) = kill_child(&pane_id, child) {
        // The kill couldn't confirm the child dead. If it has since exited — it may
        // have died from the group SIGTERM just after kill_child gave up — reap and
        // reclaim the pane now instead of stranding it in the model. Otherwise leave
        // it in place: the reader thread's EOF path reaps the still-live process when
        // it finally exits, and removing it here would drop the child handle and orphan
        // a zombie.
        let exited = state
            .pane_child(&pane_id)
            .ok()
            .flatten()
            .and_then(|child| {
                child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok().flatten())
            })
            .is_some();
        if !exited {
            state.clear_last_closed_pane_for_pane(&pane_id);
            return Err(err);
        }
        eprintln!(
            "qmux: kill for pane {pane_id} errored but the child has exited; reclaiming: {err}"
        );
    }
    state.remove_pane(&pane_id)?;
    if let Some(agent_id) = pane_agent_id
        && let Err(err) = release_waiters_for_agent(state, &agent_id)
    {
        eprintln!("qmux: failed to release waiters for closed agent {agent_id}: {err}");
    }
    Ok(())
}

fn kill_native_pane(state: &AppState, pane_id: String) -> Result<(), String> {
    let pane_agent_id = state.agent_by_pane(&pane_id)?.map(|agent| agent.id);
    if let Err(err) = state.capture_last_closed_pane(&pane_id) {
        eprintln!("qmux: failed to capture closed native pane {pane_id}: {err}");
    }
    let process_tree = take_native_process_tree(state, &pane_id);
    if let Some(tree) = process_tree.as_ref() {
        signal_native_process_tree(tree, libc::SIGTERM);
    }
    // Own this close before touching the surface: `close_surface` can fire the
    // close delegate re-entrantly, and `native_pane_did_close` must not run its
    // own capture/remove/emit sequence for a close this function handles.
    if let Ok(mut closing) = closing_native_panes().lock() {
        closing.insert(pane_id.clone());
    }
    let terminate_result = crate::native_terminal::terminate(&pane_id);
    let had_process_tree = process_tree.is_some();
    if let Some(tree) = process_tree {
        // Escalate to SIGKILL after the grace window on a background thread,
        // like the natural-exit path in `native_pane_did_close`: `pane_kill`
        // is a synchronous command on the main thread, and sleeping the grace
        // period inline stalled the UI for every pane close.
        thread::spawn(move || {
            finish_native_process_tree_termination(&tree, NATIVE_PROCESS_TERM_GRACE);
        });
    }
    if let Err(err) = terminate_result
        && state.pane_is_native(&pane_id).ok().flatten() == Some(true)
    {
        // Only leave the pane in place for a retry when nothing destructive has
        // happened yet (no tracked tree meant nothing was signalled). Once the
        // process tree has been SIGTERM/SIGKILLed, keeping a "Running" pane
        // whose processes are dead would desync state — fall through and
        // remove it despite the surface-close error.
        if !had_process_tree {
            state.clear_last_closed_pane_for_pane(&pane_id);
            if let Ok(mut closing) = closing_native_panes().lock() {
                closing.remove(&pane_id);
            }
            return Err(err);
        }
        eprintln!(
            "qmux: native surface close failed for pane {pane_id}; removing the pane anyway: {err}"
        );
    }
    let _ = state.remove_pane(&pane_id);
    let _ = crate::native_terminal::remove(&pane_id);
    if let Some(agent_id) = pane_agent_id
        && let Err(err) = release_waiters_for_agent(state, &agent_id)
    {
        eprintln!("qmux: failed to release waiters for closed agent {agent_id}: {err}");
    }
    remove_shell_integration_dir(&pane_id);
    if let Ok(mut closing) = closing_native_panes().lock() {
        closing.remove(&pane_id);
    }
    Ok(())
}

pub fn native_pane_did_close(state: &AppState, pane_id: &str, _process_alive: bool) {
    // A close initiated by `kill_native_pane` is fully handled there; this
    // delegate may fire re-entrantly from its `terminate` call while the pane
    // is still registered, and running the sequence below too would duplicate
    // the undo snapshot and double-release waiters. (A late delivery after
    // `kill_native_pane` finishes is caught by the pane check below instead.)
    if closing_native_panes()
        .lock()
        .map(|closing| closing.contains(pane_id))
        .unwrap_or(false)
    {
        return;
    }
    if state.pane_is_native(pane_id).ok().flatten() != Some(true) {
        return;
    }
    let process_tree = take_native_process_tree(state, pane_id);
    if let Some(tree) = process_tree {
        signal_native_process_tree(&tree, libc::SIGTERM);
        thread::spawn(move || {
            finish_native_process_tree_termination(&tree, NATIVE_PROCESS_TERM_GRACE);
        });
    }
    let pane_agent_id = state
        .agent_by_pane(pane_id)
        .ok()
        .flatten()
        .map(|agent| agent.id);
    if state
        .closing_pane_would_strand_queued_work(pane_id)
        .unwrap_or(false)
        && let Err(err) = state.capture_last_closed_pane(pane_id)
    {
        eprintln!("qmux: failed to capture exited native pane {pane_id}: {err}");
    }
    if let Err(err) = state.remove_pane(pane_id) {
        eprintln!("qmux: failed to remove exited native pane {pane_id}: {err}");
    }
    if let Some(agent_id) = pane_agent_id
        && let Err(err) = release_waiters_for_agent(state, &agent_id)
    {
        eprintln!("qmux: failed to release waiters for exited agent {agent_id}: {err}");
    }
    remove_shell_integration_dir(pane_id);
    state.emit(QmuxEvent::pty_exit(pane_id.to_string(), None));
}

/// Best-effort teardown of every pane's process tree on app exit.
///
/// Quitting the app just calls `app.exit`, which bypasses the per-pane
/// `kill_pane` path: nothing signals the panes' children, so anything an agent
/// left running that survives the PTY hangup — dev servers, MCP/language
/// servers, `setsid`/disowned jobs — is reparented to launchd and leaks across
/// every quit. This runs the same process-group signal + descendant walk as
/// closing a pane on each live pane, skipping the model/undo bookkeeping since
/// the process is about to exit anyway. It cannot help a hard SIGKILL/force-quit,
/// which no in-process handler can intercept.
pub fn kill_all_panes(state: &AppState) {
    let mut native_process_trees = Vec::new();
    match state.native_pane_ids() {
        Ok(panes) => {
            for pane_id in panes {
                if let Some(tree) = take_native_process_tree(state, &pane_id) {
                    signal_native_process_tree(&tree, libc::SIGTERM);
                    native_process_trees.push(tree);
                }
                if let Err(err) = crate::native_terminal::terminate(&pane_id) {
                    eprintln!("qmux: failed to close native pane {pane_id} on exit: {err}");
                }
                remove_shell_integration_dir(&pane_id);
            }
        }
        Err(err) => eprintln!("qmux: failed to enumerate native panes for exit cleanup: {err}"),
    }
    if !native_process_trees.is_empty() {
        thread::sleep(NATIVE_PROCESS_TERM_GRACE);
        for tree in &native_process_trees {
            signal_native_process_tree(tree, libc::SIGKILL);
        }
    }
    let children = match state.all_pane_children() {
        Ok(children) => children,
        Err(err) => {
            eprintln!("qmux: failed to enumerate panes for exit cleanup: {err}");
            return;
        }
    };
    for (pane_id, child) in children {
        if let Err(err) = kill_child(&pane_id, child) {
            eprintln!("qmux: failed to kill pane {pane_id} on exit: {err}");
        }
        // The reader-thread EOF path that normally removes these dirs won't run once
        // the process is exiting, so clean them up here instead of leaking them into
        // /tmp until the OS clears it.
        remove_shell_integration_dir(&pane_id);
    }
}

pub fn close_worktree_pane(
    state: &AppState,
    agent_id: &str,
    delete_worktree: bool,
) -> Result<(), String> {
    let agent = state
        .agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} was not found"))?;
    let pane_id = agent
        .pane_id
        .clone()
        .ok_or_else(|| format!("agent {agent_id} has no pane to close"))?;
    let worktree_removal = if delete_worktree {
        Some(capture_agent_worktree_removal(state, &agent)?)
    } else {
        None
    };

    kill_pane(state, pane_id)?;

    if let Some(removal) = worktree_removal {
        remove_captured_worktree(removal)?;
        state.clear_last_closed_pane_for_agent(agent_id);
    }

    Ok(())
}

#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
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
        let pane_agent_id = state
            .agent_by_pane(&pane_id)
            .ok()
            .flatten()
            .map(|agent| agent.id);
        // A natural exit normally leaves no undo snapshot (unlike `kill_pane`), but if this
        // is the group's last pane and the group still has queued turns, removing it would
        // prune that pending work with no way back. Capture a close snapshot first so it
        // can be reopened, matching the explicit-close path.
        if state
            .closing_pane_would_strand_queued_work(&pane_id)
            .unwrap_or(false)
            && let Err(err) = state.capture_last_closed_pane(&pane_id)
        {
            eprintln!("qmux: failed to capture exited pane {pane_id}: {err}");
        }
        if let Err(err) = state.remove_pane(&pane_id) {
            // A failure here (e.g. a poisoned model lock) leaves a dead pane in
            // state; log it so the stale entry has a trace rather than vanishing.
            eprintln!("qmux: failed to remove exited pane {pane_id}: {err}");
        }
        if let Some(agent_id) = pane_agent_id
            && let Err(err) = release_waiters_for_agent(&state, &agent_id)
        {
            eprintln!("qmux: failed to release waiters for exited agent {agent_id}: {err}");
        }
        remove_shell_integration_dir(&pane_id);
        state.emit(QmuxEvent::pty_exit(pane_id, exit_code));
    });
}

/// Watches a pane's direct child so a pane whose shell exits while a backgrounded
/// descendant still holds the PTY slave open is torn down instead of hanging.
///
/// The reader thread only unblocks (and runs teardown) on PTY EOF, which never
/// arrives while any descendant keeps a slave fd open. Left alone, such a pane
/// leaks its reader thread, leaves the exited shell as a zombie, and stays stuck
/// "Running" in the UI. This watcher notices the direct child has exited and
/// forces the surviving descendants down so the slave closes, the reader hits
/// EOF, and the existing per-pane cleanup runs.
///
/// A backgrounded job gets its own process group and is reparented off the shell
/// the instant the shell exits, so after the fact neither the shell's process
/// group nor a live ppid walk can find it. We therefore keep a recent snapshot of
/// the descendant pids (refreshed while the child is alive) and signal that
/// snapshot — plus the process group, for anything still in it — on exit. A job
/// spawned and orphaned within a single refresh window can still be missed, which
/// leaves the same state as before this watcher existed for that one narrow case.
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
fn start_child_watcher(
    state: AppState,
    pane_id: String,
    child: SharedChild,
    root_pid: Option<u32>,
) {
    let Some(root_pid) = root_pid else {
        return;
    };
    thread::spawn(move || {
        let mut descendants = descendant_process_ids(root_pid);
        let mut tick: u32 = 0;
        loop {
            thread::sleep(CHILD_WATCH_INTERVAL);
            // The pane's child Arc is the liveness handle: once `kill_pane` or the
            // reader's EOF cleanup removes the pane — or a respawn replaces it with
            // a fresh child under a reused id — this watcher has nothing left to do.
            match state.pane_child(&pane_id) {
                Ok(Some(current)) if Arc::ptr_eq(&current, &child) => {}
                _ => break,
            }
            let exited = {
                let Ok(mut guard) = child.lock() else {
                    break;
                };
                match guard.try_wait() {
                    Ok(status) => status.is_some(),
                    Err(_) => break,
                }
            };
            if !exited {
                tick = tick.wrapping_add(1);
                if tick.is_multiple_of(DESCENDANT_REFRESH_TICKS) {
                    descendants = descendant_process_ids(root_pid);
                }
                continue;
            }
            // Direct child gone but the pane is still present: a descendant is
            // holding the PTY slave open and the reader is blocked on read(). Force
            // the tree down (best-effort) so the slave closes, the reader hits EOF,
            // and the normal cleanup runs.
            let group = format!("-{root_pid}");
            let _ = Command::new("/bin/kill").arg("-TERM").arg(&group).status();
            for pid in &descendants {
                let _ = Command::new("/bin/kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .status();
            }
            break;
        }
    });
}

/// Waits on a pane's child so the exited process is reaped (no zombie) and returns
/// its exit code. Best-effort: a pane already removed (e.g. by `kill_pane`) or a
/// poisoned child lock yields `None`.
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
fn reap_pane_child(state: &AppState, pane_id: &str) -> Option<i32> {
    let child = state.pane_child(pane_id).ok().flatten()?;
    let mut child = child.lock().ok()?;
    child.wait().ok().map(|status| status.exit_code() as i32)
}

/// Appends to the pre-attach backlog, dropping the oldest bytes once it exceeds
/// the cap so a runaway pre-attach burst can't grow unbounded.
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
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

fn native_process_trees() -> &'static Mutex<HashMap<String, NativeProcessTree>> {
    NATIVE_PROCESS_TREES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Panes whose close is currently owned by `kill_native_pane`. Ghostty's
/// `close_surface` can invoke the close delegate before `terminate` returns,
/// which would re-enter `native_pane_did_close` while the pane is still
/// registered and capture/remove/emit a second time for the same close.
fn closing_native_panes() -> &'static Mutex<HashSet<String>> {
    CLOSING_NATIVE_PANES.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [libc::c_char; 16],
    pbi_name: [libc::c_char; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        buffer_size: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn process_start_signature(pid: u32) -> Option<String> {
    const PROC_PIDTBSDINFO: libc::c_int = 3;
    let mut info = std::mem::MaybeUninit::<ProcBsdInfo>::zeroed();
    let size = std::mem::size_of::<ProcBsdInfo>();
    let read = unsafe {
        proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(format!(
        "{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}

#[cfg(not(target_os = "macos"))]
fn process_start_signature(pid: u32) -> Option<String> {
    let output = Command::new("/bin/ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("lstart=")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let signature = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!signature.is_empty()).then_some(signature)
}

fn tracked_process(pid: u32) -> Option<TrackedProcess> {
    Some(TrackedProcess {
        pid,
        start_signature: process_start_signature(pid)?,
    })
}

fn process_matches(process: Option<&TrackedProcess>) -> bool {
    let Some(process) = process else { return false };
    process_start_signature(process.pid).as_deref() == Some(process.start_signature.as_str())
}

fn merge_live_descendants(tree: &mut NativeProcessTree) {
    for pid in descendant_process_ids(tree.root.pid) {
        let Some(process) = tracked_process(pid) else {
            continue;
        };
        match tree.descendants.get(&pid) {
            Some(existing) if process_matches(Some(existing)) => {}
            _ => {
                tree.descendants.insert(pid, process);
            }
        }
    }
}

fn take_native_process_tree(state: &AppState, pane_id: &str) -> Option<NativeProcessTree> {
    let root_pid = state.native_pane_pid(pane_id).ok().flatten()?;
    let mut tree = native_process_trees()
        .lock()
        .ok()
        .and_then(|mut trees| trees.remove(pane_id))
        .filter(|tree| tree.root.pid == root_pid)?;
    merge_live_descendants(&mut tree);
    Some(tree)
}

fn signal_native_process_tree(tree: &NativeProcessTree, signal: libc::c_int) {
    if process_matches(Some(&tree.root)) {
        // Ghostty launches the command as a session/process-group leader. Verify
        // that invariant before using a negative pid so a malformed report can
        // never target qmux's own group.
        let group_id = unsafe { libc::getpgid(tree.root.pid as libc::pid_t) };
        if group_id == tree.root.pid as libc::pid_t {
            let _ = unsafe { libc::kill(-group_id, signal) };
        }
        let _ = unsafe { libc::kill(tree.root.pid as libc::pid_t, signal) };
    }
    for process in tree.descendants.values() {
        if process.pid != tree.root.pid && process_matches(Some(process)) {
            let _ = unsafe { libc::kill(process.pid as libc::pid_t, signal) };
        }
    }
}

fn finish_native_process_tree_termination(tree: &NativeProcessTree, grace: Duration) {
    if !grace.is_zero() {
        thread::sleep(grace);
    }
    signal_native_process_tree(tree, libc::SIGKILL);
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct RunningProcess {
    name: String,
}

fn running_descendant_processes(pid: u32) -> Vec<RunningProcess> {
    running_processes(&descendant_process_ids(pid))
}

/// Filters `pids` down to live, non-zombie processes with a single `ps`
/// invocation — one subprocess total instead of one per pid — returning each
/// one's executable basename. When a requested pid is already gone, `ps`
/// still prints rows for the live ones but its exit status is
/// platform-dependent, so stdout is parsed regardless of exit status.
fn running_processes(pids: &[u32]) -> Vec<RunningProcess> {
    if pids.is_empty() {
        return Vec::new();
    }
    let pid_list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let Ok(output) = Command::new("/bin/ps")
        .arg("-p")
        .arg(pid_list)
        .arg("-o")
        .arg("stat=")
        .arg("-o")
        .arg("comm=")
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(running_process_from_line)
        .collect()
}

fn descendant_process_ids(pid: u32) -> Vec<u32> {
    let mut descendants = Vec::new();
    let mut seen = HashSet::new();
    collect_descendant_process_ids(pid, &mut seen, &mut descendants);
    descendants
}

fn collect_descendant_process_ids(pid: u32, seen: &mut HashSet<u32>, descendants: &mut Vec<u32>) {
    for child_pid in child_process_ids(pid) {
        if !seen.insert(child_pid) {
            continue;
        }
        descendants.push(child_pid);
        collect_descendant_process_ids(child_pid, seen, descendants);
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

fn running_process_from_line(line: &str) -> Option<RunningProcess> {
    let mut parts = line.split_whitespace();
    let status = parts.next()?;
    if status.starts_with('Z') {
        return None;
    }
    let command = parts.collect::<Vec<_>>().join(" ");
    let name = Path::new(&command)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(command.trim())
        .trim()
        .to_string();
    if name.is_empty() {
        return None;
    }

    Some(RunningProcess { name })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
        OpencodeAdapterConfig, QmuxConfig,
    };
    use crate::scrollback::read_pane_scrollback;
    use crate::workspace::{AgentInfo, AgentStatus, GroupInfo};
    use std::cell::RefCell;
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn wait_for_test_child(child: &mut std::process::Child) -> bool {
        for _ in 0..50 {
            if child.try_wait().ok().flatten().is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn passwd_login_shell_resolves_for_current_user() {
        let shell = passwd_login_shell().expect("current user should have a passwd entry");
        assert!(shell.starts_with('/'), "expected an absolute path: {shell}");
    }

    #[test]
    fn pane_shell_is_never_empty() {
        assert!(!pane_shell().is_empty());
    }

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
                grok: GrokAdapterConfig {
                    binary: Some("grok".to_string()),
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
                grok: GrokAdapterConfig {
                    binary: Some("grok".to_string()),
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

        let zsh_script = zsh_init_script(&qmux_cli, &shell_commands, None, true);
        let bash_script = bash_init_script(&qmux_cli, &shell_commands, None, true);

        for script in [zsh_script, bash_script] {
            assert!(script.contains("codex() {"));
            assert!(script.contains("'/Applications/qmux app/qmux' agent-exec codex \"$@\""));
            assert!(script.contains("unalias codex"));
            assert!(script.contains("claude() {"));
            assert!(script.contains("'/Applications/qmux app/qmux' agent-exec claude \"$@\""));
            assert!(script.contains("unalias claude"));
            // Detach is handled by agent-exec after the adapter process truly exits.
            // The shell wrapper must not detach after job-control stop/background.
            assert!(!script.contains("agent-detach"));
            assert!(!script.contains("local __qmux_status=$?"));
            assert!(!script.contains("return $__qmux_status"));
            // `qmux` itself is a passthrough so `qmux open <file>` works at the prompt
            // without qmux being on PATH.
            assert!(script.contains("unalias qmux"));
            assert!(script.contains("qmux() {"));
            assert!(script.contains("'/Applications/qmux app/qmux' \"$@\""));
            // Shell integration reports cwd changes so restarts reopen the last dir.
            assert!(script.contains("'/Applications/qmux app/qmux' cwd"));
            assert!(script.contains("__qmux_report_cwd"));
            // No resume requested: the script must not auto-run an agent on startup.
            assert!(!script.contains("--resume"));
        }
    }

    #[test]
    fn zsh_init_script_resets_histfile_left_pointing_at_integration_dir() {
        let qmux_cli = PathBuf::from("/Applications/qmux app/qmux");

        let script = zsh_init_script(&qmux_cli, &[], None, false);

        // macOS's /etc/zshrc sets HISTFILE from ZDOTDIR before our rc runs, so a
        // pane would otherwise read/write history in the deleted-on-close scratch
        // dir. The reset must happen before the user's .zshrc is sourced so a
        // user-set HISTFILE still wins.
        assert!(script.contains(r#"case "${HISTFILE:-}" in"#));
        assert!(script.contains(r#""$__qmux_zdotdir"/*) HISTFILE="$ZDOTDIR/.zsh_history" ;;"#));
        let reset_pos = script.find("HISTFILE=\"$ZDOTDIR/.zsh_history\"").unwrap();
        let source_pos = script.find(r#"source "$ZDOTDIR/.zshrc""#).unwrap();
        assert!(reset_pos < source_pos);
    }

    #[test]
    fn init_scripts_append_resume_command_when_requested() {
        let qmux_cli = PathBuf::from("/Applications/qmux app/qmux");
        let shell_commands = [ShellCommandIntegration {
            command_name: "claude",
            adapter_id: "claude",
        }];
        let resume = "claude --resume 'sess-1'";

        let zsh_script = zsh_init_script(&qmux_cli, &shell_commands, Some(resume), true);
        let bash_script = bash_init_script(&qmux_cli, &shell_commands, Some(resume), true);

        for script in [zsh_script, bash_script] {
            // The resume runs through the wrapper defined earlier in the script, and as
            // the final line so the shell is fully initialized before the agent starts.
            assert!(script.contains("claude() {"));
            assert!(script.trim_end().ends_with(resume));
        }
    }

    #[test]
    fn init_scripts_source_login_files_only_in_login_mode() {
        let qmux_cli = PathBuf::from("/Applications/qmux app/qmux");
        let shell_commands = [ShellCommandIntegration {
            command_name: "claude",
            adapter_id: "claude",
        }];

        // Login zsh sources .zprofile and .zlogin around the always-sourced .zshrc;
        // a non-login shell sources only .zshrc.
        let zsh_login = zsh_init_script(&qmux_cli, &shell_commands, None, true);
        assert!(zsh_login.contains("source \"$ZDOTDIR/.zprofile\""));
        assert!(zsh_login.contains("source \"$ZDOTDIR/.zshrc\""));
        assert!(zsh_login.contains("source \"$ZDOTDIR/.zlogin\""));

        let zsh_plain = zsh_init_script(&qmux_cli, &shell_commands, None, false);
        assert!(zsh_plain.contains("source \"$ZDOTDIR/.zshrc\""));
        assert!(!zsh_plain.contains(".zprofile"));
        assert!(!zsh_plain.contains(".zlogin"));

        // Login bash reproduces bash's own login-file lookup (which conventionally
        // pulls in .bashrc); a non-login shell sources the captured .bashrc directly.
        let bash_login = bash_init_script(&qmux_cli, &shell_commands, None, true);
        assert!(bash_login.contains("$HOME/.bash_profile"));
        assert!(bash_login.contains("$HOME/.bash_login"));
        assert!(bash_login.contains("$HOME/.profile"));
        assert!(!bash_login.contains("QMUX_ORIGINAL_BASHRC"));

        let bash_plain = bash_init_script(&qmux_cli, &shell_commands, None, false);
        assert!(bash_plain.contains("QMUX_ORIGINAL_BASHRC"));
        assert!(!bash_plain.contains(".bash_profile"));
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
    fn bracketed_paste_strips_embedded_end_marker() {
        let mut writer = RecordingWriter::default();
        // Payload carries a forged paste terminator followed by a command.
        let options = write_options("safe\x1b[201~\nrm -rf ~\n", true, false);

        write_pane_input(&mut writer, &options, Duration::ZERO).unwrap();

        // The embedded ESC[201~ is removed, so the paste stays framed as a
        // single inert block and the trailing bytes cannot escape to be typed.
        assert_eq!(writer.bytes, b"\x1b[200~safe\nrm -rf ~\n\x1b[201~");
    }

    #[test]
    fn bracketed_paste_strips_nested_end_marker() {
        let mut writer = RecordingWriter::default();
        // A nested marker that a single non-overlapping pass would leave a live
        // ESC[201~ behind — the strip must run to a fixed point.
        let options = write_options("safe\x1b[201\x1b[201~~\nrm -rf ~\n", true, false);

        write_pane_input(&mut writer, &options, Duration::ZERO).unwrap();

        assert_eq!(writer.bytes, b"\x1b[200~safe\nrm -rf ~\n\x1b[201~");
    }

    #[test]
    fn bracketed_paste_leaves_marker_free_data_untouched() {
        let mut writer = RecordingWriter::default();
        let options = write_options("ordinary multi\nline text", true, false);

        write_pane_input(&mut writer, &options, Duration::ZERO).unwrap();

        assert_eq!(writer.bytes, b"\x1b[200~ordinary multi\nline text\x1b[201~");
    }

    #[test]
    fn submit_after_plain_write_sends_return_after_text() {
        let mut writer = RecordingWriter::default();
        let options = write_options("y", false, true);

        write_pane_input(&mut writer, &options, Duration::ZERO).unwrap();

        assert_eq!(writer.bytes, b"y\r");
        assert_eq!(writer.flush_offsets, vec![1, 2]);
    }

    #[test]
    fn native_paste_uses_ghostty_paste_action_without_manual_markers() {
        let options = write_options("test", true, true);
        let mut raw_text = None;
        let mut approved_paste = None;

        write_native_pane_data(
            &options,
            |data| {
                raw_text = Some(data.to_string());
                Ok(())
            },
            |data| {
                approved_paste = Some(data.to_string());
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(raw_text, None);
        assert_eq!(approved_paste.as_deref(), Some("test"));
    }

    #[test]
    fn native_submission_uses_approved_paste_then_submit_key() {
        let state = test_state();
        let options = write_options("test", true, true);
        let calls = RefCell::new(Vec::new());

        write_native_pane_input(
            &state,
            &options,
            |data| {
                calls.borrow_mut().push(format!("text:{data:?}"));
                Ok(())
            },
            |data| {
                calls.borrow_mut().push(format!("paste:{data:?}"));
                Ok(())
            },
            || {
                calls.borrow_mut().push("submit-key".to_string());
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(calls.into_inner(), ["paste:\"test\"", "submit-key"]);
    }

    fn spawn_test_pty(state: &AppState, pane_id: &str, args: Vec<String>) -> PaneInfo {
        spawn_pty(
            state,
            PtySpawnSpec {
                pane_id: Some(pane_id.to_string()),
                agent_id: None,
                group_id: "group-1".to_string(),
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

    fn git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn close_worktree_pane_deletes_after_agent_is_pruned() {
        let workspace = temp_workspace();
        let repo = workspace.join("repo");
        let worktree = workspace.join("agent-worktree");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "qmux test"]);
        git(&repo, &["commit", "--allow-empty", "-m", "init"]);

        let branch = "qmux/test-agent";
        let worktree_arg = worktree.to_string_lossy().to_string();
        git(
            &repo,
            &["worktree", "add", "-b", branch, &worktree_arg, "HEAD"],
        );

        let state = test_state_with_workspace(workspace.clone());
        state
            .insert_group_after(
                GroupInfo {
                    id: "group-1".to_string(),
                    name: "group".to_string(),
                    name_override: None,
                    dir: workspace.to_string_lossy().to_string(),
                    managed_dir: workspace.join("managed").to_string_lossy().to_string(),
                    base_repo: Some(repo.to_string_lossy().to_string()),
                    base_ref: None,
                    parent_id: None,
                    created_at: 1,
                    collapsed: false,
                    agents: vec!["agent-1".to_string()],
                },
                None,
            )
            .unwrap();
        let pane = spawn_test_pty(
            &state,
            "pane-worktree",
            vec!["-c".to_string(), "sleep 30".to_string()],
        );
        state
            .insert_agent(AgentInfo {
                id: "agent-1".to_string(),
                group_id: "group-1".to_string(),
                adapter: "claude".to_string(),
                worktree_dir: worktree.to_string_lossy().to_string(),
                branch: Some(branch.to_string()),
                pane_id: Some(pane.id),
                orphaned_queue_pane_id: None,
                session_id: None,
                transcript_path: None,
                status: AgentStatus::Running,
                model: None,
                parent_id: None,
                fork_point: None,
                root_session_id: None,
                thread_id: None,
                branch_id: None,
                paused: false,
                created_at: 1,
            })
            .unwrap();

        close_worktree_pane(&state, "agent-1", true).unwrap();

        assert!(state.agent("agent-1").unwrap().is_none());
        assert!(!worktree.exists());

        fs::remove_dir_all(workspace).ok();
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
    fn pane_activity_is_idle_for_shell_without_children() {
        let state = test_state();
        let pane = spawn_test_pty(&state, "pane-idle", Vec::new());

        assert_eq!(
            pane_activity(&state, pane.id.clone()).unwrap(),
            PaneActivity::idle()
        );

        kill_pane(&state, pane.id).expect("cleanup test pane");
    }

    #[test]
    fn pane_activity_detects_running_descendant_processes() {
        let state = test_state();
        let pane = spawn_test_pty(
            &state,
            "pane-busy",
            vec!["-c".to_string(), "sleep 30 & wait".to_string()],
        );

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let activity = pane_activity(&state, pane.id.clone()).unwrap();
            if matches!(activity.kind, PaneActivityKind::RunningProcess) {
                assert!(activity.process_count >= 1);
                assert!(activity.process_summary.is_some());
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "pane activity never detected the child process"
            );
            thread::sleep(Duration::from_millis(20));
        }

        kill_pane(&state, pane.id).expect("cleanup test pane");
    }

    #[test]
    fn native_process_tree_terminates_group_and_tracked_escapee() {
        let mut root = Command::new("/bin/sh");
        root.arg("-c")
            .arg("trap '' TERM; exec /bin/sleep 30")
            .process_group(0);
        let mut root = root.spawn().expect("spawn isolated native root");
        let mut escaped = Command::new("/bin/sh");
        escaped
            .arg("-c")
            .arg("trap '' TERM; exec /bin/sleep 30")
            .process_group(0);
        let mut escaped = escaped.spawn().expect("spawn simulated escaped descendant");

        let root_process = tracked_process(root.id()).expect("track root identity");
        let escaped_process = tracked_process(escaped.id()).expect("track escaped identity");
        let tree = NativeProcessTree {
            root: root_process,
            descendants: HashMap::from([(escaped_process.pid, escaped_process)]),
        };

        signal_native_process_tree(&tree, libc::SIGTERM);
        finish_native_process_tree_termination(&tree, Duration::from_millis(50));
        assert!(
            wait_for_test_child(&mut root),
            "native root survived teardown"
        );
        assert!(
            wait_for_test_child(&mut escaped),
            "tracked escaped descendant survived teardown"
        );
    }

    #[test]
    fn native_process_tree_does_not_signal_reused_identity() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn identity test child");
        let mut stale = tracked_process(child.id()).expect("track child identity");
        stale.start_signature.push_str(" stale");
        let tree = NativeProcessTree {
            root: stale,
            descendants: HashMap::new(),
        };

        signal_native_process_tree(&tree, libc::SIGKILL);
        thread::sleep(Duration::from_millis(30));
        assert!(child.try_wait().expect("inspect child").is_none());
        let _ = child.kill();
        let _ = child.wait();
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
    fn append_capped_keeps_large_recovered_tui_repaint() {
        let mut buffer = Vec::new();
        let repaint = vec![b'x'; 512 * 1024];
        append_capped(&mut buffer, &repaint);

        assert_eq!(buffer.len(), repaint.len());
        assert_eq!(buffer[0], b'x');
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
