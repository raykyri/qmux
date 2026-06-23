use crate::state::{PaneInfo, QueuedTurn, RecentSessionInfo};
use crate::workspace::{AgentInfo, GroupInfo};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Distinguishes the scratch file of each in-flight `save` so concurrent writers
/// never share (and then race to rename) the same temp path.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Bumped whenever the on-disk shape changes incompatibly. A file written by a
/// newer or unknown version is treated as empty rather than misinterpreted.
pub const STATE_VERSION: u32 = 1;
const STATE_FILE: &str = "state.json";
const PREFERENCES_FILE: &str = "preferences.json";
const STATE_DIR: &str = ".qmux";

/// Snapshot of everything a qmux restart needs to recreate panes, agents,
/// groups and queued turns. Live PTY handles are intentionally absent: a
/// restarted process cannot adopt the old PTY, so only metadata is persisted.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub version: u32,
    #[serde(default)]
    pub next_id: u64,
    #[serde(default)]
    pub panes: Vec<PaneInfo>,
    #[serde(default)]
    pub groups: Vec<GroupInfo>,
    #[serde(default)]
    pub agents: Vec<AgentInfo>,
    #[serde(default)]
    pub queues: HashMap<String, Vec<QueuedTurn>>,
    /// Durable, tab-independent history of resumable agent sessions. Unlike `agents`,
    /// entries remain after their tab closes so Home can show recent work.
    #[serde(default)]
    pub recent_sessions: Vec<RecentSessionInfo>,
    /// Per-agent composer drafts: the unsent text sitting in the right-pane input.
    /// Persisted so an in-progress draft survives a restart, recovered alongside
    /// queues and transcripts.
    #[serde(default)]
    pub drafts: HashMap<String, String>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            next_id: 0,
            panes: Vec::new(),
            groups: Vec::new(),
            agents: Vec::new(),
            queues: HashMap::new(),
            recent_sessions: Vec::new(),
            drafts: HashMap::new(),
        }
    }
}

pub fn state_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(STATE_DIR).join(STATE_FILE)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher_adapter_id: Option<String>,
    /// The single "open folder" the app roots new shells/agents in and (later) the
    /// file panel. Absolute, canonicalized. Absent until the user picks one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_folder: Option<String>,
}

pub fn preferences_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(STATE_DIR).join(PREFERENCES_FILE)
}

pub fn load_preferences(workspace_root: &Path) -> Result<AppPreferences, String> {
    let path = preferences_path(workspace_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(AppPreferences::default()),
        Err(err) => {
            return Err(format!(
                "failed to read preferences {}: {err}",
                path.display()
            ));
        }
    };

    serde_json::from_str::<AppPreferences>(&raw)
        .map_err(|err| format!("invalid preferences {}: {err}", path.display()))
}

