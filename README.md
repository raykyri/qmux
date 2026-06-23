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
- Agent panes for Claude Code, Codex, and OpenCode, launched from the app
  launcher or by running `claude` / `codex` / `opencode` inside a qmux shell
  pane.
- Pluggable adapter registry (Rust) + UI adapters (React) so agents can define
  their own launch options, transcript parsing, and composer policy.
- Launcher with per-agent adapter and model selection, and optional git worktree
  isolation.
- Sidebar tab nesting: indent a tab under another by dragging it onto the tab, or
  via the tab's right-click Indent/Outdent.
- Sidebar keyboard shortcut hints: hold `Cmd` to show floating hints for Home and
  the first nine pane tabs.
- Hook settings generation and token-gated Unix-socket ingestion via
  `qmux notify <event>`.
- Transcript JSONL tailing for native turn rendering.
- Native follow-up composer: send, queue, steer, approve/deny, queued-turn
  editing/reordering, per-item "pause after send", a typing-aware hold that delays
  auto-send while you type, per-agent drafts, and transcript copy actions (including
  "Copy queued").
- Local Whisper-backed dictation in the launcher and follow-up composer, with the
  model cached after first use.
- Optional git worktree creation for launched agents, with dirty-worktree checks
  (and soft branch deletion) before closing worktree-backed panes.
- Session forking from inside a running Claude or Codex session (with or without a
  fresh git worktree) into a tab nested under the source — see [Skills](#skills).
- A tab-bound, resizable browser overlay that renders a local file or a
  `http://localhost` dev server in a panel over the terminal (URL bar, refresh,
  toggle), served from a loopback-only static file server.
- Clickable links in the transcript and terminal: open in the browser overlay, or
  right-click to choose the internal or external browser.
- Session/transcript recovery, including a session menu to copy the active session
  id, switch/detach transcript bindings, and correct a wrong guess.
- Persisted pane, group, agent, transcript, and queued-turn metadata with
  best-effort restart recovery.
- App settings: terminal font and size, plus a macOS wake lock that keeps the
  machine awake while agents are running (skipped on battery below 10%).

Still planned:

- Full workspace/group lifecycle commands.
- Workspace/group forking (session forking already ships via skills).
- Clip, markup, and share flows.
- More agent adapters.
- Windows/Linux support. The current implementation targets macOS first.

## Quickstart

Prerequisites:

- macOS.
- Rust toolchain.
- Node.js and npm.
- The agent CLIs you want to use on `PATH`: `claude`, `codex`, and/or `opencode`.

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

- `Cmd-T`: open a shell pane.
- `Cmd-N`: focus Home.
- `Cmd-;` / `Ctrl-;`: open the agent launcher.
- `Cmd-=` / `Cmd-+`: increase terminal font size.
- `Cmd--`: decrease terminal font size.
- `Cmd-0`: reset terminal font size.
- `Cmd-O`: open the workspace folder selector.
- `Cmd-1`..`Cmd-9` / `Ctrl-1`..`Ctrl-9`: focus the corresponding pane tab.
- Hold `Cmd`: show floating shortcut hints for Home and pane tabs in the `Cmd-1`..
  `Cmd-9` range.
- `Ctrl-Tab` / `Ctrl-Shift-Tab`: cycle through open pane tabs, skipping Home.
- `Cmd-Shift-[` / `Cmd-Shift-]`: cycle through Home and open tabs.
- `Cmd-Shift-H`: focus Home.
- `Cmd-E`: expand or restore the active transcript pane.
- `Cmd-W` / `Ctrl-W`: close the active pane.
- `Cmd-,` / `Ctrl-,`: open settings.
- In the launcher, enter a prompt, and press `Cmd-Enter` to launch.
- Enable `Worktree` to create an isolated git worktree for the agent.
- Use the mic button in the launcher or composer for local dictation. The Whisper
  model downloads on first use, is cached by qmux, and then runs locally/offline.
- In zsh/bash shell panes, the app injects `qmux`, `claude`, `codex`, and
  `opencode` shell functions to route the agent through qmux, so transcripts
  and native follow-ups work without those commands being on `PATH`.
- Nest tabs by dragging one onto another tab in the sidebar, or right-click a tab and
  choose `Indent` / `Outdent`.
- Agent input is queued while an agent is busy. Use `Steer` to inject a turn
  immediately instead of waiting for the agent to become idle. While you're typing,
  the queue holds (it auto-sends ~1.5s after you stop) so a finishing turn doesn't
  interrupt you.
- A queued item's `⋮` menu can mark it `Pause after send`: after that turn is sent the
  queue stops draining and shows `Unpause`. The composer's height toggle (left of the
  `⋮` menu) caps the queue at half the pane or lets it grow.
- The right-pane session menu can copy the active session id and select another
  transcript for the current agent. Session previews use the first usable user
  message within the first five user messages, skipping tag-wrapped instruction
  messages that render gray in the transcript.
- Fork a running Claude or Codex session from the UI or in-pane `qmux fork` command.
  Claude sessions can also use `/qmux:fork` (same directory) or `/qmux:fork-worktree`
  (a fresh isolated worktree); the fork opens as a tab nested under the source and
  inherits its transcript. A launch prompt can be passed after `--`.
- Click a link in the transcript or terminal to open it in the internal browser
  overlay; right-click to choose internal vs. external browser.
