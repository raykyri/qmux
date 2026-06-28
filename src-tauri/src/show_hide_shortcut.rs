use crate::{persistence, state::AppState};
use serde::Serialize;
use std::{path::Path, str::FromStr, sync::Mutex};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

#[derive(Default)]
pub struct ShowHideShortcutState {
    inner: Mutex<ShowHideShortcutInner>,
}

#[derive(Default)]
struct ShowHideShortcutInner {
    registered_accelerator: Option<String>,
    last_error: Option<String>,
    capture_active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowHideShortcutSetting {
    pub accelerator: Option<String>,
    pub registered: bool,
    pub error: Option<String>,
}

pub fn init<R: Runtime>(app: &AppHandle<R>, workspace_root: &Path) {
    let accelerator = match persistence::load_preferences(workspace_root) {
        Ok(preferences) => preferences.show_hide_shortcut,
        Err(err) => {
            eprintln!("qmux: failed to read show/hide shortcut preference: {err}");
            None
        }
    };

    if accelerator.is_some() {
        let state = app.state::<ShowHideShortcutState>();
        match normalize_accelerator(accelerator) {
            Ok(accelerator) => {
                let setting = replace_registered_shortcut(app, state.inner(), accelerator);
                if let Some(error) = setting.error {
                    eprintln!("qmux: failed to register show/hide shortcut: {error}");
                }
            }
            Err(err) => {
                state.set_error(err.clone());
                eprintln!("qmux: invalid show/hide shortcut preference: {err}");
            }
        }
    }
}

pub fn handle_global_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    _shortcut: &Shortcut,
    event: ShortcutEvent,
) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    if app
        .try_state::<ShowHideShortcutState>()
        .is_some_and(|state| state.inner().capture_active())
    {
        return;
    }
    if let Err(err) = toggle_qmux_visibility(app) {
        eprintln!("qmux: failed to toggle app visibility: {err}");
    }
}

#[tauri::command]
pub fn show_hide_shortcut_get(
    app_state: tauri::State<'_, AppState>,
    shortcut_state: tauri::State<'_, ShowHideShortcutState>,
) -> Result<ShowHideShortcutSetting, String> {
    let accelerator =
        persistence::load_preferences(&app_state.config().workspace_root)?.show_hide_shortcut;
    Ok(shortcut_state.status(accelerator))
}

#[tauri::command]
pub fn show_hide_shortcut_set<R: Runtime>(
    app: AppHandle<R>,
    app_state: tauri::State<'_, AppState>,
    shortcut_state: tauri::State<'_, ShowHideShortcutState>,
    accelerator: Option<String>,
) -> Result<ShowHideShortcutSetting, String> {
    let accelerator = normalize_accelerator(accelerator)?;

    let mut preferences =
        persistence::load_preferences(&app_state.config().workspace_root).unwrap_or_default();
    preferences.show_hide_shortcut = accelerator.clone();
    persistence::save_preferences(&app_state.config().workspace_root, &preferences)?;

    Ok(replace_registered_shortcut(
        &app,
        shortcut_state.inner(),
        accelerator,
    ))
}

#[tauri::command]
pub fn show_hide_shortcut_capture_set(
    shortcut_state: tauri::State<'_, ShowHideShortcutState>,
    active: bool,
) {
    shortcut_state.set_capture_active(active);
}

impl ShowHideShortcutState {
    fn set_capture_active(&self, active: bool) {
        self.inner.lock().unwrap().capture_active = active;
    }

    fn capture_active(&self) -> bool {
        self.inner.lock().unwrap().capture_active
    }

    fn set_error(&self, error: String) {
        self.inner.lock().unwrap().last_error = Some(error);
    }

    fn status(&self, configured_accelerator: Option<String>) -> ShowHideShortcutSetting {
        let inner = self.inner.lock().unwrap();
        let registered = match (
            configured_accelerator.as_deref(),
            inner.registered_accelerator.as_deref(),
        ) {
            (Some(configured), Some(registered)) => configured == registered,
            _ => false,
        };
        ShowHideShortcutSetting {
            accelerator: configured_accelerator,
            registered,
            error: inner.last_error.clone(),
        }
    }
}

fn normalize_accelerator(accelerator: Option<String>) -> Result<Option<String>, String> {
    let Some(accelerator) = accelerator else {
        return Ok(None);
    };
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return Ok(None);
    }

    let parts = accelerator.split('+').map(str::trim).collect::<Vec<&str>>();
    if parts.iter().any(|part| part.is_empty()) {
        return Err("Shortcut contains an empty key segment.".to_string());
    }

    let shortcut_text = parts.join("+");
    let shortcut = Shortcut::from_str(&shortcut_text)
        .map_err(|err| format!("Couldn't use that shortcut: {err}"))?;
    if shortcut.mods.is_empty() {
        return Err("Use at least one modifier, such as Option or Command.".to_string());
    }

    Ok(Some(display_accelerator(shortcut)))
}

fn replace_registered_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    state: &ShowHideShortcutState,
    accelerator: Option<String>,
) -> ShowHideShortcutSetting {
    let previously_registered = {
        let mut inner = state.inner.lock().unwrap();
        inner.last_error = None;
        inner.registered_accelerator.take()
    };

    if let Some(previously_registered) = previously_registered
        && let Err(err) = app
            .global_shortcut()
            .unregister(previously_registered.as_str())
    {
        eprintln!("qmux: failed to unregister previous show/hide shortcut: {err}");
    }

    let Some(accelerator) = accelerator else {
        return state.status(None);
    };

    match app.global_shortcut().register(accelerator.as_str()) {
        Ok(()) => {
            state.inner.lock().unwrap().registered_accelerator = Some(accelerator.clone());
        }
        Err(err) => {
            state.inner.lock().unwrap().last_error = Some(format!("{err}"));
        }
    }

    state.status(Some(accelerator))
}

