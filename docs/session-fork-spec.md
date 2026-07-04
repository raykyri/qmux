# Forking an agent session

Add app, CLI, and control-socket support that forks a running agent session into a
new tab. The fork inherits the session's transcript and continues independently;
the original session is untouched. Claude and Codex are supported.

## Mechanism

Claude Code can branch a session: `claude --resume <id> --fork-session` replays a
session's history but writes to a *new* session id, so the fork and the original
diverge without conflicting. Codex exposes the same concept through
`codex fork <id>`. We drive that from the app UI or the in-pane qmux CLI:

1. **Frontend** calls Tauri `agent_fork` for the right-pane fork menu and ask-in-fork
   flows.
2. **CLI** (`qmux fork [--worktree] [-- <launch prompt>]`) sends an `agent.fork`
   request over the existing token-gated control socket (`QMUX_SOCK` / `QMUX_TOKEN`),
   and prints the result so the user sees confirmation in the terminal.
3. **Control socket** resolves the source agent from the *authenticated pane* (never
   from caller input), then forks it.
4. **Backend** spawns a new pane with the adapter's native fork command, records the
   fork lineage, nests the new tab under the source, and emits `agent.forked`.
5. **Frontend** sees `agent.forked` and refetches the pane list (picking up the new
   nested tab); the source pane stays focused.

## Backend

- `qmux_pane_envs` exports the socket/token pair used by the in-pane qmux CLI to
  authenticate control-socket requests.
- `ClaudeAdapter::fork_pane(state, source, use_worktree, prompt)`:
  - Requires `source.session_id` (the SessionStart hook must have fired); errors with
    a clear message otherwise.
  - `prepare_agent_workspace` in the source's group: `use_worktree` → a fresh worktree
    off the group's base repo; otherwise runs in `source.worktree_dir` (same files).
  - Records lineage **before** spawning (so the fork's SessionStart can't race it):
    `parent_id = source.id`, `fork_point = source.session_id`,
    `root_session_id = source.root_session_id ?? source.session_id`.
  - Args: `--settings <hooks> --plugin-dir <plugin> [--model M] --permission-mode auto
    --resume <session id> --fork-session [prompt]` (no prompt → starts idle). The
    fork's own SessionStart hook sets its new session id + transcript tail.
- `CodexAdapter::fork_pane(state, source, use_worktree, prompt)`:
  - Requires `source.session_id`.
  - Records the same lineage fields as Claude.
  - Args: `--cd <dir> --add-dir <workspace root> [--model M] --profile qmux-codex
    --sandbox workspace-write --search fork <session id> [prompt]` (no prompt →
    starts idle). Codex hooks record the fork's new session id + transcript tail.
- `AppState::nest_pane_under(pane_id, parent_pane_id)` — moves a pane to immediately
  after the parent at `parent_depth + 1`, then normalizes (reuses the tab-tree
  invariant from the nesting feature).
- `adapters::agent_fork(state, authed_pane, use_worktree, prompt)` — resolves the
  source agent from the authed pane, requires adapter `claude` or `codex`, calls the
  adapter's `fork_pane`, nests the pane, emits `agent.forked`, returns the new
  `PaneInfo`.

## Control-plane trust

The control socket deliberately refuses to spawn agents — that's a GUI (Tauri)
operation. `agent.fork` is the one narrow exception: it forks **only the
authenticated pane's own session** (source derived from the token, not the payload;
payload carries only `useWorktree` and an optional launch prompt). That's the same
authority the user already has acting in that terminal, so the boundary stays
meaningful.

## Notes / simplifications (v1)

- Fork requires a started session (a brand-new session that hasn't hit SessionStart
  can't be forked yet).
- The source may be mid-turn when `qmux fork` runs; the fork reads the transcript as
  flushed so far (history up to ~the fork command), which is acceptable per the ask.
- Claude's `--fork-session` and Codex's `fork` subcommand write a new session id, so
  the source keeps writing its own session file uninterrupted.
- Worktree forks branch off the group's base repo at HEAD (like a launcher worktree),
  not off the source's uncommitted state.
- The control plane's only spawn is `agent.fork`, scoped to the caller's own session.
  There's intentionally no fork rate/count cap: it's the same authority the user has
  in their terminal. A runaway agent could fork in a loop; revisit a backstop if that
  becomes a problem in practice.
