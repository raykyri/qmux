import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterStartupPaint, loadInitialWorkspace, reconcileStartupArtifacts, reconcileStartupDrafts, startupResearchPane } from "../src/lib/startupHydration";
import type { ArtifactInfo, PaneInfo, GroupInfo } from "../src/types";

const dom = new JSDOM("<!doctype html>", { url: "http://localhost" });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
Object.assign(globalThis, {
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
});
afterEach(() => { clearMocks(); frames.clear(); });
after(() => dom.window.close());

test("initial workspace never requests archive, activity, or other secondary content", async () => {
  const calls: { command: string; args: unknown }[] = [];
  const core = new Set(["get_runtime_config", "launcher_adapter_preference_get", "active_tab_get", "list_groups", "list_panes", "pane_splits_get", "list_agents", "list_research_trees", "list_research_folders"]);
  mockIPC((command, args) => {
    calls.push({ command, args });
    // A secondary request would remain unresolved, preventing boot from completing.
    if (!core.has(command)) return new Promise(() => {});
    if (command === "get_runtime_config") return { adapters: [] };
    if (command === "active_tab_get") return "pane-selected";
    return [];
  });
  const workspace = await loadInitialWorkspace();
  assert.equal(workspace.activeTabId, "pane-selected");
  assert.equal(calls.length, 9);
  assert.deepEqual(calls.find(call => call.command === "list_research_trees")?.args, { includeArchived: false });
});

test("secondary work yields a painted frame, runs once, and can be cancelled", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  const cancel = afterStartupPaint(() => runs++);
  t.mock.timers.tick(0);
  assert.equal(runs, 0);
  for (const frame of [...frames.values()]) frame(0);
  assert.equal(runs, 0);
  t.mock.timers.tick(0);
  assert.equal(runs, 1);
  t.mock.timers.tick(250);
  assert.equal(runs, 1);
  cancel();
  const cancelNext = afterStartupPaint(() => runs++);
  cancelNext();
  t.mock.timers.tick(250);
  assert.equal(runs, 1);
  assert.equal(frames.size, 0);
});

test("hidden windows still hydrate without an animation frame", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  afterStartupPaint(() => runs++);
  t.mock.timers.tick(250);
  assert.equal(runs, 1);
  assert.equal(frames.size, 0);
});

test("late artifact snapshots preserve additions, replacements, and removals", () => {
  const entry = (id: string, createdAt: number): ArtifactInfo => ({ id, createdAt, paneId: "pane-1", groupId: "group-1" });
  const added = entry("added", 3);
  const updated = entry("updated", 4);
  const result = reconcileStartupArtifacts([entry("removed", 1), entry("updated", 2), entry("kept", 0)], new Map([
    ["removed", null], ["added", added], ["updated", updated],
  ]));
  assert.deepEqual(result.map(item => item.id), ["kept", "added", "updated"]);
  assert.equal(result[2], updated);
});

test("cleared or submitted drafts stay empty when an older snapshot arrives", () => {
  const restored = reconcileStartupDrafts(
    { cleared: "saved text", submitted: "sent prompt", edited: "old", untouched: "keep" },
    { edited: "new text" },
    new Map([["cleared", ""], ["submitted", ""], ["edited", "new text"]]),
  );
  assert.deepEqual(restored, { edited: "new text", untouched: "keep" });
});

test("Research startup rejects terminal and out-of-folder panes before loading detail", () => {
  const terminal = { id: "terminal", groupId: "terminal-group" } as PaneInfo;
  const research = { id: "research", groupId: "research-group" } as PaneInfo;
  const groups = [
    { id: "terminal-group", scope: "terminal" },
    { id: "research-group", scope: "research" },
  ] as GroupInfo[];
  assert.equal(startupResearchPane("terminal", [terminal, research], groups, "research-group"), null);
  assert.equal(startupResearchPane("research", [terminal, research], groups, "another-folder"), null);
  assert.equal(startupResearchPane("missing", [terminal, research], groups, "research-group"), null);
  // A valid saved Research terminal is preserved independently of whether its
  // document fetch later succeeds, fails, or is invalidated by a live update.
  assert.equal(startupResearchPane("research", [terminal, research], groups, "research-group"), research);
});
