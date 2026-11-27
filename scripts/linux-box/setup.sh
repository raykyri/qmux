#!/usr/bin/env bash
# Prepares a rootless Ubuntu 24.04 x86_64 desktop box (for example an airspace
# box) to build and run a Linux debug build of qmux. See
# docs/runbooks/linux-box-smoke-test.md.
#
# The box has no sudo, so system -dev packages cannot be installed. Instead this
# script runs apt-get against a private state directory, downloads the GTK and
# WebKitGTK development packages that are not already installed, and unpacks
# them into ~/sysroot. A pkg-config wrapper in ~/sysroot-bin points the Rust
# -sys crates at that sysroot, and the dangling .so symlinks are repointed at
# the runtime libraries the box already has.
#
# Usage: scripts/linux-box/setup.sh [--no-agents]
#   --no-agents  skip `npm install -g` of the Claude Code and Codex CLIs
# Writes ~/qmux-env.sh; source it before building.
set -euo pipefail

install_agents=1
case "${1:-}" in
  "") ;;
  --no-agents) install_agents=0 ;;
  *) echo "Usage: $0 [--no-agents]" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." >/dev/null && pwd)"
sysroot="$HOME/sysroot"
apt_root="$HOME/apt"
multiarch="x86_64-linux-gnu"

if [[ "$(uname -m)" != "x86_64" ]] || ! grep -q 'VERSION_ID="24.04"' /etc/os-release; then
  echo "This script expects Ubuntu 24.04 on x86_64." >&2
  exit 1
fi

apt_opts=(
  -o "Dir::State=$apt_root/state"
  -o "Dir::Cache=$apt_root/cache"
  -o Debug::NoLocking=1
)

# Development packages for tauri/wry on Linux. apt resolves the rest.
roots=(
  pkg-config libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev
  libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev
  libssl-dev
)
# Runtime libraries and tools those -dev packages need that a stock box lacks.
# Everything else non -dev that the recursive dependency walk turns up is a
# virtual-package alternative (spelling dictionaries, fonts, qemu) and is
# skipped.
extras=(
  pkgconf pkgconf-bin libpkgconf3 libharfbuzz-cairo0 libharfbuzz-subset0
  libpcre2-16-0 libpcre2-32-0 libpcre2-posix3 libtiffxx6 libwebpdecoder3
  libgirepository-2.0-0 libgles1 wayland-protocols
)

if [[ ! -x "$sysroot/usr/bin/pkgconf" ]]; then
  echo "==> Refreshing a private apt index"
  mkdir -p "$apt_root/state/lists/partial" "$apt_root/cache/archives/partial" "$apt_root/debs"
  # apt-get prints a harmless permission error for /var/cache/apt; ignore it.
  apt-get "${apt_opts[@]}" update >/dev/null 2>&1 || true
  [[ -n "$(ls "$apt_root/state/lists" 2>/dev/null | grep -v -e partial -e lock)" ]] || {
    echo "apt-get update into $apt_root/state failed" >&2
    exit 1
  }

  echo "==> Resolving development packages"
  apt-cache "${apt_opts[@]}" depends --recurse --no-recommends --no-suggests \
    --no-conflicts --no-breaks --no-replaces --no-enhances "${roots[@]}" 2>/dev/null \
    | grep -E '^[a-z0-9]' | sort -u >"$apt_root/all.txt"
  : >"$apt_root/want.txt"
  while read -r pkg; do
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
      continue
    fi
    [[ "$pkg" == *-dev* ]] && echo "$pkg" >>"$apt_root/want.txt"
  done <"$apt_root/all.txt"
  for pkg in "${extras[@]}"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" \
      || echo "$pkg" >>"$apt_root/want.txt"
  done

  echo "==> Downloading $(wc -l <"$apt_root/want.txt") packages"
  (cd "$apt_root/debs" && apt-get "${apt_opts[@]}" download $(cat "$apt_root/want.txt") >/dev/null)

  echo "==> Unpacking into $sysroot"
  mkdir -p "$sysroot"
  for deb in "$apt_root"/debs/*.deb; do
    dpkg-deb -x "$deb" "$sysroot"
  done
fi

echo "==> Repointing dangling library symlinks at the system runtime libraries"
missing=0
while IFS= read -r link; do
  [[ -e "$link" ]] && continue
  target="$(basename "$(readlink "$link")")"
  for dir in "/usr/lib/$multiarch" "/lib/$multiarch"; do
    if [[ -e "$dir/$target" ]]; then
      ln -sf "$dir/$target" "$link"
      break
    fi
  done
  if [[ ! -e "$link" ]]; then
    echo "  unresolved: $link -> $target" >&2
    missing=$((missing + 1))
  fi
done < <(find "$sysroot/usr/lib" "$sysroot/lib" -type l 2>/dev/null)
if [[ "$missing" -gt 0 ]]; then
  echo "$missing library symlinks could not be resolved; linking may fail." >&2
fi

mkdir -p "$HOME/sysroot-bin"
cat >"$HOME/sysroot-bin/pkg-config" <<EOF
#!/bin/sh
S="$sysroot"
export LD_LIBRARY_PATH="\$S/usr/lib/$multiarch\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export PKG_CONFIG_SYSROOT_DIR="\$S"
export PKG_CONFIG_PATH="\$S/usr/lib/$multiarch/pkgconfig:\$S/usr/share/pkgconfig:\$S/usr/lib/pkgconfig\${PKG_CONFIG_PATH:+:\$PKG_CONFIG_PATH}"
exec "\$S/usr/bin/pkgconf" "\$@"
EOF
chmod +x "$HOME/sysroot-bin/pkg-config"
"$HOME/sysroot-bin/pkg-config" --exists webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 gtk+-3.0 \
  || { echo "pkg-config cannot resolve the WebKitGTK stack" >&2; exit 1; }

if [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  echo "==> Installing Rust (rustup, minimal profile)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
fi

cat >"$HOME/qmux-env.sh" <<EOF
export PATH="\$HOME/sysroot-bin:\$HOME/.cargo/bin:\$PATH"
export LIBRARY_PATH="$sysroot/usr/lib/$multiarch\${LIBRARY_PATH:+:\$LIBRARY_PATH}"
export CARGO_BUILD_JOBS=2
EOF

echo "==> npm ci"
(cd "$repo_root" && npm ci --no-audit --no-fund >/dev/null)

if [[ "$install_agents" -eq 1 ]]; then
  echo "==> Installing the Claude Code and Codex CLIs"
  npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex >/dev/null
  claude --version
  codex --version
fi

echo
echo "Done. Next:"
echo "  . ~/qmux-env.sh && cd $repo_root && npx tauri build --debug --no-bundle"
