# Forking an agent session from inside the terminal

Add skills and control-socket support, callable inside a running agent session, that
fork it into a new tab nested under the current one. The fork inherits the session's
transcript and continues independently; the original session is untouched. Claude and
Codex are supported.

- `/qmux:fork` — fork in place (the new tab runs in the same directory).
- `/qmux:fork-worktree` — fork into a fresh git worktree.

(`qmux:` is the Claude plugin namespace from `qmux-plugin/.claude-plugin/plugin.json`,
the same mechanism the other injected skills use.)

## Mechanism

Claude Code can branch a session: `claude --resume <id> --fork-session` replays a
session's history but writes to a *new* session id, so the fork and the original
diverge without conflicting. Codex exposes the same concept through
`codex fork <id>`. We drive that from a skill or UI action:

1. **Skill** (`SKILL.md`) tells Claude to run one command and report the result:
   `"${QMUX_CLI:-qmux}" fork [--worktree] [-- <launch prompt>]`.
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

- `qmux_pane_envs` also exports `QMUX_CLI` (the qmux executable path) so a skill's
  bash step can call it without relying on `qmux` being on `PATH`.
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

## Skills

`qmux-plugin/skills/fork/SKILL.md` and `.../fork-worktree/SKILL.md`: minimal,
imperative — run one command, include `-- <launch prompt>` when the user provided a
task for the fork, report its output, do nothing else.

## Notes / simplifications (v1)

- Fork requires a started session (a brand-new session that hasn't hit SessionStart
  can't be forked yet).
- The source may be mid-turn when `qmux fork` runs; the fork reads the transcript as
  flushed so far (history up to ~the fork command), which is acceptable per the ask.
- Claude's `--fork-session` and Codex's `fork` subcommand write a new session id, so
  the source keeps writing its own session file uninterrupted.
- Worktree forks branch off the group's base repo at HEAD (like a launcher worktree),
  not off the source's uncommitted state.
- `QMUX_CLI` is exported into a pane's environment at spawn time, so the skill only
  works in panes started after this change. Sessions already running when qmux is
  upgraded won't have it (and `qmux` isn't on `PATH`), so the skill there prints
  "command not found" until qmux is restarted — restart re-spawns recovered panes with
  the new env. New sessions work immediately.
- The control plane's only spawn is `agent.fork`, scoped to the caller's own session.
  There's intentionally no fork rate/count cap: it's the same authority the user has
  in their terminal. A runaway agent could fork in a loop; revisit a backstop if that
  becomes a problem in practice.
