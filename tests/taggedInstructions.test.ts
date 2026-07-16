import assert from "node:assert/strict";
import test from "node:test";
import {
  stripTaggedInstructionBlocks,
  stripTaggedUserInstructionBlocks,
} from "../src/lib/taggedInstructions";

test("removes embedded tagged instruction blocks from copied user messages", () => {
  const message = [
    "Please fix the copy action.",
    "",
    "<system-reminder>",
    "Do not include this injected instruction.",
    "</system-reminder>",
    "",
    "Keep this second paragraph.",
  ].join("\n");

  const copied = stripTaggedUserInstructionBlocks(message);

  assert.equal(copied.includes("<system-reminder>"), false);
  assert.equal(copied.includes("Do not include this injected instruction."), false);
  assert.equal(copied.includes("Please fix the copy action."), true);
  assert.equal(copied.includes("Keep this second paragraph."), true);
});

test("removes nested and consecutive tagged instruction blocks", () => {
  const message = [
    "<environment_context>",
    "<cwd>/private/project</cwd>",
    "</environment_context>",
    "<permissions>",
    "secret policy",
    "</permissions>",
    "User-authored message",
  ].join("\n");

  assert.equal(stripTaggedUserInstructionBlocks(message), "\nUser-authored message");
});

test("preserves inline tag examples that are part of user-authored prose", () => {
  const message = "Explain how <strong>important</strong> is rendered.";

  assert.equal(stripTaggedUserInstructionBlocks(message), message);
});

test("generic tagged-block stripping preserves preceding Markdown headings", () => {
  const message = [
    "# Visible answer",
    "",
    "<system-reminder>",
    "Hidden instructions.",
    "</system-reminder>",
    "",
    "Keep this conclusion.",
  ].join("\n");

  assert.equal(
    stripTaggedInstructionBlocks(message),
    "# Visible answer\n\n\n\nKeep this conclusion.",
  );
});

test("generic tagged-block stripping preserves fenced and indented code", () => {
  const message = [
    "Examples:",
    "",
    "```xml",
    "<system-reminder>",
    "Literal fenced XML.",
    "</system-reminder>",
    "```",
    "",
    "    <user-instructions>",
    "    Literal indented XML.",
    "    </user-instructions>",
    "",
    "<system-reminder>",
    "Hidden instructions.",
    "</system-reminder>",
    "",
    "Visible conclusion.",
  ].join("\n");

  assert.equal(
    stripTaggedInstructionBlocks(message),
    [
      "Examples:",
      "",
      "```xml",
      "<system-reminder>",
      "Literal fenced XML.",
      "</system-reminder>",
      "```",
      "",
      "    <user-instructions>",
      "    Literal indented XML.",
      "    </user-instructions>",
      "",
      "",
      "",
      "Visible conclusion.",
    ].join("\n"),
  );
});
