import type { PaneInfo } from "./types";

// The close-confirmation dialog covers three cases: a worktree agent (offer to
// keep or delete the worktree), a live agent without a worktree (just confirm the
// stop), and the explicit tab close button (always confirm). These render in-app
// because window.confirm is a no-op in the Tauri webview.
export type CloseDialogState =
  | {
      kind: "worktree";
      pane: PaneInfo;
      agentId: string;
      worktreeDir: string;
      hasChanges: boolean;
      busy: boolean;
    }
  | { kind: "stop"; pane: PaneInfo; reason: string }
  | { kind: "pane"; pane: PaneInfo };

export type ExitDialogState = {
  paneCount: number;
};

export type PaneContextMenuState = {
  paneId: string;
  x: number;
  y: number;
};

export type PaneTabPointerDrag = {
  pointerId: number;
  paneId: string;
  startY: number;
  active: boolean;
};
