import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RESEARCH_HISTORY,
  canGoBack,
  canGoForward,
  initResearchHistory,
  pushResearchHistory,
  researchHistoryBack,
  researchHistoryForward,
  researchSwipeDirection,
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
