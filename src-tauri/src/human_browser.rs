//! Native child-webview backend for qmux's human browser mode.
//!
//! External pages are top-level documents in their own WKWebView/WebView2/etc.,
//! never frames inside the privileged application document. The child labels
//! intentionally match no Tauri capability, and every navigation is checked
//! again here so the frontend is not the security boundary.

use crate::native_terminal;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, State, Url,
    Webview, WebviewUrl,
};

const MAIN_WEBVIEW_LABEL: &str = "main";
const HUMAN_BROWSER_EVENT: &str = "human-browser-event";
static NEXT_WEBVIEW_LABEL: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanBrowserSyncRequest {
    owner_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    generation: u64,
    revision: u64,
    navigation_revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanBrowserDestroyRequest {
    owner_id: String,
    generation: u64,
    revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanBrowserOwnerRequest {
    owner_id: String,
    generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanBrowserSnapshot {
    owner_id: String,
    url: String,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HumanBrowserEvent {
    owner_id: String,
    kind: &'static str,
    url: Option<String>,
    title: Option<String>,
    loading: Option<bool>,
}

#[derive(Clone)]
struct HumanBrowserView {
    webview: Webview,
    requested_url: String,
    navigation_revision: u64,
    history_state: Arc<AtomicU8>,
    bounds: Rect,
}

struct HumanBrowserInner {
    views: HashMap<String, HumanBrowserView>,
    active_owner: Option<String>,
    retiring: HashMap<String, Webview>,
    creating: HashSet<String>,
    /// Frontend surface revisions are app-global, not per owner. That makes a
    /// delayed show from the previously active pane unable to cover the pane
    /// the user switched to while the first command was crossing the bridge.
    latest_surface_revision: u64,
    /// Lifecycle ordering is per owner. A destroy for pane A must not be
    /// discarded merely because a newer geometry update for pane B arrived
    /// first, while a genuinely stale destroy must not remove a reopened A.
    owner_revisions: HashMap<String, u64>,
    generation: u64,
}

impl Default for HumanBrowserInner {
    fn default() -> Self {
        Self {
            views: HashMap::new(),
            active_owner: None,
            retiring: HashMap::new(),
            creating: HashSet::new(),
            latest_surface_revision: 0,
            owner_revisions: HashMap::new(),
            generation: 1,
        }
    }
}

impl HumanBrowserInner {
    fn accept_surface_request(&mut self, owner_id: &str, generation: u64, revision: u64) -> bool {
        if generation != self.generation
            || revision <= self.latest_surface_revision
            || revision <= self.owner_revisions.get(owner_id).copied().unwrap_or(0)
        {
            return false;
        }
        self.latest_surface_revision = revision;
        self.owner_revisions.insert(owner_id.to_string(), revision);
        true
    }

    fn accept_destroy_request(&mut self, owner_id: &str, generation: u64, revision: u64) -> bool {
        if generation != self.generation
            || revision <= self.owner_revisions.get(owner_id).copied().unwrap_or(0)
        {
            return false;
        }
        self.owner_revisions.insert(owner_id.to_string(), revision);
        true
    }

    fn surface_request_is_current(&self, owner_id: &str, generation: u64, revision: u64) -> bool {
        generation == self.generation
            && revision == self.latest_surface_revision
            && self.owner_revisions.get(owner_id) == Some(&revision)
    }

    fn advance_generation(&mut self) {
        self.active_owner = None;
        self.latest_surface_revision = 0;
        self.owner_revisions.clear();
        self.generation = self.generation.wrapping_add(1).max(1);
    }

    fn accept_hide_all(&mut self, generation: u64, revision: u64) -> bool {
        if !self.accept_surface_request(HIDE_ALL_OWNER, generation, revision) {
            return false;
        }
        self.active_owner = None;
        true
    }
}

#[derive(Default)]
pub struct HumanBrowserManager {
    inner: Mutex<HumanBrowserInner>,
    /// Serialize ordinary sync/creation. Cleanup bypasses this permit and
    /// revokes older revisions; the main-thread commit checks those revisions
    /// after `add_child` returns, before revealing any new surface.
    lifecycle_busy: AtomicBool,
}

struct HumanBrowserLifecyclePermit<'a> {
    busy: &'a AtomicBool,
}

impl Drop for HumanBrowserLifecyclePermit<'_> {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::Release);
    }
}

impl HumanBrowserManager {
    fn try_begin_lifecycle(&self) -> Result<HumanBrowserLifecyclePermit<'_>, String> {
        self.lifecycle_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| HumanBrowserLifecyclePermit {
                busy: &self.lifecycle_busy,
            })
            .map_err(|_| "human browser lifecycle is busy; retry the request".to_string())
    }
}