pub fn save_preferences(workspace_root: &Path, preferences: &AppPreferences) -> Result<(), String> {
    let path = preferences_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create preferences dir {}: {err}",
                parent.display()
            )
        })?;
    }

    let raw = serde_json::to_string_pretty(preferences)
        .map_err(|err| format!("failed to encode preferences: {err}"))?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));

    write_synced(&tmp, raw.as_bytes())
        .map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("failed to commit {}: {err}", path.display())
    })?;

    if let Some(parent) = path.parent()
        && let Ok(dir) = fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadWarning {
    pub message: String,
    pub path: PathBuf,
    pub backup_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct LoadOutcome {
    pub state: PersistedState,
    pub warning: Option<LoadWarning>,
}

/// Reads persisted state and reports why recovery had to fall back to an empty
/// snapshot. Missing state is expected on first run and does not produce a warning.
/// Corrupt or unsupported state files are renamed aside before future saves can
/// overwrite them.
pub fn load_with_diagnostics(workspace_root: &Path) -> LoadOutcome {
    let path = state_path(workspace_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == ErrorKind::NotFound => return load_ok(PersistedState::default()),
        Err(err) => {
            return load_warning(
                path.clone(),
                format!(
                    "failed to read persisted state {}; recovery will start empty: {err}",
                    path.display()
                ),
                None,
            );
        }
    };

    let value = match serde_json::from_str::<Value>(&raw) {
        Ok(value) => value,
        Err(err) => {
            return discard_state_file(
                &path,
                "corrupt",
                format!("invalid JSON in persisted state {}: {err}", path.display()),
            );
        }
    };

    let Some(version) = value
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
    else {
        return discard_state_file(
            &path,
            "corrupt",
            format!(
                "persisted state {} is missing a valid version",
                path.display()
            ),
        );
    };

    if version != STATE_VERSION {
        return discard_state_file(
            &path,
            "unsupported-version",
            format!(
                "persisted state {} was written by unsupported version {version}; current version is {STATE_VERSION}",
                path.display()
            ),
        );
    }

    match serde_json::from_value::<PersistedState>(value) {
        Ok(state) => load_ok(state),
        Err(err) => discard_state_file(
            &path,
            "corrupt",
            format!(
                "persisted state {} does not match the expected schema: {err}",
                path.display()
            ),
        ),
    }
}

fn load_ok(state: PersistedState) -> LoadOutcome {
    LoadOutcome {
        state,
        warning: None,
    }
}

fn load_warning(path: PathBuf, message: String, backup_path: Option<PathBuf>) -> LoadOutcome {
    LoadOutcome {
        state: PersistedState::default(),
        warning: Some(LoadWarning {
            message,
            path,
            backup_path,
        }),
    }
}

fn discard_state_file(path: &Path, label: &str, reason: String) -> LoadOutcome {
    let (message, backup_path) = match preserve_rejected_state(path, label) {
        Ok(backup_path) => (
            format!(
                "{reason}; preserved rejected state at {}",
                backup_path.display()
            ),
            Some(backup_path),
        ),
        Err(err) => (
            format!("{reason}; failed to preserve rejected state: {err}"),
            None,
        ),
    };
    load_warning(path.to_path_buf(), message, backup_path)
}

fn preserve_rejected_state(path: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("state path {} has no parent directory", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(STATE_FILE);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let backup_path = parent.join(format!(
        "{file_name}.{label}.{millis}.{}.{seq}.bak",
        std::process::id()
    ));
    fs::rename(path, &backup_path).map_err(|err| {
        format!(
            "failed to rename {} to {}: {err}",
            path.display(),
            backup_path.display()
        )
    })?;
    Ok(backup_path)
}

/// Writes state atomically: serialize to a sibling `.tmp` file, flush it to disk,
/// then rename over the target so a crash mid-write can never leave a half-written
/// state.json. The temp file is fsync'd before the rename and the directory is
/// fsync'd after, so the swap is durable across power loss too — without the fsync
/// the filesystem may order the rename ahead of the data write and surface a
/// zero-length or stale file on recovery.
///
/// The scratch file name is unique per call (pid + sequence). Two saves can run
/// concurrently — `persist` releases the model lock before writing — and a shared
/// temp name would let one writer's rename consume the file out from under the
/// other, which then fails with ENOENT.
pub fn save(workspace_root: &Path, state: &PersistedState) -> Result<(), String> {
    let path = state_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create state dir {}: {err}", parent.display()))?;
    }

    let raw = serde_json::to_string_pretty(state)
        .map_err(|err| format!("failed to encode state: {err}"))?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));

    write_synced(&tmp, raw.as_bytes())
        .map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|err| {
        // Don't strand the scratch file if the commit itself fails.
        let _ = fs::remove_file(&tmp);
        format!("failed to commit {}: {err}", path.display())
    })?;

    // Persist the directory entry so the rename itself survives a crash. Best
    // effort: some platforms don't allow fsync on a directory handle.
    if let Some(parent) = path.parent()
        && let Ok(dir) = fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Writes `bytes` to `path` and fsyncs the file before returning, so the contents
