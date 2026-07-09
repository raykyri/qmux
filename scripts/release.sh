#!/usr/bin/env bash
set -euo pipefail

# Builds, signs, and notarizes the universal DMG, then uploads a draft GitHub
# release with everything the updater endpoint needs. Publish the draft by hand
# after checking the notes and installing the DMG once.
#
# Required environment:
#   APPLE_SIGNING_IDENTITY   Developer ID Application identity (auto-detected
#                            from the keychain when exactly one is present)
#   APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY +
#   APPLE_API_ISSUER + APPLE_API_KEY_PATH, for notarization.
#   Set QMUX_ALLOW_UNNOTARIZED=1 to build a release without notarizing
#   (downloads will hit Gatekeeper).

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null && pwd)"
cd "$repo_root"

# Signing/notarization credentials live in .env (gitignored), as plain
# KEY=VALUE lines. Variables already set in the environment win, so a one-off
# override doesn't require editing the file.
if [[ -f .env ]]; then
  # `|| [[ -n "$line" ]]` keeps a final line that lacks a trailing newline.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    name="${line%%=*}"
    value="${line#*=}"
    # Strip one layer of matching quotes so KEY="a b" exports as a b.
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    [[ -n "${!name:-}" ]] || export "$name=$value"
  done <.env
fi

read_version() {
  sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$1" | head -1
}

version="$(read_version src-tauri/tauri.conf.json)"
npm_version="$(read_version package.json)"
cargo_version="$(sed -n 's/^version = "\([^"]*\)"/\1/p' src-tauri/Cargo.toml | head -1)"

# The updater manifest, DMG filename, and Info.plist each read a different one
# of these files, so a release with drifted versions half-works at best.
if [[ "$version" != "$npm_version" || "$version" != "$cargo_version" ]]; then
  echo "Version mismatch: tauri.conf.json=$version package.json=$npm_version Cargo.toml=$cargo_version" >&2
  exit 1
fi

tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists — bump the version first." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty — commit or stash before releasing." >&2
  exit 1
fi

# Releases are cut from pushed history so the tag gh creates matches what
# people can clone.
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  echo "HEAD is not on origin/main — push first." >&2
  exit 1
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  identities="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p')"
  if [[ "$(printf '%s\n' "$identities" | grep -c .)" -ne 1 ]]; then
    echo "Set APPLE_SIGNING_IDENTITY (found identities: ${identities:-none})." >&2
    exit 1
  fi
  export APPLE_SIGNING_IDENTITY="$identities"
  echo "Signing as: $APPLE_SIGNING_IDENTITY"
fi

have_notary_creds() {
  [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] ||
    [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" ]]
}

if ! have_notary_creds && [[ "${QMUX_ALLOW_UNNOTARIZED:-}" != "1" ]]; then
  echo "No notarization credentials (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID or" >&2
  echo "APPLE_API_KEY/APPLE_API_ISSUER). Set them, or QMUX_ALLOW_UNNOTARIZED=1" >&2
  echo "to knowingly ship a build Gatekeeper will block." >&2
  exit 1
fi

npm run test:pane-splits
npm run check:scrollback
cargo test --manifest-path src-tauri/Cargo.toml

"$script_dir/build.sh"
"$script_dir/generate-latest-json.sh"

target="${QMUX_BUILD_TARGET:-universal-apple-darwin}"
bundle_root="src-tauri/target/$target/release/bundle"
dmg="$bundle_root/dmg/qmux_${version}_universal.dmg"
archive="$bundle_root/macos/qmux.app.tar.gz"
signature="$archive.sig"
manifest="$bundle_root/macos/latest.json"

for file in "$dmg" "$archive" "$signature" "$manifest"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing release artifact: $file" >&2
    exit 1
  fi
done

checksums="$bundle_root/SHA256SUMS"
(cd "$(dirname "$dmg")" && shasum -a 256 "$(basename "$dmg")") >"$checksums"
(cd "$(dirname "$archive")" && shasum -a 256 "$(basename "$archive")") >>"$checksums"

gh release create "$tag" \
  --draft \
  --title "qmux $tag" \
  --generate-notes \
  --target "$(git rev-parse HEAD)" \
  "$dmg" "$archive" "$signature" "$manifest" "$checksums"

echo
echo "Draft release $tag created. Install the DMG once to smoke-test, then publish:"
echo "  gh release edit $tag --draft=false"
