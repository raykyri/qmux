import type { PaneDropTarget } from "../appTypes";
import type { PaneInfo } from "../types";
import { paneCanMoveAcrossGroups } from "./paneTree";

// The caller checks that the pointer is inside the scrollable sidebar first.
export function computeSidebarPaneDropTarget(
  container: HTMLElement,
  clientY: number,
  dragId: string,
  panes: PaneInfo[],
  allowNewGroup: boolean,
): PaneDropTarget | null {
  const dragPane = panes.find((pane) => pane.id === dragId);
  if (!dragPane) {
    return null;
  }
  const dragGroupPanes = panes.filter((pane) => pane.groupId === dragPane.groupId);
  // Ordinary shell tabs may drop into another terminal group. Agent tabs stay
  // within their workspace because their worktree and queue state are group-bound.
  const allowCrossGroup = paneCanMoveAcrossGroups(dragGroupPanes, dragId);
  const newGroupZone = container.querySelector<HTMLElement>(".pane-new-group-drop-zone");
  if (newGroupZone && clientY >= newGroupZone.getBoundingClientRect().top) {
    return allowNewGroup && allowCrossGroup ? { kind: "new-group" } : null;
  }
  const rows = Array.from(container.querySelectorAll(".pane-tab-row")).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.classList.contains("pane-tab-row") &&
      typeof child.dataset.groupId === "string" &&
      (allowCrossGroup || child.dataset.groupId === dragPane.groupId) &&
      child.dataset.paneDragDisabled !== "true" &&
      // The fixed Home row isn't a reorder target and isn't in `panes`, so
      // excluding it keeps row indexes aligned with the group pane arrays below.
      !child.classList.contains("pane-home-row"),
  );
  if (rows.length === 0) {
    return null;
  }
  const dragIndex = dragGroupPanes.findIndex((pane) => pane.id === dragId);
  const gapTarget = (groupId: string, index: number): PaneDropTarget | null =>
    groupId === dragPane.groupId && dragIndex >= 0 && (index === dragIndex || index === dragIndex + 1)
      ? null // dropping into/adjacent to its own block is a no-op
      : { kind: "gap", groupId, index };

  // Rows arrive in DOM order, section by section, so a per-group counter recovers
  // each row's index within its own group's pane array.
  const rowCountByGroup = new Map<string, number>();
  for (const row of rows) {
    const groupId = row.dataset.groupId as string;
    const index = rowCountByGroup.get(groupId) ?? 0;
    rowCountByGroup.set(groupId, index + 1);
    const rect = row.getBoundingClientRect();
    if (clientY >= rect.bottom) {
      continue;
    }
    return gapTarget(groupId, clientY < rect.top + rect.height / 2 ? index : index + 1);
  }
  const lastGroupId = rows[rows.length - 1].dataset.groupId as string;
  return gapTarget(lastGroupId, rowCountByGroup.get(lastGroupId) ?? 0);
}
