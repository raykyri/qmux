import assert from "node:assert/strict";
import test from "node:test";
import {
  isResearchNodeSelectionChange,
  isResearchTreeSelectionChange,
} from "../src/lib/researchNavigation";
import { researchBranchInfo } from "../src/lib/researchBranches";
import { resolveResearchHighlightOffset } from "../src/lib/researchHighlights";
import type { ResearchHighlight, ResearchNode, ResearchNodeStatus } from "../src/types";

function node(
  id: string,
  parentNodeId: string | null,
  status: ResearchNodeStatus = "complete",
): ResearchNode {
  return {
    id,
    treeId: "tree",
    parentNodeId,
    prompt: id,
    adapter: "claude",
    groupId: "group",
    worktreeDir: "/tmp",
    status,
    createdAt: 1,
    highlights: [],
  };
}

function highlight(overrides: Partial<ResearchHighlight["anchor"]> = {}): ResearchHighlight {
  return {
    id: "highlight-1",
    createdAt: 1,
    anchor: {
      version: 1,
      projection: "answer-v1",
      responseRevision: "a".repeat(64),
      start: 7,
      end: 13,
      exact: "target",
      prefix: "before ",
      suffix: " after",
      ...overrides,
    },
  };
}

test("clicking the currently selected research breadcrumb is a no-op", () => {
  assert.equal(isResearchNodeSelectionChange("root-node", "root-node"), false);
});

test("clicking a different research breadcrumb changes the selection", () => {
  assert.equal(isResearchNodeSelectionChange("child-node", "root-node"), true);
  assert.equal(isResearchNodeSelectionChange(null, "root-node"), true);
});

test("clicking the research tree already displayed is a no-op", () => {
  assert.equal(isResearchTreeSelectionChange("tree", true, "tree"), false);
});

test("a research tree remains selectable when its document is not displayed", () => {
  assert.equal(isResearchTreeSelectionChange("tree", false, "tree"), true);
  assert.equal(isResearchTreeSelectionChange("tree", true, "other-tree"), true);
});

test("branch info includes every descendant but not siblings", () => {
  const nodes = [
    node("root", null),
    node("branch", "root"),
    node("child", "branch"),
    node("leaf", "child"),
    node("sibling", "root"),
  ];
  assert.deepEqual(researchBranchInfo(nodes, "branch"), {
    nodeIds: ["branch", "child", "leaf"],
    descendantCount: 2,
    hasActiveRuns: false,
  });
});

test("branch info detects active descendants and live panes", () => {
  const running = [node("branch", "root"), node("child", "branch", "running")];
  assert.equal(researchBranchInfo(running, "branch")?.hasActiveRuns, true);
  const pane = node("child", "branch");
  pane.paneId = "pane";
  assert.equal(researchBranchInfo([node("branch", "root"), pane], "branch")?.hasActiveRuns, true);
  assert.equal(researchBranchInfo(running, "missing"), null);
});

test("research highlights relocate only with matching quote context", () => {
  const saved = highlight();
  assert.deepEqual(
    resolveResearchHighlightOffset("inserted before target after", "a".repeat(64), saved),
    { start: 16, end: 22 },
  );
  assert.equal(
    resolveResearchHighlightOffset("an unrelated target elsewhere", "a".repeat(64), saved),
    null,
  );
});

test("research highlights do not cross snapshot revisions", () => {
  assert.equal(
    resolveResearchHighlightOffset("before target after", "b".repeat(64), highlight()),
    null,
  );
});
