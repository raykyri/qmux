use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

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
/// 8MB read + synced write + rename — per PTY chunk, under the pane's
/// scrollback lock. The slack amortizes that to one rewrite per
/// `SCROLLBACK_TRIM_TRIGGER - SCROLLBACK_LOG_CAP` bytes of output, at the cost
/// of the on-disk file transiently exceeding the cap by up to the slack.
const SCROLLBACK_TRIM_TRIGGER: u64 = SCROLLBACK_LOG_CAP + SCROLLBACK_LOG_CAP / 2;

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
        if len > SCROLLBACK_TRIM_TRIGGER {
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
    let entry = pane_log(&path);
    let _log = lock_pane_log(&entry);
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

/// Rewrites the log down to the newest `SCROLLBACK_LOG_CAP` bytes. Only called
/// once the file has grown past `SCROLLBACK_TRIM_TRIGGER`, so the rewrite cost
/// is amortized over the slack instead of paid per append.
fn trim_scrollback_file(path: &Path, len: u64) -> Result<(), String> {
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
    let retained_cap = SCROLLBACK_LOG_CAP as usize - marker.map_or(0, <[u8]>::len);
    let keep_from = canonical.len().saturating_sub(retained_cap);
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
    let mut index = start;
    while index < bytes.len() {
        if let Some((code, len)) = c1_control_at(bytes, index) {
            if code == st {
                return Some(index + len);
            }
            index += len;
            continue;
        }
        if allow_bel && bytes[index] == bel {
            return Some(index + 1);
        }
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
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

    #[test]
    fn trim_preserves_open_alternate_screen_state_for_future_appends() {
        let workspace = temp_workspace();
        let mut noisy_tui = b"before\r\n\x1b[?1049h".to_vec();
        noisy_tui.extend(std::iter::repeat_n(b'x', SCROLLBACK_TRIM_TRIGGER as usize));
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
        let mut output = vec![b'a'; SCROLLBACK_TRIM_TRIGGER as usize];
        output.extend_from_slice(b"\x1b[?1049h");

        append_pane_scrollback(&workspace, "pane-1", &output).unwrap();

        let restored = read_pane_scrollback(&workspace, "pane-1").unwrap();
        assert_eq!(restored.len(), SCROLLBACK_LOG_CAP as usize);
        assert!(restored.ends_with(b"\x1b[?1049h"));
    }
}
