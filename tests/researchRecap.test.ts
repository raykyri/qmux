import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchRecap from "../src/components/research/ResearchRecap";
import type { ResearchNodeContent } from "../src/types";

function content(): ResearchNodeContent {
  return {
    node: {
      id: "node",
      treeId: "tree",
      prompt: "Question",
      adapter: "claude",
      groupId: "group",
      worktreeDir: "/tmp",
      status: "complete",
      createdAt: 1,
      highlights: [],
      recap: { text: "The result is ready.", responseRevision: "revision" },
    },
    turns: [],
    children: [],
    responseRevision: "revision",
  };
}
const render = (value: ResearchNodeContent) =>
  renderToStaticMarkup(createElement(ResearchRecap, { content: value }));

test("recaps reserve no space until generated and belonging to the displayed answer", () => {
  const value = content();
  assert.match(render(value), /Summary: The result is ready\./);
  value.responseRevision = "different";
  assert.equal(render(value), "");
  value.responseRevision = "revision";
  value.node.status = "running";
  assert.equal(render(value), "");
  value.node.status = "complete";
  delete value.node.recap;
  assert.equal(render(value), "");
});

test("a pending summary job holds the recap slot with a spinner", () => {
  const value = content();
  const pending = (input: ResearchNodeContent) =>
    renderToStaticMarkup(createElement(ResearchRecap, { content: input, pending: true }));
  // A current recap always wins over the placeholder.
  assert.match(pending(value), /Summary: The result is ready\./);
  delete value.node.recap;
  assert.match(pending(value), /Generating summary/);
  assert.equal(render(value), "");
  // A stale recap generates again, so its slot shows the spinner, not the text.
  value.node.recap = { text: "Stale.", responseRevision: "older" };
  assert.match(pending(value), /Generating summary/);
  assert.doesNotMatch(pending(value), /Stale\./);
  // Nothing to summarize yet on a run that has not settled.
  value.node.status = "running";
  assert.equal(pending(value), "");
});

test("recaps render as text, with no Markdown or HTML interpretation", () => {
  const value = content();
  value.node.recap!.text = "<script>alert(1)</script> **text**";
  const html = render(value);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("**text**"));
  assert.ok(!html.includes("<strong>"));
  value.node.kind = "document";
  assert.equal(render(value), "");
});

test("current recaps render without an inline regeneration control", () => {
  const html = render(content());
  assert.match(html, /Summary: The result is ready\./);
  assert.doesNotMatch(html, /Generate summary/);
  assert.doesNotMatch(html, /<button/);
});
