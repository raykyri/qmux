//! Pull-only remote snapshots. Requests retain immutable cache entries until the
//! preview closes; transport workers never emit browser.open events.
use crate::{host::RemoteCommand, remote_transcript, state::AppState};
use qmux_cli::file_fetch::{Header, Metadata, Request};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CACHE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_AGE: u64 = 7 * 24 * 3600;
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    key: String,
    metadata: Metadata,
    fetched_at: u64,
    name: String,
    #[serde(skip)]
    dir: PathBuf,
}
impl Entry {
    fn path(&self) -> PathBuf {
        self.dir.join("content").join(&self.name)
    }
}
#[derive(Default)]
struct Progress {
    bytes: u64,
    total: Option<u64>,
    result: Option<Result<Entry, String>>,
    cached_available: bool,
}
struct Job {
    progress: Mutex<Progress>,
    cancel: AtomicBool,
    previous: Option<Entry>,
}
struct Handle {
    pane: String,
    transcript: String,
    key: String,
    job: Arc<Job>,
}
static REQUESTS: LazyLock<Mutex<HashMap<String, Handle>>> = LazyLock::new(Default::default);
static CACHE_LOCK: Mutex<()> = Mutex::new(());
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub bytes: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub cached_available: bool,
    pub fetched_at: Option<u64>,
    pub url: Option<String>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn root(state: &AppState) -> PathBuf {
    state
        .config()
        .workspace_root
        .join(".qmux/remote-preview-cache")
}
fn safe_cache_root(state: &AppState) -> bool {
    fs::symlink_metadata(root(state)).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Unsafe preview cache directory".into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}
fn entries(state: &AppState) -> Vec<Entry> {
    if !safe_cache_root(state) {
        return Vec::new();
    }
    let Ok(dirs) = fs::read_dir(root(state)) else {
        return Vec::new();
    };
    dirs.flatten()
        .filter_map(|dir| {
            if !dir.file_type().ok()?.is_dir() {
                return None;
            }
            let mut entry: Entry =
                serde_json::from_slice(&fs::read(dir.path().join("entry.json")).ok()?).ok()?;
            if !qmux_proto::is_safe_browser_preview_name(&entry.name) {
                return None;
            }
            entry.dir = fs::canonicalize(dir.path()).ok()?;
            if !fs::symlink_metadata(entry.dir.join("content"))
                .ok()?
                .is_dir()
            {
                return None;
            }
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            (meta.is_file() && meta.len() == entry.metadata.size).then_some(entry)
        })
        .collect()
}
fn cached(state: &AppState, key: &str) -> Option<Entry> {
    entries(state)
        .into_iter()
        .filter(|e| e.key == key)
        .max_by_key(|e| e.fetched_at)
}
/// No metadata directory is ever a preview root. Active handles pin only blobs.
pub fn cleanup(state: &AppState) {
    let _cache = CACHE_LOCK.lock().unwrap();
    if !safe_cache_root(state) {
        return;
    }
    let requests = REQUESTS.lock().unwrap();
    let pinned = requests
        .values()
        .flat_map(|h| {
            let completed = h
                .job
                .progress
                .lock()
                .unwrap()
                .result
                .clone()
                .and_then(Result::ok);
            completed
                .into_iter()
                .chain(h.job.previous.clone())
                .map(|e| e.path())
        })
        .collect::<Vec<_>>();
    let mut all = entries(state);
    all.sort_by_key(|e| e.fetched_at);
    let mut total: u64 = all.iter().map(|e| e.metadata.size).sum();
    let mut count = all.len();
    for entry in all {
        if !pinned.contains(&entry.path())
            && (total > CACHE_BYTES
                || count > 512
                || now().saturating_sub(entry.fetched_at) > MAX_AGE)
        {
            state.revoke_snapshot_preview(&entry.path());
            if fs::remove_dir_all(&entry.dir).is_ok() {
                total = total.saturating_sub(entry.metadata.size);
                count = count.saturating_sub(1);
            }
        }
    }
    // A crashed transfer has no index. A grace period avoids live workers.
    if let Ok(dirs) = fs::read_dir(root(state)) {
        for dir in dirs.flatten() {
            if dir.file_type().is_ok_and(|t| t.is_dir())
                && !dir.path().join("entry.json").exists()
                && dir
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(300))
            {
                let _ = fs::remove_dir_all(dir.path());
            }
        }
    }
}

