use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
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
    prepare_scrollback_dir(&path)?;

    let open_log = || {
        OpenOptions::new()
            .create(true)
            .append(true)
            // Owner-only: the log is as sensitive as the socket the same codebase
            // locks to 0600.
            .mode(0o600)
            .open(&path)
    };
    let mut file = match open_log() {
        Ok(file) => file,
        // The prepared-dir cache means the directory is normally never
        // re-checked; if something external removed it mid-run, self-heal by
        // evicting the cache entry and recreating it once, instead of failing
        // every append until restart (the pre-cache behavior recreated the dir
        // per chunk).
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if let (Ok(mut prepared), Some(parent)) = (PREPARED_DIRS.lock(), path.parent()) {
                prepared.remove(parent);
            }
            prepare_scrollback_dir(&path)?;
            open_log()
                .map_err(|err| format!("failed to open scrollback {}: {err}", path.display()))?
        }
        Err(err) => {
            return Err(format!(
                "failed to open scrollback {}: {err}",
                path.display()
            ));
        }
    };
    file.write_all(chunk)
        .map_err(|err| format!("failed to append scrollback {}: {err}", path.display()))?;
    // fstat on the open handle instead of a path stat: the post-append
    // length decides whether the trim trigger tripped.
    let len = file
        .metadata()
        .map_err(|err| format!("failed to stat scrollback {}: {err}", path.display()))?
        .len();
    drop(file);

    if len > SCROLLBACK_TRIM_TRIGGER {
        trim_scrollback_file(&path, len)?;
    }
    Ok(())
}

/// Creates (and permission-locks) the scrollback directory for `path` unless
/// this process has already prepared it. Callers hold `SCROLLBACK_IO_LOCK`.
fn prepare_scrollback_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let already_prepared = PREPARED_DIRS
        .lock()
        .map(|prepared| prepared.contains(parent))
        .unwrap_or(false);
    if already_prepared {
        return Ok(());
    }
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
                // Window manipulation includes resize and state queries. It
                // can call back into the host instead of merely drawing.
                || csi.final_byte == b't'
                || (csi.final_byte == b'p' && csi.intermediates.as_slice() == b"$");
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
    private: bool,
    params: Vec<u32>,
}

impl ParsedCsi {
    fn is_alternate_screen(&self, final_byte: u8) -> bool {
        self.private
            && self.final_byte == final_byte
            && self
                .params
                .iter()
                .any(|param| matches!(param, 47 | 1047 | 1049))
    }
}

fn find_csi_end(bytes: &[u8], start: usize) -> Option<usize> {
    (start..bytes.len()).find(|index| (0x40..=0x7e).contains(&bytes[*index]))
}

fn parse_csi(bytes: &[u8], start: usize, end: usize) -> ParsedCsi {
    let mut params = Vec::new();
    let mut intermediates = Vec::new();
    let mut private = false;
    let mut current = None::<u32>;

    for byte in bytes[start..end].iter().copied() {
        match byte {
            b'?' => private = true,
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
        private,
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

    #[test]
    fn replay_sanitizer_removes_host_controls_modes_and_queries() {
        let input = b"before\r\n\x1b]0;secret title\x07\x1bPpayload\x07still payload\x1b\\\x1b[?2004hprompt \x1b[c\x1b[6n\x1b[8;50;120t";
        assert_eq!(sanitize_scrollback_replay(input), b"before\r\nprompt ");
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
