use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};

const SCROLLBACK_DIR: &str = "terminal";
const STATE_DIR: &str = ".qmux";
const LOG_EXTENSION: &str = "pty";
/// Per-pane cap for durable terminal output — the size a trim retains. This is
/// intentionally byte-based: the legacy portable renderer parses these bytes on
/// replay, and retaining the latest bytes gives the same practical behavior as
/// a bounded scrollback window without storing a frontend-specific buffer shape.
const SCROLLBACK_LOG_CAP: u64 = 8 * 1024 * 1024;
/// Ceiling on trims running at once, across all panes. A trim reads the whole
/// log (up to the trigger) and builds its sanitized rewrite in memory — several
/// tens of MB transiently — and per-pane locks deliberately let every pane trim
/// independently. Without a global ceiling, a burst that pushes many noisy panes
/// past the trigger together (a fan-out of agents all dumping build output)
/// would run all their trims at once and multiply that transient by the pane
/// count, spiking to hundreds of MB. Bounding the concurrency caps the peak
/// while still letting a handful proceed in parallel; trims are rare (one per
/// trigger's worth of slack per pane), so the occasional wait costs little.
const MAX_CONCURRENT_TRIMS: usize = 4;
/// Estimated durable bytes per retained scrollback row, used to scale the log
/// cap to the user's configured `scrollbackRows`. Raw terminal bytes per row
/// vary wildly with width and escape density, so this is a budget, not a
/// guarantee — it just keeps a user who raised their live scrollback depth from
/// being silently held to the 8MB default when their session is restored.
const BYTES_PER_ROW_ESTIMATE: u64 = 512;
/// Hard ceiling on the derived cap regardless of `scrollbackRows`, so a very
/// large row setting can't grow each pane's on-disk log — and the in-memory
/// trim that rewrites it — without bound.
const MAX_SCROLLBACK_LOG_CAP: u64 = 64 * 1024 * 1024;

/// The effective per-pane byte cap. Starts at `SCROLLBACK_LOG_CAP` and is raised
/// toward `MAX_SCROLLBACK_LOG_CAP` as the configured scrollback rows grow (see
/// `set_scrollback_cap_for_rows`). Relaxed throughout: it is only a trim
/// threshold, so a briefly stale read just trims a hair early or late.
static EFFECTIVE_SCROLLBACK_CAP: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(SCROLLBACK_LOG_CAP);

fn effective_scrollback_cap() -> u64 {
    EFFECTIVE_SCROLLBACK_CAP.load(std::sync::atomic::Ordering::Relaxed)
}

/// The file length at which a trim actually runs: the effective cap plus 50%
/// hysteresis slack. Trimming rewrites the whole retained tail with an fsync, so
/// firing it the instant the file passed the cap would make every subsequent
/// append of a long-lived noisy pane pay a full cap-sized read + synced write +
/// rename per PTY chunk, under the pane's scrollback lock. The slack amortizes
/// that to one rewrite per half-cap of output, at the cost of the on-disk file
/// transiently exceeding the cap by up to the slack.
fn effective_trim_trigger() -> u64 {
    let cap = effective_scrollback_cap();
    cap + cap / 2
}

/// Maps a configured scrollback-row count to a durable byte budget, floored at
/// the 8MB default (never smaller than today) and ceilinged at
/// `MAX_SCROLLBACK_LOG_CAP`.
fn cap_bytes_for_rows(rows: u32) -> u64 {
    (rows as u64)
        .saturating_mul(BYTES_PER_ROW_ESTIMATE)
        .clamp(SCROLLBACK_LOG_CAP, MAX_SCROLLBACK_LOG_CAP)
}

/// Scales the durable scrollback cap to the live scrollback depth the user
/// configured. Called whenever the frontend seeds or updates terminal settings,
/// so the bytes retained for restore track how much history they asked their
/// live surface to keep instead of a fixed 8MB unrelated to that preference.
pub fn set_scrollback_cap_for_rows(rows: u32) {
    EFFECTIVE_SCROLLBACK_CAP.store(
        cap_bytes_for_rows(rows),
        std::sync::atomic::Ordering::Relaxed,
    );
}

/// One entry per pane log, keyed by the log's path. Scrollback I/O used to
/// serialize every pane behind one global mutex, so a noisy pane's trim — a
/// multi-MB read + synced rewrite — stalled every other pane's reader thread
/// (and with it their output rendering) for the trim's duration. Per-pane
/// entries keep appends, reads, trims, and removals of the *same* pane
/// serialized, exactly like the old global lock did, while panes no longer
/// contend with each other. The map lock itself is only ever held for a
/// lookup/insert/remove, never across I/O.
static PANE_LOGS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<PaneLog>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Available trim slots (see `MAX_CONCURRENT_TRIMS`) plus the condvar sleepers
/// wait on when none are free.
static TRIM_PERMITS: LazyLock<(Mutex<usize>, Condvar)> =
    LazyLock::new(|| (Mutex::new(MAX_CONCURRENT_TRIMS), Condvar::new()));

/// RAII trim slot: `acquire` blocks until one of the `MAX_CONCURRENT_TRIMS`
/// slots is free, and `Drop` returns it — so an early `?` return or a panic
/// inside the trim can never leak a slot and permanently shrink the ceiling.
/// Acquired while holding the trimming pane's log lock; nothing takes a pane
/// lock while holding a permit, so the pane-lock → permit order can't deadlock.
struct TrimPermit;

