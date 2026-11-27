# Building and running qmux on an airspace desktop

This runbook builds a Linux debug build of qmux on an airspace box, opens a
session in it, and drives that session with qmux's own CLI. qmux ships for
macOS only, so this is a development and smoke-test path, not a supported
platform.

## What the box provides

Tested 2026-11-27:

- Ubuntu 24.04 x86_64, 2 vCPU, 4 GB RAM, about 10 GB free disk.
- Runs as `user`, with no `sudo` and no root.
- Xvfb display `:0` with an XFCE session. `xdotool` and `agent-desktop` are
  installed.
- `git`, `gcc`, `make`, `python3`, Node 22 and npm are installed.
- The GTK/WebKitGTK 4.1 runtime libraries are installed, but there are no
  `-dev` headers and no `pkg-config`.
- Each `run` call has a hard 60-second limit on the MCP side, even when
  `timeout_seconds` is higher. Start long steps with `nohup ... &` and poll
  them with `sleep 50`.

## 1. Start the box

Call `create_box`, then `get_vnc` so you can watch it. The box stops after
10 idle minutes.

## 2. Install the toolchain without root

`scripts/airspace/setup-box.sh` does the following:

- Runs `apt-get update` against a user-local state directory (`~/apt`).
- Lists the missing build packages with `apt-get -s install`.
- Runs `apt-get download` and `dpkg -x` to unpack those packages into
  `~/sysroot`. In the test this was 120 packages.
- Points dangling `.so` symlinks at the system libraries and rewrites the
  `.pc` prefixes.
- Installs Rust stable with rustup.
- Installs `@anthropic-ai/claude-code` and `@openai/codex` into
  `~/.npm-global`.
- Writes `~/qmux-env.sh`, which sets `PATH`, `PKG_CONFIG*`,
  `LD_LIBRARY_PATH`, `LIBRARY_PATH` and `RUSTFLAGS` for the later steps.

The box can't clone this branch's working copy, so send the script over as
base64. The encoded script is about 3.7 KB, inside the 10,000-character
command limit:

```bash
base64 -w0 scripts/airspace/setup-box.sh   # run locally, paste into the next command
```

On the box:

```bash
echo '<base64>' | base64 -d > ~/setup-box.sh && chmod +x ~/setup-box.sh
nohup ~/setup-box.sh > ~/setup.log 2>&1 &
cd ~ && nohup sh -c 'git clone --depth 1 https://github.com/raykyri/qmux.git && cd qmux && npm ci' > ~/clone.log 2>&1 &
```

Poll `~/setup.log` until it shows `== setup done`. This took about 3 minutes.
In the test run it reported WebKitGTK 2.52.6, GTK 3.24.41, libsoup 3.4.4,
cargo 1.100.1, Claude Code 2.1.332 and codex-cli 0.172.0.

The repository is public, so the clone needs no credentials. The
`vendor/libghostty-spm` submodule is only used on macOS, so skip it.

## 3. Build qmux

```bash
cat > ~/build.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source ~/qmux-env.sh
cd ~/qmux
export CARGO_BUILD_JOBS=2
npx tauri build --debug --no-bundle
ls -la src-tauri/target/debug/qmux
EOF
chmod +x ~/build.sh && nohup ~/build.sh > ~/build.log 2>&1 &
```

This builds the frontend (`tsc && vite build`) and then about 400 crates. The
macOS-only code is behind `cfg` gates and the Swift build step skips itself on
Linux, so no source changes are needed. The build took about 5 minutes and
produced `src-tauri/target/debug/qmux` (about 480 MB, unstripped debug
binary). Don't build with `npm run build`: `scripts/build.sh` refuses any
target except `aarch64-apple-darwin`.

## 4. Launch qmux and open a session

```bash
source ~/qmux-env.sh; export DISPLAY=:0
cd ~/qmux && nohup src-tauri/target/debug/qmux > ~/qmux-app.log 2>&1 &
```

The window opens maximized. Ignore the libEGL "DRI3" warnings, which come
from Xvfb. On a 1280x800 screen, the **New shell** button is near (62, 773):

```bash
DISPLAY=:0 xdotool search --name '^qmux$' windowactivate; DISPLAY=:0 xdotool mousemove 62 773 click 1
```

This adds a "Shell" row in the sidebar and starts
`/bin/bash --rcfile /tmp/qmux-shell-init/pane-*/bashrc -i` as a child of
qmux. The terminal area stays blank because terminals are drawn by the native
Ghostty view, which exists only on macOS (`nativeTerminalAvailable: IS_MAC`).
The PTY session still runs, so drive it through qmux's CLI.

## 5. Drive the session with the qmux CLI

The app binary doubles as the `qmux` CLI. It needs the pane's `QMUX_SOCK` and
tokens, which you can take from the shell's environment:

```bash
P=$(pgrep -f 'qmux-shell-init/pane' | head -1)
tr '\0' '\n' < /proc/$P/environ | grep -E '^QMUX_' > ~/pane.env
set -a; source ~/pane.env; set +a
Q=~/qmux/src-tauri/target/debug/qmux
$Q pane list
```

This was verified: `pane list` returned the running shell pane
(`"kind":"shell","status":"running"`) over `~/.qmux/run/qmux.sock`.

## 6. Start the Claude and Codex CLIs (not yet verified)

The box was stopped before this step ran. Next time, try the following. The
commands come from `public_cli.rs`:

```bash
source ~/qmux-env.sh; set -a; source ~/pane.env; set +a
PANE=$QMUX_PANE_ID
$Q pane run "$PANE" 'claude --version; codex --version'
$Q pane read "$PANE"

$Q agent start --adapter claude --cwd ~/qmux
$Q agent start --adapter codex --cwd ~/qmux
$Q agent list
pgrep -a -f 'claude|codex'
```

Neither CLI is signed in on a fresh box, so each one starts on its login
screen. That is enough to show that qmux launched the process under its PTY.
Getting a model response requires signing in (`claude auth login`,
`codex login`) or setting an API key. Ask the owner before signing in.

## 7. Shut down

Call `stop_box`. This deletes everything in the box, including the
`~/sysroot` and cargo caches, so the next run repeats steps 2 and 3.
