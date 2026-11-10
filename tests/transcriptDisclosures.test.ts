import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import CollapsedTranscriptDisclosure from "../src/components/CollapsedTranscriptDisclosure";
import { transcriptDisclosureLabel } from "../src/lib/transcriptDisclosures";

const task = '<task-notification>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>';
const wrappedTask = `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n${task}`;

test("recognizes Claude task notifications with and without the system wrapper", () => {
  for (const role of ["user", "system", "assistant"]) {
    assert.equal(transcriptDisclosureLabel(task, role), "Background task completed");
    assert.equal(transcriptDisclosureLabel(wrappedTask, role), "Background task completed");
    assert.equal(transcriptDisclosureLabel(wrappedTask.replaceAll("\n", "\r\n"), role), "Background task completed");
  }
  assert.equal(transcriptDisclosureLabel(task.replace("completed", "failed"), "user"), "Background task failed");
});

test("recognizes environment updates and skill dumps using their native prefixes", () => {
  assert.equal(transcriptDisclosureLabel("# Environment update\n - Primary working directory: /project/src (was /project)", "system"), "Environment update");
  assert.equal(transcriptDisclosureLabel("<environment_context>\n<cwd>/project</cwd>\n</environment_context>", "user"), "Environment context");
  assert.equal(transcriptDisclosureLabel("\nBase directory for this skill: /Users/example/.claude/skills/docs/\n\nFull skill instructions.", "user"), "Skill: docs");
  assert.equal(transcriptDisclosureLabel("<skills>Loaded instructions</skills>", "user"), "Skill instructions");
});

test("keeps ordinary prose, quoted examples, and mixed user messages expanded", () => {
  for (const text of [
    `Explain this notification:\n${task}`,
    `\`\`\`xml\n${task}\n\`\`\``,
    "Can you update the environment?",
    "I loaded the docs skill.",
    "<environment_context>/project</environment_context>\nPlease fix the build.",
  ]) {
    assert.equal(transcriptDisclosureLabel(text, "user"), null);
  }
  assert.equal(transcriptDisclosureLabel("<report>Keep this answer visible</report>", "assistant"), null);
  assert.equal(transcriptDisclosureLabel("<system-reminder>Injected guidance</system-reminder>", "user"), "<system-reminder>");
});

const dom = new JSDOM('<!doctype html><div id="root"></div>');
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
after(() => dom.window.close());

test("disclosure defers the full text, expands on activation, and collapses with Escape", async () => {
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() => root.render(h(CollapsedTranscriptDisclosure, { label: "Background task completed", text: wrappedTask })));
    const button = container.querySelector("button")!;
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector("p"), null);
    button.focus();
    await act(() => button.click());
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(container.querySelector("p")?.textContent, wrappedTask);
    assert.equal(button.getAttribute("aria-controls"), container.querySelector("p")?.id);
    await act(() => button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector("p"), null);
    assert.equal(document.activeElement, button);
  } finally {
    await act(() => root.unmount());
  }
});
