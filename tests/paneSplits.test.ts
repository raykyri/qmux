import test from "node:test";
import assert from "node:assert/strict";
import { selectPaneAfterClose } from "../src/lib/appHelpers";
import { movePanePromotingChildrenAdjacentToPane } from "../src/lib/paneTree";
import {
  detachPaneFromSplitMemberships,
  joinPaneSplit,
  normalizePaneSplitsForPanes,
} from "../src/lib/paneSplits";
import type { PaneInfo, PaneSplitInfo } from "../src/types";

function pane(id: string, depth = 0): PaneInfo {
  return {
    id,
    title: id,
    kind: "shell",
    groupId: "group-1",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    status: "running",
    depth,
  };
}

function panes(ids: string[]): PaneInfo[] {
  return ids.map((id) => pane(id));
}

function split(paneIds: string[]): PaneSplitInfo {
  return {
    id: "split-1",
    paneIds,
    sizes: Object.fromEntries(paneIds.map((paneId) => [paneId, 1 / paneIds.length])),
  };
}

function splitWithSizes(sizes: Record<string, number>, id = "split-1"): PaneSplitInfo {
  return {
    id,
    paneIds: Object.keys(sizes),
    sizes,
  };
}

function insertedRelativeIntent(
  anchorPaneId: string,
  position: "above" | "below",
  source: "command" | "join" | "drag-half" | "drag-divider" = "join",
  createdAt = 123,
) {
  return {
    kind: "inserted-relative" as const,
    anchorPaneId,
    position,
    source,
    createdAt,
  };
}

function assertApprox(actual: number, expected: number) {
  assert.ok(
    Math.abs(actual - expected) < 0.000001,
    `expected ${actual} to be approximately ${expected}`,
  );
}

test("normalizePaneSplitsForPanes preserves a split after its top pane closes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    panes(["pane-2", "pane-3", "pane-4"]),
  );

  assert.deepEqual(normalized.map((candidate) => candidate.paneIds), [["pane-2", "pane-3"]]);
});

test("normalizePaneSplitsForPanes preserves a split after its middle pane closes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    panes(["pane-1", "pane-3", "pane-4"]),
  );

  assert.deepEqual(normalized.map((candidate) => candidate.paneIds), [["pane-1", "pane-3"]]);
});

test("normalizePaneSplitsForPanes preserves a split after its bottom pane closes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    panes(["pane-1", "pane-2", "pane-4"]),
  );

  assert.deepEqual(normalized.map((candidate) => candidate.paneIds), [["pane-1", "pane-2"]]);
});

test("normalizePaneSplitsForPanes drops a split when fewer than two panes remain", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2"])],
    panes(["pane-1", "pane-3"]),
  );

  assert.deepEqual(normalized, []);
});

test("normalizePaneSplitsForPanes prunes split intent for missing panes and anchors", () => {
  const normalized = normalizePaneSplitsForPanes(
    [
      {
        ...split(["pane-1", "pane-2", "pane-3"]),
        intent: {
          "pane-2": insertedRelativeIntent("pane-1", "below", "command", 1),
          "pane-3": insertedRelativeIntent("pane-missing", "below", "drag-half", 2),
          "pane-missing": insertedRelativeIntent("pane-1", "below", "join", 3),
        },
      },
    ],
    panes(["pane-1", "pane-2"]),
  );

  assert.deepEqual(normalized[0].intent, {
    "pane-2": insertedRelativeIntent("pane-1", "below", "command", 1),
  });
});

test("normalizePaneSplitsForPanes still rejects non-contiguous remaining panes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    panes(["pane-1", "pane-4", "pane-3"]),
  );

  assert.deepEqual(normalized, []);
});

test("selectPaneAfterClose prefers the next split pane when closing the top split pane", () => {
  assert.equal(
    selectPaneAfterClose(panes(["pane-outside", "pane-1", "pane-2"]), "pane-1", [
      split(["pane-1", "pane-2"]),
    ]),
    "pane-2",
  );
});

