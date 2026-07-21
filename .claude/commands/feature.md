---
description: Implement a feature in a new worktree and open a PR (via the feature-builder agent)
argument-hint: <feature description | GitHub issue number or URL>
---

If the argument below is empty, ask the user what feature they want built and stop — do not launch the agent with an empty spec.

Otherwise, launch the **feature-builder** subagent (Agent tool, `subagent_type: "feature-builder"`, `run_in_background: false`) with this task, passed verbatim:

<feature-request>
$ARGUMENTS
</feature-request>

When the agent finishes, relay to the user in your final message:

1. The pull request URL.
2. The absolute path of the local worktree, so they can test the change locally.
3. A brief summary of what was implemented, how it was tested, and which PR labels were applied.

If the agent reports that it stopped early (ambiguous spec, failing tests it opened as a draft, etc.), relay that state honestly instead of presenting the work as complete.
