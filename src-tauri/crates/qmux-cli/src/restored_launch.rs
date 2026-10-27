//! Failure reporting for restored shell agents. Exit status comes from the
//! supervisor's wait(), so stopped or backgrounded jobs cannot trigger a report.
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;

pub const COMMAND_ENV: &str = "QMUX_RESTORE_COMMAND";

pub(crate) fn failure_message(
    command: Option<&str>,
    result: &Result<ExitStatus, String>,
) -> Option<String> {
    let command = command?;
    let reason = match result {
        Ok(status) if status.success() => return None,
        Ok(status)
            if matches!(status.signal(), Some(libc::SIGINT | libc::SIGQUIT))
                || matches!(status.code(), Some(130 | 131)) =>
        {
            return None;
        }
        Ok(status) => format!(
            "Restored agent exited with an error (exit {}).",
            crate::exit_code_for_status(*status)
        ),
        Err(_) => "Could not launch restored agent.".to_string(),
    };
    Some(format!("qmux: {reason}\nResume manually:\n  {command}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restored_failures_preserve_the_adapters_exact_resume_command() {
        for command in [
            "claude --resume 'session-id'",
            "opencode --session 'session-id'",
            "pi --session '/path with spaces/session.jsonl'",
            "cursor-agent --resume 'session-id'",
            "muse resume 'sess'\\''ion; $(false)'",
        ] {
            let message =
                failure_message(Some(command), &Ok(ExitStatus::from_raw(2 << 8))).unwrap();
            assert!(message.contains("exit 2"));
            assert!(message.ends_with(&format!("Resume manually:\n  {command}")));
        }
    }

    #[test]
    fn fresh_successful_and_interrupted_launches_are_silent() {
        assert!(failure_message(None, &Ok(ExitStatus::from_raw(1 << 8))).is_none());
        assert!(failure_message(None, &Err("launch failed".into())).is_none());
        for status in [0, 130 << 8, 131 << 8, libc::SIGINT, libc::SIGQUIT] {
            assert!(
                failure_message(
                    Some("claude --resume 'id'"),
                    &Ok(ExitStatus::from_raw(status))
                )
                .is_none()
            );
        }
    }

    #[test]
    fn preparation_and_spawn_failures_also_include_the_resume_command() {
        let message =
            failure_message(Some("pi --session 'id'"), &Err("binary missing".into())).unwrap();
        assert_eq!(
            message,
            "qmux: Could not launch restored agent.\nResume manually:\n  pi --session 'id'"
        );
    }
}
