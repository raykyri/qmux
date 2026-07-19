import type {
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "../types";

/** Research IPC payloads are JSON-shaped. Compare their serialized meaning
 * without depending on object key insertion order, and treat an omitted
 * optional field like the same field set to `undefined`. */
function sameSnapshotValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameSnapshotValue(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameSnapshotValue(leftRecord[key], rightRecord[key]),
    )
  );
}

/** Reuse unchanged records from a freshly-deserialized collection and retain
 * the collection itself when its order and contents are identical. */
function reconcileById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) {
    return current.length === 0 ? current : incoming;
  }
  if (current.length === 0) {
    return incoming;
  }
  const currentById = new Map(current.map((item) => [item.id, item]));
  let changed = current.length !== incoming.length;
  const reconciled = incoming.map((item, index) => {
    const previous = currentById.get(item.id);
    const next = previous && sameSnapshotValue(previous, item) ? previous : item;
    if (current[index] !== next) {
      changed = true;
    }
    return next;
  });
  return changed ? reconciled : current;
}

export function reconcileResearchTreeSummaries(
  current: ResearchTreeSummary[],
  incoming: ResearchTreeSummary[],
): ResearchTreeSummary[] {
  return reconcileById(current, incoming);
}

export function reconcileResearchActivity(
  current: ResearchNode[],
  incoming: ResearchNode[],
): ResearchNode[] {
  return reconcileById(current, incoming);
}

export function reconcileResearchTreeDetail(
  current: ResearchTreeDetail | null,
  incoming: ResearchTreeDetail,
): ResearchTreeDetail {
  if (!current || current.tree.id !== incoming.tree.id) {
    return incoming;
  }
  const tree = sameSnapshotValue(current.tree, incoming.tree) ? current.tree : incoming.tree;
  const nodes = reconcileById(current.nodes, incoming.nodes);
  return tree === current.tree && nodes === current.nodes ? current : { tree, nodes };
}

/** A viewed acknowledgment is normally already reflected locally. Preserve
 * list identity in that common case so it does not manufacture an App commit. */
export function clearResearchTreeAttention(
  trees: ResearchTreeSummary[],
  treeId: string,
): ResearchTreeSummary[] {
  const index = trees.findIndex(
    (tree) => tree.id === treeId && (tree.hasUnseenUpdate || tree.hasUnseenFailure),
  );
  if (index === -1) {
    return trees;
  }
  const next = [...trees];
  next[index] = {
    ...next[index],
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
  };
  return next;
}
