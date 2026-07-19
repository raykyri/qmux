import type { ResearchTreeSummary } from "../types";

// Client-side research folders: a purely organizational grouping of research
// trees layered over the backend's flat per-workspace order. The backend
// stays the source of truth for which trees exist and their relative order;
// this store only records which trees present themselves inside which folder.

export interface ResearchFolder {
  id: string;
  name: string;
  workspaceId: string;
}

export interface ResearchFolderState {
  folders: ResearchFolder[];
  /** treeId -> folderId */
  membership: Record<string, string>;
  /** Starred tree and folder ids, in the starred list's display order. */
  starred: string[];
  /** Folder ids whose member rows are hidden in the sidebar. */
  collapsed: string[];
}

export const RESEARCH_FOLDERS_STORAGE_KEY = "qmux.research-folders.v1";

export function emptyResearchFolderState(): ResearchFolderState {
  return { folders: [], membership: {}, starred: [], collapsed: [] };
}

/** No folders, memberships, stars, or collapsed flags — nothing to persist. */
export function isEmptyResearchFolderState(state: ResearchFolderState): boolean {
  return (
    state.folders.length === 0 &&
    Object.keys(state.membership).length === 0 &&
    state.starred.length === 0 &&
    state.collapsed.length === 0
  );
}

function generateFolderId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `rfolder-${uuid}`;
}

export function loadResearchFolderState(): ResearchFolderState {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(RESEARCH_FOLDERS_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return emptyResearchFolderState();
    }
    const raw = parsed as Partial<ResearchFolderState>;
    const folders = Array.isArray(raw.folders)
      ? raw.folders.filter(
          (folder): folder is ResearchFolder =>
            Boolean(folder) &&
            typeof folder === "object" &&
            typeof (folder as ResearchFolder).id === "string" &&
            typeof (folder as ResearchFolder).name === "string" &&
            typeof (folder as ResearchFolder).workspaceId === "string",
        )
      : [];
    const folderIds = new Set(folders.map((folder) => folder.id));
    const membership: Record<string, string> = {};
    if (raw.membership && typeof raw.membership === "object") {
      for (const [treeId, folderId] of Object.entries(raw.membership)) {
        if (typeof folderId === "string" && folderIds.has(folderId)) {
          membership[treeId] = folderId;
        }
      }
    }
    const starred = Array.isArray(raw.starred)
      ? raw.starred.filter((id): id is string => typeof id === "string")
      : [];
    const collapsed = Array.isArray(raw.collapsed)
      ? raw.collapsed.filter(
          (id): id is string => typeof id === "string" && folderIds.has(id),
        )
      : [];
    return {
      folders,
      membership,
      starred: [...new Set(starred)],
      collapsed: [...new Set(collapsed)],
    };
  } catch {
    return emptyResearchFolderState();
  }
}

export function isResearchStarred(state: ResearchFolderState, id: string): boolean {
  return state.starred.includes(id);
}

/** Adds the id to the end of the starred order, or removes it. */
export function toggleResearchStar(
  state: ResearchFolderState,
  id: string,
): ResearchFolderState {
  return {
    ...state,
    starred: state.starred.includes(id)
      ? state.starred.filter((starredId) => starredId !== id)
      : [...state.starred, id],
  };
}

/** Applies a new order for the currently displayed starred entries while
 * preserving any stored entries that are not on screen (other scopes,
 * archived trees) in their relative positions after them. */
export function replaceResearchStarOrder(
  state: ResearchFolderState,
  orderedDisplayedIds: string[],
): ResearchFolderState {
  const displayed = new Set(orderedDisplayedIds);
  return {
    ...state,
    starred: [
      ...orderedDisplayedIds,
      ...state.starred.filter((id) => !displayed.has(id)),
    ],
  };
}

export function createResearchFolder(
  state: ResearchFolderState,
  workspaceId: string,
  treeIds: string[],
  name = "New folder",
): { state: ResearchFolderState; folder: ResearchFolder } {
  const folder: ResearchFolder = { id: generateFolderId(), name, workspaceId };
  const membership = { ...state.membership };
  for (const treeId of treeIds) {
    membership[treeId] = folder.id;
  }
  return {
    state: { ...state, folders: [...state.folders, folder], membership },
    folder,
  };
}

export function addTreesToResearchFolder(
  state: ResearchFolderState,
  folderId: string,
  treeIds: string[],
): ResearchFolderState {
  if (!state.folders.some((folder) => folder.id === folderId)) {
    return state;
  }
  const membership = { ...state.membership };
  for (const treeId of treeIds) {
    membership[treeId] = folderId;
  }
  const liveFolderIds = new Set(Object.values(membership));
  return {
    ...state,
    folders: state.folders.filter((folder) => liveFolderIds.has(folder.id)),
    membership,
    starred: state.starred.filter(
      (id) =>
        liveFolderIds.has(id) || !state.folders.some((folder) => folder.id === id),
    ),
    collapsed: state.collapsed.filter((id) => liveFolderIds.has(id)),
  };
}

