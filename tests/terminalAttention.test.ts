import assert from "node:assert/strict";
import test from "node:test";
import type { AgentInfo } from "../src/types";
import {
  applicableSpeculativeAcknowledgements,
  TERMINAL_ATTENTION_PROBE_INTERVAL_MS,
  terminalAttentionProbeIsDue,
  terminalPaneHasUserAttention,
  type TerminalAttentionState,
} from "../src/lib/terminalAttention";

const attentionState = (
  overrides: Partial<TerminalAttentionState> = {},
): TerminalAttentionState => ({
  activeSurface: "pane",
  activePaneId: "pane-1",
  paneId: "pane-1",
  paneExists: true,
  documentFocused: true,
  documentVisible: true,
  ...overrides,
});

const agent = (id: string, status: AgentInfo["status"]): AgentInfo => ({
  id,
  groupId: "group-1",
  adapter: "codex",
  worktreeDir: "/tmp/worktree",
  status,
  createdAt: 1,
});

test("only a visible active terminal pane has user attention", () => {
  assert.equal(terminalPaneHasUserAttention(attentionState()), true);
  assert.equal(
    terminalPaneHasUserAttention(attentionState({ activeSurface: "research" })),
    false,
  );
  assert.equal(
    terminalPaneHasUserAttention(attentionState({ activePaneId: "pane-2" })),
    false,
  );
  assert.equal(terminalPaneHasUserAttention(attentionState({ paneExists: false })), false);
  assert.equal(
    terminalPaneHasUserAttention(attentionState({ documentFocused: false })),
    false,
  );
  assert.equal(
    terminalPaneHasUserAttention(attentionState({ documentVisible: false })),
    false,
  );
});

test("speculative acknowledgement cannot roll a newer status backward", () => {
  const idle = agent("idle", "idle");
  assert.deepEqual(
    applicableSpeculativeAcknowledgements([
      agent("starting", "starting"),
      agent("running", "running"),
      agent("done", "done"),
      idle,
      agent("failed", "failed"),
    ]),
    [idle],
  );
});

test("dense terminal attention events share one backend probe window", () => {
  assert.equal(terminalAttentionProbeIsDue(undefined, 1_000), true);
  assert.equal(terminalAttentionProbeIsDue(1_000, 1_001), false);
  assert.equal(
    terminalAttentionProbeIsDue(1_000, 1_000 + TERMINAL_ATTENTION_PROBE_INTERVAL_MS - 1),
    false,
  );
  assert.equal(
    terminalAttentionProbeIsDue(1_000, 1_000 + TERMINAL_ATTENTION_PROBE_INTERVAL_MS),
    true,
  );
  assert.equal(terminalAttentionProbeIsDue(1_000, 10), true);
});
