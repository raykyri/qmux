import type { AgentInfo } from "../types";

export interface TerminalAttentionState {
  activeSurface: "pane" | "research";
  activePaneId: string | null;
  paneId: string | null;
  paneExists: boolean;
  documentFocused: boolean;
  documentVisible: boolean;
}

export function terminalPaneHasUserAttention(state: TerminalAttentionState): boolean {
  return (
    state.activeSurface === "pane" &&
    state.paneId !== null &&
    state.activePaneId === state.paneId &&
    state.paneExists &&
    state.documentFocused &&
    state.documentVisible
  );
}

// A speculative acknowledgement asks the backend to atomically re-check an
// agent whose Done event may still be in flight. Only apply an Idle response:
// a non-Idle snapshot can predate a newer status event that React has already
// received, and applying it would roll that newer state back.
export function applicableSpeculativeAcknowledgements(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.status === "idle");
}

export const TERMINAL_ATTENTION_PROBE_INTERVAL_MS = 250;

export function terminalAttentionProbeIsDue(
  lastProbeAt: number | undefined,
  now: number,
): boolean {
  return (
    lastProbeAt === undefined ||
    now < lastProbeAt ||
    now - lastProbeAt >= TERMINAL_ATTENTION_PROBE_INTERVAL_MS
  );
}
