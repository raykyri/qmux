use crate::show_hide_shortcut::{ShortcutRegistry, replace_active_registration};
use crate::{persistence, state::AppState};
use serde::Serialize;
use std::{
    path::Path,
    str::FromStr,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicI32, Ordering},
    },
};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

const WINDOW_LABEL: &str = "global-task-launcher";
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
/// Discriminant currently installed in the Swift double-tap monitor's single
/// slot (0 = none). Installing a hotkey replaces the slot, so releasing one
/// must be a no-op when another double-tap binding has already taken it over.
static INSTALLED_DOUBLE_MODIFIER: AtomicI32 = AtomicI32::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LauncherHotkey {
    DoubleControl,
    DoubleOption,
    DoubleCommand,
    ControlSpace,
    OptionSpace,
    CommandSpace,
}

impl LauncherHotkey {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "doubleControl" => Ok(Self::DoubleControl),
            "doubleOption" => Ok(Self::DoubleOption),
            "doubleCommand" => Ok(Self::DoubleCommand),
            "Control+Space" => Ok(Self::ControlSpace),
            "Option+Space" => Ok(Self::OptionSpace),
            "Command+Space" => Ok(Self::CommandSpace),
            _ => Err("Choose one of the supported global launcher hotkeys".to_string()),
        }
    }

    fn value(self) -> &'static str {
        match self {
            Self::DoubleControl => "doubleControl",
            Self::DoubleOption => "doubleOption",
            Self::DoubleCommand => "doubleCommand",
            Self::ControlSpace => "Control+Space",
            Self::OptionSpace => "Option+Space",
            Self::CommandSpace => "Command+Space",
        }
    }

    fn accelerator(self) -> Option<&'static str> {
        match self {
            Self::ControlSpace => Some("Control+Space"),
            Self::OptionSpace => Some("Option+Space"),
            Self::CommandSpace => Some("Command+Space"),
            _ => None,
        }
    }

    fn modifier_code(self) -> i32 {
        match self {
            Self::DoubleControl => 1,
            Self::DoubleOption => 2,
            Self::DoubleCommand => 3,
            _ => 0,
        }
    }
}

#[derive(Default)]
pub struct GlobalTaskLauncherState {
    inner: Mutex<GlobalTaskLauncherInner>,
    operation: Mutex<()>,
}

#[derive(Default)]
struct GlobalTaskLauncherInner {
    configured: Option<LauncherHotkey>,
    registered: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalTaskLauncherSetting {
    hotkey: Option<String>,
    registered: bool,
    error: Option<String>,
}

impl GlobalTaskLauncherState {
    fn status(&self) -> GlobalTaskLauncherSetting {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        GlobalTaskLauncherSetting {
            hotkey: inner.configured.map(|hotkey| hotkey.value().to_string()),
            registered: inner.registered,
            error: inner.error.clone(),
        }
    }

    fn handles(&self, shortcut: &Shortcut) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.registered
            && inner
                .configured
                .and_then(LauncherHotkey::accelerator)
                .and_then(|value| Shortcut::from_str(value).ok())
                .is_some_and(|registered| registered == *shortcut)
    }
}

pub fn create_window<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("index.html?global-task-launcher=1".into()),
    )
    .title("Quick Launch")
    .inner_size(720.0, 420.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .shadow(true)
    .build()?;
    Ok(())
}

/// The launcher's two hotkey backends behind the shared show/hide replacement
/// transaction: space chords live in the global accelerator registry, double-tap
/// hotkeys in the Swift modifier monitor's single slot. Registrations are keyed
/// by `LauncherHotkey::value()` strings.
struct LauncherHotkeyRegistry<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<R: Runtime> ShortcutRegistry for LauncherHotkeyRegistry<'_, R> {
    fn register(&self, value: &str) -> Result<(), String> {
        let hotkey = LauncherHotkey::parse(value)?;
        match hotkey.accelerator() {
            Some(accelerator) => {
                let shortcut =
                    Shortcut::from_str(accelerator).map_err(|error| error.to_string())?;
                self.app
                    .global_shortcut()
                    .register(shortcut)
                    .map_err(|error| error.to_string())
            }
            None => set_double_modifier_tracked(hotkey.modifier_code()),
        }
    }

    fn unregister(&self, value: &str) -> Result<(), String> {
        let hotkey = LauncherHotkey::parse(value)?;
        match hotkey.accelerator() {
            Some(accelerator) => {
                let shortcut =
                    Shortcut::from_str(accelerator).map_err(|error| error.to_string())?;
                self.app
                    .global_shortcut()
                    .unregister(shortcut)
                    .map_err(|error| error.to_string())
            }
            None if INSTALLED_DOUBLE_MODIFIER.load(Ordering::SeqCst) == hotkey.modifier_code() => {
                set_double_modifier_tracked(0)
            }
            // Another double-tap binding already replaced this slot.
            None => Ok(()),
        }
    }

    fn is_registered(&self, value: &str) -> bool {
        LauncherHotkey::parse(value).is_ok_and(|hotkey| match hotkey.accelerator() {
            Some(accelerator) => Shortcut::from_str(accelerator)
                .map(|shortcut| self.app.global_shortcut().is_registered(shortcut))
                .unwrap_or(false),
            None => INSTALLED_DOUBLE_MODIFIER.load(Ordering::SeqCst) == hotkey.modifier_code(),
        })
    }
}

