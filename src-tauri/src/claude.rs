use crate::pty::{PtySpawnSpec, spawn_pty};
use crate::state::{AppState, PaneInfo, PaneKind};
use serde::Deserialize;
use std::env;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnClaudeRequest {
    pub prompt: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
}

pub fn spawn_claude_pane(
    state: &AppState,
    request: SpawnClaudeRequest,
) -> Result<PaneInfo, String> {
    let binary = state.config().claude_binary.clone();
    ensure_on_path(&binary).ok_or_else(|| {
        format!(
            "Claude CLI binary '{binary}' was not found on PATH. Install Claude Code or update qmux.config.json."
        )
    })?;

    let cwd = request.cwd.map(PathBuf::from).unwrap_or_else(|| {
        env::current_dir().unwrap_or_else(|_| state.config().workspace_root.clone())
    });
    let pane_id = state.next_id("pane");
    let agent_id = state.next_id("agent");
    let mut args = vec![request.prompt];

    if let Some(model) = request.model.filter(|model| !model.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(model);
    }

    if let Some(permission_mode) = request
        .permission_mode
        .filter(|permission_mode| !permission_mode.trim().is_empty())
    {
        args.push("--permission-mode".to_string());
        args.push(permission_mode);
    }

    spawn_pty(
        state,
        PtySpawnSpec {
            pane_id: Some(pane_id.clone()),
            agent_id: Some(agent_id),
            kind: PaneKind::Agent,
            title: "Claude".to_string(),
            program: binary,
            args,
            cwd,
            envs: vec![
                ("QMUX_PANE_ID".to_string(), pane_id),
                (
                    "QMUX_SOCK".to_string(),
                    state.config().socket_path.display().to_string(),
                ),
                ("QMUX_TOKEN".to_string(), state.token().to_string()),
                (
                    "QMUX_WORKSPACE_ROOT".to_string(),
                    state.config().workspace_root.display().to_string(),
                ),
            ],
        },
    )
}

fn ensure_on_path(binary: &str) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        return binary_path.is_file().then(|| binary_path.to_path_buf());
    }

    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}
