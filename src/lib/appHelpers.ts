import {
  isTerminalFontLoaded,
  TERMINAL_FONT_SIZE,
} from "./terminalFont";
import { FONT_OPTIONS } from "./settings";
import type {
  AgentInfo,
  PaneInfo,
  PaneSplitInfo,
  QmuxEvent,
  QueuedTurn,
  TranscriptCopyPayload,
  TranscriptHookEvent,
  Turn,
} from "../types";

const TRANSCRIPT_COPY_VERSION = 1;
const DEFAULT_FONT_STACK = FONT_OPTIONS[0].stack;

let measuredTerminalCellSize: { width: number; height: number } | null = null;

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// Formats a quoted selection plus the user's question into one agent message: the
// quote as a Markdown blockquote (each line prefixed with `>`), a blank line, then
// the question. Used by the "Ask about this quote" launcher so the agent receives
// the quote inline regardless of which surface it was selected from.
export function buildQuotedMessage(quote: string, question: string): string {
  const quoted = quote
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  const trimmedQuestion = question.trim();
  return trimmedQuestion ? `${quoted}\n\n${trimmedQuestion}` : quoted;
}

export function selectPaneAfterClose(
  panes: PaneInfo[],
  closedPaneId: string,
  paneSplits: PaneSplitInfo[] = [],
): string | null {
  const closedIndex = panes.findIndex((pane) => pane.id === closedPaneId);
  if (closedIndex === -1) {
    return panes[0]?.id ?? null;
  }

  const availablePaneIds = new Set(panes.map((pane) => pane.id));
  availablePaneIds.delete(closedPaneId);
  const split = paneSplits.find((candidate) => candidate.paneIds.includes(closedPaneId));
  const splitIndex = split?.paneIds.indexOf(closedPaneId) ?? -1;
  if (split && splitIndex >= 0) {
    for (let index = splitIndex - 1; index >= 0; index -= 1) {
      const previousSplitPaneId = split.paneIds[index];
      if (previousSplitPaneId && availablePaneIds.has(previousSplitPaneId)) {
        return previousSplitPaneId;
      }
    }
    for (let index = splitIndex + 1; index < split.paneIds.length; index += 1) {
      const nextSplitPaneId = split.paneIds[index];
      if (nextSplitPaneId && availablePaneIds.has(nextSplitPaneId)) {
        return nextSplitPaneId;
      }
    }
  }

  return panes[closedIndex - 1]?.id ?? panes[closedIndex + 1]?.id ?? null;
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

// Decodes a `pty.data` event payload (base64-encoded raw PTY bytes) into the
// Uint8Array xterm writes. The backend sends base64 rather than a JSON integer
// array to keep this hottest-path payload compact and the decode a single step.
export function ptyDataFromPayload(payload: Record<string, unknown>): Uint8Array | null {
  return bytesFromBase64(payload.dataBase64);
}

export function bytesFromBase64(encoded: unknown): Uint8Array | null {
  if (typeof encoded !== "string") {
    return null;
  }
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

// Validates an agent payload arriving on an event before it is applied to local
// state, mirroring isTurn. Status events now carry the updated agent so the UI can
// apply changes surgically instead of refetching the whole list every time.
export function isAgentInfo(value: unknown): value is AgentInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const agent = value as Record<string, unknown>;
  return (
    typeof agent.id === "string" &&
    typeof agent.adapter === "string" &&
    typeof agent.status === "string"
  );
}

export function isQueuedTurn(value: unknown): value is QueuedTurn {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).text === "string"
  );
}

// Applies a single updated agent to the list: replaces it in place when present,
// otherwise appends it (e.g. a freshly spawned agent), preserving order.
export function upsertAgent(agents: AgentInfo[], updated: AgentInfo): AgentInfo[] {
  let replaced = false;
  const next = agents.map((agent) => {
    if (agent.id === updated.id) {
      replaced = true;
      return updated;
    }
    return agent;
  });
  return replaced ? next : [...next, updated];
}

export function reconcileQueuedTurnCollapse(
  previousTurns: QueuedTurn[],
  nextTurns: QueuedTurn[],
  previousCollapsed: boolean[],
) {
  const usedPreviousIndexes = new Set<number>();
  return nextTurns.map((nextTurn) => {
    const previousIndex = previousTurns.findIndex(
      (previousTurn, index) =>
        previousTurn.text === nextTurn.text && !usedPreviousIndexes.has(index),
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

export function agentStatusLabel(status: AgentInfo["status"]) {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "awaitingInput":
      return "Awaiting input";
    case "awaitingPermission":
      return "Requesting approval";
    case "done":
      return "Done";
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