pub fn init(app: &AppHandle, workspace_root: &Path) {
    // Retain the concrete desktop handle for the modifier-only Swift callback,
    // which has no Tauri event-loop argument of its own.
    let _ = APP_HANDLE.set(app.clone());

    let configured_value = persistence::load_preferences(workspace_root)
        .ok()
        .and_then(|preferences| preferences.global_launcher_hotkey);
    let state = app.state::<GlobalTaskLauncherState>();
    let mut inner = state
        .inner
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    match configured_value
        .as_deref()
        .map(LauncherHotkey::parse)
        .transpose()
    {
        Ok(configured) => {
            let result = configured
                .map(|hotkey| {
                    LauncherHotkeyRegistry { app }
                        .register(hotkey.value())
                        .map_err(|error| format!("Couldn't register {}: {error}", hotkey.value()))
                })
                .transpose();
            inner.configured = configured;
            inner.registered = matches!(result, Ok(Some(())));
            inner.error = result.err();
        }
        Err(error) => {
            eprintln!("qmux: invalid global launcher hotkey preference: {error}");
            inner.error = Some(error);
        }
    }
}

pub fn handle_global_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    shortcut: &Shortcut,
    event: ShortcutEvent,
) {
    if event.state != ShortcutState::Pressed
        || !app
            .try_state::<GlobalTaskLauncherState>()
            .is_some_and(|state| state.handles(shortcut))
    {
        return;
    }
    if let Err(error) = show_window(app) {
        eprintln!("qmux: failed to show global task launcher: {error}");
    }
}

pub fn show_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(());
    };
    // Record whoever is frontmost before we activate qmux, so dismissing the
    // launcher can hand focus back to the app the user summoned it from.
    capture_previous_app();
    let main_window = app.get_webview_window("main");
    let main_was_visible = main_window
        .as_ref()
        .and_then(|main| main.is_visible().ok())
        .unwrap_or(false);
    #[cfg(target_os = "macos")]
    app.show()?;
    // Unhiding the application can restore every app-hidden window. Preserve a
    // previously hidden main window so quick launch remains a standalone popup.
    if !main_was_visible && let Some(main) = main_window {
        main.hide()?;
    }
    window.center()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Hides the launcher and returns focus to the app it was summoned from. Used
/// by the explicit-dismiss paths (submit, Escape); a focus-loss dismissal keeps
/// a plain `hide` since the OS has already moved focus where the user clicked.
#[tauri::command]
pub fn global_task_launcher_dismiss<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    restore_previous_app();
    Ok(())
}

#[tauri::command]
pub fn global_task_launcher_hotkey_get(
    state: tauri::State<'_, GlobalTaskLauncherState>,
) -> GlobalTaskLauncherSetting {
    state.status()
}