test("selectPaneAfterClose prefers a previous split pane when closing middle or bottom panes", () => {
  const currentPanes = panes(["pane-1", "pane-2", "pane-3", "pane-outside"]);
  const currentSplits = [split(["pane-1", "pane-2", "pane-3"])];

  assert.equal(selectPaneAfterClose(currentPanes, "pane-2", currentSplits), "pane-1");
  assert.equal(selectPaneAfterClose(currentPanes, "pane-3", currentSplits), "pane-2");
});

test("selectPaneAfterClose skips stale split members before leaving the split", () => {
  assert.equal(
    selectPaneAfterClose(panes(["pane-outside", "pane-1", "pane-3"]), "pane-1", [
      split(["pane-1", "pane-missing", "pane-3"]),
    ]),
    "pane-3",
  );
});

test("selectPaneAfterClose falls back to neighboring tabs outside a split", () => {
  assert.equal(selectPaneAfterClose(panes(["pane-1", "pane-2", "pane-3"]), "pane-2"), "pane-1");
});

test("movePanePromotingChildrenAdjacentToPane moves a leaf below a target at the target depth", () => {
  const moved = movePanePromotingChildrenAdjacentToPane(
    [pane("pane-1"), pane("pane-2", 1), pane("pane-3"), pane("pane-4")],
    "pane-4",
    "pane-2",
    "below",
  );

  assert.deepEqual(
    moved.map((candidate) => [candidate.id, candidate.depth ?? 0]),
    [
      ["pane-1", 0],
      ["pane-2", 1],
      ["pane-4", 1],
      ["pane-3", 0],
    ],
  );
});

test("movePanePromotingChildrenAdjacentToPane promotes dragged pane descendants in place", () => {
  const moved = movePanePromotingChildrenAdjacentToPane(
    [
      pane("pane-1"),
      pane("pane-2"),
      pane("pane-2-child", 1),
      pane("pane-2-grandchild", 2),
      pane("pane-3"),
    ],
    "pane-2",
    "pane-3",
    "below",
  );

  assert.deepEqual(
    moved.map((candidate) => [candidate.id, candidate.depth ?? 0]),
    [
      ["pane-1", 0],
      ["pane-2-child", 0],
      ["pane-2-grandchild", 1],
      ["pane-3", 0],
      ["pane-2", 0],
    ],
  );
});

test("movePanePromotingChildrenAdjacentToPane refuses to drop onto a descendant", () => {
  const panes = [pane("pane-1"), pane("pane-2", 1), pane("pane-3")];

  assert.strictEqual(
    movePanePromotingChildrenAdjacentToPane(panes, "pane-1", "pane-2", "below"),
    panes,
  );
});

test("joinPaneSplit inserts a dragged pane into an existing split after reordering", () => {
  const orderedPanes = movePanePromotingChildrenAdjacentToPane(
    panes(["pane-1", "pane-2", "pane-3"]),
    "pane-3",
    "pane-1",
    "below",
  );
  const joined = joinPaneSplit(
    detachPaneFromSplitMemberships([split(["pane-1", "pane-2"])], "pane-3"),
    orderedPanes,
    "pane-1",
    "pane-3",
  );

  assert.deepEqual(joined.map((candidate) => candidate.paneIds), [
    ["pane-1", "pane-3", "pane-2"],
  ]);
});

test("joinPaneSplit records inserted pane intent", () => {
  const joined = joinPaneSplit([], panes(["pane-1", "pane-2"]), "pane-1", "pane-2", {
    insertedPaneId: "pane-2",
    source: "command",
    createdAt: 456,
  });

  assert.deepEqual(joined[0].intent, {
    "pane-2": insertedRelativeIntent("pane-1", "below", "command", 456),
  });
});

test("joinPaneSplit preserves existing split intent when inserting another pane", () => {
  const joined = joinPaneSplit(
    [
      {
        ...splitWithSizes({ "pane-1": 0.5, "pane-2": 0.5 }),
        intent: {
          "pane-2": insertedRelativeIntent("pane-1", "below", "command", 1),
        },
      },
    ],
    panes(["pane-1", "pane-2", "pane-3"]),
    "pane-2",
    "pane-3",
    {
      insertedPaneId: "pane-3",
      source: "drag-half",
      createdAt: 2,
    },
  );

  assert.deepEqual(joined[0].intent, {
    "pane-2": insertedRelativeIntent("pane-1", "below", "command", 1),
    "pane-3": insertedRelativeIntent("pane-2", "below", "drag-half", 2),
  });
});

