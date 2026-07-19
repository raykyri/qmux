import assert from "node:assert/strict";
import test from "node:test";
import {
  canContinueThread,
  inlineChainFor,
  inlineChildOf,
} from "../src/lib/researchThreads";
import type { ResearchNode, ResearchNodeStatus } from "../src/types";

function node(
  id: string,
  overrides: Partial<ResearchNode> = {},
): ResearchNode {
  return {
    id,
    treeId: "tree-1",
    prompt: `Prompt ${id}`,
    adapter: "claude",
    groupId: "group-1",
    worktreeDir: "/tmp/research",
    status: "complete" as ResearchNodeStatus,
    nativeSessionId: `session-${id}`,
    createdAt: 1,
    highlights: [],
    ...overrides,
  };
}

test("a lone node is a chain of itself", () => {
  const nodes = [node("root")];
  assert.deepEqual(inlineChainFor(nodes, "root"), ["root"]);
  assert.equal(inlineChildOf(nodes, "root"), null);
});

test("an unknown node degrades to a single-entry chain", () => {
  assert.deepEqual(inlineChainFor([node("root")], "missing"), ["missing"]);
});

test("chains walk up to the head and down to the tail from any member", () => {
  const nodes = [
    node("root"),
    node("f1", { parentNodeId: "root", inline: true, createdAt: 2 }),
    node("f2", { parentNodeId: "f1", inline: true, createdAt: 3 }),
    node("branch", { parentNodeId: "root", createdAt: 2 }),
  ];
  const expected = ["root", "f1", "f2"];
  assert.deepEqual(inlineChainFor(nodes, "root"), expected);
  assert.deepEqual(inlineChainFor(nodes, "f1"), expected);
  assert.deepEqual(inlineChainFor(nodes, "f2"), expected);
});

test("branch children start their own chains", () => {
  const nodes = [
    node("root"),
    node("f1", { parentNodeId: "root", inline: true, createdAt: 2 }),
    node("branch", { parentNodeId: "root", createdAt: 2 }),
    node("branch-f1", { parentNodeId: "branch", inline: true, createdAt: 3 }),
  ];
  assert.deepEqual(inlineChainFor(nodes, "branch"), ["branch", "branch-f1"]);
  assert.deepEqual(inlineChainFor(nodes, "branch-f1"), ["branch", "branch-f1"]);
  // The branch's chain never merges into the parent chain.
  assert.deepEqual(inlineChainFor(nodes, "root"), ["root", "f1"]);
});

test("branch children never appear as inline children", () => {
  const nodes = [node("root"), node("branch", { parentNodeId: "root" })];
  assert.equal(inlineChildOf(nodes, "root"), null);
});

test("duplicate inline children resolve to the oldest, stably", () => {
  const nodes = [
    node("root"),
    node("late", { parentNodeId: "root", inline: true, createdAt: 5 }),
    node("early", { parentNodeId: "root", inline: true, createdAt: 2 }),
  ];
  assert.equal(inlineChildOf(nodes, "root")?.id, "early");
  assert.deepEqual(inlineChainFor(nodes, "root"), ["root", "early"]);
  // The orphaned duplicate still resolves its own chain through the head.
  assert.deepEqual(inlineChainFor(nodes, "late"), ["root", "early"]);
});

test("a parent-link cycle cannot hang the walk", () => {
  const nodes = [
    node("a", { parentNodeId: "b", inline: true }),
    node("b", { parentNodeId: "a", inline: true }),
  ];
  const chain = inlineChainFor(nodes, "a");
  assert.ok(chain.length >= 1 && chain.length <= 2);
});

test("canContinueThread requires completion", () => {
  for (const status of ["queued", "starting", "running", "failed", "cancelled"] as const) {
    const tail = node("tail", { status });
    assert.equal(canContinueThread([tail], tail), false);
  }
  const tail = node("tail");
  assert.equal(canContinueThread([tail], tail), true);
});

test("canContinueThread requires a free inline slot, any child status", () => {
  for (const status of [
    "queued",
    "running",
    "complete",
    "failed",
    "cancelled",
  ] as const) {
    const tail = node("tail");
    const child = node("child", { parentNodeId: "tail", inline: true, status });
    assert.equal(canContinueThread([tail, child], tail), false);
  }
  // A branch child leaves the slot free.
  const tail = node("tail");
  const branch = node("branch", { parentNodeId: "tail" });
  assert.equal(canContinueThread([tail, branch], tail), true);
});

test("run tails need the session checkpoint; documents and conversations do not", () => {
  const unforked = node("tail", { nativeSessionId: null });
  assert.equal(canContinueThread([unforked], unforked), false);
  const document = node("doc", { kind: "document", nativeSessionId: null });
  assert.equal(canContinueThread([document], document), true);
  const conversation = node("conv", { kind: "conversation", nativeSessionId: null });
  assert.equal(canContinueThread([conversation], conversation), true);
});