fn emit_event(app: &AppHandle, event: HumanBrowserEvent) {
    let _ = app.emit_to(
        EventTarget::webview(MAIN_WEBVIEW_LABEL),
        HUMAN_BROWSER_EVENT,
        event,
    );
}

fn parse_http_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("invalid browser URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("the human browser only navigates to http(s) URLs".to_string());
    }
    Ok(url)
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_qmux_file_server_url(url: &Url, port: Option<u16>) -> bool {
    let Some(port) = port else {
        return false;
    };
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port_or_known_default() == Some(port)
}

fn validated_human_url(app: &AppHandle, state: &AppState, raw: &str) -> Result<Url, String> {
    let url = parse_http_url(raw)?;
    if is_qmux_file_server_url(&url, state.file_server_port()) {
        return Err(
            "protected qmux file previews must remain in the sandboxed preview".to_string(),
        );
    }
    // During development the privileged app origin is itself http://127.0.0.1.
    // Never let a child become that origin even though the child label is also
    // excluded from capabilities. This is defense in depth against future ACL
    // changes and against navigation to the bundled app origin on other targets.
    if let Some(main) = app.get_webview(MAIN_WEBVIEW_LABEL)
        && let Ok(app_url) = main.url()
        && same_origin(&url, &app_url)
    {
        return Err("refusing to navigate the human browser to qmux's app origin".to_string());
    }
    Ok(url)
}

fn validate_owner_id(owner_id: &str) -> Result<(), String> {
    if owner_id.is_empty() || owner_id.len() > 512 || owner_id.contains('\0') {
        return Err("invalid human browser owner id".to_string());
    }
    Ok(())
}

fn validated_bounds(request: &HumanBrowserSyncRequest) -> Result<Rect, String> {
    let values = [request.x, request.y, request.width, request.height];
    if values.iter().any(|value| !value.is_finite())
        || request.width < 0.0
        || request.height < 0.0
        || (request.visible && (request.width < 1.0 || request.height < 1.0))
    {
        return Err("invalid human browser bounds".to_string());
    }
    Ok(Rect {
        position: LogicalPosition::new(request.x, request.y).into(),
        size: LogicalSize::new(request.width, request.height).into(),
    })
}

#[cfg(target_os = "macos")]
fn set_native_browser_loading_background(webview: &Webview, active: bool) -> Result<(), String> {
    webview
        .with_webview(move |platform| {
            if let Err(error) =
                native_terminal::set_human_browser_loading_background(platform.inner(), active)
            {
                eprintln!("qmux: failed to update human-browser loading background: {error}");
            }
        })
        .map_err(|error| format!("failed to access the native human browser: {error}"))
}

