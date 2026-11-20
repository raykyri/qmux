import assert from "node:assert/strict";
import test from "node:test";
import {
  activeSidebarScrollRegion,
  sidebarScrollRegionsForMode,
} from "../src/lib/sidebarControls";

test("tracks every independent scroll region in each sidebar mode", () => {
  assert.deepEqual(sidebarScrollRegionsForMode("terminal"), ["terminal"]);
  assert.deepEqual(sidebarScrollRegionsForMode("research"), [
    "research",
    "researchTerminals",
  ]);
});

test("selects the scroll region containing the active sidebar row", () => {
  assert.equal(activeSidebarScrollRegion("terminal", "pane"), "terminal");
  assert.equal(activeSidebarScrollRegion("research", "research"), "research");
  assert.equal(activeSidebarScrollRegion("research", "pane"), "researchTerminals");
});
