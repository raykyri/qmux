#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"

"$script_dir/cleanup-tauri-dmg.sh"

# Tauri's DMG bundler runs an AppleScript step that drives Finder to lay out the
# disk-image window. That step needs Finder/Apple Events access and fails or hangs
# in non-interactive or unauthorized contexts, leaving a half-built DMG mounted and
# aborting the build with "error running bundle_dmg.sh". Setting CI makes Tauri pass
# --skip-jenkins to bundle_dmg.sh, which skips the AppleScript and produces the DMG
# deterministically. Respect a caller-provided CI value if one is already set.
export CI="${CI:-true}"

tauri build
