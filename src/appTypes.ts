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

// Where a tab drag will land: either a gap between rows (reorder) or onto a row
// (nest the dragged tab under it).
export type PaneDropTarget =
  | { kind: "gap"; index: number }
  | { kind: "nest"; paneId: string };

// Per-pane browser overlay: the URL it's showing, whether it's visible, a nonce
// bumped on open/refresh to force the iframe to remount (reload), and whether the
// iframe should be sandboxed (true for token-bearing file-server URLs).
export type BrowserOverlayState = {
  url: string | null;
  open: boolean;
  reloadNonce: number;
  sandbox: boolean;
};
