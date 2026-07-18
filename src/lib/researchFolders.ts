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
}

export const RESEARCH_FOLDERS_STORAGE_KEY = "qmux.research-folders.v1";

export function emptyResearchFolderState(): ResearchFolderState {
  return { folders: [], membership: {} };
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
    return { folders, membership };
  } catch {
    return emptyResearchFolderState();
  }
}

export function saveResearchFolderState(state: ResearchFolderState) {
  try {
    localStorage.setItem(RESEARCH_FOLDERS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or privacy-mode failures only cost the grouping, not the data.
  }
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
    state: { folders: [...state.folders, folder], membership },
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
  return { ...state, membership };
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

/** Drops individual trees out of whatever folder holds them. A folder left
 * with no members disappears from display and is pruned on the next prune. */
export function removeTreesFromResearchFolders(
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

/** Removes memberships for trees that no longer exist anywhere, then folders
 * left with no members at all. Display building already ignores both, so this
 * only keeps localStorage from accumulating forever. */
export function pruneResearchFolderState(
  state: ResearchFolderState,
  knownTreeIds: Iterable<string>,
): ResearchFolderState {
  const known = new Set(knownTreeIds);
  const membership: Record<string, string> = {};
  let membershipChanged = false;
  for (const [treeId, folderId] of Object.entries(state.membership)) {
    if (known.has(treeId)) {
      membership[treeId] = folderId;
    } else {
      membershipChanged = true;
    }
  }
  const liveFolderIds = new Set(Object.values(membership));
  const folders = state.folders.filter((folder) => liveFolderIds.has(folder.id));
  if (!membershipChanged && folders.length === state.folders.length) {
    return state;
  }
  return { folders, membership };
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

/** Moves one unit (tree or whole folder) to a gap in the unit list and returns
 * the resulting flat tree-id order, or null when the move is a no-op. */
export function moveResearchUnitToGap(
  units: ResearchSidebarUnit[],
  unitId: string,
  gapIndex: number,
): string[] | null {
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
  const next = [
    ...without.slice(0, insertIndex),
    units[fromIndex],
    ...without.slice(insertIndex),
  ];
  return flattenResearchSidebarUnits(next);
}

/** Moves one member to a gap inside its folder and returns the resulting flat
 * tree-id order, or null when the move is a no-op. */
export function moveResearchFolderMemberToGap(
  units: ResearchSidebarUnit[],
  folderId: string,
  treeId: string,
  gapIndex: number,
): string[] | null {
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
  return flattenResearchSidebarUnits(
    units.map((candidate) =>
      candidate === unit ? { ...unit, trees: reordered } : candidate,
    ),
  );
}
