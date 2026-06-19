# qmux

qmux is an experimental Tauri terminal app for running shell panes and Claude Code panes side by
side. The backend owns the PTYs in Rust, while the frontend renders them with xterm.js and layers
native app UI for launching Claude tasks, submitting follow-up turns, showing hook status, and
rendering transcript-derived turns.

The project positioning is: cmux-style PTY ownership and control plane, reimplemented with a web
renderer for extensibility.

## Current Status

Implemented through the planned M0-M4 slice:

- M0: Tauri shell, React UI, xterm.js pane, Rust PTY spawn/read/write/resize/kill.
- M1: Token-gated Unix socket control path, `qmux` CLI subcommands, and Claude pane launching.
- M2: Workspace group and agent directory model with `.qmux/group.json` manifests.
- M3: Claude hook settings generation and `qmux notify` ingestion into live agent status events.
- M4: Claude transcript JSONL tailing, native turn rendering, and native follow-up input via
  bracketed paste.

Deferred:

- Session/workspace forking.
- Clip, markup, and share flows.
- Non-Claude adapters.
- Windows/Linux support. The current implementation targets macOS first.

## Repository Layout

- `src/`: React frontend.
- `src/components/`: terminal, native input, and turn overlay UI.
- `src/lib/api.ts`: Tauri command/event client helpers.
- `src-tauri/src/`: Rust backend modules.
- `qmux-spec.md`: high-level design spec.
- `conversation-transcript.md`: design conversation transcript.
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

Paths are resolved relative to the repo root when they are not absolute. If the config file is
absent, the Rust default falls back to `~/qmux/workspaces`, but this repo intentionally commits a
local override for development.

## Development

Prerequisites:

- macOS.
- Rust toolchain.
- Node.js and npm.
- Claude Code CLI available on `PATH` as `claude`.

Install dependencies:

```sh
npm install
```

Run the app:

```sh
npm run tauri:dev
```

Build the frontend:

```sh
npm run build
```

Check Rust formatting:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Check Rust compilation:

```sh
cargo check --manifest-path src-tauri/Cargo.toml
```

## Runtime Model

- A pane is one Rust-owned PTY.
- Shell panes spawn `$SHELL`.
- Claude panes spawn `claude` from `PATH`, in a prepared agent workspace directory.
- Claude panes receive:
  - `QMUX_PANE_ID`
  - `QMUX_AGENT_ID`
  - `QMUX_SOCK`
  - `QMUX_TOKEN`
  - `QMUX_WORKSPACE_ROOT`
- Hooks call `qmux notify <event>` over the token-gated Unix socket.
- Transcript tailing starts after Claude emits a `SessionStart` hook with a transcript path.

## Verification Notes

The code has been reviewed and Rust formatting passes. Full build verification requires dependency
resolution:

- `cargo check --offline` fails if `portable-pty` is not already cached locally.
- `npm run build` requires `npm install` first so `tsc` and Vite are available.

Those commands should be run normally once networked dependency installation is allowed.
