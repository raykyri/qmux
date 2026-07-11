use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

const TRAY_ID: &str = "qmux-menu-bar";
const SHOW_WINDOW_ID: &str = "qmux-menu-bar-show-window";
const HIDE_WINDOW_ID: &str = "qmux-menu-bar-hide-window";
const SELECT_PANE_PREFIX: &str = "qmux-menu-bar-select-pane:";
const SELECT_PANE_EVENT: &str = "menu-bar-select-pane";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarSnapshot {
    pub groups: Vec<MenuBarGroup>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarGroup {
    pub id: String,
    pub label: String,
    pub tabs: Vec<MenuBarTab>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarTab {
    pub pane_id: String,
    pub title: String,
    pub path: Option<String>,
    #[serde(default)]
    pub depth: u16,
    #[serde(default = "default_status_tone")]
    pub status_tone: String,
    pub status_label: Option<String>,
    #[serde(default)]
    pub waiting_on_pane: bool,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectPanePayload {
    pane_id: String,
}

fn default_status_tone() -> String {
    "idle".to_string()
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::tray::TrayIconBuilder;

        let menu = build_menu(app, None)?;
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(bento_icon())
            .icon_as_template(true)
            .tooltip("qmux")
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(handle_menu_event)
            .build(app)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }

    Ok(())
}

#[tauri::command]
pub fn menu_bar_update<R: Runtime>(
    app: AppHandle<R>,
    snapshot: MenuBarSnapshot,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        update_menu(&app, &snapshot).map_err(|err| err.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = snapshot;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn update_menu<R: Runtime>(app: &AppHandle<R>, snapshot: &MenuBarSnapshot) -> tauri::Result<()> {
    let menu = build_menu(app, Some(snapshot))?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: Option<&MenuBarSnapshot>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{IconMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu};

    let menu = Menu::new(app)?;
    let show = MenuItemBuilder::with_id(SHOW_WINDOW_ID, "Show Window").build(app)?;
    let hide = MenuItemBuilder::with_id(HIDE_WINDOW_ID, "Hide Window").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    menu.append(&show)?;
    menu.append(&hide)?;
    menu.append(&separator)?;

    let Some(snapshot) = snapshot else {
        let empty = MenuItemBuilder::new("No tabs").enabled(false).build(app)?;
        menu.append(&empty)?;
        return Ok(menu);
    };

    let mut tab_count = 0usize;
    for group in &snapshot.groups {
        let group_label = sanitize_menu_text(&group.label, 88)
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| "Group".to_string());
        let group_menu = Submenu::with_id(
            app,
            format!("qmux-menu-bar-group:{}", group.id),
            group_label,
            true,
        )?;

        if group.tabs.is_empty() {
            let empty = MenuItemBuilder::new("No tabs").enabled(false).build(app)?;
            group_menu.append(&empty)?;
        } else {
            for tab in &group.tabs {
                tab_count += 1;
                let item = IconMenuItemBuilder::with_id(
                    format!("{SELECT_PANE_PREFIX}{}", tab.pane_id),
                    tab_menu_label(tab),
                )
                .icon(status_icon(&tab.status_tone, tab.waiting_on_pane))
                .build(app)?;
                group_menu.append(&item)?;
            }
        }

        menu.append(&group_menu)?;
    }

    if tab_count == 0 {
        let empty = MenuItemBuilder::new("No active tabs")
            .enabled(false)
            .build(app)?;
        menu.append(&empty)?;
    }

    Ok(menu)
}

#[cfg(target_os = "macos")]
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        SHOW_WINDOW_ID => {
            if let Err(err) = crate::show_hide_shortcut::show_qmux_window(app) {
                eprintln!("qmux: failed to show app from menu bar: {err}");
            }
        }
        HIDE_WINDOW_ID => {
            if let Err(err) = crate::show_hide_shortcut::hide_qmux_window(app) {
                eprintln!("qmux: failed to hide app from menu bar: {err}");
            }
        }
        id => {
            if let Some(pane_id) = id.strip_prefix(SELECT_PANE_PREFIX) {
                if let Err(err) = crate::show_hide_shortcut::show_qmux_window(app) {
                    eprintln!("qmux: failed to show app from menu bar tab selection: {err}");
                }
                if let Err(err) = app.emit(
                    SELECT_PANE_EVENT,
                    SelectPanePayload {
                        pane_id: pane_id.to_string(),
                    },
                ) {
                    eprintln!("qmux: failed to emit menu bar tab selection: {err}");
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn tab_menu_label(tab: &MenuBarTab) -> String {
    let mut label = String::new();
    if tab.selected {
        label.push_str("* ");
    }
    label.push_str(&"  ".repeat(tab.depth.min(8) as usize));
    label.push_str(
        &sanitize_menu_text(&tab.title, 96)
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "Untitled".to_string()),
    );

    if let Some(path) = sanitize_menu_text(tab.path.as_deref().unwrap_or_default(), 96)
        .filter(|path| !path.is_empty())
    {
        label.push_str(" - ");
        label.push_str(&path);
    }

    if let Some(status) = sanitize_menu_text(tab.status_label.as_deref().unwrap_or_default(), 48)
        .filter(|status| !status.is_empty())
    {
        label.push_str(" (");
        label.push_str(&status);
        label.push(')');
    }

    label
}

#[cfg(target_os = "macos")]
fn sanitize_menu_text(text: &str, max_chars: usize) -> Option<String> {
    let compact = text
        .chars()
        .map(|character| match character {
            '\n' | '\r' | '\t' => ' ',
            other => other,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if compact.is_empty() {
        return None;
    }
    Some(truncate_chars(&compact, max_chars))
}

#[cfg(target_os = "macos")]
fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(target_os = "macos")]
fn status_icon(tone: &str, waiting_on_pane: bool) -> tauri::image::Image<'static> {
    let (red, green, blue) = if waiting_on_pane {
        (0xd7, 0xa8, 0x4f)
    } else {
        match tone {
            "active" => (0xd7, 0xa8, 0x4f),
            "pending" => (0x7f, 0x88, 0x84),
            "attention" => (0xe0, 0x79, 0x6d),
            "done" => (0x6c, 0xae, 0x9d),
            "error" => (0xe0, 0x8a, 0x5f),
            _ => (0x7f, 0x88, 0x84),
        }
    };
    let outline = waiting_on_pane || tone == "idle";
    dot_icon(red, green, blue, outline)
}

#[cfg(target_os = "macos")]
fn dot_icon(red: u8, green: u8, blue: u8, outline: bool) -> tauri::image::Image<'static> {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    const SIZE: u32 = 18;

    // The menu rebuilds on every agent status flip, re-rasterizing a dot per
    // tab each time — on the main thread. There are only a handful of distinct
    // (color, outline) dots, so rasterize each once and reuse the pixels.
    static RASTER_CACHE: LazyLock<Mutex<HashMap<(u8, u8, u8, bool), Vec<u8>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    let rgba = {
        let mut cache = RASTER_CACHE.lock().unwrap_or_else(|err| err.into_inner());
        cache
            .entry((red, green, blue, outline))
            .or_insert_with(|| render_dot_rgba(red, green, blue, outline, SIZE))
            .clone()
    };
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(target_os = "macos")]
fn render_dot_rgba(red: u8, green: u8, blue: u8, outline: bool, size: u32) -> Vec<u8> {
    const SAMPLES: u32 = 4;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);

    for y in 0..size {
        for x in 0..size {
            let mut covered = 0u32;
            for sample_y in 0..SAMPLES {
                for sample_x in 0..SAMPLES {
                    let px = x as f32 + (sample_x as f32 + 0.5) / SAMPLES as f32;
                    let py = y as f32 + (sample_y as f32 + 0.5) / SAMPLES as f32;
                    let distance = ((px - 9.0).powi(2) + (py - 9.0).powi(2)).sqrt();
                    let inside = if outline {
                        (4.0..=5.6).contains(&distance)
                    } else {
                        distance <= 4.9
                    };
                    if inside {
                        covered += 1;
                    }
                }
            }
            let alpha = (covered * 255 / (SAMPLES * SAMPLES)) as u8;
            rgba.extend_from_slice(&[red, green, blue, alpha]);
        }
    }

    rgba
}

#[cfg(target_os = "macos")]
fn bento_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 36;
    const SAMPLES: u32 = 4;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);

    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut covered = 0u32;
            for sample_y in 0..SAMPLES {
                for sample_x in 0..SAMPLES {
                    let px = x as f32 + (sample_x as f32 + 0.5) / SAMPLES as f32;
                    let py = y as f32 + (sample_y as f32 + 0.5) / SAMPLES as f32;
                    if bento_covers(px, py) {
                        covered += 1;
                    }
                }
            }
            let alpha = (covered * 255 / (SAMPLES * SAMPLES)) as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }

    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

// A 2x2 pane grid with the bottom-right cell swapped for a disc: three rounded
// squares plus a circle, drawn on a 36px canvas (24px grid scaled by 1.5).
#[cfg(target_os = "macos")]
fn bento_covers(x: f32, y: f32) -> bool {
    const CELL: f32 = 11.25;
    const NEAR: f32 = 5.25;
    const FAR: f32 = 19.5;
    const RADIUS: f32 = 2.625;

    let squares = [(NEAR, NEAR), (FAR, NEAR), (NEAR, FAR)];
    if squares
        .iter()
        .any(|&(left, top)| rounded_rect_covers(x, y, left, top, CELL, RADIUS))
    {
        return true;
    }

    (x - 25.125).powi(2) + (y - 25.125).powi(2) <= 5.625f32.powi(2)
}

#[cfg(target_os = "macos")]
fn rounded_rect_covers(x: f32, y: f32, left: f32, top: f32, size: f32, radius: f32) -> bool {
    let half = size / 2.0;
    let dx = ((x - (left + half)).abs() - (half - radius)).max(0.0);
    let dy = ((y - (top + half)).abs() - (half - radius)).max(0.0);
    dx * dx + dy * dy <= radius * radius
}