pub fn toggle_qmux_visibility<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let should_hide = window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && window.is_focused().unwrap_or(false);

    if should_hide {
        hide_qmux_window(app)?;
    } else {
        show_qmux_window(app)?;
    }

    Ok(())
}

pub fn show_qmux_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    app.show()?;
    window.show()?;
    window.unminimize()?;
    window.set_focus()?;
    Ok(())
}

pub fn hide_qmux_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.hide()
}

fn display_accelerator(shortcut: Shortcut) -> String {
    let mut parts = Vec::new();
    if shortcut.mods.contains(Modifiers::CONTROL) {
        parts.push("Control".to_string());
    }
    if shortcut.mods.contains(Modifiers::ALT) {
        parts.push("Option".to_string());
    }
    if shortcut.mods.contains(Modifiers::SHIFT) {
        parts.push("Shift".to_string());
    }
    if shortcut.mods.contains(Modifiers::SUPER) {
        parts.push("Command".to_string());
    }
    parts.push(display_key(shortcut.key));
    parts.join("+")
}

fn display_key(key: Code) -> String {
    use Code::*;
    match key {
        KeyA => "A",
        KeyB => "B",
        KeyC => "C",
        KeyD => "D",
        KeyE => "E",
        KeyF => "F",
        KeyG => "G",
        KeyH => "H",
        KeyI => "I",
        KeyJ => "J",
        KeyK => "K",
        KeyL => "L",
        KeyM => "M",
        KeyN => "N",
        KeyO => "O",
        KeyP => "P",
        KeyQ => "Q",
        KeyR => "R",
        KeyS => "S",
        KeyT => "T",
        KeyU => "U",
        KeyV => "V",
        KeyW => "W",
        KeyX => "X",
        KeyY => "Y",
        KeyZ => "Z",
        Digit0 => "0",
        Digit1 => "1",
        Digit2 => "2",
        Digit3 => "3",
        Digit4 => "4",
        Digit5 => "5",
        Digit6 => "6",
        Digit7 => "7",
        Digit8 => "8",
        Digit9 => "9",
        Space => "Space",
        Enter => "Enter",
        Tab => "Tab",
        Escape => "Escape",
        Backspace => "Backspace",
        Delete => "Delete",
        ArrowUp => "Up",
        ArrowDown => "Down",
        ArrowLeft => "Left",
        ArrowRight => "Right",
        Minus => "-",
        Equal => "=",
        BracketLeft => "[",
        BracketRight => "]",
        Backslash => "\\",
        Semicolon => ";",
        Quote => "'",
        Comma => ",",
        Period => ".",
        Slash => "/",
        Backquote => "`",
        Home => "Home",
        End => "End",
        PageUp => "PageUp",
        PageDown => "PageDown",
        Insert => "Insert",
        CapsLock => "CapsLock",
        PrintScreen => "PrintScreen",
        ScrollLock => "ScrollLock",
        Pause => "Pause",
        NumLock => "NumLock",
        Numpad0 => "Numpad0",
        Numpad1 => "Numpad1",
        Numpad2 => "Numpad2",
        Numpad3 => "Numpad3",
        Numpad4 => "Numpad4",
        Numpad5 => "Numpad5",
        Numpad6 => "Numpad6",
        Numpad7 => "Numpad7",
        Numpad8 => "Numpad8",
        Numpad9 => "Numpad9",
        NumpadAdd => "NumpadAdd",
        NumpadDecimal => "NumpadDecimal",
        NumpadDivide => "NumpadDivide",
        NumpadEnter => "NumpadEnter",
        NumpadEqual => "NumpadEqual",
        NumpadMultiply => "NumpadMultiply",
        NumpadSubtract => "NumpadSubtract",
        F1 => "F1",
        F2 => "F2",
        F3 => "F3",
        F4 => "F4",
        F5 => "F5",
        F6 => "F6",
        F7 => "F7",
        F8 => "F8",
        F9 => "F9",
        F10 => "F10",
        F11 => "F11",
        F12 => "F12",
        F13 => "F13",
        F14 => "F14",
        F15 => "F15",
        F16 => "F16",
        F17 => "F17",
        F18 => "F18",
        F19 => "F19",
        F20 => "F20",
        F21 => "F21",
        F22 => "F22",
        F23 => "F23",
        F24 => "F24",
        AudioVolumeDown => "VolumeDown",
        AudioVolumeUp => "VolumeUp",
        AudioVolumeMute => "VolumeMute",
        MediaPlay => "MediaPlay",
        MediaPause => "MediaPause",
        MediaPlayPause => "MediaPlayPause",
        MediaStop => "MediaStop",
        MediaTrackNext => "MediaTrackNext",
        MediaTrackPrevious => "MediaTrackPrevious",
        _ => return key.to_string(),
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_shortcut_is_none() {
        assert_eq!(normalize_accelerator(None).unwrap(), None);
        assert_eq!(normalize_accelerator(Some("  ".to_string())).unwrap(), None);
    }

    #[test]
    fn shortcut_display_uses_macos_names() {
        assert_eq!(
            normalize_accelerator(Some("Alt + Space".to_string())).unwrap(),
            Some("Option+Space".to_string())
        );
        assert_eq!(
            normalize_accelerator(Some("Command+Shift+A".to_string())).unwrap(),
            Some("Shift+Command+A".to_string())
        );
    }

    #[test]
    fn shortcut_requires_modifier() {
        assert!(normalize_accelerator(Some("Space".to_string())).is_err());
    }
}