impl TrimPermit {
    fn acquire() -> Self {
        let (lock, cvar) = &*TRIM_PERMITS;
        let mut available = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while *available == 0 {
            available = cvar
                .wait(available)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *available -= 1;
        TrimPermit
    }
}

impl Drop for TrimPermit {
    fn drop(&mut self) {
        let (lock, cvar) = &*TRIM_PERMITS;
        let mut available = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *available += 1;
        cvar.notify_one();
    }
}

/// Per-pane log state: the append handle, kept open across chunks so the
/// steady-state append path skips the open/close (and mkdir + chmod) syscalls
/// it previously paid per chunk. `None` until the first append, after a trim
/// replaced the file, and after removal.
struct PaneLog {
    file: Option<File>,
}

impl PaneLog {
    /// Appends a chunk through the cached handle, healing the two ways the
    /// handle can go stale: the file was replaced or unlinked externally
    /// (detected by nlink = 0 after the write — the bytes went to the orphaned
    /// inode, so the chunk is rewritten to a fresh file), and a trim, which
    /// invalidates the handle itself below.
    fn append(&mut self, path: &Path, chunk: &[u8]) -> Result<(), String> {
        let mut len = self.append_once(path, chunk)?;
        if len.is_none() {
            // The previous handle pointed at an unlinked inode; recreate the
            // directory and file once and rewrite the chunk.
            self.file = None;
            len = self.append_once(path, chunk)?;
        }
        let Some(len) = len else {
            return Err(format!(
                "scrollback {} was removed while appending",
                path.display()
            ));
        };
        if len > effective_trim_trigger() {
            // The rename inside the trim replaces the inode, so the cached
            // append handle must not survive it; the next append reopens.
            self.file = None;
            trim_scrollback_file(path, len)?;
        }
        Ok(())
    }

    /// One append attempt. Returns the post-append file length, or `None` when
    /// the write landed in an inode that is no longer linked at `path`.
    fn append_once(&mut self, path: &Path, chunk: &[u8]) -> Result<Option<u64>, String> {
        if self.file.is_none() {
            prepare_scrollback_dir(path)?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                // Owner-only: the log is as sensitive as the socket the same
                // codebase locks to 0600.
                .mode(0o600)
                .open(path)
                .map_err(|err| format!("failed to open scrollback {}: {err}", path.display()))?;
            self.file = Some(file);
        }
        let file = self
            .file
            .as_mut()
            .expect("scrollback handle was just opened");
        file.write_all(chunk)
            .map_err(|err| format!("failed to append scrollback {}: {err}", path.display()))?;
        // fstat on the open handle instead of a path stat: the post-append
        // length decides whether the trim trigger tripped, and the link count
        // tells us whether the file still exists at its path at all.
        let metadata = file
            .metadata()
            .map_err(|err| format!("failed to stat scrollback {}: {err}", path.display()))?;
        if metadata.nlink() == 0 {
            return Ok(None);
        }
        Ok(Some(metadata.len()))
    }
}

/// The pane's log entry, created on first use. Removal drops the entry (see
/// `remove_pane_scrollback`), so the map tracks only live panes.
fn pane_log(path: &Path) -> Arc<Mutex<PaneLog>> {
    let mut logs = PANE_LOGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    logs.entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(PaneLog { file: None })))
        .clone()
}

/// The pane's log entry only if one already exists, without inserting. Reads use
/// this so a read of a pane that has no live writer (a closed pane whose entry
/// was dropped, or one only ever read) doesn't leave a permanent empty entry
/// behind, which over a long session would accumulate one per such pane id.
fn existing_pane_log(path: &Path) -> Option<Arc<Mutex<PaneLog>>> {
    PANE_LOGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .cloned()
}

/// Locks a pane's log entry, recovering from poisoning: the entry guards a
/// file handle whose worst post-panic state is a partially appended chunk,
/// which the next append and replay tolerate.
fn lock_pane_log(entry: &Arc<Mutex<PaneLog>>) -> MutexGuard<'_, PaneLog> {
    entry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn read_pane_scrollback(workspace_root: &Path, pane_id: &str) -> Result<Vec<u8>, String> {
    let path = pane_scrollback_path(workspace_root, pane_id)?;
    // Serialize against a concurrent append/trim of this pane by holding its log
    // lock while reading — but only if the pane has a live entry. A trim's swap
    // is an atomic rename, so a lock-free read of a pane with no active writer
    // still sees a whole file, never a half-written one.
    let entry = existing_pane_log(&path);
    let _log = entry.as_ref().map(lock_pane_log);
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
    let path = pane_scrollback_path(workspace_root, pane_id)?;
    let entry = pane_log(&path);
    let mut log = lock_pane_log(&entry);
    log.append(&path, chunk)
}

/// Creates (and permission-locks) the scrollback directory for `path`. Only
/// runs when a pane (re)opens its log handle, not per chunk.
fn prepare_scrollback_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
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
    Ok(())
}

pub fn remove_pane_scrollback(workspace_root: &Path, pane_id: &str) -> Result<(), String> {
    let path = pane_scrollback_path(workspace_root, pane_id)?;
    // Drop the map entry first so the pane stops accumulating state, then close
    // the handle and unlink under the entry lock so an in-flight append (a
    // reader thread that already cloned the Arc) can't interleave with the
    // removal. A late append after this simply recreates the file, matching the
    // old global-lock behavior.
    let entry = PANE_LOGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&path);
    let _log = entry.as_ref().map(|entry| {
        let mut log = lock_pane_log(entry);
        log.file = None;
        log
    });
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "failed to remove scrollback {}: {err}",
            path.display()
        )),
    }
}