fn cache_key(identity: &str, cwd: &str, path: &str) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(identity, cwd, path)).map_err(|e| e.to_string())?)
    ))
}

pub fn info(
    state: &AppState,
    pane: &str,
    transcript: &str,
    path: &str,
) -> Result<serde_json::Value, String> {
    let (_, cwd, _, identity) = remote_transcript::preview_source(state, pane, transcript)?;
    let key = cache_key(&identity, &cwd, path)?;
    let _cache = CACHE_LOCK.lock().unwrap();
    let entry = cached(state, &key);
    let resolved = entry
        .as_ref()
        .map(|e| e.metadata.path.clone())
        .unwrap_or_else(|| Path::new(&cwd).join(path).to_string_lossy().into_owned());
    Ok(serde_json::json!({ "cachedAvailable": entry.is_some(), "path": resolved }))
}

pub fn start(
    state: &AppState,
    pane: String,
    transcript: String,
    path: String,
    cached_only: bool,
) -> Result<String, String> {
    if path.is_empty() || path.len() > 8192 {
        return Err("Invalid remote file path".into());
    }
    let (host, cwd, roots, identity) =
        remote_transcript::preview_source(state, &pane, &transcript)?;
    let key = cache_key(&identity, &cwd, &path)?;
    cleanup(state);
    let _cache = CACHE_LOCK.lock().unwrap();
    let mut requests = REQUESTS.lock().unwrap();
    if requests.len() >= 16 {
        return Err("Close another remote preview before opening more".into());
    }
    let previous = cached(state, &key);
    let job = if !cached_only {
        requests
            .values()
            .find(|h| {
                h.key == key
                    && !h.job.cancel.load(Ordering::SeqCst)
                    && h.job.progress.lock().unwrap().result.is_none()
            })
            .map(|h| h.job.clone())
    } else {
        None
    };
    let id = state.next_id("remote-preview");
    let is_new = job.is_none();
    let job = job.unwrap_or_else(|| {
        Arc::new(Job {
            progress: Mutex::new(Progress {
                cached_available: previous.is_some(),
                ..Default::default()
            }),
            cancel: AtomicBool::new(false),
            previous: previous.clone(),
        })
    });
    requests.insert(
        id.clone(),
        Handle {
            pane,
            transcript,
            key: key.clone(),
            job: job.clone(),
        },
    );
    drop(requests);
    if is_new {
        if cached_only {
            job.progress.lock().unwrap().result =
                Some(previous.ok_or("No cached copy is available".into()));
        } else {
            let state = state.clone();
            let upload = id.clone();
            std::thread::spawn(move || {
                let result = fetch(
                    &state,
                    &host,
                    Request {
                        path,
                        cwd,
                        roots,
                        previous: previous.as_ref().map(|e| e.metadata.clone()),
                        download: false,
                    },
                    &key,
                    &upload,
                    &job,
                    previous,
                );
                let _cache = CACHE_LOCK.lock().unwrap();
                let result = result.and_then(|entry| {
                    save_entry(&entry)?;
                    Ok(entry)
                });
                job.progress.lock().unwrap().result = Some(result);
            });
        }
    }
    Ok(id)
}
pub fn status(state: &AppState, id: &str) -> Result<Status, String> {
    let requests = REQUESTS.lock().unwrap();
    let handle = requests.get(id).ok_or("Preview request was closed")?;
    remote_transcript::preview_source(state, &handle.pane, &handle.transcript)?;
    let p = handle.job.progress.lock().unwrap();
    let mut status = Status {
        bytes: p.bytes,
        total: p.total,
        error: None,
        cached_available: p.cached_available,
        fetched_at: None,
        url: None,
    };
    match &p.result {
        Some(Ok(entry)) => {
            status.url = Some(crate::remote_files::preview_url(
                state,
                &handle.pane,
                &entry.path(),
            )?);
            status.fetched_at = Some(entry.fetched_at);
        }
        Some(Err(error)) => status.error = Some(error.clone()),
        None => {}
    }
    Ok(status)
}
pub fn close(state: &AppState, id: &str) {
    let mut requests = REQUESTS.lock().unwrap();
    if let Some(handle) = requests.remove(id) {
        if !requests.values().any(|h| Arc::ptr_eq(&h.job, &handle.job)) {
            handle.job.cancel.store(true, Ordering::SeqCst);
        }
        let result = handle.job.progress.lock().unwrap().result.clone();
        if let Some(Ok(entry)) = result {
            let still_open = requests.values().any(|h| {
                h.job
                    .progress
                    .lock()
                    .unwrap()
                    .result
                    .as_ref()
                    .is_some_and(|r| r.as_ref().is_ok_and(|other| other.path() == entry.path()))
            });
            if !still_open {
                state.revoke_snapshot_preview(&entry.path());
            }
        }
    }
}

