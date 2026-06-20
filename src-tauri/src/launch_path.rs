use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

const HOME_FALLBACK_DIRS: &[&str] = &[
    ".local/bin",
    "bin",
    ".npm-global/bin",
    ".bun/bin",
    "Library/pnpm",
    ".cargo/bin",
    ".deno/bin",
    "go/bin",
];

const SYSTEM_FALLBACK_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

pub(crate) fn resolve_binary(binary: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH");
    let home = env::var_os("HOME").map(PathBuf::from);
    resolve_binary_from(binary, path.as_deref(), home.as_deref())
}

pub(crate) fn child_path() -> Option<String> {
    let path = env::var_os("PATH");
    let home = env::var_os("HOME").map(PathBuf::from);
    child_path_from(path.as_deref(), home.as_deref())
}

fn resolve_binary_from(binary: &str, path: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        return binary_path.is_file().then(|| binary_path.to_path_buf());
    }

    launch_path_dirs(path, home)
        .into_iter()
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}

fn child_path_from(path: Option<&OsStr>, home: Option<&Path>) -> Option<String> {
    env::join_paths(launch_path_dirs(path, home))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

fn launch_path_dirs(path: Option<&OsStr>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();

    if let Some(path) = path {
        for dir in env::split_paths(path) {
            push_unique_path(&mut dirs, &mut seen, dir);
        }
    }

    if let Some(home) = home {
        for relative in HOME_FALLBACK_DIRS {
            push_unique_path(&mut dirs, &mut seen, home.join(relative));
        }
    }

    for absolute in SYSTEM_FALLBACK_DIRS {
        push_unique_path(&mut dirs, &mut seen, PathBuf::from(absolute));
    }

    dirs
}

fn push_unique_path(dirs: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>, dir: PathBuf) {
    if seen.insert(dir.as_os_str().to_os_string()) {
        dirs.push(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("qmux-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"test").unwrap();
    }

    #[test]
    fn resolves_binary_from_user_fallback_dirs_when_path_is_minimal() {
        let home = temp_root("home-fallback");
        let binary = home.join(".local/bin/claude");
        touch(&binary);

        let resolved =
            resolve_binary_from("claude", Some(OsStr::new("/usr/bin:/bin")), Some(&home));

        assert_eq!(resolved, Some(binary));
    }

    #[test]
    fn path_entries_take_precedence_over_fallback_dirs() {
        let root = temp_root("path-precedence");
        let path_bin = root.join("path-bin");
        let home = root.join("home");
        let path_binary = path_bin.join("codex");
        let fallback_binary = home.join(".local/bin/codex");
        touch(&path_binary);
        touch(&fallback_binary);
        let path = env::join_paths([path_bin]).unwrap();

        let resolved = resolve_binary_from("codex", Some(path.as_os_str()), Some(&home));

        assert_eq!(resolved, Some(path_binary));
    }

    #[test]
    fn slash_containing_binary_is_checked_directly() {
        let root = temp_root("direct-binary");
        let binary = root.join("tools/claude");
        touch(&binary);

        let resolved = resolve_binary_from(binary.to_str().unwrap(), None, None);

        assert_eq!(resolved, Some(binary));
        assert!(resolve_binary_from("/missing/claude", None, None).is_none());
    }

    #[test]
    fn child_path_appends_user_and_system_fallback_dirs() {
        let home = PathBuf::from("/Users/tester");
        let child_path = child_path_from(Some(OsStr::new("/usr/bin:/bin")), Some(&home)).unwrap();
        let dirs = env::split_paths(OsStr::new(&child_path)).collect::<Vec<_>>();

        assert_eq!(dirs[0], PathBuf::from("/usr/bin"));
        assert_eq!(dirs[1], PathBuf::from("/bin"));
        assert!(dirs.contains(&PathBuf::from("/Users/tester/.local/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }
}