/// Removes scrollback logs and trim scratch files that no live pane owns.
///
/// Run once at startup, after recovery has respawned the panes that are coming
/// back. A clean quit deliberately preserves every open pane's log so recovery
/// can replay it (see the exit-teardown guard in `remove_pane`), and a crash or
/// kill leaves them all behind — so without this, the log of any pane that will
/// never return (a session lost to a kill, an agent that exited and was not
/// respawned) lingers on disk forever holding raw terminal output, which the
/// same log's directory hardening treats as secret-bearing. A `<pane_id>.pty`
/// whose id is neither in `live_pane_ids` nor already reopened by a live append
/// handle is such an orphan and is deleted. Trim scratch files
/// (`<pane_id>.trim.<pid>.tmp`) stranded by a process killed between the synced
/// temp write and the rename are swept by dead writer pid, mirroring the state
/// dir's own scratch cleanup. Best-effort throughout: leftovers are only
/// clutter, and a recycled pid just postpones one temp file's removal.
pub fn remove_orphaned_scrollback(workspace_root: &Path, live_pane_ids: &HashSet<String>) {
    let dir = workspace_root.join(STATE_DIR).join(SCROLLBACK_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let log_suffix = format!(".{LOG_EXTENSION}");
    // Hold the map lock across the sweep so a pane created in the startup window
    // (its id absent from the captured `live_pane_ids`) is still recognized as
    // live the moment its reader opens an append handle, instead of racing us to
    // a delete.
    let live_logs = PANE_LOGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if let Some(pid) = trim_scratch_writer_pid(name) {
            if pid != std::process::id() && !crate::persistence::process_is_alive(pid) {
                let _ = fs::remove_file(&path);
            }
            continue;
        }
        let Some(pane_id) = name.strip_suffix(&log_suffix) else {
            continue;
        };
        if live_pane_ids.contains(pane_id) || live_logs.contains_key(&path) {
            continue;
        }
        let _ = fs::remove_file(&path);
    }
}

/// Parses the writer pid out of a `<pane_id>.trim.<pid>.tmp` trim scratch name.
/// Returns `None` for anything else (the live `.pty` logs, foreign files), which
/// the sweep then leaves alone. Pane ids never contain `.` (see
/// `pane_scrollback_path`), so the `.trim.` marker is unambiguous.
fn trim_scratch_writer_pid(name: &str) -> Option<u32> {
    let rest = name.strip_suffix(".tmp")?;
    let (rest, pid) = rest.rsplit_once('.')?;
    if !rest.ends_with(".trim") {
        return None;
    }
    pid.parse().ok()
}

