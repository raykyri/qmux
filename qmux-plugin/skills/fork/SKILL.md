---
name: fork
description: Fork the current session into a new qmux tab nested under this one, running in the same directory. Use when the user invokes /qmux:fork or asks to fork, branch, or split off the current session (without a separate git worktree). Not for starting an unrelated new session.
---

# Fork this session

If the user gave a specific task or instruction for the fork, pass that text after
`--` so it is submitted as the forked session's first user message. Otherwise omit
the `-- ...` part.

Run one of these commands exactly once, then report its output and stop:

```bash
"${QMUX_CLI:-qmux}" fork
"${QMUX_CLI:-qmux}" fork -- "the task for the fork"
```

This asks qmux to fork the current session into a new tab nested under this one.
The new tab inherits this session's history and continues independently; this
session is unaffected and you should carry on normally afterward. When a task is
passed after `--`, qmux submits it to the fork as the launch message.

Do not run any other commands, do not retry on success, and do not modify any files.
If the command prints an error (for example, the session isn't ready to fork yet),
relay that error verbatim to the user.
