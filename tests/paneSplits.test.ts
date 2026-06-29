import test from "node:test";
import assert from "node:assert/strict";
import { normalizePaneSplitsForPanes } from "../src/lib/paneSplits";
import type { PaneInfo, PaneSplitInfo } from "../src/types";

function pane(id: string): PaneInfo {
  return {
    id,
    title: id,
    kind: "shell",
    groupId: "group-1",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    status: "running",
  };
}

function split(paneIds: string[]): PaneSplitInfo {
  return {
    id: "split-1",
    paneIds,
    sizes: Object.fromEntries(paneIds.map((paneId) => [paneId, 1 / paneIds.length])),
  };
}

test("normalizePaneSplitsForPanes preserves a split after its top pane closes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    ["pane-2", "pane-3", "pane-4"].map(pane),
  );

  assert.deepEqual(normalized.map((candidate) => candidate.paneIds), [["pane-2", "pane-3"]]);
});

test("normalizePaneSplitsForPanes preserves a split after its middle pane closes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    ["pane-1", "pane-3", "pane-4"].map(pane),
  );

  assert.deepEqual(normalized.map((candidate) => candidate.paneIds), [["pane-1", "pane-3"]]);
});

test("normalizePaneSplitsForPanes preserves a split after its bottom pane closes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    ["pane-1", "pane-2", "pane-4"].map(pane),
  );

  assert.deepEqual(normalized.map((candidate) => candidate.paneIds), [["pane-1", "pane-2"]]);
});

test("normalizePaneSplitsForPanes drops a split when fewer than two panes remain", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2"])],
    ["pane-1", "pane-3"].map(pane),
  );

  assert.deepEqual(normalized, []);
});

test("normalizePaneSplitsForPanes still rejects non-contiguous remaining panes", () => {
  const normalized = normalizePaneSplitsForPanes(
    [split(["pane-1", "pane-2", "pane-3"])],
    ["pane-1", "pane-4", "pane-3"].map(pane),
  );

  assert.deepEqual(normalized, []);
});
