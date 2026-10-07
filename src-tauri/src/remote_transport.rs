//! Shared SSH transports and pane-scoped hook forwards.
//!
//! A TTY is only a channel on a transport. Replacing that channel must never
//! unlink its hook socket: OpenSSH retains -R registrations in the master.
//! Only this manager may cancel, unlink and re-register a managed forward.
use crate::host::{RemoteTmuxCommands, SocketForward};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::process::{Command, Output};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

// Leave room under OpenSSH's default MaxSessions=10 for forward setup/recovery.
// Slot zero is reserved for the existing batch/transcript transport: every
// agent can also hold a transcript channel, so sharing it with TTYs can exhaust
// the server even when the number of terminal channels alone is below ten.
const PANES_PER_MASTER: usize = 6;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

type Runner<'a> = dyn FnMut(&[String], &str, Duration) -> Result<Output, String> + 'a;

static CONTROL_PREFIX: LazyLock<String> = LazyLock::new(|| {
    // A new namespace on each app run prevents recovery/shutdown from retiring
    // a different app's master, including an orphan from a previous run.
    let mut nonce = [0u8; 8];
    getrandom::getrandom(&mut nonce).expect("SSH transport namespace requires randomness");
    format!("~/.ssh/qmux-{:016x}", u64::from_ne_bytes(nonce))
});

pub(crate) fn control_path(destination: &str) -> String {
    // Hash the configured destination, not %C: on newer OpenSSH, %C includes
    // ProxyJump, which changes when an attachment disables connection fallback.
    // Aliases intentionally remain distinct; config/auth is resolved by ssh.
    let digest = Sha256::digest(destination.as_bytes());
    let suffix: String = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}-{suffix}", *CONTROL_PREFIX)
}

#[derive(Clone)]
struct ForwardLease {
    forward: SocketForward,
    slot: usize,
    // A locally observed master PID, never a remote process identity. A new
    // master has no forwards even if it uses the same control socket pathname.
    master_pid: Option<u32>,
}

struct HostPool {
    base: Vec<String>,
    forwards: HashMap<String, ForwardLease>,
    slots: usize,
}

#[derive(Default)]
struct Registry {
    hosts: HashMap<Vec<String>, Arc<Mutex<HostPool>>>,
    stopped: bool,
}
static HOSTS: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn ssh_base(commands: &RemoteTmuxCommands) -> Option<Vec<String>> {
    let argv = &commands.probe_argv;
    if argv.first().map(String::as_str) != Some("ssh") {
        return None;
    }
    let end = argv.iter().position(|arg| arg == "--")? + 2;
    if end >= argv.len()
        || !argv
            .iter()
            .any(|arg| arg == &format!("ControlPath={}", control_path(&argv[end - 1])))
    {
        return None;
    }
    Some(argv[..end].to_vec())
}

fn pool(commands: &RemoteTmuxCommands) -> Result<Option<Arc<Mutex<HostPool>>>, String> {
    if commands.hook_forward.is_none() {
        return Ok(None);
    }
    let base = ssh_base(commands).ok_or("remote attachment has no managed SSH transport")?;
    let mut registry = HOSTS.lock().unwrap_or_else(|e| e.into_inner());
    if registry.stopped {
        return Err("remote transport manager is shutting down".into());
    }
    Ok(Some(
        registry
            .hosts
            .entry(base.clone())
            .or_insert_with(|| {
                Arc::new(Mutex::new(HostPool {
                    base,
                    forwards: HashMap::new(),
                    slots: 2,
                }))
            })
            .clone(),
    ))
}

fn lock_pool<'a>(
    pool: &'a Mutex<HostPool>,
    cancelled: &impl Fn() -> bool,
) -> Result<MutexGuard<'a, HostPool>, String> {
    loop {
        if cancelled() {
            return Err("recovery superseded".into());
        }
        match pool.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(e)) => return Ok(e.into_inner()),
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn run(
    argv: &[String],
    action: &str,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Output, String> {
    let (program, args) = argv.split_first().ok_or("empty SSH transport command")?;
    let mut command = Command::new(program);
    command.args(args).env("LC_ALL", "C");
    crate::remote_process::output_with_timeout(command, None, action, timeout, cancelled)
}

fn require_success(output: Output, action: &str) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "failed to {action}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn options(base: &[String], extra: &[String]) -> Vec<String> {
    let mut argv = base.to_vec();
    let at = argv
        .iter()
        .position(|arg| arg == "--")
        .expect("validated SSH argv");
    argv.splice(at..at, extra.iter().cloned());
    argv
}