/// Opens the launcher window on demand — the ⌘K palette's path to it, so the
/// launcher stays reachable without the global hotkey.
#[tauri::command]
pub fn global_task_launcher_open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    show_window(&app).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn global_task_launcher_hotkey_set<R: Runtime>(
    app: AppHandle<R>,
    app_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, GlobalTaskLauncherState>,
    hotkey: Option<String>,
) -> Result<GlobalTaskLauncherSetting, String> {
    let replacement = hotkey.as_deref().map(LauncherHotkey::parse).transpose()?;
    let _operation = state
        .operation
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (previous, previous_registered) = {
        let inner = state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (inner.configured, inner.registered)
    };
    if previous == replacement && (replacement.is_none() || previous_registered) {
        return Ok(state.status());
    }

    let registry = LauncherHotkeyRegistry { app: &app };
    let result = replace_active_registration(
        &registry,
        previous
            .filter(|_| previous_registered)
            .map(LauncherHotkey::value),
        replacement.map(LauncherHotkey::value),
        || {
            persistence::update_preferences(&app_state.config().workspace_root, |preferences| {
                preferences.global_launcher_hotkey =
                    replacement.map(|hotkey| hotkey.value().to_string());
            })
        },
    );

    // Resolve the outcome — including any rollback and the registration probe —
    // *before* taking `inner`. For a double-tap hotkey the transaction crosses
    // into Swift via DispatchQueue.main.sync, and the main thread takes `inner`
    // on every global-shortcut press (`handles`) and settings read (`status`);
    // holding `inner` across those calls deadlocks the main thread. The
    // `operation` lock (held for this whole command, and taken nowhere else)
    // still serializes concurrent hotkey changes.
    let (configured, registered, error) = match result {
        Ok(()) => (replacement, replacement.is_some(), None),
        Err(error) => {
            // The transaction restored (or reported) the previous registration;
            // probe the registry rather than trust it so Settings reflects the
            // real state.
            (
                previous,
                previous.is_some_and(|hotkey| registry.is_registered(hotkey.value())),
                Some(error),
            )
        }
    };

    let mut inner = state
        .inner
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    inner.configured = configured;
    inner.registered = registered;
    inner.error = error;
    drop(inner);
    Ok(state.status())
}

fn set_double_modifier_tracked(modifier: i32) -> Result<(), String> {
    set_double_modifier(modifier)?;
    INSTALLED_DOUBLE_MODIFIER.store(modifier, Ordering::SeqCst);
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_double_modifier(modifier: i32) -> Result<(), String> {
    unsafe extern "C" {
        fn qmux_global_task_launcher_set_double_modifier(modifier: i32) -> i32;
    }
    // SAFETY: the Swift bridge accepts the documented scalar discriminants and
    // synchronously installs/removes its AppKit event monitors.
    if unsafe { qmux_global_task_launcher_set_double_modifier(modifier) } == 1 {
        Ok(())
    } else {
        Err("Couldn't install the modifier-key monitor".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn set_double_modifier(_modifier: i32) -> Result<(), String> {
    Err("Double-tap launcher hotkeys are currently available on macOS only".to_string())
}

#[cfg(target_os = "macos")]
fn capture_previous_app() {
    unsafe extern "C" {
        fn qmux_global_task_launcher_capture_previous_app();
    }
    // SAFETY: the Swift bridge records the frontmost NSRunningApplication on the
    // main thread and takes no arguments.
    unsafe { qmux_global_task_launcher_capture_previous_app() };
}

#[cfg(not(target_os = "macos"))]
fn capture_previous_app() {}

#[cfg(target_os = "macos")]
fn restore_previous_app() {
    unsafe extern "C" {
        fn qmux_global_task_launcher_restore_previous_app();
    }
    // SAFETY: the Swift bridge reactivates the recorded application on the main
    // thread and takes no arguments.
    unsafe { qmux_global_task_launcher_restore_previous_app() };
}

#[cfg(not(target_os = "macos"))]
fn restore_previous_app() {}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_global_task_launcher_did_trigger() {
    let Some(app) = APP_HANDLE.get().cloned() else {
        return;
    };
    let main_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = show_window(&main_app) {
            eprintln!("qmux: failed to show global task launcher: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{GlobalTaskLauncherState, LauncherHotkey};

    #[test]
    fn global_hotkey_defaults_to_disabled() {
        let setting = GlobalTaskLauncherState::default().status();
        assert_eq!(setting.hotkey, None);
        assert!(!setting.registered);
        assert_eq!(setting.error, None);
    }

    #[test]
    fn accepts_only_the_six_supported_hotkeys() {
        for value in [
            "doubleControl",
            "doubleOption",
            "doubleCommand",
            "Control+Space",
            "Option+Space",
            "Command+Space",
        ] {
            let hotkey = LauncherHotkey::parse(value).expect("supported hotkey");
            assert_eq!(hotkey.value(), value);
        }
        assert!(LauncherHotkey::parse("Command+K").is_err());
    }

    #[test]
    fn only_space_chords_use_the_global_shortcut_registry() {
        assert_eq!(
            LauncherHotkey::parse("Option+Space").unwrap().accelerator(),
            Some("Option+Space")
        );
        assert_eq!(
            LauncherHotkey::parse("doubleOption").unwrap().accelerator(),
            None
        );
    }
}
