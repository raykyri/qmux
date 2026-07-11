use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const SCROLLBACK_DIR: &str = "terminal";
const STATE_DIR: &str = ".qmux";
const LOG_EXTENSION: &str = "pty";
/// Per-pane cap for durable terminal output — the size a trim retains. This is
/// intentionally byte-based: the legacy portable renderer parses these bytes on
/// replay, and retaining the latest bytes gives the same practical behavior as
/// a bounded scrollback window without storing a frontend-specific buffer shape.
const SCROLLBACK_LOG_CAP: u64 = 8 * 1024 * 1024;
/// File length at which a trim actually runs. Trimming rewrites the whole
/// retained tail with an fsync, so triggering it the moment the file passed the
/// cap meant every subsequent append of a long-lived noisy pane paid a full
/// 8MB read + synced write + rename — per PTY chunk, under the global
/// scrollback lock. The slack amortizes that to one rewrite per
/// `SCROLLBACK_TRIM_TRIGGER - SCROLLBACK_LOG_CAP` bytes of output, at the cost
/// of the on-disk file transiently exceeding the cap by up to the slack.
const SCROLLBACK_TRIM_TRIGGER: u64 = SCROLLBACK_LOG_CAP + SCROLLBACK_LOG_CAP / 2;

static SCROLLBACK_IO_LOCK: Mutex<()> = Mutex::new(());
/// Scrollback directories already created and permission-locked this process
/// run, so the steady-state append path skips the mkdir + chmod syscalls it
/// previously paid per chunk. Guarded by `SCROLLBACK_IO_LOCK` ordering: every
/// writer takes that lock first.
static PREPARED_DIRS: LazyLock<Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

pub fn read_pane_scrollback(workspace_root: &Path, pane_id: &str) -> Result<Vec<u8>, String> {
    let _guard = SCROLLBACK_IO_LOCK
        .lock()
        .map_err(|_| "scrollback lock poisoned".to_string())?;
    let path = pane_scrollback_path(workspace_root, pane_id)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!(
            "failed to read scrollback {}: {err}",
            path.display()
        )),
    }
}

pub fn append_pane_scrollback(
    workspace_root: &Path,
    pane_id: &str,
    chunk: &[u8],
) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }

    let _guard = SCROLLBACK_IO_LOCK
        .lock()
        .map_err(|_| "scrollback lock poisoned".to_string())?;
    let path = pane_scrollback_path(workspace_root, pane_id)?;
    if let Some(parent) = path.parent() {
        let already_prepared = PREPARED_DIRS
            .lock()
            .map(|prepared| prepared.contains(parent))
            .unwrap_or(false);
        if !already_prepared {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create scrollback dir {}: {err}",
                    parent.display()
                )
            })?;
            // Scrollback captures raw terminal output — any secret echoed to a pane, plus
            // the pane's own QMUX_TOKEN — so keep its directory owner-only, matching the
            // socket / shell-integration hardening. Best-effort on an existing dir.
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            if let Ok(mut prepared) = PREPARED_DIRS.lock() {
                prepared.insert(parent.to_path_buf());
            }
        }
    }

    let len = {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            // Owner-only: the log is as sensitive as the socket the same codebase
            // locks to 0600.
            .mode(0o600)
            .open(&path)
            .map_err(|err| format!("failed to open scrollback {}: {err}", path.display()))?;
        file.write_all(chunk)
            .map_err(|err| format!("failed to append scrollback {}: {err}", path.display()))?;
        // fstat on the open handle instead of a path stat: the post-append
        // length decides whether the trim trigger tripped.
        file.metadata()
            .map_err(|err| format!("failed to stat scrollback {}: {err}", path.display()))?
            .len()
    };

    if len > SCROLLBACK_TRIM_TRIGGER {
        trim_scrollback_file(&path, len)?;
    }
    Ok(())
}

pub fn remove_pane_scrollback(workspace_root: &Path, pane_id: &str) -> Result<(), String> {
    let _guard = SCROLLBACK_IO_LOCK
        .lock()
        .map_err(|_| "scrollback lock poisoned".to_string())?;
    let path = pane_scrollback_path(workspace_root, pane_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "failed to remove scrollback {}: {err}",
            path.display()
        )),
    }
}

