# qmux

qmux is a desktop app for running terminals and coding agents
side-by-side, with vertical tabs and a Cursor-like sidebar for
transcript rendering.

<img src="qmux.png" alt="qmux screenshot" width="700" style="max-width: 100%; height: auto;">

It includes native UI for launching agents, queueing follow-ups,
tracking agent status, and driving TUI-based agents.

Agents are integrated through a pluggable adapter layer. Claude Code,
Codex, and OpenCode (limited support) are included as adapters, but
new agents can be added by implementing the adapter trait in Rust and
adding a matching UI adapter on the frontend.

## Features

- Shell panes backed by Rust-owned PTYs in Tauri.
- Agent panes for Claude Code, Codex, and OpenCode, launched from the app
  or by running `claude` / `codex` / `opencode` inside a shell pane.
- Transcript JSONL tailing and a native follow-up composer: send, queue,
  steer, edit/reorder queued turns, and approve/deny permission prompts where
  supported.
- Session/transcript recovery. Respawns recoverable panes and agents on
  restart, along with drafts that you've typed in qmux.
- Persisted pane, group, agent, transcript, and queued-turn metadata with
  best-effort restart recovery.
- Session forking from inside a running Claude or Codex session.
- App settings: terminal font and size, macOS wake lock that keeps the
  machine awake while agents are running (skipped on battery below 10%).
- (Experimental) git worktree creation for launched agents, with dirty
  worktree checks and a delete-or-keep prompt when closing worktree-backed panes.
- (Experimental) Local Whisper-backed dictation in the launcher and
  follow-up composer, with the model cached after first use.
- (Experimental) A tab-bound, resizable browser that renders a local file or a
  `http://localhost` dev server in a panel over the terminal.
- macOS-only at this time. Linux support is planned for the future.

## Quickstart

Prerequisites:

- macOS.
- Rust toolchain.
- Node.js and npm.
- The agent CLIs you want to use on `PATH`: `claude`, `codex`, and/or `opencode`.

Install dependencies:

```
npm install
```

Run the app in development:

```
npm run dev:tauri
```

Build the app:

```
npm run build

# Try the Finder-based DMG window layout:
QMUX_DMG_FINDER_LAYOUT=1 npm run build
```

Run a release build directly:

```
src-tauri/target/release/qmux
```

```
open src-tauri/target/release/bundle/macos/qmux.app
```

Development:

```
# Build the frontend only
npm run build:web

# Check Rust formatting
cargo fmt --manifest-path src-tauri/Cargo.toml --check

# Check Rust compilation
cargo check --manifest-path src-tauri/Cargo.toml

# Run Rust tests:
cargo test --manifest-path src-tauri/Cargo.toml
```

## Using the App

- `Cmd-T`: open a shell pane in code mode; outside code mode, open the agent
  launcher.
- `Cmd-N`: focus Home.
- `Cmd-;` / `Ctrl-;`: open the agent launcher.
- `Cmd-=` / `Cmd-+`: increase terminal font size.
- `Cmd--`: decrease terminal font size.
- `Cmd-0`: reset terminal font size.
- `Cmd-1`..`Cmd-9` / `Ctrl-1`..`Ctrl-9`: focus the corresponding pane tab.
- Hold `Cmd`: show floating shortcut hints for Home and pane tabs in the `Cmd-1`..
  `Cmd-9` range.
- `Ctrl-Tab` / `Ctrl-Shift-Tab`: cycle through Home and open tabs.
- `Cmd-Shift-[` / `Cmd-Shift-]`: cycle through Home and open tabs.
- `Cmd-Shift-T`: restore the most recently closed pane.
- `Cmd-Shift-H`: focus Home.
- `Cmd-Shift-E` / `Ctrl-Shift-E`: expand or restore the active transcript pane,
  or toggle the browser overlay on shell-only panes.
- `Cmd-W`: close the active pane.
- `Ctrl-W`: close the active pane unless focus is in a terminal or text field.
- `Cmd-,` / `Ctrl-,`: open settings.
- In the launcher, enter a prompt, and press `Cmd-Enter` to launch by default
  (`Enter` launches when "Require Cmd-Enter to send" is off).

## How it Works

- A pane is one Rust-owned PTY.
- Shell panes spawn `$SHELL`.
- Agent panes spawn the adapter's configured agent binary, either in the current
  repo/directory or in a qmux-created agent worktree. Shell functions can route
  `claude`, `codex`, and `opencode` through qmux from shell panes, but the adapter
  binary still needs to be installed or configured.
- Each pane receives:
  - `QMUX_PANE_ID`
  - `QMUX_SOCK`
  - `QMUX_TOKEN`
  - `QMUX_WORKSPACE_ROOT`
- `QMUX_CLI` is also set when the app can resolve the qmux executable, for
  in-pane tooling.
- Agent panes also receive `QMUX_AGENT_ID`.
- Hooks call `qmux notify <event>` over the token-gated Unix socket; qmux routes
  the notification to the owning agent's adapter. The same socket, scoped to the
  caller's pane, serves other in-pane commands (`qmux open`, `qmux fork`).
- A loopback-only (`127.0.0.1`) HTTP server with per-pane random tokens backs
  browser-overlay file targets. It serves only files under the workspace root, the
  requesting pane's group directory, and the requesting pane's own cwd/worktree. The
  frontend only ever sees fully-formed `http://127.0.0.1/...` URLs.
- Transcript tailing starts once an adapter binds a transcript path: Claude via
  `SessionStart`, Codex via an explicit `SessionStart` path or session-id lookup,
  and OpenCode via qmux-managed JSONL.
- Persisted state is written under `<workspaceRoot>/.qmux/state.json`.
- `qmux.config.json` keeps spawned qmux state inside this checkout:

```json
{
  "workspaceRoot": ".qmux/workspaces",
  "socketPath": ".qmux/run/qmux.sock",
  "adapters": {
    "claude": { "binary": "claude" },
    "codex": { "binary": "codex" },
    "opencode": { "binary": "opencode" }
  }
}
```

Relative paths are resolved from the process working directory when that
directory is under `$HOME`; otherwise they fall back to the platform data/runtime
locations. Each adapter's `binary` is optional and defaults to the command name
(`claude`, `codex`, `opencode`); a top-level `claudeBinary` is still honored for
backward compatibility. If the config file is absent, qmux uses the platform data
directory for workspace state and the platform runtime directory, or a `run/`
subdirectory of the data directory, for the control socket.
