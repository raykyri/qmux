//! Desktop-owned SSH transcript readers. Remote hooks supply metadata only;
//! all local destinations are derived here, never from a remote pathname.
use crate::events::QmuxEvent;
use crate::host::{self, Host, RemoteCommand};
use crate::state::AppState;
use qmux_cli::transcript_stream::{Cursor, Frame, MAX_CHUNK, MAX_FRAME};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    Arc, LazyLock, Mutex, Weak,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Binding {
    agent: String,
    pane: String,
    adapter: String,
    session: String,
    remote_id: String,
    remote_host: String,
    hint: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    roots: Vec<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Checkpoint {
    cursor: Cursor,
    generation: u64,
    source: String,
    #[serde(default)]
    digest: Vec<u8>,
    #[serde(skip)]
    verified: Option<VerifiedMirror>,
}

#[derive(PartialEq, Eq)]
struct MirrorStamp {
    device: u64,
    inode: u64,
    len: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl From<fs::Metadata> for MirrorStamp {
    fn from(meta: fs::Metadata) -> Self {
        Self {
            device: meta.dev(),
            inode: meta.ino(),
            len: meta.len(),
            mtime: (meta.mtime(), meta.mtime_nsec()),
            ctime: (meta.ctime(), meta.ctime_nsec()),
        }
    }
}
struct VerifiedMirror {
    stamp: MirrorStamp,
    hash: Sha256,
}

// Read the prefix once on recovery (or an unexpected metadata change), then
// extend its hash incrementally. Normal frame commits never reread old history.
fn verify_prefix(file: &mut fs::File, checkpoint: &mut Checkpoint) -> Result<bool, String> {
    let stamp = MirrorStamp::from(file.metadata().map_err(|e| e.to_string())?);
    if stamp.len < checkpoint.cursor.offset {
        return Ok(false);
    }
    if checkpoint
        .verified
        .as_ref()
        .is_some_and(|verified| verified.stamp == stamp)
    {
        return Ok(true);
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut remaining = checkpoint.cursor.offset;
    let mut buffer = [0; 64 * 1024];
    while remaining > 0 {
        let n = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..n])
            .map_err(|e| e.to_string())?;
        hash.update(&buffer[..n]);
        remaining -= n as u64;
    }
    if !checkpoint.digest.is_empty() && hash.clone().finalize()[..] != checkpoint.digest {
        return Ok(false);
    }
    // Legacy checkpoints lack a digest; retain their remote suffix check when
    // upgrading. Previously damaged bytes before that suffix are unknowable.
    if checkpoint.digest.is_empty() {
        let len = checkpoint.cursor.offset.min(256) as usize;
        file.seek(SeekFrom::Start(checkpoint.cursor.offset - len as u64))
            .map_err(|e| e.to_string())?;
        let mut anchor = vec![0; len];
        file.read_exact(&mut anchor).map_err(|e| e.to_string())?;
        if anchor != checkpoint.cursor.anchor {
            return Ok(false);
        }
    }
    if MirrorStamp::from(file.metadata().map_err(|e| e.to_string())?) != stamp {
        return Err("local transcript changed during verification".into());
    }
    checkpoint.digest = hash.clone().finalize().to_vec();
    checkpoint.verified = Some(VerifiedMirror { stamp, hash });
    Ok(true)
}

static READERS: LazyLock<Mutex<HashMap<PathBuf, Binding>>> = LazyLock::new(Default::default);
// The registry protects only lookup. Filesystem/model work is fenced by its
// agent root, so one slow mirror cannot block unrelated remote readers/hooks.
type RootGuard = Arc<Mutex<u64>>;
static ROOT_GUARDS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<u64>>>>> =
    LazyLock::new(Default::default);
fn root_guard(root: &Path) -> RootGuard {
    let mut roots = ROOT_GUARDS.lock().unwrap_or_else(|e| e.into_inner());
    roots.retain(|_, guard| guard.strong_count() > 0);
    if let Some(guard) = roots.get(root).and_then(Weak::upgrade) {
        return guard;
    }
    let guard = Arc::new(Mutex::new(0));
    roots.insert(root.to_path_buf(), Arc::downgrade(&guard));
    guard
}
fn current_binding(root: &Path) -> Result<Option<Binding>, String> {
    Ok(READERS
        .lock()
        .map_err(|e| e.to_string())?
        .get(root)
        .cloned())
}
fn current_reader(
    root: &Path,
    binding: &Binding,
    revision: u64,
    expected: u64,
) -> Result<bool, String> {
    Ok(revision == expected && current_binding(root)?.as_ref() == Some(binding))
}

fn encoded(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn directory(state: &AppState, agent: &str) -> PathBuf {
    state
        .config()
        .workspace_root
        .join("remote-transcripts")
        .join(encoded(agent))
}
fn session_directory(root: &Path, binding: &Binding) -> PathBuf {
    root.join(encoded(&binding.remote_id))
        .join(encoded(&binding.session))
}
fn mirror(dir: &Path, checkpoint: &Checkpoint, binding: &Binding) -> PathBuf {
    let extension = if binding.adapter == "devin" {
        "json"
    } else {
        "jsonl"
    };
    dir.join(checkpoint.generation.to_string())
        .join(format!("{}.{extension}", binding.session))
}
fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}

fn live_host(state: &AppState, binding: &Binding) -> Option<Host> {
    if !qmux_cli::transcript_stream::valid_session(&binding.session) {
        return None;
    }
    let agent = state.agent(&binding.agent).ok()??;
    if agent.pane_id.as_deref() != Some(binding.pane.as_str())
        || agent.session_id.as_deref() != Some(binding.session.as_str())
        || agent.adapter != binding.adapter
        || agent.fork_point.as_deref() == Some(binding.session.as_str())
        || agent.orphaned_queue_pane_id.is_some()
    {
        return None;
    }
    let pane = state
        .list_panes()
        .ok()?
        .into_iter()
        .find(|p| p.id == binding.pane)?;
    if pane.remote_session.as_ref()?.remote_id != binding.remote_id {
        return None;
    }
    let group = state.group(&agent.group_id).ok()??;
    let host = host::for_group(group.remote.as_ref());
    let remote = host.remote()?;
    (remote.id == binding.remote_id && remote.ssh == binding.remote_host).then_some(host)
}

/// Resolve provenance from the selected mirrored transcript, never the pane's live cwd.
/// Old mirrors without provenance fail closed rather than guessing a remote base.
pub fn preview_source(
    state: &AppState,
    pane: &str,
    transcript: &str,
) -> Result<(Host, String, Vec<String>, String), String> {
    let agent = state
        .agent_by_pane(pane)?
        .ok_or("No transcript agent for this pane")?;
    if agent.transcript_path.as_deref() != Some(transcript) {
        return Err("The selected transcript changed; open the link again".into());
    }
    let root = fs::canonicalize(directory(state, &agent.id))
        .map_err(|_| "Remote transcript provenance is unavailable")?;
    let path = fs::canonicalize(transcript).map_err(|_| "Remote transcript is unavailable")?;
    if !path.starts_with(&root) {
        return Err("Remote transcript provenance is unavailable".into());
    }
    let dir = path
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid transcript location")?;
    let binding: Binding = serde_json::from_slice(
        &fs::read(dir.join("preview-source.json"))
            .map_err(|_| "This transcript has no saved remote file context")?,
    )
    .map_err(|e| e.to_string())?;
    if binding.agent != agent.id
        || binding.cwd.is_empty()
        || dir != session_directory(&root, &binding)
    {
        return Err("Remote transcript provenance does not match this session".into());
    }
    let group = state
        .group(&agent.group_id)?
        .ok_or("Workspace is unavailable")?;
    let host = host::for_group(group.remote.as_ref());
    let remote = host
        .remote()
        .ok_or("The transcript's remote is unavailable")?;
    if remote.id != binding.remote_id || remote.ssh != binding.remote_host {
        return Err("The transcript's remote binding changed".into());
    }
    let identity = serde_json::to_string(&(
        binding.remote_id,
        binding.remote_host,
        binding.agent,
        binding.session,
    ))
    .map_err(|e| e.to_string())?;
    Ok((host, binding.cwd, binding.roots, identity))
}

/// Called only after adapter ingestion has accepted the session identity. Ignore
/// subagent and stale-session metadata rather than following a different session.
pub fn observe(state: &AppState, pane: &str, payload: &Value) {
    if payload.get("agent_id").is_some() || payload.get("agentId").is_some() {
        return;
    }
    let result = (|| -> Result<(), String> {
        let Some(agent) = state.agent_by_pane(pane)? else {
            return Ok(());
        };
        if !matches!(
            agent.adapter.as_str(),
            "claude" | "codex" | "devin" | "antigravity"
        ) {
            return Ok(());
        }
        let Some(session) = agent.session_id.clone() else {
            return Ok(());
        };
        if agent.fork_point.as_deref() == Some(session.as_str())
            || !qmux_cli::transcript_stream::valid_session(&session)
        {
            return Ok(());
        }
        let reported = payload
            .get("session_id")
            .or_else(|| payload.get("sessionId"))
            .or_else(|| payload.get("resource_id"))
            .or_else(|| payload.get("resourceId"))
            .and_then(Value::as_str);
        if reported.is_some_and(|id| id != session) {
            return Ok(());
        }
        let Some(group) = state.group(&agent.group_id)? else {
            return Ok(());
        };
        let host = host::for_group(group.remote.as_ref());
        let Some(remote) = host.remote() else {
            return Ok(());
        };
        let root = directory(state, &agent.id);
        let hint = payload
            .get("transcript_path")
            .or_else(|| payload.get("transcriptPath"))
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 8192)
            .unwrap_or("")
            .to_string();
        let mut binding = Binding {
            cwd: agent.worktree_dir.clone(),
            roots: vec![group.dir.clone(), agent.worktree_dir.clone()],
            agent: agent.id,
            pane: pane.into(),
            adapter: agent.adapter,
            session,
            remote_id: remote.id.clone(),
            remote_host: remote.ssh.clone(),
            hint,
        };
        let ready = live_host(state, &binding).is_some();
        // Launch reserves the agent binding before spawning SSH. A fast hook
        // can arrive before insert_pane; keep its path for that handoff.
        if !ready && state.list_panes()?.iter().any(|p| p.id == pane) {
            return Ok(());
        }
        let guard = root_guard(&root);
        let mut revision = guard.lock().map_err(|e| e.to_string())?;
        let previous = current_binding(&root)?;
        if binding.hint.is_empty() {
            let previous = previous.clone().or_else(|| {
                fs::read(root.join("binding.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Binding>(&bytes).ok())
            });
            if let Some(old) = previous
                && old.session == binding.session
                && old.remote_id == binding.remote_id
                && old.remote_host == binding.remote_host
                && old.adapter == binding.adapter
            {
                binding.hint = old.hint;
            }
        }
        let session_dir = session_directory(&root, &binding);
        fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;
        let source_path = session_dir.join("preview-source.json");
        if !source_path.exists() {
            save_json(&source_path, &binding)?;
        }
        if previous.as_ref() == Some(&binding) {
            return Ok(());
        }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        save_json(&root.join("binding.json"), &binding)?;
        if !ready {
            return Ok(());
        }
        let start = READERS
            .lock()
            .map_err(|e| e.to_string())?
            .insert(root.clone(), binding)
            .is_none();
        *revision += 1;
        drop(revision);
        if start {
            let state = state.clone();
            thread::spawn(move || worker(state, root, guard));
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("qmux: remote transcript setup: {error}");
    }
}

/// Reattach needs no fresh SessionStart: recover metadata persisted by the last
/// hook. Old hosts/sessions are checked against the current pane before use.
pub fn restore(state: &AppState, pane: &str) {
    let Ok(Some(agent)) = state.agent_by_pane(pane) else {
        return;
    };
    let root = directory(state, &agent.id);
    let guard = root_guard(&root);
    let Ok(mut revision) = guard.lock() else {
        return;
    };
    let Ok(bytes) = fs::read(root.join("binding.json")) else {
        // Existing panes from before streaming have a native session id but no
        // mirror metadata yet. Discover that session without waiting for a hook.
        drop(revision);
        observe(state, pane, &Value::Null);
        return;
    };
    let Ok(binding) = serde_json::from_slice::<Binding>(&bytes) else {
        return;
    };
    if binding.agent != agent.id || live_host(state, &binding).is_none() {
        return;
    }
    let Ok(previous) = current_binding(&root) else {
        return;
    };
    if previous.as_ref() == Some(&binding) {
        return;
    }
    let Ok(mut readers) = READERS.lock() else {
        return;
    };
    let start = readers.insert(root.clone(), binding).is_none();
    drop(readers);
    *revision += 1;
    drop(revision);
    if start {
        let state = state.clone();
        thread::spawn(move || worker(state, root, guard));
    }
}

fn notice(state: &AppState, binding: &Binding, message: Option<&str>) {
    state.emit(QmuxEvent::new(
        "transcript.notice",
        Some(binding.pane.clone()),
        Some(binding.agent.clone()),
        json!({"message": message}),
    ));
}

fn recover(dir: &Path, binding: &Binding) -> Result<Checkpoint, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("checkpoint.json");
    let restart_without_cursor = || -> Result<Checkpoint, String> {
        let mut generation = 0;
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if let Ok(value) = entry.file_name().to_string_lossy().parse::<u64>() {
                generation = generation.max(value);
            }
        }
        restart_checkpoint(
            &path,
            Checkpoint {
                generation,
                ..Default::default()
            },
        )
    };
    let mut checkpoint: Checkpoint = match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(checkpoint) => checkpoint,
            Err(_) => return restart_without_cursor(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return restart_without_cursor(),
        Err(e) => return Err(e.to_string()),
    };
    if !checkpoint.cursor.identity.is_empty() && checkpoint.digest.is_empty() {
        // Old checkpoints cannot attest to bytes before their 256-byte anchor.
        // Replay once on upgrade, including prefixes damaged by older clients.
        return restart_checkpoint(&path, checkpoint);
    }
    if !checkpoint.cursor.identity.is_empty() {
        let mut file = match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(mirror(dir, &checkpoint, binding))
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return restart_checkpoint(&path, checkpoint);
            }
            Err(e) => return Err(e.to_string()),
        };
        if !verify_prefix(&mut file, &mut checkpoint)? {
            return restart_checkpoint(&path, checkpoint);
        }
        // Discard an uncommitted suffix left by a crash between data and cursor.
        file.set_len(checkpoint.cursor.offset)
            .map_err(|e| e.to_string())?;
        checkpoint.verified.as_mut().unwrap().stamp =
            MirrorStamp::from(file.metadata().map_err(|e| e.to_string())?);
    }
    Ok(checkpoint)
}

