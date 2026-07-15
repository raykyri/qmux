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

use crate::connection_limit::ConnectionLimiter;
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
/// Cap on concurrent connection-handler threads. Each connection serves one
/// request then closes, so this bounds in-flight requests; 64 comfortably covers
/// a browser overlay fetching a page full of assets in parallel while keeping a
/// connection-spamming local process from exhausting threads/FDs. At the cap the
/// accept loop blocks and excess connections wait in the kernel listen backlog.
const MAX_CONCURRENT_CONNECTIONS: usize = 64;
/// Backoff after a failed accept, so persistent accept errors (e.g. EMFILE under
/// FD exhaustion) can't spin the accept loop hot.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(100);

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
        let limiter = ConnectionLimiter::new(MAX_CONCURRENT_CONNECTIONS);
        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                thread::sleep(ACCEPT_ERROR_BACKOFF);
                continue;
            };
            let slot = limiter.acquire();
            let state = state.clone();
            thread::spawn(move || {
                let _slot = slot;
                handle_connection(&state, stream);
            });
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
    host: Option<String>,
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
    let mut host = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let trimmed = header.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let name = name.trim();
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            } else if name.eq_ignore_ascii_case("host") {
                host = Some(value.trim().to_string());
            }
        }
    }

    Some(RequestHead {
        method,
        target,
        range,
        host,
    })
}

/// Whether a `Host` header names a loopback address. A DNS-rebinding attack from a
/// remote page reaches the loopback port with the *attacker's* hostname in `Host`,
/// so rejecting a non-loopback host is cheap defense-in-depth on top of the token.
/// Legit overlay/curl requests use `127.0.0.1:<port>` or `localhost:<port>`.
fn is_loopback_host_header(host: &str) -> bool {
    // Strip the port, honoring the [ipv6]:port bracket form.
    let host = if let Some(after_bracket) = host.strip_prefix('[') {
        match after_bracket.split_once(']') {
            Some((inner, _)) => inner,
            None => return false,
        }
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(v4) = host.parse::<Ipv4Addr>() {
        return v4.is_loopback();
    }
    if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        return v6.is_loopback();
    }
    false
}

fn query_parameter<'a>(query: Option<&'a str>, name: &str) -> Option<&'a str> {
    query?.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then_some(value)
    })
}

fn build_response(state: &AppState, head: &RequestHead) -> Response {
    // Reject a non-loopback Host (DNS-rebinding defense-in-depth). A missing Host
    // (e.g. a bare HTTP/1.0 client) is allowed — the per-pane token still gates access
    // — but a browser rebinding attack always carries the attacker's hostname here.
    if let Some(host) = &head.host
        && !is_loopback_host_header(host)
    {
        return Response::error(403, "Forbidden");
    }
    if head.method != "GET" && head.method != "HEAD" {
        return Response::error(405, "Method Not Allowed");
    }
    let is_head = head.method == "HEAD";

    // Split the query string off the target (dropping any fragment) before routing.
    // `?raw=1` opts a Markdown file out of the HTML rendering below.
    let without_fragment = head.target.split('#').next().unwrap_or("");
    let (path, query) = match without_fragment.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (without_fragment, None),
    };
    let raw_requested = query.is_some_and(|q| q.split('&').any(|p| p == "raw" || p == "raw=1"));
    let body_font_id = query_parameter(query, "qmux-body-font");
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
    // CSP for served content: the overlay already sandboxes it into an opaque origin
    // (so scripts can't read sibling responses cross-origin), and `connect-src 'none'`
    // closes the remaining channel — a hostile HTML file phoning the token home via
    // fetch/XHR/WebSocket/beacon. Passive subresources (a report's own CSS/JS/images)
    // still load, but only from this same file-server origin; nothing may talk to the
    // network. `state.file_server_port()` is always set once the server is serving.
    let csp = state.file_server_port().map(file_content_csp);

    // Markdown is rendered into a styled HTML page at serve time (unless `?raw=1` opts
    // out), so the overlay shows a document instead of plain source. Rendering
    // transforms the entity, so byte offsets into the source are meaningless: Range is
    // ignored and the full page is served. A file over the inline cap falls through to
    // the plain-text path and its existing 413/Range flow.
    if !raw_requested && is_markdown(&canonical) && total <= MAX_INLINE_BYTES {
        let Ok(source) = read_slice(file, 0, total) else {
            return Response::error(500, "Internal Server Error");
        };
        let page =
            render_markdown_page(&canonical, &String::from_utf8_lossy(&source), body_font_id);
        let mut response = Response::new(200, "OK");
        response.header("Content-Type", "text/html; charset=utf-8");
        response.header("Content-Length", &page.len().to_string());
        // Rendered Markdown never needs script, so serve it under a CSP with no
        // `script-src` at all (it falls back to `default-src 'none'`). Raw HTML in the
        // Markdown passes through the renderer verbatim, so a hostile file could embed
        // `<script>`/`onerror` — dropping script execution entirely makes that inert
        // instead of relying solely on the overlay's opaque-origin sandbox.
        if let Some(port) = state.file_server_port() {
            response.header("Content-Security-Policy", &markdown_page_csp(port));
        }
        if !is_head {
            response.body = page.into_bytes();
        }
        return response;
    }

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
        if let Some(csp) = &csp {
            response.header("Content-Security-Policy", csp);
        }
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
    if let Some(csp) = &csp {
        response.header("Content-Security-Policy", csp);
    }
    response.body = body;
    response
}

