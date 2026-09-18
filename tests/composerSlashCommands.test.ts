import assert from "node:assert/strict";
import test from "node:test";
import {
  completeComposerSlashCommand,
  matchingComposerSlashCommands,
  nextComposerSlashSelectionIndex,
  parseComposerSlashCommand,
} from "../src/lib/composerSlashCommands";
import {
  composerSlashCommandSubmitLabels,
  planComposerSubmission,
} from "../src/lib/composerActions";
import {
  completeSavedPromptSlashCommand,
  matchingSavedPromptSlashCommands,
  promptNameError,
  savedPromptForExactSlashCommand,
  shouldExpandExactSavedPromptOnKey,
  slugifyPromptName,
  slugifyPromptNameInput,
} from "../src/lib/promptLibrary";
import type { PromptScope, SavedPrompt } from "../src/types";

function savedPrompt(name: string, content: string, scope: PromptScope = "global"): SavedPrompt {
  return { name, content, scope, modifiedMs: 1 };
}

test("matches command prefixes only in the first unfinished token", () => {
  assert.deepEqual(
    matchingComposerSlashCommands("/").map((command) => command.name),
    ["fork", "worktree"],
  );
  assert.deepEqual(
    matchingComposerSlashCommands("/f").map((command) => command.name),
    ["fork"],
  );
  assert.deepEqual(
    matchingComposerSlashCommands("/w").map((command) => command.name),
    ["worktree"],
  );
  assert.deepEqual(matchingComposerSlashCommands("/l"), []);
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

test("treats the removed loop command as ordinary agent input", () => {
  assert.deepEqual(parseComposerSlashCommand("/loop keep fixing the tests"), { kind: "none" });
  assert.deepEqual(parseComposerSlashCommand("/loop"), { kind: "none" });
});

test("treats the removed btw command as ordinary agent input", () => {
  assert.deepEqual(parseComposerSlashCommand("/btw answer this side question"), { kind: "none" });
  assert.deepEqual(parseComposerSlashCommand("/btw"), { kind: "none" });
  assert.deepEqual(matchingComposerSlashCommands("/b").map((command) => command.name), []);
});

test("labels immediate, now, and queued slash-command actions", () => {
  const fork = parseComposerSlashCommand("/fork investigate");
  const worktree = parseComposerSlashCommand("/worktree investigate");
  assert.equal(fork.kind, "ready");
  assert.equal(worktree.kind, "ready");
  if (fork.kind === "ready" && worktree.kind === "ready") {
    assert.deepEqual(composerSlashCommandSubmitLabels(fork.command), {
      immediate: "Fork & send",
      now: "Fork now",
      queued: "Queue fork",
    });
    assert.deepEqual(composerSlashCommandSubmitLabels(worktree.command), {
      immediate: "Fork in worktree & send",
      now: "Worktree now",
      queued: "Queue worktree",
    });
  }
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

test("slugifies prompt names while preserving a trailing typing separator", () => {
  assert.equal(slugifyPromptNameInput("  Résumé Review  "), "resume-review-");
  assert.equal(slugifyPromptNameInput("API---Audit"), "api-audit");
  assert.equal(slugifyPromptName("  Résumé Review  "), "resume-review");
  assert.equal(slugifyPromptName("---"), "");
});

test("rejects empty, reserved, and duplicate prompt names", () => {
  const prompts = [
    savedPrompt("review", "global"),
    savedPrompt("deploy", "project", "project"),
  ];
  assert.equal(promptNameError("", prompts), "Enter a prompt name");
  assert.equal(promptNameError("fork", prompts), "/fork is reserved by qMux");
  assert.equal(
    promptNameError("deploy", prompts),
    "/deploy is already used by another prompt",
  );
  assert.equal(promptNameError("review", prompts, prompts[0]), null);
  assert.equal(promptNameError("new-prompt", prompts), null);
});

test("matches saved prompts only in the leading unfinished slash token", () => {
  const prompts = [
    savedPrompt("review", "Review changes"),
    savedPrompt("review-tests", "Review tests"),
    savedPrompt("deploy", "Deploy"),
  ];
  assert.deepEqual(
    matchingSavedPromptSlashCommands("/rev", prompts).map((prompt) => prompt.name),
    ["review", "review-tests"],
  );
  assert.deepEqual(
    matchingSavedPromptSlashCommands("/review", prompts).map((prompt) => prompt.name),
    ["review", "review-tests"],
  );
  assert.deepEqual(matchingSavedPromptSlashCommands("/review ", prompts), []);
  assert.deepEqual(matchingSavedPromptSlashCommands("prefix /review", prompts), []);
});

test("saved prompt selection completes a partial name before expanding an exact name", () => {
  const prompt = savedPrompt("review-changes", "Review all changed files");
  assert.equal(completeSavedPromptSlashCommand("/rev", prompt), "/review-changes");
  assert.equal(
    completeSavedPromptSlashCommand("/review-changes", prompt),
    "Review all changed files",
  );
});

test("exact saved prompt lookup excludes ambiguous and reserved names", () => {
  const review = savedPrompt("review", "Review changes");
  assert.equal(savedPromptForExactSlashCommand("/review", [review]), review);
  assert.equal(savedPromptForExactSlashCommand("/rev", [review]), null);
  assert.equal(savedPromptForExactSlashCommand("/review ", [review]), null);
  assert.equal(
    savedPromptForExactSlashCommand("/review", [review, savedPrompt("review", "Other")]),
    null,
  );
  assert.equal(savedPromptForExactSlashCommand("/fork", [savedPrompt("fork", "Prompt")]), null);
});

test("open slash menu selection wins over exact prompt expansion on Enter", () => {
  assert.equal(shouldExpandExactSavedPromptOnKey("Enter", true), false);
  assert.equal(shouldExpandExactSavedPromptOnKey("Enter", false), true);
  assert.equal(shouldExpandExactSavedPromptOnKey(" ", true), true);
  assert.equal(shouldExpandExactSavedPromptOnKey("Tab", false), false);
});

test("slash selection navigation ignores a status-only menu and wraps options", () => {
  assert.equal(nextComposerSlashSelectionIndex(0, 1, 0), null);
  assert.equal(nextComposerSlashSelectionIndex(0, 1, 2), 1);
  assert.equal(nextComposerSlashSelectionIndex(1, 1, 2), 0);
  assert.equal(nextComposerSlashSelectionIndex(0, -1, 2), 1);
});
