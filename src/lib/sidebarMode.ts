import type { GroupInfo, PaneInfo } from "../types";
import { panesForScope } from "./workspaceScope";

export type SidebarMode = "terminal" | "research";

export const SIDEBAR_MODE_STORAGE_KEY = "qmux.sidebar-mode.v1";
export const RESEARCH_DOCUMENT_TAB_ID = "__research_document__";

export function parseSidebarMode(value: string | null): SidebarMode {
  return value === "research" ? "research" : "terminal";
}

export function terminalTabForMode(
  panes: PaneInfo[],
  groups: GroupInfo[],
  preferredTabId: string | null,
  homeTabId: string,
): string {
  if (preferredTabId === homeTabId) {
    return homeTabId;
  }
  const terminalPanes = panesForScope(panes, groups, "terminal");
  if (preferredTabId && terminalPanes.some((pane) => pane.id === preferredTabId)) {
    return preferredTabId;
  }
  return terminalPanes[0]?.id ?? homeTabId;
}

export function researchCycleTabIds(
  panes: PaneInfo[],
  groups: GroupInfo[],
  activeResearchTreeId: string | null,
): string[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const visibleResearchPaneIds = panesForScope(panes, groups, "research")
    .filter((pane) => groupById.get(pane.groupId)?.collapsed !== true)
    .map((pane) => pane.id);
  return [
    ...(activeResearchTreeId ? [RESEARCH_DOCUMENT_TAB_ID] : []),
    ...visibleResearchPaneIds,
  ];
}
