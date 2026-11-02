//! Real notify/resume/worker processes and local control transport. No SSH.
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct Outbox {
    home: PathBuf,
    queue: PathBuf,
    listener: UnixListener,
}
impl Outbox {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let home = std::env::temp_dir().join(format!(
            "qmux-r09-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&home).unwrap();
        let listener = UnixListener::bind(home.join("sock")).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut result = Self {
            home,
            queue: PathBuf::new(),
            listener,
        };
        result.command(&["hook-delivery-health"]);
        result.queue = fs::read_dir(result.home.join(".qmux-hook-outbox"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.is_dir())
            .unwrap();
        result
    }
    fn command(&self, args: &[&str]) -> Value {
        let output = Command::new(env!("CARGO_BIN_EXE_qmux-cli"))
            .args(args)
            .env("HOME", &self.home)
            .env("QMUX_REMOTE", "1")
            .env("QMUX_SOCK", self.home.join("sock"))
            .env("QMUX_TOKEN", "fixture-token")
            .env("QMUX_PANE_ID", "pane")
            .env("QMUX_AGENT_ID", "agent")
            .env("QMUX_ADAPTER_ID", "claude")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
    }
    fn hold_worker(&self) -> File {
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.queue.join("worker.lock"))
            .unwrap();
        // The production lock opener requires 0600.
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        file
    }
    fn events(&self) -> Vec<PathBuf> {
        let mut paths: Vec<_> = fs::read_dir(&self.queue)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "event"))
            .collect();
        paths.sort();
        paths
    }
    fn edit_first(&self, edit: impl FnOnce(&mut Value)) {
        let path = self.events().remove(0);
        let mut event: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        edit(&mut event);
        fs::write(path, serde_json::to_vec(&event).unwrap()).unwrap();
    }
    fn receive(&self) -> (UnixStream, Value) {
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let (mut stream, _) = match self.listener.accept() {
                Ok(pair) => pair,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "worker stalled with {} durable events",
                        self.events().len()
                    );
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("{error}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            if request["command"] == "hook.delivery-lease" {
                Self::respond(&mut stream, json!({"ok":true,"data":{"lease":"lease"}}));
                continue;
            }
            assert_eq!(request["command"], "hook.deliver");
            return (stream, request["payload"].clone());
        }
    }
    fn respond(stream: &mut UnixStream, response: Value) {
        writeln!(stream, "{response}").unwrap();
    }
    fn ack(stream: &mut UnixStream, request: &Value) {
        Self::respond(
            stream,
            json!({"ok":true,"data":{"id":request["id"],"replay":request["replay"]}}),
        );
    }
    fn drained(&self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let worker = File::open(self.queue.join("worker.lock")).unwrap();
            if unsafe { libc::flock(worker.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                assert!(self.events().is_empty());
                assert!(!self.queue.join("recovering").exists());
                assert!(!self.queue.join("reconciliation.json").exists());
                return;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Outbox {
    fn drop(&mut self) {
        // Failed assertions must not leave a detached worker retrying a fixture.
        if let Ok(mut stream) = self.listener.accept().map(|pair| pair.0) {
            let _ = stream.write_all(b"{}\n");
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn recovered_backlog_has_a_finite_boundary_even_when_queue_never_empties() {
    let outbox = Outbox::new();
    let worker = outbox.hold_worker();
    for event in ["Stop", "PreToolUse", "Notification"] {
        outbox.command(&["notify", event]);
    }
    // Crash recovery: the head was attempted before the previous worker died.
    outbox.edit_first(|event| event["attempted"] = json!(true));
    drop(worker);
    outbox.command(&["hook-delivery-resume"]);
    let (mut stream, first) = outbox.receive();
    Outbox::ack(&mut stream, &first);
    drop(stream);
    let (mut stream, second) = outbox.receive(); // First ack establishes the boundary.
    for event in ["UserPromptSubmit", "Stop", "Notification"] {
        outbox.command(&["notify", event]);
    }
    assert_eq!(outbox.events().len(), 5); // Queue never became empty.
    Outbox::ack(&mut stream, &second);
    drop(stream);
    let mut delivered = vec![first, second];
    for _ in 0..4 {
        let (mut stream, request) = outbox.receive();
        Outbox::ack(&mut stream, &request);
        delivered.push(request);
    }
    outbox.drained();
    eprintln!(
        "delivered event/replay/latest: {:?}",
        delivered
            .iter()
            .map(|event| (
                &event["notification"]["event"],
                &event["replay"],
                &event["latest"]
            ))
            .collect::<Vec<_>>()
    );
    assert!(delivered[..3].iter().all(|event| event["replay"] == true));
    assert_eq!(
        delivered[2]["latest"], true,
        "reconcile the finite backlog boundary"
    );
    assert!(
        delivered[3..].iter().all(|event| event["replay"] == false),
        "fresh hooks after restored delivery must regain live lifecycle actions: {delivered:?}"
    );
    assert_eq!(delivered[4]["notification"]["event"], "Stop");
}

#[test]
fn permanent_invalid_notification_cannot_poison_successor_snapshot_or_hide_health() {
    let outbox = Outbox::new();
    let worker = outbox.hold_worker();
    outbox.command(&["notify", "Stop"]);
    outbox.command(&["notify", "SubagentStop"]);
    outbox.edit_first(|event| {
        event["attempted"] = json!(true);
        event["notification"]
            .as_object_mut()
            .unwrap()
            .remove("event");
    });
    // An old worker could already have persisted this unvalidated snapshot.
    let malformed: Value = serde_json::from_slice(&fs::read(&outbox.events()[0]).unwrap()).unwrap();
    fs::write(
        outbox.queue.join("reconciliation.json"),
        serde_json::to_vec(&malformed["notification"]).unwrap(),
    )
    .unwrap();
    drop(worker);
    outbox.command(&["hook-delivery-resume"]);
    let (mut stream, poison) = outbox.receive();
    Outbox::respond(
        &mut stream,
        json!({"ok":false,"error":"hook.invalid_notification","data":{"id":poison["id"],"replay":true,"discarded":true,"rejected":"invalid_notification"}}),
    );
    drop(stream);
    let (mut stream, successor) = outbox.receive();
    assert_ne!(
        successor["id"], poison["id"],
        "only the explicit permanent rejection may advance past this head"
    );
    Outbox::ack(&mut stream, &successor);
    drop(stream);
    outbox.drained();
    assert_eq!(
        successor["snapshot"]["event"], "SubagentStop",
        "rejection must remove the invalid cumulative snapshot"
    );
    let health = outbox.command(&["hook-delivery-health"]);
    assert!(
        health["lastRejected"].as_u64().is_some(),
        "later successful delivery must retain rejection evidence: {health}"
    );
}

#[test]
fn authentication_unknown_and_recoverable_server_errors_retain_the_same_event() {
    let outbox = Outbox::new();
    outbox.command(&["notify", "Stop"]);
    let mut ids = Vec::new();
    for error in [
        "invalid QMUX_TOKEN",
        "unknown command hook.deliver",
        "hook receipt lock poisoned",
    ] {
        let (mut stream, request) = outbox.receive();
        ids.push(request["id"].clone());
        assert_eq!(outbox.events().len(), 1);
        Outbox::respond(&mut stream, json!({"ok":false,"data":null,"error":error}));
    }
    let (mut stream, request) = outbox.receive();
    ids.push(request["id"].clone());
    Outbox::ack(&mut stream, &request);
    drop(stream);
    outbox.drained();
    assert!(ids.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(request["replay"], true);
    assert!(outbox.command(&["hook-delivery-health"])["lastRejected"].is_null());
}

#[test]
fn another_failure_reopens_recovery_before_new_hooks_can_execute_live() {
    let outbox = Outbox::new();
    let worker = outbox.hold_worker();
    for event in ["Stop", "Notification"] {
        outbox.command(&["notify", event]);
    }
    outbox.edit_first(|event| event["attempted"] = json!(true));
    drop(worker);
    outbox.command(&["hook-delivery-resume"]);
    let (mut stream, first) = outbox.receive();
    Outbox::ack(&mut stream, &first);
    drop(stream);
    let (mut stream, boundary) = outbox.receive();
    outbox.command(&["notify", "UserPromptSubmit"]);
    Outbox::respond(
        &mut stream,
        json!({"ok":false,"data":null,"error":"hook receipt lock poisoned"}),
    );
    drop(stream);
    let (mut stream, retried_boundary) = outbox.receive();
    Outbox::ack(&mut stream, &retried_boundary);
    drop(stream);
    let (mut stream, during_failure) = outbox.receive();
    // Another event after the successful retry belongs to the next live era.
    outbox.command(&["notify", "Stop"]);
    Outbox::ack(&mut stream, &during_failure);
    drop(stream);
    let (mut stream, fresh) = outbox.receive();
    Outbox::ack(&mut stream, &fresh);
    drop(stream);
    outbox.drained();
    assert_eq!(boundary["id"], retried_boundary["id"]);
    assert_eq!(during_failure["replay"], true);
    assert_eq!(during_failure["latest"], true);
    assert_eq!(fresh["replay"], false);
    assert_eq!(fresh["notification"]["event"], "Stop");
}

#[test]
fn confirmed_cutoff_survives_worker_crash_with_fresh_hooks_already_queued() {
    let outbox = Outbox::new();
    let worker = outbox.hold_worker();
    for event in ["Stop", "PreToolUse", "Notification"] {
        outbox.command(&["notify", event]);
    }
    outbox.edit_first(|event| event["attempted"] = json!(true));
    drop(worker);
    outbox.command(&["hook-delivery-resume"]);
    let (mut stream, first) = outbox.receive();
    Outbox::ack(&mut stream, &first);
    drop(stream);
    let (stream, interrupted) = outbox.receive();
    outbox.command(&["notify", "Stop"]);
    let pid = peer_pid(&stream);
    assert!(pid > 1 && pid != std::process::id() as i32);
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    drop(stream);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let worker = File::open(outbox.queue.join("worker.lock")).unwrap();
        if unsafe { libc::flock(worker.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    outbox.command(&["hook-delivery-resume"]);
    let mut delivered = Vec::new();
    for _ in 0..3 {
        let (mut stream, request) = outbox.receive();
        Outbox::ack(&mut stream, &request);
        delivered.push(request);
    }
    outbox.drained();
    assert_eq!(delivered[0]["id"], interrupted["id"]);
    assert_eq!(delivered[0]["replay"], true);
    assert_eq!(delivered[1]["latest"], true);
    assert_eq!(delivered[2]["replay"], false);
}

#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> i32 {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
    assert_eq!(
        unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut libc::pid_t).cast(),
                &mut len,
            )
        },
        0
    );
    pid
}
#[cfg(target_os = "linux")]
fn peer_pid(stream: &UnixStream) -> i32 {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of_val(&credentials) as libc::socklen_t;
    assert_eq!(
        unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut len,
            )
        },
        0
    );
    credentials.pid
}