- Browser overlay: run `qmux open <file|url>` at a shell pane's prompt, use the
  `open-in-browser` skill from an agent, or type a URL/bare host into the overlay's
  URL bar to render a file or a `http://localhost` dev server in a panel that floats
  over the terminal, bound to that tab. The globe button at the terminal's top-right
  toggles it and the button to its left refreshes it. Drag the bottom-left corner to
  resize it; the size is remembered for that tab while the app is running. Files are
  served from a loopback-only static server and must live under the workspace.

## Repository Layout

- `src/`: React frontend.
- `src/components/`: terminal, native input, launcher, turn overlay, and browser
  overlay UI.
- `src/adapters/`: per-agent UI adapters (Claude, Codex, OpenCode) and the shared interface.
- `src/lib/api.ts`: Tauri command/event client helpers.
- `src/lib/settings.ts`: persisted app settings (font, sleep behavior).
- `src-tauri/src/`: Rust backend modules (PTYs, control socket, file server,
  persistence, turn queue).
- `src-tauri/src/adapters/`: per-agent backend adapters and the adapter registry.
- `qmux-plugin/`: qmux-owned Claude plugin whose `skills/` are injected into launched
  Claude agents (see [Skills](#skills)).
- `qmux-opencode-plugin/`: qmux-owned OpenCode plugin that forwards lifecycle
  events to `qmux notify` and writes transcript JSONL for qmux to tail.
- `docs/`: design specs for larger features (tab nesting, session fork, queue pauses).
- `qmux.config.json`: repo-local development config.

## Local Config

`qmux.config.json` keeps spawned qmux state inside this checkout:

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

Relative paths are resolved from the process working directory. Each adapter's
`binary` is optional and defaults to the command name (`claude`, `codex`,
`opencode`); a top-level `claudeBinary` is still honored for backward
compatibility. If the config file is absent, qmux falls back to
`~/qmux/workspaces` for workspace state and `~/qmux/run/qmux.sock` for the
control socket.

Runtime directories:

- `<workspaceRoot>/`: qmux groups and optional agent worktrees.
- `<workspaceRoot>/.qmux/`: persisted app state, scrollback, and adapter
  transcripts (`state.json`, `terminal/*.pty`, `opencode/*.jsonl`).
- `<socketPath>` parent: the owner-only Unix socket directory; the socket file is
  recreated on startup.
- `$TMPDIR/qmux-shell-init/<pane-id>/`: temporary generated shell rc files,
  removed best-effort when panes exit.
- `<agent cwd>/.qmux/qmux-hooks.json`: Claude hook settings; when worktree mode is
  off, this may be in the selected project directory.
- `$CODEX_HOME/qmux/` or `~/.codex/qmux/`: Codex hook shim, created when launching
  Codex agents.
- `$CODEX_HOME/qmux-codex.config.toml` or `~/.codex/qmux-codex.config.toml`:
  qmux-managed Codex profile config that points at the hook shim.
- `QMUX_OPENCODE_PLUGIN_DIR` or `<cwd>/qmux-opencode-plugin`: qmux-managed OpenCode
  plugin directory injected into launched OpenCode agents.

## Skills

qmux can inject [Claude Code Agent Skills](https://code.claude.com/docs/en/skills)
into the Claude agents it launches, without touching the user's `~/.claude` or the
project's `.claude`. Skills live in a qmux-owned plugin directory and are passed to
every launched Claude instance via `--plugin-dir`:

```
qmux-plugin/
├── .claude-plugin/plugin.json   # plugin name -> skill namespace (default "qmux")
└── skills/
    └── <skill-name>/SKILL.md     # add skills here
```

Each skill is offered as a checkbox in the agent launcher (one selection at a time);
choosing one prepends its namespaced slash command (e.g. `/qmux:deep-research`) to the
prompt. Skills are also available to `claude` started inside a qmux shell pane, and can
be invoked mid-session by typing the slash command.

Bundled skills: `deep-research`, `fork` and `fork-worktree` (fork the running Claude
session into a nested tab, optionally in a fresh worktree, and submit a launch prompt
when one is provided), and `open-in-browser` (render a file or URL in the browser
overlay). `fork`/`fork-worktree`/`open-in-browser` are designed to be called from
inside a running session rather than chosen in the launcher.

The directory is resolved from `QMUX_CLAUDE_PLUGIN_DIR`, or defaults to `qmux-plugin`
relative to the process working directory (the same anchor used for `workspaceRoot`).
Drop in a new `<skill-name>/SKILL.md` and reopen the launcher — no restart needed.

## Runtime Model

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
  - `QMUX_CLI` (path to the qmux binary, for in-pane tooling)
- Agent panes also receive `QMUX_AGENT_ID`.
- Hooks call `qmux notify <event>` over the token-gated Unix socket; qmux routes
  the notification to the owning agent's adapter. The same socket, scoped to the
  caller's pane, serves other in-pane commands (`qmux open`, `qmux fork`).
- A loopback-only (`127.0.0.1`) HTTP server with a per-launch random token backs the
  browser overlay's `file://`-style URLs; it only serves files under the workspace
  roots. The frontend only ever sees fully-formed `http://127.0.0.1/...` URLs.
- Transcript tailing starts once the agent reports a transcript path (for Claude,
  on its `SessionStart` hook).
- Persisted state is written under `<workspaceRoot>/.qmux/state.json`.
