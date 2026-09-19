import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RESEARCH_HISTORY,
  canGoBack,
  canGoForward,
  canGoWorkspaceBack,
  canGoWorkspaceForward,
  initResearchHistory,
  initResearchWorkspaceHistory,
  pushResearchHistory,
  pushResearchWorkspaceHistory,
  pruneResearchHistory,
  pruneResearchWorkspaceHistory,
  researchHistoryBack,
  researchHistoryForward,
  researchSwipeDirection,
  researchSwipeTailCapturesWheel,
  researchWorkspaceHistoryBack,
  researchWorkspaceHistoryForward,
} from "../src/lib/researchHistory";

test("empty history can go neither way", () => {
  assert.equal(canGoBack(EMPTY_RESEARCH_HISTORY), false);
  assert.equal(canGoForward(EMPTY_RESEARCH_HISTORY), false);
  assert.equal(researchHistoryBack(EMPTY_RESEARCH_HISTORY), null);
  assert.equal(researchHistoryForward(EMPTY_RESEARCH_HISTORY), null);
});

test("init roots the history at the entry node", () => {
  assert.deepEqual(initResearchHistory("root"), { entries: ["root"], index: 0 });
  assert.equal(initResearchHistory(null), EMPTY_RESEARCH_HISTORY);
});

test("a single-entry history cannot navigate", () => {
  const history = initResearchHistory("root");
  assert.equal(canGoBack(history), false);
  assert.equal(canGoForward(history), false);
});

test("push appends and advances the cursor to the end", () => {
  let history = initResearchHistory("a");
  history = pushResearchHistory(history, "b");
  history = pushResearchHistory(history, "c");
  assert.deepEqual(history, { entries: ["a", "b", "c"], index: 2 });
  assert.equal(canGoBack(history), true);
  assert.equal(canGoForward(history), false);
});

test("back then forward returns to the same node", () => {
  let history = pushResearchHistory(initResearchHistory("a"), "b");
  const back = researchHistoryBack(history);
  assert.ok(back);
  assert.equal(back.nodeId, "a");
  assert.deepEqual(back.history, { entries: ["a", "b"], index: 0 });

  const forward = researchHistoryForward(back.history);
  assert.ok(forward);
  assert.equal(forward.nodeId, "b");
  assert.deepEqual(forward.history, { entries: ["a", "b"], index: 1 });
});

test("pushing after going back truncates the forward entries", () => {
  // a -> b -> c, step back to b, then branch to d: c must be discarded.
  let history = pushResearchHistory(pushResearchHistory(initResearchHistory("a"), "b"), "c");
  const back = researchHistoryBack(history);
  assert.ok(back);
  assert.equal(back.nodeId, "b");
  const branched = pushResearchHistory(back.history, "d");
  assert.deepEqual(branched, { entries: ["a", "b", "d"], index: 2 });
  assert.equal(canGoForward(branched), false);
});

test("push does not mutate the prior history value", () => {
  const before = initResearchHistory("a");
  const after = pushResearchHistory(before, "b");
  assert.deepEqual(before, { entries: ["a"], index: 0 });
  assert.notEqual(before.entries, after.entries);
});

test("horizontal wheel gestures resolve only after clear dominant travel", () => {
  assert.equal(researchSwipeDirection(-79, 0), 0);
  assert.equal(researchSwipeDirection(79, 0), 0);
  assert.equal(researchSwipeDirection(-100, 90), 0);
  assert.equal(researchSwipeDirection(100, 90), 0);
  assert.equal(researchSwipeDirection(-100, 20), -1);
  assert.equal(researchSwipeDirection(100, 20), 1);
});

test("pruning deleted visits preserves the surviving cursor position", () => {
  const history = { entries: ["root", "branch", "leaf", "root"], index: 2 };
  assert.deepEqual(pruneResearchHistory(history, new Set(["root"]), "root"), {
    entries: ["root"],
    index: 0,
  });
});

test("pruning keeps the cursor on a later surviving visit", () => {
  const history = { entries: ["root", "branch", "leaf"], index: 1 };
  assert.deepEqual(pruneResearchHistory(history, new Set(["root", "leaf"]), "root"), {
    entries: ["root", "leaf"],
    index: 0,
  });
});

test("pruning collapses visits that become adjacent duplicates", () => {
  // root -> branch -> back to root, then branch is deleted: without the
  // collapse the history reads [root, root] and Back re-applies the already
  // selected node — readers treat that as real navigation (clearing content
  // for a load that never restarts).
  const history = { entries: ["root", "branch", "root"], index: 2 };
  const pruned = pruneResearchHistory(history, new Set(["root", "other"]), "root");
  assert.deepEqual(pruned, { entries: ["root"], index: 0 });
  assert.equal(canGoBack(pruned), false);
  assert.equal(canGoForward(pruned), false);
});

