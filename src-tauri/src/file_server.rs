//! Loopback static file server for the browser overlay.
//!
//! Binds `127.0.0.1:0` (ephemeral, loopback-only) at startup and serves files via
//! `http://127.0.0.1:<port>/<token>/<percent-encoded-abs-path>`. Because any local
//! process can reach a loopback port, a random `token` (not loopback alone) is what
//! gates access. The token is *per pane* (minted in `AppState::pane_file_token`): the
//! server resolves it back to the requesting pane and only serves paths that
//! canonicalize under that pane's own roots (`pane_file_roots`). So a token an agent
//! obtains for its own pane can't reach another pane's directory, and `..`/symlinks
//! can't escape into `~/.ssh/id_rsa`.
//!
//! Hand-rolled GET/HEAD + Range over `TcpListener` to keep the dependency posture of
//! the rest of the backend (cf. the hand-rolled base64 in events.rs). Each connection
//! serves one request then closes (`Connection: close`).

use crate::state::AppState;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

const CONNECTION_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// Cap on the bytes consumed for a request's start line + headers, so a client can't
/// stream an unbounded request head into memory within the read-timeout window.
/// Generous next to any real percent-encoded file path.
const MAX_REQUEST_HEAD_BYTES: u64 = 64 * 1024;
/// Cap on a single full-file (non-range) response so a giant file can't balloon
/// memory; browsers fetch large media via Range anyway.
const MAX_INLINE_BYTES: u64 = 64 * 1024 * 1024;

pub struct FileServerInfo {
    pub port: u16,
}

/// Starts the loopback file server and returns its port. The caller stores it in
/// `AppState` so the control socket can build URLs; the frontend never sees the port
/// or any token directly (it only receives fully-formed URLs in `browser.open`).
/// Access is gated by the per-pane tokens carried in each URL's path, resolved against
/// live state per request — so no token needs capturing at startup.
pub fn start_file_server(state: AppState) -> Result<FileServerInfo, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|err| format!("failed to bind file server: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("failed to read file server address: {err}"))?
        .port();

    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let state = state.clone();
            thread::spawn(move || handle_connection(&state, stream));
        }
    });

    Ok(FileServerInfo { port })
}

/// Builds the loopback URL for an absolute file path. `abs_path` must be absolute
/// (start with `/`), so the encoded form sits directly after the token.
pub fn file_url(port: u16, token: &str, abs_path: &Path) -> String {
    format!(
        "http://127.0.0.1:{port}/{token}{}",
        percent_encode_path(&abs_path.to_string_lossy())
    )
}

/// Canonicalizes `requested` (resolving `..` and symlinks) and returns it only if it
/// lives under one of `roots`. This is the trust boundary for what may be served.
pub fn resolve_under_roots(requested: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(requested).ok()?;
    for root in roots {
        if let Ok(root_canonical) = std::fs::canonicalize(root)
            && canonical.starts_with(&root_canonical)
        {
            return Some(canonical);
        }
    }
    None
}

struct RequestHead {
    method: String,
    target: String,
    range: Option<String>,
}

struct Response {
    status: u16,
    reason: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn new(status: u16, reason: &'static str) -> Self {
        Self {
            status,
            reason,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn error(status: u16, reason: &'static str) -> Self {
        let mut response = Self::new(status, reason);
        response.header("Content-Length", "0");
        response
    }

    fn header(&mut self, key: &str, value: &str) {
        self.headers.push((key.to_string(), value.to_string()));
    }
}

fn handle_connection(state: &AppState, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(CONNECTION_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_READ_TIMEOUT));
    let Some(head) = read_request_head(&stream) else {
        return;
    };
    let response = build_response(state, &head);
    let _ = write_response(&mut stream, response);
}

fn read_request_head(stream: &TcpStream) -> Option<RequestHead> {
    let cloned = stream.try_clone().ok()?;
    // Bound the total request-head bytes: once the cap is hit, reads return EOF and the
    // line below sees a truncated request, failing the parse and closing the connection.
    let mut reader = BufReader::new(cloned.take(MAX_REQUEST_HEAD_BYTES));

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).ok()? == 0 {
        return None;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut range = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let trimmed = header.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':')
            && name.trim().eq_ignore_ascii_case("range")
        {
            range = Some(value.trim().to_string());
        }
    }

    Some(RequestHead {
        method,
        target,
        range,
    })
}

