#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Native terminal tests require macOS and the Swift/Xcode toolchain." >&2
  exit 1
fi

# build.rs prepares the exact patched Ghostty package linked by the app. Using
# its preparation keeps native tests from accidentally testing the unpatched
# submodule. After test:rust this is normally an up-to-date build, not another
# execution of the Rust tests. It also makes test:native usable on its own.
cargo test --manifest-path "$repo_root/src-tauri/Cargo.toml" --package qmux --no-run

task_target_dir="$(cargo metadata --manifest-path "$repo_root/src-tauri/Cargo.toml" --no-deps --format-version 1 | node -e 'let input=""; process.stdin.on("data", part => input += part); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));')"
task_native_root="$task_target_dir/native-terminal"
export QMUX_GHOSTTY_PACKAGE_PATH="$task_native_root/libghostty-spm"
export CLANG_MODULE_CACHE_PATH="$task_native_root/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$task_native_root/module-cache"

# A separate scratch directory preserves the release archives used by build.rs.
exec swift test \
  --package-path "$repo_root/src-tauri/swift-terminal" \
  --scratch-path "$task_native_root/swiftpm-tests" \
  --cache-path "$task_native_root/cache" \
  --config-path "$task_native_root/config" \
  --security-path "$task_native_root/security"