test("joinPaneSplit preserves existing split proportions when inserting a pane", () => {
  const joined = joinPaneSplit(
    [splitWithSizes({ "pane-1": 0.75, "pane-2": 0.25 })],
    panes(["pane-1", "pane-3", "pane-2"]),
    "pane-1",
    "pane-3",
  );
  const sizes = joined[0].sizes;

  assert.deepEqual(joined.map((candidate) => candidate.paneIds), [
    ["pane-1", "pane-3", "pane-2"],
  ]);
  assertApprox(sizes["pane-1"], 0.5);
  assertApprox(sizes["pane-3"], 1 / 3);
  assertApprox(sizes["pane-2"], 1 / 6);
});

test("joinPaneSplit preserves each split's proportions when merging split groups", () => {
  const joined = joinPaneSplit(
    [
      splitWithSizes({ "pane-1": 0.75, "pane-2": 0.25 }, "split-1"),
      splitWithSizes({ "pane-3": 0.6, "pane-4": 0.4 }, "split-2"),
    ],
    panes(["pane-1", "pane-2", "pane-3", "pane-4"]),
    "pane-2",
    "pane-3",
  );
  const sizes = joined[0].sizes;

  assert.deepEqual(joined.map((candidate) => candidate.paneIds), [
    ["pane-1", "pane-2", "pane-3", "pane-4"],
  ]);
  assertApprox(sizes["pane-1"], 0.375);
  assertApprox(sizes["pane-2"], 0.125);
  assertApprox(sizes["pane-3"], 0.3);
  assertApprox(sizes["pane-4"], 0.2);
});

test("joinPaneSplit joins a dragged parent after promoting its descendants", () => {
  const orderedPanes = movePanePromotingChildrenAdjacentToPane(
    [pane("pane-1"), pane("pane-2"), pane("pane-2-child", 1), pane("pane-3")],
    "pane-2",
    "pane-3",
    "below",
  );
  const joined = joinPaneSplit([], orderedPanes, "pane-3", "pane-2");

  assert.deepEqual(
    orderedPanes.map((candidate) => [candidate.id, candidate.depth ?? 0]),
    [
      ["pane-1", 0],
      ["pane-2-child", 0],
      ["pane-3", 0],
      ["pane-2", 0],
    ],
  );
  assert.deepEqual(joined.map((candidate) => candidate.paneIds), [["pane-3", "pane-2"]]);
});

test("detachPaneFromSplitMemberships lets a pane reorder within its existing split", () => {
  const orderedPanes = movePanePromotingChildrenAdjacentToPane(
    panes(["pane-1", "pane-2", "pane-3"]),
    "pane-3",
    "pane-1",
    "below",
  );
  const joined = joinPaneSplit(
    detachPaneFromSplitMemberships([split(["pane-1", "pane-2", "pane-3"])], "pane-3"),
    orderedPanes,
    "pane-1",
    "pane-3",
  );

  assert.deepEqual(joined.map((candidate) => candidate.paneIds), [
    ["pane-1", "pane-3", "pane-2"],
  ]);
});

test("detachPaneFromSplitMemberships drops intent for detached panes and detached anchors", () => {
  const detached = detachPaneFromSplitMemberships(
    [
      {
        ...split(["pane-1", "pane-2", "pane-3"]),
        intent: {
          "pane-2": insertedRelativeIntent("pane-1", "below", "command", 1),
          "pane-3": insertedRelativeIntent("pane-2", "below", "drag-half", 2),
        },
      },
    ],
    "pane-1",
  );

  assert.deepEqual(detached[0].intent, {
    "pane-3": insertedRelativeIntent("pane-2", "below", "drag-half", 2),
  });
});