fn build_response(state: &AppState, head: &RequestHead) -> Response {
    if head.method != "GET" && head.method != "HEAD" {
        return Response::error(405, "Method Not Allowed");
    }
    let is_head = head.method == "HEAD";

    // Drop any query string / fragment before routing.
    let path = head.target.split(['?', '#']).next().unwrap_or("");
    // The path is "/<token>/<abs path>": the first segment is the per-pane token, and
    // everything from the next '/' onward is the percent-encoded absolute path (with
    // its leading slash preserved). Tokens are hex, so they never contain a slash.
    let Some(after_root) = path.strip_prefix('/') else {
        return Response::error(404, "Not Found");
    };
    let Some(slash) = after_root.find('/') else {
        return Response::error(404, "Not Found");
    };
    let (token, encoded_path) = after_root.split_at(slash);
    // Resolve the token to its pane and serve only that pane's roots, so a URL minted
    // for one pane can never read another pane's files. An unknown token is an opaque
    // 404, indistinguishable from a missing route.
    let Some(pane_id) = state.pane_for_file_token(token) else {
        return Response::error(404, "Not Found");
    };
    let Some(decoded) = percent_decode(encoded_path) else {
        return Response::error(400, "Bad Request");
    };

    let roots = state.pane_file_roots(&pane_id);
    let Some(canonical) = resolve_under_roots(Path::new(&decoded), &roots) else {
        // Either it doesn't exist or it isn't under an allowed root — same opaque 403
        // so the server isn't a probe for which paths exist.
        return Response::error(403, "Forbidden");
    };

    let Ok(file) = File::open(&canonical) else {
        return Response::error(404, "Not Found");
    };
    let Ok(meta) = file.metadata() else {
        return Response::error(404, "Not Found");
    };
    if meta.is_dir() {
        return Response::error(403, "Forbidden");
    }
    let total = meta.len();
    let content_type = mime_type(&canonical);

    if let Some(range_raw) = &head.range {
        let Some((start, requested_end)) = parse_range(range_raw, total) else {
            let mut response = Response::error(416, "Range Not Satisfiable");
            response.header("Content-Range", &format!("bytes */{total}"));
            return response;
        };
        // Cap how much a single range response buffers. Without this, `Range: bytes=0-`
        // on a huge file allocates the whole file in one Vec — bypassing MAX_INLINE_BYTES
        // (which only guards the non-range path). Serving fewer bytes than requested is a
        // valid 206; a client that wants the rest issues the next range from `end + 1`.
        let end = cap_range_end(start, requested_end, MAX_INLINE_BYTES);
        let len = end - start + 1;
        let body = if is_head {
            Vec::new()
        } else {
            match read_slice(file, start, len) {
                Ok(bytes) => bytes,
                Err(_) => return Response::error(500, "Internal Server Error"),
            }
        };
        let mut response = Response::new(206, "Partial Content");
        response.header("Content-Type", &content_type);
        response.header("Content-Length", &len.to_string());
        response.header("Accept-Ranges", "bytes");
        response.header("Content-Range", &format!("bytes {start}-{end}/{total}"));
        response.body = body;
        return response;
    }

    if total > MAX_INLINE_BYTES {
        // Force the client to range-request a file this large rather than buffering it.
        let mut response = Response::error(413, "Payload Too Large");
        response.header("Accept-Ranges", "bytes");
        return response;
    }
    let body = if is_head {
        Vec::new()
    } else {
        match read_slice(file, 0, total) {
            Ok(bytes) => bytes,
            Err(_) => return Response::error(500, "Internal Server Error"),
        }
    };
    let mut response = Response::new(200, "OK");
    response.header("Content-Type", &content_type);
    response.header("Content-Length", &total.to_string());
    response.header("Accept-Ranges", "bytes");
    response.body = body;
    response
}

fn write_response(stream: &mut TcpStream, response: Response) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, response.reason);
    for (key, value) in &response.headers {
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    // Don't let a text file be MIME-sniffed into HTML, and never leak the token-bearing
    // URL in a Referer when served content fetches something. (The overlay also
    // sandboxes file content into an opaque origin — see BrowserOverlay.)
    head.push_str("X-Content-Type-Options: nosniff\r\n");
    head.push_str("Referrer-Policy: no-referrer\r\n");
    // One request per connection keeps the hand-rolled server simple and correct.
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if !response.body.is_empty() {
        stream.write_all(&response.body)?;
    }
    stream.flush()
}

/// Clamps a requested inclusive range end so one response never serves more than `cap`
/// bytes starting at `start`. Returns the end actually served (≤ `requested_end`).
fn cap_range_end(start: u64, requested_end: u64, cap: u64) -> u64 {
    requested_end.min(start.saturating_add(cap - 1))
}

