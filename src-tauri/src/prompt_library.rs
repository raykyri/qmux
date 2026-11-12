//! Saved composer messages stored as markdown files in ~/.qmux/prompts/.
//! The filename stem is the slash-command name and the body is the prompt text.
//! Older per-project stores are imported into this global library on access.

use crate::persistence;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

const PROMPTS_DIR: &str = "prompts";
const PROJECTS_DIR: &str = "projects";
const PROMPT_EXTENSION: &str = "md";
const PROMPT_NAMES_MIGRATION_FILE: &str = ".prompt-names-v1.json";
const RESERVED_PROMPT_NAMES: &[&str] = &["fork", "worktree"];
const MAX_NAME_CHARS: usize = 120;

/// Serializes migrations and mutations across composer surfaces.
static LIBRARY_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrompt {
    pub name: String,
    pub content: String,
    pub modified_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptLibrary {
    pub prompts: Vec<SavedPrompt>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PromptNameMigration {
    completed: bool,
    renames: Vec<PromptNameRename>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PromptNameRename {
    from: String,
    to: String,
}

fn qmux_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(persistence::STATE_DIR))
        .ok_or_else(|| "HOME is not set; the prompt library is unavailable".to_string())
}

/// Validates a prompt name and returns it unchanged. Names are lowercase slugs
/// because they double as composer slash commands and filesystem stems.
fn validated_name(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("prompt name is empty".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "prompt name is longer than {MAX_NAME_CHARS} characters"
        ));
    }
    if RESERVED_PROMPT_NAMES.contains(&name) {
        return Err(format!("/{name} is reserved by qMux"));
    }
    if name.starts_with('-')
        || name.ends_with('-')
        || name.contains("--")
        || name
            .chars()
            .any(|c| !c.is_ascii_lowercase() && !c.is_ascii_digit() && c != '-')
    {
        return Err(
            "prompt name must be a lowercase slug using letters, numbers, and hyphens".to_string(),
        );
    }
    Ok(name.to_string())
}

fn prompt_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let name = validated_name(name)?;
    Ok(dir.join(format!("{name}.{PROMPT_EXTENSION}")))
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn legacy_saved_index(name: &str) -> Option<u64> {
    let suffix = name.strip_prefix("saved")?;
    let index = suffix.parse::<u64>().ok()?;
    (index > 0 && name == format!("saved{index}")).then_some(index)
}

fn write_name_migration(path: &Path, migration: &PromptNameMigration) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(migration)
        .map_err(|err| format!("failed to serialize prompt name migration: {err}"))?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    persistence::write_synced(&tmp, &raw)
        .map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("failed to commit {}: {err}", path.display())
    })
}

fn prompt_file_names(dir: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("failed to read prompts dir {}: {err}", dir.display()))?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|ext| ext.to_str()) == Some(PROMPT_EXTENSION))
                .then(|| path.file_stem()?.to_str().map(str::to_string))?
        })
        .collect();
    names.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    Ok(names)
}

fn migrate_scope_names(dir: &Path, taken_names: &HashSet<String>) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|err| format!("failed to create prompts dir {}: {err}", dir.display()))?;
    let marker = dir.join(PROMPT_NAMES_MIGRATION_FILE);
    let mut migration = if marker.exists() {
        serde_json::from_str::<PromptNameMigration>(
            &fs::read_to_string(&marker)
                .map_err(|err| format!("failed to read {}: {err}", marker.display()))?,
        )
        .map_err(|err| format!("failed to parse {}: {err}", marker.display()))?
    } else {
        let names = prompt_file_names(dir)?;
        let occupied: HashSet<String> = names.iter().map(|name| name.to_lowercase()).collect();
        let mut used = taken_names.clone();
        used.extend(RESERVED_PROMPT_NAMES.iter().map(|name| (*name).to_string()));
        let mut preserved = HashSet::new();
        for name in &names {
            if legacy_saved_index(name).is_some() && used.insert(name.clone()) {
                preserved.insert(name.clone());
            }
        }
        let mut next = 1_u64;
        let renames = names
            .into_iter()
            .map(|from| {
                let to = if preserved.contains(&from) {
                    from.clone()
                } else {
                    loop {
                        let candidate = format!("saved{next}");
                        next += 1;
                        if !occupied.contains(&candidate) && used.insert(candidate.clone()) {
                            break candidate;
                        }
                    }
                };
                PromptNameRename { from, to }
            })
            .collect();
        let migration = PromptNameMigration {
            completed: false,
            renames,
        };
        write_name_migration(&marker, &migration)?;
        migration
    };
    if migration.completed {
        return Ok(());
    }

    for rename in &migration.renames {
        if rename.from == rename.to {
            continue;
        }
        let source = dir.join(format!("{}.{}", rename.from, PROMPT_EXTENSION));
        let target = dir.join(format!("{}.{}", rename.to, PROMPT_EXTENSION));
        match (source.exists(), target.exists()) {
            (true, false) => fs::rename(&source, &target).map_err(|err| {
                format!(
                    "failed to migrate prompt {} to {}: {err}",
                    source.display(),
                    target.display()
                )
            })?,
            (false, true) => {}
            (true, true) => {
                return Err(format!(
                    "prompt name migration found both {} and {}",
                    source.display(),
                    target.display()
                ));
            }
            (false, false) => {
                return Err(format!(
                    "prompt name migration couldn't find {} or {}",
                    source.display(),
                    target.display()
                ));
            }
        }
    }
    migration.completed = true;
    write_name_migration(&marker, &migration)
}

