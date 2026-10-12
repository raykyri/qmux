#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Native browser callback tests require macOS." >&2
  exit 1
fi

# Use the app's exact Wry/objc2 artifacts, including its vendor patch and feature
# selection. The standalone runner owns the main thread required by AppKit;
# Rust's ordinary test harness runs tests on worker threads.
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
cargo test --manifest-path "$repo_root/src-tauri/Cargo.toml" --package qmux \
  --no-run --message-format=json > "$test_dir/artifacts.jsonl"
python3 - "$repo_root" "$test_dir" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

repo, output = map(Path, sys.argv[1:])
dependencies = {name: set() for name in (
    "wry", "objc2", "objc2_app_kit", "objc2_web_kit", "objc2_foundation",
    "raw_window_handle", "block2",
)}
for line in (output / "artifacts.jsonl").read_text().splitlines():
    artifact = json.loads(line)
    if artifact.get("reason") != "compiler-artifact":
        continue
    name = artifact["target"]["name"]
    if name in dependencies:
        dependencies[name].update(p for p in artifact["filenames"] if p.endswith(".rlib"))

command = [os.environ.get("RUSTC", "rustc"), "--edition=2021",
           str(repo / "tests/nativeBrowserCallbacks.rs"),
           "-o", str(output / "native-browser-callbacks")]
directories = set()
for name, paths in dependencies.items():
    if len(paths) != 1:
        raise SystemExit(f"Expected one app artifact for {name}, got {sorted(paths)}")
    path = next(iter(paths))
    command.extend(["--extern", f"{name}={path}"])
    directories.add(str(Path(path).parent))
for directory in sorted(directories):
    command.extend(["-L", f"dependency={directory}"])
subprocess.run(command, check=True)
subprocess.run([str(output / "native-browser-callbacks")], check=True)
PY
