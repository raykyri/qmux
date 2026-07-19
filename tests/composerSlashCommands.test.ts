import assert from "node:assert/strict";
import test from "node:test";
import {
  completeComposerSlashCommand,
  isTuiCommandMessage,
  matchingComposerSlashCommands,
  parseComposerSlashCommand,
} from "../src/lib/composerSlashCommands";

test("matches command prefixes only in the first unfinished token", () => {
  assert.deepEqual(
    matchingComposerSlashCommands("/").map((command) => command.name),
    ["fork", "worktree", "loop"],
  );
  assert.deepEqual(
    matchingComposerSlashCommands("/f").map((command) => command.name),
    ["fork"],
  );
  assert.deepEqual(
    matchingComposerSlashCommands("/w").map((command) => command.name),
    ["worktree"],
  );
  assert.deepEqual(
    matchingComposerSlashCommands("/l").map((command) => command.name),
    ["loop"],
  );
  assert.deepEqual(matchingComposerSlashCommands("/fork "), []);
  assert.deepEqual(matchingComposerSlashCommands("prefix /fork"), []);
  assert.deepEqual(matchingComposerSlashCommands("/unknown"), []);
});

test("completes a selected command with a message separator", () => {
  const [fork] = matchingComposerSlashCommands("/f");
  assert.equal(completeComposerSlashCommand(fork), "/fork ");
});

test("parses fork commands and strips only the qmux command prefix", () => {
  assert.deepEqual(parseComposerSlashCommand("/fork investigate this"), {
    kind: "ready",
    command: {
      name: "fork",
      token: "/fork",
      description: "Fork this session and send the following message",
      kind: "fork",
      useWorktree: false,
    },
    prompt: "investigate this",
  });
  const parsed = parseComposerSlashCommand("/worktree\t first line\nsecond line ");
  assert.equal(parsed.kind, "ready");
  if (parsed.kind === "ready") {
    assert.equal(parsed.command.useWorktree, true);
    assert.equal(parsed.prompt, "first line\nsecond line");
  }
});

test("parses the loop command and marks it as a loop kind", () => {
  const parsed = parseComposerSlashCommand("/loop keep fixing the tests");
  assert.equal(parsed.kind, "ready");
  if (parsed.kind === "ready") {
    assert.equal(parsed.command.name, "loop");
    assert.equal(parsed.command.kind, "loop");
    assert.equal(parsed.prompt, "keep fixing the tests");
  }
  assert.equal(parseComposerSlashCommand("/loop").kind, "incomplete");
  assert.equal(parseComposerSlashCommand("/loop   ").kind, "incomplete");
});

test("flags messages the agent TUI intercepts as commands", () => {
  assert.equal(isTuiCommandMessage("/compact"), true);
  assert.equal(isTuiCommandMessage("  /model opus"), true);
  assert.equal(isTuiCommandMessage("!git status"), true);
  assert.equal(isTuiCommandMessage("\t!ls"), true);
  assert.equal(isTuiCommandMessage("keep going"), false);
  assert.equal(isTuiCommandMessage("fix the / in the path"), false);
});

test("recognizes known commands without a message as incomplete", () => {
  assert.equal(parseComposerSlashCommand("/fork").kind, "incomplete");
  assert.equal(parseComposerSlashCommand("/fork   ").kind, "incomplete");
  assert.equal(parseComposerSlashCommand("/worktree\t").kind, "incomplete");
});

test("leaves unknown, embedded, and lookalike slash commands alone", () => {
  for (const value of [
    "/compact now",
    "/forked now",
    "/Fork now",
    " /fork now",
    "explain /fork now",
    "/fork\nnow",
  ]) {
    assert.deepEqual(parseComposerSlashCommand(value), { kind: "none" }, value);
  }
});