/// Lists every readable `.md` prompt in `dir`, sorted by
/// name (case-insensitive). A missing directory is an empty library, not an error,
/// but an unreadable one IS an error: rendering hidden prompts as an empty
/// section would invite the user to re-create (and silently overwrite) them.
/// Individually unreadable or non-UTF-8 files are still skipped so one damaged
/// file can't hide the rest of the library.
fn list_dir(dir: &Path) -> Result<Vec<SavedPrompt>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(format!(
                "failed to read prompts dir {}: {err}",
                dir.display()
            ));
        }
    };

    let mut prompts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some(PROMPT_EXTENSION) {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        prompts.push(SavedPrompt {
            name: name.to_string(),
            content,
            modified_ms: modified_ms(&path),
        });
    }
    prompts.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(prompts)
}

/// Import every central project store, including projects that are no longer
/// open or whose original checkout has been deleted. Names that collide with
/// different content receive a numeric suffix. Matching content also makes a
/// retry after a successful write but failed source removal idempotent.
fn migrate_project_prompts(home: &Path) -> Result<(), String> {
    let projects = home.join(PROJECTS_DIR);
    let entries = match fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("failed to read {}: {err}", projects.display())),
    };
    let mut stores = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read project store: {err}"))?;
        if entry.file_type().map_err(|err| err.to_string())?.is_dir() {
            stores.push(entry.path());
        }
    }
    stores.sort();
    let global = home.join(PROMPTS_DIR);
    let canonical_global = global
        .canonicalize()
        .map_err(|err| format!("failed to resolve {}: {err}", global.display()))?;
    for store in stores {
        let source_dir = store.join(PROMPTS_DIR);
        if !source_dir.exists() {
            continue;
        }
        // A project may already share the global folder through a symlink.
        // Removing its "source" files would delete the global copies too.
        if source_dir
            .canonicalize()
            .map_err(|err| format!("failed to resolve {}: {err}", source_dir.display()))?
            == canonical_global
        {
            continue;
        }
        for name in prompt_file_names(&source_dir)? {
            let source = source_dir.join(format!("{name}.{PROMPT_EXTENSION}"));
            if !source.is_file() {
                continue;
            }
            // Preserve the original bytes even if a damaged prompt cannot be
            // displayed yet. list_dir skips non-UTF-8 content independently.
            let content = fs::read(&source)
                .map_err(|err| format!("failed to read {}: {err}", source.display()))?;
            let base = if validated_name(&name).is_ok() {
                name.as_str()
            } else {
                "saved"
            };
            let mut index = 1_u64;
            loop {
                let candidate = if index == 1 {
                    base.to_string()
                } else {
                    let suffix = format!("-{index}");
                    let prefix = &base[..base.len().min(MAX_NAME_CHARS - suffix.len())];
                    format!("{}{suffix}", prefix.trim_end_matches('-'))
                };
                let target = prompt_path(&global, &candidate)?;
                if target.exists() {
                    // An unreadable target is a collision, never evidence that
                    // the source is safe to remove.
                    if fs::read(&target).ok().as_ref() != Some(&content) {
                        index += 1;
                        continue;
                    }
                } else {
                    write_prompt(&global, &candidate, &content, true)?;
                }
                remove_prompt_file(&source)?;
                break;
            }
        }
    }
    Ok(())
}