/// Forgets a checkpoint whose mirror can no longer back it. An empty cursor
/// identity never matches the remote file, so the next frame is a reset from
/// byte 0 and `accept` writes it to a fresh generation directory instead of
/// appending to (or failing on) the damaged mirror.
fn restart_checkpoint(path: &Path, damaged: Checkpoint) -> Result<Checkpoint, String> {
    let restarted = Checkpoint {
        cursor: Cursor::default(),
        generation: damaged.generation,
        source: damaged.source,
        ..Default::default()
    };
    save_json(path, &restarted)?;
    Ok(restarted)
}

fn accept(
    dir: &Path,
    binding: &Binding,
    checkpoint: &mut Checkpoint,
    frame: Frame,
) -> Result<PathBuf, String> {
    if frame.session != binding.session
        || frame.data.len() > MAX_CHUNK
        || frame.start.checked_add(frame.data.len() as u64) != Some(frame.cursor.offset)
        || frame.cursor.anchor.len() != frame.cursor.offset.min(256) as usize
        || (frame.reset && frame.start != 0)
        || (!frame.reset
            && (frame.start != checkpoint.cursor.offset
                || frame.cursor.identity != checkpoint.cursor.identity))
    {
        return Err("invalid remote transcript frame".into());
    }
    let mut expected_anchor = if frame.reset {
        Vec::new()
    } else {
        checkpoint.cursor.anchor.clone()
    };
    expected_anchor.extend_from_slice(frame.data.as_bytes());
    let suffix = expected_anchor.len().saturating_sub(256);
    if expected_anchor[suffix..] != frame.cursor.anchor {
        return Err("invalid remote transcript anchor".into());
    }
    // Frames may end inside a JSON record. Persist the exact fragments; the
    // ordinary local tail only parses bytes through the last complete newline.
    let mut next = Checkpoint {
        cursor: frame.cursor,
        generation: checkpoint
            .generation
            .checked_add(u64::from(frame.reset))
            .ok_or("transcript generation exhausted")?,
        source: frame.path,
        ..Default::default()
    };
    let path = mirror(dir, &next, binding);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut file = match OpenOptions::new()
        .create(frame.reset)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if !frame.reset && e.kind() == std::io::ErrorKind::NotFound => {
            *checkpoint =
                restart_checkpoint(&dir.join("checkpoint.json"), std::mem::take(checkpoint))?;
            return Err("local transcript disappeared; restarting".into());
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut hash = if frame.reset {
        Sha256::new()
    } else {
        if !verify_prefix(&mut file, checkpoint)? {
            *checkpoint =
                restart_checkpoint(&dir.join("checkpoint.json"), std::mem::take(checkpoint))?;
            return Err("local transcript prefix changed; restarting".into());
        }
        checkpoint.verified.as_ref().unwrap().hash.clone()
    };
    if !frame.data.is_empty() || frame.reset {
        file.set_len(frame.start).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(frame.start))
            .map_err(|e| e.to_string())?;
        file.write_all(frame.data.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        hash.update(frame.data.as_bytes());
        next.digest = hash.clone().finalize().to_vec();
        next.verified = Some(VerifiedMirror {
            stamp: MirrorStamp::from(file.metadata().map_err(|e| e.to_string())?),
            hash,
        });
        if MirrorStamp::from(fs::symlink_metadata(&path).map_err(|e| e.to_string())?)
            != next.verified.as_ref().unwrap().stamp
        {
            return Err("local transcript pathname changed during commit".into());
        }
        save_json(&dir.join("checkpoint.json"), &next)?;
        *checkpoint = next;
    }
    Ok(path)
}

fn worker(state: AppState, root: PathBuf, guard: RootGuard) {
    let mut installed: Option<(Host, String)> = None;
    let historical_end = Arc::new(AtomicU64::new(u64::MAX));
    loop {
        let (binding, revision) = {
            let Ok(revision) = guard.lock() else { return };
            let Ok(Some(binding)) = current_binding(&root) else {
                return;
            };
            if live_host(&state, &binding).is_none() {
                READERS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&root);
                return;
            }
            (binding, *revision)
        };
        let result = (|| {
            let host = live_host(&state, &binding).ok_or("remote session ended")?;
            if installed
                .as_ref()
                .is_none_or(|(previous, _)| previous != &host)
            {
                let prepared = crate::remote_cli::ensure_cli(&host)?;
                installed = Some((host, prepared.path));
            }
            stream(
                &state,
                &root,
                &binding,
                &installed.as_ref().unwrap().1,
                &historical_end,
                &guard,
                revision,
            )
        })();
        if let Err(error) = result {
            let Ok(current) = guard.lock() else { return };
            if !current_reader(&root, &binding, *current, revision).unwrap_or(false) {
                continue;
            }
            eprintln!("qmux: remote transcript {}: {error}", binding.agent);
            notice(
                &state,
                &binding,
                Some("Transcript reconnecting; waiting for remote transcript."),
            );
        }
        thread::sleep(Duration::from_secs(2));
    }
}

