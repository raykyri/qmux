use std::process::{Child, Command};
use std::sync::Mutex;

/// Owns the `caffeinate(8)` helper that keeps macOS awake while agents are
/// working. Shelling out to the bundled system tool keeps this dependency-free:
/// `-i` blocks idle *system* sleep (the display may still sleep), and `-w <pid>`
/// makes the helper exit on its own if qmux dies, so a crash can never leave the
/// machine pinned awake. The frontend drives `set_active` from a settings toggle
/// combined with whether any agent is running.
#[derive(Default)]
pub struct SleepGuard {
    child: Mutex<Option<Child>>,
}

impl SleepGuard {
    /// Idempotently turns the wake lock on or off. Spawning while already armed,
    /// or releasing while already idle, is a no-op.
    pub fn set_active(&self, active: bool) -> Result<(), String> {
        let mut slot = self
            .child
            .lock()
            .map_err(|_| "sleep guard lock poisoned".to_string())?;

        // Forget a helper that has already exited (e.g. it was killed externally)
        // so we re-arm correctly rather than believing we still hold the lock.
        if slot
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(Some(_))))
        {
            *slot = None;
        }

        if active {
            if slot.is_none() {
                *slot = spawn_caffeinate()?;
            }
        } else if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

impl Drop for SleepGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn spawn_caffeinate() -> Result<Option<Child>, String> {
    let pid = std::process::id().to_string();
    Command::new("caffeinate")
        .args(["-i", "-w", &pid])
        .spawn()
        .map(Some)
        .map_err(|err| format!("failed to start caffeinate: {err}"))
}

#[cfg(not(target_os = "macos"))]
fn spawn_caffeinate() -> Result<Option<Child>, String> {
    // No idle-sleep inhibitor is wired up off macOS; keep the toggle a no-op
    // rather than surfacing an error to the UI on every change.
    Ok(None)
}
