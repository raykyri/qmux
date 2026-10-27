//! Retry only restored Codex bootstraps. The host observes the existing PTY;
//! the child keeps its original terminal descriptors and job-control behavior.
use crate::request_value_with_timeout;
use serde_json::json;
use std::cell::Cell;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

const BACKOFF: [Duration; 2] = [Duration::from_secs(3), Duration::from_secs(5)];
static INTERRUPTED: AtomicI32 = AtomicI32::new(0);

extern "C" fn interrupt(signal: libc::c_int) {
    INTERRUPTED.store(signal, Ordering::Relaxed);
}

pub(crate) fn install_signal_handlers() {
    INTERRUPTED.store(0, Ordering::Relaxed);
    // The child resets these dispositions before exec. The supervisor must
    // survive a foreground Ctrl-C to reap the child and detach its binding.
    unsafe {
        libc::signal(libc::SIGINT, interrupt as *const () as libc::sighandler_t);
        libc::signal(libc::SIGQUIT, interrupt as *const () as libc::sighandler_t);
    }
}

fn request(job_id: &str, arm: bool) -> Result<bool, String> {
    request_value_with_timeout(
        "agent.startup_retry",
        json!({ "jobId": job_id, "arm": arm }),
        Duration::from_millis(200),
    )
    .map(|value| value["routingFailure"].as_bool().unwrap_or(false))
}

fn routing_failure(job_id: &str) -> bool {
    // wait() may beat the PTY reader to the final diagnostic. Allow the reader
    // to catch up, but fail closed if the host cannot classify this attempt.
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if INTERRUPTED.load(Ordering::Relaxed) != 0 {
            return false;
        }
        match request(job_id, false) {
            Ok(true) => return true,
            Err(_) => return false,
            Ok(false) if Instant::now() >= deadline => return false,
            Ok(false) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn wait_backoff(delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    while Instant::now() < deadline {
        if INTERRUPTED.load(Ordering::Relaxed) != 0 {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    INTERRUPTED.load(Ordering::Relaxed) == 0
}

pub(crate) fn run(
    command: &mut Command,
    job_id: &str,
    args: &[String],
) -> (Result<ExitStatus, String>, Option<String>) {
    let mut attempts = 0;
    let cancelled = Cell::new(false);
    let mut result = run_attempts(
        || {
            let armed = request(job_id, true).is_ok();
            let signal = INTERRUPTED.load(Ordering::Relaxed);
            if signal != 0 {
                cancelled.set(true);
                return Ok((ExitStatus::from_raw(signal), false));
            }
            attempts += 1;
            let status = command
                .spawn()
                .and_then(|mut child| child.wait())
                .map_err(|error| format!("failed to run Codex: {error}"))?;
            let retryable = status
                .code()
                .is_some_and(|code| code != 0 && code != 130 && code != 131)
                && INTERRUPTED.load(Ordering::Relaxed) == 0
                && armed
                && routing_failure(job_id);
            Ok((status, retryable))
        },
        |attempt, delay| {
            eprintln!(
                "qmux: Codex workspace routing failed. Retrying in {}s (attempt {attempt}/3; Ctrl-C to cancel)…",
                delay.as_secs()
            );
            let proceed = wait_backoff(delay);
            cancelled.set(!proceed);
            proceed
        },
    );
    if cancelled.get() {
        result = Ok(ExitStatus::from_raw(INTERRUPTED.load(Ordering::Relaxed)));
    }
    let interrupted_exit = result.as_ref().is_ok_and(|status| {
        matches!(status.signal(), Some(libc::SIGINT | libc::SIGQUIT))
            || matches!(status.code(), Some(130 | 131))
    });
    let message = (result.as_ref().map_or(true, |status| !status.success())
        && !interrupted_exit).then(|| format!(
            "qmux: Codex exited with an error after {attempts} attempt(s).\nResume manually:\n  {}",
            resume_command(args)
        ));
    // The caller prints this after detach has reset any leftover TUI modes.
    (result, message)
}

fn run_attempts(
    mut attempt: impl FnMut() -> Result<(ExitStatus, bool), String>,
    mut backoff: impl FnMut(usize, Duration) -> bool,
) -> Result<ExitStatus, String> {
    for index in 0..=BACKOFF.len() {
        let (status, retryable) = attempt()?;
        if status.success()
            || !retryable
            || index == BACKOFF.len()
            || !backoff(index + 2, BACKOFF[index])
        {
            return Ok(status);
        }
    }
    unreachable!()
}

fn resume_command(args: &[String]) -> String {
    let mut words = vec!["codex resume".to_string()];
    words.extend(
        args.iter()
            .skip(1)
            .map(|arg| format!("'{}'", arg.replace('\'', "'\\''"))),
    );
    words.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_attempts_with_three_and_five_second_backoffs() {
        let mut attempts = 0;
        let mut delays = Vec::new();
        let status = run_attempts(
            || {
                attempts += 1;
                Ok((ExitStatus::from_raw(256), true))
            },
            |attempt, delay| {
                delays.push((attempt, delay.as_secs()));
                true
            },
        )
        .unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(delays, [(2, 3), (3, 5)]);
        assert_eq!(status.code(), Some(1));
    }

    #[test]
    fn success_unrelated_failure_and_cancel_stop_retries() {
        for (code, retryable, continue_retry, expected) in
            [(0, true, true, 1), (1, false, true, 1), (1, true, false, 1)]
        {
            let mut attempts = 0;
            run_attempts(
                || {
                    attempts += 1;
                    Ok((ExitStatus::from_raw(code << 8), retryable))
                },
                |_, _| continue_retry,
            )
            .unwrap();
            assert_eq!(attempts, expected);
        }
        let mut attempts = 0;
        run_attempts(
            || {
                attempts += 1;
                Ok((
                    ExitStatus::from_raw(if attempts == 2 { 0 } else { 256 }),
                    true,
                ))
            },
            |_, _| true,
        )
        .unwrap();
        assert_eq!(attempts, 2);
    }

    #[test]
    fn manual_resume_command_quotes_shell_metacharacters() {
        assert_eq!(
            resume_command(&["resume".into(), "session'; $(false)".into()]),
            "codex resume 'session'\\''; $(false)'"
        );
    }
}
