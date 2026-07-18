import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchTreeSummary } from "../src/types";
import {
  RESEARCH_FOLDERS_STORAGE_KEY,
  addTreesToResearchFolder,
  loadResearchFolderState,
  removeTreesFromResearchFolderMembership,
  setResearchFolderCollapsed,
  translateResearchGapAfterInsertion,
  visibleResearchTreeIds,
  type ResearchFolderState,
} from "../src/lib/researchFolders";

function tree(id: string): ResearchTreeSummary {
  return {
    id,
    title: id,
    rootNodeId: `${id}-root`,
    kind: "run",
    workspaceId: "workspace-1",
    runningCount: 0,
    failedCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    updatedAt: 0,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
  };
}

function state(): ResearchFolderState {
  return {
    folders: [
      { id: "folder-a", name: "A", workspaceId: "workspace-1" },
      { id: "folder-b", name: "B", workspaceId: "workspace-1" },
    ],
    membership: { one: "folder-a", two: "folder-a", three: "folder-b" },
    starred: ["one", "folder-a"],
    collapsed: ["folder-a"],
  };
}

test("legacy folder state loads with expanded folders", () => {
  const stored = new Map<string, string>();
  stored.set(
    RESEARCH_FOLDERS_STORAGE_KEY,
    JSON.stringify({
      folders: [{ id: "folder-a", name: "A", workspaceId: "workspace-1" }],
      membership: { one: "folder-a" },
      starred: [],
    }),
  );
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
  } as Storage;

  assert.deepEqual(loadResearchFolderState().collapsed, []);
});

test("collapse state toggles idempotently", () => {
  const initial = state();
  assert.equal(setResearchFolderCollapsed(initial, "folder-a", true), initial);
  const expanded = setResearchFolderCollapsed(initial, "folder-a", false);
  assert.deepEqual(expanded.collapsed, []);
  assert.equal(setResearchFolderCollapsed(expanded, "missing", true), expanded);
});

test("collapsed folders hide members from the visible research order", () => {
  const initial = state();
  assert.deepEqual(
    visibleResearchTreeIds([tree("one"), tree("two"), tree("three"), tree("four")], initial),
    ["one", "three", "four"],
  );
});

test("unfoldering preserves item stars and prunes an empty folder", () => {
  const initial = state();
  const next = removeTreesFromResearchFolderMembership(initial, ["one", "two"]);
  assert.deepEqual(next.membership, { three: "folder-b" });
  assert.deepEqual(next.folders.map((folder) => folder.id), ["folder-b"]);
  assert.deepEqual(next.starred, ["one"]);
  assert.deepEqual(next.collapsed, []);
});

test("moving the last member to another folder removes the empty source folder", () => {
  const initial = state();
  const next = addTreesToResearchFolder(initial, "folder-a", ["three"]);
  assert.deepEqual(next.membership, {
    one: "folder-a",
    two: "folder-a",
    three: "folder-a",
  });
  assert.deepEqual(next.folders.map((folder) => folder.id), ["folder-a"]);
});

test("pre-insertion drop gaps account for the inserted item's temporary slot", () => {
  assert.equal(translateResearchGapAfterInsertion(2, 0), 3);
  assert.equal(translateResearchGapAfterInsertion(2, 1), 3);
  assert.equal(translateResearchGapAfterInsertion(2, 2), 2);
  assert.equal(translateResearchGapAfterInsertion(0, 2), 0);
  assert.equal(translateResearchGapAfterInsertion(2, -1), 2);
});
