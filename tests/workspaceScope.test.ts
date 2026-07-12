import test from "node:test";
import assert from "node:assert/strict";
import type { GroupInfo, PaneInfo, ResearchTreeSummary } from "../src/types";
import { cycleTabId } from "../src/lib/appHelpers";
import {
  groupsForScope,
  panesForWorkspace,
  panesForScope,
  researchAttention,
  replaceScopedGroupOrder,
} from "../src/lib/workspaceScope";
import {
  parseSidebarMode,
  RESEARCH_DOCUMENT_TAB_ID,
  researchCycleTabIds,
  terminalTabForMode,
} from "../src/lib/sidebarMode";
import {
  ALL_RESEARCH_SCOPE,
  nextTreeInResearchScope,
  resolveResearchScope,
  treeForResearchScope,
  treesForResearchScope,
  workspaceIsInResearchScope,
} from "../src/lib/researchScope";

function group(id: string, scope: GroupInfo["scope"]): GroupInfo {
  return {
    id,
    name: id,
    dir: `/tmp/${id}`,
    managedDir: `/tmp/qmux/${id}`,
    createdAt: 1,
    collapsed: false,
    scope,
    agents: [],
  };
}

function pane(id: string, groupId: string): PaneInfo {
  return {
    id,
    title: id,
    kind: "shell",
    groupId,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    status: "running",
  };
}

test("scope selectors partition groups and panes without relying on research node bindings", () => {
  const terminalA = group("terminal-a", "terminal");
  const research = group("research-a", "research");
  const terminalB = group("terminal-b", "terminal");
  const groups = [terminalA, research, terminalB];
  const panes = [
    pane("research-pane", research.id),
    pane("terminal-b-pane", terminalB.id),
    pane("terminal-a-pane", terminalA.id),
  ];

  assert.deepEqual(groupsForScope(groups, "terminal").map(({ id }) => id), [
    terminalA.id,
    terminalB.id,
  ]);
  assert.deepEqual(panesForScope(panes, groups, "terminal").map(({ id }) => id), [
    "terminal-a-pane",
    "terminal-b-pane",
  ]);
  assert.deepEqual(panesForScope(panes, groups, "research").map(({ id }) => id), [
    "research-pane",
  ]);
});

test("a pane with missing group metadata remains recoverable in Terminal scope", () => {
  const orphan = pane("orphan", "missing-group");

  assert.deepEqual(panesForScope([orphan], [], "terminal"), [orphan]);
  assert.deepEqual(panesForScope([orphan], [], "research"), []);
});

test("workspace panes and research attention are derived from durable ownership and summaries", () => {
  const panes = [pane("one", "folder-a"), pane("two", "folder-b"), pane("three", "folder-a")];
  assert.deepEqual(panesForWorkspace(panes, "folder-a").map(({ id }) => id), ["one", "three"]);

  assert.deepEqual(
    researchAttention([
      {
        id: "tree-a",
        title: "A",
        rootNodeId: "root-a",
        workspaceId: "folder-a",
        runningCount: 2,
        failedCount: 0,
        completedCount: 1,
        cancelledCount: 0,
        updatedAt: 1,
        hasUnseenUpdate: true,
        hasUnseenFailure: false,
      },
      {
        id: "tree-b",
        title: "B",
        rootNodeId: "root-b",
        workspaceId: "folder-b",
        runningCount: 0,
        failedCount: 1,
        completedCount: 0,
        cancelledCount: 1,
        updatedAt: 2,
        hasUnseenUpdate: false,
        hasUnseenFailure: true,
      },
      {
        // An old failure the user already viewed: counted in the lifetime
        // failedCount but no longer demanding attention.
        id: "tree-c",
        title: "C",
        rootNodeId: "root-c",
        workspaceId: "folder-a",
        runningCount: 0,
        failedCount: 3,
        completedCount: 2,
        cancelledCount: 0,
        updatedAt: 3,
        hasUnseenUpdate: false,
        hasUnseenFailure: false,
      },
    ]),
    { runningCount: 2, failedCount: 1, unseenCount: 1 },
  );
});