/// Rewrites the log down to the newest `SCROLLBACK_LOG_CAP` bytes. Only called
/// once the file has grown past `SCROLLBACK_TRIM_TRIGGER`, so the rewrite cost
/// is amortized over the slack instead of paid per append.
fn trim_scrollback_file(path: &Path, len: u64) -> Result<(), String> {
    let keep_from = len.saturating_sub(SCROLLBACK_LOG_CAP);
    let mut file = fs::File::open(path)
        .map_err(|err| format!("failed to reopen scrollback {}: {err}", path.display()))?;
    file.seek(SeekFrom::Start(keep_from))
        .map_err(|err| format!("failed to seek scrollback {}: {err}", path.display()))?;
    let mut tail = Vec::with_capacity(SCROLLBACK_LOG_CAP as usize);
    file.read_to_end(&mut tail)
        .map_err(|err| format!("failed to trim scrollback {}: {err}", path.display()))?;
    // Rewrite atomically: write the retained tail to a sibling temp file, then
    // rename it over the log. An in-place `fs::write` truncates the file before
    // writing, so a crash mid-write could leave the scrollback empty or
    // half-written; the temp + rename swap is all-or-nothing. Callers hold the
    // global scrollback I/O lock, so the temp name can't collide with a concurrent
    // trim of the same file.
    let tmp = path.with_extension(format!("trim.{}.tmp", std::process::id()));
    // fsync the temp before the rename (and the dir after) so a power loss can't order
    // the rename ahead of the data and surface a zero-length or stale scrollback.
    write_synced(&tmp, &tail)
        .map_err(|err| format!("failed to write scrollback temp {}: {err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("failed to commit scrollback {}: {err}", path.display())
    })?;
    if let Some(parent) = path.parent()
        && let Ok(dir) = fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Writes `bytes` to `path` and fsyncs the file before returning, so its contents are
/// durable before the caller renames it into place.
fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // Owner-only: this temp is renamed over the scrollback log, so it must carry the
    // same 0600 the log itself gets rather than reverting to the umask default.
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn pane_scrollback_path(workspace_root: &Path, pane_id: &str) -> Result<PathBuf, String> {
    if pane_id.is_empty()
        || !pane_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid pane id for scrollback path".to_string());
    }
    Ok(workspace_root
        .join(STATE_DIR)
        .join(SCROLLBACK_DIR)
        .join(format!("{pane_id}.{LOG_EXTENSION}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_workspace() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-scrollback-{nanos}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scrollback_round_trips() {
        let workspace = temp_workspace();

        append_pane_scrollback(&workspace, "pane-1", b"hello ").unwrap();
        append_pane_scrollback(&workspace, "pane-1", b"world").unwrap();

        assert_eq!(
            read_pane_scrollback(&workspace, "pane-1").unwrap(),
            b"hello world"
        );
    }

    #[test]
    fn scrollback_is_capped_to_recent_bytes() {
        let workspace = temp_workspace();
        let large = vec![b'a'; SCROLLBACK_TRIM_TRIGGER as usize];

        // Exactly at the trigger: no trim yet (hysteresis slack, not the cap,
        // bounds the on-disk file between trims).
        append_pane_scrollback(&workspace, "pane-1", &large).unwrap();
        assert_eq!(
            read_pane_scrollback(&workspace, "pane-1").unwrap().len(),
            SCROLLBACK_TRIM_TRIGGER as usize
        );

        // Past the trigger: trimmed down to the newest cap-sized tail.
        append_pane_scrollback(&workspace, "pane-1", b"tail").unwrap();
        let restored = read_pane_scrollback(&workspace, "pane-1").unwrap();
        assert_eq!(restored.len(), SCROLLBACK_LOG_CAP as usize);
        assert_eq!(&restored[restored.len() - 4..], b"tail");

        // Appends below the trigger leave the file alone — no rewrite per chunk.
        append_pane_scrollback(&workspace, "pane-1", b"-more").unwrap();
        assert_eq!(
            read_pane_scrollback(&workspace, "pane-1").unwrap().len(),
            SCROLLBACK_LOG_CAP as usize + 5
        );
    }

    #[test]
    fn invalid_pane_ids_are_rejected() {
        let workspace = temp_workspace();

        assert!(append_pane_scrollback(&workspace, "../pane", b"x").is_err());
        assert!(read_pane_scrollback(&workspace, "pane/1").is_err());
    }

    #[test]
    fn removing_missing_scrollback_is_ok() {
        let workspace = temp_workspace();

        remove_pane_scrollback(&workspace, "pane-1").unwrap();
    }
}
