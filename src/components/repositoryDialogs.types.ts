import type { MessageAnchor, PaneInfo, RepositoryInventory } from "../types";

export type WorktreeCreateAction =
  | { kind: "open" }
  | { kind: "fork"; prompt?: string; anchor?: MessageAnchor };

export type WorktreeCreateDialogState = {
  pane: PaneInfo;
  action: WorktreeCreateAction;
  name: string;
  suggestedName: string;
  creating: boolean;
  error: string | null;
  inventory: RepositoryInventory | null;
  inventoryLoading: boolean;
  inventoryError: string | null;
  startRef: string | null;
  requestId: number;
};

export type RepositoryBrowserState = {
  pane: PaneInfo;
  inventory: RepositoryInventory | null;
  error: string | null;
  opening: string | null;
  names: Record<string, string>;
};
