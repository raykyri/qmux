//! Deadline-bound execution for non-interactive remote helpers.
//!
//! Pipes stay nonblocking and are drained by the deadline-owning thread. A
//! descendant retaining a pipe must not turn timeout cleanup into an unbounded
//! thread join. Each helper gets its own process group so cancellation also
//! terminates SSH proxy commands and shell children.
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const BATCH_TIMEOUT: Duration = Duration::from_secs(55);

pub(crate) fn output(
    command: Command,
    input: Option<Vec<u8>>,
    action: &str,
) -> Result<Output, String> {
    output_with_timeout(command, input, action, BATCH_TIMEOUT, || false)
}

struct ProcessGroup(Option<Child>);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            // process_group(0) makes the child's PID its process-group ID.
            unsafe {
                libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
            }
            // Reaping must not hold up the caller's deadline (e.g. a child in
            // uninterruptible kernel I/O). No pipe reader/writer threads exist.
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

fn nonblocking(pipe: &impl AsRawFd) -> io::Result<()> {
    let fd = pipe.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// Limit work per iteration even if a child writes continuously, so cancellation
// and the deadline are checked between bounded batches of I/O.
fn drain(pipe: &mut Option<impl Read>, bytes: &mut Vec<u8>) -> io::Result<()> {
    let Some(reader) = pipe.as_mut() else {
        return Ok(());
    };
    let mut buffer = [0; 8192];
    for _ in 0..16 {
        match reader.read(&mut buffer) {
            Ok(0) => {
                *pipe = None;
                break;
            }
            Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

pub(crate) fn output_with_timeout(
    mut command: Command,
    input: Option<Vec<u8>>,
    action: &str,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Output, String> {
    if cancelled() {
        return Err("recovery superseded".into());
    }
    let deadline = Instant::now() + timeout;
    command
        .process_group(0)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|err| format!("failed to {action}: {err}"))?;
    let mut group = ProcessGroup(Some(child));
    let child = group.0.as_mut().unwrap();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut stdin = child.stdin.take();
    let io_error = |err| format!("failed to {action}: {err}");
    nonblocking(stdout.as_ref().unwrap()).map_err(io_error)?;
    nonblocking(stderr.as_ref().unwrap()).map_err(io_error)?;
    if let Some(pipe) = &stdin {
        nonblocking(pipe).map_err(io_error)?;
    }
    let input = input.unwrap_or_default();
    let mut written = 0;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut status = None;
    loop {
        if cancelled() {
            return Err("recovery superseded".into());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "failed to {action}: timed out after {} seconds",
                timeout.as_secs_f64()
            ));
        }
        drain(&mut stdout, &mut out).map_err(io_error)?;
        drain(&mut stderr, &mut err).map_err(io_error)?;
        if written == input.len() {
            stdin = None;
        }
        if let Some(pipe) = &mut stdin {
            let end = (written + 65536).min(input.len());
            match pipe.write(&input[written..end]) {
                Ok(0) => return Err(format!("failed to {action}: remote command input closed")),
                Ok(count) => written += count,
                Err(err)
                    if matches!(
                        err.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(err) => return Err(io_error(err)),
            }
        }
        if status.is_none() {
            status = child.try_wait().map_err(io_error)?;
        }
        if let Some(status) = status {
            if stdout.is_none() && stderr.is_none() && stdin.is_none() {
                // try_wait already reaped the child; successful helpers may
                // intentionally launch a detached process with closed pipes.
                group.0.take();
                return Ok(Output {
                    status,
                    stdout: out,
                    stderr: err,
                });
            }
        }
        thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn deadline_includes_descendant_pipes_and_blocked_input() {
        for script in [
            "sleep 5",
            "sleep 5 & wait",
            "sleep 5 & exit 0",
            "sleep 5 & exec sleep 5",
        ] {
            let started = Instant::now();
            let result = output_with_timeout(
                shell(script),
                None,
                "test stall",
                Duration::from_millis(50),
                || false,
            );
            assert!(result.unwrap_err().contains("timed out"), "{script}");
            assert!(started.elapsed() < Duration::from_secs(1), "{script}");
        }
    }

    #[test]
    fn deadline_includes_blocked_input() {
        let started = Instant::now();
        let result = output_with_timeout(
            shell("sleep 5"),
            Some(vec![0; 1024 * 1024]),
            "test blocked upload",
            Duration::from_millis(50),
            || false,
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn drains_both_pipes_while_uploading() {
        let input = vec![b'x'; 1024 * 1024];
        let result = output(
            shell("cat; printf error >&2"),
            Some(input.clone()),
            "test upload",
        )
        .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, input);
        assert_eq!(result.stderr, b"error");
    }

    #[test]
    fn cancellation_covers_descendant_pipe_drain() {
        let started = Instant::now();
        let result = output_with_timeout(
            shell("sleep 5 & exit 0"),
            None,
            "test cancellation",
            Duration::from_secs(10),
            || started.elapsed() >= Duration::from_millis(50),
        );
        assert_eq!(result.unwrap_err(), "recovery superseded");
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
