use serde::Deserialize;
use std::sync::{Mutex, OnceLock};

use crate::events::QmuxEvent;
use crate::state::AppState;

static APP_STATE: OnceLock<Mutex<Option<AppState>>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalLayout {
    pub pane_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
    pub focused: bool,
    pub accepts_pointer_input: bool,
    pub accepts_keyboard_input: bool,
    pub defer_geometry: bool,
}

/// A DOM rectangle that keeps pointer events routed to the webview even where
/// it overlaps a native terminal surface (floating controls drawn over the
/// terminal). `visible: false` removes the region.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWebOverlayRegion {
    pub region_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalSettings {
    pub pane_id: String,
    pub font_size: f64,
    pub font_family: String,
    pub letter_spacing: f64,
    pub line_height: f64,
    pub cursor_blink: bool,
    pub cursor_style: String,
    pub scrollback_rows: u32,
    pub scroll_on_user_input: bool,
    pub scroll_sensitivity: f64,
    pub copy_on_select: bool,
    pub selection_clear_on_copy: bool,
    pub theme_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppShortcutCommand {
    FontZoomIn,
    FontZoomOut,
    FontZoomReset,
    FocusTab(u8),
    HomeOrCycleAdapter,
    FocusHome,
    FocusResearchMode,
    ToggleSidebarMode,
    CyclePaneTab(i8),
    CycleAllTab(i8),
    OpenSettings,
    ToggleTranscriptOrBrowser,
    SplitPaneBelow,
    RestoreClosedPane,
    ClosePane,
    NewGroup,
    NewPane,
}

impl AppShortcutCommand {
    fn event_fields(self) -> (&'static str, Option<u8>) {
        match self {
            Self::FontZoomIn => ("fontZoomIn", None),
            Self::FontZoomOut => ("fontZoomOut", None),
            Self::FontZoomReset => ("fontZoomReset", None),
            Self::FocusTab(index) => ("focusTab", Some(index)),
            Self::HomeOrCycleAdapter => ("homeOrCycleAdapter", None),
            Self::FocusHome => ("focusHome", None),
            Self::FocusResearchMode => ("focusResearchMode", None),
            Self::ToggleSidebarMode => ("toggleSidebarMode", None),
            Self::CyclePaneTab(-1) => ("cyclePaneTabPrevious", None),
            Self::CyclePaneTab(_) => ("cyclePaneTabNext", None),
            Self::CycleAllTab(-1) => ("cycleAllTabPrevious", None),
            Self::CycleAllTab(_) => ("cycleAllTabNext", None),
            Self::OpenSettings => ("openSettings", None),
            Self::ToggleTranscriptOrBrowser => ("toggleTranscriptOrBrowser", None),
            Self::SplitPaneBelow => ("splitPaneBelow", None),
            Self::RestoreClosedPane => ("restoreClosedPane", None),
            Self::ClosePane => ("closePane", None),
            Self::NewGroup => ("newGroup", None),
            Self::NewPane => ("newPane", None),
        }
    }
}

fn classify_app_shortcut(
    key: &str,
    shift: bool,
    control: bool,
    option: bool,
    command: bool,
) -> Option<AppShortcutCommand> {
    let normalized_key = key.to_lowercase();
    let key = match normalized_key.as_str() {
        "{" => "[",
        "}" => "]",
        other => other,
    };
    let one_primary_modifier = command != control;

    if command && !control && !option {
        if key == "+" || key == "=" {
            return Some(AppShortcutCommand::FontZoomIn);
        }
        if key == "-" && !shift {
            return Some(AppShortcutCommand::FontZoomOut);
        }
        if key == "0" && !shift {
            return Some(AppShortcutCommand::FontZoomReset);
        }
    }

    if one_primary_modifier && !option && !shift && key.len() == 1 {
        let digit = key.as_bytes()[0];
        if (b'1'..=b'9').contains(&digit) {
            return Some(AppShortcutCommand::FocusTab(digit - b'1'));
        }
    }
    if command && !control && !option && !shift && key == "n" {
        return Some(AppShortcutCommand::HomeOrCycleAdapter);
    }
    if command && !control && !option && shift && key == "h" {
        return Some(AppShortcutCommand::FocusHome);
    }
    if command && !control && !option && shift && key == "r" {
        return Some(AppShortcutCommand::FocusResearchMode);
    }
    if command && !control && !option && !shift && key == "`" {
        return Some(AppShortcutCommand::ToggleSidebarMode);
    }
    if !command && control && !option && key == "tab" {
        return Some(AppShortcutCommand::CyclePaneTab(if shift { -1 } else { 1 }));
    }
    if command && !control && !option && shift && (key == "[" || key == "]") {
        return Some(AppShortcutCommand::CycleAllTab(if key == "[" {
            -1
        } else {
            1
        }));
    }
    if one_primary_modifier && !option && !shift && key == "," {
        return Some(AppShortcutCommand::OpenSettings);
    }
    // ⌘K is deliberately NOT classified here: with a terminal focused it stays
    // native (clear screen). The command palette binds it only for web targets,
    // in appShortcuts.ts.
    if one_primary_modifier && !option && shift && key == "e" {
        return Some(AppShortcutCommand::ToggleTranscriptOrBrowser);
    }
    if command && !control && !option && key == "d" {
        return Some(AppShortcutCommand::SplitPaneBelow);
    }
    if command && !control && !option && shift && key == "t" {
        return Some(AppShortcutCommand::RestoreClosedPane);
    }
    if command && !control && !option && shift && key == "n" {
        return Some(AppShortcutCommand::NewGroup);
    }
    if command && !control && !option && !shift && key == "w" {
        return Some(AppShortcutCommand::ClosePane);
    }
    if command && !control && !option && !shift && key == "t" {
        return Some(AppShortcutCommand::NewPane);
    }

    None
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
mod imp {
    use super::APP_STATE;
    use super::NativeTerminalLayout;
    use super::NativeTerminalSettings;
    use super::NativeWebOverlayRegion;
    use crate::state::AppState;
    use std::ffi::{CString, c_char, c_void};
    use std::sync::Mutex;

    unsafe extern "C" {
        fn qmux_native_terminal_bridge_available() -> i32;
        fn qmux_native_terminal_initialize(native_view: *mut c_void) -> i32;
        fn qmux_native_terminal_create(
            pane_id: *const c_char,
            launcher_path: *const c_char,
            working_directory: *const c_char,
        ) -> i32;
        fn qmux_native_terminal_remove(pane_id: *const c_char);
        fn qmux_native_terminal_terminate(pane_id: *const c_char) -> i32;
        fn qmux_native_terminal_set_stage_backstop(x: f64, y: f64, width: f64, height: f64) -> i32;
        fn qmux_native_terminal_set_layout(
            pane_id: *const c_char,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            visible: i32,
            focused: i32,
            accepts_pointer_input: i32,
            accepts_keyboard_input: i32,
            defer_geometry: i32,
        ) -> i32;
        fn qmux_native_terminal_set_web_pointer_claimed(claimed: i32) -> i32;
        fn qmux_native_terminal_set_web_overlay_region(
            region_id: *const c_char,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            visible: i32,
        ) -> i32;
        fn qmux_native_terminal_focus(pane_id: *const c_char) -> i32;
        fn qmux_native_terminal_send_text(pane_id: *const c_char, text: *const c_char) -> i32;
        fn qmux_native_terminal_submit(pane_id: *const c_char) -> i32;
        fn qmux_native_terminal_paste_approved_text(
            pane_id: *const c_char,
            text: *const u8,
            text_len: usize,
        ) -> i32;
        fn qmux_native_terminal_action(pane_id: *const c_char, action: *const c_char) -> i32;
        fn qmux_native_terminal_update_settings(
            pane_id: *const c_char,
            font_size: f64,
            font_family: *const c_char,
            letter_spacing: f64,
            line_height: f64,
            cursor_blink: i32,
            cursor_style: *const c_char,
            scrollback_rows: u32,
            scroll_on_user_input: i32,
            scroll_sensitivity: f64,
            copy_on_select: i32,
            selection_clear_on_copy: i32,
            theme_name: *const c_char,
        ) -> i32;
        fn qmux_native_terminal_theme_catalog() -> *const c_char;
        fn qmux_native_terminal_shutdown();
    }

    fn cstring(value: &str, label: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| format!("{label} contains an interior NUL byte"))
    }

    pub fn available() -> bool {
        // SAFETY: the function has no arguments or borrowed state and is linked
        // from the pinned QmuxNativeTerminal Swift package in build.rs.
        unsafe { qmux_native_terminal_bridge_available() == 1 }
    }

    pub fn initialize(native_view: *mut c_void, state: AppState) -> Result<(), String> {
        if native_view.is_null() {
            return Err("Tauri returned a null native content view".to_string());
        }
        // SAFETY: Tauri owns this NSView for the duration of the application and
        // Swift retains only a weak reference to its window plus a child view.
        if unsafe { qmux_native_terminal_initialize(native_view) } == 1 {
            let state_slot = APP_STATE.get_or_init(|| Mutex::new(None));
            *state_slot
                .lock()
                .map_err(|_| "native terminal state lock poisoned".to_string())? = Some(state);
            Ok(())
        } else {
            Err("failed to attach the native terminal host beneath WKWebView".to_string())
        }
    }

    pub fn create(
        pane_id: &str,
        launcher_path: &str,
        working_directory: Option<&str>,
    ) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        let launcher_path = cstring(launcher_path, "launcher path")?;
        let working_directory = working_directory
            .map(|value| cstring(value, "working directory"))
            .transpose()?;
        let working_directory_ptr = working_directory
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr());
        // SAFETY: Swift copies both strings synchronously before returning.
        if unsafe {
            qmux_native_terminal_create(
                pane_id.as_ptr(),
                launcher_path.as_ptr(),
                working_directory_ptr,
            )
        } == 1
        {
            Ok(())
        } else {
            Err("failed to create the native terminal surface".to_string())
        }
    }

    pub fn remove(pane_id: &str) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        // SAFETY: Swift copies the string synchronously before returning.
        unsafe { qmux_native_terminal_remove(pane_id.as_ptr()) };
        Ok(())
    }

    pub fn terminate(pane_id: &str) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        // SAFETY: Swift copies the string and invokes Ghostty's close binding
        // synchronously on the main actor.
        if unsafe { qmux_native_terminal_terminate(pane_id.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("native terminal pane was not found".to_string())
        }
    }

    /// Positions the opaque terminal-colored backstop under the webview's
    /// terminal stage. Pane surfaces chase their DOM rects asynchronously, so
    /// the backstop is what shows through transient gaps (pane spawn,
    /// Home→pane switches, split-resize lag) instead of the window's vibrancy
    /// material.
    pub fn set_stage_backstop(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
        if !x.is_finite()
            || !y.is_finite()
            || !width.is_finite()
            || !height.is_finite()
            || width < 0.0
            || height < 0.0
        {
            return Err("native terminal backstop has invalid geometry".to_string());
        }
        // SAFETY: scalar arguments are copied synchronously on the main actor.
        if unsafe { qmux_native_terminal_set_stage_backstop(x, y, width, height) } == 1 {
            Ok(())
        } else {
            Err("native terminal host is not attached".to_string())
        }
    }

    pub fn set_layout(layout: NativeTerminalLayout) -> Result<(), String> {
        if !layout.x.is_finite()
            || !layout.y.is_finite()
            || !layout.width.is_finite()
            || !layout.height.is_finite()
            || layout.width < 0.0
            || layout.height < 0.0
        {
            return Err("native terminal layout contains invalid geometry".to_string());
        }
        let pane_id = cstring(&layout.pane_id, "pane id")?;
        // SAFETY: Swift copies the string and scalar layout synchronously.
        let success = unsafe {
            qmux_native_terminal_set_layout(
                pane_id.as_ptr(),
                layout.x,
                layout.y,
                layout.width,
                layout.height,
                i32::from(layout.visible),
                i32::from(layout.focused),
                i32::from(layout.accepts_pointer_input),
                i32::from(layout.accepts_keyboard_input),
                i32::from(layout.defer_geometry),
            )
        };
        if success == 1 {
            Ok(())
        } else {
            Err(format!(
                "native terminal pane {} was not found",
                layout.pane_id
            ))
        }
    }

    pub fn set_web_pointer_claimed(claimed: bool) -> Result<(), String> {
        // SAFETY: the scalar is copied synchronously on the main actor.
        if unsafe { qmux_native_terminal_set_web_pointer_claimed(i32::from(claimed)) } == 1 {
            Ok(())
        } else {
            Err("native terminal host is not attached".to_string())
        }
    }

    pub fn set_web_overlay_region(region: NativeWebOverlayRegion) -> Result<(), String> {
        if !region.x.is_finite()
            || !region.y.is_finite()
            || !region.width.is_finite()
            || !region.height.is_finite()
            || region.width < 0.0
            || region.height < 0.0
        {
            return Err("native web overlay region has invalid geometry".to_string());
        }
        let region_id = cstring(&region.region_id, "region id")?;
        // SAFETY: Swift copies the string and scalars synchronously.
        if unsafe {
            qmux_native_terminal_set_web_overlay_region(
                region_id.as_ptr(),
                region.x,
                region.y,
                region.width,
                region.height,
                i32::from(region.visible),
            )
        } == 1
        {
            Ok(())
        } else {
            Err("native terminal host is not attached".to_string())
        }
    }

    pub fn focus(pane_id: &str) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        // SAFETY: Swift copies the string synchronously before returning.
        if unsafe { qmux_native_terminal_focus(pane_id.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("native terminal pane is unavailable or hidden".to_string())
        }
    }

    pub fn send_text(pane_id: &str, text: &str) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        let text = cstring(text, "terminal input")?;
        // SAFETY: Swift copies both strings synchronously before returning.
        if unsafe { qmux_native_terminal_send_text(pane_id.as_ptr(), text.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("native terminal pane was not found or its surface is not ready".to_string())
        }
    }

    pub fn submit(pane_id: &str) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        // SAFETY: Swift copies the string and dispatches a synthetic Return key
        // press/release synchronously on the main actor.
        if unsafe { qmux_native_terminal_submit(pane_id.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("native terminal pane was not found, not ready, or rejected submit".to_string())
        }
    }

    pub fn paste_approved_text(pane_id: &str, text: &str) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        // SAFETY: Swift copies the UTF-8 bytes synchronously before returning.
        if unsafe {
            qmux_native_terminal_paste_approved_text(
                pane_id.as_ptr(),
                text.as_bytes().as_ptr(),
                text.len(),
            )
        } == 1
        {
            Ok(())
        } else {
            Err("native terminal pane was not found or rejected the paste".to_string())
        }
    }

    pub fn action(pane_id: &str, action: &str) -> Result<(), String> {
        let pane_id = cstring(pane_id, "pane id")?;
        let action = cstring(action, "terminal action")?;
        // SAFETY: Swift copies both strings synchronously before returning.
        if unsafe { qmux_native_terminal_action(pane_id.as_ptr(), action.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("native terminal action was not performed".to_string())
        }
    }

    pub fn update_settings(settings: NativeTerminalSettings) -> Result<(), String> {
        if !settings.font_size.is_finite()
            || settings.font_size <= 0.0
            || !settings.letter_spacing.is_finite()
            || !settings.line_height.is_finite()
            || settings.line_height <= 0.0
            || !settings.scroll_sensitivity.is_finite()
            || settings.scroll_sensitivity <= 0.0
        {
            return Err("native terminal settings contain invalid numeric values".to_string());
        }
        let pane_id = cstring(&settings.pane_id, "pane id")?;
        let font_family = cstring(&settings.font_family, "font family")?;
        let cursor_style = cstring(&settings.cursor_style, "cursor style")?;
        let theme_name = cstring(&settings.theme_name, "theme name")?;
        // SAFETY: Swift copies strings and scalar settings synchronously.
        if unsafe {
            qmux_native_terminal_update_settings(
                pane_id.as_ptr(),
                settings.font_size,
                font_family.as_ptr(),
                settings.letter_spacing,
                settings.line_height,
                i32::from(settings.cursor_blink),
                cursor_style.as_ptr(),
                settings.scrollback_rows,
                i32::from(settings.scroll_on_user_input),
                settings.scroll_sensitivity,
                i32::from(settings.copy_on_select),
                i32::from(settings.selection_clear_on_copy),
                theme_name.as_ptr(),
            )
        } == 1
        {
            Ok(())
        } else {
            Err("native terminal pane was not found or rejected its settings".to_string())
        }
    }

    /// Returns the theme catalog as JSON: the qmux default plus every bundled
    /// Ghostty color scheme, with the colors the settings UI needs for
    /// previews.
    pub fn theme_catalog() -> Result<String, String> {
        // SAFETY: Swift returns a pointer to a process-lifetime JSON buffer
        // (or null if encoding failed); the bytes are copied before returning.
        let catalog = unsafe { qmux_native_terminal_theme_catalog() };
        if catalog.is_null() {
            return Err("native terminal theme catalog is unavailable".to_string());
        }
        // SAFETY: the pointer is non-null, NUL-terminated, and never freed.
        unsafe { std::ffi::CStr::from_ptr(catalog) }
            .to_str()
            .map(ToString::to_string)
            .map_err(|_| "native terminal theme catalog is not valid UTF-8".to_string())
    }

    pub fn shutdown() {
        // SAFETY: shutdown is idempotent and synchronously tears down Swift-owned
        // views on the main thread.
        unsafe { qmux_native_terminal_shutdown() };
        if let Some(state) = APP_STATE.get()
            && let Ok(mut state) = state.lock()
        {
            *state = None;
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
mod imp {
    use super::NativeTerminalLayout;
    use super::NativeTerminalSettings;
    use super::NativeWebOverlayRegion;
    use crate::state::AppState;
    use std::ffi::c_void;

    pub fn available() -> bool {
        false
    }

    pub fn initialize(_native_view: *mut c_void, _state: AppState) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn create(
        _pane_id: &str,
        _launcher_path: &str,
        _working_directory: Option<&str>,
    ) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn remove(_pane_id: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn terminate(_pane_id: &str) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn set_stage_backstop(_x: f64, _y: f64, _width: f64, _height: f64) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn set_layout(_layout: NativeTerminalLayout) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn set_web_pointer_claimed(_claimed: bool) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn set_web_overlay_region(_region: NativeWebOverlayRegion) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn focus(_pane_id: &str) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn send_text(_pane_id: &str, _text: &str) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn submit(_pane_id: &str) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn paste_approved_text(_pane_id: &str, _text: &str) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn action(_pane_id: &str, _action: &str) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn update_settings(_settings: NativeTerminalSettings) -> Result<(), String> {
        Err("native terminals are only available on macOS".to_string())
    }

    pub fn theme_catalog() -> Result<String, String> {
        // No native themes off macOS; the settings UI treats an empty catalog
        // as "only the built-in default is available".
        Ok("[]".to_string())
    }

    pub fn shutdown() {}
}

#[allow(unused_imports)]
pub use imp::{
    action, available, create, focus, initialize, paste_approved_text, remove, send_text,
    set_layout, set_stage_backstop, set_web_overlay_region, set_web_pointer_claimed, shutdown,
    submit, terminate, update_settings,
};

fn with_app_state(operation: impl FnOnce(&AppState)) {
    let Some(slot) = APP_STATE.get() else { return };
    let Ok(state) = slot.lock() else { return };
    let Some(state) = state.as_ref() else { return };
    operation(state);
}

fn callback_string(pointer: *const std::ffi::c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    // SAFETY: Swift supplies a valid, NUL-terminated UTF-8 string for the
    // synchronous duration of each callback.
    unsafe { std::ffi::CStr::from_ptr(pointer) }
        .to_str()
        .ok()
        .map(ToString::to_string)
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_close(
    pane_id: *const std::ffi::c_char,
    process_alive: i32,
) {
    let Some(pane_id) = callback_string(pane_id) else {
        return;
    };
    with_app_state(|state| {
        // This delegate fires on the main thread, but the close handler walks
        // the pane's process tree (a `ps` fork), captures the pane (model lock
        // + scrollback read), and drains waiter queues — and a queue drain
        // submits turns, which takes pane send locks the main thread must
        // never contend for (see write_pane). Hand the whole sequence to a
        // worker; the handler's closing-set and pane-registration checks make
        // a deferred or duplicate delivery a no-op.
        let state = state.clone();
        std::thread::spawn(move || {
            crate::pty::native_pane_did_close(&state, &pane_id, process_alive == 1);
        });
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_change_title(
    pane_id: *const std::ffi::c_char,
    title: *const std::ffi::c_char,
) {
    let (Some(pane_id), Some(title)) = (callback_string(pane_id), callback_string(title)) else {
        return;
    };
    with_app_state(|state| {
        state.emit(QmuxEvent::new(
            "terminal.title_changed",
            Some(pane_id),
            None,
            serde_json::json!({ "title": title }),
        ));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_change_cwd(
    pane_id: *const std::ffi::c_char,
    cwd: *const std::ffi::c_char,
) {
    let (Some(pane_id), Some(cwd)) = (callback_string(pane_id), callback_string(cwd)) else {
        return;
    };
    with_app_state(|state| {
        if let Err(err) = state.update_pane_cwd(&pane_id, cwd) {
            eprintln!("qmux: rejected native cwd update for pane {pane_id}: {err}");
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_resize(
    pane_id: *const std::ffi::c_char,
    columns: i32,
    rows: i32,
) {
    let Some(pane_id) = callback_string(pane_id) else {
        return;
    };
    let (Ok(columns), Ok(rows)) = (u16::try_from(columns), u16::try_from(rows)) else {
        return;
    };
    if columns == 0 || rows == 0 {
        return;
    }
    with_app_state(|state| {
        if let Err(err) = state.update_pane_size(&pane_id, columns, rows) {
            eprintln!("qmux: failed to persist native size for pane {pane_id}: {err}");
        }
    });
}

fn emit_native_event(event_type: &str, pane_id: *const std::ffi::c_char) {
    let Some(pane_id) = callback_string(pane_id) else {
        return;
    };
    with_app_state(|state| {
        state.emit(QmuxEvent::new(
            event_type,
            Some(pane_id),
            None,
            serde_json::json!({}),
        ));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_request_search(pane_id: *const std::ffi::c_char) {
    emit_native_event("terminal.search_requested", pane_id);
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_request_paste(
    pane_id: *const std::ffi::c_char,
    text: *const std::ffi::c_char,
) {
    let (Some(pane_id), Some(text)) = (callback_string(pane_id), callback_string(text)) else {
        return;
    };
    with_app_state(|state| {
        state.emit(QmuxEvent::new(
            "terminal.paste_requested",
            Some(pane_id),
            None,
            serde_json::json!({ "text": text }),
        ));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_receive_user_input(pane_id: *const std::ffi::c_char) {
    emit_native_event("terminal.user_input", pane_id);
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_receive_escape(pane_id: *const std::ffi::c_char) {
    let Some(pane_id) = callback_string(pane_id) else {
        return;
    };
    with_app_state(|state| crate::workspace::watch_agent_after_escape(state, &pane_id));
}

/// A possible application shortcut typed while a native pane owned the
/// keyboard. Only exact qmux commands are consumed; every unrecognized chord
/// returns to AppKit/Ghostty unchanged.
#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_receive_shortcut(
    pane_id: *const std::ffi::c_char,
    key: *const std::ffi::c_char,
    shift: i32,
    control: i32,
    option: i32,
    command: i32,
    repeat: i32,
) -> i32 {
    let (Some(pane_id), Some(key)) = (callback_string(pane_id), callback_string(key)) else {
        return 0;
    };
    let Some(shortcut) =
        classify_app_shortcut(&key, shift == 1, control == 1, option == 1, command == 1)
    else {
        return 0;
    };
    let (command, tab_index) = shortcut.event_fields();
    let mut emitted = false;
    with_app_state(|state| {
        state.emit(QmuxEvent::new(
            "terminal.shortcut",
            Some(pane_id),
            None,
            serde_json::json!({
                "command": command,
                "tabIndex": tab_index,
                "repeat": repeat == 1,
            }),
        ));
        emitted = true;
    });
    i32::from(emitted)
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_change_command_modifier(
    pane_id: *const std::ffi::c_char,
    active: i32,
) {
    let Some(pane_id) = callback_string(pane_id) else {
        return;
    };
    with_app_state(|state| {
        state.emit(QmuxEvent::new(
            "terminal.command_modifier_changed",
            Some(pane_id),
            None,
            serde_json::json!({ "active": active == 1 }),
        ));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_activate(pane_id: *const std::ffi::c_char) {
    emit_native_event("terminal.activated", pane_id);
}

#[unsafe(no_mangle)]
pub extern "C" fn qmux_native_terminal_did_open_url(
    pane_id: *const std::ffi::c_char,
    url: *const std::ffi::c_char,
) {
    let (Some(pane_id), Some(url)) = (callback_string(pane_id), callback_string(url)) else {
        return;
    };
    with_app_state(|state| {
        state.emit(QmuxEvent::new(
            "terminal.open_url",
            Some(pane_id),
            None,
            serde_json::json!({ "url": url }),
        ));
    });
}

#[tauri::command]
pub fn native_terminal_set_layout(layout: NativeTerminalLayout) -> Result<(), String> {
    set_layout(layout)
}

#[tauri::command]
pub fn native_terminal_set_web_pointer_claimed(claimed: bool) -> Result<(), String> {
    set_web_pointer_claimed(claimed)
}

#[tauri::command]
pub fn native_terminal_set_web_overlay_region(region: NativeWebOverlayRegion) -> Result<(), String> {
    set_web_overlay_region(region)
}

#[tauri::command]
pub fn native_terminal_set_stage_backstop(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    set_stage_backstop(x, y, width, height)
}

#[tauri::command]
pub fn native_terminal_focus(pane_id: String) -> Result<(), String> {
    focus(&pane_id)
}

#[tauri::command]
pub fn native_terminal_action(pane_id: String, action: String) -> Result<(), String> {
    imp::action(&pane_id, &action)
}

#[tauri::command]
pub fn native_terminal_paste_approved_text(pane_id: String, text: String) -> Result<(), String> {
    // The paste boundary must stay unforgeable here just like on the pane_write
    // path: Ghostty frames these bytes in bracketed-paste markers, and the qmux
    // approval dialog this text passed through suppresses Ghostty's own
    // unsafe-paste prompt — so an embedded end marker would terminate the paste
    // early and hand the remainder to the shell as typed input.
    let text = crate::pty::strip_bracketed_paste_markers(&text);
    imp::paste_approved_text(&pane_id, &text)
}

#[tauri::command]
pub fn native_terminal_update_settings(settings: NativeTerminalSettings) -> Result<(), String> {
    imp::update_settings(settings)
}

#[tauri::command]
pub fn native_terminal_theme_catalog() -> Result<String, String> {
    imp::theme_catalog()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn swift_ghostty_bridge_is_linked() {
        assert!(super::available());
    }

    #[test]
    fn rejects_invalid_layout_geometry_before_ffi() {
        let result = super::set_layout(super::NativeTerminalLayout {
            pane_id: "pane-1".to_string(),
            x: f64::NAN,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            visible: true,
            focused: true,
            accepts_pointer_input: true,
            accepts_keyboard_input: true,
            defer_geometry: false,
        });
        assert_eq!(
            result.unwrap_err(),
            "native terminal layout contains invalid geometry"
        );
    }

    #[test]
    fn rejects_invalid_backstop_geometry_before_ffi() {
        let result = super::set_stage_backstop(0.0, 0.0, -1.0, 100.0);
        assert_eq!(
            result.unwrap_err(),
            "native terminal backstop has invalid geometry"
        );
    }

    #[test]
    fn native_shortcut_classifier_only_claims_qmux_commands() {
        use super::AppShortcutCommand;

        assert_eq!(
            super::classify_app_shortcut("t", false, false, false, true),
            Some(AppShortcutCommand::NewPane)
        );
        assert_eq!(
            super::classify_app_shortcut("n", true, false, false, true),
            Some(AppShortcutCommand::NewGroup)
        );
        assert_eq!(
            super::classify_app_shortcut("Tab", true, true, false, false),
            Some(AppShortcutCommand::CyclePaneTab(-1))
        );
        assert_eq!(
            super::classify_app_shortcut("4", false, true, false, false),
            Some(AppShortcutCommand::FocusTab(3))
        );
        assert_eq!(
            super::classify_app_shortcut("r", true, false, false, true),
            Some(AppShortcutCommand::FocusResearchMode)
        );
        assert_eq!(
            super::classify_app_shortcut("`", false, false, false, true),
            Some(AppShortcutCommand::ToggleSidebarMode)
        );
        for key in [";", "k", "a", "z", "Enter"] {
            assert_eq!(
                super::classify_app_shortcut(key, false, false, false, true),
                None,
                "command-{key} must remain native"
            );
        }
        assert_eq!(
            super::classify_app_shortcut("w", false, true, false, false),
            None,
            "control-w belongs to a focused terminal"
        );
    }
}
