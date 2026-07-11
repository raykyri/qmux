//! The saved prompt library: reusable composer messages stored as plain markdown
//! files, one file per prompt. The filesystem is the source of truth — files are
//! diffable, editable outside the app, and there is no index to migrate or fall
//! out of sync. The prompt's name is its filename stem; its content is the file
//! body.
//!
//! Prompts live in one of two scopes: `global` (`~/.qmux/prompts/`, visible from
//! every workspace) and `project` (`<workspaceRoot>/.qmux/prompts/`, visible only
//! while qmux runs in that workspace). Moving a prompt between scopes is a save
//! into the target directory followed by a delete from the source.

use crate::persistence;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

const PROMPTS_DIR: &str = "prompts";
const PROMPT_EXTENSION: &str = "md";
/// Filenames land in menus and Finder; anything longer is a paragraph, not a name.
const MAX_NAME_CHARS: usize = 120;

/// Serializes save/delete pairs (a rename's or move's write-then-remove) so two UI
/// surfaces can't interleave and leave both the old and new file behind.
static LIBRARY_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
/// Distinguishes concurrent writers' scratch files, mirroring persistence::TMP_SEQ.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptScope {
    Global,
    Project,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrompt {
    pub name: String,
    pub content: String,
    pub modified_ms: u64,
    pub scope: PromptScope,
}

/// The whole library plus whether the project scope is a distinct place: when the
/// workspace root *is* the home directory the two scopes share one folder, and the
/// UI should collapse to a single Global section instead of showing a mirage of
/// two independent stores.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptLibrary {
    pub prompts: Vec<SavedPrompt>,
    pub has_project_scope: bool,
}

fn global_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| {
            PathBuf::from(home)
                .join(persistence::STATE_DIR)
                .join(PROMPTS_DIR)
        })
        .ok_or_else(|| "HOME is not set; global prompts are unavailable".to_string())
}

fn project_dir(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(persistence::STATE_DIR)
        .join(PROMPTS_DIR)
}

pub fn scope_dir(workspace_root: &Path, scope: PromptScope) -> Result<PathBuf, String> {
    match scope {
        PromptScope::Global => global_dir(),
        PromptScope::Project => Ok(project_dir(workspace_root)),
    }
}

/// Whether global and project prompts live in different folders (see PromptLibrary).
fn scopes_distinct(workspace_root: &Path) -> bool {
    match global_dir() {
        Ok(global) => global != project_dir(workspace_root),
        Err(_) => false,
    }
}

/// Validates a prompt name and returns it trimmed. Names become filename stems,
/// so path separators, traversal dots, and control characters are rejected rather
/// than escaped — the stored name should read back exactly as typed.
fn validated_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("prompt name is empty".to_string());
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "prompt name is longer than {MAX_NAME_CHARS} characters"
        ));
    }
    if trimmed.starts_with('.') {
        return Err("prompt name can't start with a dot".to_string());
    }
    if trimmed
        .chars()
        .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
    {
        return Err("prompt name can't contain /, \\, : or control characters".to_string());
    }
    Ok(trimmed.to_string())
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

