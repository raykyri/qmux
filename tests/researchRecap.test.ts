import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchRecap from "../src/components/research/ResearchRecap";
import { ResearchRecapDialogPanel } from "../src/components/research/ResearchRecapDialog";
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

test("candidate dialog presents the current recap before generation", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchRecapDialogPanel, {
      content: content(),
      onClose: () => undefined,
      onApplied: () => undefined,
    }),
  );
  assert.match(html, /Generate summary/);
  // The current summary is shown for comparison and stays until a candidate
  // is generated and applied.
  assert.match(html, /The result is ready\./);
  assert.match(html, /Generate a new summary first\./);
  assert.match(html, /Generate candidate/);
  assert.ok(html.indexOf("Generate candidate") < html.indexOf(">Candidate<"));
  assert.ok(html.indexOf(">Candidate<") < html.indexOf(">Current<"));
  // Shared primitives, not hand-rolled controls: the form-field textarea and
  // input, the LauncherSelect trigger, and no native datalist.
  assert.match(html, /class="form-field research-recap-instructions"/);
  assert.match(html, /class="form-field research-recap-control"/);
  // The agent select and the model field are disabled until the adapter probe
  // returns, so nothing can be generated against an unknown agent.
  assert.match(html, /disabled="" type="button" class="control-button launcher-select-trigger"/);
  assert.match(html, /disabled="" role="combobox"/);
  assert.doesNotMatch(html, /<datalist/);
  assert.match(html, /<hr class="research-recap-comparison-divider"/);
});