/// CSP applied to every served file. Served files always come back from
/// `http://127.0.0.1:<port>` (see `file_url`), so passive subresources are pinned to
/// that exact origin — a report's sibling CSS/JS/images/fonts render, but the document
/// cannot reach any other host. `connect-src 'none'` blocks all scripted network egress
/// (the token-exfiltration channel), and `object-src`/`base-uri`/`form-action` are
/// locked down for good measure. Inline scripts/styles are permitted because a served
/// report legitimately carries its own, and the sandbox opaque origin already contains
/// what they can read.
fn file_content_csp(port: u16) -> String {
    let origin = format!("http://127.0.0.1:{port}");
    format!(
        "default-src 'none'; \
         script-src 'unsafe-inline' {origin}; \
         style-src 'unsafe-inline' {origin}; \
         img-src data: blob: {origin}; \
         font-src data: {origin}; \
         media-src blob: {origin}; \
         connect-src 'none'; \
         object-src 'none'; \
         base-uri 'none'; \
         form-action 'none'"
    )
}

/// CSP for *rendered Markdown* pages. Identical to [`file_content_csp`] but with no
/// `script-src` directive, so it falls back to `default-src 'none'` and blocks all
/// script execution. The styled Markdown template carries only inline styles (allowed
/// below) and no script, and raw HTML embedded in the source passes through the
/// renderer verbatim — so omitting `script-src` turns any embedded `<script>` into
/// inert markup, a second line of defense alongside the overlay's opaque-origin
/// sandbox rather than the sole one.
fn markdown_page_csp(port: u16) -> String {
    let origin = format!("http://127.0.0.1:{port}");
    format!(
        "default-src 'none'; \
         style-src 'unsafe-inline' {origin}; \
         img-src data: blob: {origin}; \
         font-src data: {origin}; \
         media-src blob: {origin}; \
         connect-src 'none'; \
         object-src 'none'; \
         base-uri 'none'; \
         form-action 'none'"
    )
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

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown")
    )
}