fn prepare_library(home: &Path) -> Result<PathBuf, String> {
    let global = home.join(PROMPTS_DIR);
    migrate_scope_names(&global, &HashSet::new())?;
    migrate_project_prompts(home)?;
    Ok(global)
}

pub fn list() -> Result<PromptLibrary, String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = prepare_library(&qmux_home()?)?;
    Ok(PromptLibrary {
        prompts: list_dir(&dir)?,
    })
}

pub fn materialize_dir() -> Result<PathBuf, String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prepare_library(&qmux_home()?)
}

/// The conflict a stale dialog hits: the prompt it was editing/deleting
/// changed on disk since it was loaded, or a create would clobber a name another
/// surface just claimed. Callers refresh and retry.
const PROMPT_CONFLICT_MESSAGE: &str =
    "this prompt changed since it was loaded; refresh the library and try again";

/// Fails when `path`'s current mtime differs from what the caller last saw, so a
/// stale save/delete cannot silently overwrite or remove a prompt another
/// surface updated. `None` opts out (callers with no snapshot to compare). Runs
/// under LIBRARY_LOCK, so the check and the subsequent write don't interleave.
fn ensure_prompt_unchanged(path: &Path, expected_modified_ms: Option<u64>) -> Result<(), String> {
    let Some(expected) = expected_modified_ms else {
        return Ok(());
    };
    if !path.exists() || modified_ms(path) != expected {
        return Err(PROMPT_CONFLICT_MESSAGE.to_string());
    }
    Ok(())
}

/// Writes `content` under `name` in `dir`, atomically (temp + fsync + rename).
/// With `create_only`, refuses to overwrite an existing prompt of that name so
/// two surfaces deriving the same filename can't clobber each other (serialized
/// by LIBRARY_LOCK, so the existence check and the rename don't race in-process).
fn write_prompt(
    dir: &Path,
    name: &str,
    content: &[u8],
    create_only: bool,
) -> Result<PathBuf, String> {
    let path = prompt_path(dir, name)?;
    if create_only && path.exists() {
        return Err(PROMPT_CONFLICT_MESSAGE.to_string());
    }
    fs::create_dir_all(dir)
        .map_err(|err| format!("failed to create prompts dir {}: {err}", dir.display()))?;

    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!(
        "{PROMPT_EXTENSION}.{}.{seq}.tmp",
        std::process::id()
    ));
    persistence::write_synced(&tmp, content)
        .map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("failed to commit {}: {err}", path.display())
    })?;
    Ok(path)
}

fn remove_prompt_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to delete {}: {err}", path.display())),
    }
}

/// Creates or updates a global prompt. Renames commit the new file before
/// removing the old one; the loaded mtime protects an existing prompt from
/// stale edits. Creates and renames cannot overwrite another prompt.
pub fn save(
    name: &str,
    content: &str,
    previous_name: Option<&str>,
    expected_modified_ms: Option<u64>,
) -> Result<SavedPrompt, String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = prepare_library(&qmux_home()?)?;
    save_in_dir(&dir, name, content, previous_name, expected_modified_ms)
}

fn save_in_dir(
    dir: &Path,
    name: &str,
    content: &str,
    previous_name: Option<&str>,
    expected_modified_ms: Option<u64>,
) -> Result<SavedPrompt, String> {
    let target = prompt_path(dir, name)?;
    let previous = previous_name
        .map(|name| prompt_path(dir, name))
        .transpose()?;
    let in_place = previous.as_ref() == Some(&target);
    if let Some(previous) = &previous {
        ensure_prompt_unchanged(previous, expected_modified_ms)?;
    }
    if !in_place && target.exists() {
        return Err(format!("/{name} is already used by another prompt"));
    }
    let path = write_prompt(dir, name, content.as_bytes(), !in_place)?;
    if let Some(previous) = previous {
        if previous != path {
            remove_prompt_file(&previous)
                .map_err(|err| format!("saved, but couldn't remove the old prompt: {err}"))?;
        }
    }
    Ok(SavedPrompt {
        name: name.to_string(),
        content: content.to_string(),
        modified_ms: modified_ms(&path),
    })
}

pub fn delete(name: &str, expected_modified_ms: Option<u64>) -> Result<(), String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = prepare_library(&qmux_home()?)?;
    delete_in_dir(&dir, name, expected_modified_ms)
}

