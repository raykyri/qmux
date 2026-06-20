#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd)"
bundle_root="$repo_root/src-tauri/target/release/bundle"

if [[ ! -d "$bundle_root" ]]; then
  exit 0
fi

detach_image_if_mounted() {
  local image="$1"
  local mount_points

  mount_points="$(
    hdiutil info | awk -v image="$image" '
      /^image-path[[:space:]]*:/ {
        current = substr($0, index($0, ":") + 2)
        matched = (current == image)
      }
      matched && /^\/dev\/disk/ && NF >= 3 {
        mount_point = $0
        sub(/^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+/, "", mount_point)
        if (mount_point ~ /^\//) {
          print mount_point
        }
      }
    '
  )"

  if [[ -z "$mount_points" ]]; then
    return 0
  fi

  while IFS= read -r mount_point; do
    [[ -z "$mount_point" ]] && continue
    echo "Detaching stale Tauri DMG mount: $mount_point"
    hdiutil detach "$mount_point" >/dev/null 2>&1 ||
      hdiutil detach -force "$mount_point" >/dev/null
  done <<<"$mount_points"
}

while IFS= read -r -d '' image; do
  detach_image_if_mounted "$image"
  echo "Removing stale Tauri DMG temp image: $image"
  rm -f "$image"
done < <(find "$bundle_root" -type f -name 'rw.*.dmg' -print0)
