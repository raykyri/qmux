#!/usr/bin/env bash
# Rootless setup for building qmux on an airspace box (Ubuntu 24.04 x86_64,
# no sudo). Installs the GTK/WebKit development packages into ~/sysroot,
# Rust via rustup, and the Claude Code and Codex CLIs into ~/.npm-global.
# Writes ~/qmux-env.sh, which later steps source.
set -euo pipefail

SYSROOT="$HOME/sysroot"
APT_DIR="$HOME/apt"
APTOPT=(
  -o "Dir::State::Lists=$APT_DIR/lists"
  -o "Dir::Cache=$APT_DIR/cache"
  -o "Debug::NoLocking=1"
  -o "APT::Sandbox::User=$(whoami)"
)

mkdir -p "$APT_DIR/lists/partial" "$APT_DIR/cache/archives/partial" "$APT_DIR/debs" "$SYSROOT"

echo "== apt metadata (user-local)"
apt-get "${APTOPT[@]}" update >/dev/null 2>&1 || true

echo "== resolve missing build packages"
apt-get "${APTOPT[@]}" -s install \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  librsvg2-dev libxdo-dev libayatana-appindicator3-dev pkg-config 2>/dev/null \
  | awk '/^Inst /{print $2}' >"$APT_DIR/pkgs.txt"
echo "$(wc -l <"$APT_DIR/pkgs.txt") packages"

echo "== download and extract into $SYSROOT"
(cd "$APT_DIR/debs" && xargs -a "$APT_DIR/pkgs.txt" apt-get "${APTOPT[@]}" download >/dev/null 2>&1)
for deb in "$APT_DIR"/debs/*.deb; do dpkg -x "$deb" "$SYSROOT"; done

LIBDIR="$SYSROOT/usr/lib/x86_64-linux-gnu"

echo "== repoint dangling .so symlinks at system libraries"
find "$SYSROOT" -xtype l | while read -r link; do
  target="$(readlink "$link")"
  base="$(basename "$target")"
  for dir in /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu "$LIBDIR"; do
    if [[ -e "$dir/$base" ]]; then ln -sf "$dir/$base" "$link"; break; fi
  done
done

echo "== rewrite pkg-config prefixes"
find "$SYSROOT" -name '*.pc' | while read -r pc; do
  sed -i -E "s#(=|-I|-L| )/usr(/|\$| )#\1$SYSROOT/usr\2#g" "$pc"
done

cat >"$HOME/qmux-env.sh" <<EOF
export SYSROOT="$SYSROOT"
export PATH="\$HOME/.cargo/bin:\$HOME/.npm-global/bin:\$SYSROOT/usr/bin:\$PATH"
export PKG_CONFIG="\$SYSROOT/usr/bin/pkgconf"
export PKG_CONFIG_PATH="$LIBDIR/pkgconfig:\$SYSROOT/usr/share/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig"
export LD_LIBRARY_PATH="$LIBDIR\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export LIBRARY_PATH="$LIBDIR"
export C_INCLUDE_PATH="\$SYSROOT/usr/include"
export RUSTFLAGS="-C link-arg=-Wl,-rpath-link,$LIBDIR -C link-arg=-L$LIBDIR"
export NPM_CONFIG_PREFIX="\$HOME/.npm-global"
EOF
# shellcheck disable=SC1091
source "$HOME/qmux-env.sh"
"$PKG_CONFIG" --modversion webkit2gtk-4.1 gtk+-3.0 libsoup-3.0

echo "== rust"
if ! command -v cargo >/dev/null; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
fi
cargo --version

echo "== agent CLIs"
npm install -g @anthropic-ai/claude-code @openai/codex >/dev/null
claude --version
codex --version
echo "== setup done"