#[cfg(target_os = "macos")]
fn set_native_browser_loading_background_from_state(
    webview: &Webview,
    active: Arc<AtomicBool>,
) -> Result<(), String> {
    webview
        .with_webview(move |platform| {
            // with_webview can be dispatched to AppKit after add_child returns.
            // Read the state there so a very fast load cannot be overwritten
            // with the stale initial value.
            let active = active.load(Ordering::Acquire);
            if let Err(error) =
                native_terminal::set_human_browser_loading_background(platform.inner(), active)
            {
                eprintln!("qmux: failed to update human-browser loading background: {error}");
            }
        })
        .map_err(|error| format!("failed to access the native human browser: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn set_native_browser_loading_background_from_state(
    _webview: &Webview,
    _active: Arc<AtomicBool>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn set_native_browser_loading_background(_webview: &Webview, _active: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn refresh_human_browser_history_state(webview: &Webview, history_state: Arc<AtomicU8>) {
    let _ = webview.with_webview(move |platform| {
        history_state.store(
            native_terminal::human_browser_history_state(platform.inner()),
            Ordering::Release,
        );
    });
}

#[cfg(not(target_os = "macos"))]
fn refresh_human_browser_history_state(webview: &Webview, history_state: Arc<AtomicU8>) {
    let _ = webview.eval_with_callback(
        "(() => { const nav = window.navigation; return nav ? (nav.canGoBack ? 1 : 0) | (nav.canGoForward ? 2 : 0) : (window.history.length > 1 ? 1 : 0); })()",
        move |value| {
            if let Ok(value) = serde_json::from_str::<u8>(&value) {
                history_state.store(value & 3, Ordering::Release);
            }
        },
    );
}

/// All native transitions run in one main-thread turn. The response is sent
/// only after the operation completes, independently of document JS callbacks.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.try_send(operation(&handle));
    })
    .map_err(|error| error.to_string())?;
    rx.recv()
        .await
        .ok_or_else(|| "browser transition was not acknowledged".to_string())?
}

/// Main-thread only. On macOS the native bridge changes frame, visibility and
/// responder routing together and verifies hidden/attached state before ack.
fn apply_surface(webview: &Webview, bounds: Option<Rect>, retire: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let visible = bounds.is_some();
        let values = bounds
            .map(|rect| {
                let position = rect.position.to_logical::<f64>(1.0);
                let size = rect.size.to_logical::<f64>(1.0);
                [position.x, position.y, size.width, size.height]
            })
            .unwrap_or([0.0; 4]);
        let (tx, rx) = std::sync::mpsc::channel();
        webview
            .with_webview(move |platform| {
                let _ = tx.send(native_terminal::apply_browser_surface(
                    platform.inner(),
                    values,
                    visible,
                    retire,
                ));
            })
            .map_err(|error| error.to_string())?;
        // with_webview executes inline on the main thread. Never block the UI
        // waiting for a callback if that contract changes.
        rx.try_recv()
            .map_err(|_| "browser transition must run on the main thread".to_string())??;
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(bounds) = bounds {
            webview
                .set_bounds(bounds)
                .map_err(|error| error.to_string())?;
            webview.show().map_err(|error| error.to_string())?;
        } else {
            webview.hide().map_err(|error| error.to_string())?;
        }
        let _ = retire;
    }
    Ok(())
}