/// Lists every readable `.md` prompt in `dir`, tagged with `scope` and sorted by
/// name (case-insensitive). A missing directory is an empty scope, not an error;
/// unreadable or non-UTF-8 files are skipped so one damaged file can't hide the
/// rest of the library.
fn list_dir(dir: &Path, scope: PromptScope) -> Result<Vec<SavedPrompt>, String> {
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
            scope,
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

/// Lists both scopes. A global scope that is unavailable (no HOME) or unreadable
/// degrades to empty rather than hiding the project prompts, and vice versa is not
/// forgiven: the project dir lives under the workspace the app already writes to,
/// so a read failure there is a real error worth surfacing.
pub fn list(workspace_root: &Path) -> Result<PromptLibrary, String> {
    let has_project_scope = scopes_distinct(workspace_root);
    let mut prompts = match global_dir() {
        Ok(dir) => list_dir(&dir, PromptScope::Global).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if has_project_scope {
        prompts.extend(list_dir(
            &project_dir(workspace_root),
            PromptScope::Project,
        )?);
    }
    Ok(PromptLibrary {
        prompts,
        has_project_scope,
    })
}

/// Writes `content` under `name` in `dir`, atomically (temp + fsync + rename).
fn write_prompt(dir: &Path, name: &str, content: &str) -> Result<PathBuf, String> {
    let path = prompt_path(dir, name)?;
    fs::create_dir_all(dir)
        .map_err(|err| format!("failed to create prompts dir {}: {err}", dir.display()))?;

    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!(
        "{PROMPT_EXTENSION}.{}.{seq}.tmp",
        std::process::id()
    ));
    persistence::write_synced(&tmp, content.as_bytes())
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

/// Creates or overwrites the prompt `name` in `scope`. When `previous` names a
/// different (scope, name) location this is a rename and/or a move between scopes:
/// the new file is committed first, then the old one removed, so an interruption
/// can duplicate a prompt but never lose one.
pub fn save(
    workspace_root: &Path,
    scope: PromptScope,
    name: &str,
    content: &str,
    previous: Option<(PromptScope, &str)>,
) -> Result<SavedPrompt, String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let dir = scope_dir(workspace_root, scope)?;
    let path = write_prompt(&dir, name, content)?;

    if let Some((previous_scope, previous_name)) = previous {
        let previous_dir = scope_dir(workspace_root, previous_scope)?;
        let previous_path = prompt_path(&previous_dir, previous_name)?;
        if previous_path != path {
            remove_prompt_file(&previous_path)
                .map_err(|err| format!("saved, but couldn't remove the old prompt: {err}"))?;
        }
    }

    Ok(SavedPrompt {
        name: validated_name(name)?,
        content: content.to_string(),
        modified_ms: modified_ms(&path),
        scope,
    })
}

/// Removes the prompt `name` from `scope`. Deleting a prompt that is already gone
/// succeeds: the caller's goal (the file no longer exists) is met either way.
pub fn delete(workspace_root: &Path, scope: PromptScope, name: &str) -> Result<(), String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = scope_dir(workspace_root, scope)?;
    remove_prompt_file(&prompt_path(&dir, name)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qmux-prompts-{nanos}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn empty_dir_lists_nothing() {
        let dir = temp_dir().join("missing");
        assert!(list_dir(&dir, PromptScope::Project).unwrap().is_empty());
    }

    #[test]
    fn project_save_list_delete_round_trip() {
        let root = temp_dir();
        save(
            &root,
            PromptScope::Project,
            "Review checklist",
            "Review {target} for bugs.",
            None,
        )
        .unwrap();
        save(&root, PromptScope::Project, "bugfix", "Fix {file}.", None).unwrap();

        let prompts = list_dir(&project_dir(&root), PromptScope::Project).unwrap();
        assert_eq!(
            prompts.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["bugfix", "Review checklist"]
        );
        assert_eq!(prompts[1].content, "Review {target} for bugs.");
        assert!(prompts.iter().all(|p| p.scope == PromptScope::Project));

        delete(&root, PromptScope::Project, "bugfix").unwrap();
        let prompts = list_dir(&project_dir(&root), PromptScope::Project).unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "Review checklist");

        // Deleting an already-missing prompt is a no-op, not an error.
        delete(&root, PromptScope::Project, "bugfix").unwrap();
    }

    #[test]
    fn rename_within_scope_moves_the_file() {
        let root = temp_dir();
        save(&root, PromptScope::Project, "old name", "body", None).unwrap();
        save(
            &root,
            PromptScope::Project,
            "new name",
            "body v2",
            Some((PromptScope::Project, "old name")),
        )
        .unwrap();

        let prompts = list_dir(&project_dir(&root), PromptScope::Project).unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "new name");
        assert_eq!(prompts[0].content, "body v2");
    }

    #[test]
    fn move_between_dirs_removes_the_source() {
        // Exercise the move mechanics on two explicit dirs (the global dir depends
        // on HOME, which tests must not mutate process-wide).
        let from = temp_dir();
        let to = temp_dir();
        write_prompt(&from, "shared", "body").unwrap();

        let path = write_prompt(&to, "shared", "body").unwrap();
        remove_prompt_file(&prompt_path(&from, "shared").unwrap()).unwrap();

        assert!(path.exists());
        assert!(list_dir(&from, PromptScope::Project).unwrap().is_empty());
        assert_eq!(list_dir(&to, PromptScope::Global).unwrap().len(), 1);
    }

    #[test]
    fn overwrite_updates_content() {
        let root = temp_dir();
        save(&root, PromptScope::Project, "note", "v1", None).unwrap();
        save(
            &root,
            PromptScope::Project,
            "note",
            "v2",
            Some((PromptScope::Project, "note")),
        )
        .unwrap();
        let prompts = list_dir(&project_dir(&root), PromptScope::Project).unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].content, "v2");
    }

    #[test]
    fn rejects_unsafe_names() {
        let root = temp_dir();
        for bad in [
            "",
            "  ",
            "../escape",
            "a/b",
            "a\\b",
            ".hidden",
            "a:b",
            "a\nb",
        ] {
            assert!(
                save(&root, PromptScope::Project, bad, "body", None).is_err(),
                "accepted {bad:?}"
            );
        }
        assert!(
            list_dir(&project_dir(&root), PromptScope::Project)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn skips_non_markdown_files() {
        let root = temp_dir();
        save(&root, PromptScope::Project, "keep", "body", None).unwrap();
        fs::write(project_dir(&root).join("notes.txt"), "ignored").unwrap();
        let prompts = list_dir(&project_dir(&root), PromptScope::Project).unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "keep");
    }

    #[test]
    fn scope_serialization_is_lowercase() {
        assert_eq!(
            serde_json::to_string(&PromptScope::Global).unwrap(),
            "\"global\""
        );
        assert_eq!(
            serde_json::from_str::<PromptScope>("\"project\"").unwrap(),
            PromptScope::Project
        );
    }
}
