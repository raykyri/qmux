import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PaneLayoutItem } from "./paneTree";
import type {
  AgentInfo,
  ClaudeSkill,
  GroupInfo,
  InitialPaneSize,
  MoveQueuedAgentTurnResult,
  PaneActivity,
  PaneInfo,
  PaneSplitInfo,
  QmuxEvent,
  QueuedTurn,
  QueuedTurnDelivery,
  RemoveQueuedAgentTurnResult,
  ReorderQueuedAgentTurnResult,
  SendNextQueuedAgentTurnResult,
  RuntimeConfig,
  SpawnAgentRequest,
  SubmitAgentTurnMode,
  SubmitAgentTurnResult,
  TranscriptOption,
  ThreadGraph,
  Turn,
  WorktreeStatus,
} from "../types";

export function getRuntimeConfig() {
  return invoke<RuntimeConfig>("get_runtime_config");
}

export function getLauncherAdapterPreference() {
  return invoke<string | null>("launcher_adapter_preference_get");
}

export function setLauncherAdapterPreference(adapterId: string) {
  return invoke<void>("launcher_adapter_preference_set", { adapterId });
}

// The OpenRouter API key lives in the backend's owner-only preferences file, not in
// webview localStorage, so the secret isn't readable at rest by injected scripts.
export function getOpenRouterKey() {
  return invoke<string>("openrouter_key_get");
}

export function setOpenRouterKey(key: string) {
  return invoke<void>("openrouter_key_set", { key });
}

export function getActiveTab() {
  return invoke<string | null>("active_tab_get");
}

export function setActiveTab(tabId: string | null) {
  return invoke<void>("active_tab_set", { tabId });
}

export interface ShowHideShortcutSetting {
  accelerator: string | null;
  registered: boolean;
  error?: string | null;
  captureActive: boolean;
}

export type MenuBarStatusTone =
  | "active"
  | "pending"
  | "idle"
  | "attention"
  | "done"
  | "error";

export interface MenuBarTab {
  paneId: string;
  title: string;
  path?: string | null;
  depth: number;
  statusTone: MenuBarStatusTone;
  statusLabel?: string | null;
  waitingOnPane: boolean;
  selected: boolean;
}

export interface MenuBarGroup {
  id: string;
  label: string;
  tabs: MenuBarTab[];
}

export interface MenuBarSnapshot {
  groups: MenuBarGroup[];
}

export interface MenuBarSelectPaneEvent {
  paneId: string;
}

export function getShowHideShortcut() {
  return invoke<ShowHideShortcutSetting>("show_hide_shortcut_get");
}

export function setShowHideShortcut(accelerator: string | null) {
  return invoke<ShowHideShortcutSetting>("show_hide_shortcut_set", { accelerator });
}

export function setShowHideShortcutCaptureActive(active: boolean) {
  return invoke<ShowHideShortcutSetting>("show_hide_shortcut_capture_set", { active });
}

export function updateMenuBar(snapshot: MenuBarSnapshot) {
  return invoke<void>("menu_bar_update", { snapshot });
}

