//! Durable remote hook outbox. The hook only waits for a local fsync; one
//! detached worker per credential/pane delivers events in enqueue order.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TTL: u64 = 24 * 60 * 60;
const MAX_EVENTS: usize = 512;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const WORKER_FD: &str = "QMUX_HOOK_WORKER_FD";

#[derive(Serialize, Deserialize)]
struct Event {
    id: String,
    created: u64,
    attempted: bool,
    replay: bool,
    notification: Value,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn private_dir(path: &Path) -> Result<(), String> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(format!("cannot create hook outbox: {e}")),
    }
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err("hook outbox directory must be private and owned by this user".into());
    }
    Ok(())
}

fn queue_path(socket: &str, token: &str, payload: &Value) -> Result<PathBuf, String> {
    // Use a private directory directly under HOME: no trust in XDG parents or
    // the socket directory, which may be shared /tmp on remote machines.
    let base = dirs::home_dir()
        .ok_or("home directory is unavailable")?
        .join(".qmux-hook-outbox");
    private_dir(&base)?;
    // Best-effort collection must never prevent a new hook from being saved.
    let _ = sweep_abandoned_queues(&base);
    let scope =
        serde_json::to_vec(&(socket, token, payload.get("paneId"))).map_err(|e| e.to_string())?;
    let path = base.join(format!("{:x}", Sha256::digest(scope)));
    private_dir(&path)?;
    Ok(path)
}

fn open_lock(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err("unsafe hook outbox lock file".into());
    }
    Ok(file)
}
fn try_lock(path: &Path) -> Result<Option<File>, String> {
    let file = open_lock(path)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Ok(None)
    } else {
        Err(error.to_string())
    }
}

fn sweep_abandoned_queues(base: &Path) -> Result<(), String> {
    let Some(_sweep_lock) = try_lock(&base.join("gc.lock"))? else {
        return Ok(());
    };
    let recent = fs::read_to_string(base.join("gc.last"))
        .ok()
        .and_then(|time| time.parse::<u64>().ok())
        .is_some_and(|time| now().saturating_sub(time) < 60);
    if recent {
        return Ok(());
    }
    for entry in fs::read_dir(base).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Only our hashed scope directories are eligible. Never follow links,
        // remove arbitrary files, or reclaim scope IDs by deleting sequence.
        if name.len() != 64 || !name.bytes().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            continue;
        }
        let _ = collect_expired_queue(&path);
    }
    atomic_write(base, "gc.last", now().to_string().as_bytes())
}

fn collect_expired_queue(queue: &Path) -> Result<(), String> {
    // Match producer lock order. Taking worker.lock first could make a racing
    // enqueue believe a worker exists, then skip collection on queue.lock.
    let Some(_queue_lock) = try_lock(&queue.join("queue.lock"))? else {
        return Ok(());
    };
    let Some(_worker_lock) = try_lock(&queue.join("worker.lock"))? else {
        return Ok(());
    };
    let mut pending = 0;
    let mut expired = false;
    for path in events(queue)? {
        if now().saturating_sub(read_event(&path)?.created) >= TTL {
            fs::remove_file(path).map_err(|e| e.to_string())?;
            expired = true;
        } else {
            pending += 1;
        }
    }
    let mut changed = expired;
    // No process can be writing a temporary file while both locks are held.
    for entry in fs::read_dir(queue).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().unwrap().to_string_lossy();
        if (name.starts_with('.') && name.ends_with(".tmp"))
            || (pending == 0 && matches!(name.as_ref(), "reconciliation.json" | "recovering"))
        {
            fs::remove_file(path).map_err(|e| e.to_string())?;
            changed = true;
        }
    }
    if expired {
        record_health(queue, "expired", None)?;
    }
    if changed { sync_dir(queue) } else { Ok(()) }
}

