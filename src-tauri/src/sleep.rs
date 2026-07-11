use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a battery probe's verdict is reused before `pmset` is consulted
/// again. The frontend re-asserts the wake lock every 30 seconds for as long as
/// an agent runs, and battery state moves slowly around the 10% threshold, so a
/// short TTL trades sub-minute threshold precision for not forking a subprocess
/// on every re-assert.
const BATTERY_PROBE_TTL: Duration = Duration::from_secs(60);

/// Owns the `caffeinate(8)` helper that keeps macOS awake while agents are
/// working. Shelling out to the bundled system tool keeps this dependency-free:
/// `-i` blocks idle *system* sleep (the display may still sleep), and `-w <pid>`
/// makes the helper exit on its own if qmux dies, so a crash can never leave the
/// machine pinned awake. The frontend drives `set_active` from a settings toggle
/// combined with whether any agent is running.
#[derive(Default)]
pub struct SleepGuard {
    child: Mutex<Option<Child>>,
    battery_probe: Mutex<Option<(Instant, bool)>>,
}

impl SleepGuard {
    /// Idempotently turns the wake lock on or off. Spawning while already armed,
    /// or releasing while already idle, is a no-op. Even when the caller wants the
    /// lock, it is held off (and released if already armed) while the machine is on
    /// battery and below 10% — so a long-running agent can't drain a nearly-empty
    /// battery by pinning the machine awake. The frontend re-asserts this periodically,
    /// so the lock re-arms once the charge recovers or power is plugged in.
    pub fn set_active(&self, active: bool) -> Result<(), String> {
        // `&&` short-circuits, so the battery is only probed when the lock is wanted.
        let active = active && !self.battery_blocks_wake_cached();

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

    /// `battery_blocks_wake` behind a short-lived cache, so the periodic wake-lock
    /// re-asserts don't each pay a `pmset` fork. A poisoned cache lock just probes
    /// fresh — the cache is an optimization, never a correctness dependency.
    fn battery_blocks_wake_cached(&self) -> bool {
        if let Ok(cache) = self.battery_probe.lock()
            && let Some((probed_at, verdict)) = *cache
            && probed_at.elapsed() < BATTERY_PROBE_TTL
        {
            return verdict;
        }
        let verdict = battery_blocks_wake();
        if let Ok(mut cache) = self.battery_probe.lock() {
            *cache = Some((Instant::now(), verdict));
        }
        verdict
    }
}

impl Drop for SleepGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.child.lock()
            && let Some(mut child) = slot.take()
        {
            let _ = child.kill();
            let _ = child.wait();
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

/// Whether a low battery should currently block the wake lock: only on macOS, only
/// when running on battery, and only below 10%.
#[cfg(target_os = "macos")]
fn battery_blocks_wake() -> bool {
    let Ok(output) = Command::new("pmset").args(["-g", "batt"]).output() else {
        // Can't read the battery state — fail open (keep the machine awake) rather
        // than letting it sleep mid-agent-run on an unreadable system.
        return false;
    };
    wake_blocked_by_battery(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn battery_blocks_wake() -> bool {
    false
}

/// Decides from `pmset -g batt` output whether the wake lock should be blocked: only
/// when drawing from battery AND below 10%. Output we can't parse fails open (returns
/// false) so the lock behaves as before rather than surprising the user with sleep.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn wake_blocked_by_battery(pmset_output: &str) -> bool {
    // pmset prints "Now drawing from 'Battery Power'" vs "'AC Power'"; the battery
    // line ("-InternalBattery-0") never contains the exact phrase "Battery Power".
    if !pmset_output.contains("Battery Power") {
        return false;
    }
    match parse_battery_percent(pmset_output) {
        Some(percent) => percent < 10,
        None => false,
    }
}

/// Pulls the first "NN%" charge token out of `pmset -g batt` output.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_battery_percent(text: &str) -> Option<u8> {
    let percent_idx = text.find('%')?;
    let bytes = text.as_bytes();
    let mut start = percent_idx;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start == percent_idx {
        return None;
    }
    text[start..percent_idx].parse::<u8>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON_BATTERY: &str = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t{}; discharging; present: true";
    const ON_AC: &str =
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t{}; charging; present: true";

    #[test]
    fn blocks_only_on_battery_below_ten_percent() {
        // On battery, under 10% → block the wake lock.
        assert!(wake_blocked_by_battery(&ON_BATTERY.replace("{}", "7%")));
        assert!(wake_blocked_by_battery(&ON_BATTERY.replace("{}", "0%")));
        // On battery, at/above 10% → keep it.
        assert!(!wake_blocked_by_battery(&ON_BATTERY.replace("{}", "10%")));
        assert!(!wake_blocked_by_battery(&ON_BATTERY.replace("{}", "85%")));
        // On AC, even at a low charge → never block.
        assert!(!wake_blocked_by_battery(&ON_AC.replace("{}", "3%")));
        // Unparseable output fails open.
        assert!(!wake_blocked_by_battery("garbled"));
        assert!(!wake_blocked_by_battery(
            "Now drawing from 'Battery Power'\n no percent"
        ));
    }

    #[test]
    fn parses_the_first_percent_token() {
        assert_eq!(
            parse_battery_percent(" -InternalBattery-0\t42%; discharging;"),
            Some(42)
        );
        assert_eq!(parse_battery_percent("100%; charged"), Some(100));
        assert_eq!(parse_battery_percent("no percent here"), None);
        assert_eq!(parse_battery_percent("%"), None);
    }
}