test("reordering Terminal groups preserves Research slots", () => {
  const terminalA = group("terminal-a", "terminal");
  const researchA = group("research-a", "research");
  const terminalB = group("terminal-b", "terminal");
  const researchB = group("research-b", "research");

  assert.deepEqual(
    replaceScopedGroupOrder(
      [terminalA, researchA, terminalB, researchB],
      "terminal",
      [terminalB, terminalA],
    ).map(({ id }) => id),
    [terminalB.id, researchA.id, terminalA.id, researchB.id],
  );
});

test("a stale, duplicate, or cross-scope reorder is ignored", () => {
  const terminalA = group("terminal-a", "terminal");
  const research = group("research-a", "research");
  const terminalB = group("terminal-b", "terminal");
  const groups = [terminalA, research, terminalB];

  assert.equal(
    replaceScopedGroupOrder(groups, "terminal", [terminalA, terminalA]),
    groups,
  );
  assert.equal(replaceScopedGroupOrder(groups, "terminal", [terminalA]), groups);
  assert.equal(
    replaceScopedGroupOrder(groups, "terminal", [terminalA, research]),
    groups,
  );
});

test("sidebar mode parsing safely defaults old or corrupt preferences to Terminal", () => {
  assert.equal(parseSidebarMode("research"), "research");
  assert.equal(parseSidebarMode("terminal"), "terminal");
  assert.equal(parseSidebarMode("other"), "terminal");
  assert.equal(parseSidebarMode(null), "terminal");
});

test("switching to Terminal restores a valid prior tab without crossing scope", () => {
  const terminalA = group("terminal-a", "terminal");
  const terminalB = group("terminal-b", "terminal");
  const research = group("research-a", "research");
  const groups = [terminalA, research, terminalB];
  const panes = [
    pane("research-pane", research.id),
    pane("terminal-a-pane", terminalA.id),
    pane("terminal-b-pane", terminalB.id),
  ];

  assert.equal(
    terminalTabForMode(panes, groups, "terminal-b-pane", "home"),
    "terminal-b-pane",
  );
  assert.equal(
    terminalTabForMode(panes, groups, "research-pane", "home"),
    "terminal-a-pane",
  );
  assert.equal(terminalTabForMode(panes, groups, "home", "home"), "home");
  assert.equal(terminalTabForMode([], groups, "missing", "home"), "home");
});

test("switching to Terminal prefers a pane whose group is expanded", () => {
  const terminalA = group("terminal-a", "terminal");
  const terminalB = group("terminal-b", "terminal");
  terminalA.collapsed = true;
  const groups = [terminalA, terminalB];
  const panes = [
    pane("terminal-a-pane", terminalA.id),
    pane("terminal-b-pane", terminalB.id),
  ];

  // The stale-preference fallback must not activate a tab the sidebar hides.
  assert.equal(terminalTabForMode(panes, groups, "missing", "home"), "terminal-b-pane");

  // Every group collapsed: any pane beats the empty home screen.
  terminalB.collapsed = true;
  assert.equal(terminalTabForMode(panes, groups, "missing", "home"), "terminal-a-pane");
});

test("research cycling stays on the document when no research terminals are visible", () => {
  const groups = [group("terminal", "terminal")];
  const ids = researchCycleTabIds(
    [pane("terminal-pane", "terminal")],
    groups,
    "tree",
    ALL_RESEARCH_SCOPE,
  );

  assert.deepEqual(ids, [RESEARCH_DOCUMENT_TAB_ID]);
  assert.equal(cycleTabId(ids, RESEARCH_DOCUMENT_TAB_ID, 1), RESEARCH_DOCUMENT_TAB_ID);
  assert.equal(cycleTabId(ids, RESEARCH_DOCUMENT_TAB_ID, -1), RESEARCH_DOCUMENT_TAB_ID);
});

test("research cycling wraps between the document and visible research terminals", () => {
  const terminal = group("terminal", "terminal");
  const researchA = group("research-a", "research");
  const researchB = group("research-b", "research");
  researchB.collapsed = true;
  const ids = researchCycleTabIds(
    [
      pane("terminal-pane", terminal.id),
      pane("research-one", researchA.id),
      pane("research-collapsed", researchB.id),
      pane("research-two", researchA.id),
    ],
    [terminal, researchA, researchB],
    "tree",
    ALL_RESEARCH_SCOPE,
  );

  assert.deepEqual(ids, [RESEARCH_DOCUMENT_TAB_ID, "research-one", "research-two"]);
  assert.equal(cycleTabId(ids, RESEARCH_DOCUMENT_TAB_ID, 1), "research-one");
  assert.equal(cycleTabId(ids, "research-one", 1), "research-two");
  assert.equal(cycleTabId(ids, "research-two", 1), RESEARCH_DOCUMENT_TAB_ID);
  assert.equal(cycleTabId(ids, RESEARCH_DOCUMENT_TAB_ID, -1), "research-two");
  assert.equal(cycleTabId(ids, "research-one", -1), RESEARCH_DOCUMENT_TAB_ID);
});

