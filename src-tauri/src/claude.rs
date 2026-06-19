use crate::hooks::write_claude_hook_settings;
use crate::pty::{PtySpawnSpec, qmux_pane_envs, spawn_pty};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::workspace::{
    PrepareAgentWorkspaceRequest, attach_agent_pane, mark_agent_failed, prepare_agent_workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnClaudeRequest {
    pub prompt: String,
    pub group_id: Option<String>,
    pub base_repo: Option<String>,
    pub base_ref: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareShellClaudeLaunchRequest {
    pub pane_id: String,
    pub cwd: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareShellClaudeLaunchResponse {
    pub claude_binary: String,
    pub cwd: String,
    pub settings_path: String,
    pub envs: Vec<ClaudeLaunchEnv>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLaunchEnv {
    pub key: String,
    pub value: String,
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

    let agent = prepare_agent_workspace(
        state,
        PrepareAgentWorkspaceRequest {
            group_id: request.group_id,
            base_repo: request.base_repo,
            base_ref: request.base_ref,
            adapter: "claude".to_string(),
            model: request.model.clone(),
        },
    )?;
    let cwd = request
        .cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&agent.worktree_dir));
    if !cwd.is_dir() {
        return Err(format!(
            "Claude working directory {} does not exist",
            cwd.display()
        ));
    }
    let pane_id = state.next_id("pane");
    let settings_path = match write_claude_hook_settings(&agent) {
        Ok(settings_path) => settings_path,
        Err(err) => {
            let _ = mark_agent_failed(state, &agent.id);
            return Err(err);
        }
    };
    let mut args = vec![
        "--settings".to_string(),
        settings_path.display().to_string(),
    ];

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

    args.push(request.prompt);

    let mut envs = qmux_pane_envs(state, &pane_id);
    envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));

    let spawn_result = spawn_pty(
        state,
        PtySpawnSpec {
            pane_id: Some(pane_id.clone()),
            agent_id: Some(agent.id.clone()),
            kind: PaneKind::Agent,
            title: "Claude".to_string(),
            program: binary,
            args,
            cwd,
            envs,
        },
    );

    match spawn_result {
        Ok(pane) => {
            attach_agent_pane(state, &agent.id, pane.id.clone())?;
            Ok(pane)
        }
        Err(err) => {
            let _ = mark_agent_failed(state, &agent.id);
            Err(err)
        }
    }
}

pub fn prepare_shell_claude_launch(
    state: &AppState,
    request: PrepareShellClaudeLaunchRequest,
) -> Result<PrepareShellClaudeLaunchResponse, String> {
    let binary = state.config().claude_binary.clone();
    ensure_on_path(&binary).ok_or_else(|| {
        format!(
            "Claude CLI binary '{binary}' was not found on PATH. Install Claude Code or update qmux.config.json."
        )
    })?;

    if state.pane_writer(&request.pane_id)?.is_none() {
        return Err(format!("pane {} was not found", request.pane_id));
    }

    let cwd = PathBuf::from(&request.cwd);
    if !cwd.is_dir() {
        return Err(format!(
            "Claude working directory {} does not exist",
            cwd.display()
        ));
    }

    let agent = prepare_agent_workspace(
        state,
        PrepareAgentWorkspaceRequest {
            group_id: None,
            base_repo: Some(cwd.display().to_string()),
            base_ref: Some("HEAD".to_string()),
            adapter: "claude".to_string(),
            model: None,
        },
    )?;
    let settings_path = match write_claude_hook_settings(&agent) {
        Ok(settings_path) => settings_path,
        Err(err) => {
            let _ = mark_agent_failed(state, &agent.id);
            return Err(err);
        }
    };
    let agent = attach_agent_pane(state, &agent.id, request.pane_id.clone())?;

    let mut envs = qmux_pane_envs(state, &request.pane_id);
    envs.push(("QMUX_AGENT_ID".to_string(), agent.id.clone()));
    let agent_id = agent.id.clone();
    let worktree_dir = agent.worktree_dir.clone();
    state.emit(crate::events::QmuxEvent::new(
        "agent.spawned",
        Some(request.pane_id),
        Some(agent_id),
        json!({ "agent": agent.clone(), "source": "shell" }),
    ));

    Ok(PrepareShellClaudeLaunchResponse {
        claude_binary: binary,
        cwd: worktree_dir,
        settings_path: settings_path.display().to_string(),
        envs: envs
            .into_iter()
            .map(|(key, value)| ClaudeLaunchEnv { key, value })
            .collect(),
    })
}

pub fn ensure_on_path(binary: &str) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        return binary_path.is_file().then(|| binary_path.to_path_buf());
    }

    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}
