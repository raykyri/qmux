---
name: fork
description: Fork the current Claude session into a new qmux tab nested under this one, running in the same directory. Use when the user invokes /qmux:fork or asks to fork, branch, or split off the current session (without a separate git worktree). Not for starting an unrelated new session.
---

# Fork this session

Run this command exactly once, then report its output and stop:

```bash
"${QMUX_CLI:-qmux}" fork
```

This asks qmux to fork the current Claude session into a new tab nested under this
one. The new tab inherits this session's history and continues independently; this
session is unaffected and you should carry on normally afterward.

Do not run any other commands, do not retry on success, and do not modify any files.
If the command prints an error (for example, the session isn't ready to fork yet),
relay that error verbatim to the user.