fn stream(
    state: &AppState,
    root: &Path,
    binding: &Binding,
    cli: &str,
    historical_end: &Arc<AtomicU64>,
    guard: &RootGuard,
    revision: u64,
) -> Result<(), String> {
    let dir = session_directory(root, binding);
    let (host, checkpoint) = {
        let current = guard.lock().map_err(|e| e.to_string())?;
        if !current_reader(root, binding, *current, revision)? {
            return Ok(());
        }
        historical_end.store(u64::MAX, Ordering::SeqCst);
        let host = live_host(state, binding).ok_or("remote session ended")?;
        (host, recover(&dir, binding)?)
    };
    let child = host
        .command(RemoteCommand {
            program: cli,
            args: vec![
                "transcript-stream".into(),
                binding.adapter.clone(),
                binding.session.clone(),
                if binding.hint.is_empty() {
                    checkpoint.source.clone()
                } else {
                    binding.hint.clone()
                },
                serde_json::to_string(&checkpoint.cursor).map_err(|e| e.to_string())?,
            ],
            ..Default::default()
        })
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    receive_stream(
        state,
        root,
        binding,
        historical_end,
        guard,
        revision,
        checkpoint,
        child,
    )
}

fn receive_stream(
    state: &AppState,
    root: &Path,
    binding: &Binding,
    historical_end: &Arc<AtomicU64>,
    guard: &RootGuard,
    revision: u64,
    mut checkpoint: Checkpoint,
    mut child: std::process::Child,
) -> Result<(), String> {
    let dir = session_directory(root, binding);
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            let result = reader.by_ref().take(MAX_FRAME + 1).read_line(&mut line);
            match result {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() as u64 > MAX_FRAME || !line.ends_with('\n') => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let result = (|| {
        let mut last_frame = Instant::now();
        let mut announced = false;
        loop {
            let current = guard.lock().map_err(|e| e.to_string())?;
            if !current_reader(root, binding, *current, revision)?
                || live_host(state, binding).is_none()
            {
                return Ok(());
            }
            drop(current);
            let line = match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout)
                    if last_frame.elapsed() < Duration::from_secs(60) =>
                {
                    continue;
                }
                Err(_) => return Err("remote transcript stream disconnected or timed out".into()),
            };
            let frame: Frame = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            // Rebinding and commit use the same per-root fence, including an
            // epoch to reject a stale A reader after an A -> B -> A rebind.
            let current = guard.lock().map_err(|e| e.to_string())?;
            if !current_reader(root, binding, *current, revision)?
                || live_host(state, binding).is_none()
            {
                return Ok(());
            }
            // Publish the boundary before making historical bytes visible to the tail.
            historical_end.store(frame.historical_end, Ordering::SeqCst);
            let path = accept(&dir, binding, &mut checkpoint, frame)?;
            let path = path.to_string_lossy().into_owned();
            let agent = state.agent(&binding.agent)?.ok_or("agent disappeared")?;
            let changed = agent.transcript_path.as_deref() != Some(path.as_str());
            if changed {
                let updated = state.mutate_agent(&binding.agent, |agent| {
                    if agent.session_id.as_deref() == Some(binding.session.as_str())
                        && agent.pane_id.as_deref() == Some(binding.pane.as_str())
                    {
                        agent.transcript_path = Some(path.clone());
                    }
                })?;
                if updated.is_none_or(|agent| {
                    agent.transcript_path.as_deref() != Some(path.as_str())
                        || agent.session_id.as_deref() != Some(binding.session.as_str())
                        || agent.pane_id.as_deref() != Some(binding.pane.as_str())
                }) {
                    return Ok(());
                }
            }
            if changed || !announced {
                crate::transcript::start_remote_transcript_tail(
                    state.clone(),
                    binding.agent.clone(),
                    path,
                    binding.adapter.clone(),
                    historical_end.clone(),
                );
            }
            if !announced {
                notice(state, binding, None);
                announced = true;
            }
            last_frame = Instant::now();
        }
    })();
    // Closing the receiver also releases a reader blocked on the bounded queue.
    drop(rx);
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_binding(adapter: &str, session: &str) -> Binding {
        Binding {
            cwd: "/remote/project".into(),
            roots: vec!["/remote/project".into()],
            agent: "agent".into(),
            pane: "pane".into(),
            adapter: adapter.into(),
            session: session.into(),
            remote_id: "remote".into(),
            remote_host: "host".into(),
            hint: String::new(),
        }
    }

    #[test]
    fn remote_metadata_is_persisted_and_stale_sessions_cannot_rebind() {
        let root = std::env::temp_dir().join(format!("qmux-mirror-binding-{}", std::process::id()));
        let state = AppState::new(
            serde_json::from_value(json!({
                "workspaceRoot":root, "socketPath":root.join("unused.sock")
            }))
            .unwrap(),
        );
        let group: crate::workspace::GroupInfo = serde_json::from_value(json!({
            "id":"g", "name":"Remote", "dir":"/remote", "managedDir":root.join("g"),
            "createdAt":1, "agents":["a"], "remote":{"id":"r", "label":"Remote", "host":"unreachable.invalid", "multiplexer":"tmux"}
        })).unwrap();
        state.update_group(group.clone()).unwrap();
        state.insert_agent(serde_json::from_value(json!({
            "id":"a", "groupId":"g", "adapter":"claude", "worktreeDir":"/remote", "paneId":"p",
            "sessionId":"session", "status":"running", "createdAt":1
        })).unwrap()).unwrap();
        let identity = crate::state::RemoteSessionIdentity::new("r", "p").unwrap();
        let host = host::for_group(group.remote.as_ref());
        let commands = host
            .existing_tmux_session_commands(&identity, "/unused.sock")
            .unwrap();
        observe(
            &state,
            "p",
            &json!({"session_id":"session", "transcript_path":"/remote/custom/session.jsonl"}),
        );
        let early_key = directory(&state, "a");
        let early: Binding =
            serde_json::from_slice(&fs::read(early_key.join("binding.json")).unwrap()).unwrap();
        assert_eq!(early.hint, "/remote/custom/session.jsonl");
        assert!(!READERS.lock().unwrap().contains_key(&early_key));
        state.insert_pane(crate::state::PaneRuntime {
            info: serde_json::from_value(json!({"id":"p", "title":"Remote", "kind":"agent", "agentId":"a", "groupId":"g", "cwd":"/remote",
                "remoteSession":identity, "cols":80, "rows":24, "status":"running"})).unwrap(),
            backend: crate::state::PaneBackend::RemoteTmux(crate::state::RemoteTmuxBackend::new(
                crate::remote_terminal::RemoteAttachmentController::new(),
                crate::remote_terminal::RemoteHistoryCheckpoint::new(Vec::new()),
                std::sync::Arc::new(Mutex::new(Default::default())), commands, false)),
            cwd_observation_seq:0
        }).unwrap();
        let key = directory(&state, "a");
        // Reserve the worker slot to exercise metadata routing without SSH.
        let reserved = Binding {
            cwd: "/remote".into(),
            roots: vec!["/remote".into()],
            agent: "a".into(),
            pane: "p".into(),
            adapter: "claude".into(),
            session: "old".into(),
            remote_id: "r".into(),
            remote_host: "unreachable.invalid".into(),
            hint: String::new(),
        };
        READERS.lock().unwrap().insert(key.clone(), reserved);
        observe(
            &state,
            "p",
            &json!({"session_id":"session", "transcript_path":"/remote/session.jsonl"}),
        );
        let binding = READERS.lock().unwrap().get(&key).unwrap().clone();
        assert_eq!(binding.session, "session");
        assert_eq!(binding.hint, "/remote/session.jsonl");
        assert!(live_host(&state, &binding).is_some());
        assert!(state.agent("a").unwrap().unwrap().transcript_path.is_none());
        let saved: Binding =
            serde_json::from_slice(&fs::read(key.join("binding.json")).unwrap()).unwrap();
        assert_eq!(saved, binding);
        // Provenance stays with the transcript even after the live agent moves.
        let transcript = session_directory(&key, &binding).join("0/session.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        fs::write(&transcript, "").unwrap();
        let transcript = transcript.to_string_lossy().into_owned();
        state
            .mutate_agent("a", |a| {
                a.transcript_path = Some(transcript.clone());
                a.worktree_dir = "/other/project".into();
            })
            .unwrap();
        assert_eq!(
            preview_source(&state, "p", &transcript).unwrap().1,
            "/remote"
        );
        assert!(preview_source(&state, "p", "/wrong/transcript").is_err());
        state
            .mutate_agent("a", |a| {
                a.transcript_path = None;
                a.worktree_dir = "/remote".into();
            })
            .unwrap();
        for payload in [
            json!({"session_id":"stale", "transcript_path":"/bad"}),
            json!({"agent_id":"subagent", "session_id":"session", "transcript_path":"/bad"}),
        ] {
            observe(&state, "p", &payload);
            assert_eq!(READERS.lock().unwrap().get(&key), Some(&binding));
        }
        state
            .mutate_agent("a", |agent| agent.session_id = Some("next".into()))
            .unwrap();
        assert!(live_host(&state, &binding).is_none());
        observe(&state, "p", &json!({"session_id":"next"}));
        let next = READERS.lock().unwrap().get(&key).unwrap().clone();
        assert_eq!(next.session, "next");
        assert!(next.hint.is_empty());
        assert_ne!(
            session_directory(&key, &binding),
            session_directory(&key, &next)
        );
        fs::remove_file(key.join("binding.json")).unwrap();
        READERS.lock().unwrap().insert(key.clone(), binding.clone());
        restore(&state, "p");
        assert_eq!(READERS.lock().unwrap().get(&key).unwrap().session, "next");
        assert!(key.join("binding.json").exists());
        state
            .mutate_agent("a", |agent| agent.fork_point = Some("next".into()))
            .unwrap();
        assert!(live_host(&state, &next).is_none());
        observe(
            &state,
            "p",
            &json!({"session_id":"next", "transcript_path":"/source/fork.jsonl"}),
        );
        assert!(READERS.lock().unwrap().get(&key).unwrap().hint.is_empty());
        READERS.lock().unwrap().remove(&key);
    }

    fn message_line(adapter: &str, message: &str) -> String {
        let value = if adapter == "claude" {
            json!({"type":"user", "uuid":message, "sessionId":"session", "message":{"role":"user", "content":message}})
        } else if adapter == "antigravity" {
            json!({"step_index":0, "source":"USER_EXPLICIT", "type":"USER_INPUT", "status":"DONE", "content":message})
        } else {
            json!({"type":"response_item", "payload":{"type":"message", "role":"user", "content":[{"type":"input_text", "text":message}]}})
        };
        value.to_string() + "\n"
    }
    #[test]
    fn claude_mirror_reaches_turn_pipeline_and_resets_cleanly() {
        check_mirrored_pipeline("claude");
    }
    #[test]
    fn codex_mirror_reaches_turn_pipeline_and_resets_cleanly() {
        check_mirrored_pipeline("codex");
    }
    #[test]
    fn antigravity_mirror_reaches_turn_pipeline_and_resets_cleanly() {
        check_mirrored_pipeline("antigravity");
    }
    #[test]
    fn devin_document_mirror_reaches_the_turn_pipeline() {
        let root =
            std::env::temp_dir().join(format!("qmux-mirror-pipeline-devin-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let state = AppState::new(
            serde_json::from_value(json!({
                "workspaceRoot": root, "socketPath": root.join("unused.sock")
            }))
            .unwrap(),
        );
        state
            .insert_agent(
                serde_json::from_value(json!({
                    "id":"devin-agent", "groupId":"g", "adapter":"devin",
                    "worktreeDir":"/remote/project", "paneId":"p", "sessionId":"session",
                    "status":"running", "createdAt":1
                }))
                .unwrap(),
            )
            .unwrap();
        let dir = root.join("mirror");
        let binding = test_binding("devin", "session");
        let mut checkpoint = Checkpoint::default();
        let data = json!({
            "session_id":"session",
            "steps":[{"step_id":1,"source":"user","message":"hello"}]
        })
        .to_string();
        let frame = Frame {
            session: "session".into(),
            path: "/remote/devin.json".into(),
            start: 0,
            reset: true,
            historical_end: data.len() as u64,
            cursor: Cursor {
                offset: data.len() as u64,
                identity: "inode".into(),
                anchor: data.as_bytes()[data.len().saturating_sub(256)..].to_vec(),
            },
            data,
        };
        let path = accept(&dir, &binding, &mut checkpoint, frame).unwrap();
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("json"));
        state
            .mutate_agent("devin-agent", |agent| {
                agent.transcript_path = Some(path.to_string_lossy().into())
            })
            .unwrap();
        crate::transcript::start_transcript_tail(
            state.clone(),
            "devin-agent".into(),
            path.to_string_lossy().into(),
            "devin".into(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let turns = state.list_turns(Some("devin-agent")).unwrap();
            if turns.len() == 1 {
                assert!(serde_json::to_string(&turns).unwrap().contains("hello"));
                break;
            }
            assert!(Instant::now() < deadline, "Devin mirror produced no turn");
            thread::sleep(Duration::from_millis(20));
        }
        state
            .mutate_agent("devin-agent", |agent| agent.transcript_path = None)
            .unwrap();
    }

    fn check_mirrored_pipeline(adapter: &str) {
        let root = std::env::temp_dir().join(format!(
            "qmux-mirror-pipeline-{adapter}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let config = serde_json::from_value(json!({
            "workspaceRoot": root, "socketPath": root.join("unused.sock")
        }))
        .unwrap();
        let state = AppState::new(config);
        let agent = serde_json::from_value(json!({
            "id": "remote-test-agent", "groupId": "g", "adapter": adapter,
            "worktreeDir": "/remote/project", "paneId": "p", "sessionId": "session",
            "status": "running", "createdAt": 1
        }))
        .unwrap();
        state.insert_agent(agent).unwrap();
        let source = root.join("source.jsonl");
        let dir = root.join("mirror");
        fs::create_dir_all(&dir).unwrap();
        let mut checkpoint = Checkpoint::default();
        let binding = test_binding(adapter, "session");
        for (message, expected_count) in [("hello", 1), ("second", 2)] {
            let line = message_line(adapter, message);
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&source)
                .unwrap()
                .write_all(line.as_bytes())
                .unwrap();
            let frame =
                qmux_cli::transcript_stream::read_frame(&source, "session", &checkpoint.cursor)
                    .unwrap();
            let path = accept(&dir, &binding, &mut checkpoint, frame).unwrap();
            state
                .mutate_agent("remote-test-agent", |agent| {
                    agent.transcript_path = Some(path.to_string_lossy().into())
                })
                .unwrap();
            crate::transcript::start_transcript_tail(
                state.clone(),
                "remote-test-agent".into(),
                path.to_string_lossy().into(),
                adapter.into(),
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let turns = state.list_turns(Some("remote-test-agent")).unwrap();
                if turns.len() == expected_count {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "transcript did not produce {expected_count} turns: {turns:?}"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }
        // Same session, rewritten file: the new generation must replace turns.
        fs::write(&source, message_line(adapter, "replacement")).unwrap();
        let frame = qmux_cli::transcript_stream::read_frame(&source, "session", &checkpoint.cursor)
            .unwrap();
        let path = accept(&dir, &binding, &mut checkpoint, frame).unwrap();
        state
            .mutate_agent("remote-test-agent", |agent| {
                agent.transcript_path = Some(path.to_string_lossy().into())
            })
            .unwrap();
        crate::transcript::start_transcript_tail(
            state.clone(),
            "remote-test-agent".into(),
            path.to_string_lossy().into(),
            adapter.into(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let turns = state.list_turns(Some("remote-test-agent")).unwrap();
            if turns.len() == 1
                && serde_json::to_string(&turns[0].blocks)
                    .unwrap()
                    .contains("replacement")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "rewrite did not replace turns: {turns:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
        state
            .mutate_agent("remote-test-agent", |agent| agent.transcript_path = None)
            .unwrap();
        // Leave the temporary workspace to the OS: AppState's debounced writer
        // may still be finishing a snapshot after the tail has stopped.
    }

    #[test]
    fn remote_backfill_completion_does_not_settle_live_agent() {
        let root =
            std::env::temp_dir().join(format!("qmux-backfill-lifecycle-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let state = AppState::new(
            serde_json::from_value(json!({
                "workspaceRoot": root, "socketPath": root.join("unused.sock")
            }))
            .unwrap(),
        );
        let path = root.join("session.jsonl");
        let initial = message_line("codex", "initial");
        fs::write(&path, &initial).unwrap();
        state
            .insert_agent(
                serde_json::from_value(json!({
                    "id":"backfill-agent", "groupId":"g", "adapter":"codex",
                    "worktreeDir":"/remote/project", "paneId":"p", "sessionId":"session",
                    "transcriptPath":path, "status":"running", "createdAt":1
                }))
                .unwrap(),
            )
            .unwrap();
        let completion = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n";
        let history = format!("{completion}{}", message_line("codex", "historical"));
        let boundary = Arc::new(AtomicU64::new((initial.len() + history.len()) as u64));
        crate::transcript::start_remote_transcript_tail(
            state.clone(),
            "backfill-agent".into(),
            path.to_string_lossy().into(),
            "codex".into(),
            boundary.clone(),
        );
        let wait_turns = |count| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while state.list_turns(Some("backfill-agent")).unwrap().len() < count {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(20));
            }
        };
        wait_turns(1); // Ensure the next batch takes the incremental tail path.
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(history.as_bytes())
            .unwrap();
        wait_turns(2);
        assert_eq!(
            state.agent("backfill-agent").unwrap().unwrap().status,
            crate::workspace::AgentStatus::Running
        );
        // A reconnect also treats downloaded completion records as historical.
        boundary.store(u64::MAX, Ordering::SeqCst);
        let reconnect = format!("{completion}{}", message_line("codex", "reconnected"));
        let end = fs::metadata(&path).unwrap().len() + reconnect.len() as u64;
        boundary.store(end, Ordering::SeqCst);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(reconnect.as_bytes())
            .unwrap();
        wait_turns(3);
        assert_eq!(
            state.agent("backfill-agent").unwrap().unwrap().status,
            crate::workspace::AgentStatus::Running
        );
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(completion.as_bytes())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while state.agent("backfill-agent").unwrap().unwrap().status
            != crate::workspace::AgentStatus::Done
        {
            assert!(
                Instant::now() < deadline,
                "live completion did not settle agent"
            );
            thread::sleep(Duration::from_millis(20));
        }
        state
            .mutate_agent("backfill-agent", |a| a.transcript_path = None)
            .unwrap();
    }

    #[test]
    fn chunked_large_record_reassembles_after_checkpoint_recovery() {
        let root = std::env::temp_dir().join(format!("qmux-large-mirror-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.jsonl");
        let dir = root.join("mirror");
        let record = json!({"type":"user", "message":{"content":[
            {"type":"image", "source":{"type":"base64", "data":"A".repeat(5 * 1024 * 1024)}},
            {"type":"text", "text":"image prompt"}
        ]}})
        .to_string()
            + "\n";
        let contents = record + &message_line("claude", "following message");
        fs::write(&source, &contents).unwrap();
        let mut cp = Checkpoint::default();
        let binding = test_binding("claude", "session");
        let first =
            qmux_cli::transcript_stream::read_frame(&source, "session", &cp.cursor).unwrap();
        assert!(!first.data.ends_with('\n'));
        let path = accept(&dir, &binding, &mut cp, first).unwrap();
        // Mid-record progress is durable, and an interrupted write is discarded.
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"uncommitted")
            .unwrap();
        cp = recover(&dir, &binding).unwrap();
        while cp.cursor.offset < contents.len() as u64 {
            let frame =
                qmux_cli::transcript_stream::read_frame(&source, "session", &cp.cursor).unwrap();
            assert!(!frame.data.is_empty());
            assert_eq!(accept(&dir, &binding, &mut cp, frame).unwrap(), path);
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        let state = AppState::new(
            serde_json::from_value(json!({
                "workspaceRoot":root, "socketPath":root.join("unused.sock")
            }))
            .unwrap(),
        );
        state
            .insert_agent(
                serde_json::from_value(json!({
                    "id":"large-agent", "groupId":"g", "adapter":"claude",
                    "worktreeDir":"/remote/project", "paneId":"p", "sessionId":"session",
                    "transcriptPath":path, "status":"running", "createdAt":1
                }))
                .unwrap(),
            )
            .unwrap();
        crate::transcript::start_transcript_tail(
            state.clone(),
            "large-agent".into(),
            path.to_string_lossy().into(),
            "claude".into(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let turns = state.list_turns(Some("large-agent")).unwrap();
            if turns.len() == 2 {
                assert!(
                    serde_json::to_string(&turns)
                        .unwrap()
                        .contains("following message")
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "large record did not reach turn pipeline"
            );
            thread::sleep(Duration::from_millis(20));
        }
        state
            .mutate_agent("large-agent", |agent| agent.transcript_path = None)
            .unwrap();
    }

    #[test]
    fn checkpoint_recovers_uncommitted_suffix_and_rejects_duplicates() {
        let dir = std::env::temp_dir().join(format!("qmux-mirror-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut cp = Checkpoint::default();
        let binding = test_binding("claude", "s");
        let data = "{\"a\":1}\n";
        let make = |reset, start| Frame {
            session: "s".into(),
            path: "/remote/file".into(),
            start,
            reset,
            historical_end: 0,
            cursor: Cursor {
                offset: start + data.len() as u64,
                identity: "inode".into(),
                anchor: data.as_bytes().to_vec(),
            },
            data: data.into(),
        };
        let path = accept(&dir, &binding, &mut cp, make(true, 0)).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"uncommitted")
            .unwrap();
        let mut recovered = recover(&dir, &binding).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), data);
        assert!(accept(&dir, &binding, &mut recovered, make(false, 0)).is_err());
        let other_binding = test_binding("claude", "other");
        assert!(accept(&dir, &other_binding, &mut recovered, make(true, 0)).is_err());
        let next = accept(&dir, &binding, &mut recovered, make(true, 0)).unwrap();
        assert_ne!(path, next); // A rewrite restarts parsing, even at equal length.
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_mirror_shorter_than_its_checkpoint_restarts_from_a_reset_frame() {
        let dir = std::env::temp_dir().join(format!("qmux-short-mirror-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let binding = test_binding("claude", "s");
        let data = "{\"a\":1}\n";
        let frame = |reset, start| Frame {
            session: "s".into(),
            path: "/remote/file".into(),
            start,
            reset,
            historical_end: 0,
            cursor: Cursor {
                offset: start + data.len() as u64,
                identity: "inode".into(),
                anchor: data.as_bytes().to_vec(),
            },
            data: data.into(),
        };
        let mut cp = Checkpoint::default();
        let path = accept(&dir, &binding, &mut cp, frame(true, 0)).unwrap();
        // Damage the committed prefix outside qmux.
        fs::write(&path, b"").unwrap();
        let mut recovered = recover(&dir, &binding).expect("damaged mirror must not wedge");
        assert_eq!(recovered.cursor, Cursor::default());
        // The restart is durable: a second recovery does not see the old cursor.
        assert_eq!(recover(&dir, &binding).unwrap().cursor, Cursor::default());
        // An empty identity makes the remote send a reset frame, which lands
        // in the next generation rather than the damaged file.
        assert!(accept(&dir, &binding, &mut recovered, frame(false, 0)).is_err());
        let next = accept(&dir, &binding, &mut recovered, frame(true, 0)).unwrap();
        assert_ne!(path, next);
        assert_eq!(fs::read_to_string(&next).unwrap(), data);
        // A deleted mirror restarts the same way.
        fs::remove_file(&next).unwrap();
        assert_eq!(recover(&dir, &binding).unwrap().cursor, Cursor::default());
        fs::remove_dir_all(dir).unwrap();
    }

    fn issue19_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("qmux-issue19-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn issue19_live_damage_case(damage: &str) {
        for damage in [damage] {
            let root = issue19_dir(damage);
            let dir = root.join("mirror");
            let source = root.join("source");
            let data = format!("{{\"text\":\"{}\"}}\n", "a".repeat(1024));
            fs::write(&source, &data).unwrap();
            let binding = test_binding("claude", "s");
            let mut cp = Checkpoint::default();
            let first = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
            let path = accept(&dir, &binding, &mut cp, first).unwrap();
            match damage {
                "deleted" => fs::remove_file(&path).unwrap(),
                "short" => fs::write(&path, "").unwrap(),
                _ => {
                    let mut bytes = data.as_bytes().to_vec();
                    // Before the last 256 bytes: a suffix-only check misses this.
                    bytes[10] = if damage == "invalid-json" {
                        b'\n'
                    } else {
                        b'b'
                    };
                    fs::write(&path, bytes).unwrap();
                }
            }
            let next_data = format!("{data}{{\"next\":true}}\n");
            fs::write(&source, &next_data).unwrap();
            let next = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
            assert!(
                accept(&dir, &binding, &mut cp, next).is_err(),
                "{damage}: damaged prefix was committed"
            );
            let mut restarted = recover(&dir, &binding).unwrap();
            assert_eq!(restarted.cursor, Cursor::default(), "{damage}");
            let reset =
                qmux_cli::transcript_stream::read_frame(&source, "s", &restarted.cursor).unwrap();
            assert!(reset.reset);
            let next_path = accept(&dir, &binding, &mut restarted, reset).unwrap();
            assert_ne!(path, next_path);
            assert_eq!(fs::read_to_string(next_path).unwrap(), next_data);
            fs::remove_dir_all(root).unwrap();
        }
    }

    fn issue19_heartbeat_case(empty: bool) {
        for empty in [empty] {
            let root = issue19_dir(if empty {
                "empty-heartbeat"
            } else {
                "corrupt-heartbeat"
            });
            let dir = root.join("mirror");
            let source = root.join("source");
            fs::write(&source, if empty { "" } else { "{\"a\":1}\n" }).unwrap();
            let binding = test_binding("claude", "s");
            let mut cp = Checkpoint::default();
            let frame = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
            let path = accept(&dir, &binding, &mut cp, frame).unwrap();
            if empty {
                fs::remove_file(path).unwrap();
            } else {
                fs::write(path, "{\"a\":2}\n").unwrap();
            }
            let heartbeat =
                qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
            assert!(heartbeat.data.is_empty());
            assert!(accept(&dir, &binding, &mut cp, heartbeat).is_err());
            assert_eq!(recover(&dir, &binding).unwrap().cursor, Cursor::default());
            fs::remove_dir_all(root).unwrap();
        }
    }

    fn issue19_recovery_case(invalid_checkpoint: bool) {
        for invalid_checkpoint in [invalid_checkpoint] {
            let root = issue19_dir(if invalid_checkpoint {
                "bad-checkpoint"
            } else {
                "bad-prefix"
            });
            let dir = root.join("mirror");
            let source = root.join("source");
            let data = format!("{{\"text\":\"{}\"}}\n", "a".repeat(1024));
            fs::write(&source, &data).unwrap();
            let binding = test_binding("claude", "s");
            let mut cp = Checkpoint::default();
            let frame = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
            let old = accept(&dir, &binding, &mut cp, frame).unwrap();
            if invalid_checkpoint {
                fs::write(dir.join("checkpoint.json"), b"{broken").unwrap();
            } else {
                let mut bytes = data.as_bytes().to_vec();
                bytes[10] = b'b';
                fs::write(&old, bytes).unwrap();
            }
            let mut recovered = recover(&dir, &binding).expect("damage must recover");
            assert_eq!(recovered.cursor, Cursor::default());
            assert_eq!(recover(&dir, &binding).unwrap().cursor, Cursor::default());
            let frame =
                qmux_cli::transcript_stream::read_frame(&source, "s", &recovered.cursor).unwrap();
            let next = accept(&dir, &binding, &mut recovered, frame).unwrap();
            assert_ne!(old, next);
            assert_eq!(fs::read_to_string(next).unwrap(), data);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn issue19_damaged_mirror_symlinks_fail_closed_without_touching_target() {
        let root = issue19_dir("symlink");
        let dir = root.join("mirror");
        let source = root.join("source");
        fs::write(&source, "{\"a\":1}\n").unwrap();
        let binding = test_binding("claude", "s");
        let mut cp = Checkpoint::default();
        let frame = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
        let path = accept(&dir, &binding, &mut cp, frame).unwrap();
        let offset = cp.cursor.offset;
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&source, &path).unwrap();
        let frame = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
        assert!(accept(&dir, &binding, &mut cp, frame).is_err());
        assert!(recover(&dir, &binding).is_err());
        assert_eq!(cp.cursor.offset, offset);
        assert_eq!(fs::read_to_string(&source).unwrap(), "{\"a\":1}\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn issue19_live_deleted() {
        issue19_live_damage_case("deleted");
    }

    #[test]
    fn issue19_live_short() {
        issue19_live_damage_case("short");
    }

    #[test]
    fn issue19_live_invalid_json() {
        issue19_live_damage_case("invalid-json");
    }

    #[test]
    fn issue19_live_valid_same_size() {
        issue19_live_damage_case("valid-same-size");
    }

    #[test]
    fn issue19_heartbeat_empty() {
        issue19_heartbeat_case(true);
    }

    #[test]
    fn issue19_heartbeat_corrupt() {
        issue19_heartbeat_case(false);
    }

    #[test]
    fn issue19_recovery_invalid_checkpoint() {
        issue19_recovery_case(true);
    }

    #[test]
    fn issue19_recovery_full_prefix() {
        issue19_recovery_case(false);
    }

    fn issue19_remote_fixture(tag: &str) -> (PathBuf, AppState, Binding, RootGuard) {
        let base = issue19_dir(tag);
        let state = AppState::new(
            serde_json::from_value(json!({
                "workspaceRoot":base, "socketPath":base.join("unused.sock")
            }))
            .unwrap(),
        );
        let agent = format!("a-{tag}");
        let pane = format!("p-{tag}");
        let group: crate::workspace::GroupInfo = serde_json::from_value(json!({
            "id":"g", "name":"Remote", "dir":"/remote", "managedDir":base.join("g"),
            "createdAt":1, "agents":[agent], "remote":{"id":"r", "label":"Remote", "host":"unreachable.invalid", "multiplexer":"tmux"}
        })).unwrap();
        state.update_group(group.clone()).unwrap();
        state.insert_agent(serde_json::from_value(json!({
            "id":agent, "groupId":"g", "adapter":"claude", "worktreeDir":"/remote", "paneId":pane,
            "sessionId":"session", "status":"running", "createdAt":1
        })).unwrap()).unwrap();
        let identity = crate::state::RemoteSessionIdentity::new("r", &pane).unwrap();
        let commands = host::for_group(group.remote.as_ref())
            .existing_tmux_session_commands(&identity, "/unused.sock")
            .unwrap();
        state.insert_pane(crate::state::PaneRuntime {
            info: serde_json::from_value(json!({"id":pane, "title":"Remote", "kind":"agent", "agentId":agent, "groupId":"g", "cwd":"/remote",
                "remoteSession":identity, "cols":80, "rows":24, "status":"running"})).unwrap(),
            backend: crate::state::PaneBackend::RemoteTmux(crate::state::RemoteTmuxBackend::new(
                crate::remote_terminal::RemoteAttachmentController::new(),
                crate::remote_terminal::RemoteHistoryCheckpoint::new(Vec::new()),
                Arc::new(Mutex::new(Default::default())), commands, false)),
            cwd_observation_seq:0
        }).unwrap();
        let binding = Binding {
            agent,
            pane,
            adapter: "claude".into(),
            session: "session".into(),
            remote_id: "r".into(),
            remote_host: "unreachable.invalid".into(),
            cwd: "/remote".into(),
            roots: vec!["/remote".into(), "/remote".into()],
            hint: String::new(),
        };
        let root = directory(&state, &binding.agent);
        let guard = root_guard(&root);
        READERS
            .lock()
            .unwrap()
            .insert(root.clone(), binding.clone());
        (root, state, binding, guard)
    }

    #[test]
    fn issue19_independent_root_hook_progress_while_one_root_is_blocked() {
        let (a_root, a_state, a_binding, a_guard) = issue19_remote_fixture("root-a");
        let (b_root, b_state, b_binding, _b_guard) = issue19_remote_fixture("root-b");
        let held = a_guard.lock().unwrap();
        let (a_tx, a_rx) = mpsc::channel();
        let a = thread::spawn(move || {
            observe(
                &a_state,
                &a_binding.pane,
                &json!({"session_id":"session", "transcript_path":"/remote/new-a"}),
            );
            a_tx.send(()).unwrap();
        });
        let (b_tx, b_rx) = mpsc::channel();
        let b = thread::spawn(move || {
            observe(
                &b_state,
                &b_binding.pane,
                &json!({"session_id":"session", "transcript_path":"/remote/new-b"}),
            );
            b_tx.send(()).unwrap();
        });
        b_rx.recv_timeout(Duration::from_secs(2))
            .expect("independent root blocked behind another root's commit");
        assert!(a_rx.try_recv().is_err());
        assert_eq!(
            current_binding(&b_root).unwrap().unwrap().hint,
            "/remote/new-b"
        );
        drop(held);
        a_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        a.join().unwrap();
        b.join().unwrap();
        READERS.lock().unwrap().remove(&a_root);
        READERS.lock().unwrap().remove(&b_root);
    }

    #[test]
    fn issue19_real_frame_reader_rejects_stale_stream_after_aba_rebind() {
        let (root, state, binding, guard) = issue19_remote_fixture("stale-reader");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.jsonl");
        let first_data = message_line("claude", "first");
        fs::write(&source, &first_data).unwrap();
        let first = qmux_cli::transcript_stream::read_frame(&source, "session", &Cursor::default())
            .unwrap();
        let mut all = first_data.clone();
        all.push_str(&message_line("claude", "must not commit"));
        fs::write(&source, &all).unwrap();
        let second =
            qmux_cli::transcript_stream::read_frame(&source, "session", &first.cursor).unwrap();
        let first_path = root.join("first-frame");
        let second_path = root.join("second-frame");
        fs::write(&first_path, serde_json::to_vec(&first).unwrap()).unwrap();
        fs::write(&second_path, serde_json::to_vec(&second).unwrap()).unwrap();
        let gate = root.join("next-frame");
        let child = std::process::Command::new("python3")
            .args([
                "-c",
                r#"import os,sys,time
print(open(sys.argv[1]).read(), flush=True)
while not os.path.exists(sys.argv[3]): time.sleep(.01)
print(open(sys.argv[2]).read(), flush=True)
time.sleep(10)
"#,
            ])
            .arg(first_path)
            .arg(second_path)
            .arg(&gate)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let run_state = state.clone();
        let run_root = root.clone();
        let run_binding = binding.clone();
        let run_guard = guard.clone();
        let reader = thread::spawn(move || {
            let result = receive_stream(
                &run_state,
                &run_root,
                &run_binding,
                &Arc::new(AtomicU64::new(u64::MAX)),
                &run_guard,
                0,
                Checkpoint::default(),
                child,
            );
            tx.send(result).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while state
            .agent(&binding.agent)
            .unwrap()
            .unwrap()
            .transcript_path
            .is_none()
        {
            assert!(
                Instant::now() < deadline,
                "first production stream frame was never published"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let dir = session_directory(&root, &binding);
        let committed = fs::read(dir.join("checkpoint.json")).unwrap();
        let path = state
            .agent(&binding.agent)
            .unwrap()
            .unwrap()
            .transcript_path
            .unwrap();
        state
            .mutate_agent(&binding.agent, |a| a.session_id = Some("next".into()))
            .unwrap();
        observe(&state, &binding.pane, &json!({"session_id":"next"}));
        state
            .mutate_agent(&binding.agent, |a| a.session_id = Some("session".into()))
            .unwrap();
        observe(&state, &binding.pane, &json!({"session_id":"session"}));
        assert_eq!(current_binding(&root).unwrap().as_ref(), Some(&binding));
        assert_eq!(*guard.lock().unwrap(), 2);
        fs::write(&gate, "").unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
        reader.join().unwrap();
        assert_eq!(fs::read(dir.join("checkpoint.json")).unwrap(), committed);
        assert_eq!(fs::read_to_string(path).unwrap(), first_data);
        state
            .mutate_agent(&binding.agent, |a| a.transcript_path = None)
            .unwrap();
        READERS.lock().unwrap().remove(&root);
    }

    #[test]
    fn issue19_legacy_checkpoint_upgrade_and_uncommitted_suffix_remain_recoverable() {
        let root = issue19_dir("legacy");
        let dir = root.join("mirror");
        let source = root.join("source");
        let data = "{\"a\":1}\n";
        fs::write(&source, data).unwrap();
        let binding = test_binding("claude", "s");
        let mut cp = Checkpoint::default();
        let first = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
        let path = accept(&dir, &binding, &mut cp, first).unwrap();
        let mut old: Value =
            serde_json::from_slice(&fs::read(dir.join("checkpoint.json")).unwrap()).unwrap();
        old.as_object_mut().unwrap().remove("digest");
        save_json(&dir.join("checkpoint.json"), &old).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"uncommitted")
            .unwrap();
        let mut recovered = recover(&dir, &binding).unwrap();
        assert_eq!(recovered.cursor, Cursor::default());
        assert_eq!(recovered.generation, cp.generation);
        let reset =
            qmux_cli::transcript_stream::read_frame(&source, "s", &recovered.cursor).unwrap();
        let rebuilt = accept(&dir, &binding, &mut recovered, reset).unwrap();
        assert_ne!(rebuilt, path);
        assert_eq!(recovered.digest.len(), 32);
        assert_eq!(fs::read_to_string(rebuilt).unwrap(), data);
    }

    #[test]
    fn issue19_checkpoint_save_failure_does_not_advance_and_retry_discards_suffix() {
        let root = issue19_dir("save-failure");
        let dir = root.join("mirror");
        let source = root.join("source");
        let first = "{\"a\":1}\n";
        let all = "{\"a\":1}\n{\"a\":2}\n";
        fs::write(&source, first).unwrap();
        let binding = test_binding("claude", "s");
        let mut cp = Checkpoint::default();
        let frame = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
        let path = accept(&dir, &binding, &mut cp, frame).unwrap();
        let saved = fs::read(dir.join("checkpoint.json")).unwrap();
        let cursor = cp.cursor.clone();
        fs::write(&source, all).unwrap();
        fs::create_dir(dir.join("checkpoint.tmp")).unwrap();
        let frame = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
        assert!(accept(&dir, &binding, &mut cp, frame).is_err());
        assert_eq!(cp.cursor, cursor);
        assert_eq!(fs::read(dir.join("checkpoint.json")).unwrap(), saved);
        fs::remove_dir(dir.join("checkpoint.tmp")).unwrap();
        cp = recover(&dir, &binding).unwrap();
        assert_eq!(cp.cursor, cursor);
        assert_eq!(fs::read_to_string(&path).unwrap(), first);
        let frame = qmux_cli::transcript_stream::read_frame(&source, "s", &cp.cursor).unwrap();
        accept(&dir, &binding, &mut cp, frame).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), all);
    }
}
