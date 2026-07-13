import type { PaneInfo } from "../types";

// Mirror of the backend `MAX_PANE_DEPTH` (src-tauri/src/state.rs). Keep in sync.
export const MAX_PANE_DEPTH = 8;

export interface PaneLayoutItem {
  paneId: string;
  depth: number;
}

const depthOf = (pane: PaneInfo): number => pane.depth ?? 0;

export function toLayout(panes: PaneInfo[]): PaneLayoutItem[] {
  return panes.map((pane) => ({ paneId: pane.id, depth: depthOf(pane) }));
}

/** Exclusive end index of the subtree rooted at `index` (the contiguous run of
 *  following panes deeper than it). */
export function subtreeEnd(panes: PaneInfo[], index: number): number {
  const rootDepth = depthOf(panes[index]);
  let end = index + 1;
  while (end < panes.length && depthOf(panes[end]) > rootDepth) {
    end += 1;
  }
  return end;
}

/** A pane can indent only if there's a tab above it at >= its depth (a possible
 *  parent) and it isn't already at the depth cap. */
export function canIndent(panes: PaneInfo[], index: number): boolean {
  if (index <= 0 || index >= panes.length) {
    return false;
  }
  const depth = depthOf(panes[index]);
  return depth <= depthOf(panes[index - 1]) && depth < MAX_PANE_DEPTH;
}

/** A pane can outdent whenever it isn't already at the root. */
export function canOutdent(panes: PaneInfo[], index: number): boolean {
  if (index < 0 || index >= panes.length) {
    return false;
  }
  return depthOf(panes[index]) > 0;
}

/** Clamps depths to a valid tree (first 0; each <= prev + 1; capped). Mirrors the
 *  backend's normalize so the optimistic UI matches what the backend will return. */
export function normalizeDepths(panes: PaneInfo[]): PaneInfo[] {
  let prev = 0;
  return panes.map((pane, index) => {
    const ceiling = index === 0 ? 0 : Math.min(prev + 1, MAX_PANE_DEPTH);
    const depth = Math.min(Math.max(0, depthOf(pane)), ceiling);
    prev = depth;
    return depth === depthOf(pane) ? pane : { ...pane, depth };
  });
}

function shiftSubtree(panes: PaneInfo[], index: number, delta: number): PaneInfo[] {
  const end = subtreeEnd(panes, index);
  return panes.map((pane, i) =>
    i >= index && i < end ? { ...pane, depth: depthOf(pane) + delta } : pane,
  );
}

export function indentAt(panes: PaneInfo[], index: number): PaneInfo[] {
  if (!canIndent(panes, index)) {
    return panes;
  }
  return normalizeDepths(shiftSubtree(panes, index, 1));
}

export function outdentAt(panes: PaneInfo[], index: number): PaneInfo[] {
  if (!canOutdent(panes, index)) {
    return panes;
  }
  return normalizeDepths(shiftSubtree(panes, index, -1));
}

/** Splices `block` into `rest` at `insertAt`, re-depthing the block so its root sits
 *  at `rootDepth` (descendants keep their relative depth). */
function placeBlock(
  rest: PaneInfo[],
  block: PaneInfo[],
  insertAt: number,
  rootDepth: number,
): PaneInfo[] {
  const delta = rootDepth - depthOf(block[0]);
  const shifted = block.map((pane) => ({
    ...pane,
    depth: Math.max(0, depthOf(pane) + delta),
  }));
  return [...rest.slice(0, insertAt), ...shifted, ...rest.slice(insertAt)];
}

/** Nest the dragged tab (and its subtree) as the first child of `targetId`. No-op if
 *  the target is the dragged tab, lies inside its subtree, or nesting would exceed
 *  the depth cap. */
export function nestUnder(panes: PaneInfo[], dragId: string, targetId: string): PaneInfo[] {
  const from = panes.findIndex((pane) => pane.id === dragId);
  const targetIndex = panes.findIndex((pane) => pane.id === targetId);
  if (from < 0 || targetIndex < 0 || from === targetIndex) {
    return panes;
  }
  const end = subtreeEnd(panes, from);
  if (targetIndex >= from && targetIndex < end) {
    return panes; // can't nest a tab into itself or a descendant
  }
  const rootDepth = depthOf(panes[targetIndex]) + 1;
  if (rootDepth > MAX_PANE_DEPTH) {
    return panes;
  }

  const block = panes.slice(from, end);
  const rest = [...panes.slice(0, from), ...panes.slice(end)];
  // Target index within `rest` (it shifts left if it was after the removed block).
  const targetInRest = targetIndex < from ? targetIndex : targetIndex - block.length;
  return normalizeDepths(placeBlock(rest, block, targetInRest + 1, rootDepth));
}

/** Move the dragged subtree to a gap (insert-before index in the current array). The
 *  moved root becomes a sibling of the row that ends up below the gap, else the row
 *  above, else the root. No-op when the gap is inside/adjacent to the dragged block. */
