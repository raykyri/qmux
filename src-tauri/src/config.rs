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
    /// Directory of the qmux-managed Claude plugin whose `skills/` are injected
    /// into launched Claude agents via `--plugin-dir`. Resolved at load time from
    /// `QMUX_CLAUDE_PLUGIN_DIR` or `<cwd>/qmux-plugin`; never read from or written
    /// to the config JSON (it is derived, not configured).
    #[serde(skip)]
    pub claude_plugin_dir: PathBuf,
    /// Directory of the qmux-managed opencode plugin whose JS files are injected
    /// into launched opencode agents via `OPENCODE_CONFIG_DIR`. Resolved at load
    /// time from `QMUX_OPENCODE_PLUGIN_DIR` or `<cwd>/qmux-opencode-plugin`; never
    /// read from or written to the config JSON (it is derived, not configured).
    #[serde(skip)]
    pub opencode_plugin_dir: PathBuf,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterConfigs {
    #[serde(default)]
    pub claude: ClaudeAdapterConfig,
    #[serde(default)]
    pub codex: CodexAdapterConfig,
    #[serde(default)]
    pub opencode: OpencodeAdapterConfig,
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeAdapterConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub workspace_root: String,
    pub socket_path: String,
    pub adapters: Vec<AdapterMetadata>,
    // The user's home directory, so the UI can render home-relative paths as ~/…
    // instead of bare relative segments. Empty if HOME is unset.
    pub home_dir: String,
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
        config.claude_plugin_dir = resolve_claude_plugin_dir(&cwd);
        config.opencode_plugin_dir = resolve_opencode_plugin_dir(&cwd);

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
            home_dir: env::var("HOME").unwrap_or_default(),
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

    pub fn opencode_binary(&self) -> String {
        self.adapters
            .opencode
            .binary
            .clone()
            .unwrap_or_else(|| "opencode".to_string())
    }

    fn default_config() -> Result<Self, String> {
        let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        let qmux_root = PathBuf::from(home).join("qmux");
        Ok(Self {
            workspace_root: qmux_root.join("workspaces"),
            socket_path: qmux_root.join("run/qmux.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
                opencode: OpencodeAdapterConfig {
                    binary: Some("opencode".to_string()),
                },
            },
            legacy_claude_binary: None,
            // Overwritten by load() once the cwd is known; this default is only a
            // placeholder for the no-config-file path.
            claude_plugin_dir: PathBuf::new(),
            opencode_plugin_dir: PathBuf::new(),
        })
    }
}

/// Resolves the qmux-managed Claude plugin directory. Honors an explicit
/// `QMUX_CLAUDE_PLUGIN_DIR` override (absolutized against the cwd when relative);
/// otherwise picks the first existing candidate so skills load regardless of how
/// qmux is launched — not only when the process cwd happens to be the repo root.
fn resolve_claude_plugin_dir(cwd: &Path) -> PathBuf {
    let override_os = env::var_os("QMUX_CLAUDE_PLUGIN_DIR").filter(|value| !value.is_empty());
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    pick_claude_plugin_dir(
        cwd,
        override_os.as_deref().map(Path::new),
        exe_dir.as_deref(),
    )
}

/// Pure resolver (testable): the explicit override always wins; otherwise the first
/// existing candidate is used, falling back to `<cwd>/qmux-plugin` when none exist.
/// Candidates cover the ways qmux runs:
/// - `<cwd>/qmux-plugin` — dev (`tauri dev`) or a binary run from the repo root.
/// - `<exe_dir>/qmux-plugin` — plugin copied next to the binary.
/// - `<exe_dir>/../Resources/qmux-plugin` — the macOS `.app` bundle (Finder launch).
/// - `<exe_dir>/../../../qmux-plugin` — `src-tauri/target/<profile>/qmux` -> repo root.
fn pick_claude_plugin_dir(
    cwd: &Path,
    override_dir: Option<&Path>,
    exe_dir: Option<&Path>,
) -> PathBuf {
    pick_plugin_dir(cwd, override_dir, exe_dir, "qmux-plugin")
}