/// Reconcile both registries, including orphaned Tauri children and retirements
/// whose previous close failed. Never discard the retry obligation on failure.
fn reconcile_surfaces(app: &AppHandle) -> Result<(), String> {
    let manager = app.state::<HumanBrowserManager>();
    let (active, retained, creating, retiring, generation, revision) = {
        let inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned")?;
        let active = inner
            .active_owner
            .as_ref()
            .and_then(|owner| inner.views.get(owner))
            .map(|view| (view.webview.label().to_string(), view.bounds));
        (
            active,
            inner
                .views
                .values()
                .map(|view| view.webview.label().to_string())
                .collect::<HashSet<_>>(),
            inner.creating.clone(),
            inner.retiring.clone(),
            inner.generation,
            inner.latest_surface_revision,
        )
    };
    let mut children = app
        .get_window(MAIN_WEBVIEW_LABEL)
        .map(|window| window.webviews())
        .unwrap_or_default()
        .into_iter()
        .filter(|view| view.label().starts_with("human-browser-"))
        .map(|view| (view.label().to_string(), view))
        .collect::<HashMap<_, _>>();
    children.extend(retiring.clone());
    let mut errors = Vec::new();
    for (label, webview) in children {
        let retire = retiring.contains_key(&label)
            || (!retained.contains(&label) && !creating.contains(&label));
        if retire {
            manager
                .inner
                .lock()
                .map_err(|_| "human browser state lock poisoned")?
                .retiring
                .insert(label.clone(), webview.clone());
        }
        let bounds = active
            .as_ref()
            .filter(|(active, _)| active == &label && !retire)
            .map(|(_, bounds)| *bounds);
        if std::env::var_os("QMUX_BROWSER_TRACE").is_some() {
            eprintln!(
                "qmux: browser reconcile label={label} generation={generation} revision={revision} visible={} retire={retire} bounds={bounds:?}",
                bounds.is_some()
            );
        }
        let result = (|| {
            // A prior close may have succeeded despite a lost acknowledgement.
            if app.get_webview(&label).is_some() {
                apply_surface(&webview, bounds, retire)?;
                if retire {
                    webview.close().map_err(|error| error.to_string())?;
                    if app.get_webview(&label).is_some() {
                        return Err("browser remains registered after close".to_string());
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!(
                "qmux: browser transition label={label} generation={generation} revision={revision} visible={} retire={retire}: {error}",
                bounds.is_some()
            );
            errors.push(error);
        } else if retire {
            manager
                .inner
                .lock()
                .map_err(|_| "human browser state lock poisoned")?
                .retiring
                .remove(&label);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// React need not be responsive for activation to retry native cleanup.
pub fn reconcile_on_activation(app: &AppHandle) {
    if app.try_state::<HumanBrowserManager>().is_some()
        && let Err(error) = reconcile_surfaces(app)
    {
        eprintln!("qmux: browser activation reconciliation failed: {error}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanBrowserSyncResult {
    applied: bool,
    snapshot: Option<HumanBrowserSnapshot>,
}

impl HumanBrowserSyncResult {
    fn stale() -> Self {
        Self {
            applied: false,
            snapshot: None,
        }
    }
}

fn create_webview(
    app: &AppHandle,
    state: &AppState,
    owner_id: &str,
    label: &str,
    initial_url: Url,
    bounds: Rect,
) -> Result<(Webview, Arc<AtomicU8>), String> {
    let navigation_app = app.clone();
    let navigation_state = state.clone();
    let page_app = app.clone();
    let page_owner = owner_id.to_string();
    let title_app = app.clone();
    let title_owner = owner_id.to_string();
    let popup_app = app.clone();
    let popup_state = state.clone();
    let popup_owner = owner_id.to_string();
    let loading_background_active = Arc::new(AtomicBool::new(true));
    let page_loading_background_active = loading_background_active.clone();
    let history_state = Arc::new(AtomicU8::new(0));
    let page_history_state = history_state.clone();

    let builder = WebviewBuilder::new(label, WebviewUrl::External(initial_url))
        .on_navigation(move |url| {
            validated_human_url(&navigation_app, &navigation_state, url.as_str()).is_ok()
        })
        .on_page_load(move |webview, payload| {
            let loading = payload.event() == PageLoadEvent::Started;
            page_loading_background_active.store(loading, Ordering::Release);
            let _ = set_native_browser_loading_background(&webview, loading);
            refresh_human_browser_history_state(&webview, page_history_state.clone());
            emit_event(
                &page_app,
                HumanBrowserEvent {
                    owner_id: page_owner.clone(),
                    kind: "navigation",
                    url: Some(payload.url().to_string()),
                    title: None,
                    loading: Some(loading),
                },
            );
        })
        .on_document_title_changed(move |webview, title| {
            emit_event(
                &title_app,
                HumanBrowserEvent {
                    owner_id: title_owner.clone(),
                    kind: "title",
                    url: webview.url().ok().map(|url| url.to_string()),
                    title: Some(title),
                    loading: None,
                },
            );
        })
        .on_new_window(move |url, _features| {
            if validated_human_url(&popup_app, &popup_state, url.as_str()).is_ok() {
                emit_event(
                    &popup_app,
                    HumanBrowserEvent {
                        owner_id: popup_owner.clone(),
                        kind: "newWindow",
                        url: Some(url.to_string()),
                        title: None,
                        loading: None,
                    },
                );
            }
            // Popups are routed back through the managed address/navigation
            // path. Never let a remote page create an unmanaged app window.
            NewWindowResponse::Deny
        })
        // Downloads need an explicit destination/confirmation flow before they
        // can be safely exposed as a human-browser feature.
        .on_download(|_webview, _event| false);

    let window = app
        .get_window(MAIN_WEBVIEW_LABEL)
        .ok_or_else(|| "the main window is unavailable".to_string())?;
    // Wry adds a child WKWebView to the view hierarchy during construction.
    // Give it no drawable area until the hide/background messages below have
    // reached AppKit; human_browser_sync applies the requested bounds later.
    #[cfg(target_os = "macos")]
    let initial_size = LogicalSize::new(0.0, 0.0);
    #[cfg(not(target_os = "macos"))]
    let initial_size = bounds.size;
    let webview = window
        .add_child(builder, bounds.position, initial_size)
        .map_err(|error| format!("failed to create the human browser: {error}"))?;
    // In particular, suppress the initial non-macOS child before committing
    // its desired visibility. If this fails, the orphan sweep owns cleanup.
    webview.hide().map_err(|error| error.to_string())?;
    let _ = set_native_browser_loading_background_from_state(&webview, loading_background_active);
    Ok((webview, history_state))
}

fn current_snapshot(owner_id: &str, view: &HumanBrowserView) -> HumanBrowserSnapshot {
    refresh_human_browser_history_state(&view.webview, view.history_state.clone());
    let history_state = view.history_state.load(Ordering::Acquire);
    HumanBrowserSnapshot {
        owner_id: owner_id.to_string(),
        url: view
            .webview
            .url()
            .map(|url| url.to_string())
            .unwrap_or_else(|_| view.requested_url.clone()),
        can_go_back: history_state & 1 != 0,
        can_go_forward: history_state & 2 != 0,
    }
}

#[tauri::command]
pub async fn human_browser_sync(
    request: HumanBrowserSyncRequest,
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, HumanBrowserManager>,
) -> Result<HumanBrowserSyncResult, String> {
    validate_owner_id(&request.owner_id)?;
    let bounds = validated_bounds(&request)?;
    // An unmount must be able to hide its child even if another command is
    // waiting for WebKit creation or a dispatcher response.
    if !request.visible {
        return on_main(&app, move |app| {
            let manager = app.state::<HumanBrowserManager>();
            let mut inner = manager
                .inner
                .lock()
                .map_err(|_| "human browser state lock poisoned")?;
            if !inner.accept_destroy_request(
                &request.owner_id,
                request.generation,
                request.revision,
            ) {
                return Ok(HumanBrowserSyncResult::stale());
            }
            if inner.active_owner.as_deref() == Some(&request.owner_id) {
                inner.active_owner = None;
            }
            drop(inner);
            reconcile_surfaces(app)?;
            Ok(HumanBrowserSyncResult {
                applied: true,
                snapshot: None,
            })
        })
        .await;
    }
    // Creation stays off the UI thread (required by WebView2). Cleanup can
    // revoke this request while add_child is pending; the commit checks again
    // on the main thread before any nonzero frame can be shown.
    let _lifecycle = manager.try_begin_lifecycle()?;
    let url = validated_human_url(&app, &state, &request.url)?;
    let prepare = request.clone();
    let (accepted, current) = on_main(&app, move |app| {
        let manager = app.state::<HumanBrowserManager>();
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned")?;
        if !inner.accept_surface_request(&prepare.owner_id, prepare.generation, prepare.revision) {
            return Ok((false, None));
        }
        if inner.active_owner.as_deref() != Some(&prepare.owner_id) {
            inner.active_owner = None;
        }
        let view = inner.views.get(&prepare.owner_id).cloned();
        drop(inner);
        reconcile_surfaces(app)?;
        Ok((true, view))
    })
    .await?;
    if !accepted {
        return Ok(HumanBrowserSyncResult::stale());
    }
    let created = current.is_none();
    let mut view = if let Some(view) = current {
        view
    } else {
        let label = format!(
            "human-browser-{}",
            NEXT_WEBVIEW_LABEL.fetch_add(1, Ordering::Relaxed)
        );
        manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned")?
            .creating
            .insert(label.clone());
        match create_webview(&app, &state, &request.owner_id, &label, url.clone(), bounds) {
            Ok((webview, history_state)) => HumanBrowserView {
                webview,
                history_state,
                bounds,
                requested_url: url.to_string(),
                navigation_revision: request.navigation_revision,
            },
            Err(error) => {
                manager
                    .inner
                    .lock()
                    .map_err(|_| "human browser state lock poisoned")?
                    .creating
                    .remove(&label);
                let _ = on_main(&app, reconcile_surfaces).await;
                return Err(error);
            }
        }
    };
    on_main(&app, move |app| {
        let manager = app.state::<HumanBrowserManager>();
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned")?;
        inner.creating.remove(view.webview.label());
        if !inner.surface_request_is_current(
            &request.owner_id,
            request.generation,
            request.revision,
        ) {
            if created {
                inner
                    .retiring
                    .insert(view.webview.label().to_string(), view.webview.clone());
            }
            drop(inner);
            reconcile_surfaces(app)?;
            return Ok(HumanBrowserSyncResult::stale());
        }
        // Retain ownership even when a native transition fails.
        inner.views.insert(request.owner_id.clone(), view.clone());
        drop(inner);
        if request.navigation_revision > view.navigation_revision {
            let _ = set_native_browser_loading_background(&view.webview, true);
            if view.webview.url().ok().as_ref() == Some(&url) {
                view.webview.reload().map_err(|error| error.to_string())?;
            } else {
                view.webview
                    .navigate(url.clone())
                    .map_err(|error| error.to_string())?;
            }
            view.requested_url = url.to_string();
            view.navigation_revision = request.navigation_revision;
        }
        view.bounds = bounds;
        {
            let mut inner = manager
                .inner
                .lock()
                .map_err(|_| "human browser state lock poisoned")?;
            // Native navigation can call back into the app. A reset/revocation
            // during that callback must not be overwritten by this commit.
            if !inner.surface_request_is_current(
                &request.owner_id,
                request.generation,
                request.revision,
            ) {
                drop(inner);
                reconcile_surfaces(app)?;
                return Ok(HumanBrowserSyncResult::stale());
            }
            inner.views.insert(request.owner_id.clone(), view.clone());
            inner.active_owner = Some(request.owner_id.clone());
        }
        if let Err(error) = reconcile_surfaces(app) {
            manager
                .inner
                .lock()
                .map_err(|_| "human browser state lock poisoned")?
                .active_owner = None;
            let _ = reconcile_surfaces(app);
            return Err(error);
        }
        Ok(HumanBrowserSyncResult {
            applied: true,
            snapshot: Some(current_snapshot(&request.owner_id, &view)),
        })
    })
    .await
}

const HIDE_ALL_OWNER: &str = "__qmux_hide_all__";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanBrowserHideAllRequest {
    generation: u64,
    revision: u64,
}

/// Revokes older shows without waiting for creation/navigation to complete.
/// Acknowledges only after the native visibility transition and orphan sweep.
#[tauri::command]
pub async fn human_browser_hide_all(
    request: HumanBrowserHideAllRequest,
    app: AppHandle,
) -> Result<bool, String> {
    on_main(&app, move |app| {
        let manager = app.state::<HumanBrowserManager>();
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned")?;
        if !inner.accept_hide_all(request.generation, request.revision) {
            return Ok(false);
        }
        drop(inner);
        reconcile_surfaces(app)?;
        Ok(true)
    })
    .await
}

#[tauri::command]
pub async fn human_browser_destroy(
    request: HumanBrowserDestroyRequest,
    app: AppHandle,
) -> Result<(), String> {
    validate_owner_id(&request.owner_id)?;
    on_main(&app, move |app| {
        let manager = app.state::<HumanBrowserManager>();
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned")?;
        // Equality is a retry of the same retirement, not a newer intent.
        let retry = request.generation == inner.generation
            && inner.owner_revisions.get(&request.owner_id) == Some(&request.revision);
        if !retry
            && !inner.accept_destroy_request(
                &request.owner_id,
                request.generation,
                request.revision,
            )
        {
            return Ok(());
        }
        if inner.active_owner.as_deref() == Some(&request.owner_id) {
            inner.active_owner = None;
        }
        if let Some(view) = inner.views.remove(&request.owner_id) {
            inner
                .retiring
                .insert(view.webview.label().to_string(), view.webview);
        }
        drop(inner);
        reconcile_surfaces(app)
    })
    .await
}

#[tauri::command]
pub fn human_browser_generation(manager: State<'_, HumanBrowserManager>) -> Result<u64, String> {
    manager
        .inner
        .lock()
        .map(|inner| inner.generation)
        .map_err(|_| "human browser state lock poisoned".to_string())
}

#[tauri::command]
pub fn human_browser_snapshot(
    request: HumanBrowserOwnerRequest,
    manager: State<'_, HumanBrowserManager>,
) -> Result<Option<HumanBrowserSnapshot>, String> {
    validate_owner_id(&request.owner_id)?;
    let view = {
        let inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned".to_string())?;
        if request.generation != inner.generation {
            return Ok(None);
        }
        inner.views.get(&request.owner_id).cloned()
    };
    Ok(view
        .as_ref()
        .map(|view| current_snapshot(&request.owner_id, view)))
}

#[tauri::command]
pub fn human_browser_reload(
    request: HumanBrowserOwnerRequest,
    manager: State<'_, HumanBrowserManager>,
) -> Result<(), String> {
    validate_owner_id(&request.owner_id)?;
    let _lifecycle = manager.try_begin_lifecycle()?;
    let view = {
        let inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned".to_string())?;
        if request.generation != inner.generation {
            return Ok(());
        }
        inner.views.get(&request.owner_id).cloned()
    };
    if let Some(view) = view {
        view.webview
            .reload()
            .map_err(|error| format!("failed to reload the human browser: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn human_browser_navigate_history(
    request: HumanBrowserOwnerRequest,
    direction: String,
    manager: State<'_, HumanBrowserManager>,
) -> Result<(), String> {
    validate_owner_id(&request.owner_id)?;
    let script = match direction.as_str() {
        "back" => "window.history.back()",
        "forward" => "window.history.forward()",
        _ => return Err("invalid human browser history direction".to_string()),
    };
    let _lifecycle = manager.try_begin_lifecycle()?;
    let view = {
        let inner = manager
            .inner
            .lock()
            .map_err(|_| "human browser state lock poisoned".to_string())?;
        if request.generation != inner.generation {
            return Ok(());
        }
        inner.views.get(&request.owner_id).cloned()
    };
    if let Some(view) = view {
        view.webview
            .eval(script)
            .map_err(|error| format!("failed to navigate human browser history: {error}"))?;
    }
    Ok(())
}

/// A main-document reload destroys the frontend authority for child visibility.
/// Close every child and advance the document generation so commands already
/// in flight from the old document cannot resurrect one over the reload.
pub fn reset_all(app: &AppHandle) {
    let Some(manager) = app.try_state::<HumanBrowserManager>() else {
        return;
    };
    let Ok(mut inner) = manager.inner.lock() else {
        return;
    };
    let views = inner
        .views
        .drain()
        .map(|(_, view)| view.webview)
        .collect::<Vec<_>>();
    for view in views {
        inner.retiring.insert(view.label().to_string(), view);
    }
    inner.advance_generation();
    drop(inner);
    if let Err(error) = reconcile_surfaces(app) {
        eprintln!("qmux: browser reset cleanup pending: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_network_http_urls() {
        assert!(parse_http_url("https://example.com/path").is_ok());
        assert!(parse_http_url("http://localhost:3000").is_ok());
        assert!(parse_http_url("file:///tmp/report.html").is_err());
        assert!(parse_http_url("javascript:alert(1)").is_err());
        assert!(parse_http_url("https://").is_err());
    }

    #[test]
    fn origin_comparison_normalizes_default_ports() {
        let a = Url::parse("https://example.com/path").unwrap();
        let b = Url::parse("https://example.com:443/other").unwrap();
        let c = Url::parse("http://example.com/").unwrap();
        assert!(same_origin(&a, &b));
        assert!(!same_origin(&a, &c));
    }

    #[test]
    fn recognizes_only_the_bound_file_server_port() {
        let protected = Url::parse("http://127.0.0.1:8123/token/file").unwrap();
        let dev = Url::parse("http://localhost:5173/").unwrap();
        assert!(is_qmux_file_server_url(&protected, Some(8123)));
        assert!(!is_qmux_file_server_url(&protected, Some(9000)));
        assert!(!is_qmux_file_server_url(&dev, Some(8123)));
    }

    #[test]
    fn owner_destroy_is_not_superseded_by_another_owners_surface_update() {
        let mut inner = HumanBrowserInner::default();
        assert!(inner.accept_surface_request("pane-a", 1, 1));
        assert!(inner.accept_surface_request("pane-b", 1, 3));
        assert!(inner.accept_destroy_request("pane-a", 1, 2));
        assert_eq!(inner.latest_surface_revision, 3);
        assert!(!inner.accept_surface_request("pane-a", 1, 1));
        assert!(inner.accept_surface_request("pane-a", 1, 4));
        assert!(!inner.accept_destroy_request("pane-a", 1, 2));
    }

    #[test]
    fn destroy_blocks_older_requests_for_its_owner_only() {
        let mut inner = HumanBrowserInner::default();
        assert!(inner.accept_surface_request("pane-a", 1, 1));
        assert!(inner.accept_destroy_request("pane-a", 1, 3));
        assert!(!inner.accept_surface_request("pane-a", 1, 2));
        assert!(inner.accept_surface_request("pane-b", 1, 2));
        assert!(inner.surface_request_is_current("pane-b", 1, 2));
    }

    #[test]
    fn newer_surface_request_invalidates_an_older_in_flight_commit() {
        let mut inner = HumanBrowserInner::default();
        assert!(inner.accept_surface_request("pane-a", 1, 1));
        assert!(inner.surface_request_is_current("pane-a", 1, 1));
        assert!(inner.accept_surface_request("pane-b", 1, 2));
        assert!(!inner.surface_request_is_current("pane-a", 1, 1));
        assert!(inner.surface_request_is_current("pane-b", 1, 2));
    }

    #[test]
    fn advancing_generation_rejects_old_document_commands() {
        let mut inner = HumanBrowserInner::default();
        assert!(inner.accept_surface_request("pane-a", 1, 1));
        inner.advance_generation();
        assert!(!inner.accept_surface_request("pane-a", 1, 2));
        assert!(!inner.accept_destroy_request("pane-a", 1, 3));
        assert!(inner.accept_surface_request("pane-a", 2, 1));
    }

    #[test]
    fn lifecycle_permit_rejects_overlap_and_recovers_after_drop() {
        let manager = HumanBrowserManager::default();
        let first = manager.try_begin_lifecycle().unwrap();
        assert!(manager.try_begin_lifecycle().is_err());
        drop(first);
        assert!(manager.try_begin_lifecycle().is_ok());
    }

    #[test]
    fn hide_all_uses_a_reserved_owner_that_cannot_collide_with_a_pane() {
        assert!(validate_owner_id(HIDE_ALL_OWNER).is_ok());
        let mut inner = HumanBrowserInner::default();
        assert!(inner.accept_surface_request("pane-a", 1, 1));
        assert!(inner.accept_surface_request(HIDE_ALL_OWNER, 1, 2));
        assert!(!inner.surface_request_is_current("pane-a", 1, 1));
        assert!(!inner.accept_surface_request("pane-a", 1, 1));
    }

    #[test]
    fn stale_hide_all_cannot_hide_a_newer_owner_or_document() {
        let mut inner = HumanBrowserInner::default();
        assert!(inner.accept_surface_request("a", 1, 10));
        inner.active_owner = Some("a".into());
        assert!(!inner.accept_hide_all(1, 9));
        assert!(!inner.accept_hide_all(0, 20));
        assert_eq!(inner.active_owner.as_deref(), Some("a"));
        assert!(inner.accept_hide_all(1, 11));
        assert_eq!(inner.active_owner, None);
    }

    #[test]
    fn cleanup_revokes_creation_even_while_the_creation_permit_is_held() {
        let manager = HumanBrowserManager::default();
        let _creating = manager.try_begin_lifecycle().unwrap();
        let mut inner = manager.inner.lock().unwrap();
        assert!(inner.accept_surface_request("a", 1, 1));
        assert!(inner.accept_hide_all(1, 2));
        assert!(!inner.surface_request_is_current("a", 1, 1));
        // A late completion must retire its newly created view, not show it.
        assert!(inner.accept_surface_request("a", 1, 3));
        assert!(inner.accept_destroy_request("a", 1, 4));
        assert!(!inner.surface_request_is_current("a", 1, 3));
    }

    #[test]
    fn owner_cleanup_does_not_cancel_another_owners_show_or_hide_all() {
        let mut inner = HumanBrowserInner::default();
        assert!(inner.accept_surface_request("b", 1, 2));
        assert!(inner.accept_destroy_request("a", 1, 3));
        assert!(inner.surface_request_is_current("b", 1, 2));
        assert!(inner.accept_hide_all(1, 4));
        assert!(inner.accept_destroy_request("b", 1, 6));
        assert_eq!(inner.latest_surface_revision, 4);
        assert!(!inner.accept_surface_request("b", 1, 5));
        assert!(inner.accept_surface_request("b", 1, 7));
        assert!(!inner.accept_destroy_request("b", 1, 6));
    }
}
