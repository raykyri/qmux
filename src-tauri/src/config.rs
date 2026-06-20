use crate::adapters::{AdapterMetadata, adapter_registry};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QmuxConfig {
    pub workspace_root: PathBuf,
    pub socket_path: PathBuf,
    #[serde(default)]
    pub adapters: AdapterConfigs,
    #[serde(
        default,
        rename = "claudeBinary",
        skip_serializing_if = "Option::is_none"
    )]
    pub legacy_claude_binary: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterConfigs {
    #[serde(default)]
    pub claude: ClaudeAdapterConfig,
    #[serde(default)]
    pub codex: CodexAdapterConfig,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAdapterConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAdapterConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub workspace_root: String,
    pub socket_path: String,
    pub adapters: Vec<AdapterMetadata>,
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
            adapters: adapter_registry(self).metadata(),
        }
    }

    pub fn claude_binary(&self) -> String {
        self.adapters
            .claude
            .binary
            .clone()
            .or_else(|| self.legacy_claude_binary.clone())
            .unwrap_or_else(|| "claude".to_string())
    }

    pub fn codex_binary(&self) -> String {
        self.adapters
            .codex
            .binary
            .clone()
            .unwrap_or_else(|| "codex".to_string())
    }

    fn default_config() -> Result<Self, String> {
        let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        Ok(Self {
            workspace_root: PathBuf::from(home).join("qmux/workspaces"),
            socket_path: env::temp_dir().join("qmux.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
            },
            legacy_claude_binary: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_binary_overrides_legacy_claude_binary() {
        let config: QmuxConfig = serde_json::from_str(
            r#"{
              "workspaceRoot": ".qmux/workspaces",
              "socketPath": ".qmux/run/qmux.sock",
              "claudeBinary": "legacy-claude",
              "adapters": {
                "claude": {
                  "binary": "adapter-claude"
                }
              }
            }"#,
        )
        .unwrap();

        assert_eq!(config.claude_binary(), "adapter-claude");
    }

    #[test]
    fn legacy_claude_binary_is_used_when_adapter_binary_is_absent() {
        let config: QmuxConfig = serde_json::from_str(
            r#"{
              "workspaceRoot": ".qmux/workspaces",
              "socketPath": ".qmux/run/qmux.sock",
              "claudeBinary": "legacy-claude"
            }"#,
        )
        .unwrap();

        assert_eq!(config.claude_binary(), "legacy-claude");
    }

    #[test]
    fn codex_binary_defaults_and_can_be_configured() {
        let default_config: QmuxConfig = serde_json::from_str(
            r#"{
              "workspaceRoot": ".qmux/workspaces",
              "socketPath": ".qmux/run/qmux.sock"
            }"#,
        )
        .unwrap();
        assert_eq!(default_config.codex_binary(), "codex");

        let configured: QmuxConfig = serde_json::from_str(
            r#"{
              "workspaceRoot": ".qmux/workspaces",
              "socketPath": ".qmux/run/qmux.sock",
              "adapters": {
                "codex": {
                  "binary": "/opt/bin/codex"
                }
              }
            }"#,
        )
        .unwrap();
        assert_eq!(configured.codex_binary(), "/opt/bin/codex");
    }
}
