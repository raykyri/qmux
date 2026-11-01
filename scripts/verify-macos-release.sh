#!/usr/bin/env bash
set -euo pipefail

# Verify distribution contents even for ad-hoc or explicitly unnotarized builds.
notarized=1
allow_unsigned_dmg=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --skip-notarization) notarized=0 ;;
    --allow-unsigned-dmg) allow_unsigned_dmg=1 ;;
    *) break ;;
  esac
  shift
done
if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
  echo "Usage: $0 [--skip-notarization [--allow-unsigned-dmg]] /path/to/qmux.app /path/to/qmux.dmg [/path/to/qmux.app.tar.gz]" >&2
  exit 2
fi
if [[ "$allow_unsigned_dmg" -eq 1 && "$notarized" -eq 1 ]]; then
  echo "--allow-unsigned-dmg is only supported with --skip-notarization for development builds." >&2
  exit 2
fi

app="$1"
dmg="$2"
archive="${3:-}"
[[ -d "$app" && -f "$dmg" ]] || {
  echo "Release app or DMG is missing." >&2
  exit 1
}

verify_app() {
  local candidate="$1"
  local binary="$candidate/Contents/MacOS/qmux"
  local archs
  local target
  [[ -f "$binary" ]] || {
    echo "App executable is missing: $binary" >&2
    return 1
  }
  archs="$(lipo "$binary" -archs)"
  if [[ "$archs" != arm64 ]]; then
    echo "Expected only arm64 in $binary; found: $archs" >&2
    return 1
  fi
  for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
    if [[ ! -x "$candidate/Contents/Resources/remote-cli/$target/qmux-cli" ]]; then
      echo "Bundled remote CLI is missing or not executable: $candidate/Contents/Resources/remote-cli/$target/qmux-cli" >&2
      return 1
    fi
  done
  codesign --verify --deep --strict --verbose=2 "$candidate"
  if [[ "$notarized" -eq 1 ]]; then
    xcrun stapler validate "$candidate"
    spctl --assess --type execute --verbose=4 "$candidate"
  fi
}

verify_packaged_app() {
  local candidate="$1"
  verify_app "$candidate"
  if ! cmp -s "$app/Contents/MacOS/qmux" "$candidate/Contents/MacOS/qmux"; then
    echo "Packaged executable differs from the built app: $candidate" >&2
    return 1
  fi
}

verify_app "$app"
# Tauri deliberately leaves development DMGs unsigned for identity '-'. If a
# signature is present, verify it even when unsigned development DMGs are allowed.
if [[ "$allow_unsigned_dmg" -eq 0 ]] || codesign --display "$dmg" >/dev/null 2>&1; then
  codesign --verify --strict --verbose=2 "$dmg"
fi

verify_root="$(mktemp -d "${TMPDIR:-/tmp}/qmux-release-verify.XXXXXX")"
mountpoint="$verify_root/dmg"
mounted=0
cleanup() {
  local status=$?
  if [[ "$mounted" -eq 1 ]]; then
    if ! hdiutil detach "$mountpoint" >/dev/null; then
      echo "Could not detach verification DMG at $mountpoint; leaving $verify_root intact." >&2
      exit 1
    fi
  fi
  rm -rf "$verify_root"
  exit "$status"
}
trap cleanup EXIT

if [[ -n "$archive" ]]; then
  mkdir "$verify_root/archive"
  tar -xzf "$archive" -C "$verify_root/archive"
  verify_packaged_app "$verify_root/archive/qmux.app"
fi

mkdir "$mountpoint"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mountpoint" >/dev/null
mounted=1
verify_packaged_app "$mountpoint/qmux.app"