/// A user-requested save has no browser capability and uses an isolated
/// temporary transfer, independent of the preview cache and its lifecycle.
pub fn download(
    state: &AppState,
    pane: &str,
    transcript: &str,
    path: &str,
    destination: &Path,
) -> Result<(), String> {
    if path.is_empty() || path.len() > 8192 {
        return Err("Invalid remote file path".into());
    }
    let (host, cwd, roots, identity) = remote_transcript::preview_source(state, pane, transcript)?;
    let key = cache_key(&identity, &cwd, path)?;
    let job = Arc::new(Job {
        progress: Mutex::new(Progress::default()),
        cancel: AtomicBool::new(false),
        previous: None,
    });
    let entry = fetch(
        state,
        &host,
        Request {
            path: path.into(),
            cwd,
            roots,
            previous: None,
            download: true,
        },
        &key,
        &state.next_id("qmux-remote-download"),
        &job,
        None,
    )?;
    let result = (|| {
        let (_, current_cwd, _, current_identity) =
            remote_transcript::preview_source(state, pane, transcript)?;
        if cache_key(&current_identity, &current_cwd, path)? != key {
            return Err("The remote file's session changed during download; retry".into());
        }
        save_download(state, &entry.path(), destination)
    })();
    let _ = fs::remove_dir_all(entry.dir);
    result
}