test("research cycling honours the folder scope the sidebar is filtered to", () => {
  const researchA = group("research-a", "research");
  const researchB = group("research-b", "research");
  const panes = [
    pane("pane-a", researchA.id),
    pane("pane-b", researchB.id),
  ];

  // Scoped to A: B's live terminal has no sidebar row, so it must not be
  // reachable by cycling either.
  assert.deepEqual(
    researchCycleTabIds(panes, [researchA, researchB], "tree", researchA.id),
    [RESEARCH_DOCUMENT_TAB_ID, "pane-a"],
  );
  assert.deepEqual(
    researchCycleTabIds(panes, [researchA, researchB], "tree", ALL_RESEARCH_SCOPE),
    [RESEARCH_DOCUMENT_TAB_ID, "pane-a", "pane-b"],
  );
});

test("a stored folder scope resolves to itself only while the workspace is live", () => {
  const researchA = group("research-a", "research");
  const researchB = group("research-b", "research");

  assert.equal(resolveResearchScope("research-a", [researchA, researchB]), "research-a");
  assert.equal(resolveResearchScope("research-a", [researchB]), ALL_RESEARCH_SCOPE);
  assert.equal(resolveResearchScope("research-a", []), ALL_RESEARCH_SCOPE);
  assert.equal(resolveResearchScope(null, [researchA]), ALL_RESEARCH_SCOPE);
  assert.equal(resolveResearchScope("all", [researchA]), ALL_RESEARCH_SCOPE);
});

function treeSummary(id: string, workspaceId: string): ResearchTreeSummary {
  return {
    id,
    title: id,
    rootNodeId: `${id}-root`,
    workspaceId,
    runningCount: 0,
    failedCount: 0,
    completedCount: 1,
    cancelledCount: 0,
    updatedAt: 1,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
  };
}

test("folder scoping filters trees and 'all' passes them through untouched", () => {
  const trees = [
    treeSummary("tree-1", "research-a"),
    treeSummary("tree-2", "research-b"),
    treeSummary("tree-3", "research-a"),
  ];

  assert.equal(treesForResearchScope(trees, ALL_RESEARCH_SCOPE), trees);
  assert.deepEqual(
    treesForResearchScope(trees, "research-a").map(({ id }) => id),
    ["tree-1", "tree-3"],
  );
  assert.deepEqual(treesForResearchScope(trees, "research-c"), []);
});

test("research restoration never crosses the selected folder scope", () => {
  const trees = [
    treeSummary("tree-1", "research-a"),
    treeSummary("tree-2", "research-b"),
  ];

  assert.equal(treeForResearchScope(trees, "research-b", "tree-1")?.id, "tree-2");
  assert.equal(treeForResearchScope(trees, "research-c", "tree-1"), null);
  assert.equal(treeForResearchScope(trees, ALL_RESEARCH_SCOPE, "tree-1")?.id, "tree-1");
  assert.equal(workspaceIsInResearchScope("research-a", "research-a"), true);
  assert.equal(workspaceIsInResearchScope("research-a", "research-b"), false);
  assert.equal(workspaceIsInResearchScope("research-a", ALL_RESEARCH_SCOPE), true);
});

test("the next-tree fallback stays inside the scoped folder", () => {
  const trees = [
    treeSummary("tree-1", "research-a"),
    treeSummary("tree-2", "research-b"),
    treeSummary("tree-3", "research-a"),
  ];

  assert.equal(nextTreeInResearchScope(trees, "research-a", "tree-1")?.id, "tree-3");
  // The only tree in scope going away leaves the folder empty rather than
  // jumping to another folder's tree.
  assert.equal(nextTreeInResearchScope(trees, "research-b", "tree-2"), null);
  assert.equal(nextTreeInResearchScope(trees, ALL_RESEARCH_SCOPE, "tree-1")?.id, "tree-2");
});
