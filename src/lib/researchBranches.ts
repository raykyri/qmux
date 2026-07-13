import type { ResearchNode } from "../types";

export interface ResearchBranchInfo {
  nodeIds: string[];
  descendantCount: number;
  hasActiveRuns: boolean;
}

export function researchBranchInfo(
  nodes: ResearchNode[],
  rootNodeId: string,
): ResearchBranchInfo | null {
  if (!nodes.some((node) => node.id === rootNodeId)) {
    return null;
  }
  const nodeIds = new Set([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (
        !nodeIds.has(node.id) &&
        node.parentNodeId &&
        nodeIds.has(node.parentNodeId)
      ) {
        nodeIds.add(node.id);
        changed = true;
      }
    }
  }
  const branchNodes = nodes.filter((node) => nodeIds.has(node.id));
  return {
    nodeIds: branchNodes.map((node) => node.id),
    descendantCount: Math.max(0, branchNodes.length - 1),
    hasActiveRuns: branchNodes.some(
      (node) =>
        node.paneId != null || ["queued", "starting", "running"].includes(node.status),
    ),
  };
}
