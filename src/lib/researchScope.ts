import type { GroupInfo, ResearchTreeSummary } from "../types";

// The research sidebar shows one folder (Research workspace) at a time, or all
// of them. "all" is also the recovery value whenever a stored scope no longer
// names a live research workspace (folder removed, stale persistence).
export type ResearchFolderScope = "all" | string;

export const ALL_RESEARCH_SCOPE: ResearchFolderScope = "all";

export function resolveResearchScope(
  stored: string | null,
  researchGroups: GroupInfo[],
): ResearchFolderScope {
  if (!stored || stored === ALL_RESEARCH_SCOPE) {
    return ALL_RESEARCH_SCOPE;
  }
  return researchGroups.some((group) => group.id === stored) ? stored : ALL_RESEARCH_SCOPE;
}

export function treesForResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
): ResearchTreeSummary[] {
  if (scope === ALL_RESEARCH_SCOPE) {
    return trees;
  }
  return trees.filter((tree) => tree.workspaceId === scope);
}

export function workspaceIsInResearchScope(
  workspaceId: string,
  scope: ResearchFolderScope,
): boolean {
  return scope === ALL_RESEARCH_SCOPE || workspaceId === scope;
}

export function treeForResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
  preferredTreeId: string | null,
): ResearchTreeSummary | null {
  const scoped = treesForResearchScope(trees, scope);
  return scoped.find((tree) => tree.id === preferredTreeId) ?? scoped[0] ?? null;
}

// The tree selection should stay inside the current folder when the active
// tree is archived or deleted, rather than jumping to another folder's tree.
export function nextTreeInResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
  excludeTreeId: string,
): ResearchTreeSummary | null {
  return (
    treesForResearchScope(trees, scope).find((tree) => tree.id !== excludeTreeId) ?? null
  );
}
