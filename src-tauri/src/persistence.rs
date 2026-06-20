use crate::state::PaneInfo;
use crate::workspace::{AgentInfo, GroupInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Distinguishes the scratch file of each in-flight `save` so concurrent writers
/// never share (and then race to rename) the same temp path.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Bumped whenever the on-disk shape changes incompatibly. A file written by a
/// newer or unknown version is treated as empty rather than misinterpreted.
pub const STATE_VERSION: u32 = 1;
const STATE_FILE: &str = "state.json";
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
    pub queues: HashMap<String, Vec<String>>,
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
            drafts: HashMap::new(),
        }
    }
}

pub fn state_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(STATE_DIR).join(STATE_FILE)
}

/// Reads persisted state, degrading to an empty snapshot whenever the file is
/// missing, unreadable, corrupt, or written by an unrecognized version. Recovery
/// must never abort startup, so this function does not surface errors.
pub fn load(workspace_root: &Path) -> PersistedState {
    let path = state_path(workspace_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return PersistedState::default(),
    };

    match serde_json::from_str::<PersistedState>(&raw) {
        Ok(state) if state.version == STATE_VERSION => state,
        // Unknown version or malformed JSON: start clean instead of guessing.
        _ => PersistedState::default(),
    }
}

/// Writes state atomically: serialize to a sibling `.tmp` file then rename over
/// the target so a crash mid-write can never leave a half-written state.json.
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
    fs::write(&tmp, raw).map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|err| {
        // Don't strand the scratch file if the commit itself fails.
        let _ = fs::remove_file(&tmp);
        format!("failed to commit {}: {err}", path.display())
    })
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
        }
    }

    #[test]
    fn load_missing_file_returns_empty_current_version() {
        let root = temp_root();
        let state = load(&root);
        assert_eq!(state.version, STATE_VERSION);
        assert!(state.panes.is_empty());
        assert!(state.agents.is_empty());
        assert!(state.queues.is_empty());
    }

    #[test]
    fn load_corrupt_file_returns_empty() {
        let root = temp_root();
        let path = state_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ this is not json").unwrap();

        let state = load(&root);
        assert_eq!(state.version, STATE_VERSION);
        assert!(state.panes.is_empty());
    }

    #[test]
    fn load_unknown_version_is_discarded() {
        let root = temp_root();
        let path = state_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"version":99999,"panes":[{"id":"x"}]}"#).unwrap();

        let state = load(&root);
        assert!(state.panes.is_empty());
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

        let loaded = load(&root);
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
        assert_eq!(load(&root).version, STATE_VERSION);
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