/// Inline stylesheet for rendered Markdown. Background and text colors are set
/// explicitly per scheme (not left to UA defaults): the overlay loads this page in a
/// sandboxed iframe whose canvas is transparent, so UA-default dark-scheme text would
/// float over whatever backdrop the app has — white-on-white in practice. Translucent
/// grays handle the accents in both themes, and the file CSP already allows inline
/// styles.
const MARKDOWN_PAGE_CSS: &str = "\
:root { color-scheme: light dark; }\
body { margin: 0; font-family: __QMUX_BODY_FONT__; line-height: 1.6; background: #ffffff; color: #1f2328; }\
@media (prefers-color-scheme: dark) { body { background: #1e2227; color: #e2e6ea; } }\
main { max-width: 48rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }\
h1, h2 { border-bottom: 1px solid rgba(127, 127, 127, 0.3); padding-bottom: 0.3em; }\
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: rgba(127, 127, 127, 0.15); padding: 0.1em 0.3em; border-radius: 4px; }\
pre { background: rgba(127, 127, 127, 0.12); padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }\
pre code { background: none; padding: 0; font-size: 0.85em; }\
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid rgba(127, 127, 127, 0.4); opacity: 0.85; }\
table { border-collapse: collapse; display: block; overflow-x: auto; }\
th, td { border: 1px solid rgba(127, 127, 127, 0.35); padding: 0.35em 0.7em; }\
img { max-width: 100%; }\
hr { border: none; border-top: 1px solid rgba(127, 127, 127, 0.3); }";

