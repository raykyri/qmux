use crate::config::QmuxConfig;
use crate::events::QmuxEvent;
use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
pub type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    config: QmuxConfig,
    model: Mutex<Model>,
    next_id: AtomicU64,
    app_handle: Mutex<Option<AppHandle>>,
}

#[derive(Default)]
struct Model {
    panes: HashMap<String, PaneRuntime>,
}

pub struct PaneRuntime {
    pub info: PaneInfo,
    pub child: SharedChild,
    pub master: SharedMaster,
    pub writer: SharedWriter,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub id: String,
    pub title: String,
    pub kind: PaneKind,
    pub agent_id: Option<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: PaneStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneKind {
    Shell,
    Agent,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneStatus {
    Starting,
    Running,
    Exited,
    Killed,
    Failed,
}

impl AppState {
    pub fn new(config: QmuxConfig) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                config,
                model: Mutex::new(Model::default()),
                next_id: AtomicU64::new(1),
                app_handle: Mutex::new(None),
            }),
        }
    }

    pub fn config(&self) -> &QmuxConfig {
        &self.inner.config
    }

    pub fn attach_app(&self, app_handle: AppHandle) -> Result<(), String> {
        let mut handle = self
            .inner
            .app_handle
            .lock()
            .map_err(|_| "app handle lock poisoned".to_string())?;
        *handle = Some(app_handle);
        Ok(())
    }

    pub fn next_id(&self, prefix: &str) -> String {
        let seq = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        format!("{prefix}-{millis}-{seq}")
    }

    pub fn emit(&self, event: QmuxEvent) {
        if let Ok(handle) = self.inner.app_handle.lock() {
            if let Some(app_handle) = handle.as_ref() {
                let _ = app_handle.emit("qmux-event", event);
            }
        }
    }

    pub fn list_panes(&self) -> Result<Vec<PaneInfo>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.values().map(|pane| pane.info.clone()).collect())
    }

    pub fn insert_pane(&self, pane: PaneRuntime) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        model.panes.insert(pane.info.id.clone(), pane);
        Ok(())
    }

    pub fn pane_writer(&self, pane_id: &str) -> Result<Option<SharedWriter>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.writer.clone()))
    }

    pub fn pane_master(&self, pane_id: &str) -> Result<Option<SharedMaster>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.master.clone()))
    }

    pub fn pane_child(&self, pane_id: &str) -> Result<Option<SharedChild>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.panes.get(pane_id).map(|pane| pane.child.clone()))
    }

    pub fn update_pane_size(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let pane = model
            .panes
            .get_mut(pane_id)
            .ok_or_else(|| format!("pane {pane_id} was not found"))?;
        pane.info.cols = cols;
        pane.info.rows = rows;
        Ok(())
    }

    pub fn mark_pane_status(&self, pane_id: &str, status: PaneStatus) -> Result<(), String> {
        let mut model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if let Some(pane) = model.panes.get_mut(pane_id) {
            pane.info.status = status;
        }
        Ok(())
    }
}
