#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"

# `tauri` lives in node_modules/.bin; put it on PATH so this script also works
# when invoked directly (e.g. from release.sh) rather than through `npm run`.
export PATH="$script_dir/../node_modules/.bin:$PATH"

# Shipped bundles must include the Foundation Models tab-title bridge; without
# this the bridge is optional and a missing Swift toolchain only warns.
export QMUX_REQUIRE_FOUNDATION_MODELS=1

# createUpdaterArtifacts makes the bundler sign the updater .tar.gz, which fails
# without the private half of the updater keypair. Pick up the local key when the
# caller didn't provide one (CI should set TAURI_SIGNING_PRIVATE_KEY instead; the
# variable accepts either the key contents or a path to the key file).
default_updater_key="$HOME/.tauri/qmux-updater.key"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$default_updater_key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$default_updater_key"
fi

# Release DMGs must run on both Apple Silicon and Intel Macs, so default to a
# universal binary. Override with e.g. QMUX_BUILD_TARGET=aarch64-apple-darwin
# for a faster single-arch build.
build_target="${QMUX_BUILD_TARGET:-universal-apple-darwin}"

if [[ "$build_target" == "universal-apple-darwin" ]] && command -v rustup >/dev/null; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
fi

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
    TAURI_BUNDLER_DMG_IGNORE_CI=true tauri build --target "$build_target"
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
  env -u TAURI_BUNDLER_DMG_IGNORE_CI CI=true tauri build --target "$build_target"
else
  export CI="${CI:-true}"
  tauri build --target "$build_target"
fi