fn read_slice(mut file: File, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = vec![0_u8; len as usize];
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

/// Parses a single-range `Range: bytes=...` value against a known total length.
/// Returns the inclusive `(start, end)` byte range, or `None` if unsatisfiable.
fn parse_range(raw: &str, total: u64) -> Option<(u64, u64)> {
    let spec = raw.trim().strip_prefix("bytes=")?;
    // Only the first range of a (possibly multi-range) request is honored.
    let spec = spec.split(',').next()?.trim();
    let (start_str, end_str) = spec.split_once('-')?;

    if start_str.is_empty() {
        // Suffix range: the last N bytes.
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 || total == 0 {
            return None;
        }
        return Some((total.saturating_sub(suffix), total - 1));
    }

    let start: u64 = start_str.parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_str.is_empty() {
        total - 1
    } else {
        end_str.parse::<u64>().ok()?.min(total - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn mime_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "txt" | "log" | "md" | "markdown" | "csv" | "xml" | "yaml" | "yml" | "toml" => {
            "text/plain; charset=utf-8"
        }
        _ => "application/octet-stream",
    };
    mime.to_string()
}

/// Percent-encodes a path, leaving `/` (the separator) and the RFC 3986 unreserved
/// set intact so the encoded form is a normal multi-segment URL path.
fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(hex_digit(byte >> 4));
            out.push(hex_digit(byte & 0x0f));
        }
    }
    out
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return None;
                }
                let hi = hex_value(bytes[i + 1])?;
                let lo = hex_value(bytes[i + 2])?;
                out.push(hi << 4 | lo);
                i += 3;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_round_trips_paths_with_spaces_and_specials() {
        let original = "/Users/x/my proj/réport (1).md";
        let encoded = percent_encode_path(original);
        assert!(!encoded.contains(' '));
        assert!(encoded.contains('/'));
        assert_eq!(percent_decode(&encoded).as_deref(), Some(original));
    }

    #[test]
    fn percent_decode_rejects_truncated_escapes() {
        assert!(percent_decode("%2").is_none());
        assert!(percent_decode("%zz").is_none());
    }

    #[test]
    fn parse_range_handles_open_closed_and_suffix() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        // End past the file is clamped.
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)));
        // Start past the end, or an empty file, is unsatisfiable.
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=-10", 0), None);
    }

    #[test]
    fn cap_range_end_limits_a_single_response_to_the_inline_cap() {
        // An open-ended range over a large total is capped to `cap` bytes from start.
        assert_eq!(cap_range_end(0, 999, 100), 99);
        assert_eq!(cap_range_end(50, 999, 100), 149);
        // A range already within the cap is served whole.
        assert_eq!(cap_range_end(0, 40, 100), 40);
        // Clamping saturates near u64::MAX rather than overflowing.
        assert_eq!(cap_range_end(u64::MAX - 1, u64::MAX, 100), u64::MAX);
    }

    fn http_get(port: u16, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let method_path = path;
        let mut request = format!("GET {method_path} HTTP/1.1\r\nHost: localhost\r\n");
        if let Some(range) = range {
            request.push_str(&format!("Range: {range}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)
            .unwrap_or(raw.len());
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let status = head.lines().next().unwrap_or("").to_string();
        (status, raw[split..].to_vec())
    }

    fn url_path(port: u16, token: &str, abs: &Path) -> String {
        file_url(port, token, abs)
            .strip_prefix(&format!("http://127.0.0.1:{port}"))
            .unwrap()
            .to_string()
    }

    #[test]
    fn serves_files_under_root_with_range_and_blocks_the_rest() {
        use crate::config::{
            AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, OpencodeAdapterConfig,
            QmuxConfig,
        };
        let base = std::env::temp_dir().join(format!("qmux-fs-serve-{}", std::process::id()));
        let root = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("hello.txt"), b"hello world").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();

        let config = QmuxConfig {
            workspace_root: root.clone(),
            socket_path: base.join("x.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
                opencode: OpencodeAdapterConfig {
                    binary: Some("opencode".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: PathBuf::new(),
            opencode_plugin_dir: PathBuf::new(),
        };
        let state = AppState::new(config);
        let info = start_file_server(state.clone()).unwrap();
        // The URL token is a per-pane file token; mint one for a pane whose only root is
        // the workspace root (it isn't in the model, so `pane_file_roots` falls back to
        // just the workspace root).
        let token = state.pane_file_token("pane-1").unwrap();

        let hello = std::fs::canonicalize(root.join("hello.txt")).unwrap();

        // Full GET returns the file.
        let (status, body) = http_get(info.port, &url_path(info.port, &token, &hello), None);
        assert!(status.contains("200"), "status: {status}");
        assert_eq!(body, b"hello world");

        // Range GET returns the requested slice with 206.
        let (status, body) = http_get(
            info.port,
            &url_path(info.port, &token, &hello),
            Some("bytes=0-4"),
        );
        assert!(status.contains("206"), "status: {status}");
        assert_eq!(body, b"hello");

        // A file outside every root is forbidden (even though it exists).
        let (status, _) = http_get(
            info.port,
            &url_path(info.port, &token, &outside.join("secret.txt")),
            None,
        );
        assert!(status.contains("403"), "status: {status}");

        // An unknown token can't reach any file.
        let correct = url_path(info.port, &token, &hello);
        let wrong = format!(
            "/deadbeef{}",
            correct.strip_prefix(&format!("/{token}")).unwrap()
        );
        let (status, _) = http_get(info.port, &wrong, None);
        assert!(status.contains("404"), "status: {status}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_under_roots_blocks_traversal_outside_roots() {
        let base = std::env::temp_dir().join(format!("qmux-fs-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("ok.txt"), b"ok").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();

        let roots = vec![root.clone()];
        assert!(resolve_under_roots(&root.join("ok.txt"), &roots).is_some());
        // A path that resolves outside every root is rejected, including via `..`.
        assert!(resolve_under_roots(&outside.join("secret.txt"), &roots).is_none());
        assert!(resolve_under_roots(&root.join("../outside/secret.txt"), &roots).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }
}
