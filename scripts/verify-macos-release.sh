#!/usr/bin/env bash
set -euo pipefail

# Verify the distribution artifacts before they are uploaded to a release.
if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 /path/to/qmux.app /path/to/qmux.dmg" >&2
  exit 2
fi

app="$1"
dmg="$2"
[[ -d "$app" && -f "$dmg" ]] || {
  echo "Release app or DMG is missing." >&2
  exit 1
}

lipo -verify_arch arm64 x86_64 "$app/Contents/MacOS/qmux"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --verify --strict --verbose=2 "$dmg"
# A valid ad-hoc signature alone is insufficient: require a notarization ticket
# and Gatekeeper acceptance of the Developer ID-signed application.
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"

for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
  cli="$app/Contents/Resources/remote-cli/$target/qmux-cli"
  if [[ ! -x "$cli" ]]; then
    echo "Bundled remote CLI is missing or not executable: $cli" >&2
    exit 1
  fi
done
