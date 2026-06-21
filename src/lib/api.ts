import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PaneLayoutItem } from "./paneTree";
import type {
  AgentInfo,
  ClaudeSkill,
  GroupInfo,
  InitialPaneSize,
  MoveQueuedAgentTurnResult,
  PaneInfo,
  QmuxEvent,
  QueuedTurn,
  RemoveQueuedAgentTurnResult,
  ReorderQueuedAgentTurnResult,
  SendNextQueuedAgentTurnResult,
  RuntimeConfig,
  SpawnAgentRequest,
  SubmitAgentTurnMode,
  SubmitAgentTurnResult,
  TranscriptOption,
  Turn,
  WorktreeStatus,
} from "../types";

export function getRuntimeConfig() {
  return invoke<RuntimeConfig>("get_runtime_config");
}

/** Skills the qmux-managed Claude plugin can inject into launched Claude agents. */
export function listClaudeSkills() {
  return invoke<ClaudeSkill[]>("list_claude_skills");
}

export function listPanes() {
  return invoke<PaneInfo[]>("list_panes");
}

export function listGroups() {
  return invoke<GroupInfo[]>("list_groups");
}

export function listAgents() {
  return invoke<AgentInfo[]>("list_agents");
}

export function listTurns(agentId?: string | null) {
  return invoke<Turn[]>("list_turns", { agentId: agentId ?? null });
}

export function listAgentTurnQueue(agentId: string) {
  return invoke<QueuedTurn[]>("list_agent_turn_queue", { agentId });
}

/** Toggles the pause-after-send flag on one queued turn. */
export function setQueuedTurnPause(
  agentId: string,
  index: number,
  pauseAfter: boolean,
  expectedData: string,
) {
  return invoke<QueuedTurn[]>("agent_set_queued_turn_pause", {
    agentId,
    index,
    pauseAfter,
    expectedData,
  });
}

/** Clears an agent's paused state, draining the next queued turn if it is idle. */
export function unpauseAgent(agentId: string) {
  return invoke<SendNextQueuedAgentTurnResult>("agent_unpause", { agentId });
}

export function listAgentTranscripts(agentId: string) {
  return invoke<TranscriptOption[]>("list_agent_transcripts", { agentId });
}

export function setAgentTranscript(agentId: string, path: string | null) {
  return invoke<AgentInfo>("set_agent_transcript", { agentId, path });
}

export function spawnShell(initialSize?: InitialPaneSize | null) {
  return invoke<PaneInfo>("spawn_shell", { initialSize: initialSize ?? null });
}

export function spawnAgent(request: SpawnAgentRequest) {
  return invoke<PaneInfo>("agent_spawn", { request });
}

export function writePane(paneId: string, data: string) {
  return invoke<void>("pane_write", { paneId, data, paste: false, submit: false });
}

export function submitPaneInput(paneId: string, data: string) {
  return invoke<void>("pane_write", { paneId, data, paste: true, submit: true });
}

// Writes pasted text to a pane's PTY, wrapping it in bracketed-paste markers when
// the program has that mode on. Used to re-inject a large paste the user confirmed
// in an in-app dialog, since that path bypasses xterm's own paste handling.
export function pastePaneInput(paneId: string, data: string, bracketed: boolean) {
  return invoke<void>("pane_write", { paneId, data, paste: bracketed, submit: false });
}

export function submitAgentTurn(agentId: string, data: string, mode: SubmitAgentTurnMode = "auto") {
  return invoke<SubmitAgentTurnResult>("agent_submit_turn", {
    request: { agentId, data, mode },
  });
}

export function removeQueuedAgentTurn(agentId: string, index: number, expectedData: string) {
  return invoke<RemoveQueuedAgentTurnResult>("agent_remove_queued_turn", {
    request: { agentId, index, expectedData },
  });
}

export function reorderQueuedAgentTurn(
  agentId: string,
  fromIndex: number,
  toIndex: number,
  expectedData: string,
) {
  return invoke<ReorderQueuedAgentTurnResult>("agent_reorder_queued_turn", {
    request: { agentId, fromIndex, toIndex, expectedData },
  });
}

export function sendNextQueuedAgentTurn(agentId: string) {
  return invoke<SendNextQueuedAgentTurnResult>("agent_send_next_queued_turn", { agentId });
}

/** Marks/clears that the user is actively typing for an agent, so the backend holds
 *  off auto-draining its queue. Clearing drains a held turn if the agent is idle. */
export function setAgentTyping(agentId: string, typing: boolean) {
  return invoke<SendNextQueuedAgentTurnResult>("agent_set_typing", { agentId, typing });
}

// Atomically moves a queued turn from one agent to another. The backend removes
// from the source and hands it to the target in one call, rolling back on failure,
// so the turn can never end up in both queues or be lost.
export function moveQueuedAgentTurn(
  fromAgentId: string,
  toAgentId: string,
  index: number,
  expectedData: string,
) {
  return invoke<MoveQueuedAgentTurnResult>("agent_move_queued_turn", {
    request: { fromAgentId, toAgentId, index, expectedData },
  });
}

export function setAgentDraft(agentId: string, draft: string) {
  return invoke<void>("agent_set_draft", { agentId, draft });
}

export function getAgentDraft(agentId: string) {
  return invoke<string | null>("agent_get_draft", { agentId });
}

export function acknowledgeAgent(agentId: string, includeFailed = false) {
  return invoke<AgentInfo>("agent_acknowledge", { agentId, includeFailed });
}

/**
 * Tells the backend the listener for this pane is live, flushing any PTY output
 * buffered before the webview subscribed (e.g. the cold-start prompt). Must be
 * called only after listenToEvents has resolved.
 */
export function attachPane(paneId: string) {
  return invoke<void>("pane_attach", { paneId });
}

export function resizePane(paneId: string, cols: number, rows: number) {
  return invoke<void>("pane_resize", { paneId, cols, rows });
}

export function killPane(paneId: string) {
  return invoke<void>("pane_kill", { paneId });
}

export function renamePane(paneId: string, title: string) {
  return invoke<PaneInfo>("pane_rename", { paneId, title });
}

export function reorderPanes(paneIds: string[]) {
  return invoke<PaneInfo[]>("pane_reorder", { paneIds });
}

/** Atomically sets the sidebar tab tree (order + nesting depth) in one call. */
export function setPaneLayout(items: PaneLayoutItem[]) {
  return invoke<PaneInfo[]>("pane_set_layout", { items });
}

export function worktreeStatus(agentId: string) {
  return invoke<WorktreeStatus>("worktree_status", { agentId });
}

export function removeWorktree(agentId: string) {
  return invoke<void>("worktree_remove", { agentId });
}

export function confirmAppExit() {
  return invoke<void>("app_confirm_exit");
}

/** Arms (or releases) the macOS wake lock that keeps the machine awake. */
export function setPreventSleep(active: boolean) {
  return invoke<void>("app_set_prevent_sleep", { active });
}

export function listenToEvents(onEvent: (event: QmuxEvent) => void): Promise<UnlistenFn> {
  return listen<QmuxEvent>("qmux-event", (event) => onEvent(event.payload));
}
