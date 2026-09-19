import type { GroupInfo, PaneInfo, ResearchTreeSummary } from "../types";
import { type ResearchFolderScope, workspaceIsInResearchScope } from "./researchScope";
import { panesForScope } from "./workspaceScope";

export type SidebarMode = "terminal" | "research";

export const SIDEBAR_MODE_STORAGE_KEY = "qmux.sidebar-mode.v1";
export const RESEARCH_HOME_TAB_ID = "__research_home__";
export const RESEARCH_BOOKMARKS_TAB_ID = "__research_bookmarks__";
export const RESEARCH_HIGHLIGHTS_TAB_ID = "__research_highlights__";
const RESEARCH_ENCYCLOPEDIA_TAB_PREFIX = "__research_encyclopedia__:";
const RESEARCH_TREE_TAB_PREFIX = "__research_tree__:";

/** The journal pages the research surface can show. */
export type ResearchJournalView = "home" | "bookmarks" | "highlights";

/** Every journal view, in sidebar order, for tests that cover the whole set. */
export const RESEARCH_JOURNAL_VIEWS: readonly ResearchJournalView[] = [
  "home",
  "bookmarks",
  "highlights",
];

/** The journal pages in sidebar order. They lead the Ctrl-Tab cycle, ahead of
 * the research trees, so cycling follows the sidebar top to bottom.
 *
 * A tab id only belongs here once `focusResearchTabById` in App.tsx has a
 * dispatch arm for it; otherwise cycling onto it would call `focusPaneTab` with
 * a pane id that does not exist. All three pages are dispatched there. */
export const RESEARCH_JOURNAL_TAB_IDS: readonly string[] = [
  RESEARCH_HOME_TAB_ID,
  RESEARCH_BOOKMARKS_TAB_ID,
  RESEARCH_HIGHLIGHTS_TAB_ID,
];

export function researchJournalTabId(view: ResearchJournalView): string {
  switch (view) {
    case "bookmarks":
      return RESEARCH_BOOKMARKS_TAB_ID;
    case "highlights":
      return RESEARCH_HIGHLIGHTS_TAB_ID;
    default:
      return RESEARCH_HOME_TAB_ID;
  }
}

export function researchJournalViewFromTabId(tabId: string): ResearchJournalView | null {
  switch (tabId) {
    case RESEARCH_HOME_TAB_ID:
      return "home";
    case RESEARCH_BOOKMARKS_TAB_ID:
      return "bookmarks";
    case RESEARCH_HIGHLIGHTS_TAB_ID:
      return "highlights";
    default:
      return null;
  }
}

export function researchEncyclopediaTabId(slug: string): string {
  return `${RESEARCH_ENCYCLOPEDIA_TAB_PREFIX}${slug}`;
}

export function researchEncyclopediaSlugFromTabId(tabId: string): string | null {
  if (!tabId.startsWith(RESEARCH_ENCYCLOPEDIA_TAB_PREFIX)) {
    return null;
  }
  const slug = tabId.slice(RESEARCH_ENCYCLOPEDIA_TAB_PREFIX.length);
  return slug || null;
}

export function researchTreeTabId(treeId: string): string {
  return `${RESEARCH_TREE_TAB_PREFIX}${treeId}`;
}

export function researchTreeIdFromTabId(tabId: string): string | null {
  if (!tabId.startsWith(RESEARCH_TREE_TAB_PREFIX)) {
    return null;
  }
  const treeId = tabId.slice(RESEARCH_TREE_TAB_PREFIX.length);
  return treeId || null;
}

export function parseSidebarMode(value: string | null): SidebarMode {
  return value === "research" ? "research" : "terminal";
}

export function terminalTabForMode(
  panes: PaneInfo[],
  groups: GroupInfo[],
  preferredTabId: string | null,
): string | null {
  const terminalPanes = panesForScope(panes, groups, "terminal");
  if (preferredTabId && terminalPanes.some((pane) => pane.id === preferredTabId)) {
    return preferredTabId;
  }
  // Fall back the way the app's other automatic selections do: prefer a pane
  // whose group is expanded — a collapsed group renders no rows, so
  // activating one of its panes would highlight nothing in the sidebar. Only
  // when every group is collapsed (or there are no panes) fall through to
  // the first pane, or null when Terminal has nothing to show.
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const visiblePane = terminalPanes.find(
    (pane) => groupById.get(pane.groupId)?.collapsed !== true,
  );
  return visiblePane?.id ?? terminalPanes[0]?.id ?? null;
}

export function researchCycleTabIds(
  panes: PaneInfo[],
  groups: GroupInfo[],
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
  pages: readonly { slug: string; workspaceId: string }[] = [],
): string[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  // Cycle exactly what the sidebar lists: the "Live terminals" section is
  // filtered by the research folder scope, and cycling into a pane with no
  // visible row would leave the stage and the sidebar contradicting each
  // other (an active terminal with nothing highlighted anywhere).
  const visibleResearchPaneIds = panesForScope(panes, groups, "research")
    .filter((pane) => workspaceIsInResearchScope(pane.groupId, scope))
    .filter((pane) => groupById.get(pane.groupId)?.collapsed !== true)
    .map((pane) => pane.id);
  return [
    ...RESEARCH_JOURNAL_TAB_IDS,
    ...pages
      .filter((page) => workspaceIsInResearchScope(page.workspaceId, scope))
      .map((page) => researchEncyclopediaTabId(page.slug)),
    ...trees
      .filter((tree) => workspaceIsInResearchScope(tree.workspaceId, scope))
      .map((tree) => researchTreeTabId(tree.id)),
    ...visibleResearchPaneIds,
  ];
}
