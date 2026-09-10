import type { ResearchNode, ResearchTreeDetail } from "../types";
import { inlineChainFor } from "../lib/researchThreads";

/** Full ancestry of a selected branch; the tree landing opens its inline tail. */
export function conversationPath(
  detail: ResearchTreeDetail,
  selectedId?: string,
): ResearchNode[] {
  const byId = new Map(detail.nodes.map((node) => [node.id, node]));
  const initial =
    selectedId ??
    inlineChainFor(detail.nodes, detail.tree.rootNodeId).slice(-1)[0] ??
    detail.tree.rootNodeId;
  let node = byId.get(initial);
  if (!node) throw new Error("This research node no longer exists");
  const seen = new Set<string>();
  const path: ResearchNode[] = [];
  while (node && !seen.has(node.id)) {
    path.unshift(node);
    seen.add(node.id);
    node = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
  }
  return path;
}

export function researchRoute(treeId: string, nodeId?: string) {
  return `/research/${encodeURIComponent(treeId)}${nodeId ? `/node/${encodeURIComponent(nodeId)}` : ""}`;
}
