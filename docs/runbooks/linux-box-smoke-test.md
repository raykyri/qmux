# Runbook: Linux desktop smoke test on an airspace box

This runbook builds qmux on a throwaway Linux desktop, starts a session, and
checks that the Claude Code and Codex CLIs launch inside qmux panes. It uses
the airspace connector (`create_box`, `run`, `screenshot`, `stop_box`), but any
rootless Ubuntu 24.04 x86_64 desktop with an X display works the same way.

qmux ships for macOS only. The Linux build exists because `build.rs` skips the
Swift/Ghostty bridge on non-macOS targets and the backend falls back to the
portable PTY. Treat this as a smoke test of that path, not a supported target.

Last run: 2026-11-27, qmux 0.5.1 (`c9ec970`), Rust 1.100.1, Node 22.23.5,
Claude Code 2.1.332, Codex CLI 0.172.0. Total time was about 20 minutes, of
which about 4 minutes was the debug build.

## Box facts that shape the steps

- 2 vCPU, 4 GB RAM, 14 GB disk, Ubuntu 24.04, user `user`, **no sudo**.
- Display `:0` at 1280x800; screenshots come back scaled to 768x480
  (multiply screenshot coordinates by 5/3 for `xdotool`).
- Present: git, gcc, make, curl, Node 22 + npm, xdotool, the GTK 3 and
  WebKitGTK 4.1 *runtime* libraries. `/usr/local` is world-writable, so
  `npm install -g` works.
- Missing: pkg-config and every `-dev` package. `scripts/linux-box/setup.sh`
  works around this with a private apt index and a sysroot (see the script
  header).
- Through the MCP client, a `run` call times out after about 60 s whatever
  `timeout_seconds` says. Start long jobs with `nohup ... &`, write logs to
  `~/logs`, and poll with `sleep 45; tail` calls.
- The box stops after 10 idle minutes. Keep polling during long builds.
- `agent-desktop` cannot read the WebKitGTK accessibility tree (its `find`
  times out), so drive the qmux window with `xdotool` and screenshots.

## 1. Start the box

1. `create_box`, then note the box id.
2. `get_vnc` so the user can watch.
3. Check the environment:

   ```bash
   whoami; grep VERSION_ID /etc/os-release; nproc; free -g; node -v; echo $DISPLAY
   ```

## 2. Clone and set up

```bash
mkdir -p ~/logs
git clone --depth 50 https://github.com/raykyri/qmux ~/qmux
# To test a branch: git -C ~/qmux fetch origin <branch> && git -C ~/qmux checkout FETCH_HEAD
(nohup ~/qmux/scripts/linux-box/setup.sh > ~/logs/setup.log 2>&1; echo "EXIT $?" >> ~/logs/setup.log) >/dev/null 2>&1 &
```

Poll `tail -5 ~/logs/setup.log` until it prints `EXIT 0`. The run takes 3 to 4
minutes on a fresh box: an apt index refresh (~35 s), about 107 `.deb`
downloads (~30 MB), rustup, `npm ci`, and a global install of
`@anthropic-ai/claude-code` and `@openai/codex`. The script is idempotent; it
skips the sysroot and rustup steps when they already exist.

The submodule `vendor/libghostty-spm` is only needed on macOS; do not
initialize it.

## 3. Build

```bash
cd ~/qmux && . ~/qmux-env.sh && (nohup npx tauri build --debug --no-bundle > ~/logs/build.log 2>&1; echo "EXIT $?" >> ~/logs/build.log) >/dev/null 2>&1 &
```

Poll with:

```bash
grep -nE "^error|EXIT|Built application" ~/logs/build.log; tail -2 ~/logs/build.log
```

`tauri build` runs `npm run build:site:frontend` first, then a cargo debug
build with the frontend embedded. Expect about 4 minutes and
`Built application at: /home/user/qmux/src-tauri/target/debug/qmux`. Warnings
about unused imports in `main.rs` and deprecated `run_javascript` in wry are
normal on Linux.

