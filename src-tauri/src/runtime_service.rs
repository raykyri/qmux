//! Process ownership for the opt-in background runtime. Renderer disconnects
//! never call shutdown; only a deliberate service stop freezes and tears down
//! execution. The desktop takes the same workspace lock while running in-process.
use crate::{config::QmuxConfig, state::AppState};
use std::{
    fs::{self, File},
    path::Path,
};

pub struct SessionOwner {
    _lock: File,
}
impl SessionOwner {
    pub fn acquire(config: &QmuxConfig) -> Result<Self, String> {
        let directory = config.workspace_root.join(crate::persistence::STATE_DIR);
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let lock = crate::runtime_paths::exclusive_lock(&directory.join("session-owner.lock"))?;
        Ok(Self { _lock: lock })
    }
}

pub struct RuntimeService {
    pub state: AppState,
    rpc: Option<crate::runtime_rpc::RuntimeServer>,
    control: crate::control_socket::ControlSocketRuntime,
    browser: Option<crate::browser_backend::BrowserDiscoverySocket>,
    file_server: Option<crate::file_server::FileServerInfo>,
    _owner: SessionOwner,
}
impl RuntimeService {
    pub fn start(config: QmuxConfig, root: &Path) -> Result<Self, String> {
        let owner = SessionOwner::acquire(&config)?;
        let root = crate::runtime_paths::private_directory(root)?;
        let terminals = crate::local_terminal::TerminalServer::open(&root.join("terminals"))?;
        let state = AppState::with_terminal_server(config, terminals);
        let rpc = crate::runtime_rpc::RuntimeServer::bind_starting(state.clone(), &root)?;
        state.terminal_server().unwrap().refuse_existing_server()?;
        state.preflight_persisted_state()?;
        crate::launch_path::warm_login_shell_path();
        let control = crate::control_socket::start_control_socket(state.clone())?;
        let file_server = crate::file_server::start_file_server(state.clone())?;
        state.set_file_server(file_server.port);
        let recovered = state.restore_session();
        if let Some(warning) = state.take_recovery_warning() {
            eprintln!("qmux-runtime: {warning}");
        }
        crate::workspace::reconcile_imported_research_archives(&state);
        crate::recovery::respawn_session(&state, recovered);
        state.normalize_pane_layout();
        let browser = match crate::browser_backend::start_browser_discovery(Some(state.clone())) {
            Ok(browser) => Some(browser),
            Err(error) => {
                eprintln!("qmux-runtime: browser discovery unavailable: {error}");
                None
            }
        };
        rpc.activate();
        Ok(Self {
            state,
            rpc: Some(rpc),
            control,
            browser,
            file_server: Some(file_server),
            _owner: owner,
        })
    }
    pub fn shutdown_requested(&self) -> bool {
        self.rpc
            .as_ref()
            .is_some_and(|rpc| rpc.shutdown_requested())
    }
}
impl Drop for RuntimeService {
    fn drop(&mut self) {
        // Stop accepting commands and finish admitted mutations before freezing
        // persistence. Reader EOF must not overwrite the frozen session.
        if let Some(rpc) = &mut self.rpc {
            rpc.stop_accepting();
        }
        self.control.shutdown();
        self.state.finalize_persistence_for_exit();
        crate::research_runtime::kill_all_sessions();
        crate::pty::kill_all_panes(&self.state);
        drop(self.browser.take());
        drop(self.file_server.take());
        drop(self.rpc.take());
    }
}
