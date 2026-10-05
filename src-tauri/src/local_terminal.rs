//! Persistent local terminals, isolated from the user's tmux server/configuration.
//! The server owns emulation and PTYs; GUI clients may attach and disappear.
//! Drop never means kill: explicit pane/server shutdown owns process termination.
use crate::adapters::shell_quote_arg;
use crate::remote_process::output_with_timeout;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub struct TerminalServer {
    root: PathBuf,
    binary: PathBuf,
    input_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

#[derive(Clone)]
pub struct Terminal {
    server: TerminalServer,
    name: String,
    // A paste and its submit key must never interleave with another submission.
    input: Arc<Mutex<()>>,
    instance: Arc<()>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TerminalStatus {
    pub dead: bool,
    pub exit_code: Option<i32>,
    pub pid: u32,
}

impl TerminalServer {
    pub fn open(root: &Path) -> Result<Self, String> {
        let binary = crate::adapters::ensure_on_path("tmux")
            .ok_or("the background runtime requires tmux 3.3 or newer")?;
        Self::with_binary(root, binary)
    }

    fn with_binary(root: &Path, binary: PathBuf) -> Result<Self, String> {
        // create_dir refuses a pre-existing symlink. Existing directories must be
        // private and owned by this account; never chmod someone else's path.
        match fs::DirBuilder::new().mode(0o700).create(root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        let meta = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err("runtime terminal directory must be an owner-only directory".into());
        }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        if root.join("tmux.sock").as_os_str().len() >= 100 {
            return Err("runtime terminal socket path is too long".into());
        }
        let server = Self {
            root,
            binary,
            input_locks: Arc::new(Mutex::new(HashMap::new())),
        };
        let output = server.run(["-V"], None)?;
        crate::pty::validate_remote_tmux_version(&String::from_utf8_lossy(&output.stdout))?;
        Ok(server)
    }

    pub fn socket(&self) -> PathBuf {
        self.root.join("tmux.sock")
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .arg("-S")
            .arg(self.socket())
            .args(["-f", "/dev/null"]);
        // The server persists its launch environment. Never let the first pane's
        // credentials become defaults inherited by all subsequently spawned panes.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("QMUX_") || key == "TMUX" || key == "TMUX_PANE" {
                command.env_remove(key);
            }
        }
        command
    }

    fn run<I, S>(&self, args: I, input: Option<&[u8]>) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = self.command();
        command.args(args);
        let output = output_with_timeout(
            command,
            input.map(<[u8]>::to_vec),
            "local terminal operation",
            Duration::from_secs(10),
            || false,
        )?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(format!(
                "local terminal operation failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    fn name(id: &str) -> Result<String, String> {
        if id.is_empty()
            || id.len() > 160
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("invalid runtime pane identity".into());
        }
        Ok(format!("q-{id}"))
    }

    pub fn terminal(&self, id: &str) -> Result<Terminal, String> {
        let name = Self::name(id)?;
        let input = self
            .input_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(name.clone())
            .or_default()
            .clone();
        Ok(Terminal {
            server: self.clone(),
            name,
            input,
            instance: Arc::new(()),
        })
    }

    pub fn spawn(
        &self,
        id: &str,
        program: &str,
        args: &[String],
        cwd: &Path,
        envs: &[(String, String)],
        cols: u16,
        rows: u16,
    ) -> Result<Terminal, String> {
        validate_size(cols, rows)?;
        if program.is_empty() || program.contains('\0') || args.iter().any(|arg| arg.contains('\0'))
        {
            return Err("invalid terminal command".into());
        }
        let terminal = self.terminal(id)?;
        if self
            .run(["has-session", "-t", &terminal.name], None)
            .is_ok()
        {
            return Err("runtime terminal already exists; attach instead of spawning again".into());
        }
        // Credentials stay in an owner-only script, never in tmux's argv or its
        // shared environment. The script is removed only when the session is closed.
        let path = self.root.join(format!("{}.sh", terminal.name));
        let mut script = String::from("#!/bin/sh\n");
        for (key, value) in envs {
            if key.is_empty()
                || !key.bytes().enumerate().all(|(i, b)| {
                    b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit())
                })
                || value.contains('\0')
            {
                return Err("invalid terminal environment".into());
            }
            script.push_str(&format!("export {key}={}\n", shell_quote_arg(value)));
        }
        script.push_str("exec ");
        script.push_str(&shell_quote_arg(program));
        for arg in args {
            script.push(' ');
            script.push_str(&shell_quote_arg(arg));
        }
        script.push('\n');
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|e| e.to_string())?;
        if let Err(error) = file
            .write_all(script.as_bytes())
            .and_then(|()| file.sync_all())
        {
            let _ = fs::remove_file(&path);
            return Err(error.to_string());
        }
        let command = format!("/bin/sh {}", shell_quote_arg(&path.to_string_lossy()));
        // Configure before the process runs: new-session starts a waiting shell,
        // then respawn-pane runs the real command after remain-on-exit is enabled.
        let start = self.run(
            [
                "new-session",
                "-d",
                "-s",
                &terminal.name,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
                "-c",
                &cwd.to_string_lossy(),
                "sleep 86400",
            ],
            None,
        );
        if let Err(error) = start {
            let _ = fs::remove_file(path);
            return Err(error);
        }
        let configured = (|| {
            self.run(["set-option", "-t", &terminal.name, "status", "off"], None)?;
            self.run(["set-option", "-t", &terminal.name, "prefix", "None"], None)?;
            self.run(
                ["set-option", "-t", &terminal.name, "update-environment", ""],
                None,
            )?;
            self.run(
                [
                    "set-window-option",
                    "-t",
                    &terminal.name,
                    "remain-on-exit",
                    "on",
                ],
                None,
            )?;
            self.run(
                [
                    "set-window-option",
                    "-t",
                    &terminal.name,
                    "window-size",
                    "manual",
                ],
                None,
            )?;
            self.run(
                [
                    "set-window-option",
                    "-t",
                    &terminal.name,
                    "history-limit",
                    "10000",
                ],
                None,
            )?;
            self.run(
                [
                    "respawn-pane",
                    "-k",
                    "-t",
                    &terminal.target(),
                    "-c",
                    &cwd.to_string_lossy(),
                    &command,
                ],
                None,
            )?;
            Ok::<_, String>(())
        })();
        if let Err(error) = configured {
            let _ = terminal.close();
            return Err(error);
        }
        Ok(terminal)
    }

    pub fn shutdown(&self) -> Result<(), String> {
        self.run(["kill-server"], None).map(|_| ())
    }
}

fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 500 || rows > 200 {
        Err("invalid terminal size".into())
    } else {
        Ok(())
    }
}

impl Terminal {
    pub(crate) fn same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.instance, &other.instance)
    }
    fn target(&self) -> String {
        format!("{}:0.0", self.name)
    }
    pub fn attachment(&self) -> (PathBuf, Vec<String>) {
        (
            self.server.binary.clone(),
            vec![
                "-S".into(),
                self.server.socket().to_string_lossy().into(),
                "-f".into(),
                "/dev/null".into(),
                "attach-session".into(),
                "-t".into(),
                self.name.clone(),
            ],
        )
    }
    pub fn capture(&self, history: bool) -> Result<String, String> {
        let start = if history { "-10000" } else { "0" };
        let out = self.server.run(
            ["capture-pane", "-p", "-t", &self.target(), "-S", start],
            None,
        )?;
        Ok(String::from_utf8_lossy(&out.stdout).into())
    }
    pub fn status(&self) -> Result<TerminalStatus, String> {
        let out = self.server.run(
            [
                "display-message",
                "-p",
                "-t",
                &self.target(),
                "#{pane_dead} #{pane_dead_status} #{pane_pid}",
            ],
            None,
        )?;
        let raw = String::from_utf8_lossy(&out.stdout);
        let fields: Vec<_> = raw.trim().split(' ').collect();
        if fields.len() != 3 {
            return Err("invalid terminal status response".into());
        }
        Ok(TerminalStatus {
            dead: fields[0] == "1",
            exit_code: fields[1].parse().ok(),
            pid: fields[2].parse().map_err(|_| "invalid terminal pid")?,
        })
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;
        self.server
            .run(
                [
                    "resize-window",
                    "-t",
                    &self.name,
                    "-x",
                    &cols.to_string(),
                    "-y",
                    &rows.to_string(),
                ],
                None,
            )
            .map(|_| ())
    }
    pub fn send(
        &self,
        text: &str,
        paste: bool,
        submit: bool,
    ) -> Result<(), crate::pty::PaneWriteFailure> {
        let _guard = self.input.lock().unwrap_or_else(|e| e.into_inner());
        self.send_locked(text, paste)?;
        if submit {
            std::thread::sleep(Duration::from_millis(15));
            self.server
                .run(["send-keys", "-t", &self.target(), "Enter"], None)
                .map_err(crate::pty::PaneWriteFailure::after_data)?;
        }
        Ok(())
    }
    fn send_locked(&self, text: &str, paste: bool) -> Result<(), crate::pty::PaneWriteFailure> {
        use crate::pty::PaneWriteFailure;
        if text.is_empty() {
            return Ok(());
        }
        if text.len() > 4 * 1024 * 1024 {
            return Err(PaneWriteFailure::before_data(
                "terminal input is too large".into(),
            ));
        }
        if paste {
            let name = format!("{}-input", self.name);
            let data = crate::pty::strip_bracketed_paste_markers(text);
            self.server
                .run(["load-buffer", "-b", &name, "-"], Some(data.as_bytes()))
                .map_err(PaneWriteFailure::before_data)?;
            let result = self.server.run(
                [
                    "paste-buffer",
                    "-p",
                    "-d",
                    "-b",
                    &name,
                    "-t",
                    &self.target(),
                ],
                None,
            );
            if result.is_err() {
                let _ = self.server.run(["delete-buffer", "-b", &name], None);
            }
            result.map_err(PaneWriteFailure::after_data)?;
        } else {
            // Hex input is literal: tmux cannot interpret an argument as a key name.
            for chunk in text.as_bytes().chunks(1024) {
                let mut args = vec![
                    "send-keys".to_string(),
                    "-t".into(),
                    self.target(),
                    "-H".into(),
                ];
                args.extend(chunk.iter().map(|byte| format!("{byte:02x}")));
                self.server
                    .run(args, None)
                    .map_err(PaneWriteFailure::after_data)?;
            }
        }
        Ok(())
    }
    pub fn close(&self) -> Result<(), String> {
        if let Ok(status) = self.status() {
            if !status.dead {
                crate::pty::terminate_descendants(status.pid);
            }
        }
        self.server.run(["kill-session", "-t", &self.name], None)?;
        let _ = fs::remove_file(self.server.root.join(format!("{}.sh", self.name)));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn server() -> TerminalServer {
        let root = std::env::temp_dir().join(format!("qt-{}-{}", std::process::id(), {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        }));
        TerminalServer::open(&root).expect("tmux 3.3+ is required for persistent-terminal tests")
    }
    struct Cleanup(TerminalServer);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.shutdown();
            let _ = fs::remove_dir_all(&self.0.root);
        }
    }
    fn wait_for(t: &Terminal, text: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if t.capture(true).unwrap().contains(text) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "missing output {text:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn attach_and_read(t: &Terminal, expected: &str) {
        use portable_pty::{CommandBuilder, PtySize, native_pty_system};
        use std::io::Read;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let (binary, args) = t.attachment();
        let mut command = CommandBuilder::new(binary);
        command.args(args);
        command.env("TERM", "xterm-256color");
        command.env_remove("TMUX");
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = output.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut chunk = [0; 4096];
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let found = loop {
            if String::from_utf8_lossy(&output.lock().unwrap()).contains(expected) {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        child.kill().unwrap();
        child.wait().unwrap();
        drop(pair.master);
        reader_thread.join().unwrap();
        assert!(found, "attachment did not redraw {expected:?}");
    }

    #[test]
    #[ignore = "requires tmux 3.3+; run persistent terminal tests explicitly"]
    fn emulator_answers_queries_and_redraws_after_client_disconnect() {
        let server = server();
        let _cleanup = Cleanup(server.clone());
        let t = server.spawn("query", "/bin/sh", &["-c".into(),
            "stty raw -echo; printf '\x1b[6n'; answer=$(dd bs=1 count=6 2>/dev/null); printf 'QUERY-ANSWER:%s:END' \"$answer\"; sleep 30".into()],
            Path::new("/tmp"), &[], 80, 24).unwrap();
        wait_for(&t, "QUERY-ANSWER:");
        let pid = t.status().unwrap().pid;
        attach_and_read(&t, "QUERY-ANSWER:");
        assert_eq!(pid, t.status().unwrap().pid);
        attach_and_read(&t, "QUERY-ANSWER:");
        assert_eq!(pid, t.status().unwrap().pid);
        t.close().unwrap();
    }

    #[test]
    #[ignore = "requires tmux 3.3+; run persistent terminal tests explicitly"]
    fn detached_process_retains_identity_modes_and_accepts_followups() {
        let server = server();
        let _cleanup = Cleanup(server.clone());
        let t = server.spawn("pane-one", "/bin/sh", &["-c".into(), "printf '\x1b[?1049h\x1b[?2004hREADY\\n'; while IFS= read -r line; do printf 'GOT:%s\\n' \"$line\"; done".into()], Path::new("/tmp"), &[], 80, 24).unwrap();
        wait_for(&t, "READY");
        let pid = t.status().unwrap().pid;
        drop(t);
        let t = server.terminal("pane-one").unwrap();
        assert_eq!(t.status().unwrap().pid, pid);
        t.send("first", false, true).unwrap();
        wait_for(&t, "GOT:first");
        t.resize(100, 30).unwrap();
        t.send("second", false, true).unwrap();
        wait_for(&t, "GOT:second");
        assert_eq!(t.status().unwrap().pid, pid);
        t.close().unwrap();
        assert!(t.status().is_err());
    }
    #[test]
    #[ignore = "requires tmux 3.3+; run persistent terminal tests explicitly"]
    fn pane_environment_is_private_and_spawn_is_not_replayed() {
        let server = server();
        let _cleanup = Cleanup(server.clone());
        let a = server
            .spawn(
                "a",
                "/bin/sh",
                &[
                    "-c".into(),
                    "printf 'TOKEN:%s\\n' \"$QMUX_TOKEN\"; sleep 30".into(),
                ],
                Path::new("/tmp"),
                &[("QMUX_TOKEN".into(), "secret-one".into())],
                80,
                24,
            )
            .unwrap();
        wait_for(&a, "TOKEN:secret-one");
        assert!(
            server
                .spawn("a", "/bin/sh", &[], Path::new("/tmp"), &[], 80, 24)
                .is_err()
        );
        let b = server
            .spawn(
                "b",
                "/bin/sh",
                &[
                    "-c".into(),
                    "printf 'TOKEN:%s:END\\n' \"$QMUX_TOKEN\"; sleep 30".into(),
                ],
                Path::new("/tmp"),
                &[],
                80,
                24,
            )
            .unwrap();
        wait_for(&b, "TOKEN::END");
        assert!(server.terminal("../escape").is_err());
        assert!(a.resize(0, 24).is_err());
    }
}