export function setResearchFolderCollapsed(
  state: ResearchFolderState,
  folderId: string,
  collapsed: boolean,
): ResearchFolderState {
  if (!state.folders.some((folder) => folder.id === folderId)) {
    return state;
  }
  const alreadyCollapsed = state.collapsed.includes(folderId);
  if (alreadyCollapsed === collapsed) {
    return state;
  }
  return {
    ...state,
    collapsed: collapsed
      ? [...state.collapsed, folderId]
      : state.collapsed.filter((id) => id !== folderId),
  };
}

export function renameResearchFolder(
  state: ResearchFolderState,
  folderId: string,
  name: string,
): ResearchFolderState {
  return {
    ...state,
    folders: state.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name } : folder,
    ),
  };
}

/** Drops individual trees out of whatever folder holds them, and out of the
 * starred list — a tree passed here is gone, foldered or not. A folder left
 * with no members disappears along with its own star. */
export function removeTreesFromResearchFolders(
  state: ResearchFolderState,
  treeIds: string[],
): ResearchFolderState {
  const removed = new Set(treeIds);
  const membership = { ...state.membership };
  let membershipChanged = false;
  for (const treeId of treeIds) {
    if (treeId in membership) {
      delete membership[treeId];
      membershipChanged = true;
    }
  }
  const liveFolderIds = new Set(Object.values(membership));
  const starred = state.starred.filter(
    (id) =>
      !removed.has(id) &&
      (liveFolderIds.has(id) || !state.folders.some((folder) => folder.id === id)),
  );
  if (!membershipChanged && starred.length === state.starred.length) {
    return state;
  }
  return {
    folders: state.folders.filter((folder) => liveFolderIds.has(folder.id)),
    membership,
    starred,
    collapsed: state.collapsed.filter((id) => liveFolderIds.has(id)),
  };
}

/** Removes only the organizational membership for the supplied trees. Stars
 * on the trees are preserved; empty folders and their own UI state are pruned. */
export function removeTreesFromResearchFolderMembership(
  state: ResearchFolderState,
  treeIds: string[],
): ResearchFolderState {
  const membership = { ...state.membership };
  let changed = false;
  for (const treeId of treeIds) {
    if (treeId in membership) {
      delete membership[treeId];
      changed = true;
    }
  }
  if (!changed) {
    return state;
  }
  const liveFolderIds = new Set(Object.values(membership));
  return {
    folders: state.folders.filter((folder) => liveFolderIds.has(folder.id)),
    membership,
    starred: state.starred.filter(
      (id) =>
        liveFolderIds.has(id) || !state.folders.some((folder) => folder.id === id),
    ),
    collapsed: state.collapsed.filter((id) => liveFolderIds.has(id)),
  };
}

/** Drops the folder record and every membership pointing at it. The trees
 * themselves are untouched — they return to the flat list. */
export function dissolveResearchFolder(
  state: ResearchFolderState,
  folderId: string,
): ResearchFolderState {
  const membership: Record<string, string> = {};
  for (const [treeId, memberFolderId] of Object.entries(state.membership)) {
    if (memberFolderId !== folderId) {
      membership[treeId] = memberFolderId;
    }
  }
  return {
    folders: state.folders.filter((folder) => folder.id !== folderId),
    membership,
    starred: state.starred.filter((id) => id !== folderId),
    collapsed: state.collapsed.filter((id) => id !== folderId),
  };
}

export function researchFolderMemberIds(
  state: ResearchFolderState,
  folderId: string,
): string[] {
  return Object.entries(state.membership)
    .filter(([, memberFolderId]) => memberFolderId === folderId)
    .map(([treeId]) => treeId);
}

// The sidebar's display model: the backend's flat tree order regrouped into
// "units" — a plain tree, or a folder carrying every one of its member trees
// present in the list. A folder sits where its first member sat, and its
// members keep their relative order inside it.

export type ResearchSidebarUnit =
  | { kind: "tree"; tree: ResearchTreeSummary }
  | { kind: "folder"; folder: ResearchFolder; trees: ResearchTreeSummary[] };

export function researchSidebarUnitId(unit: ResearchSidebarUnit): string {
  return unit.kind === "tree" ? unit.tree.id : unit.folder.id;
}

export function buildResearchSidebarUnits(
  trees: ResearchTreeSummary[],
  state: ResearchFolderState,
): ResearchSidebarUnit[] {
  const units: ResearchSidebarUnit[] = [];
  const folderUnits = new Map<
    string,
    Extract<ResearchSidebarUnit, { kind: "folder" }>
  >();
  for (const tree of trees) {
    const folderId = state.membership[tree.id];
    const folder = folderId
      ? state.folders.find((candidate) => candidate.id === folderId)
      : undefined;
    if (!folder) {
      units.push({ kind: "tree", tree });
      continue;
    }
    let unit = folderUnits.get(folder.id);
    if (!unit) {
      unit = { kind: "folder", folder, trees: [] };
      folderUnits.set(folder.id, unit);
      units.push(unit);
    }
    unit.trees.push(tree);
  }
  return units;
}

export function flattenResearchSidebarUnits(
  units: ResearchSidebarUnit[],
): string[] {
  return units.flatMap((unit) =>
    unit.kind === "tree" ? [unit.tree.id] : unit.trees.map((tree) => tree.id),
  );
}

