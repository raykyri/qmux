//! Desktop-initiated, bounded exact-file snapshots over SSH stdout.
use qmux_proto::MAX_REMOTE_OPEN_FILE_BYTES;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request {
    pub path: String,
    pub cwd: String,
    pub roots: Vec<String>,
    pub previous: Option<Metadata>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metadata {
    pub path: String,
    pub size: u64,
    pub device: u64,
    pub inode: u64,
    pub modified: (i64, i64),
    pub changed: (i64, i64),
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Header {
    pub version: u32,
    pub metadata: Option<Metadata>,
    pub unchanged: bool,
    pub error: Option<String>,
}

fn identity(path: &Path, meta: &fs::Metadata) -> Metadata {
    Metadata {
        path: path.to_string_lossy().into(), size: meta.len(), device: meta.dev(), inode: meta.ino(),
        modified: (meta.mtime(), meta.mtime_nsec()), changed: (meta.ctime(), meta.ctime_nsec()),
    }
}

// Walk an already canonical absolute path without following any symlinks. This
// closes the canonicalize/open race and O_NONBLOCK prevents a swapped FIFO hang.
fn open_canonical(path: &Path) -> Result<File, String> {
    let mut file = File::open("/").map_err(|e| e.to_string())?;
    let names = path.components().filter_map(|c| match c { Component::Normal(n) => Some(n), _ => None }).collect::<Vec<_>>();
    for (index, name) in names.iter().enumerate() {
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|e| e.to_string())?;
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
            | if index + 1 < names.len() { libc::O_DIRECTORY } else { 0 };
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 { return Err(format!("Cannot safely open remote file: {}", std::io::Error::last_os_error())); }
        file = unsafe { File::from_raw_fd(fd) };
    }
    Ok(file)
}
fn prepare(request: &Request) -> Result<(File, Metadata), String> {
    if request.path.len() > 8192 || !Path::new(&request.cwd).is_absolute() { return Err("Invalid remote file context".into()); }
    let requested = Path::new(&request.cwd).join(&request.path);
    let canonical = fs::canonicalize(&requested).map_err(|e| format!("Remote file unavailable: {e}"))?;
    let roots = request.roots.iter().map(PathBuf::from)
        .chain([PathBuf::from("/tmp"), std::env::temp_dir()]);
    if !roots.filter_map(|root| fs::canonicalize(root).ok()).any(|root| root != Path::new("/") && canonical.starts_with(root)) {
        return Err("Remote file is outside this transcript's workspace and temporary directories".into());
    }
    let file = open_canonical(&canonical)?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() { return Err("Remote preview requires a regular file, not a directory or device".into()); }
    if meta.len() > MAX_REMOTE_OPEN_FILE_BYTES { return Err("Remote preview exceeds the 10 MiB limit".into()); }
    let name = canonical.file_name().and_then(|n| n.to_str()).ok_or("Invalid remote filename")?;
    if !qmux_proto::is_safe_browser_preview_name(name) { return Err("This file format cannot be previewed".into()); }
    Ok((file, identity(&canonical, &meta)))
}
fn write_json(writer: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|e| e.to_string())?;
    writer.write_all(b"\n").map_err(|e| e.to_string())
}
pub fn send(request: Request, writer: &mut impl Write) -> Result<(), String> {
    let (mut file, metadata) = match prepare(&request) {
        Ok(value) => value,
        Err(error) => return write_json(writer, &Header { version: 1, metadata: None, unchanged: false, error: Some(error) }),
    };
    let unchanged = request.previous.as_ref() == Some(&metadata);
    write_json(writer, &Header { version: 1, metadata: Some(metadata.clone()), unchanged, error: None })?;
    if !unchanged {
        let copied = std::io::copy(&mut Read::by_ref(&mut file).take(metadata.size), writer).map_err(|e| e.to_string())?;
        if copied != metadata.size { return Err("Remote file was truncated while reading".into()); }
    }
    let after = identity(Path::new(&metadata.path), &file.metadata().map_err(|e| e.to_string())?);
    if after != metadata { return Err("Remote file changed while reading; retry the preview".into()); }
    // A mandatory trailer distinguishes a complete, validated read from an EOF.
    write_json(writer, &serde_json::json!({"complete": true}))?;
    writer.flush().map_err(|e| e.to_string())
}
pub fn run(args: Vec<String>) -> Result<(), String> {
    if args.len() != 1 || args[0].len() > 32768 { return Err("usage: qmux file-fetch <request-json>".into()); }
    send(serde_json::from_str(&args[0]).map_err(|e| e.to_string())?, &mut std::io::stdout().lock())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_fetch_revalidates_and_denies_symlink_escape() {
        let root = std::env::current_dir().unwrap().join(format!(".fetch-test-{}", std::process::id()));
        fs::create_dir_all(root.join("allowed")).unwrap();
        fs::write(root.join("allowed/report.html"), "hello").unwrap();
        fs::write(root.join("secret.html"), "secret").unwrap();
        std::os::unix::fs::symlink(root.join("secret.html"), root.join("allowed/link.html")).unwrap();
        let mut req = Request { path: "report.html".into(), cwd: root.join("allowed").to_string_lossy().into(), roots: vec![root.join("allowed").to_string_lossy().into()], previous: None };
        let mut bytes = Vec::new(); send(req.clone(), &mut bytes).unwrap();
        let end = bytes.iter().position(|b| *b == b'\n').unwrap();
        let header: Header = serde_json::from_slice(&bytes[..end]).unwrap();
        assert_eq!(&bytes[end+1..end+6], b"hello");
        req.previous = header.metadata;
        bytes.clear(); send(req.clone(), &mut bytes).unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("\"unchanged\":true"));
        req.path = "link.html".into();
        assert!(prepare(&req).unwrap_err().contains("outside"));
        req.path = ".".into(); assert!(prepare(&req).unwrap_err().contains("regular file"));
        fs::remove_dir_all(root).unwrap();
    }
}