export function moveToGap(panes: PaneInfo[], dragId: string, gap: number): PaneInfo[] {
  const from = panes.findIndex((pane) => pane.id === dragId);
  if (from < 0) {
    return panes;
  }
  const end = subtreeEnd(panes, from);
  if (gap >= from && gap <= end) {
    return panes; // dropping onto its own position
  }

  const block = panes.slice(from, end);
  const rest = [...panes.slice(0, from), ...panes.slice(end)];
  const insertAt = gap <= from ? gap : gap - block.length;
  const below = rest[insertAt];
  const above = rest[insertAt - 1];
  const rootDepth = below ? depthOf(below) : above ? depthOf(above) : 0;
  return normalizeDepths(placeBlock(rest, block, insertAt, rootDepth));
}

/** Moves a pane and its descendants by one sibling position without changing
 * nesting. At a nesting boundary this is a no-op, so keyboard reordering never
 * reparents a pane or crosses out of its group. */
export function movePaneSubtreeBy(
  panes: PaneInfo[],
  paneId: string,
  direction: -1 | 1,
): PaneInfo[] {
  const from = panes.findIndex((pane) => pane.id === paneId);
  if (from < 0) {
    return panes;
  }
  const rootDepth = depthOf(panes[from]);
  const end = subtreeEnd(panes, from);

  if (direction === -1) {
    let previousSibling = from - 1;
    while (previousSibling >= 0 && depthOf(panes[previousSibling]) > rootDepth) {
      previousSibling -= 1;
    }
    if (previousSibling < 0 || depthOf(panes[previousSibling]) !== rootDepth) {
      return panes;
    }
    return [
      ...panes.slice(0, previousSibling),
      ...panes.slice(from, end),
      ...panes.slice(previousSibling, from),
      ...panes.slice(end),
    ];
  }

  if (end >= panes.length || depthOf(panes[end]) !== rootDepth) {
    return panes;
  }
  const nextSiblingEnd = subtreeEnd(panes, end);
  return [
    ...panes.slice(0, from),
    ...panes.slice(end, nextSiblingEnd),
    ...panes.slice(from, end),
    ...panes.slice(nextSiblingEnd),
  ];
}

export function isLeafPane(panes: PaneInfo[], paneId: string): boolean {
  const index = panes.findIndex((pane) => pane.id === paneId);
  return index >= 0 && subtreeEnd(panes, index) === index + 1;
}

export function movePanePromotingChildrenAdjacentToPane(
  panes: PaneInfo[],
  dragId: string,
  targetId: string,
  position: "above" | "below",
): PaneInfo[] {
  const from = panes.findIndex((pane) => pane.id === dragId);
  const targetIndex = panes.findIndex((pane) => pane.id === targetId);
  if (from < 0 || targetIndex < 0 || from === targetIndex || !isLeafPane(panes, targetId)) {
    return panes;
  }

  const end = subtreeEnd(panes, from);
  if (targetIndex >= from && targetIndex < end) {
    return panes;
  }

  const dragPane = panes[from];
  const targetDepth = depthOf(panes[targetIndex]);
  const promotedDescendants = panes
    .slice(from + 1, end)
    .map((pane) => ({ ...pane, depth: Math.max(0, depthOf(pane) - 1) }));
  const rest = [
    ...panes.slice(0, from),
    ...promotedDescendants,
    ...panes.slice(end),
  ];
  const targetInRest = targetIndex < from ? targetIndex : targetIndex - 1;
  const insertAt = position === "above" ? targetInRest : targetInRest + 1;
  const moved = { ...dragPane, depth: targetDepth };
  return normalizeDepths([...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)]);
}

/** Move the dragged subtree to sit immediately after `afterId`'s subtree, re-rooting
 *  it as a sibling of `afterId` (same depth). Used to lift a tab out from between
 *  split members so the remaining members stay contiguous. No-op if either id is
 *  missing, they're the same, or the target lies inside the dragged subtree. */
export function movePaneAfterSubtree(
  panes: PaneInfo[],
  dragId: string,
  afterId: string,
): PaneInfo[] {
  const from = panes.findIndex((pane) => pane.id === dragId);
  const afterIndex = panes.findIndex((pane) => pane.id === afterId);
  if (from < 0 || afterIndex < 0 || from === afterIndex) {
    return panes;
  }
  const end = subtreeEnd(panes, from);
  if (afterIndex >= from && afterIndex < end) {
    return panes; // can't move a tab to sit after its own descendant
  }

  const block = panes.slice(from, end);
  const rest = [...panes.slice(0, from), ...panes.slice(end)];
  const afterInRest = afterIndex < from ? afterIndex : afterIndex - block.length;
  const insertAt = subtreeEnd(rest, afterInRest);
  return normalizeDepths(placeBlock(rest, block, insertAt, depthOf(rest[afterInRest])));
}
