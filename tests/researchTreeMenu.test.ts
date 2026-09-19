import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchTreeMenuItems } from "../src/components/research/ResearchTreeMenu";
import { emptyResearchFolderState } from "../src/lib/researchFolders";
import type { ResearchTreeSummary } from "../src/types";

const tree: ResearchTreeSummary = {
  id: "tree-1",
  title: "Collective memory",
  rootNodeId: "root",
  kind: "run",
  workspaceId: "workspace",
  runningCount: 0,
  failedCount: 0,
  completedCount: 2,
  cancelledCount: 0,
  updatedAt: 200,
  hasUnseenUpdate: false,
  hasUnseenFailure: false,
};

const noop = () => {};

function renderMenu(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(ResearchTreeMenuItems, {
      tree,
      archived: false,
      folderState: emptyResearchFolderState(),
      onClose: noop,
      onToggleStar: noop,
      onRename: noop,
      onArchive: noop,
      onRestore: noop,
      onDelete: noop,
      onRemoveFromFolder: noop,
      onRequestCreateFolder: noop,
      ...overrides,
    }),
  );
}

test("research tree menus expose summary regeneration only when it is offered", () => {
  const html = renderMenu({ onRegenerateSummary: noop });
  assert.match(html, /Generate summary/);
  assert.match(html, /Rename/);
  assert.match(html, /Delete/);
  // A thread whose summary cannot be replaced — an archived one, or a card with
  // no summary yet — passes no handler and gets no item.
  assert.doesNotMatch(renderMenu(), /Generate summary/);
});
