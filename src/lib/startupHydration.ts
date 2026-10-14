import type { ArtifactInfo, GroupInfo, PaneInfo } from "../types";
import {
  getRuntimeConfig, getLauncherAdapterPreference, getActiveTab, listGroups,
  listPanes, getPaneSplits, listAgents, listResearchTrees, listResearchFolders,
} from "./api";
import { emptyResearchFolderState } from "./researchFolders";

/** Only workspace/navigation data gates the first usable interface. */
export async function loadInitialWorkspace() {
  const [config, launcherAdapterId, activeTabId, groups, panes, splits, agents, researchTrees, researchFolders] = await Promise.all([
    getRuntimeConfig(),
    getLauncherAdapterPreference().catch(() => null),
    getActiveTab().catch(() => null),
    listGroups().catch(() => []),
    listPanes(),
    getPaneSplits().catch(() => []),
    listAgents(),
    listResearchTrees(false).catch(() => []),
    listResearchFolders().catch(emptyResearchFolderState),
  ]);
  return { config, launcherAdapterId, activeTabId, groups, panes, splits, agents, researchTrees, researchFolders };
}

/** Yield a painted frame before secondary IPC; still run if the user hides us. */
export function afterStartupPaint(task: () => void): () => void {
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    task();
  };
  const frame = requestAnimationFrame(() => {
    clearTimeout(timer);
    timer = setTimeout(run, 0);
  });
  timer = setTimeout(run, 250);
  return () => {
    finished = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

/** Replay live tray changes over an older boot snapshot, including removals. */
export function reconcileStartupArtifacts(
  snapshot: ArtifactInfo[],
  overrides: ReadonlyMap<string, ArtifactInfo | null>,
): ArtifactInfo[] {
  const entries = new Map(snapshot.map((entry) => [entry.id, entry]));
  for (const [id, entry] of overrides) {
    if (entry) entries.set(id, entry);
    else entries.delete(id);
  }
  return [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function reconcileStartupDrafts(
  snapshot: Record<string, string>,
  current: Record<string, string>,
  overrides: ReadonlyMap<string, string>,
): Record<string, string> {
  const drafts = { ...snapshot, ...current };
  for (const [id, draft] of overrides) {
    if (draft) drafts[id] = draft;
    else delete drafts[id];
  }
  return drafts;
}

/** Establish the correct stage before an async document read can fail/stale. */
export function startupResearchPane(
  savedPaneId: string | null,
  panes: PaneInfo[],
  groups: GroupInfo[],
  scope: string | null,
): PaneInfo | null {
  return panes.find(pane => pane.id === savedPaneId && pane.groupId === scope &&
    groups.some(group => group.id === pane.groupId && group.scope === "research")) ?? null;
}
