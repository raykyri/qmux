// Research navigation restoration state (selected node and per-node scroll
// offsets, keyed by tree). Held as a module-level singleton so the workspace
// (which reads/writes selections) and the app shell (which prunes entries for
// deleted trees) mutate the same object — pruning localStorage behind a
// separate in-memory copy would just get resurrected by the next save.

export interface SavedResearchNavigation {
  selectedNodeId?: string;
  scrollByNode: Record<string, number>;
  /** Nodes whose "Show earlier" window the user expanded. Restored together
   * with the scroll offset — an offset captured against the expanded list
   * would land in the wrong place in the collapsed one. */
  expandedByNode?: Record<string, boolean>;
}

const RESEARCH_NAVIGATION_KEY = "qmux.research-navigation.v1";

let store: Record<string, SavedResearchNavigation> | null = null;

export function isResearchNodeSelectionChange(
  selectedNodeId: string | null,
  nextNodeId: string,
): boolean {
  return selectedNodeId !== nextNodeId;
}

export function isResearchTreeSelectionChange(
  selectedTreeId: string | null,
  documentVisible: boolean,
  nextTreeId: string,
): boolean {
  // Re-selecting the visible document would clear its detail while the same
  // tree is fetched again, producing a needless loading blink. The same tree
  // remains selectable when one of its terminal panes is currently visible.
  return !documentVisible || selectedTreeId !== nextTreeId;
}

function load(): Record<string, SavedResearchNavigation> {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESEARCH_NAVIGATION_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([treeId, value]) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        const candidate = value as Partial<SavedResearchNavigation>;
        const scrollByNode = Object.fromEntries(
          Object.entries(candidate.scrollByNode ?? {}).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
          ),
        );
        const expandedByNode = Object.fromEntries(
          Object.entries(candidate.expandedByNode ?? {}).filter(
            (entry): entry is [string, boolean] => entry[1] === true,
          ),
        );
        return [[treeId, {
          selectedNodeId:
            typeof candidate.selectedNodeId === "string" ? candidate.selectedNodeId : undefined,
          scrollByNode,
          ...(Object.keys(expandedByNode).length > 0 ? { expandedByNode } : {}),
        } satisfies SavedResearchNavigation]];
      }),
    );
  } catch {
    return {};
  }
}

export function researchNavigationStore(): Record<string, SavedResearchNavigation> {
  return (store ??= load());
}

export function saveResearchNavigation(): void {
  try {
    localStorage.setItem(RESEARCH_NAVIGATION_KEY, JSON.stringify(researchNavigationStore()));
  } catch {
    // Navigation restoration is a convenience; storage denial must not break research.
  }
}

/** Drops navigation state for trees that no longer exist. */
export function pruneResearchNavigation(validTreeIds: Iterable<string>): void {
  const valid = new Set(validTreeIds);
  const current = researchNavigationStore();
  let changed = false;
  for (const treeId of Object.keys(current)) {
    if (!valid.has(treeId)) {
      delete current[treeId];
      changed = true;
    }
  }
  if (changed) {
    saveResearchNavigation();
  }
}

/** Drops per-node state (scroll offsets, selection) for deleted nodes of a tree. */
export function pruneResearchNavigationNodes(treeId: string, validNodeIds: Iterable<string>): void {
  const navigation = researchNavigationStore()[treeId];
  if (!navigation) {
    return;
  }
  const valid = new Set(validNodeIds);
  let changed = false;
  for (const nodeId of Object.keys(navigation.scrollByNode)) {
    if (!valid.has(nodeId)) {
      delete navigation.scrollByNode[nodeId];
      changed = true;
    }
  }
  for (const nodeId of Object.keys(navigation.expandedByNode ?? {})) {
    if (!valid.has(nodeId)) {
      delete navigation.expandedByNode?.[nodeId];
      changed = true;
    }
  }
  if (navigation.selectedNodeId && !valid.has(navigation.selectedNodeId)) {
    delete navigation.selectedNodeId;
    changed = true;
  }
  if (changed) {
    saveResearchNavigation();
  }
}
