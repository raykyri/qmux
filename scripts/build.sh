#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"

"$script_dir/cleanup-tauri-dmg.sh"

finder_layout_failed=0

# Tauri's DMG bundler runs an AppleScript step that drives Finder to lay out the
# disk-image window. That step needs Finder/Apple Events access and fails or hangs
# in non-interactive or unauthorized contexts, leaving a half-built DMG mounted and
# aborting the build with "error running bundle_dmg.sh". Keep normal builds
# deterministic, but allow an explicit interactive attempt that falls back to the
# CI/--skip-jenkins path if Finder automation is unavailable.
case "${QMUX_DMG_FINDER_LAYOUT:-}" in
  1 | true | yes | try)
    echo "Trying Tauri DMG build with Finder window layout enabled..."
    set +e
    TAURI_BUNDLER_DMG_IGNORE_CI=true tauri build
    status=$?
    set -e

    if [[ "$status" -eq 0 ]]; then
      exit 0
    fi

    if [[ "$status" -eq 130 || "$status" -eq 143 ]]; then
      exit "$status"
    fi

    echo "Finder DMG layout failed; retrying with Finder layout skipped."
    "$script_dir/cleanup-tauri-dmg.sh"
    finder_layout_failed=1
    ;;
esac

# Setting CI makes Tauri pass --skip-jenkins to bundle_dmg.sh, which skips the
# AppleScript and produces the DMG deterministically. Respect a caller-provided CI
# value if one is already set, except after a failed Finder attempt where the
# fallback must force the non-interactive path.
if [[ "$finder_layout_failed" -eq 1 ]]; then
  env -u TAURI_BUNDLER_DMG_IGNORE_CI CI=true tauri build
else
  export CI="${CI:-true}"
  tauri build
fi
