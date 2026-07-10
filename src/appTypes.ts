import type { PaneInfo } from "./types";

export type CloseGroupContinuation = {
  groupId: string;
  groupName: string;
  remainingPaneIds: string[];
  totalCount: number;
};

type CloseDialogGroupContext = {
  groupClose?: CloseGroupContinuation;
};

// The close-confirmation dialog covers four cases: a worktree agent (offer to
// keep or delete the worktree), a live agent without a worktree (just confirm the
// stop), a tab with child processes, and the explicit tab close button (always
// confirm). These render in-app because window.confirm is a no-op in the Tauri
// webview.
export type CloseDialogState =
  | ({
      kind: "worktree";
      pane: PaneInfo;
      agentId: string;
      worktreeDir: string;
      // null means the git status probe failed or was intentionally skipped.
      hasChanges: boolean | null;
      busy: boolean;
    } & CloseDialogGroupContext)
  | ({ kind: "stop"; pane: PaneInfo; reason: string } & CloseDialogGroupContext)
  | ({
      kind: "runningProcess";
      pane: PaneInfo;
      processCount: number;
      processSummary?: string | null;
    } & CloseDialogGroupContext)
  | ({ kind: "pane"; pane: PaneInfo } & CloseDialogGroupContext);

export type ExitDialogState = {
  paneCount: number;
};

export type ExitPreflightRequest = {
  paneCount: number;
  nonce: number;
};

export type PaneContextMenuState = {
  paneId: string;
  x: number;
  y: number;
};

export type PaneTabPointerDrag = {
  pointerId: number;
  paneId: string;
  startX: number;
  startY: number;
  active: boolean;
};

export type GroupPointerDrag = {
  pointerId: number;
  groupId: string;
  startX: number;
  startY: number;
  active: boolean;
};

// Where a tab drag will land: a gap between rows (reorder), onto a row (nest), or
// into the visible terminal stack (split above/below the target pane).
export type PaneDropTarget =
  | { kind: "gap"; groupId: string; index: number }
  | { kind: "nest"; groupId: string; paneId: string }
  | {
      kind: "terminal-split";
      groupId: string;
      targetPaneId: string;
      position: "above" | "below";
    };

export type GroupDropTarget = { index: number };

export type BrowserOverlaySize = {
  width: number;
  height: number;
};

// Per-pane browser overlay: the URL it's showing, whether it's visible, a nonce
// bumped on open/refresh to force the iframe to remount (reload), whether the
// iframe should be sandboxed (true for token-bearing file-server URLs), and an
// optional user-resized size that survives tab switches in React state.
export type BrowserOverlayState = {
  url: string | null;
  open: boolean;
  reloadNonce: number;
  sandbox: boolean;
  size?: BrowserOverlaySize | null;
};

// Viewport-coordinate bounding box of a text selection, used to anchor the
// floating "Ask" popup near the selected text.
export type SelectionAnchor = { left: number; right: number; top: number; bottom: number };

// The floating Ask / Ask-in-new-thread button group shown over a non-empty text
// selection in the terminal or an assistant transcript message. Ephemeral.
export type SelectionAskState = {
  quote: string;
  anchor: SelectionAnchor;
  sourceAgentId: string;
  sourcePaneId: string;
  // Whether the source agent can be forked (supported adapter with a recorded
  // session), which gates the "Ask in new thread" button.
  canFork: boolean;
};

// The ask launcher modal: a launcher-style popup seeded with a quote. "ask" sends
// to the source agent; "newThread" forks the source conversation with the question
// as its launch prompt.
// Ephemeral — closing discards the typed question and any options.
export type AskLauncherState = {
  quote: string;
  mode: "ask" | "newThread";
  sourceAgentId: string;
  sourcePaneId: string;
};
