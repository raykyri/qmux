use crate::events::base64_encode;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SCROLLBACK_DIR: &str = "terminal";
const STATE_DIR: &str = ".qmux";
const LOG_EXTENSION: &str = "pty";
/// Per-pane cap for durable terminal output. This is intentionally byte-based:
/// xterm does the terminal parsing on replay, and retaining the latest bytes gives
/// the same practical behavior as a bounded scrollback window without storing a
/// frontend-specific buffer shape.
const SCROLLBACK_LOG_CAP: u64 = 8 * 1024 * 1024;

static SCROLLBACK_IO_LOCK: Mutex<()> = Mutex::new(());

pub fn pane_scrollback_base64(workspace_root: &Path, pane_id: &str) -> Result<String, String> {
    read_pane_scrollback(workspace_root, pane_id).map(|bytes| base64_encode(&bytes))
}

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
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create scrollback dir {}: {err}",
                parent.display()
            )
        })?;
    }

    {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|err| format!("failed to open scrollback {}: {err}", path.display()))?;
        file.write_all(chunk)
            .map_err(|err| format!("failed to append scrollback {}: {err}", path.display()))?;
        file.flush()
            .map_err(|err| format!("failed to flush scrollback {}: {err}", path.display()))?;
    }

    trim_scrollback_file(&path)
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

fn trim_scrollback_file(path: &Path) -> Result<(), String> {
    let len = fs::metadata(path)
        .map_err(|err| format!("failed to stat scrollback {}: {err}", path.display()))?
        .len();
    if len <= SCROLLBACK_LOG_CAP {
        return Ok(());
    }

    let keep_from = len - SCROLLBACK_LOG_CAP;
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
    let mut file = fs::File::create(path)?;
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
    fn scrollback_round_trips_and_encodes_as_base64() {
        let workspace = temp_workspace();

        append_pane_scrollback(&workspace, "pane-1", b"hello ").unwrap();
        append_pane_scrollback(&workspace, "pane-1", b"world").unwrap();

        assert_eq!(
            read_pane_scrollback(&workspace, "pane-1").unwrap(),
            b"hello world"
        );
        assert_eq!(
            pane_scrollback_base64(&workspace, "pane-1").unwrap(),
            "aGVsbG8gd29ybGQ="
        );
    }

    #[test]
    fn scrollback_is_capped_to_recent_bytes() {
        let workspace = temp_workspace();
        let large = vec![b'a'; SCROLLBACK_LOG_CAP as usize];

        append_pane_scrollback(&workspace, "pane-1", &large).unwrap();
        append_pane_scrollback(&workspace, "pane-1", b"tail").unwrap();

        let restored = read_pane_scrollback(&workspace, "pane-1").unwrap();
        assert_eq!(restored.len(), SCROLLBACK_LOG_CAP as usize);
        assert_eq!(&restored[restored.len() - 4..], b"tail");
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
