#!/usr/bin/env bash
set -euo pipefail

# Generates the latest.json update manifest the updater plugin polls at
# https://github.com/raykyri/qmux/releases/latest/download/latest.json.
# Run after scripts/build.sh, then upload latest.json AND the .app.tar.gz +
# .sig to the GitHub release alongside the DMG.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd)"
target="${QMUX_BUILD_TARGET:-universal-apple-darwin}"
bundle_dir="$repo_root/src-tauri/target/$target/release/bundle/macos"

version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$repo_root/src-tauri/tauri.conf.json" | head -1)"
archive="$bundle_dir/qmux.app.tar.gz"
signature_file="$archive.sig"

for file in "$archive" "$signature_file"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing $file — run scripts/build.sh first." >&2
    exit 1
  fi
done

signature="$(cat "$signature_file")"
url="https://github.com/raykyri/qmux/releases/download/v$version/qmux.app.tar.gz"
pub_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The updater requests the darwin-<arch> key for the arch the process runs as;
# a universal archive serves both, so list it under both keys.
cat >"$bundle_dir/latest.json" <<EOF
{
  "version": "$version",
  "pub_date": "$pub_date",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$signature",
      "url": "$url"
    },
    "darwin-x86_64": {
      "signature": "$signature",
      "url": "$url"
    }
  }
}
EOF

echo "Wrote $bundle_dir/latest.json"
echo "Upload these to the v$version GitHub release:"
echo "  $archive (as qmux.app.tar.gz)"
echo "  $bundle_dir/latest.json"
