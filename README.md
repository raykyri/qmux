# qmux

A queueing terminal multiplexer.

qmux is a Tauri desktop app for running terminals and coding agents
side-by-side, using a Cursor-like sidebar for transcript rendering.
It includes a native UI for launching agents, queueing follow-ups,
tracking agent status, and driving TUI-based agents.

Agents are integrated through a pluggable **adapter** layer rather
than being hard-wired to one CLI. Today Claude Code and Codex ship as
adapters; new agents are added by implementing the adapter trait on
the Rust side and a matching UI adapter on the frontend.

## Status

Implemented today:

- Shell panes backed by Rust-owned PTYs.
- Agent panes for Claude Code and Codex, launched from the app launcher or by
  running `claude` / `codex` inside a qmux shell pane.
- Pluggable adapter registry (Rust) + UI adapters (React) so agents can define
  their own launch options, transcript parsing, and composer policy.
- Launcher with per-agent adapter and model selection, and optional git worktree
  isolation.
- Hook settings generation and token-gated Unix-socket ingestion via
  `qmux notify <event>`.
- Transcript JSONL tailing for native turn rendering.
- Native follow-up composer: send, queue, steer, approve/deny, queued-turn
  editing and reordering, per-agent drafts, and transcript copy actions.
- Optional git worktree creation for launched agents, with dirty-worktree checks
  (and soft branch deletion) before closing worktree-backed panes.
- Session/transcript recovery, including a picker to correct a wrong guess.
- Persisted pane, group, agent, transcript, and queued-turn metadata with
  best-effort restart recovery.
- App settings: terminal font and size, plus a macOS wake lock that keeps the
  machine awake while agents are running.

Still planned:

- Full workspace/group lifecycle commands.
- Session and workspace forking.
- Clip, markup, and share flows.
- More agent adapters.
- Windows/Linux support. The current implementation targets macOS first.

## Quickstart

Prerequisites:

- macOS.
- Rust toolchain.
- Node.js and npm.
- The agent CLIs you want to use on `PATH`: `claude` and/or `codex`.

Install dependencies:

```sh
npm install
```

Run the app in development:

```sh
npm run dev:tauri
```

Build the app:

```sh
npm run build

# Try the Finder-based DMG window layout:
QMUX_DMG_FINDER_LAYOUT=1 npm run build
```

Run a release build directly:

```sh
src-tauri/target/release/qmux
```

```sh
open src-tauri/target/release/bundle/macos/qmux.app
```

Development:

```sh
# Build the frontend only
npm run build:web

# Check Rust formatting
cargo fmt --manifest-path src-tauri/Cargo.toml --check

# Check Rust compilation
cargo check --manifest-path src-tauri/Cargo.toml

# Run Rust tests:
cargo test --manifest-path src-tauri/Cargo.toml
```

## Using The App

- `Cmd-T` / `Cmd-N`: open a shell pane.
- `Cmd-K`: open the agent launcher.
- `Cmd-W`: close the active pane.
- `Cmd-,`: open settings.
- In the launcher, enter a prompt, and press `Cmd-Enter` to launch.
- Enable `Worktree` to create an isolated git worktree for the agent.
- In zsh/bash shell panes, the app injects `claude` and `codex` shell functions
  to route the agent through qmux, so transcripts and native follow-ups work.
- Agent input is queued while an agent is busy. Use `Steer` to inject a turn
  immediately instead of waiting for the agent to become idle.

## Repository Layout

- `src/`: React frontend.
- `src/components/`: terminal, native input, launcher, and turn overlay UI.
- `src/adapters/`: per-agent UI adapters (Claude, Codex) and the shared interface.
- `src/lib/api.ts`: Tauri command/event client helpers.
- `src/lib/settings.ts`: persisted app settings (font, sleep behavior).
- `src-tauri/src/`: Rust backend modules.
- `src-tauri/src/adapters/`: per-agent backend adapters and the adapter registry.
- `qmux.config.json`: repo-local development config.

## Local Config

`qmux.config.json` keeps spawned qmux state inside this checkout:

```json
{
  "workspaceRoot": ".qmux/workspaces",
  "socketPath": ".qmux/run/qmux.sock",
  "adapters": {
    "claude": { "binary": "claude" },
    "codex": { "binary": "codex" }
  }
}
```

Relative paths are resolved from the process working directory. Each adapter's
`binary` is optional and defaults to the command name (`claude`, `codex`); a
top-level `claudeBinary` is still honored for backward compatibility. If the
config file is absent, qmux falls back to `~/qmux/workspaces` for workspace state
and a temporary `qmux.sock` control socket.

## Runtime Model

- A pane is one Rust-owned PTY.
- Shell panes spawn `$SHELL`.
- Agent panes spawn the adapter's agent binary, either in the current
  repo/directory or in a qmux-created agent worktree.
- Each pane receives:
  - `QMUX_PANE_ID`
  - `QMUX_SOCK`
  - `QMUX_TOKEN`
  - `QMUX_WORKSPACE_ROOT`
- Agent panes also receive `QMUX_AGENT_ID`.
- Hooks call `qmux notify <event>` over the token-gated Unix socket; qmux routes
  the notification to the owning agent's adapter.
- Transcript tailing starts once the agent reports a transcript path (for Claude,
  on its `SessionStart` hook).
- Persisted state is written under `<workspaceRoot>/.qmux/state.json`.
