import type { ResearchTreeSummary } from "../types";

/** Moves one id to a gap in the original list (0..length), matching the
 * pointer-drop coordinates used by terminal tab reordering. */
export function moveResearchTreeIdToGap(
  ids: string[],
  treeId: string,
  gapIndex: number,
): string[] {
  const fromIndex = ids.indexOf(treeId);
  if (fromIndex < 0 || gapIndex < 0 || gapIndex > ids.length) {
    return ids;
  }
  if (gapIndex === fromIndex || gapIndex === fromIndex + 1) {
    return ids;
  }
  const withoutTree = ids.filter((id) => id !== treeId);
  const insertIndex = Math.max(
    0,
    Math.min(gapIndex > fromIndex ? gapIndex - 1 : gapIndex, withoutTree.length),
  );
  return [
    ...withoutTree.slice(0, insertIndex),
    treeId,
    ...withoutTree.slice(insertIndex),
  ];
}

/** Replaces one folder's relative order inside an active or archived master
 * list without disturbing the slots occupied by other folders. */
export function replaceResearchTreeScopeOrder(
  trees: ResearchTreeSummary[],
  workspaceId: string,
  orderedTreeIds: string[],
): ResearchTreeSummary[] {
  const scopedTrees = trees.filter((tree) => tree.workspaceId === workspaceId);
  if (scopedTrees.length !== orderedTreeIds.length) {
    return trees;
  }
  const byId = new Map(scopedTrees.map((tree) => [tree.id, tree]));
  if (
    new Set(orderedTreeIds).size !== orderedTreeIds.length ||
    orderedTreeIds.some((treeId) => !byId.has(treeId))
  ) {
    return trees;
  }
  const replacements = orderedTreeIds.map((treeId) => byId.get(treeId)!);
  let replacementIndex = 0;
  return trees.map((tree) =>
    tree.workspaceId === workspaceId ? replacements[replacementIndex++] : tree,
  );
}

export function moveResearchTreeIdBy(
  ids: string[],
  treeId: string,
  direction: -1 | 1,
): string[] {
  const fromIndex = ids.indexOf(treeId);
  const toIndex = fromIndex + direction;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= ids.length) {
    return ids;
  }
  const next = [...ids];
  [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
  return next;
}
