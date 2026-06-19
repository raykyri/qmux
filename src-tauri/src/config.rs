use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QmuxConfig {
    pub workspace_root: PathBuf,
    pub socket_path: PathBuf,
    pub claude_binary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub workspace_root: String,
    pub socket_path: String,
    pub claude_binary: String,
}

impl QmuxConfig {
    pub fn load() -> Result<Self, String> {
        let cwd = env::current_dir().map_err(|err| format!("failed to read cwd: {err}"))?;
        let config_path = cwd.join("qmux.config.json");

        let mut config = if config_path.exists() {
            let raw = fs::read_to_string(&config_path)
                .map_err(|err| format!("failed to read {}: {err}", config_path.display()))?;
            serde_json::from_str::<QmuxConfig>(&raw)
                .map_err(|err| format!("failed to parse {}: {err}", config_path.display()))?
        } else {
            Self::default_config()?
        };

        config.workspace_root = absolutize(&cwd, &config.workspace_root);
        config.socket_path = absolutize(&cwd, &config.socket_path);

        fs::create_dir_all(&config.workspace_root).map_err(|err| {
            format!(
                "failed to create workspace root {}: {err}",
                config.workspace_root.display()
            )
        })?;

        if let Some(parent) = config.socket_path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create socket directory {}: {err}",
                    parent.display()
                )
            })?;
            // Best-effort: keep the control socket's directory owner-only so the socket
            // itself is not reachable by other local accounts.
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }

        Ok(config)
    }

    pub fn runtime(&self) -> RuntimeConfig {
        RuntimeConfig {
            workspace_root: self.workspace_root.display().to_string(),
            socket_path: self.socket_path.display().to_string(),
            claude_binary: self.claude_binary.clone(),
        }
    }

    fn default_config() -> Result<Self, String> {
        let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        Ok(Self {
            workspace_root: PathBuf::from(home).join("qmux/workspaces"),
            socket_path: env::temp_dir().join("qmux.sock"),
            claude_binary: "claude".to_string(),
        })
    }
}

fn absolutize(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}