/// Rewrites the log down to the newest `effective_scrollback_cap()` bytes. Only
/// called once the file has grown past `effective_trim_trigger()`, so the
/// rewrite cost is amortized over the slack instead of paid per append.
fn trim_scrollback_file(path: &Path, len: u64) -> Result<(), String> {
    // Bound the peak memory of simultaneous trims. Held for the whole rewrite;
    // released on drop at function exit (including the error paths below).
    let _permit = TrimPermit::acquire();
    let mut file = fs::File::open(path)
        .map_err(|err| format!("failed to reopen scrollback {}: {err}", path.display()))?;
    let mut captured = Vec::with_capacity(len as usize);
    file.read_to_end(&mut captured)
        .map_err(|err| format!("failed to trim scrollback {}: {err}", path.display()))?;
    // Canonicalize on each bounded rewrite. Besides making restored output
    // inert, this preserves alternate-screen state across future appends with
    // a synthetic entry marker: if a noisy TUI alone exceeds the byte cap,
    // later chunks must not become apparent primary-screen history merely
    // because the real entry sequence fell off the front of the file.
    let (canonical, alternate_screen) = sanitize_scrollback_replay_with_state(&captured);
    let marker = alternate_screen.then_some(b"\x1b[?1049h".as_slice());
    let retained_cap = effective_scrollback_cap() as usize - marker.map_or(0, <[u8]>::len);
    let keep_from = canonical.len().saturating_sub(retained_cap);
    // The cap is a raw byte offset, so it can land inside a multi-byte UTF-8
    // scalar or an SGR/cursor escape and leave the retained tail beginning with
    // orphaned continuation bytes (rendered as replacement chars) or a stripped
    // escape's stray parameter digits (rendered literally) at the top of every
    // restored scrollback. Nudge the cut forward to the next line boundary,
    // which escapes and scalars almost never straddle.
    let keep_from = safe_cut_boundary(&canonical, keep_from);
    let mut tail = canonical[keep_from..].to_vec();
    if let Some(marker) = marker {
        tail.extend_from_slice(marker);
    }
    // Rewrite atomically: write the retained tail to a sibling temp file, then
    // rename it over the log. An in-place `fs::write` truncates the file before
    // writing, so a crash mid-write could leave the scrollback empty or
    // half-written; the temp + rename swap is all-or-nothing. Callers hold the
    // pane's scrollback log lock, so the temp name can't collide with a
    // concurrent trim of the same file.
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

/// Returns the newest `cap` bytes of a captured log, nudged forward to a line
/// boundary so the tail doesn't begin mid-scalar when it is later replayed.
/// Used to bound the scrollback an undo snapshot keeps resident: the durable
/// log is deleted when a pane closes, so the snapshot is the only copy, and the
/// undo stack holds many of them — storing each full multi-MB log would pin
/// hundreds of MB for a convenience buffer. Buffers already within `cap` are
/// returned as-is (no copy).
pub fn bounded_scrollback_tail(bytes: Vec<u8>, cap: usize) -> Vec<u8> {
    if bytes.len() <= cap {
        return bytes;
    }
    let start = safe_cut_boundary(&bytes, bytes.len() - cap);
    bytes[start..].to_vec()
}

/// Advances a raw cut offset to a safe boundary so the retained tail doesn't
/// begin mid-scalar or mid-escape. Prefers the byte after the next `\n` (a line
/// boundary is virtually never straddled by a UTF-8 scalar or an ANSI escape),
/// searching only a bounded window so a marker-free blob can't shift the cut far
/// off the cap; failing that, at least steps past any UTF-8 continuation bytes
/// so the tail starts on a lead byte. Only ever moves the cut forward, so the
/// retained tail stays within the byte cap.
fn safe_cut_boundary(bytes: &[u8], start: usize) -> usize {
    // `start == 0` means the whole canonical buffer fit under the cap — keep it
    // all rather than trimming a first line off untrimmed history.
    if start == 0 || start >= bytes.len() {
        return start.min(bytes.len());
    }
    const LINE_SCAN_WINDOW: usize = 8 * 1024;
    let limit = (start + LINE_SCAN_WINDOW).min(bytes.len());
    if let Some(offset) = bytes[start..limit].iter().position(|&byte| byte == b'\n') {
        return start + offset + 1;
    }
    let mut index = start;
    while index < bytes.len() && (0x80..=0xbf).contains(&bytes[index]) {
        index += 1;
    }
    index
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

/// Converts a captured PTY byte stream into inert historical output suitable
/// for feeding into a fresh terminal surface. String controls can mutate host
/// state (title, clipboard, notifications, images), mode changes can leak into
/// the resumed process, and alternate-screen repaint traffic is not scrollback;
/// discard all three while preserving ordinary cursor/erase/SGR rendering.
pub fn sanitize_scrollback_replay(bytes: &[u8]) -> Vec<u8> {
    sanitize_scrollback_replay_with_state(bytes).0
}

fn sanitize_scrollback_replay_with_state(bytes: &[u8]) -> (Vec<u8>, bool) {
    const ESC: u8 = 0x1b;
    const BEL: u8 = 0x07;
    const CSI: u8 = 0x9b;
    const OSC: u8 = 0x9d;
    const DCS: u8 = 0x90;
    const SOS: u8 = 0x98;
    const PM: u8 = 0x9e;
    const APC: u8 = 0x9f;
    const ST: u8 = 0x9c;

    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut alternate_screen = false;

    while index < bytes.len() {
        // Multi-byte UTF-8 text must be consumed whole: its continuation bytes
        // share 0x80-0x9f with raw C1 controls, so scanning them individually
        // would open a phantom string control inside e.g. an emoji and swallow
        // everything after it. `c1_control_at` is checked first only so that a
        // C2-prefixed C1 (a real control character in UTF-8) keeps its control
        // handling below.
        if c1_control_at(bytes, index).is_none() {
            let utf8_len = valid_utf8_sequence_len(bytes, index);
            if utf8_len > 1 {
                if !alternate_screen {
                    output.extend_from_slice(&bytes[index..index + utf8_len]);
                }
                index += utf8_len;
                continue;
            }
        }

        let (code, prefix_len) = c1_control_at(bytes, index)
            .map(|control| (control.0, control.1))
            .unwrap_or((bytes[index], 1));

        if code == CSI || (code == ESC && bytes.get(index + 1) == Some(&b'[')) {
            let start = index + if code == CSI { prefix_len } else { 2 };
            let Some(end) = find_csi_end(bytes, start) else {
                break;
            };
            let csi = parse_csi(bytes, start, end);
            let alternate_set = csi.is_alternate_screen(b'h');
            let alternate_reset = csi.is_alternate_screen(b'l');
            if alternate_set {
                alternate_screen = true;
            }
            let discard = alternate_screen
                || alternate_set
                || alternate_reset
                || matches!(csi.final_byte, b'h' | b'l' | b'c' | b'n')
                // Kitty's keyboard protocol uses private CSI-u forms to
                // push, pop, set, and query progressive-enhancement flags.
                // Replaying an agent's historical push into a fresh surface
                // leaves release-event reporting active after the resumed
                // agent exits and pops only its own live push. Queries are
                // stateful too: replaying one writes a reply into the fresh
                // PTY's input stream. Plain CSI-u remains valid ANSI cursor
                // restoration, so only discard the private forms.
                || csi.is_kitty_keyboard_control()
                // Window manipulation includes resize and state queries. It
                // can call back into the host instead of merely drawing.
                || csi.final_byte == b't'
                || (csi.final_byte == b'p' && csi.intermediates.as_slice() == b"$")
                // XTMODKEYS (CSI > ... m) changes key encoding — terminal
                // mode, not rendering — and XTQMODKEYS (CSI ? ... m) is a
                // query whose replay would write a reply into the fresh
                // PTY's input stream. Plain SGR (no prefix) stays.
                || (csi.final_byte == b'm'
                    && matches!(csi.parameter_prefix, Some(b'>' | b'?')));
            if !discard {
                output.extend_from_slice(&bytes[index..=end]);
            }
            if alternate_reset {
                alternate_screen = false;
            }
            index = end + 1;
            continue;
        }

        if matches!(code, OSC | DCS | SOS | PM | APC) {
            let start = index + if code == ESC { 2 } else { prefix_len };
            let Some(end) = find_string_control_end(bytes, start, code == OSC, BEL, ST) else {
                break;
            };
            index = end;
            continue;
        }

        if code == ESC {
            let Some(next) = bytes.get(index + 1).copied() else {
                break;
            };
            if matches!(next, b']' | b'P' | b'X' | b'^' | b'_') {
                let Some(end) = find_string_control_end(bytes, index + 2, next == b']', BEL, ST)
                else {
                    break;
                };
                index = end;
                continue;
            }
            if next == b'c' {
                index += 2;
                continue;
            }
            // DECKPAM/DECKPNM switch the keypad between application and
            // numeric encoding — terminal mode, not rendering. A TUI that
            // died with application keypad active must not re-latch it onto
            // the fresh surface through replayed history.
            if next == b'=' || next == b'>' {
                index += 2;
                continue;
            }
            if alternate_screen {
                index += 2;
                continue;
            }
            output.push(ESC);
            index += 1;
            continue;
        }

        if !alternate_screen {
            output.extend_from_slice(&bytes[index..index + prefix_len]);
        }
        index += prefix_len;
    }

    (output, alternate_screen)
}

struct ParsedCsi {
    final_byte: u8,
    intermediates: Vec<u8>,
    parameter_prefix: Option<u8>,
    params: Vec<u32>,
}

impl ParsedCsi {
    fn is_alternate_screen(&self, final_byte: u8) -> bool {
        self.parameter_prefix == Some(b'?')
            && self.final_byte == final_byte
            && self
                .params
                .iter()
                .any(|param| matches!(param, 47 | 1047 | 1049))
    }

    fn is_kitty_keyboard_control(&self) -> bool {
        self.final_byte == b'u' && matches!(self.parameter_prefix, Some(b'<' | b'=' | b'>' | b'?'))
    }
}

fn find_csi_end(bytes: &[u8], start: usize) -> Option<usize> {
    (start..bytes.len()).find(|index| (0x40..=0x7e).contains(&bytes[*index]))
}

fn parse_csi(bytes: &[u8], start: usize, end: usize) -> ParsedCsi {
    let mut params = Vec::new();
    let mut intermediates = Vec::new();
    let mut parameter_prefix = None;
    let mut current = None::<u32>;

    for byte in bytes[start..end].iter().copied() {
        match byte {
            b'<'..=b'?' if parameter_prefix.is_none() && params.is_empty() && current.is_none() => {
                parameter_prefix = Some(byte);
            }
            b'0'..=b'9' => {
                current = Some(
                    current
                        .unwrap_or_default()
                        .saturating_mul(10)
                        .saturating_add(u32::from(byte - b'0')),
                );
            }
            b';' | b':' => {
                params.push(current.take().unwrap_or_default());
            }
            0x20..=0x2f => {
                if let Some(value) = current.take() {
                    params.push(value);
                }
                intermediates.push(byte);
            }
            _ => {
                if let Some(value) = current.take() {
                    params.push(value);
                }
            }
        }
    }
    if let Some(value) = current {
        params.push(value);
    }
    ParsedCsi {
        final_byte: bytes[end],
        intermediates,
        parameter_prefix,
        params,
    }
}

fn find_string_control_end(
    bytes: &[u8],
    start: usize,
    allow_bel: bool,
    bel: u8,
    st: u8,
) -> Option<usize> {
    // CAN and SUB abort any string/escape sequence in the VT parser, returning
    // the stream to ground. Honoring them here is what keeps a *truncated*
    // string control (an OSC/DCS a program emitted but never terminated before
    // it was killed, or a raw ESC-] that landed in `cat`ed binary) from
    // swallowing every byte after it: without an abort, an unterminated control
    // scans to the next stray ST/BEL or to EOF, and at EOF the caller drops the
    // entire remainder. Most consequentially, `RESTORED_SCROLLBACK_TERMINAL_RESET`
    // opens with CAN precisely to cancel a sequence a dead TUI left dangling —
    // so a sanitizer that ignored CAN would let a dangling control eat the reset
    // and all the surviving shell's history behind it.
    const CAN: u8 = 0x18;
    const SUB: u8 = 0x1a;
    let mut index = start;
    while index < bytes.len() {
        if let Some((code, len)) = c1_control_at(bytes, index) {
            if code == st {
                return Some(index + len);
            }
            index += len;
            continue;
        }
        let byte = bytes[index];
        if byte == CAN || byte == SUB {
            return Some(index + 1);
        }
        if allow_bel && byte == bel {
            return Some(index + 1);
        }
        if byte == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
            return Some(index + 2);
        }
        index += valid_utf8_sequence_len(bytes, index).max(1);
    }
    None
}

fn c1_control_at(bytes: &[u8], index: usize) -> Option<(u8, usize)> {
    let first = *bytes.get(index)?;
    if (0x80..=0x9f).contains(&first) {
        return Some((first, 1));
    }
    let second = bytes.get(index + 1).copied()?;
    (first == 0xc2 && (0x80..=0x9f).contains(&second)).then_some((second, 2))
}

fn valid_utf8_sequence_len(bytes: &[u8], index: usize) -> usize {
    let Some(first) = bytes.get(index).copied() else {
        return 0;
    };
    let byte_in = |offset: usize, range: std::ops::RangeInclusive<u8>| {
        bytes
            .get(index + offset)
            .is_some_and(|byte| range.contains(byte))
    };
    let continuation = |offset: usize| byte_in(offset, 0x80..=0xbf);
    match first {
        0xc2..=0xdf if continuation(1) => 2,
        // E0 must not encode an overlong value; ED must not encode a UTF-16
        // surrogate. The middle range has no special second-byte constraint.
        0xe0 if byte_in(1, 0xa0..=0xbf) && continuation(2) => 3,
        0xe1..=0xec | 0xee..=0xef if continuation(1) && continuation(2) => 3,
        0xed if byte_in(1, 0x80..=0x9f) && continuation(2) => 3,
        // F0 must not encode an overlong value, while F4 is capped at
        // U+10FFFF. F1-F3 accept the full continuation-byte range.
        0xf0 if byte_in(1, 0x90..=0xbf) && continuation(2) && continuation(3) => 4,
        0xf1..=0xf3 if continuation(1) && continuation(2) && continuation(3) => 4,
        0xf4 if byte_in(1, 0x80..=0x8f) && continuation(2) && continuation(3) => 4,
        _ => 0,
    }
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
        let large = vec![b'a'; effective_trim_trigger() as usize];

        // Exactly at the trigger: no trim yet (hysteresis slack, not the cap,
        // bounds the on-disk file between trims).
        append_pane_scrollback(&workspace, "pane-1", &large).unwrap();
        assert_eq!(
            read_pane_scrollback(&workspace, "pane-1").unwrap().len(),
            effective_trim_trigger() as usize
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

    // More panes trim at once than there are permits, so some trims must wait
    // on the semaphore. They must all still complete correctly and release their
    // slots — no deadlock, no cross-pane corruption under the shared permit.
    #[test]
    fn concurrent_trims_exceeding_the_permit_ceiling_all_complete() {
        let workspace = temp_workspace();
        let panes = MAX_CONCURRENT_TRIMS * 2;
        let handles: Vec<_> = (0..panes)
            .map(|i| {
                let workspace = workspace.clone();
                std::thread::spawn(move || {
                    let pane = format!("pane-{i}");
                    let mut data = vec![b'a'; effective_trim_trigger() as usize];
                    data.extend_from_slice(b"tail");
                    append_pane_scrollback(&workspace, &pane, &data).unwrap();
                    let restored = read_pane_scrollback(&workspace, &pane).unwrap();
                    assert_eq!(restored.len(), SCROLLBACK_LOG_CAP as usize);
                    assert!(restored.ends_with(b"tail"));
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    }

    #[test]
    fn cap_scales_with_rows_between_the_default_floor_and_the_ceiling() {
        // Low / default row counts stay at the historical 8MB floor.
        assert_eq!(cap_bytes_for_rows(0), SCROLLBACK_LOG_CAP);
        assert_eq!(cap_bytes_for_rows(1_000), SCROLLBACK_LOG_CAP);
        // Deeper scrollback scales the durable cap up...
        let mid = cap_bytes_for_rows(60_000);
        assert!(mid > SCROLLBACK_LOG_CAP && mid < MAX_SCROLLBACK_LOG_CAP);
        // ...but a huge setting is clamped at the ceiling, not unbounded.
        assert_eq!(cap_bytes_for_rows(u32::MAX), MAX_SCROLLBACK_LOG_CAP);
    }

    #[test]
    fn bounded_scrollback_tail_keeps_recent_bytes_on_a_boundary() {
        // Under the cap: returned verbatim.
        assert_eq!(
            bounded_scrollback_tail(b"short".to_vec(), 1024),
            b"short".to_vec()
        );
        // Over the cap: the newest bytes, beginning at a line boundary.
        let input = b"line one\nline two\nline three\n".to_vec();
        let tail = bounded_scrollback_tail(input, 12);
        assert!(tail.len() <= 12);
        assert_eq!(tail, b"line three\n".to_vec());
    }

    #[test]
    fn safe_cut_boundary_prefers_the_next_line_start() {
        // Mid-line cut jumps to just after the next newline.
        assert_eq!(safe_cut_boundary(b"aaa\nbbb\nccc", 1), 4);
        assert_eq!(safe_cut_boundary(b"aaa\nbbb\nccc", 4), 8);
        // Offset 0 keeps everything (canonical fit under the cap).
        assert_eq!(safe_cut_boundary(b"aaa\nbbb", 0), 0);
        // Past the end clamps to the length.
        assert_eq!(safe_cut_boundary(b"aaa", 9), 3);
    }

    #[test]
    fn safe_cut_boundary_skips_utf8_continuation_bytes_without_a_newline() {
        // "é界" = C3 A9 E4 B8 96, no newline anywhere. Cutting at offset 1 (a
        // continuation byte) advances to the next lead byte at offset 2.
        let bytes = "é界".as_bytes();
        assert_eq!(bytes[0], 0xc3);
        assert_eq!(safe_cut_boundary(bytes, 1), 2);
        // Already on a lead byte with no newline: left where it is.
        assert_eq!(safe_cut_boundary(bytes, 2), 2);
    }

    // A raw byte cut at the cap can split a UTF-8 scalar and leave the restored
    // tail starting with orphaned continuation bytes. The boundary nudge must
    // land the tail on a line start, keeping it valid UTF-8.
    #[test]
    fn trim_keeps_the_retained_tail_on_a_scalar_boundary() {
        let workspace = temp_workspace();
        let line = "héllo-世界\n".as_bytes();
        let count = (effective_trim_trigger() as usize / line.len()) + 2;
        let mut data = Vec::with_capacity(count * line.len());
        for _ in 0..count {
            data.extend_from_slice(line);
        }
        append_pane_scrollback(&workspace, "pane-1", &data).unwrap();

        let restored = read_pane_scrollback(&workspace, "pane-1").unwrap();
        assert!(restored.len() <= SCROLLBACK_LOG_CAP as usize);
        assert!(
            std::str::from_utf8(&restored).is_ok(),
            "retained tail must not begin mid-scalar"
        );
        assert!(
            restored.starts_with(line),
            "retained tail should begin at a line boundary"
        );
    }

    #[test]
    fn append_recreates_an_externally_removed_scrollback_dir() {
        let workspace = temp_workspace();

        append_pane_scrollback(&workspace, "pane-1", b"before").unwrap();
        // Simulate an external cleaner removing the whole terminal dir while
        // the app runs; the prepared-dir cache must self-heal, not fail every
        // append until restart.
        fs::remove_dir_all(
            pane_scrollback_path(&workspace, "pane-1")
                .unwrap()
                .parent()
                .unwrap(),
        )
        .unwrap();
        append_pane_scrollback(&workspace, "pane-1", b"after").unwrap();

        assert_eq!(
            read_pane_scrollback(&workspace, "pane-1").unwrap(),
            b"after"
        );
    }

    #[test]
    fn reading_scrollback_does_not_leak_a_map_entry() {
        let workspace = temp_workspace();
        let path = pane_scrollback_path(&workspace, "pane-1").unwrap();
        let present = |path: &Path| {
            PANE_LOGS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(path)
        };

        // A read of a never-appended pane returns empty and inserts nothing.
        assert!(read_pane_scrollback(&workspace, "pane-1").unwrap().is_empty());
        assert!(!present(&path), "read must not insert a map entry");

        // A leftover log from a previous process (on disk, no writer) still
        // reads correctly, still without leaving an entry behind.
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"from a previous process").unwrap();
        assert_eq!(
            read_pane_scrollback(&workspace, "pane-1").unwrap(),
            b"from a previous process"
        );
        assert!(!present(&path), "read must not insert a map entry");
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

    // Removal must invalidate the pane's cached append handle: a later append
    // (e.g. a reused pane id) has to recreate the log rather than write into
    // the unlinked inode the old handle still points at.
    #[test]
    fn append_after_remove_recreates_the_log() {
        let workspace = temp_workspace();

        append_pane_scrollback(&workspace, "pane-1", b"old").unwrap();
        remove_pane_scrollback(&workspace, "pane-1").unwrap();
        append_pane_scrollback(&workspace, "pane-1", b"new").unwrap();

        assert_eq!(read_pane_scrollback(&workspace, "pane-1").unwrap(), b"new");
    }

    #[test]
    fn orphaned_scrollback_logs_are_swept_by_liveness() {
        let workspace = temp_workspace();
        append_pane_scrollback(&workspace, "pane-live", b"keep me").unwrap();
        // Model a log left by a previous process: on disk, with no in-memory
        // append handle. Written directly so PANE_LOGS holds no entry for it.
        let dead_path = pane_scrollback_path(&workspace, "pane-dead").unwrap();
        fs::create_dir_all(dead_path.parent().unwrap()).unwrap();
        fs::write(&dead_path, b"drop me").unwrap();

        let live: HashSet<String> = ["pane-live".to_string()].into_iter().collect();
        remove_orphaned_scrollback(&workspace, &live);

        assert_eq!(
            read_pane_scrollback(&workspace, "pane-live").unwrap(),
            b"keep me"
        );
        assert!(!dead_path.exists(), "orphaned log should be removed");
    }

    #[test]
    fn orphaned_sweep_keeps_a_pane_with_a_live_append_handle() {
        let workspace = temp_workspace();
        // The pane id is absent from the captured live set (as if created in the
        // startup window), but its append handle is open — the sweep must keep it.
        append_pane_scrollback(&workspace, "pane-racing", b"live output").unwrap();

        remove_orphaned_scrollback(&workspace, &HashSet::new());

        assert_eq!(
            read_pane_scrollback(&workspace, "pane-racing").unwrap(),
            b"live output"
        );
    }

    #[test]
    fn orphaned_sweep_removes_dead_pid_trim_scratch_only() {
        let workspace = temp_workspace();
        let dir = workspace.join(STATE_DIR).join(SCROLLBACK_DIR);
        fs::create_dir_all(&dir).unwrap();

        // A pid we know is dead: spawn a child, reap it, reuse its pid.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();

        let dead_scratch = dir.join(format!("pane-1.trim.{dead_pid}.tmp"));
        let live_scratch = dir.join(format!("pane-1.trim.{}.tmp", std::process::id()));
        fs::write(&dead_scratch, b"stranded").unwrap();
        fs::write(&live_scratch, b"in flight").unwrap();

        remove_orphaned_scrollback(&workspace, &HashSet::new());

        assert!(!dead_scratch.exists(), "dead-pid trim scratch should be swept");
        assert!(
            live_scratch.exists(),
            "a live process's in-flight trim scratch must be left alone"
        );
    }

    #[test]
    fn trim_scratch_writer_pid_parses_only_trim_temps() {
        assert_eq!(trim_scratch_writer_pid("pane-1.trim.4321.tmp"), Some(4321));
        assert_eq!(trim_scratch_writer_pid("pane-1.pty"), None);
        assert_eq!(trim_scratch_writer_pid("pane-1.trim.tmp"), None);
        assert_eq!(trim_scratch_writer_pid("pane-1.trim.notpid.tmp"), None);
    }

    #[test]
    fn replay_sanitizer_removes_host_controls_modes_and_queries() {
        let input = b"before\r\n\x1b]0;secret title\x07\x1bPpayload\x07still payload\x1b\\\x1b[?2004hprompt \x1b[c\x1b[6n\x1b[8;50;120t";
        assert_eq!(sanitize_scrollback_replay(input), b"before\r\nprompt ");
    }

    #[test]
    fn replay_sanitizer_removes_kitty_keyboard_controls_and_queries() {
        let input = b"before\x1b[>7u\x1b[?u\x1b[=3;2u\x1b[<u\x9b>7u\xc2\x9b?uafter";

        assert_eq!(sanitize_scrollback_replay(input), b"beforeafter");
    }

    #[test]
    fn replay_sanitizer_preserves_plain_csi_u_cursor_restore() {
        let input = b"before\x1b[uafter";

        assert_eq!(sanitize_scrollback_replay(input), input);
    }

    #[test]
    fn replay_sanitizer_removes_modify_other_keys_controls_and_queries() {
        // XTMODKEYS set/reset and the XTQMODKEYS query; plain SGR survives.
        let input = b"before\x1b[>4;2m\x1b[>4m\x1b[?4m\x1b[1;32mok\x1b[0mafter";

        assert_eq!(
            sanitize_scrollback_replay(input),
            b"before\x1b[1;32mok\x1b[0mafter"
        );
    }

    #[test]
    fn replay_sanitizer_removes_keypad_mode_switches() {
        // DECKPAM/DECKPNM are terminal mode, not rendering: a TUI that died
        // with application keypad active must not re-latch it via replay.
        let input = b"before\x1b=middle\x1b>after";

        assert_eq!(sanitize_scrollback_replay(input), b"beforemiddleafter");
    }

    #[test]
    fn replay_sanitizer_handles_oversized_csi_parameters_without_panicking() {
        let input = b"before\x1b[999999999999999999999999999999999999Gafter";
        assert_eq!(sanitize_scrollback_replay(input), input);
    }

    #[test]
    fn replay_sanitizer_drops_alternate_screen_output() {
        let input = b"before\r\n\x1b[?1049h\x1b[2Jhidden tui\r\n\x1b[?1049lafter\r\n";
        assert_eq!(sanitize_scrollback_replay(input), b"before\r\nafter\r\n");
    }

    #[test]
    fn replay_sanitizer_preserves_sgr_cursor_and_utf8() {
        let input = "\x1b[38;2;10;20;30mhello\x1b[6G世界\x1b[39m\r\n".as_bytes();
        assert_eq!(sanitize_scrollback_replay(input), input);
    }

    // Continuation bytes of these characters fall in 0x80-0x9f: 😀 ends in
    // 0x9f 0x98 0x80 (APC/SOS), ” ends in 0x9d (OSC), ⠛ ends in 0x9b (CSI),
    // ם ends in 0x9d. None may be read as a raw C1 control.
    #[test]
    fn replay_sanitizer_preserves_utf8_with_c1_valued_continuation_bytes() {
        let input = "before 😀 “quoted” ⠛ שלום after\r\nmore output\r\n".as_bytes();
        assert_eq!(sanitize_scrollback_replay(input), input);
    }

    #[test]
    fn replay_sanitizer_still_strips_c2_prefixed_c1_string_controls() {
        let input = b"before\xc2\x9d0;secret title\x07after";
        assert_eq!(sanitize_scrollback_replay(input), b"beforeafter");
    }

    #[test]
    fn replay_sanitizer_does_not_hide_c1_controls_in_invalid_utf8() {
        for invalid_prefix in [
            &[0xe0, 0x80][..],       // Overlong three-byte sequence.
            &[0xed, 0xa0][..],       // UTF-16 surrogate.
            &[0xf0, 0x80, 0x80][..], // Overlong four-byte sequence.
        ] {
            let mut input = invalid_prefix.to_vec();
            input.extend_from_slice(b"\x9d0;secret title\x07after");

            let mut expected = invalid_prefix.to_vec();
            expected.extend_from_slice(b"after");
            assert_eq!(sanitize_scrollback_replay(&input), expected);
        }
    }

    #[test]
    fn utf8_sequence_length_enforces_scalar_value_boundaries() {
        for valid in [
            &[0xc2, 0xa0][..],
            &[0xe0, 0xa0, 0x80][..],
            &[0xed, 0x9f, 0xbf][..],
            &[0xf0, 0x90, 0x80, 0x80][..],
            &[0xf4, 0x8f, 0xbf, 0xbf][..],
        ] {
            assert_eq!(valid_utf8_sequence_len(valid, 0), valid.len());
        }
        for invalid in [
            &[0xc0, 0x80][..],
            &[0xe0, 0x9f, 0xbf][..],
            &[0xed, 0xa0, 0x80][..],
            &[0xf0, 0x8f, 0xbf, 0xbf][..],
            &[0xf4, 0x90, 0x80, 0x80][..],
            &[0xf5, 0x80, 0x80, 0x80][..],
        ] {
            assert_eq!(valid_utf8_sequence_len(invalid, 0), 0);
        }
    }

    #[test]
    fn replay_sanitizer_drops_utf8_text_inside_alternate_screen() {
        let input = "before\r\n\x1b[?1049h😀 hidden\r\n\x1b[?1049lafter\r\n".as_bytes();
        assert_eq!(sanitize_scrollback_replay(input), b"before\r\nafter\r\n");
    }

    #[test]
    fn replay_sanitizer_drops_unterminated_string_control_tail() {
        assert_eq!(
            sanitize_scrollback_replay(b"visible\r\n\x1b]0;unfinished"),
            b"visible\r\n"
        );
    }

    // An OSC with no terminator must not swallow the output that follows it.
    // CAN/SUB abort the sequence, so the bytes after the abort keep rendering
    // instead of being lost from the very byte the truncated control opened.
    #[test]
    fn replay_sanitizer_aborts_unterminated_string_control_on_can_or_sub() {
        assert_eq!(
            sanitize_scrollback_replay(b"before\x1b]0;stuck title\x18after"),
            b"beforeafter"
        );
        assert_eq!(
            sanitize_scrollback_replay(b"before\x1bPstuck payload\x1aafter"),
            b"beforeafter"
        );
    }

    // A TUI killed mid-OSC leaves the log holding an unterminated control.
    // `RESTORED_SCROLLBACK_TERMINAL_RESET` (recorded on agent exit) opens with a
    // CAN (`\x18`) precisely to cancel such a dangling sequence, so the reset
    // itself and the surviving shell's history behind it must not be eaten on
    // replay. The leading `\x18` here mirrors that reset.
    #[test]
    fn replay_sanitizer_lets_a_leading_can_rescue_a_dangling_control() {
        let input =
            b"scrollback line\r\n\x1b]8;;https://example.com/never-closed\x18\x1b[0m$ prompt after restore\r\n";

        let restored = sanitize_scrollback_replay(input);
        assert!(
            restored.starts_with(b"scrollback line\r\n"),
            "pre-dangle history should survive, got {restored:?}"
        );
        assert!(
            restored.ends_with(b"$ prompt after restore\r\n"),
            "history behind the dangling OSC must not be swallowed, got {restored:?}"
        );
    }

    #[test]
    fn trim_preserves_open_alternate_screen_state_for_future_appends() {
        let workspace = temp_workspace();
        let mut noisy_tui = b"before\r\n\x1b[?1049h".to_vec();
        noisy_tui.extend(std::iter::repeat_n(b'x', effective_trim_trigger() as usize));
        append_pane_scrollback(&workspace, "pane-1", &noisy_tui).unwrap();
        assert!(
            read_pane_scrollback(&workspace, "pane-1").unwrap().len()
                <= SCROLLBACK_LOG_CAP as usize
        );
        append_pane_scrollback(
            &workspace,
            "pane-1",
            b"still hidden\r\n\x1b[?1049lafter\r\n",
        )
        .unwrap();

        let restored = read_pane_scrollback(&workspace, "pane-1").unwrap();
        assert_eq!(
            sanitize_scrollback_replay(&restored),
            b"before\r\nafter\r\n"
        );
    }

    #[test]
    fn trim_counts_the_alternate_screen_marker_toward_the_cap() {
        let workspace = temp_workspace();
        let mut output = vec![b'a'; effective_trim_trigger() as usize];
        output.extend_from_slice(b"\x1b[?1049h");

        append_pane_scrollback(&workspace, "pane-1", &output).unwrap();

        let restored = read_pane_scrollback(&workspace, "pane-1").unwrap();
        assert_eq!(restored.len(), SCROLLBACK_LOG_CAP as usize);
        assert!(restored.ends_with(b"\x1b[?1049h"));
    }
}