fn control(base: &[String], op: &str, forward: Option<&SocketForward>) -> Vec<String> {
    let mut extra = vec!["-O".into(), op.into()];
    if let Some(forward) = forward {
        extra.extend([
            "-R".into(),
            format!("{}:{}", forward.remote_path, forward.local_path),
        ]);
    }
    options(base, &extra)
}

fn master_pid(base: &[String], runner: &mut Runner<'_>) -> Result<Option<u32>, String> {
    let output = runner(
        &control(base, "check", None),
        "check qmux SSH transport",
        CONTROL_TIMEOUT,
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    // OpenSSH writes `Master running (pid=123)` to stderr in the C locale.
    let text = String::from_utf8_lossy(&output.stderr);
    let pid = text
        .split("(pid=")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .and_then(|pid| pid.parse().ok());
    pid.map(Some)
        .ok_or_else(|| "SSH master did not report its process identity".into())
}

impl HostPool {
    fn base_for(&self, slot: usize) -> Vec<String> {
        let mut base = self.base.clone();
        if slot > 0 {
            for arg in &mut base {
                if let Some(path) = arg.strip_prefix("ControlPath=") {
                    *arg = format!("ControlPath={path}-{slot}");
                }
            }
        }
        base
    }

    /// Only invalidate a same-master lease when the remote host positively
    /// confirms its socket is absent. A slow ping alone must not tear down a
    /// live forward (or the terminal sharing its master).
    fn repair_missing_forward(
        &mut self,
        commands: &RemoteTmuxCommands,
        runner: &mut Runner<'_>,
    ) -> Result<bool, String> {
        let forward = commands
            .hook_forward
            .as_ref()
            .ok_or("missing hook forward")?;
        if let Some(lease) = self.forwards.get(&forward.remote_path).cloned() {
            if lease.forward != *forward {
                return Err("remote hook socket is already owned by another local endpoint".into());
            }
            let base = self.base_for(lease.slot);
            if lease.master_pid.is_some() && master_pid(&base, runner)? == lease.master_pid {
                let mut probe = base;
                probe.push(format!(
                    "if test -S {}; then exit 0; else exit 3; fi",
                    crate::adapters::shell_quote_arg(&forward.remote_path)
                ));
                let output = runner(&probe, "check remote hook socket", CONNECT_TIMEOUT)?;
                match output.status.code() {
                    Some(0) => return Ok(false),
                    Some(3) => {
                        self.forwards
                            .get_mut(&forward.remote_path)
                            .unwrap()
                            .master_pid = None
                    }
                    _ => return Err("could not check remote hook socket".into()),
                }
            }
        }
        self.prepare(commands, runner).map(|_| true)
    }

    fn prepare(
        &mut self,
        commands: &RemoteTmuxCommands,
        runner: &mut Runner<'_>,
    ) -> Result<Vec<String>, String> {
        let forward = commands
            .hook_forward
            .as_ref()
            .ok_or("missing hook forward")?;
        if let Some(lease) = self.forwards.get(&forward.remote_path) {
            if lease.forward != *forward {
                return Err("remote hook socket is already owned by another local endpoint".into());
            }
        } else {
            let slot = (1..self.slots)
                .find(|slot| {
                    self.forwards
                        .values()
                        .filter(|lease| lease.slot == *slot)
                        .count()
                        < PANES_PER_MASTER
                })
                .unwrap_or_else(|| {
                    self.slots += 1;
                    self.slots - 1
                });
            self.forwards.insert(
                forward.remote_path.clone(),
                ForwardLease {
                    forward: forward.clone(),
                    slot,
                    master_pid: None,
                },
            );
        }
        let lease = self.forwards[&forward.remote_path].clone();
        let base = self.base_for(lease.slot);
        let pid = match master_pid(&base, runner)? {
            Some(pid) => pid,
            None => {
                // The short command starts ControlPersist without a -fN daemon
                // retaining the helper's output pipes. Subsequent panes reuse it.
                let mut start = base.clone();
                start.push("true".into());
                require_success(
                    runner(&start, "connect qmux SSH transport", CONNECT_TIMEOUT)?,
                    "connect qmux SSH transport",
                )?;
                master_pid(&base, runner)?.ok_or("SSH multiplexing is unavailable")?
            }
        };
        if lease.master_pid != Some(pid) {
            self.forwards
                .get_mut(&forward.remote_path)
                .unwrap()
                .master_pid = None;
            // Cancel before unlink, including an uncertain previous registration.
            // A missing registration returns nonzero; a helper timeout is an error.
            let _ = runner(
                &control(&base, "cancel", Some(forward)),
                "cancel stale hook forward",
                CONTROL_TIMEOUT,
            )?;
            let mut cleanup = base.clone();
            cleanup.push(
                commands
                    .forward_cleanup_argv
                    .last()
                    .ok_or("missing hook socket cleanup")?
                    .clone(),
            );
            require_success(
                runner(&cleanup, "remove stale remote hook socket", CONNECT_TIMEOUT)?,
                "remove stale remote hook socket",
            )?;
            require_success(
                runner(
                    &control(&base, "forward", Some(forward)),
                    "register remote hook forward",
                    CONNECT_TIMEOUT,
                )?,
                "register remote hook forward",
            )?;
            if master_pid(&base, runner)? != Some(pid) {
                return Err("SSH transport changed while registering remote hooks".into());
            }
            self.forwards
                .get_mut(&forward.remote_path)
                .unwrap()
                .master_pid = Some(pid);
        }
        let path = base
            .iter()
            .find(|arg| arg.starts_with("ControlPath="))
            .unwrap();
        let mut attach = commands.attach_argv.clone();
        for arg in &mut attach {
            if arg.starts_with("ControlPath=") {
                *arg = path.clone();
            }
            if arg.starts_with("ControlMaster=") {
                *arg = "ControlMaster=no".into();
            }
        }
        // Fail closed if the master disappears between registration and attach.
        // A fresh fallback connection would have a terminal but no hook forward.
        Ok(options(
            &attach,
            &["-o".into(), "ProxyCommand=false".into()],
        ))
    }

    fn retire_unhealthy(&self, slot: usize, runner: &mut Runner<'_>) {
        // A slow tmux/helper operation must not tear down every healthy terminal.
        // Probe the actual transport independently before retiring this app's master.
        for slot in if slot == 0 { vec![0] } else { vec![0, slot] } {
            let base = self.base_for(slot);
            let mut probe = options(&base, &["-o".into(), "ProxyCommand=false".into()]);
            probe.push("true".into());
            if runner(&probe, "check shared SSH transport health", CONTROL_TIMEOUT)
                .is_err_and(|error| error.contains("timed out"))
            {
                let _ = runner(
                    &control(&base, "exit", None),
                    "retire stale qmux SSH transport",
                    CONTROL_TIMEOUT,
                );
            }
        }
    }

    fn release(&mut self, path: &str, runner: &mut Runner<'_>) -> Result<(), String> {
        let Some(lease) = self.forwards.get(path).cloned() else {
            return Ok(());
        };
        let base = self.base_for(lease.slot);
        if master_pid(&base, runner)?.is_some() {
            // Cancel is idempotent when the master has been replaced or an
            // earlier failed attempt registered the forward without acknowledgement.
            let _ = runner(
                &control(&base, "cancel", Some(&lease.forward)),
                "release remote hook forward",
                CONTROL_TIMEOUT,
            )?;
        }
        self.forwards.remove(path);
        // sshd may leave the Unix pathname behind. Next registration removes it
        // only after cancellation; closing a pane never starts a new SSH session.
        Ok(())
    }
}

pub(crate) fn prepare_attachment(
    commands: &RemoteTmuxCommands,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<String>, String> {
    let Some(pool) = pool(commands)? else {
        return Ok(commands.attach_argv.clone());
    };
    let mut host = lock_pool(&pool, &cancelled)?;
    host.prepare(commands, &mut |argv, action, timeout| {
        run(argv, action, timeout, &cancelled)
    })
}

pub(crate) fn repair_missing_forward(
    commands: &RemoteTmuxCommands,
    cancelled: impl Fn() -> bool,
) -> Result<bool, String> {
    let Some(pool) = pool(commands)? else {
        return Ok(false);
    };
    let mut host = lock_pool(&pool, &cancelled)?;
    host.repair_missing_forward(commands, &mut |argv, action, timeout| {
        run(argv, action, timeout, &cancelled)
    })
}

pub(crate) fn release_forward(commands: &RemoteTmuxCommands) {
    let Some(base) = ssh_base(commands) else {
        return;
    };
    let pool = HOSTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .hosts
        .get(&base)
        .cloned();
    if let Some(pool) = pool {
        let mut host = pool.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(err) = host.release(
            &commands.remote_socket_path,
            &mut |argv, action, timeout| run(argv, action, timeout, || false),
        ) {
            eprintln!("qmux: {err}");
        }
    }
}

pub(crate) fn retire_unhealthy(commands: &RemoteTmuxCommands) {
    let Ok(Some(pool)) = pool(commands) else {
        return;
    };
    let host = pool.lock().unwrap_or_else(|e| e.into_inner());
    let slot = host
        .forwards
        .get(&commands.remote_socket_path)
        .map(|lease| lease.slot)
        .unwrap_or(0);
    host.retire_unhealthy(slot, &mut |argv, action, timeout| {
        run(argv, action, timeout, || false)
    });
}

pub(crate) fn shutdown() {
    let hosts: Vec<_> = {
        let mut registry = HOSTS.lock().unwrap_or_else(|e| e.into_inner());
        registry.stopped = true;
        registry.hosts.values().cloned().collect()
    };
    std::thread::scope(|scope| {
        for pool in hosts {
            scope.spawn(move || {
                let host = pool.lock().unwrap_or_else(|e| e.into_inner());
                for slot in 0..host.slots {
                    let _ = run(
                        &control(&host.base_for(slot), "exit", None),
                        "stop qmux SSH transport",
                        CONTROL_TIMEOUT,
                        || false,
                    );
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::RemoteSessionIdentity;
    use crate::workspace::{RemoteMultiplexer, RemoteRef};
    use std::collections::HashSet;
    use std::os::unix::process::ExitStatusExt;

    fn commands(pane: &str) -> RemoteTmuxCommands {
        commands_for(pane, "test@example.invalid")
    }

    fn commands_for(pane: &str, destination: &str) -> RemoteTmuxCommands {
        let remote = RemoteRef {
            id: "transport-test".into(),
            label: "Transport test".into(),
            host: destination.into(),
            qmux_cli: None,
            workspace_root: Some("/tmp".into()),
            multiplexer: RemoteMultiplexer::Tmux,
        };
        crate::host::for_group(Some(&remote))
            .existing_tmux_session_commands(
                &RemoteSessionIdentity::new(&remote.id, pane).unwrap(),
                "/local/qmux.sock",
            )
            .unwrap()
    }

    fn host(commands: &RemoteTmuxCommands) -> HostPool {
        HostPool {
            base: ssh_base(commands).unwrap(),
            forwards: HashMap::new(),
            slots: 2,
        }
    }

    fn output(success: bool, stderr: &str) -> Output {
        Output {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 256 }),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[derive(Default)]
    struct Ssh {
        masters: HashMap<String, u32>,
        registrations: HashMap<(String, String), String>,
        sockets: HashSet<String>,
        next_pid: u32,
        calls: Vec<String>,
        lose_forward_reply: bool,
        refuse_forward: bool,
    }
    impl Ssh {
        fn run(&mut self, argv: &[String], action: &str, _: Duration) -> Result<Output, String> {
            self.calls.push(action.into());
            let path = argv
                .iter()
                .find(|arg| arg.starts_with("ControlPath="))
                .unwrap()
                .clone();
            let op = argv
                .windows(2)
                .find(|pair| pair[0] == "-O")
                .map(|pair| pair[1].as_str());
            let forward = argv.windows(2).find(|pair| pair[0] == "-R").map(|pair| {
                let (remote, local) = pair[1].split_once(':').unwrap();
                (remote.to_string(), local.to_string())
            });
            match op {
                Some("check") => Ok(match self.masters.get(&path) {
                    Some(pid) => output(true, &format!("Master running (pid={pid})\n")),
                    None => output(false, "No such file"),
                }),
                Some("cancel") => {
                    let (remote, _) = forward.unwrap();
                    // Cancellation can leave a pathname on the remote host.
                    Ok(output(
                        self.registrations.remove(&(path, remote)).is_some(),
                        "",
                    ))
                }
                Some("forward") => {
                    let (remote, local) = forward.unwrap();
                    if self.refuse_forward {
                        return Ok(output(false, "forward refused"));
                    }
                    // OpenSSH accepts duplicate registrations without rebinding.
                    if self
                        .registrations
                        .contains_key(&(path.clone(), remote.clone()))
                    {
                        return Ok(output(true, ""));
                    }
                    if !self.sockets.insert(remote.clone()) {
                        return Ok(output(false, "socket in use"));
                    }
                    self.registrations.insert((path, remote), local);
                    if std::mem::take(&mut self.lose_forward_reply) {
                        return Err("register remote hook forward timed out".into());
                    }
                    Ok(output(true, ""))
                }
                None if argv.last().unwrap() == "true" => {
                    self.next_pid += 1;
                    self.masters.insert(path, self.next_pid);
                    Ok(output(true, ""))
                }
                None if action == "check remote hook socket" => {
                    let remote = argv.last().unwrap().split('\'').nth(1).unwrap();
                    let mut result = output(true, "");
                    if !self.sockets.contains(remote) {
                        result.status = std::process::ExitStatus::from_raw(3 << 8);
                    }
                    Ok(result)
                }
                None => {
                    // Cleanup commands quote the exact managed socket as the last token.
                    let remote = argv.last().unwrap().split('\'').rev().nth(1).unwrap();
                    self.sockets.remove(remote);
                    Ok(output(true, ""))
                }
                _ => panic!("unexpected SSH operation: {argv:?}"),
            }
        }
    }

    fn prepare(
        host: &mut HostPool,
        commands: &RemoteTmuxCommands,
        ssh: &mut Ssh,
    ) -> Result<Vec<String>, String> {
        host.prepare(commands, &mut |argv, action, timeout| {
            ssh.run(argv, action, timeout)
        })
    }

    #[test]
    fn repair_preserves_live_forward_and_rebuilds_only_missing_socket() {
        let commands = commands("repair");
        let mut host = host(&commands);
        let mut ssh = Ssh::default();
        prepare(&mut host, &commands, &mut ssh).unwrap();
        ssh.calls.clear();
        host.repair_missing_forward(&commands, &mut |a, b, c| ssh.run(a, b, c))
            .unwrap();
        assert!(
            !ssh.calls
                .iter()
                .any(|call| call == "cancel stale hook forward")
        );
        let masters = ssh.masters.clone();
        ssh.sockets
            .remove(&commands.hook_forward.as_ref().unwrap().remote_path);
        ssh.calls.clear();
        host.repair_missing_forward(&commands, &mut |a, b, c| ssh.run(a, b, c))
            .unwrap();
        assert!(
            ssh.calls
                .iter()
                .any(|call| call == "register remote hook forward")
        );
        assert_eq!(ssh.masters, masters);
        assert!(
            ssh.sockets
                .contains(&commands.hook_forward.as_ref().unwrap().remote_path)
        );
    }

    #[test]
    fn second_pane_and_reattachment_reuse_transport_and_preserve_hook_sockets() {
        let a = commands("a");
        let b = commands("b");
        let mut host = host(&a);
        let mut ssh = Ssh::default();
        let first = prepare(&mut host, &a, &mut ssh).unwrap();
        prepare(&mut host, &b, &mut ssh).unwrap();
        assert_eq!(ssh.masters.len(), 1);
        assert_eq!(ssh.next_pid, 1, "a second pane must not authenticate again");
        ssh.calls.clear();
        assert_eq!(prepare(&mut host, &a, &mut ssh).unwrap(), first);
        assert_eq!(ssh.calls, ["check qmux SSH transport"]);
        assert!(ssh.sockets.contains(&a.remote_socket_path));
        assert!(ssh.sockets.contains(&b.remote_socket_path));
        assert!(!first.iter().any(|arg| arg == "-R"));
        assert!(first.iter().any(|arg| arg == "ProxyCommand=false"));
        assert!(first.iter().any(|arg| arg == "ControlMaster=no"));
    }

    #[test]
    fn replacement_master_rebinds_both_existing_panes() {
        let a = commands("a");
        let b = commands("b");
        let mut host = host(&a);
        let mut ssh = Ssh::default();
        prepare(&mut host, &a, &mut ssh).unwrap();
        prepare(&mut host, &b, &mut ssh).unwrap();
        ssh.masters.clear();
        ssh.registrations.clear(); // Stale Unix paths survive.
        prepare(&mut host, &a, &mut ssh).unwrap();
        prepare(&mut host, &b, &mut ssh).unwrap();
        assert_eq!(ssh.next_pid, 2);
        assert_eq!(ssh.registrations.len(), 2);
        assert!(
            host.forwards
                .values()
                .all(|lease| lease.master_pid == Some(2))
        );
    }

    #[test]
    fn lost_registration_reply_is_cancelled_before_socket_is_unlinked() {
        let a = commands("a");
        let mut host = host(&a);
        let mut ssh = Ssh {
            lose_forward_reply: true,
            ..Default::default()
        };
        assert!(prepare(&mut host, &a, &mut ssh).is_err());
        assert_eq!(ssh.registrations.len(), 1);
        ssh.calls.clear();
        prepare(&mut host, &a, &mut ssh).unwrap();
        assert_eq!(
            &ssh.calls[..4],
            [
                "check qmux SSH transport",
                "cancel stale hook forward",
                "remove stale remote hook socket",
                "register remote hook forward"
            ]
        );
        assert!(
            ssh.sockets.contains(&a.remote_socket_path),
            "duplicate -R must not leave an unbound pathname"
        );
    }

    #[test]
    fn refused_forward_never_returns_an_attachment_and_can_retry() {
        let a = commands("a");
        let mut host = host(&a);
        let mut ssh = Ssh {
            refuse_forward: true,
            ..Default::default()
        };
        assert!(
            prepare(&mut host, &a, &mut ssh)
                .unwrap_err()
                .contains("forward refused")
        );
        assert_eq!(host.forwards[&a.remote_socket_path].master_pid, None);
        ssh.refuse_forward = false;
        prepare(&mut host, &a, &mut ssh).unwrap();
    }

    #[test]
    fn closing_one_pane_preserves_other_panes_and_does_not_connect_when_offline() {
        let a = commands("a");
        let b = commands("b");
        let mut host = host(&a);
        let mut ssh = Ssh::default();
        prepare(&mut host, &a, &mut ssh).unwrap();
        prepare(&mut host, &b, &mut ssh).unwrap();
        host.release(&a.remote_socket_path, &mut |a, b, c| ssh.run(a, b, c))
            .unwrap();
        assert_eq!(ssh.registrations.len(), 1);
        ssh.calls.clear();
        prepare(&mut host, &b, &mut ssh).unwrap();
        assert_eq!(ssh.calls, ["check qmux SSH transport"]);
        ssh.masters.clear();
        ssh.calls.clear();
        host.release(&b.remote_socket_path, &mut |a, b, c| ssh.run(a, b, c))
            .unwrap();
        assert_eq!(ssh.calls, ["check qmux SSH transport"]);
        assert!(host.forwards.is_empty());
    }

    #[test]
    fn pool_leaves_capacity_for_helpers_and_reuses_released_slots() {
        let panes: Vec<_> = (0..PANES_PER_MASTER + 1)
            .map(|i| commands(&i.to_string()))
            .collect();
        let mut host = host(&panes[0]);
        let mut ssh = Ssh::default();
        for pane in &panes {
            prepare(&mut host, pane, &mut ssh).unwrap();
        }
        assert_eq!(ssh.masters.len(), 2);
        assert_eq!(
            host.forwards[&panes[PANES_PER_MASTER].remote_socket_path].slot,
            2
        );
        host.release(&panes[0].remote_socket_path, &mut |a, b, c| {
            ssh.run(a, b, c)
        })
        .unwrap();
        let extra = commands("replacement");
        prepare(&mut host, &extra, &mut ssh).unwrap();
        assert_eq!(host.forwards[&extra.remote_socket_path].slot, 1);
        assert_eq!(ssh.next_pid, 2);
    }

    #[test]
    fn socket_ownership_cannot_be_reassigned_to_another_local_endpoint() {
        let a = commands("a");
        let mut host = host(&a);
        let mut ssh = Ssh::default();
        prepare(&mut host, &a, &mut ssh).unwrap();
        let mut forged = a.clone();
        forged.hook_forward.as_mut().unwrap().local_path = "/other.sock".into();
        assert!(
            prepare(&mut host, &forged, &mut ssh)
                .unwrap_err()
                .contains("already owned")
        );
    }

    #[test]
    fn control_paths_are_private_to_this_run_and_destination_and_do_not_expand_proxy_options() {
        assert_eq!(control_path("a"), control_path("a"));
        assert_ne!(control_path("a"), control_path("b"));
        assert!(!control_path("user@host").contains('%'));
        let mut commands = commands("a");
        for arg in &mut commands.probe_argv {
            if arg.starts_with("ControlPath=") {
                *arg = "ControlPath=~/.ssh/user-master".into();
            }
        }
        assert!(
            ssh_base(&commands).is_none(),
            "never manage a user-owned master"
        );
    }

    #[test]
    fn queued_transport_work_observes_cancellation_without_waiting_for_the_host() {
        let mutex = Mutex::new(host(&commands("a")));
        let _guard = mutex.lock().unwrap();
        assert!(
            matches!(lock_pool(&mutex, &|| true), Err(error) if error == "recovery superseded")
        );
    }

    #[test]
    fn only_an_unresponsive_transport_is_retired_not_a_slow_helper_or_full_server() {
        let commands = commands("a");
        let host = host(&commands);
        for probe in [
            Ok(output(true, "")),
            Ok(output(false, "Session open refused by peer")),
            Err("failed to check shared SSH transport health: timed out".to_string()),
        ] {
            let should_retire = probe.is_err();
            let mut probe = Some(probe);
            let mut retired = false;
            host.retire_unhealthy(0, &mut |argv, _, _| {
                if argv.last().unwrap() == "true" {
                    probe.take().unwrap()
                } else {
                    assert!(argv.windows(2).any(|pair| pair == ["-O", "exit"]));
                    retired = true;
                    Ok(output(true, ""))
                }
            });
            assert_eq!(retired, should_retire);
        }
    }

    #[test]
    fn closing_after_a_lost_forward_reply_cancels_the_uncertain_registration() {
        let a = commands("a");
        let mut host = host(&a);
        let mut ssh = Ssh {
            lose_forward_reply: true,
            ..Default::default()
        };
        assert!(prepare(&mut host, &a, &mut ssh).is_err());
        host.release(&a.remote_socket_path, &mut |a, b, c| ssh.run(a, b, c))
            .unwrap();
        assert!(ssh.registrations.is_empty());
        assert!(host.forwards.is_empty());
    }

    #[test]
    #[ignore = "requires QMUX_TEST_SSH_TARGET, python3 on that host, and Unix-socket forwarding"]
    fn shared_ssh_forward_round_trip() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        use std::sync::atomic::{AtomicBool, Ordering};
        let target = std::env::var("QMUX_TEST_SSH_TARGET").expect("QMUX_TEST_SSH_TARGET");
        let mut a = commands_for("forward-a", &target);
        let mut b = commands_for("forward-b", &target);
        let dir = std::env::temp_dir()
            .join(&a.remote_socket_path[5..])
            .with_extension("test");
        std::fs::create_dir(&dir).unwrap();
        let local = dir.join("hooks.sock");
        let listener = UnixListener::bind(&local).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let server_stopped = stopped.clone();
        let server = std::thread::spawn(move || {
            while !server_stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut bytes = [0; 4];
                        stream.read_exact(&mut bytes).unwrap();
                        assert_eq!(&bytes, b"ping");
                        stream.write_all(b"pong").unwrap();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("hook listener: {e}"),
                }
            }
        });
        a.hook_forward.as_mut().unwrap().local_path = local.display().to_string();
        b.hook_forward.as_mut().unwrap().local_path = local.display().to_string();
        let mut host = host(&a);
        let mut runner =
            |argv: &[String], action: &str, timeout| run(argv, action, timeout, || false);
        // Always retire the test's masters and sockets, including on assertion failure.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let ping = |commands: &RemoteTmuxCommands| {
                let script = format!(
                    "import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect({:?}); s.sendall(b'ping'); assert s.recv(4)==b'pong'",
                    commands.remote_socket_path
                );
                let mut argv = ssh_base(commands).unwrap();
                argv.push(format!(
                    "python3 -c {}",
                    crate::adapters::shell_quote_arg(&script)
                ));
                require_success(
                    run(&argv, "round trip hook socket", CONNECT_TIMEOUT, || false).unwrap(),
                    "round trip hook socket",
                )
                .unwrap();
            };
            host.prepare(&a, &mut runner).unwrap();
            let terminal_base = host.base_for(host.forwards[&a.remote_socket_path].slot);
            assert_ne!(
                terminal_base, host.base,
                "terminal channels must not consume transcript capacity"
            );
            let initial_pid = host.forwards[&a.remote_socket_path].master_pid.unwrap();
            host.prepare(&b, &mut runner).unwrap();
            assert_eq!(
                host.forwards[&b.remote_socket_path].master_pid,
                Some(initial_pid)
            );
            ping(&a);
            ping(&b);
            let mut stale_attachment = host.prepare(&a, &mut runner).unwrap(); // A TTY-only reconnect preserves its forward.
            ping(&a);
            ping(&b);
            require_success(
                runner(
                    &control(&terminal_base, "exit", None),
                    "test disconnect",
                    CONTROL_TIMEOUT,
                )
                .unwrap(),
                "test disconnect",
            )
            .unwrap();
            // Wait for exit acknowledgement to become a closed control socket.
            let deadline = std::time::Instant::now() + CONTROL_TIMEOUT;
            while master_pid(&terminal_base, &mut runner).unwrap().is_some() {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            *stale_attachment.last_mut().unwrap() = "printf unexpected-fallback".into();
            let stale =
                runner(&stale_attachment, "test stale attachment", CONTROL_TIMEOUT).unwrap();
            assert!(!stale.status.success());
            assert!(!String::from_utf8_lossy(&stale.stdout).contains("unexpected-fallback"));
            host.prepare(&a, &mut runner).unwrap();
            host.prepare(&b, &mut runner).unwrap();
            assert_ne!(
                host.forwards[&a.remote_socket_path].master_pid,
                Some(initial_pid)
            );
            ping(&a);
            ping(&b);
            host.release(&a.remote_socket_path, &mut runner).unwrap();
            ping(&b);
            host.release(&b.remote_socket_path, &mut runner).unwrap();
        }));
        for slot in 0..host.slots {
            let _ = runner(
                &control(&host.base_for(slot), "exit", None),
                "test cleanup",
                CONTROL_TIMEOUT,
            );
        }
        // The sockets are unique nonce-named test artifacts on the remote host.
        for commands in [&a, &b] {
            let _ = runner(
                &commands.forward_cleanup_argv,
                "remove test socket",
                CONNECT_TIMEOUT,
            );
        }
        let _ = runner(
            &control(&host.base, "exit", None),
            "test cleanup",
            CONTROL_TIMEOUT,
        );
        stopped.store(true, Ordering::SeqCst);
        server.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