fn save_download(state: &AppState, source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("Invalid download destination")?;
    let temporary = parent.join(format!(".{}", state.next_id("qmux-download")));
    let result = (|| {
        let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        fs::rename(&temporary, destination).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn json_line<T: serde::de::DeserializeOwned>(reader: &mut impl BufRead) -> Result<T, String> {
    let mut bytes = Vec::new();
    reader
        .take(32769)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 32768 || bytes.last() != Some(&b'\n') {
        return Err("Remote preview protocol unavailable or interrupted; reconnect to update qmux-cli, or update your custom CLI".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid remote preview response: {e}"))
}
fn fetch(
    state: &AppState,
    host: &crate::host::Host,
    request: Request,
    key: &str,
    upload: &str,
    job: &Arc<Job>,
    previous: Option<Entry>,
) -> Result<Entry, String> {
    let download = request.download;
    let cache = if download {
        std::env::temp_dir()
    } else {
        root(state)
    };
    if !download {
        private_dir(&cache)?;
    }
    let cache = fs::canonicalize(cache).map_err(|e| e.to_string())?;
    let dir = cache.join(upload);
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    private_dir(&dir)?;
    let result = (|| {
        let target = host.remote().ok_or("Remote is unavailable")?;
        let program = host.expand_home(&target.qmux_cli)?;
        if job.cancel.load(Ordering::SeqCst) {
            return Err("Preview cancelled".into());
        }
        let child = host
            .command(RemoteCommand {
                program: &program,
                args: vec![
                    "file-fetch".into(),
                    serde_json::to_string(&request).map_err(|e| e.to_string())?,
                ],
                ..Default::default()
            })
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut child = child;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let done = Arc::new(AtomicBool::new(false));
        let watchdog = {
            let child = child.clone();
            let done = done.clone();
            let job = job.clone();
            std::thread::spawn(move || {
                let began = Instant::now();
                while !done.load(Ordering::SeqCst) {
                    if job.cancel.load(Ordering::SeqCst)
                        || began.elapsed() > Duration::from_secs(60)
                    {
                        let _ = child.lock().unwrap().kill();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
        };
        let errors = std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut bytes = Vec::new();
            let _ = Read::by_ref(&mut stderr).take(8192).read_to_end(&mut bytes);
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            String::from_utf8_lossy(&bytes).into_owned()
        });
        let transfer = receive_file(
            &mut BufReader::new(stdout),
            &dir,
            key,
            job,
            previous,
            download,
        );
        // Kill on malformed/failed reads too; never block waiting for a hostile helper.
        if transfer.is_err() {
            let _ = child.lock().unwrap().kill();
        }
        let exit = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(error) => break Err(error.to_string()),
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        done.store(true, Ordering::SeqCst);
        let _ = watchdog.join();
        let stderr = errors.join().unwrap_or_default();
        if job.cancel.load(Ordering::SeqCst) {
            return Err("Preview cancelled".into());
        }
        let entry = transfer.map_err(|error| {
            if stderr.trim().is_empty() {
                error
            } else {
                format!("{error}\n{}", stderr.trim())
            }
        })?;
        if !exit?.success() {
            return Err(format!(
                "Remote file changed or transfer failed; retry. {}",
                stderr.trim()
            ));
        }
        Ok(entry)
    })();
    if result.as_ref().map_or(true, |entry| entry.dir != dir) {
        let _ = fs::remove_dir_all(dir);
    }
    result
}
fn save_entry(entry: &Entry) -> Result<(), String> {
    let mut index = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(entry.dir.join("entry.tmp"))
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut index, entry).map_err(|e| e.to_string())?;
    index.sync_all().map_err(|e| e.to_string())?;
    fs::rename(entry.dir.join("entry.tmp"), entry.dir.join("entry.json")).map_err(|e| e.to_string())
}

#[cfg(test)]
fn receive(
    reader: &mut impl BufRead,
    dir: &Path,
    key: &str,
    job: &Job,
    previous: Option<Entry>,
) -> Result<Entry, String> {
    receive_file(reader, dir, key, job, previous, false)
}

fn receive_file(
    reader: &mut impl BufRead,
    dir: &Path,
    key: &str,
    job: &Job,
    previous: Option<Entry>,
    download: bool,
) -> Result<Entry, String> {
    let header: Header = json_line(reader)?;
    if header.version != 1 {
        return Err("Update remote qmux-cli to support file previews".into());
    }
    if let Some(error) = header.error {
        if download && error == "This file format cannot be previewed" {
            return Err("Update qmux-cli on the remote to download this file format".into());
        }
        return Err(error);
    }
    let metadata = header.metadata.ok_or("Remote file metadata missing")?;
    let name = Path::new(&metadata.path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid remote filename")?
        .to_string();
    if !(if download {
        qmux_proto::is_safe_file_name(&name)
    } else {
        qmux_proto::is_safe_browser_preview_name(&name)
    }) || metadata.size > qmux_proto::MAX_REMOTE_OPEN_FILE_BYTES
    {
        return Err("Unsupported remote file or preview exceeds 10 MiB".into());
    }
    job.progress.lock().unwrap().total = Some(metadata.size);
    let validate = |reader: &mut _| -> Result<(), String> {
        let trailer: serde_json::Value = json_line(reader)?;
        if trailer.get("complete") != Some(&serde_json::Value::Bool(true)) {
            return Err("Remote file changed during transfer; retry".into());
        }
        Ok(())
    };
    let entry = if header.unchanged {
        let entry = previous
            .filter(|e| e.metadata == metadata && e.path().is_file())
            .ok_or("Cached copy is no longer available; retry")?;
        validate(reader)?;
        entry
    } else {
        let content = dir.join("content");
        private_dir(&content)?;
        crate::remote_files::stage_download_in_directory(
            &content,
            &name,
            metadata.size,
            reader,
            |bytes| {
                if job.cancel.load(Ordering::SeqCst) {
                    return Err("Preview cancelled".into());
                }
                job.progress.lock().unwrap().bytes = bytes;
                Ok(())
            },
            validate,
        )?;
        Entry {
            key: key.into(),
            metadata,
            fetched_at: now(),
            name,
            dir: dir.into(),
        }
    };
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn download_receives_binary_without_granting_preview_support_and_requires_completion() {
        let dir = directory();
        let body = b"PK\x03\x04\x00\xff";
        let data = wire(body.len() as u64, body, true);
        let end = data.iter().position(|b| *b == b'\n').unwrap();
        let mut header: Header = serde_json::from_slice(&data[..end]).unwrap();
        header.metadata.as_mut().unwrap().path = "/remote/reports.zip".into();
        let mut data = serde_json::to_vec(&header).unwrap();
        data.push(b'\n');
        data.extend(body);
        data.extend(b"{\"complete\":true}\n");
        assert!(receive(&mut Cursor::new(data.clone()), &dir, "host", &job(), None).is_err());
        let entry = receive_file(
            &mut Cursor::new(data.clone()),
            &dir,
            "host",
            &job(),
            None,
            true,
        )
        .unwrap();
        assert_eq!(fs::read(entry.path()).unwrap(), body);
        let incomplete = directory();
        data.truncate(data.len() - b"{\"complete\":true}\n".len());
        assert!(
            receive_file(
                &mut Cursor::new(data),
                &incomplete,
                "host",
                &job(),
                None,
                true
            )
            .is_err()
        );
        assert!(!incomplete.join("content/reports.zip").exists());
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(incomplete).unwrap();
    }

    #[test]
    fn saving_download_is_atomic_and_failure_keeps_existing_destination() {
        let root = directory();
        let state = AppState::new(
            serde_json::from_value(
                serde_json::json!({"workspaceRoot": root, "socketPath": root.join("unused.sock")}),
            )
            .unwrap(),
        );
        let source = root.join("source.zip");
        let destination = root.join("saved.zip");
        fs::write(&destination, b"previous file").unwrap();
        assert!(save_download(&state, &source, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"previous file");
        fs::write(&source, b"PK\x03\x04\x00\xff").unwrap();
        save_download(&state, &source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), fs::read(&source).unwrap());
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!fs::read_dir(&root).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".qmux-download")
        }));
        fs::remove_dir_all(root).unwrap();
    }
    fn job() -> Job {
        Job {
            progress: Mutex::new(Progress::default()),
            cancel: AtomicBool::new(false),
            previous: None,
        }
    }
    fn directory() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "qmux-pull-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }
    fn wire(size: u64, body: &[u8], trailer: bool) -> Vec<u8> {
        let header = Header {
            version: 1,
            unchanged: false,
            error: None,
            metadata: Some(Metadata {
                path: "/remote/entry.json".into(),
                size,
                device: 1,
                inode: 2,
                modified: (3, 4),
                changed: (5, 6),
            }),
        };
        let mut bytes = serde_json::to_vec(&header).unwrap();
        bytes.push(b'\n');
        bytes.extend(body);
        if trailer {
            bytes.extend(b"{\"complete\":true}\n");
        }
        bytes
    }
    #[test]
    fn pull_requires_completion_and_keeps_metadata_outside_content() {
        let dir = directory();
        let job = job();
        assert!(
            receive(
                &mut Cursor::new(wire(3, b"abc", false)),
                &dir,
                "host-a",
                &job,
                None
            )
            .is_err()
        );
        assert!(!dir.join("content/entry.json").exists());
        let entry = receive(
            &mut Cursor::new(wire(3, b"abc", true)),
            &dir,
            "host-a",
            &job,
            None,
        )
        .unwrap();
        save_entry(&entry).unwrap();
        assert_eq!(fs::read(entry.path()).unwrap(), b"abc");
        assert!(
            serde_json::from_slice::<Entry>(&fs::read(dir.join("entry.json")).unwrap()).is_ok()
        );
        // A refresh cannot overwrite the old snapshot.
        assert!(
            receive(
                &mut Cursor::new(wire(3, b"xyz", true)),
                &dir,
                "host-a",
                &job,
                None
            )
            .is_err()
        );
        assert_eq!(fs::read(entry.path()).unwrap(), b"abc");
        let next = directory();
        let header = Header {
            version: 1,
            unchanged: true,
            error: None,
            metadata: Some(entry.metadata.clone()),
        };
        let wire = format!(
            "{}\n{{\"complete\":true}}\n",
            serde_json::to_string(&header).unwrap()
        );
        let reused = receive(
            &mut Cursor::new(wire),
            &next,
            "host-a",
            &job,
            Some(entry.clone()),
        )
        .unwrap();
        assert_eq!(reused.path(), entry.path());
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(next).unwrap();
    }
    #[test]
    fn pull_cancellation_and_truncation_never_publish() {
        let dir = directory();
        let job = job();
        assert!(
            receive(
                &mut Cursor::new(wire(10, b"abc", false)),
                &dir,
                "key",
                &job,
                None
            )
            .is_err()
        );
        job.cancel.store(true, Ordering::SeqCst);
        assert!(
            receive(
                &mut Cursor::new(wire(3, b"abc", true)),
                &dir,
                "key",
                &job,
                None
            )
            .unwrap_err()
            .contains("cancelled")
        );
        assert!(!dir.join("content/entry.json").exists());
        assert!(!dir.join("content/.upload").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn closing_one_subscriber_preserves_shared_transfer() {
        let root = directory();
        let state = AppState::new(
            serde_json::from_value(
                serde_json::json!({"workspaceRoot": root, "socketPath": root.join("unused.sock")}),
            )
            .unwrap(),
        );
        let job = Arc::new(job());
        let ids = [state.next_id("subscriber"), state.next_id("subscriber")];
        for id in &ids {
            REQUESTS.lock().unwrap().insert(
                id.clone(),
                Handle {
                    pane: "p".into(),
                    transcript: "t".into(),
                    key: "key".into(),
                    job: job.clone(),
                },
            );
        }
        close(&state, &ids[0]);
        assert!(!job.cancel.load(Ordering::SeqCst));
        close(&state, &ids[1]);
        assert!(job.cancel.load(Ordering::SeqCst));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cache_cleanup_keeps_active_previous_snapshot_and_separates_keys() {
        let workspace = directory();
        let state = AppState::new(serde_json::from_value(serde_json::json!({"workspaceRoot": workspace, "socketPath": workspace.join("unused.sock")})).unwrap());
        let dir = root(&state).join("snapshot");
        private_dir(&dir).unwrap();
        let mut entry = receive(
            &mut Cursor::new(wire(3, b"abc", true)),
            &dir,
            "host-a",
            &job(),
            None,
        )
        .unwrap();
        entry.fetched_at = 1;
        save_entry(&entry).unwrap();
        assert!(cached(&state, "host-b").is_none());
        let request = state.next_id("pin");
        let job = Arc::new(Job {
            previous: Some(entry.clone()),
            ..job()
        });
        REQUESTS.lock().unwrap().insert(
            request.clone(),
            Handle {
                pane: "p".into(),
                transcript: "t".into(),
                key: "host-a".into(),
                job,
            },
        );
        cleanup(&state);
        assert!(entry.path().exists());
        close(&state, &request);
        cleanup(&state);
        assert!(!entry.path().exists());
        fs::remove_dir_all(workspace).unwrap();
    }
}
