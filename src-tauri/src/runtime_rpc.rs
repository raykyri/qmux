//! Private, bounded runtime IPC. Events are invalidation notices, not model
//! patches: clients refetch affected entities and replace snapshots on a gap.
//! A snapshot's cursor is sampled BEFORE its model read, so a concurrent change
//! can be reported twice but can never be silently skipped.
use crate::{events::QmuxEvent, state::AppState};
use qmux_proto::runtime::{MAX_REQUEST, MAX_RESPONSE, Operation, Request, Response, VERSION};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const EVENT_BYTES: usize = 16 * 1024 * 1024;
const EVENT_COUNT: usize = 4096;
const CLIENT_COUNT: usize = 65_536;
const TOTAL_REPLY_BYTES: usize = 8 * 1024 * 1024;
const CACHED_REPLY_BYTES: usize = 512 * 1024;

pub(crate) fn private_directory(root: &Path) -> Result<PathBuf, String> {
    match fs::DirBuilder::new().mode(0o700).create(root) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    let meta = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err("runtime directory must be owned by this user with mode 0700".into());
    }
    root.canonicalize().map_err(|e| e.to_string())
}

pub(crate) fn exclusive_lock(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err("runtime lock must be an owner-only regular file".into());
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("this runtime or workspace already has an owner".into());
    }
    Ok(file)
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn write_frame<T: Serialize>(
    stream: &mut UnixStream,
    value: &T,
    limit: usize,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("runtime frame exceeds size limit".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|()| stream.write_all(&bytes))
        .map_err(|e| e.to_string())
}
fn read_frame<T: DeserializeOwned>(stream: &mut UnixStream, limit: usize) -> Result<T, String> {
    let mut length = [0; 4];
    stream.read_exact(&mut length).map_err(|e| e.to_string())?;
    let length = u32::from_be_bytes(length) as usize;
    if length > limit {
        return Err("runtime frame exceeds size limit".into());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[derive(Default)]
struct EventLog {
    sequence: u64,
    bytes: usize,
    entries: VecDeque<(u64, Value, usize)>,
}
impl EventLog {
    fn push(&mut self, event: QmuxEvent) {
        self.sequence += 1;
        let value = serde_json::to_value(event).expect("QmuxEvent serializes");
        let size = serde_json::to_vec(&value).expect("JSON serializes").len();
        self.bytes += size;
        self.entries.push_back((self.sequence, value, size));
        while self.bytes > EVENT_BYTES || self.entries.len() > EVENT_COUNT {
            if let Some((_, _, size)) = self.entries.pop_front() {
                self.bytes -= size;
            }
        }
    }
    fn since(&self, after: u64) -> Value {
        let first = self
            .entries
            .front()
            .map(|e| e.0)
            .unwrap_or(self.sequence + 1);
        let gap = after > self.sequence || after.saturating_add(1) < first;
        let events: Vec<_> = if gap {
            vec![]
        } else {
            self.entries
                .iter()
                .filter(|e| e.0 > after)
                .map(|(sequence, event, _)| json!({"sequence": sequence, "event": event}))
                .collect()
        };
        json!({"cursor": self.sequence, "gap": gap, "events": events})
    }
}

struct Receipt {
    sequence: u64,
    fingerprint: [u8; 32],
}
#[derive(Default)]
struct ReplyCache {
    entries: HashMap<String, (Result<Value, String>, usize)>,
    order: VecDeque<String>,
    bytes: usize,
}
impl ReplyCache {
    fn insert(&mut self, client: &str, result: &Result<Value, String>) -> Result<(), String> {
        if let Some((_, size)) = self.entries.remove(client) {
            self.bytes -= size;
        }
        self.order.retain(|id| id != client);
        let size = serde_json::to_vec(result).map_err(|e| e.to_string())?.len();
        if size > CACHED_REPLY_BYTES {
            return Ok(());
        }
        self.bytes += size;
        self.order.push_back(client.into());
        self.entries.insert(client.into(), (result.clone(), size));
        while self.bytes > TOTAL_REPLY_BYTES {
            if let Some(id) = self.order.pop_front() {
                if let Some((_, size)) = self.entries.remove(&id) {
                    self.bytes -= size;
                }
            }
        }
        Ok(())
    }
}
#[derive(Default)]
struct Receipts {
    clients: Mutex<HashMap<String, Arc<Mutex<Option<Receipt>>>>>,
    replies: Mutex<ReplyCache>,
}
impl Receipts {
    fn execute(
        &self,
        client: &str,
        sequence: u64,
        method: &str,
        args: &Value,
        action: impl FnOnce() -> Result<Value, String>,
    ) -> Result<Value, String> {
        if client.len() != 64 || !client.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid runtime client identity".into());
        }
        let lane = {
            let mut clients = self
                .clients
                .lock()
                .map_err(|_| "client registry lock poisoned")?;
            if let Some(lane) = clients.get(client) {
                lane.clone()
            } else {
                if sequence != 1 || clients.len() >= CLIENT_COUNT {
                    return Err("unknown client sequence or runtime client capacity reached".into());
                }
                let lane = Arc::new(Mutex::new(None));
                clients.insert(client.into(), lane.clone());
                lane
            }
        };
        // Independent clients may execute concurrently. Only a client's own
        // ambiguous/retried mutation waits for its prior operation to finish.
        let mut last = lane
            .lock()
            .map_err(|_| "client command failed; reconnect and inspect state")?;
        let fingerprint: [u8; 32] =
            Sha256::digest(serde_json::to_vec(&(method, args)).map_err(|e| e.to_string())?).into();
        if let Some(last) = &*last {
            if sequence == last.sequence {
                return if fingerprint == last.fingerprint {
                    self.replies
                        .lock()
                        .map_err(|_| "reply cache lock poisoned")?
                        .entries
                        .get(client)
                        .map(|(result, _)| result.clone())
                        .unwrap_or_else(|| {
                            Err(
                                "request already executed; cached reply expired; refresh state"
                                    .into(),
                            )
                        })
                } else {
                    Err("request sequence was reused with a different payload".into())
                };
            }
            if last.sequence.checked_add(1) != Some(sequence) {
                return Err("request sequence is stale or out of order; refresh state".into());
            }
        } else if sequence != 1 {
            return Err("invalid initial request sequence".into());
        }
        let result = action();
        *last = Some(Receipt {
            sequence,
            fingerprint,
        });
        self.replies
            .lock()
            .map_err(|_| "reply cache lock poisoned")?
            .insert(client, &result)?;
        result
    }
}

struct Core {
    state: AppState,
    token: String,
    boot: String,
    events: Arc<Mutex<EventLog>>,
    receipts: Receipts,
    shutdown_requested: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
}
impl Core {
    fn handle(&self, request: Request) -> Response {
        let result = (|| {
            if request.version != VERSION {
                return Err("incompatible runtime protocol; no action performed".into());
            }
            if request.token != self.token {
                return Err("runtime authentication failed".into());
            }
            if !matches!(request.operation, Operation::Hello)
                && request.boot.as_deref() != Some(&self.boot)
            {
                return Err("runtime restarted; refresh state before issuing commands".into());
            }
            if !self.ready.load(Ordering::Acquire) {
                return Err("runtime is starting; reconnect when ready".into());
            }
            match request.operation {
                Operation::Hello => Ok(
                    json!({"workspaceRoot": self.state.config().workspace_root, "eventMode": "invalidation"}),
                ),
                Operation::Snapshot => {
                    let cursor = self
                        .events
                        .lock()
                        .map_err(|_| "event lock poisoned")?
                        .sequence;
                    Ok(json!({"cursor": cursor, "state": self.state.runtime_snapshot()?}))
                }
                Operation::Events { after } => Ok(self
                    .events
                    .lock()
                    .map_err(|_| "event lock poisoned")?
                    .since(after)),
                Operation::Call {
                    client,
                    sequence,
                    method,
                    args,
                } => self
                    .receipts
                    .execute(&client, sequence, &method, &args, || {
                        if self.shutdown_requested.load(Ordering::Acquire) {
                            return Err("runtime is shutting down".into());
                        }
                        if method == "runtime_shutdown" {
                            self.shutdown_requested.store(true, Ordering::Release);
                            return Ok(Value::Null);
                        }
                        crate::runtime_commands::dispatch(&self.state, &method, args.clone())
                    }),
            }
        })();
        let (result, error) = match result {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        Response {
            version: VERSION,
            boot: self.boot.clone(),
            result,
            error,
        }
    }
}

/// The listener's lifetime never owns pane lifetime. Dropping it disconnects
/// clients; explicit execution shutdown is a separate operation.
pub struct RuntimeServer {
    root: PathBuf,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    _lock: File,
    shutdown_requested: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
}
impl RuntimeServer {
    pub fn shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::Acquire)
    }

    pub fn bind(state: AppState, root: &Path) -> Result<Self, String> {
        Self::bind_with_readiness(state, root, true)
    }
    pub fn bind_starting(state: AppState, root: &Path) -> Result<Self, String> {
        Self::bind_with_readiness(state, root, false)
    }
    pub fn activate(&self) {
        self.ready.store(true, Ordering::Release);
    }
    pub fn stop_accepting(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
    fn bind_with_readiness(state: AppState, root: &Path, ready: bool) -> Result<Self, String> {
        let ready = Arc::new(AtomicBool::new(ready));
        let root = private_directory(root)?;
        if root.join("runtime.sock").as_os_str().len() >= 100 {
            return Err("runtime socket path is too long".into());
        }
        let lock = exclusive_lock(&root.join("owner.lock"))?;
        let socket = root.join("runtime.sock");
        if let Ok(meta) = fs::symlink_metadata(&socket) {
            if !meta.file_type().is_socket() {
                return Err("refusing to replace a non-socket runtime path".into());
            }
        }
        // The directory and exclusive lock prove ownership of stale names.
        match fs::remove_file(&socket) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        let listener = UnixListener::bind(&socket).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let token = random_id()?;
        let mut token_file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root.join("credential"))
            .map_err(|e| e.to_string())?;
        let meta = token_file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err("invalid runtime credential permissions".into());
        }
        token_file.set_len(0).map_err(|e| e.to_string())?;
        token_file
            .write_all(token.as_bytes())
            .and_then(|()| token_file.sync_all())
            .map_err(|e| e.to_string())?;
        let events = Arc::new(Mutex::new(EventLog::default()));
        let sink = Arc::downgrade(&events);
        state.set_event_sink(Some(Arc::new(move |event| {
            if let Some(sink) = sink.upgrade() {
                if let Ok(mut log) = sink.lock() {
                    log.push(event);
                }
            }
        })));
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let core = Arc::new(Core {
            state,
            token,
            boot: random_id()?,
            events,
            receipts: Receipts::default(),
            shutdown_requested: shutdown_requested.clone(),
            ready: ready.clone(),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::spawn(move || {
            let limiter = crate::connection_limit::ConnectionLimiter::new(32);
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            while !stopping.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let Some(slot) = limiter.try_acquire() else {
                            continue;
                        };
                        let core = core.clone();
                        workers.push(thread::spawn(move || {
                            let _slot = slot;
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                            if let Ok(request) = read_frame(&mut stream, MAX_REQUEST) {
                                let response = core.handle(request);
                                let _ = write_frame(&mut stream, &response, MAX_RESPONSE);
                            }
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
                let mut index = 0;
                while index < workers.len() {
                    if workers[index].is_finished() {
                        let _ = workers.swap_remove(index).join();
                    } else {
                        index += 1;
                    }
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
            core.state.set_event_sink(None);
        });
        Ok(Self {
            root,
            stop,
            thread: Some(thread),
            _lock: lock,
            shutdown_requested,
            ready,
        })
    }
}
impl Drop for RuntimeServer {
    fn drop(&mut self) {
        self.stop_accepting();
        let _ = fs::remove_file(self.root.join("runtime.sock"));
        let _ = fs::remove_file(self.root.join("credential"));
    }
}

/// Sequential caller. Transport failures retain the exact pending mutation;
/// callers must retry it or reconnect and inspect state, never silently resend
/// it under a new identity. A changed daemon boot is always an error.
pub struct RuntimeClient {
    root: PathBuf,
    token: String,
    boot: String,
    client: String,
    sequence: u64,
    pending: Option<(String, Value)>,
}
impl RuntimeClient {
    pub fn connect(root: &Path) -> Result<Self, String> {
        let root = private_directory(root)?;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("credential"))
            .map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.mode() & 0o077 != 0 || meta.uid() != unsafe { libc::geteuid() } {
            return Err("invalid runtime credential permissions".into());
        }
        let mut token = String::new();
        (&mut file)
            .take(65)
            .read_to_string(&mut token)
            .map_err(|e| e.to_string())?;
        if token.len() != 64 {
            return Err("invalid runtime credential".into());
        }
        let mut client = Self {
            root,
            token,
            boot: String::new(),
            client: random_id()?,
            sequence: 1,
            pending: None,
        };
        let response = client.exchange(Operation::Hello)?;
        Self::value(response.clone())?;
        client.boot = response.boot;
        Ok(client)
    }
    pub fn boot(&self) -> &str {
        &self.boot
    }
    fn exchange(&self, operation: Operation) -> Result<Response, String> {
        let mut stream = UnixStream::connect(self.root.join("runtime.sock"))
            .map_err(|e| format!("runtime disconnected: {e}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(120)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| e.to_string())?;
        write_frame(
            &mut stream,
            &Request {
                version: VERSION,
                token: self.token.clone(),
                boot: Some(self.boot.clone()),
                operation,
            },
            MAX_REQUEST,
        )?;
        let response: Response = read_frame(&mut stream, MAX_RESPONSE)?;
        if response.version != VERSION || (!self.boot.is_empty() && self.boot != response.boot) {
            return Err("runtime identity changed; reconnect and refresh state".into());
        }
        Ok(response)
    }
    fn value(response: Response) -> Result<Value, String> {
        if let Some(error) = response.error {
            Err(error)
        } else {
            Ok(response.result.unwrap_or(Value::Null))
        }
    }
    pub fn snapshot(&self) -> Result<Value, String> {
        Self::value(self.exchange(Operation::Snapshot)?)
    }
    pub fn events(&self, after: u64) -> Result<Value, String> {
        Self::value(self.exchange(Operation::Events { after })?)
    }
    pub fn call(&mut self, method: &str, args: Value) -> Result<Value, String> {
        if let Some((pending_method, pending_args)) = &self.pending {
            if pending_method != method || pending_args != &args {
                return Err("previous runtime command has an unknown outcome; retry that exact command first".into());
            }
        }
        self.pending = Some((method.into(), args.clone()));
        let response = self.exchange(Operation::Call {
            client: self.client.clone(),
            sequence: self.sequence,
            method: method.into(),
            args,
        })?;
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("runtime client sequence exhausted")?;
        self.pending = None;
        Self::value(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(root: &Path) -> AppState {
        AppState::new(
            serde_json::from_value(
                json!({"workspaceRoot":root,"socketPath":root.join("control.sock")}),
            )
            .unwrap(),
        )
    }
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "qr-{}-{}",
            std::process::id(),
            &random_id().unwrap()[..12]
        ))
    }
    #[test]
    fn receipts_reject_replays_conflicts_and_expired_results() {
        let receipts = Receipts::default();
        let client = "a".repeat(64);
        let args = json!({"text":"hello"});
        assert_eq!(
            receipts
                .execute(&client, 1, "create", &args, || Ok(json!(42)))
                .unwrap(),
            json!(42)
        );
        assert_eq!(
            receipts
                .execute(&client, 1, "create", &args, || panic!("replayed mutation"))
                .unwrap(),
            json!(42)
        );
        assert!(
            receipts
                .execute(&client, 1, "create", &json!({}), || panic!(
                    "changed payload"
                ))
                .is_err()
        );
        assert!(
            receipts
                .execute(&client, 3, "create", &args, || panic!("skipped sequence"))
                .is_err()
        );
        *receipts.replies.lock().unwrap() = ReplyCache::default();
        assert!(
            receipts
                .execute(&client, 1, "create", &args, || panic!(
                    "expired receipt replayed"
                ))
                .is_err()
        );
        receipts
            .execute(&client, 2, "create", &args, || Ok(json!(43)))
            .unwrap();
        assert!(
            receipts
                .execute(&client, 1, "create", &args, || panic!("stale mutation"))
                .is_err()
        );
    }
    #[test]
    fn events_report_retention_gaps_and_future_cursors() {
        let mut log = EventLog::default();
        for _ in 0..EVENT_COUNT + 2 {
            log.push(QmuxEvent::new("changed", None, None, Value::Null));
        }
        assert_eq!(log.since(0)["gap"], true);
        assert_eq!(log.since(2)["gap"], false);
        assert_eq!(log.since(log.sequence)["events"], json!([]));
        assert_eq!(log.since(log.sequence + 1)["gap"], true);
    }
    #[test]
    fn socket_reconnect_preserves_state_and_rejects_wrong_boot_and_token() {
        let root = root();
        let state = state(&root);
        let server = RuntimeServer::bind(state.clone(), &root).unwrap();
        assert!(RuntimeServer::bind(state.clone(), &root).is_err());
        let mut client = RuntimeClient::connect(&root).unwrap();
        let created = client
            .call("create_global_draft", json!({"text":"survives disconnect"}))
            .unwrap();
        let boot = client.boot.clone();
        drop(client);
        let mut client = RuntimeClient::connect(&root).unwrap();
        assert_eq!(client.boot(), boot);
        assert_eq!(
            client.snapshot().unwrap()["state"]["globalDrafts"][0],
            created
        );
        let original = client.token.clone();
        client.token = "wrong".into();
        assert!(client.snapshot().is_err());
        client.token = original;
        client.boot = "old-boot".into();
        assert!(
            client
                .call("create_global_draft", json!({"text":"must not run"}))
                .is_err()
        );
        assert_eq!(state.global_drafts().unwrap().len(), 1);
        drop(server);
        let server = RuntimeServer::bind(state.clone(), &root).unwrap();
        assert!(client.snapshot().is_err());
        assert_ne!(RuntimeClient::connect(&root).unwrap().boot(), boot);
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn framing_rejects_oversized_input_before_allocating_body() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        a.write_all(&((MAX_REQUEST + 1) as u32).to_be_bytes())
            .unwrap();
        assert!(
            read_frame::<Request>(&mut b, MAX_REQUEST)
                .unwrap_err()
                .contains("size limit")
        );
    }
    #[test]
    fn unrelated_clients_do_not_wait_for_a_slow_command() {
        let receipts = Arc::new(Receipts::default());
        let (started, running) = std::sync::mpsc::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let slow = receipts.clone();
        let worker = thread::spawn(move || {
            slow.execute(&"a".repeat(64), 1, "slow", &json!({}), || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(Value::Null)
            })
        });
        running.recv_timeout(Duration::from_secs(3)).unwrap();
        receipts
            .execute(&"b".repeat(64), 1, "fast", &json!({}), || Ok(Value::Null))
            .unwrap();
        finish.send(()).unwrap();
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn lost_reply_can_be_retrieved_without_repeating_the_mutation() {
        let root = root();
        let state = state(&root);
        let server = RuntimeServer::bind(state.clone(), &root).unwrap();
        let client = RuntimeClient::connect(&root).unwrap();
        let operation = || Operation::Call {
            client: client.client.clone(),
            sequence: 1,
            method: "create_global_draft".into(),
            args: json!({"text":"one draft"}),
        };
        let mut stream = UnixStream::connect(root.join("runtime.sock")).unwrap();
        write_frame(
            &mut stream,
            &Request {
                version: VERSION,
                token: client.token.clone(),
                boot: Some(client.boot.clone()),
                operation: operation(),
            },
            MAX_REQUEST,
        )
        .unwrap();
        drop(stream); // server can commit even though nobody reads its response
        RuntimeClient::value(client.exchange(operation()).unwrap()).unwrap();
        assert_eq!(state.global_drafts().unwrap().len(), 1);
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bind_refuses_to_replace_an_unrelated_file() {
        let root = root();
        private_directory(&root).unwrap();
        fs::write(root.join("runtime.sock"), "keep me").unwrap();
        assert!(RuntimeServer::bind(state(&root), &root).is_err());
        assert_eq!(
            fs::read_to_string(root.join("runtime.sock")).unwrap(),
            "keep me"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn starting_runtime_rejects_clients_and_shutdown_returns_null() {
        let root = root();
        let server = RuntimeServer::bind_starting(state(&root), &root).unwrap();
        assert!(RuntimeClient::connect(&root).is_err());
        server.activate();
        let mut client = RuntimeClient::connect(&root).unwrap();
        assert_eq!(
            client.call("runtime_shutdown", json!({})).unwrap(),
            Value::Null
        );
        assert!(server.shutdown_requested());
        assert!(
            client
                .call("create_global_draft", json!({"text":"too late"}))
                .is_err()
        );
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }
}
