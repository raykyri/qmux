//! Startup progress is separate from the session model so polling and quitting
//! stay responsive while recovery holds the model lock or waits for a shell.
use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupProgress {
    pub phase: &'static str,
    pub completed: usize,
    pub total: usize,
    pub error: Option<String>,
    pub quitting: bool,
}

struct Inner {
    progress: StartupProgress,
    running: bool,
    interface_ready: bool,
}

pub struct StartupState(Mutex<Inner>);

pub enum StartupExit {
    Defer,
    Exit,
    Confirm,
}

impl Default for StartupState {
    fn default() -> Self {
        Self(Mutex::new(Inner {
            progress: StartupProgress {
                phase: "loading",
                completed: 0,
                total: 0,
                error: None,
                quitting: false,
            },
            running: true,
            interface_ready: false,
        }))
    }
}

impl StartupState {
    pub fn snapshot(&self) -> StartupProgress {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .progress
            .clone()
    }

    pub fn panes(&self, completed: usize, total: usize) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.progress.phase = "panes";
        inner.progress.completed = completed;
        inner.progress.total = total;
    }

    pub fn quitting(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .progress
            .quitting
    }

    /// Returns whether an exit was deferred until the recovery worker stopped.
    pub fn finish(&self, result: Result<(), String>) -> bool {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.running = false;
        inner.progress.phase = if result.is_ok() { "ready" } else { "failed" };
        inner.progress.error = result.err();
        inner.progress.quitting
    }

    pub fn interface_ready(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .interface_ready = true;
    }

    pub fn interface_loading(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .interface_ready = false;
    }

    pub fn request_exit(&self) -> StartupExit {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.interface_ready && !inner.progress.quitting {
            return StartupExit::Confirm;
        }
        inner.progress.quitting = true;
        if inner.running {
            StartupExit::Defer
        } else {
            StartupExit::Exit
        }
    }
}

#[tauri::command]
pub fn startup_progress(startup: tauri::State<'_, StartupState>) -> StartupProgress {
    startup.snapshot()
}

#[tauri::command]
pub fn app_interface_ready(startup: tauri::State<'_, StartupState>) {
    startup.interface_ready();
}

#[tauri::command]
pub fn startup_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_waits_for_worker_and_survives_progress_updates() {
        let state = StartupState::default();
        assert!(matches!(state.request_exit(), StartupExit::Defer));
        state.panes(1, 3);
        assert!(state.snapshot().quitting);
        assert!(state.finish(Ok(())));
        assert!(matches!(state.request_exit(), StartupExit::Exit));
    }

    #[test]
    fn normal_confirmation_requires_the_interface_listener() {
        let state = StartupState::default();
        assert!(!state.finish(Ok(())));
        assert!(matches!(state.request_exit(), StartupExit::Exit));
        let state = StartupState::default();
        state.finish(Ok(()));
        state.interface_ready();
        assert!(matches!(state.request_exit(), StartupExit::Confirm));
    }

    #[test]
    fn failure_can_be_displayed_and_quit() {
        let state = StartupState::default();
        state.finish(Err("cannot read session".into()));
        assert_eq!(state.snapshot().phase, "failed");
        assert_eq!(
            state.snapshot().error.as_deref(),
            Some("cannot read session")
        );
        assert!(matches!(state.request_exit(), StartupExit::Exit));
    }

    #[test]
    fn reload_revokes_confirmation_until_the_new_listener_is_ready() {
        let state = StartupState::default();
        state.finish(Ok(()));
        state.interface_ready();
        state.interface_loading();
        assert!(matches!(state.request_exit(), StartupExit::Exit));
    }
}
