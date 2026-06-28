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

export function getLauncherAdapterPreference() {
  return invoke<string | null>("launcher_adapter_preference_get");
}

export function setLauncherAdapterPreference(adapterId: string) {
  return invoke<void>("launcher_adapter_preference_set", { adapterId });
}

export interface ShowHideShortcutSetting {
  accelerator: string | null;
  registered: boolean;
  error?: string | null;
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
  return invoke<void>("show_hide_shortcut_capture_set", { active });
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

export function pickGroupDirectory(groupId: string) {
  return invoke<GroupInfo | null>("group_pick_dir", { groupId });
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

export interface DictationCacheHeader {
  name: string;
  value: string;
}

export interface DictationCacheMetadata {
  size: number;
  headers: DictationCacheHeader[];
}

export function dictationCacheMetadata(request: string) {
  return invoke<DictationCacheMetadata | null>("dictation_cache_metadata", { request });
}

export function dictationCacheRead(request: string, offset: number, length: number) {
  return invoke<string>("dictation_cache_read", { request, offset, length });
}

export function dictationCachePutStart(request: string, headers: DictationCacheHeader[]) {
  return invoke<void>("dictation_cache_put_start", { request, headers });
}

export function dictationCachePutChunk(request: string, dataBase64: string) {
  return invoke<void>("dictation_cache_put_chunk", { request, dataBase64 });
}

export function dictationCachePutFinish(request: string) {
  return invoke<void>("dictation_cache_put_finish", { request });
}

export function dictationCacheDelete(request: string) {
  return invoke<boolean>("dictation_cache_delete", { request });
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

export function getPaneScrollback(paneId: string) {
  return invoke<string>("pane_scrollback", { paneId });
}

export function resizePane(paneId: string, cols: number, rows: number) {
  return invoke<void>("pane_resize", { paneId, cols, rows });
}

export function paneActivity(paneId: string) {
  return invoke<PaneActivity>("pane_activity", { paneId });
}

export function killPane(paneId: string) {
  return invoke<void>("pane_kill", { paneId });
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