fn markdown_body_font(font_id: Option<&str>) -> &'static str {
    match font_id {
        Some("inter") => {
            "'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        }
        Some("anthropic-sans-text") => {
            "'Anthropic Sans Text', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        }
        Some("valley-sans") => {
            "'Valley Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        }
        _ => "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }
}

/// Renders Markdown source into a complete standalone HTML page. Raw HTML embedded in
/// the Markdown passes through untouched: the overlay's sandbox + CSP were designed to
/// contain fully hostile served HTML files, so rendered Markdown gets the same
/// containment rather than a sanitizer.
fn render_markdown_page(path: &Path, source: &str, body_font_id: Option<&str>) -> String {
    use pulldown_cmark::{Options, Parser, html};

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);

    let mut body = String::with_capacity(source.len() * 2);
    html::push_html(&mut body, Parser::new_ext(source, options));

    let title = escape_html(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Markdown"),
    );
    let markdown_page_css =
        MARKDOWN_PAGE_CSS.replace("__QMUX_BODY_FONT__", markdown_body_font(body_font_id));
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n<style>{markdown_page_css}</style>\n</head>\n\
         <body>\n<main>\n{body}</main>\n</body>\n</html>\n"
    )
}

/// Escapes text for interpolation into HTML (the page `<title>`).
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
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
    fn markdown_page_csp_blocks_scripts() {
        let csp = markdown_page_csp(12345);
        // No script-src at all → falls back to default-src 'none', so an embedded
        // <script> in a rendered Markdown file cannot execute.
        assert!(
            !csp.contains("script-src"),
            "rendered markdown CSP must not grant script execution: {csp}"
        );
        assert!(csp.contains("default-src 'none'"), "{csp}");
        assert!(csp.contains("style-src 'unsafe-inline'"), "{csp}");
        assert!(csp.contains("connect-src 'none'"), "{csp}");
        // The general file-content CSP, by contrast, still permits (contained) inline
        // script for self-hosted reports.
        assert!(file_content_csp(12345).contains("script-src 'unsafe-inline'"));
    }

    #[test]
    fn loopback_host_header_accepts_loopback_and_rejects_remote() {
        assert!(is_loopback_host_header("127.0.0.1:5173"));
        assert!(is_loopback_host_header("localhost:5173"));
        assert!(is_loopback_host_header("127.0.0.1"));
        assert!(is_loopback_host_header("LOCALHOST"));
        assert!(is_loopback_host_header("[::1]:5173"));
        assert!(is_loopback_host_header("127.9.9.9"));

        assert!(!is_loopback_host_header("evil.com"));
        assert!(!is_loopback_host_header("evil.com:5173"));
        assert!(!is_loopback_host_header("127.0.0.1.evil.com"));
        assert!(!is_loopback_host_header("0.0.0.0"));
        assert!(!is_loopback_host_header("192.168.1.5:5173"));
    }

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

    #[test]
    fn rendered_markdown_uses_only_known_body_font_stacks() {
        let path = Path::new("doc.md");
        let source = "# Hello";
        assert_eq!(
            query_parameter(Some("raw=1&qmux-body-font=inter"), "qmux-body-font"),
            Some("inter")
        );

        let default_page = render_markdown_page(path, source, None);
        assert!(default_page.contains("font-family: ui-sans-serif, system-ui"));

        let selected_page = render_markdown_page(path, source, Some("anthropic-sans-text"));
        assert!(selected_page.contains("font-family: 'Anthropic Sans Text', ui-sans-serif"));
        assert!(!selected_page.contains("__QMUX_BODY_FONT__"));

        let valley_page = render_markdown_page(path, source, Some("valley-sans"));
        assert!(valley_page.contains("font-family: 'Valley Sans', ui-sans-serif"));
        assert!(!valley_page.contains("__QMUX_BODY_FONT__"));

        let unknown_page = render_markdown_page(path, source, Some("body{};color:red"));
        assert!(unknown_page.contains("font-family: ui-sans-serif, system-ui"));
        assert!(!unknown_page.contains("body{};color:red"));
    }

    /// Issues a GET and returns the full response head (status line + headers) and body.
    fn http_get_full(port: u16, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
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
        (head, raw[split..].to_vec())
    }

    fn http_get(port: u16, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let (head, body) = http_get_full(port, path, range);
        let status = head.lines().next().unwrap_or("").to_string();
        (status, body)
    }

    fn url_path(port: u16, token: &str, abs: &Path) -> String {
        file_url(port, token, abs)
            .strip_prefix(&format!("http://127.0.0.1:{port}"))
            .unwrap()
            .to_string()
    }

    /// Builds an `AppState` whose workspace root is `root`, for serving tests.
    fn test_state(root: &Path, base: &Path) -> AppState {
        use crate::config::{
            AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
            OpencodeAdapterConfig, QmuxConfig,
        };
        let config = QmuxConfig {
            workspace_root: root.to_path_buf(),
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
                grok: GrokAdapterConfig {
                    binary: Some("grok".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: PathBuf::new(),
            opencode_plugin_dir: PathBuf::new(),
        };
        AppState::new(config)
    }

    #[test]
    fn serves_files_under_root_with_range_and_blocks_the_rest() {
        let base = std::env::temp_dir().join(format!("qmux-fs-serve-{}", std::process::id()));
        let root = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("hello.txt"), b"hello world").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();

        let state = test_state(&root, &base);
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
    fn renders_markdown_as_html_unless_raw_is_requested() {
        let base = std::env::temp_dir().join(format!("qmux-fs-md-{}", std::process::id()));
        let root = base.join("ws");
        std::fs::create_dir_all(&root).unwrap();
        let source = "# Hello\n\nSome *text* in a table:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
        std::fs::write(root.join("doc.md"), source).unwrap();

        let state = test_state(&root, &base);
        let info = start_file_server(state.clone()).unwrap();
        let token = state.pane_file_token("pane-md").unwrap();
        let doc = std::fs::canonicalize(root.join("doc.md")).unwrap();
        let path = url_path(info.port, &token, &doc);

        // A plain GET returns a rendered HTML page.
        let (head, body) = http_get_full(info.port, &path, None);
        let body_text = String::from_utf8(body).unwrap();
        assert!(head.starts_with("HTTP/1.1 200"), "head: {head}");
        assert!(head.contains("Content-Type: text/html"), "head: {head}");
        assert!(body_text.contains("<h1>Hello</h1>"), "body: {body_text}");
        assert!(body_text.contains("<table>"), "body: {body_text}");

        // `?raw=1` opts out and serves the source as plain text.
        let (head, body) = http_get_full(info.port, &format!("{path}?raw=1"), None);
        assert!(head.starts_with("HTTP/1.1 200"), "head: {head}");
        assert!(head.contains("Content-Type: text/plain"), "head: {head}");
        assert_eq!(body, source.as_bytes());

        // Range on Markdown is ignored: the full rendered page comes back as a 200.
        let (head, body) = http_get_full(info.port, &path, Some("bytes=0-4"));
        assert!(head.starts_with("HTTP/1.1 200"), "head: {head}");
        assert!(
            String::from_utf8(body).unwrap().contains("<h1>Hello</h1>"),
            "range response should carry the full rendered page"
        );

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