fn lock(queue: &Path) -> Result<File, String> {
    let file = open_lock(&queue.join("queue.lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(file)
}
fn sync_dir(queue: &Path) -> Result<(), String> {
    File::open(queue)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
fn atomic_write(queue: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = queue.join(format!(".{name}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(tmp, queue.join(name)).map_err(|e| e.to_string())?;
    sync_dir(queue)
}
fn events(queue: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = fs::read_dir(queue)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|e| e.path()).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.retain(|p| p.extension().is_some_and(|ext| ext == "event"));
    paths.sort();
    Ok(paths)
}
fn read_event(path: &Path) -> Result<Event, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub(super) fn enqueue(socket: &str, token: &str, notification: Value) -> Result<(), String> {
    let queue = queue_path(socket, token, &notification)?;
    let _lock = lock(&queue)?;
    enqueue_locked(&queue, notification)?;
    start_worker(&queue, socket, token)
}

pub(super) fn resume_or_health(health: bool, probe: bool) -> Result<(), String> {
    let socket = std::env::var("QMUX_SOCK").map_err(|_| "QMUX_SOCK is not set")?;
    let token = std::env::var("QMUX_TOKEN").map_err(|_| "QMUX_TOKEN is not set")?;
    let pane = std::env::var("QMUX_PANE_ID").map_err(|_| "QMUX_PANE_ID is not set")?;
    let queue = queue_path(&socket, &token, &json!({"paneId":pane}))?;
    let _lock = lock(&queue)?;
    let pending = events(&queue)?.len();
    if health {
        let saved = fs::read(queue.join("health.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let delivery = json!({"pending":pending,"status":saved.as_ref().and_then(|s|s.get("status")).unwrap_or(&json!("unknown")),"lastSuccess":saved.as_ref().and_then(|s|s.get("lastSuccess"))});
        drop(_lock);
        if probe {
            let raw = super::send_request(&socket, &token, "ping", json!({}))?;
            let mut response: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if response["ok"] == true {
                response["data"]["delivery"] = delivery;
            }
            println!("{response}");
        } else {
            println!("{delivery}");
        }
    } else if pending > 0 {
        start_worker(&queue, &socket, &token)?;
    }
    Ok(())
}

fn enqueue_locked(queue: &Path, notification: Value) -> Result<(), String> {
    // Atomic-write remnants can survive process/machine crashes. All writers
    // hold queue.lock, so no currently active write can own these files.
    for entry in fs::read_dir(queue).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with('.'))
            && path.extension().is_some_and(|ext| ext == "tmp")
        {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    let paths = events(queue)?;
    let mut count = 0;
    let mut bytes = 0;
    for path in paths {
        let event = read_event(&path)?;
        if now().saturating_sub(event.created) >= TTL {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        } else {
            count += 1;
            bytes += fs::metadata(path).map_err(|e| e.to_string())?.len();
        }
    }
    let counter = match fs::read_to_string(queue.join("sequence")) {
        Ok(s) => s
            .parse::<u64>()
            .map_err(|_| "invalid hook outbox sequence")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.to_string()),
    }
    .checked_add(1)
    .ok_or("hook outbox sequence exhausted")?;
    let name = format!("{counter:020}.event");
    let id = format!("{}-{counter}", queue.file_name().unwrap().to_string_lossy());
    let event = Event {
        id,
        created: now(),
        attempted: false,
        replay: false,
        notification,
    };
    let data = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
    if count >= MAX_EVENTS || bytes + data.len() as u64 > MAX_BYTES {
        record_health(queue, "full", None)?;
        return Err("remote hook outbox is full; reconnect qmux to resume delivery".into());
    }
    // Reserve the sequence before the event, so a crash never reuses an ID.
    atomic_write(queue, "sequence", counter.to_string().as_bytes())?;
    atomic_write(queue, &name, &data)
}

fn start_worker(queue: &Path, socket: &str, token: &str) -> Result<(), String> {
    let worker_lock = open_lock(&queue.join("worker.lock"))?;
    if unsafe { libc::flock(worker_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Ok(());
        }
        return Err(error.to_string());
    }
    let fd = worker_lock.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg("hook-delivery-worker")
        .arg(queue)
        .env(WORKER_FD, fd.to_string())
        .env("QMUX_SOCK", socket)
        .env("QMUX_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() == -1 || libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .spawn()
        .map_err(|e| format!("cannot start hook delivery worker: {e}"))?;
    Ok(())
}

pub(super) fn run(queue: PathBuf) -> Result<(), String> {
    private_dir(&queue)?;
    let fd = std::env::var(WORKER_FD)
        .map_err(|_| "hook delivery worker is internal")?
        .parse::<i32>()
        .map_err(|_| "invalid worker lock")?;
    if fd < 3 || unsafe { libc::fcntl(fd, libc::F_GETFD) } == -1 {
        return Err("invalid worker lock".into());
    }
    let worker_lock = unsafe { File::from_raw_fd(fd) };
    let socket = std::env::var("QMUX_SOCK").map_err(|_| "QMUX_SOCK is not set")?;
    let token = std::env::var("QMUX_TOKEN").map_err(|_| "QMUX_TOKEN is not set")?;
    let started = Instant::now();
    let mut delay = 1;
    loop {
        let guard = lock(&queue)?;
        let paths = events(&queue)?;
        let Some(path) = paths.first() else {
            // Release singleton lock while still holding producer lock. An
            // enqueue racing our shutdown will always start a replacement.
            for filename in ["reconciliation.json", "recovering"] {
                match fs::remove_file(queue.join(filename)) {
                    Ok(()) => sync_dir(&queue)?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
            drop(worker_lock);
            return Ok(());
        };
        let mut event = read_event(path)?;
        if now().saturating_sub(event.created) >= TTL {
            fs::remove_file(path).map_err(|e| e.to_string())?;
            record_health(&queue, "expired", None)?;
            continue;
        }
        let replay = event.replay
            || event.attempted
            || queue.join("recovering").exists()
            || now().saturating_sub(event.created) > 5;
        if replay {
            atomic_write(&queue, "recovering", b"1")?;
        }
        // Persist the snapshot even for a live attempt: the desktop can
        // downgrade it to replay if its short-lived delivery lease expires.
        let previous = fs::read(queue.join("reconciliation.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let snapshot = reconcile_snapshot(previous.as_ref(), &event.notification);
        atomic_write(
            &queue,
            "reconciliation.json",
            &serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?,
        )?;
        event.attempted = true;
        atomic_write(
            &queue,
            path.file_name().unwrap().to_str().unwrap(),
            &serde_json::to_vec(&event).map_err(|e| e.to_string())?,
        )?;
        drop(guard);
        let result = deliver(
            &socket,
            &token,
            &event,
            replay,
            paths.len() == 1,
            Some(&snapshot),
            Duration::from_secs(2),
        );
        let guard = lock(&queue)?;
        if let Ok(replayed) = result {
            if replayed {
                atomic_write(&queue, "recovering", b"1")?;
            }
            match fs::remove_file(path) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.to_string()),
            }
            sync_dir(&queue)?;
            record_health(&queue, "healthy", Some(now()))?;
            delay = 1;
        } else {
            atomic_write(&queue, "recovering", b"1")?;
            // Never persist arbitrary server error strings (or the token).
            let category = if is_authentication_error(result.as_ref().unwrap_err()) {
                "authentication failed"
            } else {
                "delivery unavailable"
            };
            record_health(&queue, category, None)?;
        }
        if started.elapsed() >= Duration::from_secs(TTL) {
            drop(worker_lock);
            return Ok(());
        }
        drop(guard);
        if result.is_err() {
            std::thread::sleep(Duration::from_secs(delay));
            delay = (delay * 2).min(30);
        }
    }
}
fn session_identity(notification: &Value) -> Option<&str> {
    let payload = notification.get("payload")?;
    [
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
        "resource_id",
        "resourceId",
    ]
    .into_iter()
    .find_map(|key| payload.get(key).and_then(Value::as_str))
}

fn reconcile_snapshot(previous: Option<&Value>, notification: &Value) -> Value {
    let previous = previous.filter(|previous| {
        previous.get("agentId") == notification.get("agentId")
            && previous.get("adapterId") == notification.get("adapterId")
            && !matches!(
                notification.get("event").and_then(Value::as_str),
                Some("SessionStart" | "sessionStart")
            )
            && !(!qmux_proto::hook_payload_is_subagent(
                notification.get("payload").unwrap_or(&Value::Null),
            ) && session_identity(previous).is_some()
                && session_identity(notification).is_some()
                && session_identity(previous) != session_identity(notification))
    });
    let lifecycle =
        !qmux_proto::hook_payload_is_subagent(notification.get("payload").unwrap_or(&Value::Null))
            && qmux_proto::hook_observation(
                notification
                    .get("event")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                notification.get("payload").unwrap_or(&Value::Null),
            )
            .is_some();
    let mut snapshot = if lifecycle {
        notification.clone()
    } else {
        previous.unwrap_or(notification).clone()
    };
    // Session and transcript hints are independent of lifecycle state. Carry
    // hints across non-lifecycle hooks, but never across agent generations.
    for source in [previous, Some(notification)].into_iter().flatten() {
        if qmux_proto::hook_payload_is_subagent(source.get("payload").unwrap_or(&Value::Null)) {
            continue;
        }
        for key in [
            "session_id",
            "sessionId",
            "conversation_id",
            "conversationId",
            "resource_id",
            "resourceId",
            "transcript_path",
            "transcriptPath",
            "cwd",
        ] {
            if let Some(value) = source.get("payload").and_then(|p| p.get(key)) {
                if !snapshot.get("payload").is_some_and(Value::is_object) {
                    snapshot["payload"] = json!({});
                }
                snapshot["payload"][key] = value.clone();
            }
        }
    }
    snapshot
}

fn is_authentication_error(error: &str) -> bool {
    error == "invalid QMUX_TOKEN" || error.contains("auth")
}

fn record_health(queue: &Path, status: &str, success: Option<u64>) -> Result<(), String> {
    let previous = fs::read(queue.join("health.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let success = success.or_else(|| previous.as_ref()?.get("lastSuccess")?.as_u64());
    atomic_write(
        queue,
        "health.json",
        &serde_json::to_vec(&json!({"status": status, "updated":now(), "lastSuccess":success}))
            .unwrap(),
    )
}
fn deliver(
    socket: &str,
    token: &str,
    event: &Event,
    replay: bool,
    latest: bool,
    snapshot: Option<&Value>,
    timeout: Duration,
) -> Result<bool, String> {
    let lease = if replay {
        None
    } else {
        let raw = super::send_request_with_timeout(
            socket,
            token,
            "hook.delivery-lease",
            json!({}),
            timeout,
        )?;
        super::validate_ack(&raw)?;
        let response: qmux_proto::ControlResponse =
            serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        Some(
            response
                .data
                .get("lease")
                .and_then(Value::as_str)
                .filter(|lease| !lease.is_empty())
                .ok_or("hook delivery lease is missing")?
                .to_string(),
        )
    };
    let response = super::send_request_with_timeout(
        socket,
        token,
        "hook.deliver",
        json!({
            "id": event.id, "replay": replay, "latest":latest, "notification":event.notification, "snapshot":snapshot, "lease":lease,
        }),
        timeout,
    )?;
    super::validate_ack(&response)?;
    let response: qmux_proto::ControlResponse =
        serde_json::from_str(&response).map_err(|e| e.to_string())?;
    if response.data.get("id").and_then(Value::as_str) != Some(event.id.as_str()) {
        return Err("hook acknowledgment does not match the queued event".into());
    }
    Ok(response
        .data
        .get("replay")
        .and_then(Value::as_bool)
        .unwrap_or(replay))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;

    fn temp() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "qmux-outbox-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        private_dir(&path).unwrap();
        path
    }
    #[test]
    fn concurrent_enqueues_are_ordered_unique_and_durable() {
        let dir = temp();
        std::thread::scope(|scope| {
            for n in 0..16 {
                let dir = &dir;
                scope.spawn(move || {
                    let _lock = lock(dir).unwrap();
                    enqueue_locked(dir, json!({"event":n})).unwrap();
                });
            }
        });
        let paths = events(&dir).unwrap();
        assert_eq!(paths.len(), 16);
        let events: Vec<_> = paths.iter().map(|p| read_event(p).unwrap()).collect();
        assert!(!events[0].replay);
        assert!(events.iter().all(|e| !e.replay));
        assert_eq!(
            events
                .iter()
                .map(|e| &e.id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            16
        );
        assert_eq!(fs::read_to_string(dir.join("sequence")).unwrap(), "16");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn transport_requires_ack_and_retries_keep_the_same_id() {
        let dir = temp();
        let socket = dir.join("socket");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let mut ids = vec![];
            for attempt in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let value: Value = serde_json::from_str(&line).unwrap();
                ids.push(value["payload"]["id"].clone());
                assert_eq!(value["payload"]["replay"], true);
                if attempt == 0 {
                    std::thread::sleep(Duration::from_millis(100));
                }
                if attempt == 2 {
                    stream
                        .write_all(
                            format!("{}\n", json!({"ok":true,"data":{"id":"same-id"}})).as_bytes(),
                        )
                        .unwrap();
                }
            }
            assert!(ids.windows(2).all(|pair| pair[0] == pair[1]));
        });
        let event = Event {
            id: "same-id".into(),
            created: now(),
            attempted: false,
            replay: false,
            notification: json!({}),
        };
        assert!(
            deliver(
                socket.to_str().unwrap(),
                "secret",
                &event,
                true,
                true,
                None,
                Duration::from_millis(20)
            )
            .is_err()
        );
        assert!(
            deliver(
                socket.to_str().unwrap(),
                "secret",
                &event,
                true,
                true,
                None,
                Duration::from_secs(1)
            )
            .is_err()
        );
        assert!(
            deliver(
                socket.to_str().unwrap(),
                "secret",
                &event,
                true,
                true,
                None,
                Duration::from_secs(1)
            )
            .is_ok()
        );
        server.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn snapshot_keeps_lifecycle_and_hints_but_resets_for_new_sessions() {
        let start = json!({"agentId":"a","adapterId":"claude","event":"SessionStart","payload":{"session_id":"one","transcript_path":"/one"}});
        let stop = json!({"agentId":"a","adapterId":"claude","event":"Stop","payload":{}});
        let notification = json!({"agentId":"a","adapterId":"claude","event":"UnknownHook","payload":{"message":"note"}});
        let stopped = reconcile_snapshot(Some(&start), &stop);
        let snapshot = reconcile_snapshot(Some(&stopped), &notification);
        assert_eq!(snapshot["event"], "Stop");
        assert_eq!(snapshot["payload"]["session_id"], "one");
        assert_eq!(snapshot["payload"]["transcript_path"], "/one");
        let new_start = json!({"agentId":"a","adapterId":"claude","event":"SessionStart","payload":{"session_id":"two"}});
        let reset = reconcile_snapshot(Some(&snapshot), &new_start);
        assert_eq!(reset["event"], "SessionStart");
        assert!(reset["payload"].get("transcript_path").is_none());
        let other = json!({"agentId":"b","adapterId":"claude","event":"Notification","payload":{}});
        assert_eq!(reconcile_snapshot(Some(&snapshot), &other), other);
    }

    #[test]
    fn expires_old_events_and_bounds_count_with_visible_health() {
        let dir = temp();
        let old = Event {
            id: "expired".into(),
            created: now() - TTL,
            attempted: true,
            replay: true,
            notification: json!({}),
        };
        fs::write(
            dir.join("00000000000000000000.event"),
            serde_json::to_vec(&old).unwrap(),
        )
        .unwrap();
        fs::write(dir.join(".abandoned.tmp"), b"unfinished").unwrap();
        enqueue_locked(&dir, json!({"event":"Stop"})).unwrap();
        assert_eq!(events(&dir).unwrap().len(), 1);
        assert!(!dir.join(".abandoned.tmp").exists());
        let fresh = Event {
            created: now(),
            ..old
        };
        let data = serde_json::to_vec(&fresh).unwrap();
        for n in 2..=MAX_EVENTS {
            fs::write(dir.join(format!("{n:020}.event")), &data).unwrap();
        }
        assert!(
            enqueue_locked(&dir, json!({}))
                .unwrap_err()
                .contains("full")
        );
        let health: Value =
            serde_json::from_slice(&fs::read(dir.join("health.json")).unwrap()).unwrap();
        assert_eq!(health["status"], "full");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_public_or_symlinked_queue_directories() {
        let dir = temp();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(private_dir(&link).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn classifies_invalid_token_as_authentication_failure() {
        assert!(is_authentication_error("invalid QMUX_TOKEN"));
        assert!(is_authentication_error(
            "control token is not authorized for that agent"
        ));
        assert!(!is_authentication_error(
            "failed to read response: timed out"
        ));
    }

    #[test]
    fn abandoned_queue_collection_expires_payloads_without_reusing_ids() {
        let base = temp();
        let queue = base.join("a".repeat(64));
        private_dir(&queue).unwrap();
        enqueue_locked(&queue, json!({"event":"Stop","payload":{"secret":"old"}})).unwrap();
        let path = events(&queue).unwrap().remove(0);
        let mut event = read_event(&path).unwrap();
        event.created = now() - TTL;
        fs::write(&path, serde_json::to_vec(&event).unwrap()).unwrap();
        fs::write(queue.join("reconciliation.json"), b"sensitive snapshot").unwrap();
        fs::write(queue.join(".abandoned.tmp"), b"sensitive partial write").unwrap();
        fs::write(queue.join("recovering"), b"1").unwrap();
        fs::write(queue.join("unrelated"), b"preserve").unwrap();
        // A worker owning its lock must never have its in-flight event removed.
        let worker = try_lock(&queue.join("worker.lock")).unwrap().unwrap();
        collect_expired_queue(&queue).unwrap();
        assert!(path.exists());
        drop(worker);
        // A producer owning queue.lock is likewise left alone without waiting.
        let producer = lock(&queue).unwrap();
        collect_expired_queue(&queue).unwrap();
        assert!(path.exists());
        drop(producer);
        let outside = base.join("not-a-scope");
        private_dir(&outside).unwrap();
        fs::write(outside.join("reconciliation.json"), b"preserve").unwrap();
        std::os::unix::fs::symlink(&outside, base.join("b".repeat(64))).unwrap();
        sweep_abandoned_queues(&base).unwrap();
        assert!(events(&queue).unwrap().is_empty());
        for name in ["reconciliation.json", "recovering", ".abandoned.tmp"] {
            assert!(!queue.join(name).exists());
        }
        for name in ["worker.lock", "queue.lock", "sequence", "unrelated"] {
            assert!(queue.join(name).exists());
        }
        assert!(outside.join("reconciliation.json").exists());
        enqueue_locked(&queue, json!({"event":"Stop"})).unwrap();
        assert!(queue.join("00000000000000000002.event").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn collection_preserves_unexpired_abandoned_events_and_snapshot() {
        let dir = temp();
        enqueue_locked(&dir, json!({"event":"Stop"})).unwrap();
        fs::write(dir.join("reconciliation.json"), b"snapshot").unwrap();
        collect_expired_queue(&dir).unwrap();
        assert_eq!(events(&dir).unwrap().len(), 1);
        assert!(dir.join("reconciliation.json").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn subagent_notification_keeps_parent_snapshot_and_identity() {
        let parent = json!({"agentId":"a","adapterId":"claude","event":"Stop","payload":{"session_id":"parent","transcript_path":"/parent"}});
        let child = json!({"agentId":"a","adapterId":"claude","event":"SubagentStop","payload":{"agent_id":"child","session_id":"child-session","transcript_path":"/child"}});
        let snapshot = reconcile_snapshot(Some(&parent), &child);
        assert_eq!(snapshot, parent);
        let child_stop = json!({"agentId":"a","adapterId":"claude","event":"Stop","payload":{"agent_id":"child","session_id":"child-session"}});
        assert_eq!(reconcile_snapshot(Some(&parent), &child_stop), parent);
        let notification = json!({"agentId":"a","adapterId":"claude","event":"Notification","payload":{"message":"question"}});
        assert_eq!(
            reconcile_snapshot(Some(&parent), &notification)["event"],
            "Notification"
        );
    }

    #[test]
    fn oversized_event_is_not_acknowledged_or_saved() {
        let dir = temp();
        assert!(enqueue_locked(&dir, json!({"data":"x".repeat(MAX_BYTES as usize)})).is_err());
        assert!(events(&dir).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