export function flattenVisibleResearchSidebarUnits(
  units: ResearchSidebarUnit[],
  state: ResearchFolderState,
): string[] {
  const collapsed = new Set(state.collapsed);
  return units.flatMap((unit) =>
    unit.kind === "tree" || !collapsed.has(unit.folder.id)
      ? unit.kind === "tree"
        ? [unit.tree.id]
        : unit.trees.map((tree) => tree.id)
      : [],
  );
}

export function visibleResearchTreeIds(
  trees: ResearchTreeSummary[],
  state: ResearchFolderState,
): string[] {
  const lists = buildResearchSidebarLists(trees, state);
  return [
    ...flattenVisibleResearchSidebarUnits(lists.starred, state),
    ...flattenVisibleResearchSidebarUnits(lists.main, state),
  ];
}

export interface ResearchSidebarLists {
  /** Units pinned to the top, in the stored starred order. */
  starred: ResearchSidebarUnit[];
  /** Everything else, in the backend's flat order. */
  main: ResearchSidebarUnit[];
}

/** Splits the display into the starred list and the main list. A starred tree
 * always shows in the starred list — even out of a folder it belongs to — and
 * a starred folder brings its remaining members with it. */
export function buildResearchSidebarLists(
  trees: ResearchTreeSummary[],
  state: ResearchFolderState,
): ResearchSidebarLists {
  const starredSet = new Set(state.starred);
  const starredFolderIds = new Set(
    state.folders.filter((folder) => starredSet.has(folder.id)).map((folder) => folder.id),
  );
  const mainTrees = trees.filter((tree) => {
    if (starredSet.has(tree.id)) {
      return false;
    }
    const folderId = state.membership[tree.id];
    return !folderId || !starredFolderIds.has(folderId);
  });
  const starred: ResearchSidebarUnit[] = [];
  for (const id of state.starred) {
    const folder = state.folders.find((candidate) => candidate.id === id);
    if (folder) {
      const members = trees.filter(
        (tree) => state.membership[tree.id] === id && !starredSet.has(tree.id),
      );
      if (members.length > 0) {
        starred.push({ kind: "folder", folder, trees: members });
      }
      continue;
    }
    const tree = trees.find((candidate) => candidate.id === id);
    if (tree) {
      starred.push({ kind: "tree", tree });
    }
  }
  return { starred, main: buildResearchSidebarUnits(mainTrees, state) };
}

/** Moves one unit (tree or whole folder) to a gap in the unit list. Returns
 * the reordered unit list, or null when the move is a no-op. */
export function moveResearchUnitToGap(
  units: ResearchSidebarUnit[],
  unitId: string,
  gapIndex: number,
): ResearchSidebarUnit[] | null {
  const fromIndex = units.findIndex((unit) => researchSidebarUnitId(unit) === unitId);
  if (fromIndex < 0 || gapIndex < 0 || gapIndex > units.length) {
    return null;
  }
  if (gapIndex === fromIndex || gapIndex === fromIndex + 1) {
    return null;
  }
  const without = units.filter((unit) => researchSidebarUnitId(unit) !== unitId);
  const insertIndex = Math.max(
    0,
    Math.min(gapIndex > fromIndex ? gapIndex - 1 : gapIndex, without.length),
  );
  return [
    ...without.slice(0, insertIndex),
    units[fromIndex],
    ...without.slice(insertIndex),
  ];
}

/** Moves one member to a gap inside its folder. Returns the unit list with
 * that folder's members reordered, or null when the move is a no-op. */
export function moveResearchFolderMemberToGap(
  units: ResearchSidebarUnit[],
  folderId: string,
  treeId: string,
  gapIndex: number,
): ResearchSidebarUnit[] | null {
  const unit = units.find(
    (candidate) => candidate.kind === "folder" && candidate.folder.id === folderId,
  );
  if (!unit || unit.kind !== "folder") {
    return null;
  }
  const memberIds = unit.trees.map((tree) => tree.id);
  const fromIndex = memberIds.indexOf(treeId);
  if (fromIndex < 0 || gapIndex < 0 || gapIndex > memberIds.length) {
    return null;
  }
  if (gapIndex === fromIndex || gapIndex === fromIndex + 1) {
    return null;
  }
  const without = unit.trees.filter((tree) => tree.id !== treeId);
  const insertIndex = Math.max(
    0,
    Math.min(gapIndex > fromIndex ? gapIndex - 1 : gapIndex, without.length),
  );
  const reordered = [
    ...without.slice(0, insertIndex),
    unit.trees[fromIndex],
    ...without.slice(insertIndex),
  ];
  return units.map((candidate) =>
    candidate === unit ? { ...unit, trees: reordered } : candidate,
  );
}

/** A drop gap measured before an item joined a list needs to move one slot
 * right when the newly inserted item landed before that gap. */
export function translateResearchGapAfterInsertion(
  gapIndex: number,
  insertedIndex: number,
): number {
  return insertedIndex >= 0 && insertedIndex < gapIndex ? gapIndex + 1 : gapIndex;
}