export function listenToMenuBarSelectPane(
  onSelectPane: (event: MenuBarSelectPaneEvent) => void,
): Promise<UnlistenFn> {
  return listen<MenuBarSelectPaneEvent>("menu-bar-select-pane", (event) =>
    onSelectPane(event.payload),
  );
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

export function createGroup(request?: {
  name?: string | null;
  dir?: string | null;
  afterGroupId?: string | null;
  baseRepo?: string | null;
  baseRef?: string | null;
}) {
  return invoke<GroupInfo>("group_create", {
    request: {
      name: request?.name ?? null,
      dir: request?.dir ?? null,
      afterGroupId: request?.afterGroupId ?? null,
      baseRepo: request?.baseRepo ?? null,
      baseRef: request?.baseRef ?? null,
    },
  });
}

export function createGroupWithFolder(afterGroupId?: string | null) {
  return invoke<GroupInfo | null>("group_create_pick", { afterGroupId: afterGroupId ?? null });
}

export function removeGroup(groupId: string) {
  return invoke<void>("group_remove", { groupId });
}

export function renameGroup(groupId: string, name: string | null) {
  return invoke<GroupInfo>("group_rename", { groupId, name });
}

export function reorderGroups(groupIds: string[]) {
  return invoke<GroupInfo[]>("group_reorder", { groupIds });
}

export function setGroupCollapsed(groupId: string, collapsed: boolean) {
  return invoke<GroupInfo>("group_set_collapsed", { groupId, collapsed });
}

export function pickGroupDirectory(groupId: string) {
  return invoke<GroupInfo | null>("group_pick_dir", { groupId });
}

export function listAgents() {
  return invoke<AgentInfo[]>("list_agents");
}

export function listTurns(agentId?: string | null) {
  return invoke<Turn[]>("list_turns", { agentId: agentId ?? null });
}

export function listThreadGraphs() {
  return invoke<ThreadGraph[]>("list_thread_graphs");
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

export function spawnShell(
  initialSize?: InitialPaneSize | null,
  sourcePaneId?: string | null,
  groupId?: string | null,
) {
  return invoke<PaneInfo>("spawn_shell", {
    initialSize: initialSize ?? null,
    sourcePaneId: sourcePaneId ?? null,
    groupId: groupId ?? null,
  });
}

export function setUseLoginShell(enabled: boolean) {
  return invoke<void>("use_login_shell_set", { enabled });
}

export function spawnAgent(request: SpawnAgentRequest) {
  return invoke<PaneInfo>("agent_spawn", { request });
}

// Forks the session in `paneId` into a new tab and resumes it. With `nest`, the
// fork lands as a child of the source pane; otherwise it lands as a sibling
// immediately after it. `prompt` is submitted as the fork's launch message.
export function forkAgent(
  paneId: string,
  options?: { useWorktree?: boolean; nest?: boolean; prompt?: string },
) {
  return invoke<PaneInfo>("agent_fork", {
    paneId,
    useWorktree: options?.useWorktree ?? false,
    nest: options?.nest ?? false,
    prompt: options?.prompt,
  });
}

export function writePane(paneId: string, data: string) {
  return invoke<void>("pane_write", { paneId, data, paste: false, submit: false });
}

export function submitPaneInput(paneId: string, data: string) {
  return invoke<void>("pane_write", { paneId, data, paste: true, submit: true });
}

export function submitAgentTurn(agentId: string, data: string, mode: SubmitAgentTurnMode = "auto") {
  return invoke<SubmitAgentTurnResult>("agent_submit_turn", {
    request: { agentId, data, mode },
  });
}

export function queueWaitAgentTurn(
  agentId: string,
  data: string,
  waitForAgentId: string,
  waitForPaneId?: string | null,
  waitForLabel?: string | null,
) {
  return invoke<SubmitAgentTurnResult>("agent_queue_wait_turn", {
    request: {
      agentId,
      data,
      waitForAgentId,
      waitForPaneId: waitForPaneId ?? null,
      waitForLabel: waitForLabel ?? null,
    },
  });
}

// Queues a turn that, when reached, is delivered to a new pane (a fork of this
// session or a fresh session in the same directory) instead of this agent's own
// composer.
export function queueDeliveryAgentTurn(
  agentId: string,
  data: string,
  delivery: QueuedTurnDelivery,
) {
  return invoke<SubmitAgentTurnResult>("agent_queue_delivery_turn", {
    request: { agentId, data, delivery },
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

/** Opens an http(s)/mailto URL in the user's default external browser/mail client. */
export function openExternalUrl(url: string) {
  return invoke<void>("open_external_url", { url });
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

export function clearAgentWorkingStatus(agentId: string) {
  return invoke<AgentInfo>("agent_clear_working_status", { agentId });
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

export interface NativeTerminalLayout {
  paneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  focused: boolean;
  acceptsPointerInput: boolean;
  acceptsKeyboardInput: boolean;
  deferGeometry: boolean;
}

export function setNativeTerminalLayout(layout: NativeTerminalLayout) {
  return invoke<void>("native_terminal_set_layout", { layout });
}

let nativeTerminalWebPointerClaims = 0;
let nativeTerminalWebPointerUpdate: Promise<void> = Promise.resolve();

function queueNativeTerminalWebPointerClaim(claimed: boolean) {
  // Preserve start/end order even when a very short drag releases before the
  // first invoke has completed. Errors are intentionally absorbed so a failed
  // native bridge call cannot poison later drag ownership updates.
  nativeTerminalWebPointerUpdate = nativeTerminalWebPointerUpdate
    .catch(() => undefined)
    .then(() => invoke<void>("native_terminal_set_web_pointer_claimed", { claimed }))
    .catch(() => undefined);
}

/**
 * Temporarily gives WKWebView every pointer event, including events whose
 * coordinates overlap a native terminal surface. Used for mid-gesture drag
 * controls and for sticky overlays (sidebar menus) that open over the terminal.
 * Claims are reference-counted so independently mounted claimants cannot
 * release each other's capture. Call the returned function to release.
 */
export function claimNativeTerminalPointerForWebDrag(): () => void {
  nativeTerminalWebPointerClaims += 1;
  if (nativeTerminalWebPointerClaims === 1) {
    queueNativeTerminalWebPointerClaim(true);
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    nativeTerminalWebPointerClaims = Math.max(0, nativeTerminalWebPointerClaims - 1);
    if (nativeTerminalWebPointerClaims === 0) {
      queueNativeTerminalWebPointerClaim(false);
    }
  };
}

/** Positions the opaque native backstop under the terminal stage, so transient
 * gaps while pane surfaces chase their DOM rects show terminal-colored pixels
 * instead of the window's vibrancy material. */
export function setNativeTerminalStageBackstop(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return invoke<void>("native_terminal_set_stage_backstop", rect);
}

export function focusNativeTerminal(paneId: string) {
  return invoke<void>("native_terminal_focus", { paneId });
}

export interface NativeTerminalSettings {
  paneId: string;
  fontSize: number;
  fontFamily: string;
  letterSpacing: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollbackRows: number;
  scrollOnUserInput: boolean;
  canAskSelection: boolean;
  scrollSensitivity: number;
  copyOnSelect: boolean;
  selectionClearOnCopy: boolean;
}

export function performNativeTerminalAction(paneId: string, action: string) {
  return invoke<void>("native_terminal_action", { paneId, action });
}

export function pasteApprovedNativeTerminalText(paneId: string, text: string) {
  return invoke<void>("native_terminal_paste_approved_text", { paneId, text });
}

export function updateNativeTerminalSettings(settings: NativeTerminalSettings) {
  return invoke<void>("native_terminal_update_settings", { settings });
}

export function paneActivity(paneId: string) {
  return invoke<PaneActivity>("pane_activity", { paneId });
}

export function killPane(paneId: string) {
  return invoke<void>("pane_kill", { paneId });
}

// Records the focused pane so the backend can pick a group's most-recently-active
// shell pane when resolving a spawn cwd. Best-effort; failures are ignored.
export function activatePane(paneId: string) {
  return invoke<void>("pane_activate", { paneId });
}

export function restoreLastClosedPane() {
  return invoke<PaneInfo | null>("pane_restore_last_closed");
}

export function renamePane(paneId: string, title: string) {
  return invoke<PaneInfo>("pane_rename", { paneId, title });
}

export function generateFoundationTabTitle(message: string) {
  return invoke<string>("generate_foundation_tab_title", { message });
}

export function reorderPanes(paneIds: string[]) {
  return invoke<PaneInfo[]>("pane_reorder", { paneIds });
}

/** Atomically sets the sidebar tab tree (order + nesting depth) in one call. */
export function setPaneLayout(items: PaneLayoutItem[]) {
  return invoke<PaneInfo[]>("pane_set_layout", { items });
}

/** Moves `paneId` immediately after `siblingPaneId` at the same sidebar depth. */
export function placePaneAfter(paneId: string, siblingPaneId: string) {
  return invoke<PaneInfo[]>("pane_place_after", { paneId, siblingPaneId });
}

export function getPaneSplits() {
  return invoke<PaneSplitInfo[]>("pane_splits_get");
}

export function setPaneSplits(splits: PaneSplitInfo[]) {
  return invoke<PaneSplitInfo[]>("pane_splits_set", { splits });
}

export function worktreeStatus(agentId: string) {
  return invoke<WorktreeStatus>("worktree_status", { agentId });
}

export function closeWorktreePane(agentId: string, deleteWorktree: boolean) {
  return invoke<void>("worktree_close_pane", { agentId, deleteWorktree });
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
