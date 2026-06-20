import {
  isTerminalFontLoaded,
  TERMINAL_FONT_SIZE,
} from "./terminalFont";
import { FONT_OPTIONS } from "./settings";
import type {
  AgentInfo,
  PaneInfo,
  QmuxEvent,
  TranscriptCopyPayload,
  TranscriptHookEvent,
  Turn,
  WorktreeStatus,
} from "../types";

const TRANSCRIPT_COPY_VERSION = 1;
const DEFAULT_FONT_STACK = FONT_OPTIONS[0].stack;

let measuredTerminalCellSize: { width: number; height: number } | null = null;

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// Validates a turn payload arriving over the backend event stream before it is
// trusted as a Turn. The data is structured by Rust, but guarding at the boundary
// keeps a malformed/renamed field from silently producing an invalid turn the UI
// then renders.
export function isTurn(value: unknown): value is Turn {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.id === "string" &&
    typeof turn.agentId === "string" &&
    typeof turn.role === "string" &&
    Array.isArray(turn.blocks)
  );
}

export function reconcileQueuedTurnCollapse(
  previousTurns: string[],
  nextTurns: string[],
  previousCollapsed: boolean[],
) {
  const usedPreviousIndexes = new Set<number>();
  return nextTurns.map((nextTurn) => {
    const previousIndex = previousTurns.findIndex(
      (previousTurn, index) => previousTurn === nextTurn && !usedPreviousIndexes.has(index),
    );
    if (previousIndex === -1) {
      return false;
    }
    usedPreviousIndexes.add(previousIndex);
    return previousCollapsed[previousIndex] ?? false;
  });
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function isTerminalTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && target.closest(".terminal-mount") !== null;
}

export function measureTerminalCellSize(fontFamily: string, fontSize: number) {
  // Only the default font + size is cached (the common case); other choices
  // measure fresh so a pane created with them gets a close initial grid pre-fit.
  const isDefault = fontFamily === DEFAULT_FONT_STACK && fontSize === TERMINAL_FONT_SIZE;
  if (isDefault && measuredTerminalCellSize && isTerminalFontLoaded()) {
    return measuredTerminalCellSize;
  }

  const probe = document.createElement("span");
  probe.textContent = "mmmmmmmmmm";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = fontFamily;
  probe.style.fontSize = `${fontSize}px`;
  document.body.appendChild(probe);

  const rect = probe.getBoundingClientRect();
  probe.remove();

  const cellSize = {
    width: rect.width > 0 ? rect.width / 10 : 8,
    height: rect.height > 0 ? rect.height : 16,
  };
  if (isDefault && isTerminalFontLoaded()) {
    measuredTerminalCellSize = cellSize;
  }
  return cellSize;
}

export function statusLabel(status: PaneInfo["status"]) {
  switch (status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "exited":
      return "Exited";
    case "killed":
      return "Killed";
    case "failed":
      return "Failed";
  }
}

export function agentStatusLabel(status: AgentInfo["status"], reviewStatus?: WorktreeStatus | null) {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "awaitingInput":
      return "Awaiting input";
    case "awaitingPermission":
      return "Approval needed";
    case "done":
      return reviewStatus?.hasChanges ? `Review (${reviewStatus.changedFiles})` : "Done";
    case "idle":
      return null;
    case "failed":
      return "Failed";
  }
}

// Maps an agent status onto the status-dot tones used by the pane detail popover.
export function agentStatusTone(status: AgentInfo["status"]) {
  switch (status) {
    case "running":
      return "active";
    case "starting":
      return "pending";
    case "awaitingInput":
    case "awaitingPermission":
      return "attention";
    case "done":
      return "done";
    case "failed":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

export function transcriptHookEvent(event: QmuxEvent): TranscriptHookEvent | null {
  const hookEvent = event.payload.hookEvent;
  if (!event.agentId || typeof hookEvent !== "string") {
    return null;
  }

  return {
    type: event.type,
    paneId: event.paneId ?? null,
    agentId: event.agentId,
    hookEvent,
    payload: event.payload.payload ?? null,
    timestamp: event.timestamp,
  };
}

export function formatTranscriptCopyJson(
  input: Omit<TranscriptCopyPayload, "version" | "exportedAt">,
) {
  const payload: TranscriptCopyPayload = {
    version: TRANSCRIPT_COPY_VERSION,
    exportedAt: new Date().toISOString(),
    ...input,
  };
  return JSON.stringify(payload, null, 2);
}
