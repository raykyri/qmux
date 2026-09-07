#!/usr/bin/env bash
# Verify that src-tauri/vendor/wry matches the recorded patch.
#
# Usage:
#   scripts/verify-vendor-wry.sh           # verify (exit 0 = match)
#   scripts/verify-vendor-wry.sh --update  # overwrite vendor/wry.patch
#
# The script fetches the upstream wry commit declared in
# src-tauri/vendor/VENDOR-WRY.md, diffs the source files against the
# vendored copy, and compares the result to vendor/wry.patch.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null 2>&1 && pwd)"
vendor_dir="$repo_root/src-tauri/vendor/wry"
patch_file="$repo_root/src-tauri/vendor/wry.patch"

# Upstream base commit — keep in sync with VENDOR-WRY.md.
UPSTREAM_REPO="https://github.com/tauri-apps/wry"
UPSTREAM_COMMIT="a5bf203a1c8dbb3583588382538d6521655222a8"

# Source files that are intentionally modified relative to upstream.
MODIFIED_FILES=(
  "src/wkwebview/class/url_scheme_handler.rs"
  "src/wkwebview/class/wry_web_view_parent.rs"
  "src/wkwebview/class/wry_web_view_ui_delegate.rs"
  "src/wkwebview/download.rs"
  "src/wkwebview/drag_drop.rs"
  "src/wkwebview/mod.rs"
  "src/wkwebview/synthetic_mouse_events.rs"
)

mode="verify"
if [[ "${1:-}" == "--update" ]]; then
  mode="update"
fi

# Fetch upstream into a temp directory.
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "Fetching wry @ $UPSTREAM_COMMIT …"
git clone --quiet --depth 1 "$UPSTREAM_REPO" "$tmp_dir/upstream" 2>/dev/null
git -C "$tmp_dir/upstream" fetch --quiet --depth 1 origin "$UPSTREAM_COMMIT" 2>/dev/null
git -C "$tmp_dir/upstream" checkout --quiet "$UPSTREAM_COMMIT" 2>/dev/null

is_expected_modified() {
  local candidate="$1"
  local expected
  for expected in "${MODIFIED_FILES[@]}"; do
    [[ "$candidate" == "$expected" ]] && return 0
  done
  return 1
}

unexpected_source_change=false
while IFS= read -r -d '' upstream_file; do
  relative="${upstream_file#"$tmp_dir/upstream/"}"
  if ! cmp -s "$upstream_file" "$vendor_dir/$relative" && ! is_expected_modified "$relative"; then
    echo "FAIL: unexpected vendored source change: $relative" >&2
    unexpected_source_change=true
  fi
done < <(find "$tmp_dir/upstream/src" \( -type f -o -type l \) -print0)
while IFS= read -r -d '' vendor_file; do
  relative="${vendor_file#"$vendor_dir/"}"
  if [[ ! -e "$tmp_dir/upstream/$relative" ]] && ! is_expected_modified "$relative"; then
    echo "FAIL: unexpected vendored source file: $relative" >&2
    unexpected_source_change=true
  fi
done < <(find "$vendor_dir/src" \( -type f -o -type l \) -print0)
if [[ "$unexpected_source_change" == true ]]; then
  echo "Add intentional source changes to MODIFIED_FILES and regenerate the patch." >&2
  exit 1
fi

# Generate the current diff (normalized labels, no timestamps).
current_patch="$tmp_dir/current.patch"
for f in "${MODIFIED_FILES[@]}"; do
  diff -u \
    --label "a/$f" \
    --label "b/$f" \
    "$tmp_dir/upstream/$f" \
    "$vendor_dir/$f" >> "$current_patch" 2>/dev/null || true
done

if [[ "$mode" == "update" ]]; then
  cp "$current_patch" "$patch_file"
  echo "Updated $patch_file ($(wc -l < "$patch_file") lines)."
  exit 0
fi

# Compare.
if diff -q "$current_patch" "$patch_file" >/dev/null 2>&1; then
  echo "OK: vendor/wry matches recorded patch ($(wc -l < "$patch_file") lines)."
  exit 0
else
  echo "FAIL: vendor/wry does NOT match recorded patch." >&2
  echo "Unexpected diff:" >&2
  diff -u "$patch_file" "$current_patch" >&2 || true
  echo "" >&2
  echo "If the changes are intentional, re-run with --update and commit the new patch." >&2
  exit 1
fi
