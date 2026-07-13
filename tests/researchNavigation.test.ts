import assert from "node:assert/strict";
import test from "node:test";
import { isResearchNodeSelectionChange } from "../src/lib/researchNavigation";
import { researchBranchInfo } from "../src/lib/researchBranches";
import type { ResearchNode, ResearchNodeStatus } from "../src/types";

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
  };
}

test("clicking the currently selected research breadcrumb is a no-op", () => {
  assert.equal(isResearchNodeSelectionChange("root-node", "root-node"), false);
});

test("clicking a different research breadcrumb changes the selection", () => {
  assert.equal(isResearchNodeSelectionChange("child-node", "root-node"), true);
  assert.equal(isResearchNodeSelectionChange(null, "root-node"), true);
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