test("pruning falls back when every visited node was deleted", () => {
  assert.deepEqual(
    pruneResearchHistory({ entries: ["branch", "leaf"], index: 1 }, new Set(["root"]), "root"),
    { entries: ["root"], index: 0 },
  );
});

test("opening a document from Recent Activity pushes a return visit", () => {
  let history = initResearchWorkspaceHistory({ kind: "journal" });
  history = pushResearchWorkspaceHistory(history, { kind: "document", treeId: "tree-a" });
  assert.deepEqual(history, {
    entries: [{ kind: "journal" }, { kind: "document", treeId: "tree-a" }],
    index: 1,
  });
  assert.equal(canGoWorkspaceBack(history), true);
  assert.equal(canGoWorkspaceForward(history), false);

  const back = researchWorkspaceHistoryBack(history);
  assert.ok(back);
  assert.deepEqual(back.visit, { kind: "journal" });
  const forward = researchWorkspaceHistoryForward(back.history);
  assert.ok(forward);
  assert.deepEqual(forward.visit, { kind: "document", treeId: "tree-a" });
});

test("re-opening the current workspace page does not grow the stack", () => {
  const history = initResearchWorkspaceHistory({ kind: "journal" });
  assert.equal(pushResearchWorkspaceHistory(history, { kind: "journal" }), history);
});

test("encyclopedia pages are workspace pages of their own, told apart by slug", () => {
  const journal = { kind: "journal" } as const;
  const alpha = { kind: "encyclopedia", slug: "alpha" } as const;
  const beta = { kind: "encyclopedia", slug: "beta" } as const;
  let history = initResearchWorkspaceHistory(journal);
  history = pushResearchWorkspaceHistory(history, alpha);
  // A different slug is a new page; the same slug is the page already shown, so
  // following a link to the open page must not grow the stack.
  history = pushResearchWorkspaceHistory(history, beta);
  assert.equal(pushResearchWorkspaceHistory(history, beta), history);
  assert.deepEqual(history, { entries: [journal, alpha, beta], index: 2 });

  const back = researchWorkspaceHistoryBack(history);
  assert.ok(back);
  assert.deepEqual(back.visit, alpha);
  const forward = researchWorkspaceHistoryForward(back.history);
  assert.ok(forward);
  assert.deepEqual(forward.visit, beta);
});

test("pruning removed trees keeps encyclopedia visits, which no tree owns", () => {
  const alpha = { kind: "encyclopedia", slug: "alpha" } as const;
  const docA = { kind: "document", treeId: "tree-a" } as const;
  const history = { entries: [alpha, docA], index: 0 };
  assert.deepEqual(pruneResearchWorkspaceHistory(history, () => false), {
    entries: [alpha],
    index: 0,
  });
});

test("pruning removed trees from workspace history keeps the cursor on the current page", () => {
  const journal = { kind: "journal" } as const;
  const docA = { kind: "document", treeId: "tree-a" } as const;
  const docB = { kind: "document", treeId: "tree-b" } as const;
  // Home -> A -> Home (via a shortcut) -> B, then A is archived.
  const history = { entries: [journal, docA, journal, docB], index: 3 };
  const pruned = pruneResearchWorkspaceHistory(history, (treeId) => treeId !== "tree-a");
  assert.deepEqual(pruned, { entries: [journal, docB], index: 1 });
  const back = researchWorkspaceHistoryBack(pruned);
  assert.ok(back);
  assert.deepEqual(back.visit, journal);
});

test("pruning collapses duplicate pages when an intermediate visit is removed", () => {
  const journal = { kind: "journal" } as const;
  const docA = { kind: "document", treeId: "tree-a" } as const;
  const history = { entries: [journal, docA, journal], index: 2 };
  assert.deepEqual(pruneResearchWorkspaceHistory(history, () => false), {
    entries: [journal],
    index: 0,
  });
});

test("pruning preserves the current visit and returns the same stack when unchanged", () => {
  const journal = { kind: "journal" } as const;
  const docA = { kind: "document", treeId: "tree-a" } as const;
  const history = { entries: [journal, docA], index: 1 };
  assert.equal(pruneResearchWorkspaceHistory(history, () => true), history);
  assert.deepEqual(pruneResearchWorkspaceHistory(history, () => false), history);
  const forwardStack = { entries: [journal, docA], index: 0 };
  assert.deepEqual(pruneResearchWorkspaceHistory(forwardStack, () => false), {
    entries: [journal],
    index: 0,
  });
});

test("swipe tail captures horizontal momentum per wheel event", () => {
  assert.equal(researchSwipeTailCapturesWheel(-40, 0), true);
  assert.equal(researchSwipeTailCapturesWheel(-12, 4), true);
  // Vertical scroll on the page the swipe opened is not captured.
  assert.equal(researchSwipeTailCapturesWheel(0, 30), false);
  assert.equal(researchSwipeTailCapturesWheel(4, 12), false);
  assert.equal(researchSwipeTailCapturesWheel(10, -10), false);
});
