use crate::events::base64_encode;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_READ_CHUNK: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationCacheHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationCacheMetadata {
    pub size: u64,
    pub headers: Vec<DictationCacheHeader>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDictationCacheMetadata {
    request: String,
    size: u64,
    headers: Vec<DictationCacheHeader>,
}

struct CachePaths {
    data: PathBuf,
    meta: PathBuf,
    data_tmp: PathBuf,
    meta_tmp: PathBuf,
}

pub fn metadata(app: AppHandle, request: String) -> Result<Option<DictationCacheMetadata>, String> {
    let Some((stored, paths)) = read_metadata(&app, &request)? else {
        return Ok(None);
    };
    let size = fs::metadata(&paths.data)
        .map_err(|err| format!("failed to stat dictation cache entry: {err}"))?
        .len();
    Ok(Some(DictationCacheMetadata {
        size,
        headers: stored.headers,
    }))
}

pub fn read_chunk(
    app: AppHandle,
    request: String,
    offset: u64,
    length: u64,
) -> Result<String, String> {
    let Some((_stored, paths)) = read_metadata(&app, &request)? else {
        return Err("dictation cache entry not found".to_string());
    };
    let mut file = File::open(&paths.data)
        .map_err(|err| format!("failed to open dictation cache entry: {err}"))?;
    let size = file
        .metadata()
        .map_err(|err| format!("failed to stat dictation cache entry: {err}"))?
        .len();
    if offset >= size {
        return Ok(String::new());
    }
    let length = length.min(MAX_READ_CHUNK).min(size - offset);
    let mut buf = vec![0; length as usize];
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("failed to seek dictation cache entry: {err}"))?;
    let read = file
        .read(&mut buf)
        .map_err(|err| format!("failed to read dictation cache entry: {err}"))?;
    buf.truncate(read);
    Ok(base64_encode(&buf))
}

pub fn put_start(
    app: AppHandle,
    request: String,
    headers: Vec<DictationCacheHeader>,
) -> Result<(), String> {
    let paths = cache_paths(&app, &request)?;
    let mut data_tmp = File::create(&paths.data_tmp)
        .map_err(|err| format!("failed to create dictation cache temp file: {err}"))?;
    data_tmp
        .flush()
        .map_err(|err| format!("failed to flush dictation cache temp file: {err}"))?;
    let metadata = StoredDictationCacheMetadata {
        request,
        size: 0,
        headers,
    };
    write_metadata_file(&paths.meta_tmp, &metadata)
}

pub fn put_chunk(app: AppHandle, request: String, data_base64: String) -> Result<(), String> {
    let paths = cache_paths(&app, &request)?;
    let data = base64_decode(&data_base64)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.data_tmp)
        .map_err(|err| format!("failed to open dictation cache temp file: {err}"))?;
    file.write_all(&data)
        .map_err(|err| format!("failed to write dictation cache chunk: {err}"))?;
    Ok(())
}

pub fn put_finish(app: AppHandle, request: String) -> Result<(), String> {
    let paths = cache_paths(&app, &request)?;
    let mut metadata = read_metadata_file(&paths.meta_tmp)?
        .ok_or_else(|| "dictation cache metadata temp file is missing".to_string())?;
    if metadata.request != request {
        return Err("dictation cache metadata request mismatch".to_string());
    }

    let data_file = OpenOptions::new()
        .read(true)
        .open(&paths.data_tmp)
        .map_err(|err| format!("failed to open dictation cache temp file: {err}"))?;
    metadata.size = data_file
        .metadata()
        .map_err(|err| format!("failed to stat dictation cache temp file: {err}"))?
        .len();
    data_file
        .sync_all()
        .map_err(|err| format!("failed to sync dictation cache temp file: {err}"))?;
    write_metadata_file(&paths.meta_tmp, &metadata)?;
    replace_file(&paths.data_tmp, &paths.data)?;
    replace_file(&paths.meta_tmp, &paths.meta)?;
    Ok(())
}

pub fn delete(app: AppHandle, request: String) -> Result<bool, String> {
    let paths = cache_paths(&app, &request)?;
    let mut removed = false;
    for path in [&paths.data, &paths.meta, &paths.data_tmp, &paths.meta_tmp] {
        match fs::remove_file(path) {
            Ok(()) => removed = true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("failed to remove dictation cache file: {err}")),
        }
    }
    Ok(removed)
}

fn read_metadata(
    app: &AppHandle,
    request: &str,
) -> Result<Option<(StoredDictationCacheMetadata, CachePaths)>, String> {
    let paths = cache_paths(app, request)?;
    let Some(metadata) = read_metadata_file(&paths.meta)? else {
        return Ok(None);
    };
    if metadata.request != request || !paths.data.is_file() {
        return Ok(None);
    }
    Ok(Some((metadata, paths)))
}

fn cache_paths(app: &AppHandle, request: &str) -> Result<CachePaths, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("failed to resolve app cache dir: {err}"))?
        .join("transformers");
    fs::create_dir_all(&root)
        .map_err(|err| format!("failed to create dictation cache dir: {err}"))?;
    let id = cache_id(request);
    Ok(CachePaths {
        data: root.join(format!("{id}.bin")),
        meta: root.join(format!("{id}.json")),
        data_tmp: root.join(format!("{id}.bin.tmp")),
        meta_tmp: root.join(format!("{id}.json.tmp")),
    })
}

fn cache_id(request: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in request.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn read_metadata_file(path: &Path) -> Result<Option<StoredDictationCacheMetadata>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("failed to read dictation cache metadata: {err}")),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|err| format!("invalid dictation cache metadata: {err}"))
}

fn write_metadata_file(path: &Path, metadata: &StoredDictationCacheMetadata) -> Result<(), String> {
    let raw = serde_json::to_vec(metadata)
        .map_err(|err| format!("failed to encode dictation cache metadata: {err}"))?;
    fs::write(path, raw)
        .map_err(|err| format!("failed to write dictation cache metadata: {err}"))?;
    if let Ok(file) = File::open(path) {
        file.sync_all()
            .map_err(|err| format!("failed to sync dictation cache metadata: {err}"))?;
    }
    Ok(())
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_err) if to.exists() => {
            fs::remove_file(to).map_err(|remove_err| {
                format!("failed to replace dictation cache file: {remove_err}")
            })?;
            fs::rename(from, to).map_err(|rename_err| {
                format!("failed to commit dictation cache file: {rename_err}")
            })
        }
        Err(err) => Err(format!("failed to commit dictation cache file: {err}")),
    }
}

fn base64_decode(raw: &str) -> Result<Vec<u8>, String> {
    let bytes = raw.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err("invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        let c = base64_value(chunk[2])?;
        let d = base64_value(chunk[3])?;
        if a == 64 || b == 64 || (c == 64 && d != 64) {
            return Err("invalid base64 padding".to_string());
        }
        out.push((a << 2) | (b >> 4));
        if c != 64 {
            out.push(((b & 0x0f) << 4) | (c >> 2));
        }
        if d != 64 {
            out.push(((c & 0x03) << 6) | d);
        }
    }
    Ok(out)
}

fn base64_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        b'=' => Ok(64),
        _ => Err("invalid base64 character".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decode_matches_known_vectors() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(base64_decode("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(base64_decode("Zm9vYmE=").unwrap(), b"fooba");
        assert_eq!(base64_decode("Zm9vYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn cache_id_is_stable() {
        assert_eq!(
            cache_id("https://example.com/model.onnx"),
            "99914a056087891e"
        );
    }
}