/// Resolves the qmux-managed opencode plugin directory. Honors an explicit
/// `QMUX_OPENCODE_PLUGIN_DIR` override (absolutized against the cwd when relative);
/// otherwise picks the first existing candidate so the plugin loads regardless of
/// how qmux is launched. Mirrors `resolve_claude_plugin_dir`.
fn resolve_opencode_plugin_dir(cwd: &Path) -> PathBuf {
    let override_os = env::var_os("QMUX_OPENCODE_PLUGIN_DIR").filter(|value| !value.is_empty());
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    pick_plugin_dir(
        cwd,
        override_os.as_deref().map(Path::new),
        exe_dir.as_deref(),
        "qmux-opencode-plugin",
    )
}

/// Shared plugin-directory resolver used by both the Claude and opencode plugin
/// lookups. The explicit override always wins; otherwise the first existing
/// candidate is used, falling back to `<cwd>/<default_name>` when none exist.
fn pick_plugin_dir(
    cwd: &Path,
    override_dir: Option<&Path>,
    exe_dir: Option<&Path>,
    default_name: &str,
) -> PathBuf {
    if let Some(override_dir) = override_dir {
        return absolutize(cwd, override_dir);
    }
    let mut candidates = vec![cwd.join(default_name)];
    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join(default_name));
        candidates.push(exe_dir.join("../Resources").join(default_name));
        candidates.push(exe_dir.join("../../../").join(default_name));
    }
    candidates
        .into_iter()
        .find(|dir| dir.is_dir())
        .unwrap_or_else(|| cwd.join(default_name))
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

    #[test]
    fn opencode_binary_defaults_and_can_be_configured() {
        let default_config: QmuxConfig = serde_json::from_str(
            r#"{
              "workspaceRoot": ".qmux/workspaces",
              "socketPath": ".qmux/run/qmux.sock"
            }"#,
        )
        .unwrap();
        assert_eq!(default_config.opencode_binary(), "opencode");

        let configured: QmuxConfig = serde_json::from_str(
            r#"{
              "workspaceRoot": ".qmux/workspaces",
              "socketPath": ".qmux/run/qmux.sock",
              "adapters": {
                "opencode": {
                  "binary": "/opt/bin/opencode"
                }
              }
            }"#,
        )
        .unwrap();
        assert_eq!(configured.opencode_binary(), "/opt/bin/opencode");
    }

    #[test]
    fn default_socket_path_lives_under_owned_run_dir() {
        let home = env::var("HOME").unwrap();
        let config = QmuxConfig::default_config().unwrap();
        let temp_dir = env::temp_dir();

        assert_eq!(
            config.workspace_root,
            PathBuf::from(&home).join("qmux/workspaces")
        );
        assert_eq!(
            config.socket_path,
            PathBuf::from(home).join("qmux/run/qmux.sock")
        );
        assert_ne!(config.socket_path.parent(), Some(temp_dir.as_path()));
    }

    #[test]
    fn plugin_dir_override_wins_and_is_absolutized() {
        let cwd = Path::new("/tmp/qmux-cfg");
        // Absolute override is used verbatim.
        assert_eq!(
            pick_claude_plugin_dir(cwd, Some(Path::new("/opt/skills")), None),
            PathBuf::from("/opt/skills")
        );
        // Relative override is resolved against the cwd.
        assert_eq!(
            pick_claude_plugin_dir(cwd, Some(Path::new("rel/skills")), None),
            PathBuf::from("/tmp/qmux-cfg/rel/skills")
        );
    }

    #[test]
    fn plugin_dir_prefers_first_existing_candidate() {
        let base = env::temp_dir().join(format!("qmux-plugindir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let cwd = base.join("cwd");
        let exe_dir = base.join("exe");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&exe_dir).unwrap();

        // Nothing exists yet -> falls back to <cwd>/qmux-plugin.
        assert_eq!(
            pick_claude_plugin_dir(&cwd, None, Some(&exe_dir)),
            cwd.join("qmux-plugin")
        );

        // An exe-adjacent plugin is found even though cwd has none — the case that
        // previously failed when the process cwd was not the repo root.
        let exe_plugin = exe_dir.join("qmux-plugin");
        fs::create_dir_all(&exe_plugin).unwrap();
        assert_eq!(
            pick_claude_plugin_dir(&cwd, None, Some(&exe_dir)),
            exe_plugin
        );

        // The cwd candidate takes precedence once it exists.
        let cwd_plugin = cwd.join("qmux-plugin");
        fs::create_dir_all(&cwd_plugin).unwrap();
        assert_eq!(
            pick_claude_plugin_dir(&cwd, None, Some(&exe_dir)),
            cwd_plugin
        );

        let _ = fs::remove_dir_all(&base);
    }
}
