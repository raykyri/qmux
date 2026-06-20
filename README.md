# qmux

A queueing terminal multiplexer for coding agents.

qmux is an experimental Tauri terminal app for running shell panes and
Claude Code panes side-by-side. Rust owns the PTYs and control socket; React
renders the panes with xterm.js and adds native UI for launching Claude,
queueing follow-up turns, showing hook-driven agent status, and rendering
transcript-derived turns.

The current positioning is cmux-style PTY ownership and a scriptable control
plane, rebuilt with a web renderer so richer UI surfaces can sit beside the
terminal.

## Status

Implemented today:

- Shell panes backed by Rust-owned PTYs.
- Claude panes launched from the app launcher or by running `claude` inside a
  qmux shell pane.
- Hook settings generation and token-gated Unix socket ingestion via
  `qmux notify <event>`.
- Transcript JSONL tailing for native turn rendering.
- Native follow-up input with send, queue, steer, approve/deny, queued-turn
  editing, and transcript copy actions.
- Optional git worktree creation for launched Claude agents.
- Dirty-worktree checks before closing worktree-backed agent panes.
- Persisted pane, group, agent, transcript, and queued-turn metadata with
  best-effort restart recovery.

Still planned:

- Full workspace/group lifecycle commands.
- Session and workspace forking.
- Clip, markup, and share flows.
- Non-Claude adapters.
- Windows/Linux support. The current implementation targets macOS first.

## Quickstart

Prerequisites:

- macOS.
- Rust toolchain.
- Node.js and npm.
- Claude Code CLI available on `PATH` as `claude`.

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
```

Run a release build directly:

```sh
src-tauri/target/release/qmux
```

```sh
open src-tauri/target/release/bundle/macos/qmux.app
```

## Using The App

- `Cmd-T` / `Cmd-N`: open a shell pane.
- `Cmd-K`: open the Claude launcher.
- `Cmd-W`: close the active pane.
- In the launcher, enter a prompt and press `Cmd-Enter` to launch Claude.
- Enable `Worktree` in the launcher to create an isolated git worktree for the
  agent; leave it off to run Claude in place.
- In zsh/bash shell panes, the app injects a `claude` shell function that routes
  Claude through qmux so hooks, transcripts, and native follow-up input work.
- Agent input is queued while an agent is busy. Use `Steer` to inject a turn
  immediately instead of waiting for the agent to become idle.

## Repository Layout

- `src/`: React frontend.
- `src/components/`: terminal, native input, and turn overlay UI.
- `src/lib/api.ts`: Tauri command/event client helpers.
- `src-tauri/src/`: Rust backend modules.
- `qmux-spec.md`: high-level product and architecture spec.
- `launcher.md`, `worktrees.md`, `detach.md`: focused implementation notes.
- `qmux.config.json`: repo-local development config.

## Local Config

`qmux.config.json` keeps spawned qmux state inside this checkout:

```json
{
  "workspaceRoot": ".qmux/workspaces",
  "socketPath": ".qmux/run/qmux.sock",
  "claudeBinary": "claude"
}
```

Relative paths are resolved from the process working directory. If the config
file is absent, qmux falls back to `~/qmux/workspaces` for workspace state and a
temporary `qmux.sock` control socket.

## Runtime Model

- A pane is one Rust-owned PTY.
- Shell panes spawn `$SHELL`.
- Agent panes spawn `claude` either in the current repo/directory or in a
  qmux-created agent worktree.
- Each pane receives:
  - `QMUX_PANE_ID`
  - `QMUX_SOCK`
  - `QMUX_TOKEN`
  - `QMUX_WORKSPACE_ROOT`
- Agent panes also receive `QMUX_AGENT_ID`.
- Hooks call `qmux notify <event>` over the token-gated Unix socket.
- Transcript tailing starts after Claude emits a `SessionStart` hook with a
  transcript path.
- Persisted state is written under `<workspaceRoot>/.qmux/state.json`.

## Development

Build the frontend only:

```sh
npm run build:web
```

Check Rust formatting:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Check Rust compilation:

```sh
cargo check --manifest-path src-tauri/Cargo.toml
```

Run Rust tests:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```
