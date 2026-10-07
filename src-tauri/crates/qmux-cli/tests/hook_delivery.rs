//! Exercise the real detached worker: hooks exit during a stalled connection,
//! queued events survive a lost acknowledgment, and replay drains in order.
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn remote_hooks_return_while_disconnected_and_worker_replays_in_order() {
    let home = std::env::temp_dir().join(format!("qmux-hook-process-{}", std::process::id()));
    fs::create_dir(&home).unwrap();
    let socket = home.join("sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let (seen_tx, seen_rx) = std::sync::mpsc::channel();
    let (killed_tx, killed_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let mut deliveries = vec![];
        let deadline = Instant::now() + Duration::from_secs(15);
        while deliveries.len() < 3 {
            let (mut stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "worker did not drain queue");
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(e) => panic!("{e}"),
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
                stream
                    .write_all(b"{\"ok\":true,\"data\":{\"lease\":\"test-lease\"}}\n")
                    .unwrap();
                continue;
            }
            deliveries.push(request["payload"].clone());
            if deliveries.len() == 1 {
                seen_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                // Simulate a worker crash after desktop received the event,
                // before the acknowledgment made it back. Recover via probe.
                let pid = peer_pid(&stream);
                assert!(pid > 1 && pid != std::process::id() as i32);
                assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
                killed_tx.send(()).unwrap();
            } else {
                stream
                    .write_all(
                        format!(
                            "{}\n",
                            json!({"ok":true,"data":{"id":request["payload"]["id"], "replay":request["payload"]["replay"]}})
                        )
                        .as_bytes(),
                    )
                    .unwrap();
            }
        }
        deliveries
    });
    let notify = |event: &str| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qmux-cli"))
            .args(["notify", event])
            .env("HOME", &home)
            .env("QMUX_REMOTE", "1")
            .env("QMUX_SOCK", &socket)
            .env("QMUX_TOKEN", "test-private-token")
            .env("QMUX_PANE_ID", "pane")
            .env("QMUX_AGENT_ID", "agent")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(json!({"session_id":"session"}).to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // The server has not acknowledged anything and cannot proceed until
        // this hook returns and the caller releases it. This checks network
        // independence without imposing a wall-clock limit on local fsync or
        // first-launch executable verification under load.
    };
    notify("Stop");
    seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    notify("UserPromptSubmit");
    let queue = fs::read_dir(home.join(".qmux-hook-outbox"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.is_dir())
        .unwrap();
    let event_count = || {
        fs::read_dir(&queue)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|v| v == "event")
            })
            .count()
    };
    assert_eq!(
        event_count(),
        2,
        "events remain durable until acknowledgment"
    );
    release_tx.send(()).unwrap();
    killed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // Wait for the killed worker's lock to be released before resuming it.
    let worker_lock = fs::File::open(queue.join("worker.lock")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while unsafe { libc::flock(worker_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(worker_lock);
    let resumed = Command::new(env!("CARGO_BIN_EXE_qmux-cli"))
        .arg("hook-delivery-resume")
        .env("HOME", &home)
        .env("QMUX_SOCK", &socket)
        .env("QMUX_TOKEN", "test-private-token")
        .env("QMUX_PANE_ID", "pane")
        .output()
        .unwrap();
    assert!(
        resumed.status.success(),
        "{}",
        String::from_utf8_lossy(&resumed.stderr)
    );
    let delivered = server.join().unwrap();
    assert_eq!(delivered[0]["id"], delivered[1]["id"]);
    assert_eq!(delivered[0]["replay"], false);
    assert_eq!(delivered[1]["replay"], true);
    assert_eq!(delivered[1]["latest"], false);
    assert_eq!(delivered[2]["replay"], true);
    assert_eq!(delivered[2]["latest"], true);
    assert_eq!(delivered[2]["notification"]["event"], "UserPromptSubmit");
    let deadline = Instant::now() + Duration::from_secs(3);
    while event_count() != 0 || queue.join("recovering").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    fs::remove_dir_all(home).unwrap();
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

#[test]
fn healthy_hook_burst_preserves_live_lifecycle_delivery() {
    let home = std::env::temp_dir().join(format!("qmux-hook-burst-{}", std::process::id()));
    fs::create_dir(&home).unwrap();
    let socket = home.join("sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let (seen_tx, seen_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let mut deliveries = vec![];
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while deliveries.len() < 3 {
            let (mut stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(e) => panic!("{e}"),
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
                stream
                    .write_all(b"{\"ok\":true,\"data\":{\"lease\":\"test-lease\"}}\n")
                    .unwrap();
                continue;
            }
            deliveries.push(request["payload"].clone());
            if deliveries.len() == 1 {
                seen_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            }
            stream
                .write_all(
                    format!(
                        "{}\n",
                        json!({"ok":true,"data":{"id":request["payload"]["id"], "replay":request["payload"]["replay"]}})
                    )
                    .as_bytes(),
                )
                .unwrap();
        }
        deliveries
    });
    for (index, event) in ["SessionStart", "UserPromptSubmit", "Stop"]
        .into_iter()
        .enumerate()
    {
        let output = Command::new(env!("CARGO_BIN_EXE_qmux-cli"))
            .args(["notify", event])
            .env("HOME", &home)
            .env("QMUX_REMOTE", "1")
            .env("QMUX_SOCK", &socket)
            .env("QMUX_TOKEN", "burst-token")
            .env("QMUX_PANE_ID", "pane")
            .env("QMUX_AGENT_ID", "agent")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        if index == 0 {
            seen_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        }
    }
    release_tx.send(()).unwrap();
    let delivered = server.join().unwrap();
    assert!(delivered.iter().all(|event| event["replay"] == false));
    assert_eq!(delivered[1]["latest"], false);
    assert_eq!(delivered[1]["notification"]["event"], "UserPromptSubmit");
    let queue = fs::read_dir(home.join(".qmux-hook-outbox"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.is_dir())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let worker_lock = fs::File::open(queue.join("worker.lock")).unwrap();
        if unsafe { libc::flock(worker_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::remove_dir_all(home).unwrap();
}