/// are on disk before the caller renames it into place.
fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{PaneKind, PaneStatus};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-persist-{nanos}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn preferences_round_trip_launcher_adapter() {
        let root = temp_root();
        assert_eq!(load_preferences(&root).unwrap().launcher_adapter_id, None);

        save_preferences(
            &root,
            &AppPreferences {
                launcher_adapter_id: Some("codex".to_string()),
            },
        )
        .unwrap();

        assert_eq!(
            load_preferences(&root).unwrap().launcher_adapter_id,
            Some("codex".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn sample_pane() -> PaneInfo {
        PaneInfo {
            id: "pane-1".to_string(),
            title: "Shell".to_string(),
            kind: PaneKind::Shell,
            agent_id: None,
            cwd: "/tmp/work".to_string(),
            cols: 120,
            rows: 40,
            status: PaneStatus::Running,
            recovered: false,
            depth: 0,
        }
    }

    #[test]
    fn load_missing_file_returns_empty_current_version() {
        let root = temp_root();
        let state = load_with_diagnostics(&root).state;
        assert_eq!(state.version, STATE_VERSION);
        assert!(state.panes.is_empty());
        assert!(state.agents.is_empty());
        assert!(state.queues.is_empty());
    }

    #[test]
    fn load_corrupt_file_returns_empty_and_preserves_rejected_file() {
        let root = temp_root();
        let path = state_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bad_state = "{ this is not json";
        fs::write(&path, bad_state).unwrap();

        let outcome = load_with_diagnostics(&root);
        assert_eq!(outcome.state.version, STATE_VERSION);
        assert!(outcome.state.panes.is_empty());
        let warning = outcome.warning.expect("corrupt state should warn");
        assert!(warning.message.contains("invalid JSON"));
        let backup_path = warning
            .backup_path
            .expect("corrupt state should be preserved");
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(backup_path).unwrap(), bad_state);
    }

    #[test]
    fn load_unknown_version_returns_empty_and_preserves_rejected_file() {
        let root = temp_root();
        let path = state_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bad_state = r#"{"version":99999,"panes":[{"id":"x"}]}"#;
        fs::write(&path, bad_state).unwrap();

        let outcome = load_with_diagnostics(&root);
        assert!(outcome.state.panes.is_empty());
        let warning = outcome
            .warning
            .expect("unsupported state version should warn");
        assert!(warning.message.contains("unsupported version 99999"));
        let backup_path = warning
            .backup_path
            .expect("unsupported state should be preserved");
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(backup_path).unwrap(), bad_state);
    }

    #[test]
    fn pane_metadata_survives_round_trip() {
        let root = temp_root();
        let state = PersistedState {
            next_id: 17,
            panes: vec![sample_pane()],
            ..PersistedState::default()
        };
        save(&root, &state).unwrap();

        let loaded = load_with_diagnostics(&root).state;
        assert_eq!(loaded.next_id, 17);
        assert_eq!(loaded.panes.len(), 1);
        let pane = &loaded.panes[0];
        assert_eq!(pane.id, "pane-1");
        assert_eq!(pane.cwd, "/tmp/work");
        assert_eq!(pane.cols, 120);
        assert_eq!(pane.rows, 40);
        assert!(matches!(pane.kind, PaneKind::Shell));
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp_file() {
        let root = temp_root();
        let state = PersistedState::default();
        save(&root, &state).unwrap();

        let path = state_path(&root);
        assert!(path.exists());
        assert!(!path.with_extension("json.tmp").exists());
    }

    // Regression: persist() releases the model lock before writing, so saves can
    // overlap. A shared temp name let one writer's rename pull the file out from
    // under another, which then failed to commit with ENOENT.
    #[test]
    fn concurrent_saves_do_not_race_and_leave_no_temp_files() {
        use std::sync::Arc;
        use std::thread;

        let root = Arc::new(temp_root());
        let parent = state_path(&root).parent().unwrap().to_path_buf();
        fs::create_dir_all(&parent).unwrap();

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let root = Arc::clone(&root);
                thread::spawn(move || {
                    for _ in 0..50 {
                        save(&root, &PersistedState::default()).expect("save must not fail");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        // A complete, parseable snapshot survives and nothing is stranded.
        assert_eq!(load_with_diagnostics(&root).state.version, STATE_VERSION);
        let leftover_temps: Vec<_> = fs::read_dir(&parent)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftover_temps.is_empty(),
            "stranded temp files: {leftover_temps:?}"
        );
    }
}