fn delete_in_dir(dir: &Path, name: &str, expected_modified_ms: Option<u64>) -> Result<(), String> {
    let path = prompt_path(dir, name)?;
    if !path.exists() {
        return Ok(());
    }
    ensure_prompt_unchanged(&path, expected_modified_ms)?;
    remove_prompt_file(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-prompts-{label}-{nanos}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn imports_all_projects_into_global_library_without_overwriting() {
        let home = temp_dir("global-migration");
        let global = prepare_library(&home).unwrap();
        fs::write(global.join("review.md"), "global review").unwrap();
        let a = home.join("projects/a/prompts");
        let b = home.join("projects/b/prompts");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("review.md"), "project a review").unwrap();
        fs::write(b.join("review.md"), "project b review").unwrap();
        fs::write(b.join("explain.md"), "explanation").unwrap();
        fs::write(b.join("notes.txt"), "not a prompt").unwrap();
        // A long conflicting name still produces a valid bounded slug.
        let long_name = "x".repeat(MAX_NAME_CHARS);
        fs::write(global.join(format!("{long_name}.md")), "first").unwrap();
        fs::write(a.join(format!("{long_name}.md")), "second").unwrap();
        fs::write(a.join("Invalid name.md"), "legacy prompt").unwrap();

        prepare_library(&home).unwrap();
        let prompts = list_dir(&global).unwrap();
        assert_eq!(prompts.len(), 7);
        assert!(
            prompts
                .iter()
                .all(|prompt| validated_name(&prompt.name).is_ok())
        );
        assert_eq!(
            fs::read_to_string(global.join("review.md")).unwrap(),
            "global review"
        );
        assert_eq!(
            fs::read_to_string(global.join("review-2.md")).unwrap(),
            "project a review"
        );
        assert_eq!(
            fs::read_to_string(global.join("review-3.md")).unwrap(),
            "project b review"
        );
        assert_eq!(
            fs::read_to_string(global.join("explain.md")).unwrap(),
            "explanation"
        );
        assert!(prompt_file_names(&a).unwrap().is_empty());
        assert!(prompt_file_names(&b).unwrap().is_empty());
        assert!(b.join("notes.txt").exists());
        prepare_library(&home).unwrap();
        assert_eq!(list_dir(&global).unwrap().len(), 7);
        // A deleted imported prompt must never reappear on another access.
        delete_in_dir(&global, "review-2", None).unwrap();
        prepare_library(&home).unwrap();
        assert_eq!(list_dir(&global).unwrap().len(), 6);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn interrupted_import_reuses_the_already_written_target() {
        let home = temp_dir("retry-import");
        let global = prepare_library(&home).unwrap();
        fs::write(global.join("review.md"), "global").unwrap();
        fs::write(global.join("review-2.md"), "imported").unwrap();
        let source = home.join("projects/old/prompts");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("review.md"), "imported").unwrap();
        prepare_library(&home).unwrap();
        assert_eq!(list_dir(&global).unwrap().len(), 2);
        assert!(!source.join("review.md").exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn import_keeps_global_prompts_when_a_project_folder_links_to_global() {
        let home = temp_dir("linked-library");
        let global = prepare_library(&home).unwrap();
        fs::write(global.join("review.md"), "keep this").unwrap();
        let store = home.join("projects/linked");
        fs::create_dir_all(&store).unwrap();
        std::os::unix::fs::symlink(&global, store.join(PROMPTS_DIR)).unwrap();

        prepare_library(&home).unwrap();

        assert_eq!(
            fs::read_to_string(global.join("review.md")).unwrap(),
            "keep this"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn import_preserves_non_utf8_files_without_blocking_readable_prompts() {
        let home = temp_dir("non-utf8-import");
        let global = prepare_library(&home).unwrap();
        let source = home.join("projects/old/prompts");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("damaged.md"), [0xff, 0xfe]).unwrap();
        fs::write(source.join("review.md"), "review this").unwrap();

        prepare_library(&home).unwrap();

        assert_eq!(fs::read(global.join("damaged.md")).unwrap(), [0xff, 0xfe]);
        let prompts = list_dir(&global).unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "review");
        assert!(prompt_file_names(&source).unwrap().is_empty());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn failed_import_keeps_the_source_prompt() {
        let home = temp_dir("failed-import");
        let source = home.join("projects/old/prompts");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("review.md"), "keep this").unwrap();
        fs::write(home.join(PROMPTS_DIR), "blocks directory creation").unwrap();
        assert!(migrate_project_prompts(&home).is_err());
        assert_eq!(
            fs::read_to_string(source.join("review.md")).unwrap(),
            "keep this"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn list_ignores_non_markdown_and_missing_directories() {
        let dir = temp_dir("list");
        assert!(list_dir(&dir.join("missing")).unwrap().is_empty());
        fs::write(dir.join("notes.txt"), "not a prompt").unwrap();
        fs::write(dir.join("review.md"), "review").unwrap();
        let prompts = list_dir(&dir).unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "review");
        assert_eq!(prompts[0].content, "review");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn global_crud_preserves_concurrency_checks_and_rename_safety() {
        let dir = temp_dir("crud");
        let saved = save_in_dir(&dir, "review", "first", None, None).unwrap();
        assert!(save_in_dir(&dir, "review", "clobber", None, None).is_err());
        assert!(
            save_in_dir(
                &dir,
                "review",
                "stale",
                Some("review"),
                Some(saved.modified_ms.wrapping_add(1))
            )
            .is_err()
        );
        assert!(delete_in_dir(&dir, "review", Some(saved.modified_ms.wrapping_add(1))).is_err());
        let updated = save_in_dir(
            &dir,
            "review",
            "second",
            Some("review"),
            Some(saved.modified_ms),
        )
        .unwrap();
        save_in_dir(&dir, "other", "other body", None, None).unwrap();
        assert!(
            save_in_dir(
                &dir,
                "other",
                "overwrite",
                Some("review"),
                Some(updated.modified_ms)
            )
            .is_err()
        );
        let renamed = save_in_dir(
            &dir,
            "renamed",
            "second",
            Some("review"),
            Some(updated.modified_ms),
        )
        .unwrap();
        assert!(!dir.join("review.md").exists());
        assert_eq!(
            fs::read_to_string(dir.join("other.md")).unwrap(),
            "other body"
        );
        delete_in_dir(&dir, "renamed", Some(renamed.modified_ms)).unwrap();
        delete_in_dir(&dir, "renamed", Some(renamed.modified_ms)).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unsafe_and_reserved_names() {
        let dir = temp_dir("unsafe");
        for name in [
            "",
            "../escape",
            "a/b",
            "a\\b",
            ".hidden",
            "a:b",
            "a\nb",
            "Upper",
            "two words",
            "double--dash",
            "fork",
            "worktree",
        ] {
            assert!(
                save_in_dir(&dir, name, "body", None, None).is_err(),
                "accepted {name:?}"
            );
        }
        assert!(list_dir(&dir).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_legacy_prompt_names_deterministically() {
        let dir = temp_dir("migrate");
        fs::write(dir.join("Alpha prompt.md"), "alpha").unwrap();
        fs::write(dir.join("Saved1.md"), "case collision").unwrap();
        fs::write(dir.join("fork.md"), "reserved").unwrap();
        fs::write(dir.join("saved2.md"), "existing saved name").unwrap();
        let taken = HashSet::from(["saved1".to_string()]);

        migrate_scope_names(&dir, &taken).unwrap();

        let prompts = list_dir(&dir).unwrap();
        assert_eq!(
            prompts
                .iter()
                .map(|prompt| (prompt.name.as_str(), prompt.content.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("saved2", "existing saved name"),
                ("saved3", "alpha"),
                ("saved4", "reserved"),
                ("saved5", "case collision"),
            ]
        );
        assert!(dir.join(PROMPT_NAMES_MIGRATION_FILE).exists());

        migrate_scope_names(&dir, &taken).unwrap();
        assert_eq!(list_dir(&dir).unwrap().len(), 4);
        fs::remove_file(dir.join("saved3.md")).unwrap();
        migrate_scope_names(&dir, &taken).unwrap();
        assert_eq!(list_dir(&dir).unwrap().len(), 3);
    }

    #[test]
    fn resumes_an_interrupted_prompt_name_migration() {
        let dir = temp_dir("resume-migration");
        let migration = PromptNameMigration {
            completed: false,
            renames: vec![PromptNameRename {
                from: "legacy".to_string(),
                to: "saved1".to_string(),
            }],
        };
        write_name_migration(&dir.join(PROMPT_NAMES_MIGRATION_FILE), &migration).unwrap();
        fs::write(dir.join("saved1.md"), "body").unwrap();

        migrate_scope_names(&dir, &HashSet::new()).unwrap();

        let prompts = list_dir(&dir).unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "saved1");
        assert_eq!(prompts[0].content, "body");
    }
}
