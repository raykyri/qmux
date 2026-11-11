import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { computeSidebarPaneDropTarget } from "../src/lib/sidebarPaneDropTarget";
import type { PaneInfo } from "../src/types";

const dom = new JSDOM("<!doctype html>");
Object.assign(globalThis, { HTMLElement: dom.window.HTMLElement });

const panes = [
  { id: "shell", groupId: "one", kind: "shell", agentId: null },
  { id: "agent", groupId: "one", kind: "agent", agentId: "agent-1" },
  { id: "other", groupId: "two", kind: "shell", agentId: null },
] as PaneInfo[];

function sidebar(collapsedLastGroup = false) {
  const container = dom.window.document.createElement("nav");
  container.innerHTML = `
    <section class="pane-group" data-group-id="one">
      <div class="pane-tab-row" data-group-id="one"></div>
      <div class="pane-tab-row" data-group-id="one"></div>
    </section>
    <section class="pane-group" data-group-id="two">
      ${collapsedLastGroup ? "" : '<div class="pane-tab-row" data-group-id="two"></div>'}
    </section>
    <div class="pane-new-group-drop-zone"></div>`;
  container.querySelectorAll<HTMLElement>(".pane-tab-row").forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: 20 + index * 20, bottom: 40 + index * 20, height: 20 }) as DOMRect;
  });
  container.querySelector<HTMLElement>(".pane-new-group-drop-zone")!.getBoundingClientRect =
    () => ({ top: 100, bottom: 400, height: 300 }) as DOMRect;
  return container;
}

test("dropping below all groups creates a group instead of appending to the last one", () => {
  const container = sidebar();
  for (const y of [100, 120, 399]) {
    assert.deepEqual(computeSidebarPaneDropTarget(container, y, "shell", panes, true), {
      kind: "new-group",
    });
  }
  // The lower half of the final tab still means insert into its existing group.
  assert.deepEqual(computeSidebarPaneDropTarget(container, 75, "shell", panes, true), {
    kind: "gap", groupId: "two", index: 1,
  });
});

test("new group target works below collapsed groups and for the last group's own tab", () => {
  assert.deepEqual(computeSidebarPaneDropTarget(sidebar(true), 120, "shell", panes, true), {
    kind: "new-group",
  });
  assert.deepEqual(computeSidebarPaneDropTarget(sidebar(), 120, "other", panes, true), {
    kind: "new-group",
  });
});

test("new group target rejects agent tabs, research tabs, and disappeared tabs", () => {
  const container = sidebar();
  assert.equal(computeSidebarPaneDropTarget(container, 120, "agent", panes, true), null);
  assert.equal(computeSidebarPaneDropTarget(container, 120, "shell", panes, false), null);
  assert.equal(computeSidebarPaneDropTarget(container, 120, "missing", panes, true), null);
  const attachedShell = panes.map((pane) => pane.id === "shell" ? { ...pane, agentId: "a" } : pane);
  assert.equal(computeSidebarPaneDropTarget(container, 120, "shell", attachedShell, true), null);
});

test("existing within-group reorder and no-op targets remain intact", () => {
  const container = sidebar();
  assert.equal(computeSidebarPaneDropTarget(container, 25, "shell", panes, true), null);
  assert.deepEqual(computeSidebarPaneDropTarget(container, 55, "shell", panes, true), {
    kind: "gap", groupId: "one", index: 2,
  });
});
