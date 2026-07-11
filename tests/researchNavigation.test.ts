import assert from "node:assert/strict";
import test from "node:test";
import { isResearchNodeSelectionChange } from "../src/lib/researchNavigation";

test("clicking the currently selected research breadcrumb is a no-op", () => {
  assert.equal(isResearchNodeSelectionChange("root-node", "root-node"), false);
});

test("clicking a different research breadcrumb changes the selection", () => {
  assert.equal(isResearchNodeSelectionChange("child-node", "root-node"), true);
  assert.equal(isResearchNodeSelectionChange(null, "root-node"), true);
});
