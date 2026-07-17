use crate::{persistence, state::AppState};
use serde::Serialize;
use std::{
    path::Path,
    str::FromStr,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

const WINDOW_LABEL: &str = "global-task-launcher";
const DEFAULT_HOTKEY: &str = "doubleOption";

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

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
    hotkey: String,
    registered: bool,
    error: Option<String>,
}

impl GlobalTaskLauncherState {
    fn status(&self) -> GlobalTaskLauncherSetting {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        GlobalTaskLauncherSetting {
            hotkey: inner
                .configured
                .unwrap_or(LauncherHotkey::DoubleOption)
                .value()
                .to_string(),
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

pub fn init(app: &AppHandle, workspace_root: &Path) {
    // Retain the concrete desktop handle for the modifier-only Swift callback,
    // which has no Tauri event-loop argument of its own.
    let _ = APP_HANDLE.set(app.clone());

    let configured_value = persistence::load_preferences(workspace_root)
        .ok()
        .and_then(|preferences| preferences.global_launcher_hotkey)
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());
    let configured =
        LauncherHotkey::parse(&configured_value).unwrap_or(LauncherHotkey::DoubleOption);
    let state = app.state::<GlobalTaskLauncherState>();
    let result = activate(app, configured);
    let mut inner = state
        .inner
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    inner.configured = Some(configured);
    inner.registered = result.is_ok();
    inner.error = result.err();
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

#[tauri::command]
pub fn global_task_launcher_hotkey_get(
    state: tauri::State<'_, GlobalTaskLauncherState>,
) -> GlobalTaskLauncherSetting {
    state.status()
}

#[tauri::command(async)]
pub fn global_task_launcher_hotkey_set<R: Runtime>(
    app: AppHandle<R>,
    app_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, GlobalTaskLauncherState>,
    hotkey: String,
) -> Result<GlobalTaskLauncherSetting, String> {
    let replacement = LauncherHotkey::parse(&hotkey)?;
    let _operation = state
        .operation
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let previous = {
        let inner = state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        inner.configured.unwrap_or(LauncherHotkey::DoubleOption)
    };
    if previous == replacement && state.status().registered {
        return Ok(state.status());
    }

    deactivate(&app, previous);
    let activation = activate(&app, replacement).and_then(|()| {
        persistence::update_preferences(&app_state.config().workspace_root, |preferences| {
            preferences.global_launcher_hotkey = Some(replacement.value().to_string());
        })
    });

    let mut inner = state
        .inner
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    match activation {
        Ok(()) => {
            inner.configured = Some(replacement);
            inner.registered = true;
            inner.error = None;
        }
        Err(error) => {
            deactivate(&app, replacement);
            let rollback = activate(&app, previous);
            inner.configured = Some(previous);
            inner.registered = rollback.is_ok();
            inner.error = Some(match rollback {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}. Restoring the previous hotkey also failed: {rollback_error}")
                }
            });
        }
    }
    drop(inner);
    Ok(state.status())
}

fn activate<R: Runtime>(app: &AppHandle<R>, hotkey: LauncherHotkey) -> Result<(), String> {
    if let Some(accelerator) = hotkey.accelerator() {
        let shortcut = Shortcut::from_str(accelerator)
            .map_err(|error| format!("Couldn't use {accelerator}: {error}"))?;
        app.global_shortcut()
            .register(shortcut)
            .map_err(|error| format!("Couldn't register {accelerator}: {error}"))
    } else {
        set_double_modifier(hotkey.modifier_code())
    }
}

fn deactivate<R: Runtime>(app: &AppHandle<R>, hotkey: LauncherHotkey) {
    if let Some(accelerator) = hotkey.accelerator() {
        if let Ok(shortcut) = Shortcut::from_str(accelerator) {
            let _ = app.global_shortcut().unregister(shortcut);
        }
    } else {
        let _ = set_double_modifier(0);
    }
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
    use super::LauncherHotkey;

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
