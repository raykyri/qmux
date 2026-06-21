---
name: fork-worktree
description: Fork the current Claude session into a new qmux tab nested under this one, running in a fresh isolated git worktree. Use when the user invokes /qmux:fork-worktree or asks to fork/branch the current session into a separate worktree so the fork's file changes stay isolated. Not for starting an unrelated new session.
---

# Fork this session into a new worktree

Run this command exactly once, then report its output and stop:

```bash
"${QMUX_CLI:-qmux}" fork --worktree
```

This asks qmux to fork the current Claude session into a new tab nested under this
one, running in a fresh git worktree so its file changes are isolated. The new tab
inherits this session's history and continues independently; this session is
unaffected and you should carry on normally afterward.

Do not run any other commands, do not retry on success, and do not modify any files.
If the command prints an error (for example, the session isn't ready to fork yet),
relay that error verbatim to the user.
