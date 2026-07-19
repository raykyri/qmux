// Chain math for inline follow-ups: the linear "thread spine" a research
// document renders when follow-ups continue an answer in place instead of
// branching into rail cards. A node has at most one existing inline child
// (enforced by the backend under its model lock); these helpers only read
// whatever node list they are given, so a malformed graph degrades to
// shorter chains rather than throwing.

import type { ResearchNode } from "../types";

/** The unique inline child of a node, or null. Duplicate inline children
 * cannot be created, but a corrupted store could hold them; the oldest wins
 * (stable across renders) so the thread never flickers between spines. */
export function inlineChildOf(nodes: ResearchNode[], nodeId: string): ResearchNode | null {
  let child: ResearchNode | null = null;
  for (const node of nodes) {
    if (node.parentNodeId === nodeId && node.inline) {
      if (!child || node.createdAt < child.createdAt || (node.createdAt === child.createdAt && node.id < child.id)) {
        child = node;
      }
    }
  }
  return child;
}

/** Ordered node ids of the inline chain containing nodeId: walk up parent
 * links while the current node is inline, then down through inline children.
 * Every node is a chain of at least itself. Cycle-guarded with visited sets
 * so a malformed graph cannot hang the renderer. */
export function inlineChainFor(nodes: ResearchNode[], nodeId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let head = byId.get(nodeId);
  if (!head) {
    return [nodeId];
  }
  const visited = new Set<string>([head.id]);
  while (head.inline && head.parentNodeId) {
    const parent = byId.get(head.parentNodeId);
    if (!parent || visited.has(parent.id)) {
      break;
    }
    visited.add(parent.id);
    head = parent;
  }
  const chain = [head.id];
  const seen = new Set<string>([head.id]);
  let current = head;
  for (;;) {
    const next = inlineChildOf(nodes, current.id);
    if (!next || seen.has(next.id)) {
      break;
    }
    seen.add(next.id);
    chain.push(next.id);
    current = next;
  }
  return chain;
}

/** Whether the thread composer can continue from this tail node: complete,
 * inline slot free, and — for run nodes, whose follow-ups fork the native
 * session — the session checkpoint recorded. Documents and conversations
 * launch fresh runs that carry their content as context, so they need no
 * checkpoint. Archived-tree gating stays the caller's job, matching how
 * branch follow-ups are gated today. */
export function canContinueThread(nodes: ResearchNode[], tail: ResearchNode): boolean {
  if (tail.status !== "complete" || inlineChildOf(nodes, tail.id)) {
    return false;
  }
  const launchesFresh = tail.kind === "document" || tail.kind === "conversation";
  return launchesFresh || Boolean(tail.nativeSessionId);
}