Use a debug build. A release build adds thin LTO, which takes much longer on
2 vCPUs and is not needed here. `--no-bundle` skips the `.app`/`.dmg` targets
in `tauri.conf.json`, which cannot be produced on Linux.

## 4. Launch qmux

```bash
(DISPLAY=:0 nohup ~/qmux/src-tauri/target/debug/qmux > ~/logs/qmux.log 2>&1 &); sleep 12; pgrep -a qmux; tail ~/logs/qmux.log
```

`libEGL warning: DRI3 error` lines in the log are harmless. Take a
`screenshot`: the window shows the Terminal/Research toggle at the top of the
sidebar and **New shell** / **New agent** at the bottom.

## 5. Start a session and launch the agents

Coordinates are screen pixels for the default maximized window at 1280x800.
Take a screenshot after each click if anything looks different.

| Action | Screenshot (768x480) | `xdotool` (1280x800) |
| --- | --- | --- |
| **New agent** button | 103, 464 | 172, 773 |
| Agent picker (shows "Claude") | 516, 283 | 860, 472 |
| "Codex" item in the picker | 522, 115 | 870, 192 |
| Launch button (⌘↩) | 564, 283 | 940, 472 |

Claude (the default agent):

```bash
export DISPLAY=:0; xdotool mousemove 172 773 click 1; sleep 1.5; xdotool mousemove 940 472 click 1; sleep 6
ps -eo pid,ppid,etime,args | grep -E "claude|codex" | grep -v grep | cut -c1-160
```

Codex:

```bash
export DISPLAY=:0; xdotool mousemove 172 773 click 1; sleep 1.5
xdotool mousemove 860 472 click 1; sleep 1; xdotool mousemove 870 192 click 1; sleep 1
xdotool mousemove 940 472 click 1; sleep 10
```

Leaving the prompt empty launches the agent without sending anything, which
keeps the test free of sign-ins. The agent picker labels Claude and Codex
"Sign in" when their binaries are on `PATH`, and labels the other adapters
"Not installed". That confirms qmux's agent detection.

## 6. Verify

Linux has no terminal renderer yet, so the pane area stays blank on screen.
Verify through the process tree and the pane scrollback that qmux persists:

```bash
ps -eo pid,ppid,etime,stat,args | grep -E "claude|codex" | grep -v grep | cut -c1-160
ls -t ~/.local/share/qmux/workspaces/.qmux/terminal/
~/qmux/scripts/linux-box/pane-text.sh <pane-id>   # or no argument for the newest pane
```

Pass criteria:

- `claude` runs with qmux as its parent, with
  `--settings ~/.local/share/qmux/workspaces/.qmux/hooks/pane-*.json --plugin-dir ...`,
  and its pane text contains `Welcome to Claude Code v<version>` and the
  first-run theme picker ("Let's get started").
- `codex` runs with qmux as its parent, with `--profile qmux-codex` and qmux's
  `developer_instructions`, and its pane text contains
  `OpenAI Codex (v<version>)` and "Welcome to Codex" with the sign-in choices.
- The sidebar lists a `Claude` pane and a `Codex` pane under the `user` group.

Words run together in `pane-text.sh` output because TUIs position text with
cursor moves rather than spaces. That is expected.

Going further (sending a prompt, transcripts, the follow-up composer) needs
the CLIs to be signed in. Ask the user before signing in to anything on the
box.

## 7. Shut down

`stop_box` with the box id. Everything on the box is lost, so copy out any
logs you want first (for example, `cat` them through `run`). `list_boxes`
should no longer show it.

## Known Linux gaps seen in this run

- Terminal panes draw nothing: `nativeTerminalAvailable` is `IS_MAC`, and the
  only terminal renderer is the macOS Ghostty surface.
- The window is created with `"transparent": true`, so the sidebar shows the
  desktop (or whichever window is behind it) through it.
- In the agent picker, status labels ("Not installed") overlap the agent names.
- Keyboard hints use macOS glyphs (⌘↩) on Linux.
