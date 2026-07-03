import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Expand,
  Folder,
  GitBranch,
  House,
  LoaderCircle,
  MessageSquareText,
  Minimize2,
  Minus,
  MoreHorizontal,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Settings,
  SquareChevronLeft,
  SquareChevronRight,
  SquareTerminal,
  X,
} from "lucide-react";
import { agentUiAdapters, findAgentUiAdapter, getAgentUiAdapter } from "./adapters";
import { CLAUDE_ADAPTER_ID } from "./adapters/claude";
import { CODEX_ADAPTER_ID } from "./adapters/codex";
import { GROK_ADAPTER_ID } from "./adapters/grok";
import { OPENCODE_ADAPTER_ID } from "./adapters/opencode";
import claudeModelIconUrl from "./assets/model-icons/claude-ai.svg";
import openAiModelIconUrl from "./assets/model-icons/openai.svg";
import openCodeModelIconUrl from "./assets/model-icons/opencode-dark.svg";
import grokModelIconUrl from "./assets/model-icons/grok.svg";
import NativeInput from "./components/NativeInput";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "./components/ComposerSubmitShortcut";
import DictationMicButton from "./components/DictationMicButton";
import { useDictation } from "./useDictation";
import { getDictationDownload, subscribeDictationDownload } from "./dictationStatus";
import { LauncherSelect } from "./components/LauncherSelect";
import type { LauncherSelectOption } from "./components/LauncherSelect";
import BrowserOverlay from "./components/BrowserOverlay";
import BrowserOverlayControls from "./components/BrowserOverlayControls";
import LinkContextMenu from "./components/LinkContextMenu";
import TerminalPane from "./components/TerminalPane";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import TurnOverlay, { formatTurnsTranscript } from "./components/TurnOverlay";
import SelectionAskPopup from "./components/SelectionAskPopup";
import TurnPaneHeader from "./components/TurnPaneHeader";
import type { LinkActions } from "./components/TurnOverlay";
import RecoveredQueuePanel from "./components/RecoveredQueuePanel";
import type { OrphanedQueueGroup } from "./components/RecoveredQueuePanel";
import {
  agentStatusLabel,
  agentStatusTone,
  buildQuotedMessage,
  clamp,
  cycleTabId,
  formatTranscriptCopyJson,
  isEditableTarget,
  isTerminalTarget,
  measureTerminalCellSize,
  reconcileQueuedTurnCollapse,
  selectPaneAfterClose,
  statusLabel,
} from "./lib/appHelpers";
import { useQmuxEvents } from "./hooks/useQmuxEvents";
import type {
  AskLauncherState,
  BrowserOverlayState,
  BrowserOverlaySize,
  CloseGroupContinuation,
  CloseDialogState,
  ExitDialogState,
  ExitPreflightRequest,
  GroupDropTarget,
  GroupPointerDrag,
  PaneContextMenuState,
  PaneDropTarget,
  PaneTabPointerDrag,
  SelectionAnchor,
  SelectionAskState,
} from "./appTypes";
import {
  canIndent,
  canOutdent,
  indentAt,
  isLeafPane,
  movePaneAfterSubtree,
  movePanePromotingChildrenAdjacentToPane,
  moveToGap,
  nestUnder,
  outdentAt,
  type PaneLayoutItem,
  subtreeEnd,
  toLayout,
} from "./lib/paneTree";
import {
  adjacentPaneBelow,
  detachPaneFromSplitMemberships,
  joinPaneSplit,
  normalizePaneSplitsForPanes,
  paneSplitForPane,
  paneSplitsEqual,
  paneSnapshotForPersistedPaneSplits,
  resizeSplitFractions,
  splitFractions,
} from "./lib/paneSplits";
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "./lib/terminalFont";
import { canRenderInInternalBrowser } from "./lib/links";
import { stripTaggedUserInstructionBlocks } from "./lib/taggedInstructions";
import {
  clampConfirmPasteOverChars,
  clampFontSize,
  clampLineHeight,
  clampScrollbackRows,
  clampScrollDurationMs,
  CONFIRM_PASTE_OVER_CHARS_MAX,
  CONFIRM_PASTE_OVER_CHARS_MIN,
  CURSOR_INACTIVE_STYLE_OPTIONS,
  CURSOR_STYLE_OPTIONS,
  FONT_OPTIONS,
  fontStackFor,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_STEP,
  letterSpacingFor,
  loadSettings,
  MOUSE_WHEEL_SENSITIVITY_OPTIONS,
  pasteProtectionFor,
  saveSettings,
  SCROLL_DURATION_MS_MAX,
  SCROLL_DURATION_MS_MIN,
  SCROLL_DURATION_MS_STEP,
  SCROLLBACK_ROWS_MAX,
  SCROLLBACK_ROWS_MIN,
  scrollSensitivityFor,
  TAB_TITLE_PROVIDER_OPTIONS,
  type AppSettings,
} from "./lib/settings";
import {
  acknowledgeAgent,
  attachPane,
  clearAgentWorkingStatus,
  closeWorktreePane,
  confirmAppExit,
  createGroup,
  createGroupWithFolder,
  forkAgent,
  getActiveTab,
  getPaneSplits,
  getLauncherAdapterPreference,
  getAgentDraft,
  getShowHideShortcut,
  getRuntimeConfig,
  generateFoundationTabTitle,
  killPane,
  listenToMenuBarSelectPane,
  listGroups,
  listAgents,
  listClaudeSkills,
  listAgentTranscripts,
  listAgentTurnQueue,
  listTurns,
  listPanes,
  moveQueuedAgentTurn,
  openExternalUrl,
  paneActivity,
  pickGroupDirectory,
  placePaneAfter,
  removeQueuedAgentTurn,
  removeGroup,
  renameGroup,
  renamePane,
  reorderGroups,
  restoreLastClosedPane,
  setLauncherAdapterPreference,
  setActiveTab,
  setGroupCollapsed,
  setPaneLayout,
  setPaneSplits as persistPaneSplits,
  setAgentDraft as persistAgentDraft,
  setAgentTranscript,
  setAgentTyping,
  setShowHideShortcut,
  setShowHideShortcutCaptureActive,
  setPreventSleep,
  setUseLoginShell,
  spawnAgent,
  spawnShell,
  submitAgentTurn,
  updateMenuBar,
  worktreeStatus,
} from "./lib/api";
import type {
  AgentInfo,
  ClaudeSkill,
  GroupInfo,
  InitialPaneSize,
  PaneInfo,
  PaneSplitInfo,
  QueuedTurn,
  RuntimeConfig,
  TranscriptHookEvent,
  TranscriptOption,
  Turn,
  WaitTarget,
} from "./types";
import type { ShowHideShortcutSetting } from "./lib/api";
import type { MenuBarSnapshot, MenuBarStatusTone } from "./lib/api";

const LEFT_SIDEBAR_DEFAULT_WIDTH = 268;
const LEFT_SIDEBAR_MIN_WIDTH = 208;
const LEFT_SIDEBAR_MAX_WIDTH = 420;
// Below this width the New shell/New agent buttons drop their icons to keep the
// labels readable. (The icon-only Settings cog always keeps its icon.)
const LEFT_SIDEBAR_COMPACT_WIDTH = 270;
const PANE_TAB_DRAG_START_THRESHOLD = 4;
const PANE_TAB_DRAG_CLICK_SUPPRESS_MS = 100;
// Sentinel "active pane" value for the fixed Home tab. It's not a real pane, so it
// lives outside the `panes` list — it can't be closed, reordered, or nested, and
// selecting it shows the empty content placeholder (the launcher).
const HOME_TAB_ID = "__home__";
// How long after the user's last keystroke we keep holding the queue before letting a
// finished turn auto-send the next queued message.
const INPUT_DEQUEUE_HOLD_MS = 1500;
// Short grace period for selection popup closes: rapid re-selection should move the
// popup instead of flashing it out and back in.
const SELECTION_ASK_HIDE_DEBOUNCE_MS = 150;
// Left strip of the sidebar the browser overlay leaves uncovered, so the first few
// chars of each tab stay visible and clickable for switching tabs.
const BROWSER_OVERLAY_LEFT_MARGIN = 64;
const EXPAND_TOGGLE_SHORTCUT_LABEL = "⌘⇧E / Ctrl+Shift+E";
const TERMINAL_MIN_WIDTH = 380;
const TURN_PANE_MIN_WIDTH = 300;
const TURN_PANE_DEFAULT_WIDTH = 420;
const TURN_PANE_MAX_WIDTH = 720;
const TERMINAL_HORIZONTAL_PADDING = 10;
const TERMINAL_VERTICAL_PADDING = 20;
const TERMINAL_SPLIT_MIN_HEIGHT = 140;
const DEFAULT_INITIAL_COLS = 100;
const DEFAULT_INITIAL_ROWS = 24;
const MIN_INITIAL_COLS = 20;
const MIN_INITIAL_ROWS = 5;
const MAX_INITIAL_COLS = 500;
const MAX_INITIAL_ROWS = 200;
const PANE_CONTEXT_MENU_WIDTH = 320;
const PANE_CONTEXT_MENU_ESTIMATED_HEIGHT = 360;
const GROUP_CONTEXT_MENU_WIDTH = 220;
const GROUP_CONTEXT_MENU_ESTIMATED_HEIGHT = 270;
const SETTINGS_CONTEXT_MENU_WIDTH = 160;
const SETTINGS_CONTEXT_MENU_ESTIMATED_HEIGHT = 66;
const LAUNCHER_ADAPTER_ICON_BY_ID: Record<string, string> = {
  [CLAUDE_ADAPTER_ID]: claudeModelIconUrl,
  [CODEX_ADAPTER_ID]: openAiModelIconUrl,
  [OPENCODE_ADAPTER_ID]: openCodeModelIconUrl,
  [GROK_ADAPTER_ID]: grokModelIconUrl,
};
const DEFAULT_SHELL_TITLE = "Shell";
const MAX_TERMINAL_TITLE_CHARS = 160;
const MAX_FIRST_MESSAGE_TITLE_CHARS = 80;
const MAX_OPENROUTER_TITLE_SOURCE_CHARS = 4000;
const OPENROUTER_TITLE_MAX_COMPLETION_TOKENS = 1000;
const OPENROUTER_TITLE_TIMEOUT_MS = 15_000;
const FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT = 5;
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const APP_TOAST_TIMEOUT_MS = 5000;
const TITLE_GENERATION_TEST_MESSAGE =
  "Review the launch plan, identify the highest-risk blockers, and suggest next steps.";
// How long the composer can sit idle before its draft is flushed to disk. The
// in-memory copy updates on every keystroke (so tab switches never lose it); the
// disk write is debounced so a paused composer — and a restart — can recover it.
const DRAFT_FLUSH_DEBOUNCE_MS = 1000;

function waitForPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

interface PendingFirstMessageTitle {
  paneId: string;
  checkedMessages: number;
  seenTurnIds: Set<string>;
  skillCommand: string | null;
}

interface AgentTurnInfo {
  turns: Turn[];
  assistantLabel: string;
  transcript: string;
}

interface TurnPaneSurface {
  pane: PaneInfo;
  agent: AgentInfo | undefined;
  turns: Turn[];
  assistantLabel: string;
  transcript: string;
  hookEvents: TranscriptHookEvent[];
  transcriptNotice: string | null;
  transcriptOptions: TranscriptOption[];
  queuedTurns: QueuedTurn[];
  waitTargets: WaitTarget[];
  collapsedQueuedTurns: boolean[];
  draft: string;
  orphanedQueues: OrphanedQueueGroup[];
  queueSplit: boolean;
  queueSplitHeight: number | undefined;
  browserOverlay: BrowserOverlayState | undefined;
  topFraction: number;
  heightFraction: number;
  hasTurnSidebar: boolean;
}

interface OpenRouterTitleConfig {
  apiKey: string;
  model: string;
}

type FirstMessageTitleConfig =
  | { provider: "appleFoundationModels" }
  | ({ provider: "openRouter" } & OpenRouterTitleConfig);

type OpenRouterTitleReasoningEffort = "none" | "minimal";

type TitleGenerationTestState =
  | { status: "running"; providerLabel: string }
  | { status: "success"; providerLabel: string; title: string }
  | { status: "error"; providerLabel: string; message: string };

function sanitizeTerminalTitle(rawTitle: string): string | null {
  const title = rawTitle
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) {
    return null;
  }
  return Array.from(title).slice(0, MAX_TERMINAL_TITLE_CHARS).join("");
}

function normalizedMessagePreview(rawMessage: string): string | null {
  const normalized = rawMessage
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function stripSkillCommandPrefix(rawMessage: string, skillCommand: string | null): string {
  const command = skillCommand?.trim();
  if (!command) {
    return rawMessage;
  }

  const leadingMatch = rawMessage.match(/^\s*/);
  const leading = leadingMatch?.[0] ?? "";
  const message = rawMessage.slice(leading.length);
  if (!message.startsWith(command)) {
    return rawMessage;
  }

  const next = message[command.length];
  if (next !== undefined && next.trim() !== "") {
    return rawMessage;
  }

  return `${leading}${message.slice(command.length)}`;
}

function firstMessageTitleSource(rawMessage: string, skillCommand: string | null = null): string | null {
  const withoutSkillCommand = stripSkillCommandPrefix(rawMessage, skillCommand);
  return normalizedMessagePreview(stripTaggedUserInstructionBlocks(withoutSkillCommand));
}

function appleFoundationModelsTitleAvailable(config: RuntimeConfig | null): boolean {
  return config?.tabTitleGeneration.appleFoundationModelsAvailable === true;
}

function sanitizeGeneratedTitle(rawTitle: string): string | null {
  const normalized = sanitizeTerminalTitle(rawTitle);
  if (!normalized) {
    return null;
  }
  const withoutLabel = normalized.replace(/^title:\s*/i, "").trim();
  const unquoted = withoutLabel.replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!unquoted) {
    return null;
  }
  const chars = Array.from(unquoted);
  if (chars.length <= MAX_FIRST_MESSAGE_TITLE_CHARS) {
    return unquoted;
  }

  return `${chars.slice(0, MAX_FIRST_MESSAGE_TITLE_CHARS - 3).join("").trimEnd()}...`;
}

function firstMessageTitleConfig(
  settings: AppSettings,
  config: RuntimeConfig | null,
): FirstMessageTitleConfig | null {
  if (settings.tabTitleProvider === "disabled") {
    return null;
  }
  if (settings.tabTitleProvider === "appleFoundationModels") {
    return appleFoundationModelsTitleAvailable(config)
      ? { provider: "appleFoundationModels" }
      : null;
  }

  // OpenRouter sends first-message text to a third-party service, so selecting the
  // provider is the consent boundary; key/model are still required to make a call.
  const apiKey = settings.openRouterKey.trim();
  const model = settings.openRouterModel.trim();
  return apiKey && model ? { provider: "openRouter", apiKey, model } : null;
}

function firstMessageTitleProviderLabel(config: FirstMessageTitleConfig): string {
  return config.provider === "appleFoundationModels" ? "Apple Foundation Models" : "OpenRouter";
}

function tabTitleProviderLabel(provider: AppSettings["tabTitleProvider"]): string {
  return (
    TAB_TITLE_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? "Tab titles"
  );
}

function focusConfirmDialogButton(button: HTMLButtonElement | null, force = false) {
  if (!button) {
    return;
  }
  const dialog = button.closest(".confirm-dialog");
  const activeElement = document.activeElement;
  if (force || !dialog?.contains(activeElement)) {
    button.focus();
  }
}

function scrollChildIntoViewVertically(container: HTMLElement, child: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();

  if (childRect.top < containerRect.top) {
    container.scrollTop -= containerRect.top - childRect.top;
  } else if (childRect.bottom > containerRect.bottom) {
    container.scrollTop += childRect.bottom - containerRect.bottom;
  }
}

function unknownErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isShowHideShortcutCaptureTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("[data-shortcut-capture='show-hide']") !== null
  );
}

function shortcutKeyLabel(event: KeyboardEvent | ReactKeyboardEvent): string | null {
  if (
    event.key === "Shift" ||
    event.key === "Control" ||
    event.key === "Alt" ||
    event.key === "Meta"
  ) {
    return null;
  }

  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return code;
  }

  switch (code) {
    case "Space":
    case "Enter":
    case "Tab":
    case "Backspace":
    case "Delete":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
    case "Insert":
    case "CapsLock":
      return code;
    case "Escape":
      return "Escape";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "NumpadAdd":
    case "NumpadDecimal":
    case "NumpadDivide":
    case "NumpadEnter":
    case "NumpadEqual":
    case "NumpadMultiply":
    case "NumpadSubtract":
      return code;
    case "AudioVolumeDown":
      return "VolumeDown";
    case "AudioVolumeUp":
      return "VolumeUp";
    case "AudioVolumeMute":
      return "VolumeMute";
    case "MediaPlayPause":
    case "MediaStop":
    case "MediaTrackNext":
    case "MediaTrackPrevious":
      return code;
    default:
      return null;
  }
}

function shortcutFromKeyboardEvent(
  event: KeyboardEvent | ReactKeyboardEvent,
): { accelerator: string | null; error: string | null } {
  const key = shortcutKeyLabel(event);
  if (!key) {
    return { accelerator: null, error: null };
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Control");
  }
  if (event.altKey) {
    modifiers.push("Option");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (event.metaKey) {
    modifiers.push("Command");
  }
  if (modifiers.length === 0) {
    return {
      accelerator: null,
      error: "Use at least one modifier, such as Option or Command.",
    };
  }

  return { accelerator: [...modifiers, key].join("+"), error: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function openRouterPayloadErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload.trim() || null;
  }
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  const error = record.error;
  if (typeof error === "string") {
    return error;
  }
  const errorRecord = asRecord(error);
  return typeof errorRecord?.message === "string" ? errorRecord.message : null;
}

function openRouterContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const partRecord = asRecord(part);
      const text = partRecord?.text;
      if (typeof text === "string") {
        return text;
      }
      const nestedContent = partRecord?.content;
      return typeof nestedContent === "string" ? nestedContent : "";
    })
    .join("");
  return text.trim() ? text : null;
}

function openRouterFirstChoice(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  return asRecord(choices[0]);
}

function openRouterTitleFromPayload(payload: unknown): string | null {
  const firstChoice = openRouterFirstChoice(payload);
  const message = asRecord(firstChoice?.message);
  const content = message?.content ?? firstChoice?.text;
  const text = openRouterContentText(content);
  return text ? sanitizeGeneratedTitle(text) : null;
}

function openRouterChoiceErrorMessage(choice: Record<string, unknown> | null): string | null {
  const error = asRecord(choice?.error);
  if (!error) {
    return null;
  }
  const message = typeof error.message === "string" ? error.message : "Unknown provider error";
  const code =
    typeof error.code === "string" || typeof error.code === "number" ? ` ${error.code}` : "";
  return `choice error${code}: ${message}`;
}

function openRouterPayloadUsageSummary(payload: unknown): string | null {
  const record = asRecord(payload);
  const usage = asRecord(record?.usage);
  if (!usage) {
    return null;
  }
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  const completionDetails = asRecord(usage.completion_tokens_details);
  const reasoningTokens =
    typeof completionDetails?.reasoning_tokens === "number"
      ? completionDetails.reasoning_tokens
      : null;
  const parts: string[] = [];
  if (completionTokens !== null) {
    parts.push(`completion_tokens=${completionTokens}`);
  }
  if (reasoningTokens !== null) {
    parts.push(`reasoning_tokens=${reasoningTokens}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function openRouterEmptyTitleMessage(payload: unknown): string {
  const firstChoice = openRouterFirstChoice(payload);
  const choiceError = openRouterChoiceErrorMessage(firstChoice);
  if (choiceError) {
    return `OpenRouter generation failed: ${choiceError}`;
  }

  const finishReason =
    typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null;
  const nativeFinishReason =
    typeof firstChoice?.native_finish_reason === "string"
      ? firstChoice.native_finish_reason
      : null;
  const usage = openRouterPayloadUsageSummary(payload);
  const details: string[] = [];
  if (finishReason) {
    details.push(`finish_reason=${finishReason}`);
  }
  if (nativeFinishReason && nativeFinishReason !== finishReason) {
    details.push(`native_finish_reason=${nativeFinishReason}`);
  }
  if (usage) {
    details.push(usage);
  }

  return details.length > 0
    ? `OpenRouter returned no title (${details.join(", ")}).`
    : "OpenRouter returned no title.";
}

function isOpenRouterReasoningConfigError(status: number, message: string | null): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  return /\b(reasoning|effort|thinking)\b/i.test(message ?? "");
}

function openRouterTitlePayload(
  sourceMessage: string,
  titleConfig: OpenRouterTitleConfig,
  reasoningEffort: OpenRouterTitleReasoningEffort | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: titleConfig.model,
    messages: [
      {
        role: "system",
        content:
          "Create a concise terminal tab title for the user's first message. Return only the title, without quotes. Use 2-6 words. Use sentence case, not title case.",
      },
      {
        role: "user",
        content: Array.from(sourceMessage).slice(0, MAX_OPENROUTER_TITLE_SOURCE_CHARS).join(""),
      },
    ],
    temperature: 0.2,
    max_completion_tokens: OPENROUTER_TITLE_MAX_COMPLETION_TOKENS,
    stream: false,
  };
  if (reasoningEffort) {
    payload.reasoning = {
      effort: reasoningEffort,
      exclude: true,
    };
  }
  return payload;
}

async function readOpenRouterPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (response.ok) {
      throw new Error("OpenRouter returned invalid JSON.");
    }
    return raw;
  }
}

async function summarizeFirstMessageTitle(
  sourceMessage: string,
  titleConfig: OpenRouterTitleConfig,
): Promise<string | null> {
  const attempts: (OpenRouterTitleReasoningEffort | null)[] = ["none", "minimal", null];
  for (let index = 0; index < attempts.length; index += 1) {
    const reasoningEffort = attempts[index];
    const payload = openRouterTitlePayload(sourceMessage, titleConfig, reasoningEffort);
    const abortController = new AbortController();
    const timeout = window.setTimeout(
      () => abortController.abort(),
      OPENROUTER_TITLE_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${titleConfig.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "qmux",
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        throw new Error("OpenRouter title request timed out after 15 seconds.");
      }
      throw err;
    } finally {
      window.clearTimeout(timeout);
    }
    const responsePayload = await readOpenRouterPayload(response);
    if (!response.ok) {
      const message = openRouterPayloadErrorMessage(responsePayload) ?? response.statusText;
      if (
        index < attempts.length - 1 &&
        isOpenRouterReasoningConfigError(response.status, message)
      ) {
        continue;
      }
      throw new Error(`OpenRouter request failed (${response.status}): ${message}`);
    }

    const payloadError = openRouterPayloadErrorMessage(responsePayload);
    if (payloadError) {
      throw new Error(`OpenRouter returned an error: ${payloadError}`);
    }
    const title = openRouterTitleFromPayload(responsePayload);
    if (!title) {
      throw new Error(openRouterEmptyTitleMessage(responsePayload));
    }
    return title;
  }
  return null;
}

async function generateFirstMessageTitle(
  sourceMessage: string,
  config: FirstMessageTitleConfig,
): Promise<string | null> {
  if (config.provider === "openRouter") {
    return summarizeFirstMessageTitle(sourceMessage, config);
  }
  const title = await generateFoundationTabTitle(sourceMessage);
  return sanitizeGeneratedTitle(title);
}

function createPendingFirstMessageTitle(
  paneId: string,
  skillCommand: string | null = null,
): PendingFirstMessageTitle {
  return {
    paneId,
    checkedMessages: 0,
    seenTurnIds: new Set(),
    skillCommand,
  };
}

function firstUserTurnText(turn: Turn): string | null {
  if (turn.role !== "user") {
    return null;
  }

  for (const block of turn.blocks) {
    if (block.type !== "text") {
      continue;
    }
    const trimmed = block.text.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function latestUserTurnId(turns: Turn[]): string | null {
  let latest: string | null = null;
  for (const turn of turns) {
    if (firstUserTurnText(turn)) {
      latest = turn.id;
    }
  }
  return latest;
}

function defaultPaneTitle(
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  config: RuntimeConfig | null,
): string | null {
  if (pane.kind === "shell") {
    return DEFAULT_SHELL_TITLE;
  }
  if (!agent) {
    return null;
  }
  return (
    config?.adapters.find((adapter) => adapter.id === agent.adapter)?.label ??
    findAgentUiAdapter(agent.adapter)?.label ??
    null
  );
}

export default function App() {
  const appRef = useRef<HTMLElement | null>(null);
  const paneListRef = useRef<HTMLElement | null>(null);
  const terminalStageRef = useRef<HTMLDivElement | null>(null);
  const terminalPaneRefs = useRef(new Map<string, TerminalPaneHandle>());
  // Becomes true once the single backend event subscription is live. Until then,
  // panes that want to attach are parked here so their pre-attach backlog is only
  // released after the listener can actually deliver it.
  const eventsReadyRef = useRef(false);
  const pendingAttachRef = useRef<Set<string>>(new Set());
  const panesRef = useRef<PaneInfo[]>([]);
  const agentsRef = useRef<AgentInfo[]>([]);
  const queuedTurnsByAgentRef = useRef<Record<string, QueuedTurn[]>>({});
  // Composer drafts live here keyed by agent so they survive tab switches; the
  // ref mirrors the state for synchronous reads from the debounced disk flush.
  const draftsByAgentRef = useRef<Record<string, string>>({});
  const draftFlushTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Per-agent queue scroll positions, so switching tabs (even through a shell pane,
  // which unmounts the composer) restores where each queue was left. Ephemeral: a ref
  // so scroll updates never re-render, and the whole thing is dropped on app restart.
  const queueScrollByAgentRef = useRef<Record<string, number>>({});
  const wasLauncherOpenRef = useRef(false);
  const launcherInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Keep active-tab actions reachable from the global keydown listener without
  // re-registering it on every state change.
  const activePaneRef = useRef<PaneInfo | undefined>(undefined);
  const requestClosePaneRef = useRef<(pane: PaneInfo) => void>(() => {});
  const splitPaneBelowRef = useRef<(pane: PaneInfo) => void | Promise<void>>(() => {});
  const canToggleActiveTranscriptExpandedRef = useRef(false);
  const toggleActiveTranscriptExpandedRef = useRef<() => void>(() => {});
  const paneTabPointerDragRef = useRef<PaneTabPointerDrag | null>(null);
  const groupPointerDragRef = useRef<GroupPointerDrag | null>(null);
  const suppressGroupMenuButtonClickRef = useRef(false);
  const browserOverlayByPaneRef = useRef<Record<string, BrowserOverlayState>>({});
  const toggleActiveBrowserOverlayRef = useRef<() => void>(() => {});
  const closeActiveBrowserOverlayRef = useRef<() => void>(() => {});
  const terminalSplitResizeRef = useRef<{
    splitId: string;
    dividerIndex: number;
    startY: number;
    stageHeight: number;
    startSplit: PaneSplitInfo;
  } | null>(null);
  // Debounced "user is typing" hold per agent: while active the backend won't
  // auto-drain that agent's queue. Holds the agent id + the pending release timer.
  const agentTypingRef = useRef<{ agentId: string; timer: number } | null>(null);
  const paneDropTargetRef = useRef<PaneDropTarget | null>(null);
  const groupDropTargetRef = useRef<GroupDropTarget | null>(null);
  const paneReorderPersistChainRef = useRef<Promise<void>>(Promise.resolve());
  const paneReorderRequestSeqRef = useRef(0);
  const groupReorderPersistChainRef = useRef<Promise<void>>(Promise.resolve());
  const groupReorderRequestSeqRef = useRef(0);
  const pendingFirstTitleByAgentRef = useRef<Map<string, PendingFirstMessageTitle>>(new Map());
  const titleRegenerationSeqByPaneRef = useRef<Record<string, number>>({});
  const paneSplitsRef = useRef<PaneSplitInfo[]>([]);
  const titleGenerationTestSeqRef = useRef(0);
  const activeTabPersistenceReadyRef = useRef(false);
  const appToastTimerRef = useRef<number | null>(null);
  const suppressPaneTabClickRef = useRef(false);
  const dismissedRecoveredPaneIdsRef = useRef<Set<string>>(new Set());
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const configRef = useRef<RuntimeConfig | null>(null);
  configRef.current = config;
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [lastActiveGroupId, setLastActiveGroupId] = useState<string | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(
    null,
  );
  const [settingsMenu, setSettingsMenu] = useState<{ x: number; y: number } | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const applyRecoveredDismissals = useCallback((paneList: PaneInfo[]) => {
    const dismissed = dismissedRecoveredPaneIdsRef.current;
    if (dismissed.size === 0) {
      return paneList;
    }
    let changed = false;
    const next = paneList.map((pane) => {
      if (pane.recovered && dismissed.has(pane.id)) {
        changed = true;
        return { ...pane, recovered: false };
      }
      return pane;
    });
    return changed ? next : paneList;
  }, []);
  const setPanesPreservingRecoveredDismissals = useCallback(
    (update: SetStateAction<PaneInfo[]>) => {
      setPanes((current) => {
        const next =
          typeof update === "function"
            ? (update as (current: PaneInfo[]) => PaneInfo[])(current)
            : update;
        return applyRecoveredDismissals(next);
      });
    },
    [applyRecoveredDismissals],
  );
  const [terminalTitleByPane, setTerminalTitleByPane] = useState<Record<string, string>>({});
  const [manuallyTitledPaneIds, setManuallyTitledPaneIds] = useState<Set<string>>(
    () => new Set(),
  );
  const manuallyTitledPaneIdsRef = useRef(manuallyTitledPaneIds);
  manuallyTitledPaneIdsRef.current = manuallyTitledPaneIds;
  const [regeneratingTitlePaneIds, setRegeneratingTitlePaneIds] = useState<Set<string>>(
    () => new Set(),
  );
  const regeneratingTitlePaneIdsRef = useRef(regeneratingTitlePaneIds);
  regeneratingTitlePaneIdsRef.current = regeneratingTitlePaneIds;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // Agents we believe are actively working *right now*, used to show the
  // "Working…" indicator at the bottom of the transcript. This is driven by live
  // status transitions (see useQmuxEvents), not the raw status field: an agent
  // restored into a working status — or loaded that way from the boot snapshot —
  // must not light up, since it isn't genuinely doing work. Membership is added
  // only on a live event that moves the agent into a working status (and on the
  // user's own send), and cleared on any non-working event.
  const [thinkingAgentIds, setThinkingAgentIds] = useState<Set<string>>(() => new Set());
  const [processingNewMessageByAgent, setProcessingNewMessageByAgent] = useState<
    Record<string, string | null>
  >({});
  const [turns, setTurns] = useState<Turn[]>([]);
  const [queuedTurnsByAgent, setQueuedTurnsByAgentState] = useState<Record<string, QueuedTurn[]>>({});
  const [hookEventsByAgent, setHookEventsByAgent] = useState<
    Record<string, TranscriptHookEvent[]>
  >({});
  // Latest unexpected-state message per agent (stalled/unreadable transcript,
  // adapter failure). Shown under the right pane's "No activity yet" placeholder;
  // null clears it once the transcript tail recovers.
  const [transcriptNoticeByAgent, setTranscriptNoticeByAgent] = useState<
    Record<string, string | null>
  >({});
  // Sessions available per agent for the right pane's transcript picker. Fetched
  // lazily when an agent is viewed and refreshed when its transcript rotates.
  const [transcriptOptionsByAgent, setTranscriptOptionsByAgent] = useState<
    Record<string, TranscriptOption[]>
  >({});
  const [collapsedQueuedTurnsByAgent, setCollapsedQueuedTurnsByAgent] = useState<
    Record<string, boolean[]>
  >({});
  const [waitTargetHoverAgentId, setWaitTargetHoverAgentId] = useState<string | null>(null);
  const [draftsByAgent, setDraftsByAgentState] = useState<Record<string, string>>({});
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [shortcutHintsVisible, setShortcutHintsVisible] = useState(false);
  const [turnPaneWidth, setTurnPaneWidth] = useState(TURN_PANE_DEFAULT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  // Application-level settings, loaded from localStorage once on mount and
  // persisted on every change. Shared by every pane. Font size is also adjustable
  // in-session with Cmd-=/Cmd--.
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"basic" | "advanced">("basic");
  const [openRouterKeyVisible, setOpenRouterKeyVisible] = useState(false);
  const [showHideShortcutSetting, setShowHideShortcutSetting] =
    useState<ShowHideShortcutSetting>({
      accelerator: null,
      registered: false,
      error: null,
    });
  const [showHideShortcutSaving, setShowHideShortcutSaving] = useState(false);
  const showHideShortcutValue = showHideShortcutSetting.accelerator ?? "";
  const showHideShortcutMessage =
    showHideShortcutSetting.error ??
    (showHideShortcutValue && !showHideShortcutSetting.registered
      ? "Shortcut is saved but not active."
      : null);
  const terminalFontSize = settings.fontSize;
  const terminalFontFamily = fontStackFor(settings.fontId);
  const terminalLetterSpacing = letterSpacingFor(settings.fontId);
  const terminalScrollSensitivity = scrollSensitivityFor(settings.mouseWheelSensitivity);
  const pasteProtection = useMemo(() => pasteProtectionFor(settings), [settings]);
  const shortcutHintsShown = settings.showShortcutHints && shortcutHintsVisible;
  const [prompt, setPrompt] = useState("");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherAdapterId, setLauncherAdapterId] = useState<string | null>(null);
  const [launcherOptionsByAdapter, setLauncherOptionsByAdapter] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [createInWorktree, setCreateInWorktree] = useState(false);
  // Skills the qmux-managed Claude plugin can inject, and the single one selected
  // for this launch (prepended to the prompt as `/<plugin>:<skill>`). Single-select
  // because a leading slash command can only invoke one skill.
  const [availableSkills, setAvailableSkills] = useState<ClaudeSkill[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  // Measured width of the faint skill-command prefix, used to indent the first line
  // of the composer so typed text starts after the immutable command.
  const [skillPrefixWidth, setSkillPrefixWidth] = useState(0);
  const skillPrefixRef = useRef<HTMLSpanElement | null>(null);
  // The floating Ask popup over a text selection, and the ask launcher it opens.
  // Both are ephemeral: dismissing discards their contents (per the "can be lost"
  // requirement). The ask launcher reuses the launcher's markup but its own state.
  const [selectionAsk, setSelectionAsk] = useState<SelectionAskState | null>(null);
  const selectionAskHideTimerRef = useRef<number | null>(null);
  const [askLauncher, setAskLauncher] = useState<AskLauncherState | null>(null);
  const [askPrompt, setAskPrompt] = useState("");
  const [askCreateInWorktree, setAskCreateInWorktree] = useState(false);
  const [askSelectedSkillId, setAskSelectedSkillId] = useState<string | null>(null);
  const askInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Mirrors `askLauncher !== null` for the global keydown handler (which reads refs
  // rather than re-subscribing) so it can yield the keyboard while the ask modal is
  // open.
  const askLauncherOpenRef = useRef(false);
  askLauncherOpenRef.current = askLauncher !== null;
  // Guards `submitAsk` against re-entry (held Cmd+Enter, a double-click) so a single
  // ask never sends twice or — worse, in "new thread" mode — forks twice.
  const askSubmittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [appToast, setAppToast] = useState<{
    message: string;
    tone: "normal" | "warning";
  } | null>(null);
  const [folderPickerStatus, setFolderPickerStatus] = useState<string | null>(null);
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  const closeConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Which worktree-dialog action is mid-flight, so the dialog stays open (and its
  // buttons disabled) until the close/delete actually finishes.
  const [resolvingClose, setResolvingClose] = useState<"keep" | "delete" | null>(null);
  const [exitDialog, setExitDialog] = useState<ExitDialogState | null>(null);
  const exitConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const [exitPreflightRequest, setExitPreflightRequest] =
    useState<ExitPreflightRequest | null>(null);
  const [renamePaneId, setRenamePaneId] = useState<string | null>(null);
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [titleGenerationTest, setTitleGenerationTest] =
    useState<TitleGenerationTestState | null>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<PaneContextMenuState | null>(null);
  const [paneSplits, setPaneSplitsState] = useState<PaneSplitInfo[]>([]);
  paneSplitsRef.current = paneSplits;
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [paneDropTarget, setPaneDropTarget] = useState<PaneDropTarget | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [groupDropTarget, setGroupDropTarget] = useState<GroupDropTarget | null>(null);
  // Per-pane browser overlay state, so each tab keeps its own page and open/closed.
  const [browserOverlayByPane, setBrowserOverlayByPane] = useState<
    Record<string, BrowserOverlayState>
  >({});
  const [transcriptExpandedByPane, setTranscriptExpandedByPane] = useState<
    Record<string, boolean>
  >({});
  const [splitTranscriptExpandedByPane, setSplitTranscriptExpandedByPane] = useState<
    Record<string, boolean>
  >({});
  const [rightBarCollapsed, setRightBarCollapsed] = useState(false);
  const [queueSplitByAgent, setQueueSplitByAgent] = useState<Record<string, boolean>>({});
  const [queueSplitHeightByAgent, setQueueSplitHeightByAgent] = useState<Record<string, number>>(
    {},
  );
  // Right-click chooser for a link (transcript or terminal): internal vs external.
  const [linkMenu, setLinkMenu] = useState<{
    url: string;
    x: number;
    y: number;
    paneId: string | null;
  } | null>(null);
  // The Home tab is selected explicitly, or implicitly whenever there are no real
  // panes to fall back to. While Home is active there is no active terminal pane.
  const homeActive = activePaneId === HOME_TAB_ID || panes.length === 0;
  const activePane = useMemo(
    () => (homeActive ? undefined : (panes.find((pane) => pane.id === activePaneId) ?? panes[0])),
    [homeActive, activePaneId, panes],
  );
  const paneById = useMemo(
    () => new Map(panes.map((pane) => [pane.id, pane])),
    [panes],
  );
  const agentByPaneId = useMemo(() => {
    const result = new Map<string, AgentInfo>();
    for (const agent of agents) {
      if (agent.paneId) {
        result.set(agent.paneId, agent);
      }
    }
    return result;
  }, [agents]);
  const agentTurnInfoById = useMemo(() => {
    const turnsByAgent = new Map<string, Turn[]>();
    for (const turn of turns) {
      const agentTurns = turnsByAgent.get(turn.agentId);
      if (agentTurns) {
        agentTurns.push(turn);
      } else {
        turnsByAgent.set(turn.agentId, [turn]);
      }
    }
    const result = new Map<string, AgentTurnInfo>();
    for (const agent of agents) {
      const agentTurns = turnsByAgent.get(agent.id) ?? [];
      const adapter = getAgentUiAdapter(agent.adapter);
      const normalizedTurns = adapter.normalizeTurns?.(agentTurns) ?? agentTurns;
      const assistantLabel = adapter.label;
      result.set(agent.id, {
        turns: normalizedTurns,
        assistantLabel,
        transcript: formatTurnsTranscript(normalizedTurns, assistantLabel),
      });
    }
    return result;
  }, [agents, turns]);
  const activeAgent = activePane ? agentByPaneId.get(activePane.id) : undefined;
  const activePaneSplit = useMemo(
    () => paneSplitForPane(paneSplits, activePane?.id),
    [activePane?.id, paneSplits],
  );
  const splitRightPaneMode = Boolean(activePaneSplit && activePaneSplit.paneIds.length > 1);
  const activeSplitFractions = useMemo(
    () => (activePaneSplit ? splitFractions(activePaneSplit) : []),
    [activePaneSplit],
  );
  const visibleTerminalPaneIds = useMemo(
    () => (activePaneSplit ? activePaneSplit.paneIds : activePane ? [activePane.id] : []),
    [activePane?.id, activePaneSplit],
  );
  const visibleTerminalPanes = useMemo(
    () =>
      visibleTerminalPaneIds
        .map((paneId) => paneById.get(paneId))
        .filter((pane): pane is PaneInfo => Boolean(pane)),
    [paneById, visibleTerminalPaneIds],
  );
  const visibleTerminalPaneIdSet = useMemo(
    () => new Set(visibleTerminalPaneIds),
    [visibleTerminalPaneIds],
  );
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const sidebarPanes = useMemo(() => {
    const grouped = groups.flatMap((group) => panes.filter((pane) => pane.groupId === group.id));
    const groupedIds = new Set(grouped.map((pane) => pane.id));
    return [...grouped, ...panes.filter((pane) => !groupedIds.has(pane.id))];
  }, [groups, panes]);
  const cycleableSidebarPanes = useMemo(
    () => sidebarPanes.filter((pane) => groupById.get(pane.groupId)?.collapsed !== true),
    [groupById, sidebarPanes],
  );
  const shortcutLabelForPaneId = useCallback(
    (paneId?: string | null) => {
      if (!paneId) {
        return null;
      }
      const index = sidebarPanes.findIndex((pane) => pane.id === paneId);
      return index >= 0 && index < 9 ? `⌘${index + 1}` : null;
    },
    [sidebarPanes],
  );
  const activeBrowserOverlay = activePane ? browserOverlayByPane[activePane.id] : undefined;
  useEffect(() => {
    if (activePane?.groupId) {
      setLastActiveGroupId(activePane.groupId);
    }
  }, [activePane?.groupId]);
  useEffect(() => {
    if (!activeTabPersistenceReadyRef.current) {
      return;
    }
    const nextActiveTabId = homeActive ? HOME_TAB_ID : (activePane?.id ?? null);
    if (!nextActiveTabId) {
      return;
    }
    void setActiveTab(nextActiveTabId).catch(() => undefined);
  }, [homeActive, activePane?.id]);
  const handleTerminalTitleChange = useCallback((paneId: string, rawTitle: string) => {
    const title = sanitizeTerminalTitle(rawTitle);
    setTerminalTitleByPane((current) => {
      if (!title) {
        if (!(paneId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[paneId];
        return next;
      }
      if (current[paneId] === title) {
        return current;
      }
      return { ...current, [paneId]: title };
    });
  }, []);

  function paneUsesDefaultTitle(pane: PaneInfo, agent: AgentInfo | undefined): boolean {
    if (manuallyTitledPaneIdsRef.current.has(pane.id)) {
      return false;
    }
    const defaultTitle = defaultPaneTitle(pane, agent, configRef.current);
    return defaultTitle !== null && pane.title === defaultTitle;
  }

  function paneHasUserSetTitle(pane: PaneInfo, agent: AgentInfo | undefined): boolean {
    if (manuallyTitledPaneIdsRef.current.has(pane.id)) {
      return true;
    }
    const defaultTitle = defaultPaneTitle(pane, agent, configRef.current);
    return defaultTitle !== null && pane.title !== defaultTitle;
  }

  function paneStillBelongsToAgent(
    pane: PaneInfo,
    agent: AgentInfo | undefined,
    expectedAgentId: string | undefined,
  ): boolean {
    return !expectedAgentId || agent?.id === expectedAgentId || pane.agentId === expectedAgentId;
  }

  function displayPaneTitle(pane: PaneInfo, agent: AgentInfo | undefined): string {
    const terminalTitle = terminalTitleByPane[pane.id];
    return terminalTitle && paneUsesDefaultTitle(pane, agent) ? terminalTitle : pane.title;
  }

  function queuedTurnsForAgent(agent: AgentInfo | undefined): QueuedTurn[] {
    return agent ? (queuedTurnsByAgent[agent.id] ?? []) : [];
  }

  function paneWaitsOnOtherPane(agent: AgentInfo | undefined): boolean {
    if (!agent) {
      return false;
    }
    const firstQueuedTurn = queuedTurnsForAgent(agent)[0];
    return Boolean(firstQueuedTurn?.waitFor && firstQueuedTurn.waitFor.agentId !== agent.id);
  }

  function paneTabStatusTone(agent: AgentInfo | undefined): MenuBarStatusTone {
    return agent ? (agentStatusTone(agent.status) as MenuBarStatusTone) : "idle";
  }

  function paneTabStatusLabel(pane: PaneInfo, agent: AgentInfo | undefined): string | null {
    const queueCount = queuedTurnsForAgent(agent).length;
    const rawStatus = agent ? agentStatusLabel(agent.status) : statusLabel(pane.status);
    return (agent?.status === "running" || agent?.status === "idle") && queueCount > 0
      ? `${queueCount} ${paneWaitsOnOtherPane(agent) ? "waiting" : "queued"}`
      : rawStatus === "Running"
        ? null
        : rawStatus;
  }

  function paneTabStatusMetaLabel(pane: PaneInfo, agent: AgentInfo | undefined): string | null {
    const tabStatus = paneTabStatusLabel(pane, agent);
    if (pane.recovered && tabStatus) {
      return `Restored, ${tabStatus}`;
    }
    return pane.recovered ? "Restored" : tabStatus;
  }

  function collapsedGroupStatusAgents(groupPanes: PaneInfo[]): AgentInfo[] {
    return groupPanes
      .map((pane) => agentByPaneId.get(pane.id))
      .filter(
        (agent): agent is AgentInfo =>
          agent !== undefined && agent.status !== "done" && agent.status !== "idle",
      );
  }

  function collapsedGroupStatusLabel(agent: AgentInfo) {
    return agentStatusLabel(agent.status) ?? agent.status;
  }

  function showAppToast(message: string, tone: "normal" | "warning" = "normal") {
    setAppToast({ message, tone });
    if (appToastTimerRef.current !== null) {
      window.clearTimeout(appToastTimerRef.current);
    }
    appToastTimerRef.current = window.setTimeout(() => {
      setAppToast(null);
      appToastTimerRef.current = null;
    }, APP_TOAST_TIMEOUT_MS);
  }

  function setPaneTitleRegenerationBusy(paneId: string, busy: boolean) {
    const next = new Set(regeneratingTitlePaneIdsRef.current);
    if (busy) {
      next.add(paneId);
    } else {
      next.delete(paneId);
    }
    if (next.size === regeneratingTitlePaneIdsRef.current.size) {
      return;
    }
    regeneratingTitlePaneIdsRef.current = next;
    setRegeneratingTitlePaneIds(next);
  }

  async function testFirstMessageTitleGeneration() {
    const settingsSnapshot = settingsRef.current;
    const titleConfig = firstMessageTitleConfig(settingsSnapshot, configRef.current);
    const providerLabel = titleConfig
      ? firstMessageTitleProviderLabel(titleConfig)
      : tabTitleProviderLabel(settingsSnapshot.tabTitleProvider);
    const requestSeq = titleGenerationTestSeqRef.current + 1;
    titleGenerationTestSeqRef.current = requestSeq;

    if (!titleConfig) {
      const message =
        settingsSnapshot.tabTitleProvider === "openRouter"
          ? "Add an OpenRouter key and model before testing."
          : settingsSnapshot.tabTitleProvider === "appleFoundationModels"
            ? "Apple Foundation Models are not available in this build."
            : "Choose a title generation provider before testing.";
      setTitleGenerationTest({ status: "error", providerLabel, message });
      return;
    }

    const sourceMessage = firstMessageTitleSource(TITLE_GENERATION_TEST_MESSAGE);
    if (!sourceMessage) {
      setTitleGenerationTest({
        status: "error",
        providerLabel,
        message: "Test message could not be prepared.",
      });
      return;
    }

    setTitleGenerationTest({ status: "running", providerLabel });
    try {
      const title = await generateFirstMessageTitle(sourceMessage, titleConfig);
      if (!title) {
        throw new Error(`${providerLabel} returned no title.`);
      }
      if (titleGenerationTestSeqRef.current !== requestSeq) {
        return;
      }
      setTitleGenerationTest({ status: "success", providerLabel, title });
      showAppToast(`${providerLabel} title test: ${title}`);
    } catch (err) {
      if (titleGenerationTestSeqRef.current !== requestSeq) {
        return;
      }
      const message = unknownErrorMessage(err);
      setTitleGenerationTest({ status: "error", providerLabel, message });
      showAppToast(`${providerLabel} title test failed: ${message}`, "warning");
    }
  }

  async function applyFirstMessageTitle(
    paneId: string,
    sourceMessage: string,
    titleConfig: FirstMessageTitleConfig,
    fallbackPane?: PaneInfo,
    expectedAgentId?: string,
  ) {
    if (!sourceMessage) {
      return;
    }

    const pane =
      panesRef.current.find((candidate) => candidate.id === paneId) ?? fallbackPane;
    const paneAgent = pane
      ? agentsRef.current.find((agent) => agent.paneId === pane.id)
      : undefined;
    if (pane && !paneStillBelongsToAgent(pane, paneAgent, expectedAgentId)) {
      return;
    }
    if (pane && paneHasUserSetTitle(pane, paneAgent)) {
      return;
    }

    let title: string | null;
    try {
      title = await generateFirstMessageTitle(sourceMessage, titleConfig);
    } catch (err) {
      showAppToast(
        `${firstMessageTitleProviderLabel(titleConfig)} title error: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "warning",
      );
      return;
    }
    if (!title) {
      return;
    }

    const currentPane =
      panesRef.current.find((candidate) => candidate.id === paneId) ?? fallbackPane;
    const currentPaneAgent = currentPane
      ? agentsRef.current.find((agent) => agent.paneId === currentPane.id)
      : undefined;
    if (
      currentPane &&
      !paneStillBelongsToAgent(currentPane, currentPaneAgent, expectedAgentId)
    ) {
      return;
    }
    if (!currentPane || paneHasUserSetTitle(currentPane, currentPaneAgent)) {
      return;
    }

    try {
      const updated = await renamePane(paneId, title);
      setManuallyTitledPaneIds((current) => {
        const next = new Set(current);
        next.add(paneId);
        return next;
      });
      setPanesPreservingRecoveredDismissals((current) =>
        current.map((pane) => (pane.id === paneId ? { ...pane, title: updated.title } : pane)),
      );
    } catch (err) {
      showAppToast(
        `Couldn't set terminal title: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }
  }

  async function regeneratePaneTitleFromUserMessage(
    paneId: string,
    rawMessage: string,
    expectedAgentId?: string,
  ) {
    if (regeneratingTitlePaneIdsRef.current.has(paneId)) {
      return;
    }

    const titleConfig = firstMessageTitleConfig(settingsRef.current, configRef.current);
    if (!titleConfig) {
      showAppToast("Title generation is disabled or unavailable.", "warning");
      return;
    }

    const sourceMessage = firstMessageTitleSource(rawMessage);
    if (!sourceMessage) {
      showAppToast("No title text remains after removing instruction blocks.", "warning");
      return;
    }

    const requestSeq = (titleRegenerationSeqByPaneRef.current[paneId] ?? 0) + 1;
    titleRegenerationSeqByPaneRef.current[paneId] = requestSeq;
    setPaneTitleRegenerationBusy(paneId, true);

    try {
      const title = await generateFirstMessageTitle(sourceMessage, titleConfig);
      if (titleRegenerationSeqByPaneRef.current[paneId] !== requestSeq) {
        return;
      }
      if (!title) {
        showAppToast(`${firstMessageTitleProviderLabel(titleConfig)} returned no title.`, "warning");
        return;
      }

      const pane = panesRef.current.find((candidate) => candidate.id === paneId);
      const paneAgent = pane
        ? agentsRef.current.find((agent) => agent.paneId === pane.id)
        : undefined;
      if (!pane || !paneStillBelongsToAgent(pane, paneAgent, expectedAgentId)) {
        return;
      }

      const updated = await renamePane(paneId, title);
      if (titleRegenerationSeqByPaneRef.current[paneId] !== requestSeq) {
        return;
      }
      setManuallyTitledPaneIds((current) => {
        const next = new Set(current);
        next.add(paneId);
        return next;
      });
      setPanesPreservingRecoveredDismissals((current) =>
        current.map((candidate) =>
          candidate.id === paneId ? { ...candidate, title: updated.title } : candidate,
        ),
      );
      showAppToast(`Renamed tab: ${updated.title}`);
    } catch (err) {
      showAppToast(
        `${firstMessageTitleProviderLabel(titleConfig)} title error: ${unknownErrorMessage(err)}`,
        "warning",
      );
    } finally {
      if (titleRegenerationSeqByPaneRef.current[paneId] === requestSeq) {
        setPaneTitleRegenerationBusy(paneId, false);
      }
    }
  }

  function applyPendingFirstMessageTitle(
    agentId: string,
    rawMessage: string,
    source: { turnId?: string } = {},
  ) {
    const pending = pendingFirstTitleByAgentRef.current.get(agentId);
    if (!pending) {
      return;
    }
    if (source.turnId) {
      if (pending.seenTurnIds.has(source.turnId)) {
        return;
      }
      pending.seenTurnIds.add(source.turnId);
    }

    const messagePreview = normalizedMessagePreview(rawMessage);
    if (!messagePreview) {
      return;
    }
    pending.checkedMessages += 1;
    const sourceMessage = firstMessageTitleSource(rawMessage, pending.skillCommand);
    if (!sourceMessage) {
      if (pending.checkedMessages >= FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
      }
      return;
    }
    const titleConfig = firstMessageTitleConfig(settingsRef.current, configRef.current);
    if (titleConfig) {
      pendingFirstTitleByAgentRef.current.delete(agentId);
      void applyFirstMessageTitle(pending.paneId, sourceMessage, titleConfig, undefined, agentId);
      return;
    }
    pendingFirstTitleByAgentRef.current.delete(agentId);
  }

  function registerShellCodexFirstMessageTitle(
    agent: AgentInfo,
    paneId: string | null,
    source: string | null,
  ) {
    if (source !== "shell" || agent.adapter !== CODEX_ADAPTER_ID) {
      return;
    }
    const resolvedPaneId = paneId ?? agent.paneId ?? null;
    if (!resolvedPaneId || pendingFirstTitleByAgentRef.current.has(agent.id)) {
      return;
    }

    const pane = panesRef.current.find((candidate) => candidate.id === resolvedPaneId);
    if (pane && paneHasUserSetTitle(pane, agent)) {
      return;
    }

    pendingFirstTitleByAgentRef.current.set(
      agent.id,
      createPendingFirstMessageTitle(resolvedPaneId),
    );
  }

  function handleAgentPromptSubmitted(agentId: string, prompt: string) {
    applyPendingFirstMessageTitle(agentId, prompt);
  }

  // Drop per-pane UI state for panes that have closed so it can't leak or resurface.
  useEffect(() => {
    panesRef.current = panes;
    const ids = new Set(panes.map((pane) => pane.id));
    setTerminalTitleByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setManuallyTitledPaneIds((current) => {
      const next = new Set([...current].filter((paneId) => ids.has(paneId)));
      return next.size === current.size ? current : next;
    });
    setRegeneratingTitlePaneIds((current) => {
      const next = new Set([...current].filter((paneId) => ids.has(paneId)));
      if (next.size === current.size) {
        return current;
      }
      regeneratingTitlePaneIdsRef.current = next;
      return next;
    });
    setBrowserOverlayByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setTranscriptExpandedByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setSplitTranscriptExpandedByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    for (const [agentId, pending] of pendingFirstTitleByAgentRef.current) {
      if (!ids.has(pending.paneId)) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
      }
    }
    for (const paneId of Object.keys(titleRegenerationSeqByPaneRef.current)) {
      if (!ids.has(paneId)) {
        delete titleRegenerationSeqByPaneRef.current[paneId];
      }
    }
  }, [panes]);

  // Drop per-agent UI state for agents that no longer exist, so these maps and refs
  // don't grow unbounded across a long session of spawning and closing agents.
  useEffect(() => {
    const ids = new Set(agents.map((agent) => agent.id));
    const pruneRecord = <T,>(current: Record<string, T>): Record<string, T> => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    };
    setHookEventsByAgent(pruneRecord);
    setTranscriptNoticeByAgent(pruneRecord);
    setTranscriptOptionsByAgent(pruneRecord);
    setCollapsedQueuedTurnsByAgent(pruneRecord);
    setProcessingNewMessageByAgent(pruneRecord);
    setThinkingAgentIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
    for (const id of Object.keys(queuedTurnsByAgentRef.current)) {
      if (!ids.has(id)) delete queuedTurnsByAgentRef.current[id];
    }
    for (const id of Object.keys(draftsByAgentRef.current)) {
      if (!ids.has(id)) delete draftsByAgentRef.current[id];
    }
    for (const id of Object.keys(queueScrollByAgentRef.current)) {
      if (!ids.has(id)) delete queueScrollByAgentRef.current[id];
    }
    for (const agentId of pendingFirstTitleByAgentRef.current.keys()) {
      if (!ids.has(agentId)) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
      }
    }
  }, [agents]);

  useEffect(() => {
    setProcessingNewMessageByAgent((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([agentId]) => thinkingAgentIds.has(agentId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [thinkingAgentIds]);

  useEffect(() => {
    setProcessingNewMessageByAgent((current) => {
      const entries = Object.entries(current);
      if (entries.length === 0) {
        return current;
      }

      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      let next: Record<string, string | null> | null = null;
      const mutableNext = () => {
        next ??= { ...current };
        return next;
      };

      for (const [agentId, baselineUserTurnId] of entries) {
        const agent = agentsById.get(agentId);
        if (!agent) {
          delete mutableNext()[agentId];
          continue;
        }

        const agentTurns = turns.filter((turn) => turn.agentId === agentId);
        const adapter = getAgentUiAdapter(agent.adapter);
        const normalizedTurns = adapter.normalizeTurns?.(agentTurns) ?? agentTurns;
        const latestTurnId = latestUserTurnId(normalizedTurns);
        if (latestTurnId && latestTurnId !== baselineUserTurnId) {
          delete mutableNext()[agentId];
        }
      }

      return next ?? current;
    });
  }, [agents, processingNewMessageByAgent, turns]);

  useEffect(() => {
    const pendingAgentIds = Array.from(pendingFirstTitleByAgentRef.current.keys());
    if (pendingAgentIds.length === 0) {
      return;
    }

    for (const agentId of pendingAgentIds) {
      for (const turn of turns) {
        if (!pendingFirstTitleByAgentRef.current.has(agentId)) {
          break;
        }
        if (turn.agentId !== agentId) {
          continue;
        }
        const text = firstUserTurnText(turn);
        if (text) {
          applyPendingFirstMessageTitle(agentId, text, { turnId: turn.id });
        }
      }
    }
  }, [turns]);

  const runtimeDefaultAdapterId =
    config?.adapters.find((adapter) => adapter.default)?.id ?? config?.adapters[0]?.id ?? "claude";
  const selectedLauncherAdapterId = launcherAdapterId ?? runtimeDefaultAdapterId;
  const launchAdapter = useMemo(
    () => getAgentUiAdapter(selectedLauncherAdapterId),
    [selectedLauncherAdapterId],
  );
  const launcherOptions = launcherOptionsByAdapter[launchAdapter.id] ?? {};
  const LauncherOptions = launchAdapter.LauncherOptions;
  // Skills only apply to Claude (the only adapter with a qmux plugin today).
  const skillsEnabled = launchAdapter.id === CLAUDE_ADAPTER_ID;
  const selectedSkill =
    skillsEnabled && selectedSkillId
      ? availableSkills.find((skill) => skill.id === selectedSkillId) ?? null
      : null;
  const launcherAdapters = useMemo(() => {
    const runtimeAdapters = config?.adapters
      .map((adapter) => findAgentUiAdapter(adapter.id))
      .filter((adapter): adapter is NonNullable<typeof adapter> => Boolean(adapter));
    return runtimeAdapters && runtimeAdapters.length > 0 ? runtimeAdapters : agentUiAdapters;
  }, [config]);
  const launcherAdapterOptions = useMemo<LauncherSelectOption[]>(
    () =>
      launcherAdapters.map((adapter) => ({
        value: adapter.id,
        label: adapter.label,
        iconSrc: LAUNCHER_ADAPTER_ICON_BY_ID[adapter.id],
        iconClassName:
          adapter.id === CODEX_ADAPTER_ID
            ? "is-mono-light is-compact"
            : adapter.id === OPENCODE_ADAPTER_ID
              ? "is-compact"
              : undefined,
      })),
    [launcherAdapters],
  );
  function rememberLauncherAdapter(adapterId: string) {
    setLauncherAdapterId(adapterId);
    void setLauncherAdapterPreference(adapterId).catch(() => undefined);
  }
  function focusLauncherInput() {
    requestAnimationFrame(() => launcherInputRef.current?.focus());
  }
  function cycleLauncherAdapter() {
    if (launcherAdapterOptions.length === 0) {
      return;
    }

    const currentIndex = launcherAdapterOptions.findIndex(
      (option) => option.value === launchAdapter.id,
    );
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + 1) % launcherAdapterOptions.length;
    const nextAdapterId = launcherAdapterOptions[nextIndex]?.value;
    if (nextAdapterId && nextAdapterId !== launchAdapter.id) {
      rememberLauncherAdapter(nextAdapterId);
    }
    focusLauncherInput();
  }
  // Live voice dictation for the launcher prompt, mirroring the composer's mic.
  // Reads/writes go through the live textarea so each re-transcription pass
  // overwrites the previous one in place.
  const launcherDictation = useDictation({
    getText: () => launcherInputRef.current?.value ?? prompt,
    getCaret: () => {
      const ta = launcherInputRef.current;
      if (!ta) {
        return prompt.length;
      }
      // If the prompt isn't focused, append at the end rather than wherever
      // selectionStart happens to sit (0 for a never-focused field).
      return document.activeElement === ta ? ta.selectionStart : ta.value.length;
    },
    setText: (text, caret) => {
      setPrompt(text);
      requestAnimationFrame(() => {
        const ta = launcherInputRef.current;
        if (!ta) {
          return;
        }
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    },
    focus: () => launcherInputRef.current?.focus(),
  });
  function focusAskInput() {
    requestAnimationFrame(() => askInputRef.current?.focus());
  }
  // Voice dictation for the ask launcher's question field, mirroring the launcher
  // and composer mics so its recording/loading/error states stay identical.
  const askDictation = useDictation({
    getText: () => askInputRef.current?.value ?? askPrompt,
    getCaret: () => {
      const ta = askInputRef.current;
      if (!ta) {
        return askPrompt.length;
      }
      return document.activeElement === ta ? ta.selectionStart : ta.value.length;
    },
    setText: (text, caret) => {
      setAskPrompt(text);
      requestAnimationFrame(() => {
        const ta = askInputRef.current;
        if (!ta) {
          return;
        }
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    },
    focus: () => askInputRef.current?.focus(),
  });
  // The Whisper voice model is loaded once and cached; surface its progress as
  // an app-level toast since it's shared across every composer's mic.
  const dictationDownload = useSyncExternalStore(subscribeDictationDownload, getDictationDownload);
  // The launcher renders in two places: the modal (Cmd-; / sidebar button) and,
  // when there are no panes, inline as the content-pane placeholder. Only one is
  // ever mounted at a time (the inline one yields to the modal), so they can share
  // the launcher refs/state and the focus/auto-grow effects below.
  const launcherVisible = launcherOpen || homeActive;

  // Called on each keystroke in an agent's composer or terminal. Sets a backend
  // "typing" hold (so a finishing turn won't auto-drain into what the user is typing)
  // and schedules its release INPUT_DEQUEUE_HOLD_MS after the last keystroke; the
  // release drains a held turn if the agent is idle.
  function noteUserInput(agentId: string) {
    const current = agentTypingRef.current;
    if (current && current.agentId !== agentId) {
      // The user moved to a different agent; release the previous hold immediately.
      window.clearTimeout(current.timer);
      void setAgentTyping(current.agentId, false).catch(() => undefined);
      agentTypingRef.current = null;
    }
    if (agentTypingRef.current) {
      window.clearTimeout(agentTypingRef.current.timer);
    } else {
      void setAgentTyping(agentId, true).catch(() => undefined);
    }
    const timer = window.setTimeout(() => {
      agentTypingRef.current = null;
      void setAgentTyping(agentId, false).catch(() => undefined);
    }, INPUT_DEQUEUE_HOLD_MS);
    agentTypingRef.current = { agentId, timer };
  }

  // Opens (or replaces) a pane's browser overlay with a URL, bumping the reload nonce
  // so even re-opening the same URL reloads. Driven by the browser.open event.
  // `sandbox` is set for token-bearing file-server URLs so the iframe loads them in an
  // opaque origin (see BrowserOverlay); plain http(s) URLs are not sandboxed.
  const openBrowserOverlay = useCallback((paneId: string, url: string, sandbox = false) => {
    setBrowserOverlayByPane((current) => ({
      ...current,
      [paneId]: {
        url,
        open: true,
        reloadNonce: (current[paneId]?.reloadNonce ?? 0) + 1,
        sandbox,
        size: current[paneId]?.size ?? null,
      },
    }));
  }, []);

  const openLinkForPane = useCallback(
    (paneId: string | null | undefined, url: string) => {
      if (paneId && canRenderInInternalBrowser(url)) {
        openBrowserOverlay(paneId, url);
      } else {
        void openExternalUrl(url);
      }
    },
    [openBrowserOverlay],
  );

  const openPaneLink = useCallback(
    (_paneId: string, url: string) => {
      void openExternalUrl(url);
    },
    [],
  );

  const openPaneLinkMenu = useCallback(
    (paneId: string, url: string, x: number, y: number) => {
      setLinkMenu({ url, x, y, paneId });
    },
    [],
  );

  function toggleActiveBrowserOverlay() {
    const paneId = activePane?.id;
    if (!paneId) {
      return;
    }
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      return {
        ...current,
        [paneId]: {
          url: prev?.url ?? null,
          open: !(prev?.open ?? false),
          reloadNonce: prev?.reloadNonce ?? 0,
          sandbox: prev?.sandbox ?? false,
          size: prev?.size ?? null,
        },
      };
    });
  }

  function closeActiveBrowserOverlay() {
    const paneId = activePane?.id;
    if (!paneId) {
      return;
    }
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      if (!prev?.open) {
        return current;
      }
      return { ...current, [paneId]: { ...prev, open: false } };
    });
  }

  function setBrowserOverlaySize(paneId: string, size: BrowserOverlaySize) {
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      if (!prev) {
        return current;
      }
      return { ...current, [paneId]: { ...prev, size } };
    });
  }

  function toggleActiveQueueSplit() {
    const agentId = activeAgent?.id;
    if (!agentId) {
      return;
    }
    setQueueSplitByAgent((current) => ({ ...current, [agentId]: !(current[agentId] ?? false) }));
  }

  function toggledPaneRecord(current: Record<string, boolean>, paneId: string) {
    const next = { ...current };
    if (next[paneId]) {
      delete next[paneId];
    } else {
      next[paneId] = true;
    }
    return next;
  }

  function paneRecordWithFlag(
    current: Record<string, boolean>,
    paneId: string,
    expanded: boolean,
  ) {
    if (expanded) {
      return current[paneId] ? current : { ...current, [paneId]: true };
    }
    if (!current[paneId]) {
      return current;
    }
    const next = { ...current };
    delete next[paneId];
    return next;
  }

  function setTranscriptExpandedForPane(
    paneId: string,
    expanded: boolean,
    splitMode = splitRightPaneMode,
  ) {
    if (splitMode) {
      setSplitTranscriptExpandedByPane((current) =>
        paneRecordWithFlag(current, paneId, expanded),
      );
      return;
    }
    setTranscriptExpandedByPane((current) => paneRecordWithFlag(current, paneId, expanded));
  }

  function toggleTranscriptExpandedForPane(paneId: string, splitMode = splitRightPaneMode) {
    if (splitMode) {
      setSplitTranscriptExpandedByPane((current) => toggledPaneRecord(current, paneId));
      return;
    }
    setTranscriptExpandedByPane((current) => toggledPaneRecord(current, paneId));
  }

  function toggleActiveTranscriptExpanded() {
    const paneId = activePane?.id;
    if (!paneId || !activePaneHasTurnSidebar) {
      return;
    }

    if (rightBarCollapsed) {
      setRightBarCollapsed(false);
      return;
    }

    toggleTranscriptExpandedForPane(paneId);
  }

  function expandNewAgentTranscriptByDefault(pane: PaneInfo) {
    if (settingsRef.current.codeMode || pane.kind !== "agent") {
      return;
    }
    setTranscriptExpandedByPane((current) =>
      current[pane.id] ? current : { ...current, [pane.id]: true },
    );
  }

  function setQueueSplitHeightForAgent(agentId: string, height: number) {
    setQueueSplitHeightByAgent((current) => ({ ...current, [agentId]: height }));
  }

  function refreshActiveBrowserOverlay() {
    const paneId = activePane?.id;
    if (!paneId) {
      return;
    }
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      if (!prev) {
        return current;
      }
      return { ...current, [paneId]: { ...prev, reloadNonce: prev.reloadNonce + 1 } };
    });
  }

  const getQueueScroll = useCallback(
    (agentId: string) => queueScrollByAgentRef.current[agentId],
    [],
  );
  const saveQueueScroll = useCallback((agentId: string, scrollTop: number) => {
    queueScrollByAgentRef.current[agentId] = scrollTop;
  }, []);

  // Navigate the overlay to a typed address. A bare host (no scheme) gets http://
  // so `localhost:5173` works; file paths still go through `qmux open`.
  function navigateActiveBrowserOverlay(rawInput: string) {
    const paneId = activePane?.id;
    const trimmed = rawInput.trim();
    if (!paneId || !trimmed) {
      return;
    }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    // The overlay can only render loopback http (CSP frame-src). Hand a typed external
    // URL to the OS browser rather than loading a blank, CSP-blocked iframe; the
    // external opener itself rejects anything but http(s)/mailto.
    if (canRenderInInternalBrowser(url)) {
      openBrowserOverlay(paneId, url);
    } else {
      void openExternalUrl(url);
    }
  }

  function linkActionsForPane(paneId: string): LinkActions {
    return {
      openLink: (url) => {
        openLinkForPane(paneId, url);
      },
      openLinkMenu: (url, x, y) => setLinkMenu({ url, x, y, paneId }),
    };
  }

  function turnInfoForAgent(agent: AgentInfo | undefined): AgentTurnInfo {
    if (!agent) {
      return { turns: [], assistantLabel: "Claude", transcript: "" };
    }
    return (
      agentTurnInfoById.get(agent.id) ?? {
        turns: [],
        assistantLabel: getAgentUiAdapter(agent.adapter).label,
        transcript: "",
      }
    );
  }

  function waitTargetsForAgent(activeWaitAgent: AgentInfo | undefined): WaitTarget[] {
    if (!activeWaitAgent) {
      return [];
    }
    return sidebarPanes
      .flatMap((pane) => {
        const agent = agentByPaneId.get(pane.id);
        if (!agent) {
          return [];
        }
        if (agent.id === activeWaitAgent.id || agent.status === "failed") {
          return [];
        }
        const queuedTurns = queuedTurnsByAgent[agent.id] ?? [];
        const hasActiveWork =
          agent.status === "starting" ||
          agent.status === "running" ||
          agent.status === "awaitingInput" ||
          agent.status === "awaitingPermission";
        if (!hasActiveWork && queuedTurns.length === 0) {
          return [];
        }
        return [
          {
            agentId: agent.id,
            paneId: pane.id,
            label: displayPaneTitle(pane, agent),
            shortcutLabel: shortcutLabelForPaneId(pane.id),
            status: agent.status,
            queueCount: queuedTurns.length,
            queueBlocked: Boolean(queuedTurns[0]?.waitFor),
          },
        ];
      });
  }

  function orphanedQueuesForPane(pane: PaneInfo | undefined): OrphanedQueueGroup[] {
    if (!pane) {
      return [];
    }
    return agents
      .filter((agent) => agent.orphanedQueuePaneId === pane.id)
      .map((agent) => ({
        agent,
        queuedTurns: queuedTurnsByAgent[agent.id] ?? [],
      }))
      .filter((queue) => queue.queuedTurns.length > 0);
  }

  function turnPaneSurfaceForPane(pane: PaneInfo, splitIndex = -1): TurnPaneSurface {
    const agent = agentByPaneId.get(pane.id);
    const turnInfo = turnInfoForAgent(agent);
    const orphanedQueues = orphanedQueuesForPane(pane);
    const topFraction =
      splitRightPaneMode && splitIndex > 0
        ? activeSplitFractions.slice(0, splitIndex).reduce((sum, value) => sum + value, 0)
        : 0;
    const heightFraction =
      splitRightPaneMode && splitIndex >= 0 ? (activeSplitFractions[splitIndex] ?? 0) : 1;

    return {
      pane,
      agent,
      turns: turnInfo.turns,
      assistantLabel: turnInfo.assistantLabel,
      transcript: turnInfo.transcript,
      hookEvents: agent ? (hookEventsByAgent[agent.id] ?? []) : [],
      transcriptNotice: agent ? (transcriptNoticeByAgent[agent.id] ?? null) : null,
      transcriptOptions: agent ? (transcriptOptionsByAgent[agent.id] ?? []) : [],
      queuedTurns: agent ? (queuedTurnsByAgent[agent.id] ?? []) : [],
      waitTargets: waitTargetsForAgent(agent),
      collapsedQueuedTurns: agent ? (collapsedQueuedTurnsByAgent[agent.id] ?? []) : [],
      draft: agent ? (draftsByAgent[agent.id] ?? "") : "",
      orphanedQueues,
      queueSplit: agent ? (queueSplitByAgent[agent.id] ?? false) : false,
      queueSplitHeight: agent ? queueSplitHeightByAgent[agent.id] : undefined,
      browserOverlay: browserOverlayByPane[pane.id],
      topFraction,
      heightFraction,
      hasTurnSidebar: Boolean(agent) || orphanedQueues.length > 0,
    };
  }

  const activeTurnPaneSurface = activePane
    ? turnPaneSurfaceForPane(
        activePane,
        activePaneSplit ? activePaneSplit.paneIds.indexOf(activePane.id) : -1,
      )
    : null;
  const splitTurnPaneSurfaces = splitRightPaneMode
    ? visibleTerminalPanes
        .map((pane, index) => turnPaneSurfaceForPane(pane, index))
        .filter((surface) => surface.hasTurnSidebar)
    : [];
  const splitTurnPaneSurfaceByPaneId = new Map(
    splitTurnPaneSurfaces.map((surface) => [surface.pane.id, surface]),
  );
  const visibleTurnPaneSurfaces = splitRightPaneMode
    ? splitTurnPaneSurfaces
    : activeTurnPaneSurface?.hasTurnSidebar
      ? [activeTurnPaneSurface]
      : [];
  const activePaneHasTurnSidebar = Boolean(activeTurnPaneSurface?.hasTurnSidebar);
  const visibleRightBarSurfaces = rightBarCollapsed ? [] : visibleTurnPaneSurfaces;
  const hasVisibleRightBar = visibleRightBarSurfaces.length > 0;
  const hasGlobalTurnSidebar = hasVisibleRightBar && !splitRightPaneMode;
  const activeTranscriptExpanded = Boolean(
    activePane &&
      activePaneHasTurnSidebar &&
      (splitRightPaneMode
        ? splitTranscriptExpandedByPane[activePane.id]
        : transcriptExpandedByPane[activePane.id]),
  );
  const activeTranscriptVisibleExpanded = activeTranscriptExpanded && !rightBarCollapsed;
  const activePaneHasTurnPaneHeader =
    activePaneHasTurnSidebar && !splitRightPaneMode && !rightBarCollapsed;
  const activePaneReservesTurnPaneWidth = Boolean(
    hasGlobalTurnSidebar ||
      (splitRightPaneMode &&
        !rightBarCollapsed &&
        activePaneHasTurnSidebar &&
        !activeTranscriptVisibleExpanded),
  );
  const showFloatingBrowserControls = Boolean(
    activePane &&
      !activeTranscriptVisibleExpanded &&
      !activeBrowserOverlay?.open &&
      !activePaneHasTurnPaneHeader,
  );
  const visibleTurnPaneAgentIds = visibleRightBarSurfaces
    .map((surface) => surface.agent?.id)
    .filter((agentId): agentId is string => Boolean(agentId));
  const visibleTurnPaneAgentIdsKey = visibleTurnPaneAgentIds.join("\0");

  // Load session lists when a pane's right side is visible so transcript pickers are ready.
  useEffect(() => {
    for (const agentId of visibleTurnPaneAgentIds) {
      void refreshTranscriptOptions(agentId);
    }
    // refreshTranscriptOptions only touches stable setters/imports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTurnPaneAgentIdsKey]);

  const menuBarSnapshot = useMemo<MenuBarSnapshot>(() => {
    const agentByPaneId = new Map<string, AgentInfo>();
    for (const agent of agents) {
      if (agent.paneId) {
        agentByPaneId.set(agent.paneId, agent);
      }
    }
    const groupedPaneIds = new Set<string>();
    const tabForPane = (pane: PaneInfo) => {
      const paneAgent = agentByPaneId.get(pane.id);
      const paneDir = paneAgent?.worktreeDir ?? pane.cwd;
      groupedPaneIds.add(pane.id);
      return {
        paneId: pane.id,
        title: displayPaneTitle(pane, paneAgent),
        path: settings.codeMode && settings.showTabDirectories && paneDir
          ? formatPaneDir(paneDir)
          : null,
        depth: pane.depth ?? 0,
        statusTone: paneTabStatusTone(paneAgent),
        statusLabel: paneTabStatusMetaLabel(pane, paneAgent),
        waitingOnPane: paneWaitsOnOtherPane(paneAgent),
        selected: pane.id === activePane?.id,
      };
    };

    const snapshotGroups = groups.map((group) => ({
      id: group.id,
      label: group.nameOverride?.trim() || middleTruncatePath(formatPaneDir(group.dir)),
      tabs: panes.filter((pane) => pane.groupId === group.id).map(tabForPane),
    }));
    const orphanTabs = panes.filter((pane) => !groupedPaneIds.has(pane.id)).map(tabForPane);
    if (orphanTabs.length > 0) {
      snapshotGroups.push({
        id: "__orphaned__",
        label: "Other Tabs",
        tabs: orphanTabs,
      });
    }
    return { groups: snapshotGroups };
  }, [
    activePane?.id,
    agents,
    config,
    groups,
    manuallyTitledPaneIds,
    panes,
    queuedTurnsByAgent,
    settings.codeMode,
    settings.showTabDirectories,
    terminalTitleByPane,
  ]);

  useEffect(() => {
    void updateMenuBar(menuBarSnapshot).catch(() => undefined);
  }, [menuBarSnapshot]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  function replaceQueuedTurnsByAgent(nextQueues: Record<string, QueuedTurn[]>) {
    const previousQueues = queuedTurnsByAgentRef.current;
    queuedTurnsByAgentRef.current = nextQueues;
    setQueuedTurnsByAgentState(nextQueues);
    setCollapsedQueuedTurnsByAgent((current) => {
      const nextCollapsedByAgent: Record<string, boolean[]> = {};
      for (const [agentId, queuedTurns] of Object.entries(nextQueues)) {
        nextCollapsedByAgent[agentId] = reconcileQueuedTurnCollapse(
          previousQueues[agentId] ?? [],
          queuedTurns,
          current[agentId] ?? [],
        );
      }
      return nextCollapsedByAgent;
    });
  }

  function setAgentQueuedTurns(agentId: string, queuedTurns: QueuedTurn[]) {
    const previousQueues = queuedTurnsByAgentRef.current;
    const nextQueues = {
      ...previousQueues,
      [agentId]: queuedTurns,
    };
    queuedTurnsByAgentRef.current = nextQueues;
    setQueuedTurnsByAgentState(nextQueues);
    setCollapsedQueuedTurnsByAgent((current) => {
      const nextCollapsed = {
        ...current,
        [agentId]: reconcileQueuedTurnCollapse(
          previousQueues[agentId] ?? [],
          queuedTurns,
          current[agentId] ?? [],
        ),
      };
      if (queuedTurns.length === 0) {
        delete nextCollapsed[agentId];
      }
      return nextCollapsed;
    });
  }

  // Records a composer draft: the in-memory copy updates immediately so the text
  // is there when the user returns to the tab, while the disk write is debounced
  // (clearing flushes at once so a sent/emptied draft never lingers in state.json).
  function setAgentDraft(agentId: string, draft: string) {
    const nextDrafts = { ...draftsByAgentRef.current };
    if (draft) {
      nextDrafts[agentId] = draft;
    } else {
      delete nextDrafts[agentId];
    }
    draftsByAgentRef.current = nextDrafts;
    setDraftsByAgentState(nextDrafts);

    const timers = draftFlushTimersRef.current;
    const pending = timers[agentId];
    if (pending !== undefined) {
      clearTimeout(pending);
      delete timers[agentId];
    }
    if (!draft) {
      void persistAgentDraft(agentId, "").catch(() => undefined);
      return;
    }
    timers[agentId] = setTimeout(() => {
      delete timers[agentId];
      void persistAgentDraft(agentId, draftsByAgentRef.current[agentId] ?? "").catch(
        () => undefined,
      );
    }, DRAFT_FLUSH_DEBOUNCE_MS);
  }

  // Flushes every still-pending debounced draft right now (used when the window is
  // going away, so the last second of typing is not lost on a quick close).
  function flushPendingDrafts() {
    const timers = draftFlushTimersRef.current;
    for (const [agentId, timer] of Object.entries(timers)) {
      clearTimeout(timer);
      delete timers[agentId];
      void persistAgentDraft(agentId, draftsByAgentRef.current[agentId] ?? "").catch(
        () => undefined,
      );
    }
  }

  function toggleQueuedTurnCollapsed(agentId: string, index: number) {
    setCollapsedQueuedTurnsByAgent((current) => {
      const queuedTurns = queuedTurnsByAgentRef.current[agentId] ?? [];
      if (index < 0 || index >= queuedTurns.length) {
        return current;
      }
      const collapsedTurns = current[agentId] ?? [];
      const nextCollapsedTurns = queuedTurns.map(
        (_, turnIndex) => collapsedTurns[turnIndex] ?? false,
      );
      nextCollapsedTurns[index] = !nextCollapsedTurns[index];
      return {
        ...current,
        [agentId]: nextCollapsedTurns,
      };
    });
  }

  // Compact directory label for a pane tab. Worktrees under the workspace root
  // are shown relative to it (e.g. "group-1/agent-1"); home paths use ~/ and
  // other paths fall back to their last two segments so the meaningful tail stays
  // visible. The full path is preserved in the tab's title attribute.
  function formatPaneDir(rawPath: string): string {
    const workspaceRoot = config?.workspaceRoot;
    if (workspaceRoot && rawPath.startsWith(`${workspaceRoot}/`)) {
      const relative = rawPath.slice(workspaceRoot.length + 1);
      // When the workspace root is the home directory itself, the path is being
      // shown relative to home, so anchor it with ~/ instead of leaving bare
      // segments. A root that is a deeper child of home already reads clearly as
      // a relative path, so it is left unchanged.
      return config?.homeDir && workspaceRoot === config.homeDir
        ? `~/${relative}`
        : relative;
    }
    const homeDir = config?.homeDir;
    if (homeDir && rawPath === homeDir) {
      return "~";
    }
    if (homeDir && rawPath.startsWith(`${homeDir}/`)) {
      return `~/${rawPath.slice(homeDir.length + 1)}`;
    }
    const segments = rawPath.split("/").filter(Boolean);
    if (segments.length <= 2) {
      return rawPath;
    }
    return `…/${segments.slice(-2).join("/")}`;
  }

  // Shorten a display path to fit the narrow sidebar button, preserving the final
  // folder name (the most useful part) and the leading anchor while collapsing the
  // middle to "…". CSS ellipsis is a last-resort safety net; this keeps the tail
  // visible, which left-side CSS truncation would hide.
  function middleTruncatePath(label: string, maxChars = 32): string {
    if (label.length <= maxChars) {
      return label;
    }
    const segments = label.split("/");
    const tail = segments.pop() || segments.pop() || label;
    const head = segments.shift() ?? "";
    const candidate = head ? `${head}/…/${tail}` : `…/${tail}`;
    if (candidate.length <= maxChars) {
      return candidate;
    }
    // Even the final segment alone overflows: clip it from the left so its end shows.
    return `…${tail.slice(-Math.max(4, maxChars - 1))}`;
  }

  function defaultGroupName(group: GroupInfo): string {
    const base = group.dir.split("/").filter(Boolean).pop();
    return base && base.length > 0 ? base : formatPaneDir(group.dir);
  }

  function displayGroupName(group: GroupInfo): string {
    return group.nameOverride?.trim() || defaultGroupName(group);
  }

  function launchGroupId() {
    if (activePane?.groupId) {
      return activePane.groupId;
    }
    if (lastActiveGroupId && groupById.has(lastActiveGroupId)) {
      return lastActiveGroupId;
    }
    return null;
  }

  function insertionSiblingForNewTab(targetGroupId: string | null): string | null {
    const currentPane = activePaneRef.current;
    if (!currentPane) {
      return null;
    }
    const currentPanes = panesRef.current;
    const currentPaneIds = new Set(currentPanes.map((pane) => pane.id));
    if (!currentPaneIds.has(currentPane.id)) {
      return null;
    }
    if (targetGroupId && currentPane.groupId !== targetGroupId) {
      return null;
    }

    const split = paneSplitForPane(paneSplitsRef.current, currentPane.id);
    if (!split) {
      return currentPane.id;
    }

    for (let index = split.paneIds.length - 1; index >= 0; index -= 1) {
      const splitPaneId = split.paneIds[index];
      const splitPane = currentPanes.find((pane) => pane.id === splitPaneId);
      if (splitPane && splitPane.groupId === currentPane.groupId) {
        return splitPane.id;
      }
    }
    return currentPane.id;
  }

  async function panesWithNewTabInLaunchPosition(
    pane: PaneInfo,
    targetGroupId: string | null,
  ): Promise<PaneInfo[]> {
    const siblingPaneId = insertionSiblingForNewTab(targetGroupId);
    if (!siblingPaneId || siblingPaneId === pane.id) {
      return [...panesRef.current.filter((existing) => existing.id !== pane.id), pane];
    }
    return placePaneAfter(pane.id, siblingPaneId);
  }

  async function refreshGroups() {
    setGroups(await listGroups());
  }

  async function changeGroupDirectory(groupId: string) {
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForPaintedFrame();
      const group = await pickGroupDirectory(groupId);
      if (!group) {
        return;
      }
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderPickerStatus(null);
    }
  }

  async function createGroupWithInitialShell(anchorGroup: GroupInfo | null) {
    setError(null);
    try {
      const newGroup = await createGroup({
        dir: anchorGroup?.dir ?? null,
        afterGroupId: anchorGroup?.id ?? null,
      });
      setLauncherOpen(false);
      await createInitialShellForGroup(newGroup.id);
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createInitialShellForGroup(groupId: string) {
    const pane = await spawnShell(estimateInitialPaneSize(false), null, groupId);
    const orderedPanes = await panesWithNewTabInLaunchPosition(pane, groupId);
    setPanesPreservingRecoveredDismissals(orderedPanes);
    setActivePaneId(pane.id);
    setLastActiveGroupId(pane.groupId);
  }

  async function createGroupAfterWithFolder(group: GroupInfo) {
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForPaintedFrame();
      const newGroup = await createGroupWithFolder(group.id);
      if (!newGroup) {
        return;
      }
      await createInitialShellForGroup(newGroup.id);
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderPickerStatus(null);
    }
  }

  async function createGroupFromSettingsMenu() {
    setSettingsMenu(null);
    const anchorGroupId = launchGroupId();
    const fallbackGroup = groups.length > 0 ? groups[groups.length - 1] : null;
    const anchorGroup = anchorGroupId
      ? (groupById.get(anchorGroupId) ?? fallbackGroup)
      : fallbackGroup;
    await createGroupWithInitialShell(anchorGroup);
  }

  async function addShellPaneInGroup(groupId: string | null) {
    setError(null);
    try {
      const sourcePaneId =
        activePane?.kind === "shell" && activePane.groupId === groupId ? activePane.id : null;
      const pane = await spawnShell(estimateInitialPaneSize(false), sourcePaneId, groupId);
      const orderedPanes = await panesWithNewTabInLaunchPosition(pane, groupId);
      setPanesPreservingRecoveredDismissals(orderedPanes);
      setActivePaneId(pane.id);
      setLastActiveGroupId(pane.groupId);
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function estimateSplitPaneSize(nextSplitPaneCount: number): InitialPaneSize {
    const size = estimateInitialPaneSize(false);
    return {
      ...size,
      rows: clamp(
        Math.floor(size.rows / Math.max(1, nextSplitPaneCount)),
        MIN_INITIAL_ROWS,
        size.rows,
      ),
    };
  }

  async function splitPaneBelow(sourcePane: PaneInfo) {
    setError(null);
    setPaneContextMenu(null);
    try {
      const existingSplit = paneSplitForPane(paneSplits, sourcePane.id);
      const nextSplitPaneCount = (existingSplit?.paneIds.length ?? 1) + 1;
      const pane = await spawnShell(
        estimateSplitPaneSize(nextSplitPaneCount),
        sourcePane.kind === "shell" ? sourcePane.id : null,
        sourcePane.groupId,
      );
      const orderedPanes = await placePaneAfter(pane.id, sourcePane.id);
      setPanesPreservingRecoveredDismissals(orderedPanes);
      savePaneSplits(
        joinPaneSplit(paneSplits, orderedPanes, sourcePane.id, pane.id, {
          insertedPaneId: pane.id,
          source: "command",
        }),
        orderedPanes,
      );
      setActivePaneId(pane.id);
      setLastActiveGroupId(pane.groupId);
      await refreshGroups();
      requestAnimationFrame(() => {
        terminalPaneRefs.current.get(pane.id)?.focus();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function joinPaneBelow(sourcePane: PaneInfo, belowPane: PaneInfo) {
    setPaneContextMenu(null);
    savePaneSplits(
      joinPaneSplit(paneSplits, panes, sourcePane.id, belowPane.id, {
        insertedPaneId: belowPane.id,
        source: "join",
      }),
    );
    setActivePaneId(sourcePane.id);
  }

  // Detach a single tab from its split while keeping the remaining members grouped.
  function removePaneFromSplit(pane: PaneInfo) {
    setPaneContextMenu(null);
    setError(null);
    const split = paneSplitForPane(paneSplits, pane.id);
    if (!split || split.paneIds.length < 2) {
      return;
    }
    for (const splitPaneId of split.paneIds) {
      terminalPaneRefs.current.get(splitPaneId)?.preserveViewport();
    }
    const nextSplits = detachPaneFromSplitMemberships(paneSplits, pane.id);
    const memberIndex = split.paneIds.indexOf(pane.id);
    const isEdgeMember = memberIndex === 0 || memberIndex === split.paneIds.length - 1;
    if (isEdgeMember) {
      // An edge member leaves the remaining members contiguous, so the tab can stay
      // put — only the split membership changes.
      savePaneSplits(nextSplits);
      setActivePaneId(pane.id);
      return;
    }

    // A middle member can't stay between the others without re-forming the split, so
    // lift it just below the remaining block before persisting.
    const lastRemainingId = split.paneIds[split.paneIds.length - 1];
    const groupPanes = panes.filter((candidate) => candidate.groupId === pane.groupId);
    const nextGroupPanes = movePaneAfterSubtree(groupPanes, pane.id, lastRemainingId);
    const nextPanes = panesWithGroupOrder(pane.groupId, nextGroupPanes);
    const nextLayout = toLayout(nextPanes);
    const requestSeq = paneReorderRequestSeqRef.current + 1;
    paneReorderRequestSeqRef.current = requestSeq;
    // Apply panes and splits together so the pane-change normalization effect doesn't
    // briefly persist the pre-detach split shape.
    setPanesPreservingRecoveredDismissals(nextPanes);
    setPaneSplitsState(nextSplits);

    const persist = paneReorderPersistChainRef.current
      .catch(() => undefined)
      .then(() => setPaneLayout(nextLayout));

    paneReorderPersistChainRef.current = persist
      .then((orderedPanes) => {
        if (paneReorderRequestSeqRef.current !== requestSeq) {
          return;
        }
        setPanesPreservingRecoveredDismissals(orderedPanes);
        savePaneSplits(nextSplits, orderedPanes);
        setActivePaneId(pane.id);
      })
      .catch((err) => {
        if (paneReorderRequestSeqRef.current !== requestSeq) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        void Promise.all([listPanes(), getPaneSplits().catch(() => paneSplits)])
          .then(([latestPanes, latestSplits]) => {
            if (paneReorderRequestSeqRef.current === requestSeq) {
              setPanesPreservingRecoveredDismissals(latestPanes);
              setPaneSplitsState(normalizePaneSplitsForPanes(latestSplits, latestPanes));
            }
          })
          .catch(() => undefined);
      });
  }

  async function refreshAgentTurnQueue(agentId: string) {
    const queuedTurns = await listAgentTurnQueue(agentId);
    setAgentQueuedTurns(agentId, queuedTurns);
  }

  async function refreshTranscriptOptions(agentId: string) {
    try {
      const options = await listAgentTranscripts(agentId);
      setTranscriptOptionsByAgent((current) => ({ ...current, [agentId]: options }));
    } catch {
      // The picker is a best-effort aid; a failed scan just leaves it hidden.
    }
  }

  async function handleSelectTranscript(agentId: string, path: string | null) {
    setError(null);
    try {
      const updated = await setAgentTranscript(agentId, path);
      // The command repoints the agent but emits no agent.* event, so apply the
      // returned agent directly to keep the dropdown's selection in sync.
      setAgents((current) =>
        current.map((agent) => (agent.id === updated.id ? updated : agent)),
      );
      if (path) {
        // Re-read the session list so the active flag follows the new binding.
        await refreshTranscriptOptions(agentId);
      } else {
        // With no bound transcript there is no directory to rescan from; keep the
        // already-loaded menu visible, just without an active row.
        setTranscriptOptionsByAgent((current) => ({
          ...current,
          [agentId]: (current[agentId] ?? []).map((option) => ({
            ...option,
            isActive: false,
          })),
        }));
        setTranscriptNoticeByAgent((current) => ({ ...current, [agentId]: null }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function discardRecoveredQueuedTurn(agentId: string, index: number, turn: string) {
    setError(null);
    try {
      const result = await removeQueuedAgentTurn(agentId, index, turn);
      setAgentQueuedTurns(agentId, result.queuedTurns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function moveRecoveredQueuedTurn(
    agentId: string,
    targetAgentId: string | null | undefined,
    index: number,
    turn: string,
  ) {
    if (!targetAgentId || targetAgentId === agentId) {
      return;
    }

    setError(null);
    try {
      // One atomic backend call removes from the source and hands the turn to the
      // target (rolling back on failure), so the turn can't end up in both queues.
      const result = await moveQueuedAgentTurn(agentId, targetAgentId, index, turn);
      setAgentQueuedTurns(agentId, result.sourceQueuedTurns);
      setAgentQueuedTurns(targetAgentId, result.targetQueuedTurns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function replaceAgent(updatedAgent: AgentInfo) {
    setAgents((current) =>
      current.map((agent) => (agent.id === updatedAgent.id ? updatedAgent : agent)),
    );
  }

  async function acknowledgeAgentStatus(agentId: string, includeFailed = false) {
    setError(null);
    try {
      replaceAgent(await acknowledgeAgent(agentId, includeFailed));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearAgentWorkingIndicator(agentId: string) {
    setError(null);
    try {
      replaceAgent(await clearAgentWorkingStatus(agentId));
      setThinkingAgentIds((current) => {
        if (!current.has(agentId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(agentId);
        return next;
      });
      setProcessingNewMessageByAgent((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, agentId)) {
          return current;
        }
        const next = { ...current };
        delete next[agentId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function acknowledgePaneIfDone(paneId: string | null) {
    if (!paneId || !document.hasFocus()) {
      return;
    }
    const agent = agentsRef.current.find((candidate) => candidate.paneId === paneId);
    if (agent?.status === "done") {
      void acknowledgeAgentStatus(agent.id);
    }
  }

  function focusActiveTerminal() {
    const paneId = activePane?.id;
    if (!paneId) {
      return;
    }

    requestAnimationFrame(() => {
      terminalPaneRefs.current.get(paneId)?.focus();
    });
  }

  function maxTurnPaneWidth() {
    const appWidth = appRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const available = Math.floor(appWidth - sidebarWidth - TERMINAL_MIN_WIDTH);
    return Math.max(TURN_PANE_MIN_WIDTH, Math.min(TURN_PANE_MAX_WIDTH, available));
  }

  function clampTurnPaneWidth(width: number) {
    return clamp(width, TURN_PANE_MIN_WIDTH, maxTurnPaneWidth());
  }

  // The sidebar may grow until the terminal would fall below its minimum (with the
  // turn pane's current width reserved), capped by a comfortable absolute maximum.
  function maxSidebarWidth() {
    const appWidth = appRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const reservedTurnPane = hasVisibleRightBar ? turnPaneWidth : 0;
    const available = Math.floor(appWidth - TERMINAL_MIN_WIDTH - reservedTurnPane);
    return Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(LEFT_SIDEBAR_MAX_WIDTH, available));
  }

  function clampSidebarWidth(width: number) {
    return clamp(width, LEFT_SIDEBAR_MIN_WIDTH, maxSidebarWidth());
  }

  function estimateInitialPaneSize(willShowTurnPane: boolean): InitialPaneSize {
    const stageRect = terminalStageRef.current?.getBoundingClientRect();
    const appWidth = appRef.current?.getBoundingClientRect().width;
    const reservedTurnPaneWidth = willShowTurnPane ? clampTurnPaneWidth(turnPaneWidth) : 0;
    const terminalWidth =
      appWidth !== undefined
        ? appWidth - sidebarWidth - reservedTurnPaneWidth
        : (stageRect?.width ?? window.innerWidth - sidebarWidth - reservedTurnPaneWidth);
    const terminalHeight = stageRect?.height ?? window.innerHeight;
    const cell = measureTerminalCellSize(terminalFontFamily, terminalFontSize);
    const cols = Math.floor((terminalWidth - TERMINAL_HORIZONTAL_PADDING) / cell.width);
    const rows = Math.floor((terminalHeight - TERMINAL_VERTICAL_PADDING) / cell.height);

    return {
      cols: Number.isFinite(cols)
        ? clamp(cols, MIN_INITIAL_COLS, MAX_INITIAL_COLS)
        : DEFAULT_INITIAL_COLS,
      rows: Number.isFinite(rows)
        ? clamp(rows, MIN_INITIAL_ROWS, MAX_INITIAL_ROWS)
        : DEFAULT_INITIAL_ROWS,
    };
  }

  // Grow the right pane's text by 0.25px for every 1px the terminal font is above
  // its base size, capped at +1px, so the transcript/composer track the terminal
  // zoom without overpowering it. No change at or below the base size.
  const turnFontDelta = Math.min(1, Math.max(0, (terminalFontSize - TERMINAL_FONT_SIZE) * 0.25));
  const transcriptExpandedFontDelta = activeTranscriptVisibleExpanded ? 1 : 0;
  const transcriptExpandedLineHeightDelta = activeTranscriptVisibleExpanded ? 0.1 : 0;

  const appStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--browser-overlay-left": `${BROWSER_OVERLAY_LEFT_MARGIN}px`,
    "--turn-font-delta": `${turnFontDelta}px`,
    "--transcript-expanded-font-delta": `${transcriptExpandedFontDelta}px`,
    "--transcript-expanded-line-height-delta": `${transcriptExpandedLineHeightDelta}`,
    ...(rightBarCollapsed && activePaneHasTurnSidebar
      ? { "--right-bar-restore-control-offset": "34px" }
      : {}),
    ...(activePaneReservesTurnPaneWidth ? { "--turn-pane-width": `${turnPaneWidth}px` } : {}),
    ...(splitRightPaneMode && hasVisibleRightBar
      ? { "--inline-turn-pane-width": `${turnPaneWidth}px` }
      : {}),
  } as CSSProperties;

  function terminalPaneStyle(paneId: string): CSSProperties | undefined {
    if (!activePaneSplit) {
      return undefined;
    }
    const index = activePaneSplit.paneIds.indexOf(paneId);
    if (index < 0) {
      return undefined;
    }
    const top = activeSplitFractions.slice(0, index).reduce((sum, value) => sum + value, 0);
    const height = activeSplitFractions[index] ?? 0;
    const reservesInlineTurnPane =
      !rightBarCollapsed &&
      !activeTranscriptVisibleExpanded &&
      splitTurnPaneSurfaceByPaneId.has(paneId);
    return {
      top: `${top * 100}%`,
      bottom: "auto",
      height: `${height * 100}%`,
      right: reservesInlineTurnPane ? "var(--inline-turn-pane-width)" : 0,
    };
  }

  function terminalSplitDropPlaceholderStyle(): CSSProperties | undefined {
    if (paneDropTarget?.kind !== "terminal-split") {
      return undefined;
    }
    const index = visibleTerminalPaneIds.indexOf(paneDropTarget.targetPaneId);
    if (index < 0) {
      return undefined;
    }
    const paneTop = activePaneSplit
      ? activeSplitFractions.slice(0, index).reduce((sum, value) => sum + value, 0)
      : 0;
    const paneHeight = activePaneSplit ? (activeSplitFractions[index] ?? 0) : 1;
    const top =
      paneDropTarget.position === "below" ? paneTop + paneHeight / 2 : paneTop;
    return {
      top: `${top * 100}%`,
      height: `${(paneHeight / 2) * 100}%`,
    };
  }

  const terminalSplitDropStyle = terminalSplitDropPlaceholderStyle();

  const terminalSplitDividerOffsets = activePaneSplit
    ? activePaneSplit.paneIds.slice(0, -1).map((_, index) =>
        activeSplitFractions.slice(0, index + 1).reduce((sum, value) => sum + value, 0),
      )
    : [];

  function startTerminalSplitResize(
    event: ReactPointerEvent<HTMLDivElement>,
    split: PaneSplitInfo,
    dividerIndex: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const stageHeight = terminalStageRef.current?.getBoundingClientRect().height ?? 0;
    if (stageHeight < TERMINAL_SPLIT_MIN_HEIGHT * split.paneIds.length) {
      return;
    }

    let latestSplit = split;
    terminalSplitResizeRef.current = {
      splitId: split.id,
      dividerIndex,
      startY: event.clientY,
      stageHeight,
      startSplit: split,
    };

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = terminalSplitResizeRef.current;
      if (!drag || drag.splitId !== split.id) {
        return;
      }
      latestSplit = resizeSplitFractions(
        drag.startSplit,
        drag.dividerIndex,
        (pointerEvent.clientY - drag.startY) / drag.stageHeight,
      );
      setPaneSplitsState((current) =>
        current.map((candidate) => (candidate.id === latestSplit.id ? latestSplit : candidate)),
      );
    };

    const finishResize = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", finishResize, true);
      window.removeEventListener("pointercancel", finishResize, true);
      terminalSplitResizeRef.current = null;
      savePaneSplits(
        paneSplits.map((candidate) => (candidate.id === latestSplit.id ? latestSplit : candidate)),
      );
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", finishResize, true);
    window.addEventListener("pointercancel", finishResize, true);
  }

  function resizeTerminalSplitWithKeyboard(
    event: ReactKeyboardEvent<HTMLDivElement>,
    split: PaneSplitInfo,
    dividerIndex: number,
  ) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.08 : 0.03;
    const delta = event.key === "ArrowDown" ? step : -step;
    const resized = resizeSplitFractions(split, dividerIndex, delta);
    savePaneSplits(
      paneSplits.map((candidate) => (candidate.id === resized.id ? resized : candidate)),
    );
  }

  const contextMenuPane = paneContextMenu
    ? panes.find((pane) => pane.id === paneContextMenu.paneId)
    : undefined;
  const contextMenuAgent = contextMenuPane
    ? agents.find((agent) => agent.paneId === contextMenuPane.id)
    : undefined;
  const contextMenuDisplayTitle = contextMenuPane
    ? displayPaneTitle(contextMenuPane, contextMenuAgent)
    : "";
  const contextMenuTerminalTitle = contextMenuPane
    ? (terminalTitleByPane[contextMenuPane.id] ?? null)
    : null;
  const groupMenuGroup = groupMenu ? groups.find((group) => group.id === groupMenu.groupId) : null;
  const appleFoundationTitleAvailable = appleFoundationModelsTitleAvailable(config);
  const titleGenerationEnabled = firstMessageTitleConfig(settings, config) !== null;
  const titleGenerationTestVisible =
    settings.tabTitleProvider === "openRouter" ||
    settings.tabTitleProvider === "appleFoundationModels";
  const titleGenerationTestRunning = titleGenerationTest?.status === "running";
  const draggingPaneGroup = draggingPaneId
    ? panes.find((pane) => pane.id === draggingPaneId)?.groupId
    : undefined;
  const draggingGroupPanes = draggingPaneGroup
    ? panes.filter((pane) => pane.groupId === draggingPaneGroup)
    : [];
  const draggingPaneIndex = draggingPaneId
    ? draggingGroupPanes.findIndex((pane) => pane.id === draggingPaneId)
    : -1;
  // The dragged tab moves with its whole subtree, so dim that contiguous range.
  const draggingSubtreeEnd =
    draggingPaneIndex >= 0 ? subtreeEnd(draggingGroupPanes, draggingPaneIndex) : -1;
  // Context-menu pane index, for enabling/disabling Indent/Outdent.
  const contextMenuGroupPanes = contextMenuPane
    ? panes.filter((pane) => pane.groupId === contextMenuPane.groupId)
    : [];
  const contextMenuPaneIndex = paneContextMenu
    ? contextMenuGroupPanes.findIndex((pane) => pane.id === paneContextMenu.paneId)
    : -1;
  const contextMenuPaneSplit = paneSplitForPane(paneSplits, contextMenuPane?.id);
  const contextMenuPaneHasSplit = Boolean(
    contextMenuPaneSplit && contextMenuPaneSplit.paneIds.length >= 2,
  );
  const contextMenuAdjacentBelow = adjacentPaneBelow(panes, contextMenuPane);
  const contextMenuAdjacentBelowSplit = paneSplitForPane(
    paneSplits,
    contextMenuAdjacentBelow?.id,
  );
  const canJoinContextMenuBelow = Boolean(
    contextMenuPane &&
      contextMenuAdjacentBelow &&
      (!contextMenuPaneSplit ||
        !contextMenuAdjacentBelowSplit ||
        contextMenuPaneSplit.id !== contextMenuAdjacentBelowSplit.id),
  );

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const [
          runtimeConfig,
          preferredLauncherAdapterId,
          preferredActiveTabId,
          existingGroups,
          existingPanes,
          existingPaneSplits,
          existingAgents,
          existingTurns,
        ] = await Promise.all([
          getRuntimeConfig(),
          getLauncherAdapterPreference().catch(() => null),
          getActiveTab().catch(() => null),
          listGroups().catch((): GroupInfo[] => []),
          listPanes(),
          getPaneSplits().catch((): PaneSplitInfo[] => []),
          listAgents(),
          listTurns(),
        ]);
        if (cancelled) {
          return;
        }

        setConfig(runtimeConfig);
        setGroups(existingGroups);
        setPaneSplitsState(normalizePaneSplitsForPanes(existingPaneSplits, existingPanes));
        setLauncherAdapterId(
          preferredLauncherAdapterId &&
            runtimeConfig.adapters.some((adapter) => adapter.id === preferredLauncherAdapterId)
            ? preferredLauncherAdapterId
            : null,
        );
        setAgents(existingAgents);
        setTurns(existingTurns);
        // Per-agent fetches are individually guarded so one failed draft/queue read
        // can't reject the whole boot and leave the app stuck on a fatal error with
        // no panes rendered. A failed read just falls back to empty for that agent.
        const [queueEntries, draftEntries] = await Promise.all([
          Promise.all(
            existingAgents.map(
              async (agent) =>
                [
                  agent.id,
                  await listAgentTurnQueue(agent.id).catch((): QueuedTurn[] => []),
                ] as const,
            ),
          ),
          Promise.all(
            existingAgents.map(
              async (agent) =>
                [agent.id, await getAgentDraft(agent.id).catch((): string | null => null)] as const,
            ),
          ),
        ]);
        if (cancelled) {
          return;
        }
        replaceQueuedTurnsByAgent(Object.fromEntries(queueEntries));
        const restoredDrafts = Object.fromEntries(
          draftEntries.filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        draftsByAgentRef.current = restoredDrafts;
        setDraftsByAgentState(restoredDrafts);

        if (existingPanes.length > 0) {
          const restoredActivePane =
            preferredActiveTabId && preferredActiveTabId !== HOME_TAB_ID
              ? existingPanes.find((pane) => pane.id === preferredActiveTabId)
              : undefined;
          const fallbackPane = restoredActivePane ?? existingPanes[0];
          const nextActivePaneId =
            preferredActiveTabId === HOME_TAB_ID ? HOME_TAB_ID : fallbackPane.id;
          setPanesPreservingRecoveredDismissals(existingPanes);
          setActivePaneId(nextActivePaneId);
          setLastActiveGroupId(fallbackPane.groupId);
          activeTabPersistenceReadyRef.current = true;
          return;
        }

        const pane = await spawnShell(estimateInitialPaneSize(false));
        if (!cancelled) {
          const latestGroups = await listGroups().catch((): GroupInfo[] => []);
          const nextActivePaneId = preferredActiveTabId === HOME_TAB_ID ? HOME_TAB_ID : pane.id;
          setGroups(latestGroups);
          setPanesPreservingRecoveredDismissals([pane]);
          setActivePaneId(nextActivePaneId);
          setLastActiveGroupId(pane.groupId);
          activeTabPersistenceReadyRef.current = true;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist any debounced-but-unwritten drafts when the window is hidden or the
  // app unmounts, so a quick close never drops the last second of typing.
  useEffect(() => {
    const handlePageHide = () => flushPendingDrafts();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      flushPendingDrafts();
    };
  }, []);

  useEffect(() => {
    acknowledgePaneIfDone(activePaneId);
  }, [activePaneId]);

  // Selecting a pane clears its one-time "Restored" badge automatically — the same
  // dismiss-on-select behavior as a done agent's review status — so it's never a
  // manual click. Guarded so it only fires for a pane that still carries the badge.
  useEffect(() => {
    if (activePaneId && panes.some((pane) => pane.id === activePaneId && pane.recovered)) {
      dismissRecoveredBadge(activePaneId);
    }
  }, [activePaneId, panes]);

  useLayoutEffect(() => {
    if (!activePaneId) {
      return;
    }
    const paneList = paneListRef.current;
    if (!paneList) {
      return;
    }

    const selectedRow = Array.from(paneList.querySelectorAll<HTMLElement>(".pane-tab-row")).find(
      (row) =>
        activePaneId === HOME_TAB_ID
          ? row.dataset.homeTab === "true"
          : row.dataset.paneId === activePaneId,
    );
    if (selectedRow) {
      scrollChildIntoViewVertically(paneList, selectedRow);
    }
  }, [activePaneId]);

  useEffect(() => {
    const handleFocus = () => acknowledgePaneIfDone(activePaneId);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [activePaneId]);

  // Routes a decoded PTY chunk from the app's single event subscription to the
  // pane that owns it. Stable so TerminalPane's attach effect doesn't re-run.
  const dispatchPtyData = useCallback((paneId: string, data: Uint8Array) => {
    terminalPaneRefs.current.get(paneId)?.write(data);
  }, []);

  // Releases a pane's pre-attach output backlog. While the backend subscription is
  // still being set up, the request is parked and flushed by handleEventsReady, so
  // no cold-start output is delivered before a listener exists to receive it.
  const requestPaneAttach = useCallback((paneId: string) => {
    if (eventsReadyRef.current) {
      void attachPane(paneId).catch(() => undefined);
    } else {
      pendingAttachRef.current.add(paneId);
    }
  }, []);

  const handleEventsReady = useCallback(() => {
    eventsReadyRef.current = true;
    const pending = pendingAttachRef.current;
    pendingAttachRef.current = new Set();
    for (const paneId of pending) {
      void attachPane(paneId).catch(() => undefined);
    }
  }, []);

  function savePaneSplits(nextSplits: PaneSplitInfo[], paneSnapshot = panes) {
    const normalized = normalizePaneSplitsForPanes(nextSplits, paneSnapshot);
    setPaneSplitsState(normalized);
    void persistPaneSplits(normalized)
      .then((persisted) => {
        const paneBasis = paneSnapshotForPersistedPaneSplits(
          persisted,
          panesRef.current,
          paneSnapshot,
        );
        setPaneSplitsState(normalizePaneSplitsForPanes(persisted, paneBasis));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }

  useEffect(() => {
    setPaneSplitsState((current) => {
      const normalized = normalizePaneSplitsForPanes(current, panes);
      if (paneSplitsEqual(current, normalized)) {
        return current;
      }
      void persistPaneSplits(normalized).catch(() => undefined);
      return normalized;
    });
  }, [panes]);

  // Stable per-pane ref callbacks. An inline `ref={(h) => ...}` is a new function
  // each render, which would defeat TerminalPane's React.memo; returning the same
  // callback per pane id keeps the ref prop stable.
  const paneRefCallbacks = useRef(new Map<string, (handle: TerminalPaneHandle | null) => void>());
  const terminalPaneRefCallback = useCallback((paneId: string) => {
    const existing = paneRefCallbacks.current.get(paneId);
    if (existing) {
      return existing;
    }
    const callback = (handle: TerminalPaneHandle | null) => {
      if (handle) {
        terminalPaneRefs.current.set(paneId, handle);
      } else {
        terminalPaneRefs.current.delete(paneId);
        paneRefCallbacks.current.delete(paneId);
      }
    };
    paneRefCallbacks.current.set(paneId, callback);
    return callback;
  }, []);

  useQmuxEvents({
    setHookEventsByAgent,
    setPanes: setPanesPreservingRecoveredDismissals,
    setActivePaneId,
    setPaneContextMenu,
    setExitPreflightRequest,
    setAgents,
    setGroups,
    setThinkingAgentIds,
    setTurns,
    setTranscriptNoticeByAgent,
    setAgentQueuedTurns,
    refreshAgentTurnQueue,
    refreshTranscriptOptions,
    dispatchPtyData,
    openBrowserOverlay,
    onEventsReady: handleEventsReady,
    onAgentSpawned: registerShellCodexFirstMessageTitle,
    onAgentPromptSubmitted: handleAgentPromptSubmitted,
  });

  async function addShellPane() {
    await addShellPaneInGroup(launchGroupId());
  }

  async function restoreClosedPane() {
    setError(null);
    try {
      const pane = await restoreLastClosedPane();
      if (!pane) {
        return;
      }

      const [latestPanes, latestAgents, latestTurns, latestGroups] = await Promise.all([
        listPanes(),
        listAgents(),
        listTurns(),
        listGroups(),
      ]);
      setPanesPreservingRecoveredDismissals(latestPanes);
      setAgents(latestAgents);
      setTurns(latestTurns);
      setGroups(latestGroups);
      setActivePaneId(pane.id);

      const restoredAgent = latestAgents.find(
        (agent) => agent.paneId === pane.id || agent.id === pane.agentId,
      );
      if (restoredAgent) {
        void refreshAgentTurnQueue(restoredAgent.id).catch(() => undefined);
        void getAgentDraft(restoredAgent.id)
          .then((draft) => {
            const nextDrafts = { ...draftsByAgentRef.current };
            if (draft) {
              nextDrafts[restoredAgent.id] = draft;
            } else {
              delete nextDrafts[restoredAgent.id];
            }
            draftsByAgentRef.current = nextDrafts;
            setDraftsByAgentState(nextDrafts);
          })
          .catch(() => undefined);
      }

      requestAnimationFrame(() => {
        terminalPaneRefs.current.get(pane.id)?.focus();
      });
      showAppToast("Tab restored");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function focusPaneTab(paneId: string) {
    setActivePaneId(paneId);
    setLauncherOpen(false);
    requestAnimationFrame(() => {
      terminalPaneRefs.current.get(paneId)?.focus();
    });
  }

  const activateTerminalPane = useCallback((paneId: string) => {
    setActivePaneId(paneId);
    setLauncherOpen(false);
  }, []);

  function focusHomeTab() {
    setActivePaneId(HOME_TAB_ID);
    setLauncherOpen(false);
    focusLauncherInput();
  }

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listenToMenuBarSelectPane(({ paneId }) => {
      if (disposed || !panesRef.current.some((pane) => pane.id === paneId)) {
        return;
      }
      focusPaneTab(paneId);
      acknowledgePaneIfDone(paneId);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
    // The listener reads live pane/agent state through refs and uses stable state
    // setters, so it should be registered once for the app lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openAgentLauncher() {
    if (homeActive) {
      focusHomeTab();
      return;
    }
    setLauncherOpen(true);
  }

  function handleGroupHeaderPointerDown(event: ReactPointerEvent<HTMLDivElement>, groupId: string) {
    if (event.button !== 0) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".pane-group-collapse-button, .pane-group-menu-button")
    ) {
      return;
    }
    groupPointerDragRef.current = {
      pointerId: event.pointerId,
      groupId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleGroupHeaderPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = groupPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < PANE_TAB_DRAG_START_THRESHOLD) {
        return;
      }
      drag.active = true;
      setDraggingGroupId(drag.groupId);
      updateGroupDropTarget(null);
      updatePaneDropTarget(null);
    }

    event.preventDefault();
    updateGroupDropTarget(computeGroupDragDropTarget(event.clientX, event.clientY, drag.groupId));
  }

  function handleGroupHeaderPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = groupPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the platform.
    }

    groupPointerDragRef.current = null;
    if (!drag.active) {
      return;
    }

    event.preventDefault();
    const target =
      groupDropTargetRef.current ??
      computeGroupDragDropTarget(event.clientX, event.clientY, drag.groupId);
    clearGroupDrag();
    if (target === null) {
      return;
    }
    applyGroupDropTarget(drag.groupId, target);
  }

  function handleGroupHeaderPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = groupPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    groupPointerDragRef.current = null;
    clearGroupDrag();
  }

  function handlePaneTabPointerDown(event: ReactPointerEvent<HTMLDivElement>, paneId: string) {
    if (event.button !== 0) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".pane-tab-close, .pane-tab-status-clickable, .pane-tab-dot-button")
    ) {
      return;
    }
    paneTabPointerDragRef.current = {
      pointerId: event.pointerId,
      paneId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePaneTabPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = paneTabPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < PANE_TAB_DRAG_START_THRESHOLD) {
        return;
      }
      drag.active = true;
      setDraggingPaneId(drag.paneId);
      updatePaneDropTarget(null);
    }

    event.preventDefault();
    updatePaneDropTarget(computePaneDragDropTarget(event.clientX, event.clientY, drag.paneId));
  }

  function handlePaneTabPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = paneTabPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the platform.
    }

    paneTabPointerDragRef.current = null;
    if (!drag.active) {
      return;
    }

    event.preventDefault();
    suppressPaneTabClickRef.current = true;
    window.setTimeout(() => {
      suppressPaneTabClickRef.current = false;
    }, PANE_TAB_DRAG_CLICK_SUPPRESS_MS);

    const target =
      paneDropTargetRef.current ??
      computePaneDragDropTarget(event.clientX, event.clientY, drag.paneId);
    clearPaneTabDrag();
    if (target === null) {
      return;
    }
    applyDropTarget(drag.paneId, target);
  }

  function handlePaneTabPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = paneTabPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    paneTabPointerDragRef.current = null;
    clearPaneTabDrag();
  }

  function handlePaneTabClick(paneId: string) {
    if (suppressPaneTabClickRef.current) {
      return;
    }
    setActivePaneId(paneId);
    acknowledgePaneIfDone(paneId);
  }

  function handlePaneTabDoubleClick(pane: PaneInfo) {
    if (suppressPaneTabClickRef.current) {
      return;
    }
    openRenameDialog(pane);
  }

  function updatePaneDropTarget(target: PaneDropTarget | null) {
    paneDropTargetRef.current = target;
    setPaneDropTarget(target);
  }

  function updateGroupDropTarget(target: GroupDropTarget | null) {
    groupDropTargetRef.current = target;
    setGroupDropTarget(target);
  }

  function clearPaneTabDrag() {
    paneDropTargetRef.current = null;
    setDraggingPaneId(null);
    setPaneDropTarget(null);
  }

  function clearGroupDrag() {
    groupDropTargetRef.current = null;
    setDraggingGroupId(null);
    setGroupDropTarget(null);
  }

  // Classifies a pointer position during a drag into a drop target: the top/bottom
  // ~30% of a row is a reorder gap, the middle ~40% nests into that row. Rows inside
  // the dragged tab's own subtree are never targets (can't nest into self), and gaps
  // adjacent to that block are suppressed (would be a no-op move).
  function computePaneDragDropTarget(
    clientX: number,
    clientY: number,
    dragId: string,
  ): PaneDropTarget | null {
    const stage = terminalStageRef.current;
    if (stage && pointInRect(stage.getBoundingClientRect(), clientX, clientY)) {
      return computeTerminalSplitDropTarget(clientY, dragId);
    }

    const list = paneListRef.current;
    if (list && pointInRect(list.getBoundingClientRect(), clientX, clientY)) {
      return computeSidebarDropTarget(list, clientY, dragId);
    }

    return null;
  }

  function pointInRect(rect: DOMRect, clientX: number, clientY: number) {
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function computeGroupDragDropTarget(
    clientX: number,
    clientY: number,
    dragGroupId: string,
  ): GroupDropTarget | null {
    const list = paneListRef.current;
    if (!list || !pointInRect(list.getBoundingClientRect(), clientX, clientY)) {
      return null;
    }

    const rows = Array.from(list.querySelectorAll(".pane-group")).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains("pane-group"),
    );
    const dragIndex = groups.findIndex((group) => group.id === dragGroupId);
    if (rows.length === 0 || dragIndex < 0) {
      return null;
    }

    const gapTarget = (index: number): GroupDropTarget | null =>
      index === dragIndex || index === dragIndex + 1 ? null : { index };

    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top) {
        return gapTarget(index);
      }
      if (clientY <= rect.bottom) {
        return gapTarget(clientY < rect.top + rect.height / 2 ? index : index + 1);
      }
    }
    return gapTarget(rows.length);
  }

  function computeSidebarDropTarget(
    container: HTMLElement,
    clientY: number,
    dragId: string,
  ): PaneDropTarget | null {
    const dragPane = panes.find((pane) => pane.id === dragId);
    if (!dragPane) {
      return null;
    }
    const groupPanes = panes.filter((pane) => pane.groupId === dragPane.groupId);
    const rows = Array.from(container.querySelectorAll(".pane-tab-row")).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains("pane-tab-row") &&
        child.dataset.groupId === dragPane.groupId &&
        // The fixed Home row isn't a reorder/nest target and isn't in `panes`, so
        // excluding it keeps the row index aligned with the group pane array below.
        !child.classList.contains("pane-home-row"),
    );
    if (rows.length === 0) {
      return null;
    }
    const dragIndex = groupPanes.findIndex((pane) => pane.id === dragId);
    const dragEnd = dragIndex >= 0 ? subtreeEnd(groupPanes, dragIndex) : -1;
    const inDraggedSubtree = (index: number) =>
      dragIndex >= 0 && index >= dragIndex && index < dragEnd;

    const gapTarget = (index: number): PaneDropTarget | null =>
      dragIndex >= 0 && index >= dragIndex && index <= dragEnd
        ? null // dropping into/adjacent to its own block is a no-op
        : { kind: "gap", groupId: dragPane.groupId, index };

    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.bottom) {
        continue;
      }
      const fraction = (clientY - rect.top) / rect.height;
      if (fraction < 0.3) {
        return gapTarget(index);
      }
      if (fraction > 0.7) {
        return gapTarget(index + 1);
      }
      const pane = groupPanes[index];
      if (!pane || inDraggedSubtree(index)) {
        return null;
      }
      return { kind: "nest", groupId: dragPane.groupId, paneId: pane.id };
    }
    return gapTarget(rows.length);
  }

  function computeTerminalSplitDropTarget(
    clientY: number,
    dragId: string,
  ): PaneDropTarget | null {
    const stageRect = terminalStageRef.current?.getBoundingClientRect();
    const dragPane = panes.find((pane) => pane.id === dragId);
    if (!stageRect || !dragPane || visibleTerminalPanes.length === 0) {
      return null;
    }

    const groupPanes = panes.filter((pane) => pane.groupId === dragPane.groupId);
    const dragIndex = groupPanes.findIndex((pane) => pane.id === dragId);
    const dragEnd = dragIndex >= 0 ? subtreeEnd(groupPanes, dragIndex) : -1;
    const targetInDraggedSubtree = (paneId: string) => {
      const targetIndex = groupPanes.findIndex((pane) => pane.id === paneId);
      return targetIndex >= dragIndex && targetIndex < dragEnd;
    };

    let topFraction = 0;
    for (const [index, pane] of visibleTerminalPanes.entries()) {
      const heightFraction = activePaneSplit ? (activeSplitFractions[index] ?? 0) : 1;
      const top = stageRect.top + topFraction * stageRect.height;
      const height = heightFraction * stageRect.height;
      const bottom = top + height;
      if (clientY < top || clientY > bottom) {
        topFraction += heightFraction;
        continue;
      }
      if (
        pane.id === dragId ||
        pane.groupId !== dragPane.groupId ||
        targetInDraggedSubtree(pane.id) ||
        !isLeafPane(groupPanes, pane.id)
      ) {
        return null;
      }
      return {
        kind: "terminal-split",
        groupId: pane.groupId,
        targetPaneId: pane.id,
        position: clientY < top + height / 2 ? "above" : "below",
      };
    }

    return null;
  }

  function applyDropTarget(dragId: string, target: PaneDropTarget) {
    if (target.kind === "terminal-split") {
      void splitDraggedPaneIntoTerminal(dragId, target);
      return;
    }
    const groupPanes = panes.filter((pane) => pane.groupId === target.groupId);
    const next =
      target.kind === "nest"
        ? nestUnder(groupPanes, dragId, target.paneId)
        : moveToGap(groupPanes, dragId, target.index);
    applyPaneLayout(target.groupId, next);
  }

  function applyGroupDropTarget(dragGroupId: string, target: GroupDropTarget) {
    const dragIndex = groups.findIndex((group) => group.id === dragGroupId);
    if (dragIndex < 0 || target.index === dragIndex || target.index === dragIndex + 1) {
      return;
    }

    const withoutDragged = groups.filter((group) => group.id !== dragGroupId);
    const insertIndex = clamp(
      target.index > dragIndex ? target.index - 1 : target.index,
      0,
      withoutDragged.length,
    );
    const dragGroup = groups[dragIndex];
    const next = [
      ...withoutDragged.slice(0, insertIndex),
      dragGroup,
      ...withoutDragged.slice(insertIndex),
    ];
    applyGroupOrder(next);
  }

  async function splitDraggedPaneIntoTerminal(
    dragId: string,
    target: Extract<PaneDropTarget, { kind: "terminal-split" }>,
  ) {
    setError(null);
    const dragPane = panes.find((pane) => pane.id === dragId);
    const targetPane = panes.find((pane) => pane.id === target.targetPaneId);
    if (
      !dragPane ||
      !targetPane ||
      dragPane.groupId !== target.groupId ||
      targetPane.groupId !== target.groupId
    ) {
      return;
    }

    const groupPanes = panes.filter((pane) => pane.groupId === target.groupId);
    if (!isLeafPane(groupPanes, target.targetPaneId)) {
      return;
    }

    const nextGroupPanes = movePanePromotingChildrenAdjacentToPane(
      groupPanes,
      dragId,
      target.targetPaneId,
      target.position,
    );
    const nextPanes = panesWithGroupOrder(target.groupId, nextGroupPanes);
    const nextLayout = toLayout(nextPanes);
    const layoutChanged = !sameLayout(nextLayout, toLayout(sidebarPanes));
    const topPaneId = target.position === "above" ? dragId : target.targetPaneId;
    const belowPaneId = target.position === "above" ? target.targetPaneId : dragId;
    const detachedSplits = detachPaneFromSplitMemberships(paneSplits, dragId);
    const optimisticSplits = joinPaneSplit(detachedSplits, nextPanes, topPaneId, belowPaneId, {
      insertedPaneId: dragId,
      source: "drag-half",
    });
    const requestSeq = paneReorderRequestSeqRef.current + 1;
    paneReorderRequestSeqRef.current = requestSeq;
    // Keep panes and splits consistent during the optimistic reorder so the
    // pane-change normalization effect doesn't persist the pre-drop split shape.
    setPanesPreservingRecoveredDismissals(nextPanes);
    setPaneSplitsState(optimisticSplits);

    const persist = paneReorderPersistChainRef.current
      .catch(() => undefined)
      .then(() => (layoutChanged ? setPaneLayout(nextLayout) : nextPanes));

    paneReorderPersistChainRef.current = persist
      .then((orderedPanes) => {
        if (paneReorderRequestSeqRef.current !== requestSeq) {
          return;
        }

        setPanesPreservingRecoveredDismissals(orderedPanes);
        savePaneSplits(
          joinPaneSplit(detachedSplits, orderedPanes, topPaneId, belowPaneId, {
            insertedPaneId: dragId,
            source: "drag-half",
          }),
          orderedPanes,
        );
        setActivePaneId(dragId);
        setLastActiveGroupId(target.groupId);
        requestAnimationFrame(() => {
          terminalPaneRefs.current.get(dragId)?.focus();
        });
      })
      .catch((err) => {
        if (paneReorderRequestSeqRef.current !== requestSeq) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        void Promise.all([
          listPanes(),
          getPaneSplits().catch(() => paneSplits),
        ])
          .then(([latestPanes, latestSplits]) => {
            if (paneReorderRequestSeqRef.current === requestSeq) {
              setPanesPreservingRecoveredDismissals(latestPanes);
              setPaneSplitsState(normalizePaneSplitsForPanes(latestSplits, latestPanes));
            }
          })
          .catch(() => undefined);
      });
  }

  function panesWithGroupOrder(groupId: string, nextGroupPanes: PaneInfo[]) {
    const next = groups.flatMap((group) =>
      group.id === groupId ? nextGroupPanes : panes.filter((pane) => pane.groupId === group.id),
    );
    const groupedIds = new Set(next.map((pane) => pane.id));
    next.push(...panes.filter((pane) => !groupedIds.has(pane.id)));
    return next;
  }

  // Optimistically applies a new tab layout (order + depth) and persists it, with the
  // same request-sequence guard the old reorder used so stale responses never clobber
  // a newer local state.
  function applyPaneLayout(groupId: string, nextGroupPanes: PaneInfo[]) {
    const next = panesWithGroupOrder(groupId, nextGroupPanes);
    const nextLayout = toLayout(next);
    if (sameLayout(nextLayout, toLayout(sidebarPanes))) {
      return; // structural no-op — don't churn a backend round-trip
    }
    const requestSeq = paneReorderRequestSeqRef.current + 1;
    paneReorderRequestSeqRef.current = requestSeq;
    setPanesPreservingRecoveredDismissals(next);

    const persist = paneReorderPersistChainRef.current
      .catch(() => undefined)
      .then(() => setPaneLayout(nextLayout));
    paneReorderPersistChainRef.current = persist
      .then((orderedPanes) => {
        if (paneReorderRequestSeqRef.current === requestSeq) {
          setPanesPreservingRecoveredDismissals(orderedPanes);
        }
      })
      .catch(() => {
        // A layout change is non-critical, and a pane added/closed mid-edit makes the
        // request "stale" — both are benign, so resync from the backend instead of
        // surfacing an error. Only the latest request's resync is allowed to land.
        if (paneReorderRequestSeqRef.current !== requestSeq) {
          return;
        }
        void listPanes()
          .then((latest) => {
            if (paneReorderRequestSeqRef.current === requestSeq) {
              setPanesPreservingRecoveredDismissals(latest);
            }
          })
          .catch(() => undefined);
      });
  }

  function applyGroupOrder(nextGroups: GroupInfo[]) {
    const nextIds = nextGroups.map((group) => group.id);
    if (sameStringList(nextIds, groups.map((group) => group.id))) {
      return;
    }

    const requestSeq = groupReorderRequestSeqRef.current + 1;
    groupReorderRequestSeqRef.current = requestSeq;
    setGroups(nextGroups);

    const persist = groupReorderPersistChainRef.current
      .catch(() => undefined)
      .then(() => reorderGroups(nextIds));
    groupReorderPersistChainRef.current = persist
      .then((orderedGroups) => {
        if (groupReorderRequestSeqRef.current === requestSeq) {
          setGroups(orderedGroups);
        }
      })
      .catch(() => {
        if (groupReorderRequestSeqRef.current !== requestSeq) {
          return;
        }
        void listGroups()
          .then((latest) => {
            if (groupReorderRequestSeqRef.current === requestSeq) {
              setGroups(latest);
            }
          })
          .catch(() => undefined);
      });
  }

  function sameLayout(a: PaneLayoutItem[], b: PaneLayoutItem[]) {
    return (
      a.length === b.length &&
      a.every(
        (item, index) => item.paneId === b[index].paneId && item.depth === b[index].depth,
      )
    );
  }

  function sameStringList(a: string[], b: string[]) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }

  function indentContextMenuPane() {
    if (contextMenuPaneIndex < 0) {
      return;
    }
    const groupId = contextMenuPane?.groupId;
    if (!groupId) {
      return;
    }
    applyPaneLayout(groupId, indentAt(contextMenuGroupPanes, contextMenuPaneIndex));
  }

  function outdentContextMenuPane() {
    if (contextMenuPaneIndex < 0) {
      return;
    }
    const groupId = contextMenuPane?.groupId;
    if (!groupId) {
      return;
    }
    applyPaneLayout(groupId, outdentAt(contextMenuGroupPanes, contextMenuPaneIndex));
  }

  function openPaneContextMenu(event: ReactMouseEvent, pane: PaneInfo) {
    event.preventDefault();
    event.stopPropagation();
    setGroupMenu(null);
    setSettingsMenu(null);
    const maxX = Math.max(8, window.innerWidth - PANE_CONTEXT_MENU_WIDTH - 8);
    const maxY = Math.max(8, window.innerHeight - PANE_CONTEXT_MENU_ESTIMATED_HEIGHT - 8);
    setPaneContextMenu({
      paneId: pane.id,
      x: clamp(event.clientX, 8, maxX),
      y: clamp(event.clientY, 8, maxY),
    });
  }

  // The "Restored" badge is a one-time, post-restart hint, cleared automatically
  // when its pane is selected (see the activePaneId effect). Clearing the flag
  // locally and recording the pane id keeps later backend pane refetches from
  // resurrecting the badge during this app session.
  function dismissRecoveredBadge(paneId: string) {
    dismissedRecoveredPaneIdsRef.current.add(paneId);
    setPanesPreservingRecoveredDismissals((current) =>
      current.map((pane) => (pane.id === paneId ? { ...pane, recovered: false } : pane)),
    );
  }

  function openRenameDialog(pane: PaneInfo) {
    const paneAgent = agents.find((agent) => agent.paneId === pane.id);
    setRenameValue(displayPaneTitle(pane, paneAgent));
    setRenameGroupId(null);
    setRenamePaneId(pane.id);
  }

  function openGroupRenameDialog(group: GroupInfo) {
    setRenameValue(displayGroupName(group));
    setRenamePaneId(null);
    setRenameGroupId(group.id);
  }

  function closeRenameDialog() {
    setRenamePaneId(null);
    setRenameGroupId(null);
  }

  async function submitRename() {
    const groupId = renameGroupId;
    if (groupId) {
      const title = renameValue.trim();
      const previous = groups.find((group) => group.id === groupId);
      const clearingUserTitle = title.length === 0;
      const nextNameOverride = clearingUserTitle ? null : title;
      closeRenameDialog();
      if (!previous) {
        return;
      }
      const previousNameOverride = previous.nameOverride?.trim() || null;
      if (
        previousNameOverride === nextNameOverride ||
        (previousNameOverride === null && nextNameOverride === defaultGroupName(previous))
      ) {
        return;
      }

      setGroups((current) =>
        current.map((group) =>
          group.id === groupId ? { ...group, nameOverride: nextNameOverride } : group,
        ),
      );
      try {
        const updated = await renameGroup(groupId, nextNameOverride);
        setGroups((current) =>
          current.map((group) => (group.id === groupId ? updated : group)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setGroups((current) =>
          current.map((group) => (group.id === groupId ? previous : group)),
        );
      }
      return;
    }

    const paneId = renamePaneId;
    if (!paneId) {
      return;
    }
    const title = renameValue.trim();
    const previous = panes.find((pane) => pane.id === paneId);
    const paneAgent = previous ? agents.find((agent) => agent.paneId === previous.id) : undefined;
    const clearingUserTitle = title.length === 0;
    const nextTitle = clearingUserTitle
      ? (previous ? (defaultPaneTitle(previous, paneAgent, config) ?? previous.title) : "")
      : title;
    const previousWasManuallyTitled = manuallyTitledPaneIds.has(paneId);
    closeRenameDialog();
    if (!previous) {
      return;
    }
    if (previous.title === nextTitle) {
      if (clearingUserTitle && previousWasManuallyTitled) {
        setManuallyTitledPaneIds((current) => {
          const next = new Set(current);
          next.delete(paneId);
          return next;
        });
      }
      return;
    }

    setManuallyTitledPaneIds((current) => {
      const next = new Set(current);
      if (clearingUserTitle) {
        next.delete(paneId);
      } else {
        next.add(paneId);
      }
      return next;
    });
    // Optimistically rename, then persist; revert if the backend rejects it.
    setPanesPreservingRecoveredDismissals((current) =>
      current.map((pane) => (pane.id === paneId ? { ...pane, title: nextTitle } : pane)),
    );
    try {
      const updated = await renamePane(paneId, nextTitle);
      setPanesPreservingRecoveredDismissals((current) =>
        current.map((pane) => (pane.id === paneId ? { ...pane, title: updated.title } : pane)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setManuallyTitledPaneIds((current) => {
        const next = new Set(current);
        if (previousWasManuallyTitled) {
          next.add(paneId);
        } else {
          next.delete(paneId);
        }
        return next;
      });
      setPanesPreservingRecoveredDismissals((current) =>
        current.map((pane) =>
          pane.id === paneId ? { ...pane, title: previous?.title ?? pane.title } : pane,
        ),
      );
    }
  }

  function forgetClosedPane(paneToClose: PaneInfo) {
    setPanesPreservingRecoveredDismissals((current) => {
      const nextPanes = current.filter((pane) => pane.id !== paneToClose.id);
      setActivePaneId((currentActivePaneId) => {
        if (currentActivePaneId !== paneToClose.id) {
          return currentActivePaneId;
        }
        return selectPaneAfterClose(current, paneToClose.id, paneSplits, {
          isPaneInCollapsedGroup: (pane) =>
            groupById.get(pane.groupId)?.collapsed === true,
        });
      });
      return nextPanes;
    });
    setPaneContextMenu((current) => (current?.paneId === paneToClose.id ? null : current));
  }

  async function closePane(paneToClose: PaneInfo): Promise<boolean> {
    setError(null);
    try {
      await killPane(paneToClose.id);
      forgetClosedPane(paneToClose);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function removeClosedGroup(groupClose: CloseGroupContinuation) {
    setError(null);
    try {
      await removeGroup(groupClose.groupId);
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function continueGroupClose(groupClose: CloseGroupContinuation) {
    const paneById = new Map(panesRef.current.map((pane) => [pane.id, pane]));
    const nextIndex = groupClose.remainingPaneIds.findIndex((paneId) => paneById.has(paneId));
    if (nextIndex < 0) {
      await removeClosedGroup(groupClose);
      return;
    }

    const paneToClose = paneById.get(groupClose.remainingPaneIds[nextIndex]);
    if (!paneToClose) {
      await removeClosedGroup(groupClose);
      return;
    }

    const nextGroupClose: CloseGroupContinuation = {
      ...groupClose,
      remainingPaneIds: groupClose.remainingPaneIds.slice(nextIndex + 1),
    };
    const dialog = await closeDialogForPane(paneToClose, { checkWorktreeStatus: true });
    if (dialog) {
      setCloseDialog({ ...dialog, groupClose: nextGroupClose });
      return;
    }

    const closed = await closePane(paneToClose);
    if (closed) {
      await continueGroupClose(nextGroupClose);
    }
  }

  async function requestCloseGroup(group: GroupInfo) {
    setGroupMenu(null);
    const groupPanes = panesRef.current.filter((pane) => pane.groupId === group.id);
    await continueGroupClose({
      groupId: group.id,
      groupName: displayGroupName(group),
      remainingPaneIds: groupPanes.map((pane) => pane.id),
      totalCount: groupPanes.length,
    });
  }

  async function applyGroupCollapsed(group: GroupInfo, collapsed: boolean) {
    setGroupMenu(null);
    if (group.collapsed === collapsed) {
      return;
    }
    setError(null);
    setGroups((current) =>
      current.map((candidate) =>
        candidate.id === group.id ? { ...candidate, collapsed } : candidate,
      ),
    );
    try {
      const updated = await setGroupCollapsed(group.id, collapsed);
      setGroups((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
    } catch (err) {
      setGroups((current) =>
        current.map((candidate) =>
          candidate.id === group.id ? { ...candidate, collapsed: group.collapsed } : candidate,
        ),
      );
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleGroupCollapsed(group: GroupInfo) {
    await applyGroupCollapsed(group, !group.collapsed);
  }

  async function expandGroup(group: GroupInfo) {
    await applyGroupCollapsed(group, false);
  }

  async function closeDialogForPane(
    paneToClose: PaneInfo,
    options?: { confirmAlways?: boolean; checkWorktreeStatus?: boolean },
  ): Promise<CloseDialogState | null> {
    const agent = agentsRef.current.find((candidate) => candidate.paneId === paneToClose.id);
    if (agent && agent.branch) {
      let hasChanges = false;
      if (options?.checkWorktreeStatus !== false) {
        try {
          hasChanges = (await worktreeStatus(agent.id)).hasChanges;
        } catch {
          // If the status check fails, still offer the choice rather than blocking
          // the close; treat the change state as unknown (assume none).
          hasChanges = false;
        }
      }
      return {
        kind: "worktree",
        pane: paneToClose,
        agentId: agent.id,
        worktreeDir: agent.worktreeDir,
        hasChanges,
        busy:
          agent.status === "starting" ||
          agent.status === "running" ||
          agent.status === "awaitingInput" ||
          agent.status === "awaitingPermission",
      };
    }

    const liveReason =
      agent?.status === "awaitingPermission"
        ? "is waiting to approve a tool use"
        : agent?.status === "awaitingInput"
          ? "is waiting for your input"
          : agent?.status === "running" || agent?.status === "starting"
            ? "is still working"
            : null;

    // Recovered (orphaned) queued turns parked in this pane would be discarded on
    // close — surface that through the same stop dialog rather than a second prompt.
    const recoveredTurnCount = agents
      .filter((candidate) => candidate.orphanedQueuePaneId === paneToClose.id)
      .reduce(
        (total, candidate) =>
          total + (queuedTurnsByAgentRef.current[candidate.id]?.length ?? 0),
        0,
      );

    const reason =
      liveReason ??
      (recoveredTurnCount > 0
        ? `has ${recoveredTurnCount} recovered queued ${
            recoveredTurnCount === 1 ? "turn" : "turns"
          }`
        : null);
    if (reason) {
      return { kind: "stop", pane: paneToClose, reason };
    }
    try {
      const activity = await paneActivity(paneToClose.id);
      if (activity.kind === "runningProcess" && activity.processCount > 0) {
        return {
          kind: "runningProcess",
          pane: paneToClose,
          processCount: activity.processCount,
          processSummary: activity.processSummary,
        };
      }
    } catch {
      // Process inspection is best-effort. If the probe fails, let the normal close
      // path continue instead of turning an inspection error into a blocking prompt.
    }
    if (options?.confirmAlways) {
      return { kind: "pane", pane: paneToClose };
    }
    return null;
  }

  // Closing a tab that owns a git worktree opens a dialog: check the worktree for
  // uncommitted changes first, then let the user delete or keep it (or cancel).
  // Other agent panes confirm only when a live agent would be interrupted; shell
  // panes and finished/failed agents close without a prompt.
  async function requestClosePane(paneToClose: PaneInfo, options?: { confirmAlways?: boolean }) {
    const dialog = await closeDialogForPane(paneToClose, {
      confirmAlways: options?.confirmAlways,
      checkWorktreeStatus: true,
    });
    if (dialog) {
      setCloseDialog(dialog);
      return;
    }
    await closePane(paneToClose);
  }

  useEffect(() => {
    if (!exitPreflightRequest) {
      return;
    }
    let cancelled = false;

    const preflightExit = async () => {
      const paneSnapshot = panesRef.current;
      const promptDialogs = (
        await Promise.all(
          paneSnapshot.map((pane) =>
            closeDialogForPane(pane, { checkWorktreeStatus: false }),
          ),
        )
      ).filter((dialog): dialog is CloseDialogState => dialog !== null);

      if (cancelled) {
        return;
      }

      setExitPreflightRequest(null);
      const paneCount = Math.max(
        exitPreflightRequest.paneCount,
        paneSnapshot.length,
        promptDialogs.length,
      );
      if (paneCount === 0) {
        setExitDialog(null);
        return;
      }

      setExitDialog({
        paneCount,
      });
    };

    void preflightExit();
    return () => {
      cancelled = true;
    };
  }, [exitPreflightRequest]);

  useEffect(() => {
    if (!closeDialog) {
      return;
    }

    const focusCloseButton = (force = false) =>
      focusConfirmDialogButton(closeConfirmButtonRef.current, force);

    focusCloseButton(true);
    const frame = requestAnimationFrame(() => focusCloseButton());
    const settle = window.setTimeout(() => focusCloseButton(), 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [closeDialog]);

  useEffect(() => {
    if (!exitDialog) {
      return;
    }

    const focusQuitButton = (force = false) =>
      focusConfirmDialogButton(exitConfirmButtonRef.current, force);

    focusQuitButton(true);
    const frame = requestAnimationFrame(() => focusQuitButton());
    const settle = window.setTimeout(() => focusQuitButton(), 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [exitDialog]);

  function handlePaneTabClosePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    pane: PaneInfo,
  ) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void requestClosePane(pane, { confirmAlways: true });
  }

  function handlePaneTabCloseClick(event: ReactMouseEvent<HTMLElement>, pane: PaneInfo) {
    event.stopPropagation();
    if (event.detail === 0) {
      void requestClosePane(pane, { confirmAlways: true });
    }
  }

  // Resolves the worktree close dialog: always closes the pane, and additionally
  // deletes the worktree when the user chose to.
  async function resolveCloseDialog(choice: "keep" | "delete") {
    const dialog = closeDialog;
    if (!dialog || dialog.kind !== "worktree" || resolvingClose) {
      return;
    }
    const groupClose = dialog.groupClose;
    setError(null);
    setResolvingClose(choice);
    try {
      await closeWorktreePane(dialog.agentId, choice === "delete");
      forgetClosedPane(dialog.pane);
      setCloseDialog(null);
      if (groupClose) {
        await continueGroupClose(groupClose);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCloseDialog(null);
    } finally {
      setResolvingClose(null);
    }
  }

  // Confirms stopping a live agent that has no worktree to clean up.
  async function confirmStopAndClose() {
    const dialog = closeDialog;
    if (!dialog || dialog.kind !== "stop") {
      return;
    }
    const groupClose = dialog.groupClose;
    setCloseDialog(null);
    const closed = await closePane(dialog.pane);
    if (closed && groupClose) {
      await continueGroupClose(groupClose);
    }
  }

  async function confirmPaneClose() {
    const dialog = closeDialog;
    if (!dialog || (dialog.kind !== "pane" && dialog.kind !== "runningProcess")) {
      return;
    }
    const groupClose = dialog.groupClose;
    setCloseDialog(null);
    const closed = await closePane(dialog.pane);
    if (closed && groupClose) {
      await continueGroupClose(groupClose);
    }
  }

  async function confirmExit() {
    setExitDialog(null);
    setError(null);
    flushPendingDrafts();
    try {
      await confirmAppExit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addAgentPane() {
    // End any in-flight dictation so it can't keep writing into the prompt after
    // the agent launches and the field clears.
    launcherDictation.stop();
    const trimmed = prompt.trim();
    // A selected skill is sent as a leading slash command so the launched agent
    // invokes it before the user's prompt (e.g. `/qmux:deep-research <prompt>`).
    const finalPrompt = selectedSkill ? `${selectedSkill.command} ${trimmed}`.trim() : trimmed;
    setError(null);
    rememberLauncherAdapter(launchAdapter.id);
    try {
      const targetGroupId = launchGroupId();
      const pane = await spawnAgent({
        adapterId: launchAdapter.id,
        prompt: finalPrompt,
        groupId: targetGroupId,
        baseRepo: null,
        baseRef: "HEAD",
        initialSize: estimateInitialPaneSize(true),
        useWorktree: createInWorktree,
        options: launcherOptions,
      });
      const orderedPanes = await panesWithNewTabInLaunchPosition(pane, targetGroupId);
      setPanesPreservingRecoveredDismissals(orderedPanes);
      setActivePaneId(pane.id);
      setLastActiveGroupId(pane.groupId);
      expandNewAgentTranscriptByDefault(pane);
      if (pane.agentId) {
        setAgentQueuedTurns(pane.agentId, []);
        pendingFirstTitleByAgentRef.current.set(
          pane.agentId,
          createPendingFirstMessageTitle(pane.id, selectedSkill?.command ?? null),
        );
        applyPendingFirstMessageTitle(pane.agentId, trimmed);
      }
      setPrompt("");
      setSelectedSkillId(null);
      setLauncherOpen(false);
      const [latestAgents] = await Promise.all([listAgents(), refreshGroups()]);
      setAgents(latestAgents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Forks the active session into a new tab (resuming it) — as a sibling right
  // after the current tab, or nested under it when `nest` is set — and focuses the
  // fork. The backend also emits agent.forked, which refetches the ordered pane
  // list, so the optimistic append below is just to avoid a flicker.
  async function forkActivePane(options: { nest: boolean; useWorktree: boolean }) {
    if (!activePane || !activeAgent) {
      return;
    }
    setError(null);
    try {
      const pane = await forkAgent(activePane.id, options);
      setPanesPreservingRecoveredDismissals((current) =>
        current.some((existing) => existing.id === pane.id) ? current : [...current, pane],
      );
      setActivePaneId(pane.id);
      expandNewAgentTranscriptByDefault(pane);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Show the floating Ask popup for a selection. Both surfaces (terminal and
  // transcript) route here; the selection is always within the active agent's pane,
  // and we require an active agent (shell panes have nothing to ask).
  function clearSelectionAskHideTimer() {
    if (selectionAskHideTimerRef.current === null) {
      return;
    }
    window.clearTimeout(selectionAskHideTimerRef.current);
    selectionAskHideTimerRef.current = null;
  }
  function dismissSelectionAskSoon() {
    clearSelectionAskHideTimer();
    selectionAskHideTimerRef.current = window.setTimeout(() => {
      selectionAskHideTimerRef.current = null;
      setSelectionAsk(null);
    }, SELECTION_ASK_HIDE_DEBOUNCE_MS);
  }
  function dismissSelectionAskNow() {
    clearSelectionAskHideTimer();
    setSelectionAsk(null);
  }
  function showSelectionAskForPane(
    pane: PaneInfo | undefined,
    agent: AgentInfo | undefined,
    quote: string,
    anchor: SelectionAnchor,
  ) {
    if (!agent || !pane) {
      return;
    }
    const trimmed = quote.trim();
    if (!trimmed) {
      return;
    }
    clearSelectionAskHideTimer();
    setSelectionAsk({
      quote: trimmed,
      anchor,
      sourceAgentId: agent.id,
      sourcePaneId: pane.id,
      // "Ask in new thread" forks, which needs an adapter with native fork support
      // and a recorded session id — gate the button so it's never a dead end.
      canFork:
        Boolean(agent.sessionId) &&
        (agent.adapter === CLAUDE_ADAPTER_ID || agent.adapter === CODEX_ADAPTER_ID),
    });
  }
  function handleTerminalAskSelection(paneId: string, quote: string, anchor: SelectionAnchor) {
    if (!visibleTerminalPaneIdSet.has(paneId)) {
      return;
    }
    const pane = paneById.get(paneId);
    showSelectionAskForPane(pane, pane ? agentByPaneId.get(pane.id) : undefined, quote, anchor);
  }
  function handleTerminalSelectionCopied() {
    showAppToast("Selection copied");
  }
  function openAskLauncher(mode: "ask" | "newThread") {
    const selection = selectionAsk;
    if (!selection) {
      return;
    }
    setAskLauncher({
      quote: selection.quote,
      mode,
      sourceAgentId: selection.sourceAgentId,
      sourcePaneId: selection.sourcePaneId,
    });
    setAskPrompt("");
    setAskCreateInWorktree(false);
    setAskSelectedSkillId(null);
    dismissSelectionAskNow();
    focusAskInput();
  }
  function closeAskLauncher(focusPaneId?: string) {
    askDictation.stop();
    setAskLauncher(null);
    setAskPrompt("");
    setAskCreateInWorktree(false);
    setAskSelectedSkillId(null);
    // After a fork the active pane changed, but `focusActiveTerminal` reads the
    // pre-update `activePane` from this render's closure — so focus the requested
    // pane (the fork) explicitly; otherwise fall back to the active terminal.
    if (focusPaneId) {
      requestAnimationFrame(() => terminalPaneRefs.current.get(focusPaneId)?.focus());
    } else {
      focusActiveTerminal();
    }
  }
  async function submitAsk() {
    if (!askLauncher || askSubmittingRef.current) {
      return;
    }
    const question = askPrompt.trim();
    if (!question) {
      return;
    }
    askDictation.stop();
    const target = askLauncher;
    const targetAgent = agents.find((agent) => agent.id === target.sourceAgentId) ?? null;
    const skill =
      target.mode === "newThread" &&
      targetAgent?.adapter === CLAUDE_ADAPTER_ID &&
      askSelectedSkillId
        ? availableSkills.find((entry) => entry.id === askSelectedSkillId) ?? null
        : null;
    let message = buildQuotedMessage(target.quote, question);
    if (skill) {
      message = `${skill.command} ${message}`;
    }
    setError(null);
    askSubmittingRef.current = true;
    let focusPaneId: string | undefined;
    try {
      if (target.mode === "ask") {
        // "auto": the backend sends now if the agent is ready, or queues onto the
        // current conversation if it's busy.
        const result = await submitAgentTurn(target.sourceAgentId, message, "auto");
        setAgentQueuedTurns(target.sourceAgentId, result.queuedTurns);
      } else {
        const pane = await forkAgent(target.sourcePaneId, {
          nest: true,
          useWorktree: askCreateInWorktree,
          prompt: message,
        });
        setPanesPreservingRecoveredDismissals((current) =>
          current.some((existing) => existing.id === pane.id) ? current : [...current, pane],
        );
        setActivePaneId(pane.id);
        expandNewAgentTranscriptByDefault(pane);
        // Land focus on the fork we just switched to, not the source pane.
        focusPaneId = pane.id;
        if (!pane.agentId) {
          // A forkable pane should always come back with an agent id; surface it
          // rather than silently accepting a fork that cannot be tracked.
          setError("The forked conversation isn't ready to receive a message.");
        }
      }
      closeAskLauncher(focusPaneId);
    } catch (err) {
      // Keep the launcher open on failure so the question isn't lost and the user
      // can retry.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      askSubmittingRef.current = false;
    }
  }

  // Mirror active-tab state into refs so the always-on keydown listener never reads
  // stale state.
  useEffect(() => {
    activePaneRef.current = activePane;
    browserOverlayByPaneRef.current = browserOverlayByPane;
    toggleActiveBrowserOverlayRef.current = toggleActiveBrowserOverlay;
    closeActiveBrowserOverlayRef.current = closeActiveBrowserOverlay;
    requestClosePaneRef.current = requestClosePane;
    splitPaneBelowRef.current = splitPaneBelow;
    canToggleActiveTranscriptExpandedRef.current = Boolean(
      activePane && activePaneHasTurnSidebar,
    );
    toggleActiveTranscriptExpandedRef.current = toggleActiveTranscriptExpanded;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      const pane = activePaneRef.current;
      const browserOpen = pane ? browserOverlayByPaneRef.current[pane.id]?.open === true : false;
      if (!browserOpen) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeActiveBrowserOverlayRef.current();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    if (!paneContextMenu && !groupMenu && !settingsMenu) {
      return;
    }
    const handleDismiss = () => {
      setPaneContextMenu(null);
      setGroupMenu(null);
      setSettingsMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPaneContextMenu(null);
        setGroupMenu(null);
        setSettingsMenu(null);
        return;
      }

      if (!groupMenu || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== "c" && key !== "e" && key !== "r") {
        return;
      }

      const group = groups.find((candidate) => candidate.id === groupMenu.groupId);
      if (!group) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (key === "r") {
        setGroupMenu(null);
        openGroupRenameDialog(group);
        return;
      }

      if (key === "e") {
        void expandGroup(group);
        return;
      }

      void toggleGroupCollapsed(group);
    };
    window.addEventListener("mousedown", handleDismiss);
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handleDismiss);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [paneContextMenu, groupMenu, settingsMenu, groups]);

  useEffect(() => {
    if (paneContextMenu && !panes.some((pane) => pane.id === paneContextMenu.paneId)) {
      setPaneContextMenu(null);
    }
    if (groupMenu && !groups.some((group) => group.id === groupMenu.groupId)) {
      setGroupMenu(null);
    }
  }, [paneContextMenu, panes, groupMenu, groups]);

  // Persist application settings whenever they change, so the choice survives a
  // restart. Writing on the initial value is harmless.
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    titleGenerationTestSeqRef.current += 1;
    setTitleGenerationTest(null);
  }, [
    settings.tabTitleProvider,
    settings.openRouterKey,
    settings.openRouterModel,
    config?.tabTitleGeneration.appleFoundationModelsAvailable,
  ]);

  useEffect(() => {
    let disposed = false;
    void getShowHideShortcut()
      .then((setting) => {
        if (!disposed) {
          setShowHideShortcutSetting(setting);
        }
      })
      .catch((err) => {
        if (!disposed) {
          setShowHideShortcutSetting({
            accelerator: null,
            registered: false,
            error: unknownErrorMessage(err),
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (appToastTimerRef.current !== null) {
        window.clearTimeout(appToastTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => () => clearSelectionAskHideTimer(), []);

  // Keep the machine awake while the toggle is on and at least one agent is
  // actively working (running or starting up). Releasing the lock the moment no
  // agent is busy lets normal power management resume.
  const anyAgentBusy = useMemo(
    () => agents.some((agent) => agent.status === "running" || agent.status === "starting"),
    [agents],
  );
  useEffect(() => {
    const active = settings.preventSleep && anyAgentBusy;
    void setPreventSleep(active).catch(() => undefined);
    if (!active) {
      return;
    }
    // Re-assert periodically while the lock is wanted: the backend declines (and
    // releases) it while on battery under 10%, so this lets a drop below — or a
    // recovery / plugging in — take effect without waiting for an agent state change.
    const interval = window.setInterval(() => {
      void setPreventSleep(true).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [settings.preventSleep, anyAgentBusy]);

  // Mirror the login-shell preference to the backend, which keeps its own
  // persisted copy (read on the spawn path, including startup recovery that runs
  // before this fires). Pushing on mount and on every change keeps the two stores
  // in agreement so a fresh spawn — and the next restart's recovery — honors what
  // the dialog shows.
  useEffect(() => {
    void setUseLoginShell(settings.useLoginShell).catch(() => undefined);
  }, [settings.useLoginShell]);

  // Escape cancels the worktree close dialog. Capture phase so it wins over the
  // global ⌘W/Ctrl-W shortcut handler while the dialog is open.
  useEffect(() => {
    if (!closeDialog && !exitDialog) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // Don't dismiss the worktree dialog while its close/delete is running.
        if (!resolvingClose) {
          setCloseDialog(null);
        }
        setExitDialog(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeDialog, exitDialog, resolvingClose]);

  // Escape closes the settings panel. Separate from the dialog handler above so
  // it can run regardless of which other modals are open.
  useEffect(() => {
    if (!settingsOpen) {
      setOpenRouterKeyVisible(false);
      setSettingsTab("basic");
      setShowHideShortcutCapturing(false);
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [settingsOpen]);

  // Focus and select the name when the rename dialog opens, so the user can type
  // a new name straight away.
  useEffect(() => {
    if (renamePaneId || renameGroupId) {
      const input = renameInputRef.current;
      input?.focus();
      input?.select();
    }
  }, [renamePaneId, renameGroupId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.metaKey) {
        setShortcutHintsVisible(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta" || !event.metaKey) {
        setShortcutHintsVisible(false);
      }
    };
    const hideShortcutHints = () => setShortcutHintsVisible(false);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hideShortcutHints();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", hideShortcutHints);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", hideShortcutHints);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShowHideShortcutCaptureTarget(event.target)) {
        return;
      }
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) {
        return;
      }

      // The ask modal owns the keyboard while open: don't stack the launcher or
      // settings over it, switch tabs behind it, or zoom. Its own combos (Escape,
      // Cmd+Enter, Cmd+Z) are handled on the form and don't pass through here. We
      // only return, never preventDefault, so the textarea's native editing keys
      // (Cmd+C/V/A) still work.
      if (askLauncherOpenRef.current) {
        return;
      }

      const key = event.key.toLowerCase();

      const commandOnly = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

      // Cmd-= zooms the terminal font in, Cmd-- zooms it out, and Cmd-0 resets it.
      // Handled before the repeat bail so holding the zoom combo keeps stepping
      // the size; the change is written into the persisted settings, same as the
      // panel stepper.
      if (commandOnly && (key === "+" || key === "=" || key === "-" || key === "0")) {
        event.preventDefault();
        event.stopPropagation();
        setSettings((current) => ({
          ...current,
          fontSize:
            key === "0"
              ? TERMINAL_FONT_SIZE
              : clampFontSize(current.fontSize + (key === "-" ? -1 : 1)),
        }));
        return;
      }

      if (event.repeat) {
        return;
      }

      const focusTabById = (tabId: string) => {
        if (tabId === HOME_TAB_ID) {
          focusHomeTab();
          return;
        }
        focusPaneTab(tabId);
      };

      const cycleTab = (
        direction: -1 | 1,
        includeHome: boolean,
        cyclePanes = sidebarPanes,
      ) => {
        const tabIds = includeHome
          ? [HOME_TAB_ID, ...cyclePanes.map((pane) => pane.id)]
          : cyclePanes.map((pane) => pane.id);
        if (tabIds.length === 0) {
          return;
        }
        const listedIndex = tabIds.indexOf(activePaneId ?? "");
        let fallbackIndex: number;
        if (listedIndex !== -1) {
          fallbackIndex = listedIndex;
        } else if (includeHome) {
          // Active tab not in the list (e.g. a pane inside a collapsed group):
          // position so forward lands on the first visible pane and backward on Home.
          fallbackIndex = direction === 1 ? 0 : Math.min(1, tabIds.length - 1);
        } else {
          // Skipping Home while Home is active: position so forward lands on the
          // first pane and backward on the last.
          fallbackIndex = direction === 1 ? -1 : 0;
        }
        const nextTabId = cycleTabId(
          tabIds,
          activePaneId,
          direction,
          paneSplits,
          fallbackIndex,
        );
        if (nextTabId) {
          focusTabById(nextTabId);
        }
      };

      // Cmd-1..9 / Ctrl-1..9 jump to real pane tabs in sidebar order. Claimed
      // before the editable-target bail so the app-level tab shortcuts keep
      // working from terminal and composer focus.
      if (/^[1-9]$/.test(key) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const pane = sidebarPanes[Number(key) - 1];
        if (pane) {
          focusPaneTab(pane.id);
        }
        return;
      }

      // Cmd-N jumps to Home. Once Home's inline launcher is already active,
      // repeat presses cycle the selected agent adapter.
      if (commandOnly && key === "n") {
        event.preventDefault();
        event.stopPropagation();
        if (homeActive) {
          cycleLauncherAdapter();
        } else {
          focusHomeTab();
        }
        return;
      }

      // Cmd-Shift-H also jumps to Home. Claimed before the editable-target bail so
      // it works from terminal and composer focus too.
      if (event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey && key === "h") {
        event.preventDefault();
        event.stopPropagation();
        focusHomeTab();
        return;
      }

      // Ctrl-Tab / Ctrl-Shift-Tab cycle through visible pane tabs across groups.
      // Claimed here in the capture phase (before the terminal/editable bail) so it
      // works regardless of focus; Tab with Ctrl is never a text-editing key.
      if (key === "tab" && event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(event.shiftKey ? -1 : 1, false, cycleableSidebarPanes);
        return;
      }

      // Cmd-Shift-[ / Cmd-Shift-] cycle backward/forward through Home and the open
      // tabs (Home included). Claimed in the capture phase so it works regardless
      // of focus.
      if ((key === "[" || key === "]") && event.metaKey && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(key === "[" ? -1 : 1, true, cycleableSidebarPanes);
        return;
      }

      // Cmd-; / Ctrl-; opens qmux's agent picker, even from terminal focus.
      // Once the picker is open, repeat presses cycle the selected agent adapter.
      // Claimed in the capture phase so focus doesn't matter; ⌘K is left alone
      // for the terminal to handle (e.g. clear-screen).
      if (key === ";") {
        event.preventDefault();
        event.stopPropagation();
        if (launcherOpen) {
          cycleLauncherAdapter();
        } else {
          setLauncherOpen(true);
        }
        return;
      }

      // Cmd-, / Ctrl-, opens the settings panel from anywhere, including terminal
      // focus. Claimed in the capture phase so focus doesn't matter; Escape (handled
      // separately) closes it again.
      if (key === ",") {
        event.preventDefault();
        event.stopPropagation();
        setSettingsMenu(null);
        setSettingsOpen(true);
        return;
      }

      // Cmd-Shift-E / Ctrl-Shift-E toggles transcript expansion when available.
      // In shell-only tabs, where there is no transcript to expand, the same combo
      // toggles the browser overlay.
      if (
        key === "e" &&
        event.shiftKey &&
        !event.altKey &&
        ((event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey))
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (canToggleActiveTranscriptExpandedRef.current) {
          toggleActiveTranscriptExpandedRef.current();
        } else if (activePaneRef.current) {
          toggleActiveBrowserOverlayRef.current();
        }
        return;
      }

      // Cmd-D / Cmd-Shift-D splits the active terminal downward, matching the tab
      // context-menu action and common terminal split behavior.
      if (event.metaKey && !event.ctrlKey && !event.altKey && key === "d") {
        event.preventDefault();
        event.stopPropagation();
        const pane = activePaneRef.current;
        if (pane) {
          void splitPaneBelowRef.current(pane);
        }
        return;
      }

      if (key !== "t" && key !== "w") {
        return;
      }

      // Cmd-Shift-T restores the most recently closed tab, matching browser tab undo.
      // Claimed before the Cmd-T branch so it never opens a fresh shell instead.
      if (event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey && key === "t") {
        event.preventDefault();
        event.stopPropagation();
        void restoreClosedPane();
        return;
      }

      // ⌘W/Ctrl-W close the active pane instead of the window. ⌘W always closes
      // (it is never a text-editing key); Ctrl-W must stay as delete-previous-word
      // in the terminal and text inputs, so it only closes when focus is elsewhere.
      if (key === "w") {
        if (
          event.ctrlKey &&
          !event.metaKey &&
          (isTerminalTarget(event.target) || isEditableTarget(event.target))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const pane = activePaneRef.current;
        if (pane) {
          requestClosePaneRef.current(pane);
        }
        return;
      }

      // Ctrl-based shortcuts collide with native text editing (e.g. Ctrl-W delete-word) in
      // any editable element, so let those through; the documented ⌘ shortcuts keep working.
      if (event.ctrlKey && !event.metaKey && isEditableTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Cmd-T opens a new shell pane in code mode. Outside code mode, shell panes
      // are hidden from the sidebar actions, so Cmd-T aliases the visible New Agent
      // action.
      if (!event.metaKey || event.ctrlKey) {
        return;
      }
      if (!settingsRef.current.codeMode) {
        setLauncherOpen(true);
        return;
      }
      void addShellPane();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    activePaneId,
    panes,
    sidebarPanes,
    cycleableSidebarPanes,
    activePane,
    lastActiveGroupId,
    groupById,
    homeActive,
    launcherOpen,
    launcherAdapterOptions,
    launchAdapter.id,
    paneSplits,
  ]);

  useEffect(() => {
    if (!launcherVisible) {
      return;
    }

    // New agents default to no worktree and no skill each time the launcher opens.
    setCreateInWorktree(false);
    setSelectedSkillId(null);
    // Re-read the plugin's skills on open so newly added ones show up without a
    // restart. Failures (e.g. no plugin dir) just leave the list empty.
    void listClaudeSkills()
      .then(setAvailableSkills)
      .catch(() => setAvailableSkills([]));
    requestAnimationFrame(() => {
      launcherInputRef.current?.focus();
      launcherInputRef.current?.select();
    });
    // Depend on launcherOpen too: on Home the launcher is already visible inline, so
    // opening the modal (e.g. ⌘;) doesn't flip launcherVisible. Without this the modal's
    // freshly-mounted textarea — a different node than the inline one — never gets focus.
  }, [launcherVisible, launcherOpen]);

  // The ask launcher's Claude "new thread" mode shows the same skill toggles, but
  // opening it doesn't pass through the launcher-visible effect above — so load the
  // skills here too, otherwise the toggles are empty until the main launcher has
  // been opened once this session.
  useEffect(() => {
    if (askLauncher?.mode !== "newThread") {
      return;
    }
    const sourceAgent = agents.find((agent) => agent.id === askLauncher.sourceAgentId);
    if (sourceAgent?.adapter !== CLAUDE_ADAPTER_ID) {
      setAskSelectedSkillId(null);
      return;
    }
    void listClaudeSkills()
      .then(setAvailableSkills)
      .catch(() => setAvailableSkills([]));
  }, [agents, askLauncher?.mode, askLauncher?.sourceAgentId]);

  // Selecting a non-Claude adapter clears any chosen skill; measure the faint
  // command prefix so the composer's first line is indented past it.
  useEffect(() => {
    if (!skillsEnabled) {
      setSelectedSkillId(null);
    }
  }, [skillsEnabled]);

  useLayoutEffect(() => {
    if (!selectedSkill) {
      setSkillPrefixWidth(0);
      return;
    }
    setSkillPrefixWidth(skillPrefixRef.current?.getBoundingClientRect().width ?? 0);
  }, [selectedSkill, launcherVisible]);

  // Grow the launcher textarea to fit its content so a multi-line prompt expands the
  // whole launcher (the CSS max-height caps it, after which the field scrolls). The
  // skill prefix changes the first line's indent, so re-measure when it changes too.
  useLayoutEffect(() => {
    const textarea = launcherInputRef.current;
    if (!launcherVisible || !textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [prompt, launcherVisible, skillPrefixWidth]);

  useEffect(() => {
    const runtimeAdapterIds = config?.adapters.map((adapter) => adapter.id) ?? [];
    if (runtimeAdapterIds.length === 0) {
      return;
    }
    setLauncherAdapterId((current) =>
      current && runtimeAdapterIds.includes(current) ? current : null,
    );
  }, [config]);

  useEffect(() => {
    if (wasLauncherOpenRef.current && !launcherOpen) {
      focusActiveTerminal();
    }
    wasLauncherOpenRef.current = launcherOpen;
  }, [launcherOpen, activePane?.id]);

  useEffect(() => {
    if (!hasVisibleRightBar) {
      return;
    }

    const handleResize = () => {
      setTurnPaneWidth((current) => clampTurnPaneWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hasVisibleRightBar]);

  // Keep the sidebar within bounds as the window resizes or the turn pane claims
  // space (deps refresh the clamp's view of available width).
  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hasVisibleRightBar, turnPaneWidth]);

  async function updateShowHideShortcut(accelerator: string | null) {
    setShowHideShortcutSaving(true);
    setShowHideShortcutSetting((current) => ({
      ...current,
      accelerator,
      error: null,
    }));
    try {
      const setting = await setShowHideShortcut(accelerator);
      setShowHideShortcutSetting(setting);
    } catch (err) {
      setShowHideShortcutSetting((current) => ({
        ...current,
        error: unknownErrorMessage(err),
      }));
    } finally {
      setShowHideShortcutSaving(false);
    }
  }

  function captureShowHideShortcut(event: ReactKeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    event.stopPropagation();

    const { accelerator, error } = shortcutFromKeyboardEvent(event);
    if (error) {
      setShowHideShortcutSetting((current) => ({ ...current, error }));
      return;
    }
    if (!accelerator) {
      return;
    }
    void updateShowHideShortcut(accelerator);
  }

  function clearShowHideShortcut() {
    void updateShowHideShortcut(null);
  }

  function setShowHideShortcutCapturing(active: boolean) {
    void setShowHideShortcutCaptureActive(active).catch(() => undefined);
  }

  function startTurnPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = turnPaneWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + startX - moveEvent.clientX;
      setTurnPaneWidth(clampTurnPaneWidth(nextWidth));
    };
    const stopResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function resizeTurnPaneWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    setTurnPaneWidth((current) =>
      clampTurnPaneWidth(current + (event.key === "ArrowLeft" ? step : -step)),
    );
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      setSidebarWidth(clampSidebarWidth(nextWidth));
    };
    const stopResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function resizeSidebarWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    setSidebarWidth((current) =>
      clampSidebarWidth(current + (event.key === "ArrowRight" ? step : -step)),
    );
  }

  // The launcher form, shared by the modal overlay and the inline content-pane
  // placeholder. The inline variant drops the modal semantics (no Escape-to-close,
  // no aria-modal) and wears a plain border instead of the accent ring.
  const renderLauncher = (variant: "modal" | "inline") => (
    <form
      className={`command-launcher${variant === "inline" ? " command-launcher--inline" : ""}`}
      role="dialog"
      aria-modal={variant === "modal" ? true : undefined}
      aria-label="New agent"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (variant === "modal") {
            event.preventDefault();
            setLauncherOpen(false);
          }
          return;
        }
        // Swallow Undo/Redo (⌘Z / ⌘⇧Z, Ctrl on other platforms). The prompt is a
        // controlled input, so the WebView's native undo has no field-local history
        // to act on and instead blurs the textarea — which hands focus back to the
        // terminal. Trapping the combo here keeps focus (and the caret) put.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          return;
        }
        if (isComposerSubmitShortcut(event, settings.requireCmdEnterToSend)) {
          event.preventDefault();
          void addAgentPane();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void addAgentPane();
      }}
    >
      {selectedSkill ? (
        <span
          ref={skillPrefixRef}
          className="command-launcher-skill-prefix"
          aria-hidden="true"
        >
          {`${selectedSkill.command} `}
        </span>
      ) : null}
      <textarea
        ref={launcherInputRef}
        id="agent-prompt"
        className="command-launcher-input"
        value={prompt}
        onChange={(event) => setPrompt(event.currentTarget.value)}
        // While dictation is live, the first real keystroke hands control back to
        // the keyboard: stop transcribing so it stops overwriting the caret. Bare
        // modifiers don't count.
        onKeyDownCapture={(event) => {
          if (!launcherDictation.listening) {
            return;
          }
          if (
            event.key === "Shift" ||
            event.key === "Control" ||
            event.key === "Alt" ||
            event.key === "Meta" ||
            event.key === "CapsLock"
          ) {
            return;
          }
          launcherDictation.stop();
        }}
        rows={2}
        placeholder="What should we investigate next?"
        style={selectedSkill ? { textIndent: `${skillPrefixWidth}px` } : undefined}
      />
      <DictationMicButton dictation={launcherDictation} className="command-launcher-mic" />
      <div className="command-launcher-overlay">
        <div className="command-launcher-overlay-group">
          {settings.codeMode ? (
            <label className="command-launcher-worktree">
              <input
                type="checkbox"
                checked={createInWorktree}
                onChange={(event) => {
                  setCreateInWorktree(event.currentTarget.checked);
                  focusLauncherInput();
                }}
              />
              <span>New worktree</span>
            </label>
          ) : null}
          {skillsEnabled && availableSkills.length > 0 ? (
            <div className="command-launcher-skills">
              {availableSkills.map((skill) => (
                <label
                  key={skill.id}
                  className="command-launcher-worktree command-launcher-skill"
                  title={skill.command}
                >
                  <input
                    type="checkbox"
                    checked={selectedSkillId === skill.id}
                    onChange={() => {
                      // Single-select: re-clicking the active skill clears it.
                      setSelectedSkillId((current) =>
                        current === skill.id ? null : skill.id,
                      );
                      focusLauncherInput();
                    }}
                  />
                  <span>{skill.name}</span>
                </label>
              ))}
            </div>
          ) : null}
          {LauncherOptions ? (
            <div className="command-launcher-options">
              <LauncherOptions
                value={launcherOptions}
                onChange={(next) => {
                  setLauncherOptionsByAdapter((current) => ({
                    ...current,
                    [launchAdapter.id]: next,
                  }));
                  focusLauncherInput();
                }}
              />
            </div>
          ) : null}
        </div>
        <div className="command-launcher-controls">
          <div className="command-launcher-adapter-select">
            <LauncherSelect
              value={launchAdapter.id}
              options={launcherAdapterOptions}
              ariaLabel="Agent"
              onChange={(adapterId) => {
                rememberLauncherAdapter(adapterId);
                focusLauncherInput();
              }}
            />
          </div>
          <button
            type="submit"
            className="command-launcher-send"
            aria-label={`Launch ${launchAdapter.label}`}
            title={`Launch ${launchAdapter.label}`}
          >
            <ComposerSubmitShortcutGlyph
              requireCmdEnter={settings.requireCmdEnterToSend}
              ariaHidden
            />
          </button>
        </div>
      </div>
    </form>
  );

  const askLauncherSourceAgent = askLauncher
    ? agents.find((agent) => agent.id === askLauncher.sourceAgentId) ?? null
    : null;
  const askLauncherSkillsEnabled =
    askLauncher?.mode === "newThread" && askLauncherSourceAgent?.adapter === CLAUDE_ADAPTER_ID;

  // The ask launcher: a launcher-style modal seeded with a quoted selection. In
  // "ask" mode only the question field, mic, and submit show; in "newThread" mode
  // (fork-with-prompt) the worktree checkbox is shown, with Claude skill toggles
  // when the source adapter supports them. The adapter select is intentionally
  // omitted — a fork inherits the source's adapter.
  const renderAskLauncher = (state: AskLauncherState) => (
    <form
      className="command-launcher command-launcher--ask"
      role="dialog"
      aria-modal={true}
      aria-label={state.mode === "newThread" ? "Ask in a new thread" : "Ask about selection"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeAskLauncher();
          return;
        }
        // Swallow Undo/Redo so the WebView doesn't blur the controlled textarea
        // (see the launcher's note).
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          return;
        }
        if (
          isComposerSubmitShortcut(event, settings.requireCmdEnterToSend) &&
          !event.repeat
        ) {
          event.preventDefault();
          void submitAsk();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submitAsk();
      }}
    >
      <blockquote className="command-launcher-quote">{state.quote}</blockquote>
      <textarea
        ref={askInputRef}
        className="command-launcher-input command-launcher-input--ask"
        value={askPrompt}
        onChange={(event) => setAskPrompt(event.currentTarget.value)}
        onKeyDownCapture={(event) => {
          if (!askDictation.listening) {
            return;
          }
          if (
            event.key === "Shift" ||
            event.key === "Control" ||
            event.key === "Alt" ||
            event.key === "Meta" ||
            event.key === "CapsLock"
          ) {
            return;
          }
          askDictation.stop();
        }}
        rows={2}
        placeholder="Ask about this quote"
        autoFocus
      />
      <div className="command-launcher-overlay">
        <div className="command-launcher-overlay-group">
          {state.mode === "newThread" ? (
            <>
              {settings.codeMode ? (
                <label className="command-launcher-worktree">
                  <input
                    type="checkbox"
                    checked={askCreateInWorktree}
                    onChange={(event) => {
                      setAskCreateInWorktree(event.currentTarget.checked);
                      focusAskInput();
                    }}
                  />
                  <span>New worktree</span>
                </label>
              ) : null}
              {askLauncherSkillsEnabled && availableSkills.length > 0 ? (
                <div className="command-launcher-skills">
                  {availableSkills.map((skill) => (
                    <label
                      key={skill.id}
                      className="command-launcher-worktree command-launcher-skill"
                      title={skill.command}
                    >
                      <input
                        type="checkbox"
                        checked={askSelectedSkillId === skill.id}
                        onChange={() => {
                          setAskSelectedSkillId((current) =>
                            current === skill.id ? null : skill.id,
                          );
                          focusAskInput();
                        }}
                      />
                      <span>{skill.name}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="command-launcher-controls">
          <DictationMicButton dictation={askDictation} className="command-launcher-ask-mic" />
          <button
            type="submit"
            className="command-launcher-send"
            aria-label={state.mode === "newThread" ? "Ask in a new thread" : "Ask"}
            title={state.mode === "newThread" ? "Ask in a new thread" : "Ask"}
          >
            {state.mode === "newThread" ? (
              <GitBranch size={13} aria-hidden="true" />
            ) : null}
            <span className="command-launcher-send-label">
              {state.mode === "newThread" ? "Ask in fork" : "Queue"}
            </span>
            <ComposerSubmitShortcutGlyph
              requireCmdEnter={settings.requireCmdEnterToSend}
              ariaHidden
            />
          </button>
        </div>
      </div>
    </form>
  );

  function openGroupMenu(event: ReactMouseEvent, group: GroupInfo) {
    event.preventDefault();
    event.stopPropagation();
    setPaneContextMenu(null);
    setSettingsMenu(null);
    setGroupMenu({
      groupId: group.id,
      x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - GROUP_CONTEXT_MENU_WIDTH - 8)),
      y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - GROUP_CONTEXT_MENU_ESTIMATED_HEIGHT - 8)),
    });
  }

  function toggleGroupMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>, group: GroupInfo) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || rect.right;
    const y = event.clientY || rect.bottom;
    setPaneContextMenu(null);
    setSettingsMenu(null);
    setGroupMenu((current) =>
      current?.groupId === group.id
        ? null
        : {
            groupId: group.id,
            x: clamp(x, 8, Math.max(8, window.innerWidth - GROUP_CONTEXT_MENU_WIDTH - 8)),
            y: clamp(y, 8, Math.max(8, window.innerHeight - GROUP_CONTEXT_MENU_ESTIMATED_HEIGHT - 8)),
          },
    );
  }

  function toggleSettingsMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - SETTINGS_CONTEXT_MENU_WIDTH - 8);
    const maxY = Math.max(8, window.innerHeight - SETTINGS_CONTEXT_MENU_ESTIMATED_HEIGHT - 8);
    const x = clamp(rect.right - SETTINGS_CONTEXT_MENU_WIDTH, 8, maxX);
    const upwardY = rect.top - SETTINGS_CONTEXT_MENU_ESTIMATED_HEIGHT - 6;
    const downwardY = rect.bottom + 6;
    const y = clamp(upwardY >= 8 ? upwardY : downwardY, 8, maxY);
    setPaneContextMenu(null);
    setGroupMenu(null);
    setSettingsMenu((current) => (current ? null : { x, y }));
  }

  function renderPaneTabRow(pane: PaneInfo, index: number, groupPanes: PaneInfo[], groupId: string) {
    const paneAgent = agents.find((agent) => agent.paneId === pane.id);
    const paneDisplayTitle = displayPaneTitle(pane, paneAgent);
    const paneTitleIsUserSet = paneHasUserSetTitle(pane, paneAgent);
    const paneAgentStatusTone = paneTabStatusTone(paneAgent);
    const paneAgentStatusClass =
      paneAgent?.status === "awaitingInput" ? " status-awaiting-input" : "";
    const canClearWorkingStatus =
      paneAgent?.status === "running" || paneAgent?.status === "starting";
    const paneTopQueueWaitsOnOtherPane = paneWaitsOnOtherPane(paneAgent);
    const paneWaitingClass = paneTopQueueWaitsOnOtherPane ? " is-waiting-on-pane" : "";
    const paneStatus = paneTabStatusLabel(pane, paneAgent);
    const paneSplit = paneSplitForPane(paneSplits, pane.id);
    // The panes of the active split render as one connected card in the sidebar.
    // Flag the run (and its top/bottom edges) so only the split you're viewing is
    // grouped — an inactive split keeps plain tabs. Members are contiguous within
    // their group, so the neighbours bracket the run.
    const paneInActiveSplit = Boolean(activePaneSplit) && visibleTerminalPaneIdSet.has(pane.id);
    const isActiveSplitFirst =
      paneInActiveSplit && !visibleTerminalPaneIdSet.has(groupPanes[index - 1]?.id ?? "");
    const isActiveSplitLast =
      paneInActiveSplit && !visibleTerminalPaneIdSet.has(groupPanes[index + 1]?.id ?? "");
    const paneDir = paneAgent?.worktreeDir ?? pane.cwd;
    const splitMembersShareDir = Boolean(
      paneSplit &&
        paneSplit.paneIds.length > 1 &&
        paneSplit.paneIds.every((paneId) => {
          const splitPane = paneById.get(paneId);
          if (!splitPane) {
            return false;
          }
          const splitPaneAgent = agentByPaneId.get(paneId);
          return (splitPaneAgent?.worktreeDir ?? splitPane.cwd) === paneDir;
        }),
    );
    const hidePaneDir =
      splitMembersShareDir && paneSplit?.paneIds[paneSplit.paneIds.length - 1] !== pane.id;
    const paneBranch = paneAgent?.branch ?? null;
    const paneWorktreeName =
      paneBranch && paneAgent?.worktreeDir
        ? (paneAgent.worktreeDir.split("/").filter(Boolean).pop() ?? null)
        : null;
    const paneGitMeta = [paneBranch, paneWorktreeName].filter(Boolean).join(" · ");
    const paneGitMetaTitle = [paneBranch, paneBranch ? paneAgent?.worktreeDir : null]
      .filter(Boolean)
      .join(" · ");
    const dropGap =
      paneDropTarget?.kind === "gap" && paneDropTarget.groupId === groupId
        ? paneDropTarget.index
        : null;
    const isNestTarget =
      paneDropTarget?.kind === "nest" &&
      paneDropTarget.groupId === groupId &&
      paneDropTarget.paneId === pane.id;
    const isDraggingRow =
      draggingPaneGroup === groupId &&
      draggingPaneIndex >= 0 &&
      index >= draggingPaneIndex &&
      index < draggingSubtreeEnd;
    const shortcutIndex = sidebarPanes.findIndex((sidebarPane) => sidebarPane.id === pane.id);
    const className = [
      "pane-tab-row",
      pane.id === activePane?.id ? "is-selected" : "",
      paneSplit ? "is-split-member" : "",
      paneInActiveSplit ? "is-split-active" : "",
      isActiveSplitFirst ? "is-split-active-first" : "",
      isActiveSplitLast ? "is-split-active-last" : "",
      paneAgent?.id === waitTargetHoverAgentId ? "is-wait-target-preview" : "",
      canClearWorkingStatus ? "has-clearable-status" : "",
      isDraggingRow ? "is-dragging" : "",
      dropGap === index ? "is-drop-before" : "",
      dropGap === groupPanes.length && index === groupPanes.length - 1 ? "is-drop-after" : "",
      isNestTarget ? "is-drop-nest" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div
        key={pane.id}
        className={className}
        data-pane-id={pane.id}
        data-group-id={groupId}
        style={{ "--pane-depth": pane.depth ?? 0 } as CSSProperties}
        onContextMenu={(event) => openPaneContextMenu(event, pane)}
        onPointerDown={(event) => handlePaneTabPointerDown(event, pane.id)}
        onPointerMove={handlePaneTabPointerMove}
        onPointerUp={handlePaneTabPointerUp}
        onPointerCancel={handlePaneTabPointerCancel}
        onClick={() => handlePaneTabClick(pane.id)}
        onDoubleClick={() => handlePaneTabDoubleClick(pane)}
      >
        {isNestTarget ? (
          <div className="pane-tab-nest-indicator" aria-hidden="true">
            <span className="pane-tab-nest-gutter">
              <ChevronRight size={12} aria-hidden="true" />
            </span>
          </div>
        ) : null}
        <button
          type="button"
          className="pane-tab"
          onClick={(event) => {
            event.stopPropagation();
            handlePaneTabClick(pane.id);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            handlePaneTabDoubleClick(pane);
          }}
        >
          <span
            className={`pane-tab-dot status-${paneAgentStatusTone}${paneAgentStatusClass}${paneWaitingClass}${
              canClearWorkingStatus ? " is-clearable-placeholder" : ""
            }`}
            aria-hidden="true"
          />
          <span className="pane-tab-content">
            <span className={`pane-tab-title${paneTitleIsUserSet ? " is-user-set" : ""}`}>
              {paneDisplayTitle}
            </span>
            {settings.codeMode && settings.showTabDirectories && paneDir && !hidePaneDir ? (
              <span className="pane-tab-path" title={paneDir}>
                {formatPaneDir(paneDir)}
              </span>
            ) : null}
            {settings.codeMode && paneGitMeta ? (
              <span className="pane-tab-gitmeta" title={paneGitMetaTitle}>
                {paneGitMeta}
              </span>
            ) : null}
          </span>
          {pane.recovered || paneStatus ? (
            <span className="pane-tab-meta">
              {pane.recovered ? (
                <small className="pane-tab-status" title="Restored after restart">
                  Restored
                </small>
              ) : null}
              {paneStatus ? (
                paneAgent?.status === "failed" ? (
                  <small
                    className="pane-tab-status pane-tab-status-clickable"
                    role="button"
                    tabIndex={0}
                    title="Dismiss failed status"
                    aria-label="Dismiss failed status"
                    onClick={(event) => {
                      event.stopPropagation();
                      void acknowledgeAgentStatus(paneAgent.id, true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        void acknowledgeAgentStatus(paneAgent.id, true);
                      }
                    }}
                  >
                    {paneStatus}
                  </small>
                ) : (
                  <small className="pane-tab-status">{paneStatus}</small>
                )
              ) : null}
            </span>
          ) : null}
        </button>
        {canClearWorkingStatus && paneAgent ? (
          <button
            type="button"
            className="pane-tab-clear-status pane-tab-dot-button"
            aria-label={`Clear working status for ${paneDisplayTitle}`}
            title="Clear working status"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              void clearAgentWorkingIndicator(paneAgent.id);
            }}
          >
            <span
              className={`pane-tab-dot status-${paneAgentStatusTone}${paneAgentStatusClass}${paneWaitingClass}`}
              aria-hidden="true"
            />
          </button>
        ) : null}
        <a
          className="pane-tab-close"
          role="button"
          tabIndex={0}
          aria-label={`Close ${paneDisplayTitle}`}
          title={`Close ${paneDisplayTitle}`}
          onPointerDown={(event) => handlePaneTabClosePointerDown(event, pane)}
          onClick={(event) => handlePaneTabCloseClick(event, pane)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              void requestClosePane(pane, { confirmAlways: true });
            }
          }}
        >
          <X size={13.5} aria-hidden="true" />
        </a>
        {shortcutHintsShown && shortcutIndex >= 0 && shortcutIndex < 9 ? (
          <span className="pane-tab-shortcut-hint" aria-hidden="true">
            ⌘{shortcutIndex + 1}
          </span>
        ) : null}
      </div>
    );
  }

  function renderTurnPaneResizer() {
    return (
      <div
        className="turn-pane-resizer"
        role="separator"
        aria-label="Resize command queue"
        aria-orientation="vertical"
        aria-valuemin={TURN_PANE_MIN_WIDTH}
        aria-valuemax={maxTurnPaneWidth()}
        aria-valuenow={turnPaneWidth}
        tabIndex={0}
        onPointerDown={startTurnPaneResize}
        onKeyDown={resizeTurnPaneWithKeyboard}
      />
    );
  }

  function turnPaneSplitCellStyle(surface: TurnPaneSurface): CSSProperties {
    return {
      top: `${surface.topFraction * 100}%`,
      height: `${surface.heightFraction * 100}%`,
    };
  }

  function renderFloatingTurnPaneControls(surface: TurnPaneSurface) {
    const expanded = surface.pane.id === activePane?.id && activeTranscriptExpanded;
    const label = expanded ? "Restore transcript" : "Expand transcript";
    return (
      <div className="turn-pane-floating-controls">
        <button
          type="button"
          className={`turn-pane-header-button turn-pane-floating-expand-button${
            expanded ? " is-active" : ""
          }`}
          title={`${label} (${EXPAND_TOGGLE_SHORTCUT_LABEL})`}
          aria-label={label}
          aria-pressed={expanded}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            activateTerminalPane(surface.pane.id);
            setTranscriptExpandedForPane(surface.pane.id, !expanded, true);
          }}
        >
          {expanded ? (
            <Minimize2 size={14} aria-hidden="true" />
          ) : (
            <Expand size={14} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="turn-pane-header-button turn-pane-floating-collapse-button"
          title="Collapse right bar"
          aria-label="Collapse right bar"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            activateTerminalPane(surface.pane.id);
            setRightBarCollapsed(true);
          }}
        >
          <PanelRightClose size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }

  function renderFloatingRightBarRestoreButton() {
    if (!rightBarCollapsed || !activePaneHasTurnSidebar) {
      return null;
    }

    return (
      <button
        type="button"
        className="turn-pane-header-button turn-pane-floating-restore-button"
        title="Show right bar"
        aria-label="Show right bar"
        onClick={() => setRightBarCollapsed(false)}
      >
        <PanelRightOpen size={14} aria-hidden="true" />
      </button>
    );
  }

  function renderTurnPaneSurface(surface: TurnPaneSurface, showHeader: boolean) {
    const agent = surface.agent;
    // Split cells are short and deliberately headerless, so keep the composer
    // floating there even if this agent normally uses a transcript/queue split.
    const queueSplit = showHeader && surface.queueSplit;

    return (
      <TurnOverlay
        turns={agent ? surface.turns : []}
        thinking={Boolean(
          agent &&
            thinkingAgentIds.has(agent.id) &&
            (agent.status === "running" || agent.status === "starting"),
        )}
        thinkingLabel={
          agent && Object.prototype.hasOwnProperty.call(processingNewMessageByAgent, agent.id)
            ? "Processing new message…"
            : "Working…"
        }
        showActivityDetail={settings.showToolCalls}
        agentId={agent?.id ?? surface.pane.id}
        assistantLabel={surface.assistantLabel}
        notice={agent ? surface.transcriptNotice : null}
        transcriptOptions={agent ? surface.transcriptOptions : []}
        transcriptPath={agent?.transcriptPath ?? null}
        onSelectTranscript={
          agent ? (path) => void handleSelectTranscript(agent.id, path) : undefined
        }
        queueSplit={queueSplit}
        queueSplitHeight={queueSplit ? surface.queueSplitHeight : undefined}
        onQueueSplitHeightChange={
          agent ? (height) => setQueueSplitHeightForAgent(agent.id, height) : undefined
        }
        linkActions={linkActionsForPane(surface.pane.id)}
        onAskSelection={(quote, anchor) =>
          showSelectionAskForPane(surface.pane, agent, quote, anchor)
        }
        onDismissSelection={dismissSelectionAskSoon}
        onRegenerateTitleFromUserMessage={
          agent && titleGenerationEnabled
            ? (message) =>
                void regeneratePaneTitleFromUserMessage(surface.pane.id, message, agent.id)
            : undefined
        }
        titleGenerationBusy={regeneratingTitlePaneIds.has(surface.pane.id)}
        header={
          showHeader ? (
            <TurnPaneHeader
              sessionId={agent?.sessionId ?? null}
              transcriptOptions={agent ? surface.transcriptOptions : []}
              transcriptPath={agent?.transcriptPath ?? null}
              onSelectTranscript={(path) => {
                if (agent) {
                  void handleSelectTranscript(agent.id, path);
                }
              }}
              canFork={Boolean(
                agent?.sessionId &&
                  (agent.adapter === CLAUDE_ADAPTER_ID || agent.adapter === CODEX_ADAPTER_ID),
              )}
              onFork={(options) => void forkActivePane(options)}
              showQueueSplit={Boolean(agent)}
              queueSplit={surface.queueSplit}
              onToggleQueueSplit={toggleActiveQueueSplit}
              browserOpen={surface.browserOverlay?.open ?? false}
              onToggleBrowser={toggleActiveBrowserOverlay}
              transcriptExpanded={activeTranscriptExpanded}
              transcriptShortcutLabel={EXPAND_TOGGLE_SHORTCUT_LABEL}
              onToggleTranscriptExpanded={toggleActiveTranscriptExpanded}
              onCollapseRightBar={() => setRightBarCollapsed(true)}
            />
          ) : undefined
        }
        input={
          <div className="turn-pane-input-stack">
            {surface.orphanedQueues.length > 0 ? (
              <RecoveredQueuePanel
                queues={surface.orphanedQueues}
                hasTargetAgent={Boolean(agent)}
                agentLabel={launchAdapter.label}
                onMoveTurn={(agentId, index, turn) =>
                  void moveRecoveredQueuedTurn(agentId, agent?.id, index, turn)
                }
                onDiscardTurn={(agentId, index, turn) =>
                  void discardRecoveredQueuedTurn(agentId, index, turn)
                }
              />
            ) : null}
            {agent ? (
              <NativeInput
                pane={surface.pane}
                agent={agent}
                draft={surface.draft}
                queuedTurns={surface.queuedTurns}
                waitTargets={surface.waitTargets}
                collapsedQueuedTurns={surface.collapsedQueuedTurns}
                queueSplit={queueSplit}
                requireCmdEnterToSend={settings.requireCmdEnterToSend}
                pasteProtection={pasteProtection}
                transcriptText={surface.transcript}
                transcriptCopyText={() =>
                  formatTranscriptCopyJson({
                    agent,
                    pane: surface.pane,
                    transcriptText: surface.transcript,
                    turns: surface.turns,
                    hooks: surface.hookEvents,
                  })
                }
                composerPolicy={getAgentUiAdapter(agent.adapter).composerPolicy(agent)}
                shortcutLabelForPane={shortcutLabelForPaneId}
                onQueueChange={setAgentQueuedTurns}
                onDraftChange={setAgentDraft}
                onQueuedTurnCollapseToggle={toggleQueuedTurnCollapsed}
                onWaitTargetHover={setWaitTargetHoverAgentId}
                onTurnSubmitted={(agentId, text, mode) => {
                  // Show "Working…" the instant a send starts a run, before the
                  // backend's status event round-trips. Gate on the agent being
                  // ready to receive (a plain send): queued turns don't start work,
                  // and an already-running agent is marked by its live status
                  // events instead. Send Now keeps the live indicator lit with a
                  // more precise label until the transcript catches the new turn.
                  const policy = getAgentUiAdapter(agent.adapter).composerPolicy(agent);
                  const shouldShowWorking =
                    mode === "steer" ||
                    (mode === "send" && policy.readyStatuses.includes(agent.status));
                  if (agent.id === agentId && shouldShowWorking) {
                    setThinkingAgentIds((prev) =>
                      prev.has(agentId) ? prev : new Set(prev).add(agentId),
                    );
                  }
                  if (agent.id === agentId && mode === "steer") {
                    const baselineUserTurnId = latestUserTurnId(surface.turns);
                    setProcessingNewMessageByAgent((current) =>
                      current[agentId] === baselineUserTurnId
                        ? current
                        : { ...current, [agentId]: baselineUserTurnId },
                    );
                  }
                  applyPendingFirstMessageTitle(agentId, text);
                }}
                onUserInput={noteUserInput}
                getQueueScroll={getQueueScroll}
                saveQueueScroll={saveQueueScroll}
                onError={setError}
              />
            ) : null}
          </div>
        }
      />
    );
  }

  return (
    <main
      ref={appRef}
      className={`app-shell ${hasGlobalTurnSidebar ? "has-turn-sidebar" : ""}${
        activeTranscriptVisibleExpanded ? " has-expanded-transcript" : ""
      }${settings.reduceMotion ? " reduce-motion" : ""}`}
      style={appStyle}
    >
      <aside
        className={`sidebar${sidebarWidth < LEFT_SIDEBAR_COMPACT_WIDTH ? " is-narrow" : ""}${
          settings.codeMode ? " is-code-mode" : ""
        }`}
      >
        <div className="titlebar-drag" data-tauri-drag-region aria-hidden="true" />
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={maxSidebarWidth()}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
        />
        <nav
          ref={paneListRef}
          className={`pane-list${draggingPaneId || draggingGroupId ? " is-dragging" : ""}`}
          aria-label="Panes"
        >
          {/* Fixed Home tab: not a real pane, so it can't be closed, reordered, or
              nested. Selecting it shows the empty content placeholder (the launcher). */}
          <div
            className={`pane-tab-row pane-home-row${homeActive ? " is-selected" : ""}`}
            data-home-tab="true"
            onClick={() => setActivePaneId(HOME_TAB_ID)}
          >
            <button
              type="button"
              className="pane-tab"
              aria-current={homeActive ? "page" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setActivePaneId(HOME_TAB_ID);
              }}
            >
              <House size={12} aria-hidden="true" />
              <span className="pane-tab-title">Home</span>
            </button>
            {shortcutHintsShown ? (
              <span className="pane-tab-shortcut-hint" aria-hidden="true">
                ⌘N
              </span>
            ) : null}
          </div>
          {groups.map((group, groupIndex) => {
            const groupPanes = panes.filter((pane) => pane.groupId === group.id);
            const hasGroupPanes = groupPanes.length > 0;
            const isActiveGroup = activePane?.groupId === group.id;
            const isCollapsedGroup = group.collapsed;
            const groupDisplayName = displayGroupName(group);
            const groupDropGap = groupDropTarget?.index ?? null;
            const collapsedStatusAgents = isCollapsedGroup
              ? collapsedGroupStatusAgents(groupPanes)
              : [];
            return (
              <section
                key={group.id}
                className={`pane-group${hasGroupPanes ? " has-panes" : ""}${
                  isActiveGroup ? " is-active-group" : ""
                }${isCollapsedGroup ? " is-collapsed" : ""}${
                  draggingGroupId === group.id ? " is-group-dragging" : ""
                }${groupDropGap === groupIndex ? " is-group-drop-before" : ""}${
                  groupDropGap === groups.length && groupIndex === groups.length - 1
                    ? " is-group-drop-after"
                    : ""
                }`}
                data-group-id={group.id}
                onContextMenu={(event) => openGroupMenu(event, group)}
              >
                <div
                  className="pane-group-header"
                  title={group.dir}
                  onPointerDown={(event) => handleGroupHeaderPointerDown(event, group.id)}
                  onPointerMove={handleGroupHeaderPointerMove}
                  onPointerUp={handleGroupHeaderPointerUp}
                  onPointerCancel={handleGroupHeaderPointerCancel}
                >
                  <span className="pane-group-title">
                    <Folder className="pane-group-folder" size={13} aria-hidden="true" />
                    <span
                      className="pane-group-name"
                      title={groupDisplayName}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openGroupRenameDialog(group);
                      }}
                    >
                      {groupDisplayName}
                    </span>
                    {isCollapsedGroup ? (
                      <span className="pane-group-count">{groupPanes.length}</span>
                    ) : null}
                    {collapsedStatusAgents.length > 0 ? (
                      <span
                        className="pane-group-status-icons"
                        role="img"
                        aria-label={collapsedStatusAgents
                          .map(collapsedGroupStatusLabel)
                          .join(", ")}
                      >
                        {collapsedStatusAgents.map((agent) => {
                          const statusTone = agentStatusTone(agent.status);
                          const statusClass =
                            agent.status === "awaitingInput" ? " status-awaiting-input" : "";
                          return (
                            <span
                              key={agent.id}
                              className={`pane-tab-dot status-${statusTone}${statusClass}`}
                              title={collapsedGroupStatusLabel(agent)}
                              aria-hidden="true"
                            />
                          );
                        })}
                      </span>
                    ) : null}
                  </span>
                  <span className="pane-group-aux">
                    <button
                      type="button"
                      className="pane-group-collapse-button"
                      aria-label={`${isCollapsedGroup ? "Expand" : "Collapse"} ${groupDisplayName}`}
                      title={isCollapsedGroup ? "Expand group" : "Collapse group"}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void toggleGroupCollapsed(group);
                      }}
                    >
                      {isCollapsedGroup ? (
                        <ChevronsUpDown size={14} aria-hidden="true" />
                      ) : (
                        <ChevronsDownUp size={14} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="pane-group-menu-button"
                      aria-label={`Group options for ${groupDisplayName}`}
                      aria-haspopup="menu"
                      aria-expanded={groupMenu?.groupId === group.id ? true : undefined}
                      title="Group options"
                      onMouseDown={(event) => {
                        if (event.button !== 0) {
                          return;
                        }
                        suppressGroupMenuButtonClickRef.current = true;
                        toggleGroupMenuFromButton(event, group);
                      }}
                      onClick={(event) => {
                        if (suppressGroupMenuButtonClickRef.current) {
                          suppressGroupMenuButtonClickRef.current = false;
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        toggleGroupMenuFromButton(event, group);
                      }}
                    >
                      <MoreHorizontal size={14} aria-hidden="true" />
                    </button>
                  </span>
                </div>
                {!hasGroupPanes || isCollapsedGroup ? null : (
                  <div className="pane-list-body">
                    {groupPanes.map((pane, index) =>
                      renderPaneTabRow(pane, index, groupPanes, group.id),
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </nav>

        <div className={`sidebar-actions${settings.codeMode ? "" : " is-agent-only"}`}>
          {settings.codeMode ? (
            <div className="sidebar-action-with-hint">
              <button type="button" onClick={addShellPane}>
                <SquareTerminal size={14} aria-hidden="true" />
                <span>New shell</span>
              </button>
              {shortcutHintsShown ? (
                <span
                  className="pane-tab-shortcut-hint sidebar-action-shortcut-hint"
                  aria-hidden="true"
                >
                  ⌘T
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="sidebar-action-with-hint">
            <button type="button" onClick={openAgentLauncher}>
              <MessageSquareText size={14} aria-hidden="true" />
              <span>New agent</span>
            </button>
            {shortcutHintsShown ? (
              <span
                className="pane-tab-shortcut-hint sidebar-action-shortcut-hint"
                aria-hidden="true"
              >
                {settings.codeMode ? "⌘;" : "⌘; / ⌘T"}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="sidebar-settings-button"
            aria-label="Settings menu"
            aria-haspopup="menu"
            aria-expanded={settingsMenu ? true : undefined}
            title="Settings menu"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={toggleSettingsMenuFromButton}
          >
            <Settings size={14} aria-hidden="true" />
          </button>
        </div>
      </aside>

      {settingsMenu ? (
        <div
          className="pane-context-menu settings-context-menu"
          role="menu"
          aria-label="Settings menu"
          style={{ left: settingsMenu.x, top: settingsMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="group-context-actions">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void createGroupFromSettingsMenu();
              }}
            >
              <Plus size={13} aria-hidden="true" />
              <span>New Group</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSettingsMenu(null);
                setSettingsOpen(true);
              }}
            >
              <Settings size={13} aria-hidden="true" />
              <span>Settings</span>
            </button>
          </div>
        </div>
      ) : null}

      {groupMenu && groupMenuGroup ? (
        <div
          className="pane-context-menu group-context-menu"
          role="menu"
          aria-label="Group options"
          style={{ left: groupMenu.x, top: groupMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="group-context-actions">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setGroupMenu(null);
                void changeGroupDirectory(groupMenuGroup.id);
              }}
            >
              <Folder size={13} aria-hidden="true" />
              <span>Change directory</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-has-shortcut"
              onClick={() => {
                setGroupMenu(null);
                openGroupRenameDialog(groupMenuGroup);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
              <span>Rename group</span>
              <kbd className="context-menu-shortcut">R</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-has-shortcut"
              onClick={() => {
                void toggleGroupCollapsed(groupMenuGroup);
              }}
            >
              {groupMenuGroup.collapsed ? (
                <ChevronsUpDown size={13} aria-hidden="true" />
              ) : (
                <ChevronsDownUp size={13} aria-hidden="true" />
              )}
              <span>{groupMenuGroup.collapsed ? "Expand group" : "Collapse group"}</span>
              <kbd className="context-menu-shortcut">
                {groupMenuGroup.collapsed ? "C/E" : "C"}
              </kbd>
            </button>
            <div className="context-menu-divider" role="separator" />
            {settings.codeMode ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setGroupMenu(null);
                  void addShellPaneInGroup(groupMenuGroup.id);
                }}
              >
                <SquareTerminal size={13} aria-hidden="true" />
                <span>New shell</span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setGroupMenu(null);
                setActivePaneId(HOME_TAB_ID);
                setLastActiveGroupId(groupMenuGroup.id);
                setLauncherOpen(true);
              }}
            >
              <MessageSquareText size={13} aria-hidden="true" />
              <span>New agent</span>
            </button>
            <div className="context-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              disabled={folderPickerStatus !== null}
              onClick={() => {
                setGroupMenu(null);
                void createGroupAfterWithFolder(groupMenuGroup);
              }}
            >
              <Plus size={13} aria-hidden="true" />
              <span>New group...</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-danger"
              onClick={() => {
                void requestCloseGroup(groupMenuGroup);
              }}
            >
              <X size={13} aria-hidden="true" />
              <span>Close group</span>
            </button>
          </div>
        </div>
      ) : null}

      {paneContextMenu && contextMenuPane ? (
        <div
          className="pane-context-menu"
          role="dialog"
          aria-label={`${contextMenuDisplayTitle} details`}
          style={{ left: paneContextMenu.x, top: paneContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <dl className="pane-context-details">
            {contextMenuAgent ? (
              <div
                className={`pane-context-status-row status-${agentStatusTone(contextMenuAgent.status)}`}
              >
                <dt>Agent</dt>
                <dd>
                  {agentStatusLabel(contextMenuAgent.status) ?? "Idle"}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Tab</dt>
              <dd>{contextMenuDisplayTitle}</dd>
            </div>
            {contextMenuTerminalTitle && contextMenuTerminalTitle !== contextMenuDisplayTitle ? (
              <div>
                <dt>Terminal title</dt>
                <dd>{contextMenuTerminalTitle}</dd>
              </div>
            ) : null}
            {contextMenuAgent?.branch ? (
              <div>
                <dt>Branch</dt>
                <dd>{contextMenuAgent.branch}</dd>
              </div>
            ) : null}
            {contextMenuAgent?.branch && contextMenuAgent.worktreeDir ? (
              <div>
                <dt>Worktree</dt>
                <dd>{contextMenuAgent.worktreeDir}</dd>
              </div>
            ) : null}
            <div>
              <dt>Directory</dt>
              <dd>{contextMenuPane.cwd}</dd>
            </div>
          </dl>
          <div className="pane-context-actions" role="menu" aria-label="Tab actions">
            <button
              type="button"
              role="menuitem"
              className="context-menu-has-shortcut"
              title="Create a new shell split below this tab"
              onClick={() => {
                setPaneContextMenu(null);
                void splitPaneBelow(contextMenuPane);
              }}
            >
              <PanelBottomClose size={13} aria-hidden="true" />
              <span>
                {contextMenuPaneHasSplit ? "Add split to current terminal" : "Split terminal"}
              </span>
              <kbd className="context-menu-shortcut">⌘D</kbd>
            </button>
            {canJoinContextMenuBelow && contextMenuAdjacentBelow ? (
              <button
                type="button"
                role="menuitem"
                title="Show this tab and the next tab in one vertical split"
                onClick={() => {
                  setPaneContextMenu(null);
                  joinPaneBelow(contextMenuPane, contextMenuAdjacentBelow);
                }}
              >
                <PanelBottomClose size={13} aria-hidden="true" />
                <span>Join with terminal below</span>
              </button>
            ) : null}
            {contextMenuPaneSplit ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setPaneContextMenu(null);
                  removePaneFromSplit(contextMenuPane);
                }}
              >
                <PanelBottomOpen size={13} aria-hidden="true" />
                <span>Detach from split</span>
              </button>
            ) : null}
            <div className="context-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              disabled={!canOutdent(contextMenuGroupPanes, contextMenuPaneIndex)}
              onClick={() => {
                outdentContextMenuPane();
                setPaneContextMenu(null);
              }}
            >
              <SquareChevronLeft size={13} aria-hidden="true" />
              <span>Outdent</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canIndent(contextMenuGroupPanes, contextMenuPaneIndex)}
              onClick={() => {
                indentContextMenuPane();
                setPaneContextMenu(null);
              }}
            >
              <SquareChevronRight size={13} aria-hidden="true" />
              <span>Indent</span>
            </button>
            <div className="context-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="context-menu-danger"
              aria-label={`Close ${contextMenuDisplayTitle}`}
              title={`Close ${contextMenuDisplayTitle}`}
              onClick={() => {
                setPaneContextMenu(null);
                void requestClosePane(contextMenuPane, { confirmAlways: true });
              }}
            >
              <X size={13} aria-hidden="true" />
              <span>Close tab</span>
            </button>
          </div>
        </div>
      ) : null}

      {launcherOpen ? (
        <div
          className="command-launcher-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setLauncherOpen(false);
            }
          }}
        >
          {renderLauncher("modal")}
        </div>
      ) : null}

      {askLauncher ? (
        <div
          className="command-launcher-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeAskLauncher();
            }
          }}
        >
          {renderAskLauncher(askLauncher)}
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
            }
          }}
        >
          <div
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-header">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="settings-close"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="settings-tabs" role="tablist" aria-label="Settings sections">
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === "basic"}
                className={settingsTab === "basic" ? "is-active" : ""}
                onClick={() => setSettingsTab("basic")}
              >
                Basic
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === "advanced"}
                className={settingsTab === "advanced" ? "is-active" : ""}
                onClick={() => setSettingsTab("advanced")}
              >
                Advanced
              </button>
            </div>

            {settingsTab === "basic" ? (
              <div className="settings-content" role="tabpanel">
            <div className="settings-row">
              <label htmlFor="settings-font" className="settings-label">
                Font
              </label>
              <select
                id="settings-font"
                className="settings-select"
                value={settings.fontId}
                onChange={(event) => {
                  // Read the value synchronously: the setSettings updater runs
                  // during render, by which point React has reset currentTarget
                  // to null, so it must close over the value, not the event.
                  const fontId = event.currentTarget.value;
                  setSettings((current) => ({ ...current, fontId }));
                }}
              >
                {FONT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <span className="settings-label">Font size</span>
              <div className="settings-stepper" role="group" aria-label="Font size">
                <button
                  type="button"
                  aria-label="Decrease font size"
                  disabled={settings.fontSize <= TERMINAL_FONT_SIZE_MIN}
                  onClick={() =>
                    setSettings((current) => ({
                      ...current,
                      fontSize: clampFontSize(current.fontSize - 1),
                    }))
                  }
                >
                  <Minus size={14} aria-hidden="true" />
                </button>
                <span className="settings-stepper-value">{settings.fontSize}px</span>
                <button
                  type="button"
                  aria-label="Increase font size"
                  disabled={settings.fontSize >= TERMINAL_FONT_SIZE_MAX}
                  onClick={() =>
                    setSettings((current) => ({
                      ...current,
                      fontSize: clampFontSize(current.fontSize + 1),
                    }))
                  }
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="settings-divider" role="separator" />

            <label className="settings-row settings-toggle">
              <span className="settings-label">Use login shell</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.useLoginShell}
                onChange={(event) => {
                  // Capture before the updater: see the font select above, where
                  // currentTarget is nulled out by the time the updater runs.
                  const useLoginShell = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, useLoginShell }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label">Code mode</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.codeMode}
                onChange={(event) => {
                  const codeMode = event.currentTarget.checked;
                  setSettings((current) => ({
                    ...current,
                    codeMode,
                    showTabDirectories: codeMode,
                    showToolCalls: codeMode,
                    requireCmdEnterToSend: codeMode,
                  }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label settings-label-indented">Show tab directories</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.showTabDirectories}
                onChange={(event) => {
                  const showTabDirectories = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, showTabDirectories }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label settings-label-indented">Show tool calls</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.showToolCalls}
                onChange={(event) => {
                  const showToolCalls = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, showToolCalls }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label settings-label-indented">
                Require ⌘↵ to send
              </span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.requireCmdEnterToSend}
                onChange={(event) => {
                  const requireCmdEnterToSend = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, requireCmdEnterToSend }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label">Keep awake while agents run (&gt;10% battery)</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.preventSleep}
                onChange={(event) => {
                  // See the font select above: capture before the updater, which
                  // runs after currentTarget has been nulled out.
                  const preventSleep = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, preventSleep }));
                }}
              />
            </label>

            <div className="settings-row settings-shortcut-row">
              <label htmlFor="settings-show-hide-shortcut" className="settings-label">
                Show/hide app shortcut
              </label>
              <div className="settings-shortcut-control">
                <input
                  id="settings-show-hide-shortcut"
                  className="settings-input settings-shortcut-input"
                  data-shortcut-capture="show-hide"
                  value={showHideShortcutValue}
                  placeholder="e.g. Option+Space"
                  readOnly
                  aria-invalid={showHideShortcutMessage ? true : undefined}
                  aria-describedby={
                    showHideShortcutMessage ? "settings-show-hide-shortcut-message" : undefined
                  }
                  onFocus={() => setShowHideShortcutCapturing(true)}
                  onBlur={() => setShowHideShortcutCapturing(false)}
                  onKeyDown={captureShowHideShortcut}
                />
                {showHideShortcutValue ? (
                  <button
                    type="button"
                    className="settings-link-button"
                    disabled={showHideShortcutSaving}
                    onClick={clearShowHideShortcut}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>
            {showHideShortcutMessage || showHideShortcutSaving ? (
              <p
                id="settings-show-hide-shortcut-message"
                className={`settings-hint settings-shortcut-message${
                  showHideShortcutMessage ? " is-error" : ""
                }`}
              >
                {showHideShortcutSaving ? "Saving shortcut..." : showHideShortcutMessage}
              </p>
            ) : null}

            <label className="settings-row settings-toggle">
              <span className="settings-label">Show keyboard shortcut hints</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.showShortcutHints}
                onChange={(event) => {
                  const showShortcutHints = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, showShortcutHints }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label">Reduce motion</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.reduceMotion}
                onChange={(event) => {
                  const reduceMotion = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, reduceMotion }));
                }}
              />
            </label>

            <div className="settings-divider" role="separator" />

            <div className="settings-row">
              <label htmlFor="settings-tab-title-provider" className="settings-label">
                Generate tab titles
              </label>
              <select
                id="settings-tab-title-provider"
                className="settings-select"
                value={settings.tabTitleProvider}
                onChange={(event) => {
                  const tabTitleProvider =
                    event.currentTarget.value as AppSettings["tabTitleProvider"];
                  setSettings((current) => ({ ...current, tabTitleProvider }));
                }}
              >
                {TAB_TITLE_PROVIDER_OPTIONS.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={
                      option.id === "appleFoundationModels" && !appleFoundationTitleAvailable
                    }
                  >
                    {option.id === "appleFoundationModels" && !appleFoundationTitleAvailable
                      ? `${option.label} (unavailable)`
                      : option.label}
                  </option>
                ))}
              </select>
            </div>
            {!appleFoundationTitleAvailable ? (
              <p className="settings-hint">
                Apple Foundation Models are not available in this build.
              </p>
            ) : null}
            {settings.tabTitleProvider === "openRouter" ? (
              <>
                <p className="settings-hint">
                  Sends the first message of each new tab to OpenRouter to summarize a title.
                </p>

                <div className="settings-row">
                  <label htmlFor="settings-openrouter-key" className="settings-label">
                    OpenRouter key
                  </label>
                  <div className="settings-secret-input">
                    <input
                      id="settings-openrouter-key"
                      className="settings-input"
                      type={openRouterKeyVisible ? "text" : "password"}
                      value={settings.openRouterKey}
                      placeholder="sk-or-v1-..."
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        const openRouterKey = event.currentTarget.value;
                        setSettings((current) => ({ ...current, openRouterKey }));
                      }}
                    />
                    <button
                      type="button"
                      className="settings-secret-toggle"
                      aria-label={
                        openRouterKeyVisible ? "Hide OpenRouter key" : "Show OpenRouter key"
                      }
                      aria-pressed={openRouterKeyVisible}
                      onClick={() => setOpenRouterKeyVisible((visible) => !visible)}
                    >
                      {openRouterKeyVisible ? (
                        <EyeOff size={14} aria-hidden="true" />
                      ) : (
                        <Eye size={14} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <label htmlFor="settings-openrouter-model" className="settings-label">
                    OpenRouter model
                  </label>
                  <input
                    id="settings-openrouter-model"
                    className="settings-input"
                    type="text"
                    value={settings.openRouterModel}
                    placeholder="google/gemma-4-31b-it:free"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      const openRouterModel = event.currentTarget.value;
                      setSettings((current) => ({ ...current, openRouterModel }));
                    }}
                  />
                </div>
              </>
            ) : null}
            {titleGenerationTestVisible ? (
              <div className="settings-title-test">
                <div className="settings-row">
                  <span className="settings-label">Test title generation</span>
                  <button
                    type="button"
                    className="settings-test-button"
                    disabled={titleGenerationTestRunning}
                    aria-describedby={
                      titleGenerationTest ? "settings-title-test-message" : undefined
                    }
                    onClick={() => void testFirstMessageTitleGeneration()}
                  >
                    {titleGenerationTestRunning ? (
                      <LoaderCircle
                        className="settings-test-spinner"
                        size={14}
                        aria-hidden="true"
                      />
                    ) : (
                      <MessageSquareText size={14} aria-hidden="true" />
                    )}
                    {titleGenerationTestRunning ? "Testing..." : "Test title"}
                  </button>
                </div>
                {titleGenerationTest ? (
                  <p
                    id="settings-title-test-message"
                    className={`settings-hint settings-title-test-message is-${titleGenerationTest.status}`}
                  >
                    {titleGenerationTest.status === "running"
                      ? `${titleGenerationTest.providerLabel} is generating a title...`
                      : titleGenerationTest.status === "success"
                        ? `${titleGenerationTest.providerLabel}: "${titleGenerationTest.title}"`
                        : `${titleGenerationTest.providerLabel}: ${titleGenerationTest.message}`}
                  </p>
                ) : null}
              </div>
            ) : null}
              </div>
            ) : (
              <div className="settings-content" role="tabpanel">
                <label className="settings-row settings-toggle">
                  <span className="settings-label">Cursor blink</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.cursorBlink}
                    onChange={(event) => {
                      const cursorBlink = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, cursorBlink }));
                    }}
                  />
                </label>

                <div className="settings-row">
                  <label htmlFor="settings-cursor-style" className="settings-label">
                    Cursor style
                  </label>
                  <select
                    id="settings-cursor-style"
                    className="settings-select"
                    value={settings.cursorStyle}
                    onChange={(event) => {
                      const cursorStyle = event.currentTarget.value as AppSettings["cursorStyle"];
                      setSettings((current) => ({ ...current, cursorStyle }));
                    }}
                  >
                    {CURSOR_STYLE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-row">
                  <label htmlFor="settings-cursor-inactive-style" className="settings-label">
                    Cursor inactive style
                  </label>
                  <select
                    id="settings-cursor-inactive-style"
                    className="settings-select"
                    value={settings.cursorInactiveStyle}
                    onChange={(event) => {
                      const cursorInactiveStyle = event.currentTarget
                        .value as AppSettings["cursorInactiveStyle"];
                      setSettings((current) => ({ ...current, cursorInactiveStyle }));
                    }}
                  >
                    {CURSOR_INACTIVE_STYLE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-row">
                  <label htmlFor="settings-scrollback-rows" className="settings-label">
                    Scrollback rows
                  </label>
                  <input
                    id="settings-scrollback-rows"
                    className="settings-input settings-number-input"
                    type="number"
                    min={SCROLLBACK_ROWS_MIN}
                    max={SCROLLBACK_ROWS_MAX}
                    step={1000}
                    value={settings.scrollbackRows}
                    onChange={(event) => {
                      const scrollbackRows = clampScrollbackRows(
                        Number(event.currentTarget.value),
                      );
                      setSettings((current) => ({ ...current, scrollbackRows }));
                    }}
                  />
                </div>

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Scroll on user input</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.scrollOnUserInput}
                    onChange={(event) => {
                      const scrollOnUserInput = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, scrollOnUserInput }));
                    }}
                  />
                </label>

                <div className="settings-row">
                  <label htmlFor="settings-mouse-wheel-sensitivity" className="settings-label">
                    Mouse wheel sensitivity
                  </label>
                  <select
                    id="settings-mouse-wheel-sensitivity"
                    className="settings-select"
                    value={settings.mouseWheelSensitivity}
                    onChange={(event) => {
                      const mouseWheelSensitivity = event.currentTarget
                        .value as AppSettings["mouseWheelSensitivity"];
                      setSettings((current) => ({ ...current, mouseWheelSensitivity }));
                    }}
                  >
                    {MOUSE_WHEEL_SENSITIVITY_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-row">
                  <span className="settings-label">Scroll duration</span>
                  <div className="settings-stepper" role="group" aria-label="Scroll duration">
                    <button
                      type="button"
                      aria-label="Decrease scroll duration"
                      disabled={settings.scrollDurationMs <= SCROLL_DURATION_MS_MIN}
                      onClick={() =>
                        setSettings((current) => ({
                          ...current,
                          scrollDurationMs: clampScrollDurationMs(
                            current.scrollDurationMs - SCROLL_DURATION_MS_STEP,
                          ),
                        }))
                      }
                    >
                      <Minus size={14} aria-hidden="true" />
                    </button>
                    <span className="settings-stepper-value">{settings.scrollDurationMs}ms</span>
                    <button
                      type="button"
                      aria-label="Increase scroll duration"
                      disabled={settings.scrollDurationMs >= SCROLL_DURATION_MS_MAX}
                      onClick={() =>
                        setSettings((current) => ({
                          ...current,
                          scrollDurationMs: clampScrollDurationMs(
                            current.scrollDurationMs + SCROLL_DURATION_MS_STEP,
                          ),
                        }))
                      }
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <span className="settings-label">Line height</span>
                  <div className="settings-stepper" role="group" aria-label="Line height">
                    <button
                      type="button"
                      aria-label="Decrease line height"
                      disabled={settings.lineHeight <= LINE_HEIGHT_MIN}
                      onClick={() =>
                        setSettings((current) => ({
                          ...current,
                          lineHeight: clampLineHeight(current.lineHeight - LINE_HEIGHT_STEP),
                        }))
                      }
                    >
                      <Minus size={14} aria-hidden="true" />
                    </button>
                    <span className="settings-stepper-value">
                      {settings.lineHeight.toFixed(1)}x
                    </span>
                    <button
                      type="button"
                      aria-label="Increase line height"
                      disabled={settings.lineHeight >= LINE_HEIGHT_MAX}
                      onClick={() =>
                        setSettings((current) => ({
                          ...current,
                          lineHeight: clampLineHeight(current.lineHeight + LINE_HEIGHT_STEP),
                        }))
                      }
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Copy on select</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.copyOnSelect}
                    onChange={(event) => {
                      const copyOnSelect = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, copyOnSelect }));
                    }}
                  />
                </label>

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Selection clear on copy</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.selectionClearOnCopy}
                    onChange={(event) => {
                      const selectionClearOnCopy = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, selectionClearOnCopy }));
                    }}
                  />
                </label>

                <div className="settings-divider" role="separator" />

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Confirm multi-line paste</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.confirmMultiLinePaste}
                    onChange={(event) => {
                      const confirmMultiLinePaste = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, confirmMultiLinePaste }));
                    }}
                  />
                </label>

                <div className="settings-row">
                  <label htmlFor="settings-confirm-paste-over" className="settings-label">
                    Confirm paste over chars
                  </label>
                  <input
                    id="settings-confirm-paste-over"
                    className="settings-input settings-number-input"
                    type="number"
                    min={CONFIRM_PASTE_OVER_CHARS_MIN}
                    max={CONFIRM_PASTE_OVER_CHARS_MAX}
                    step={1000}
                    value={settings.confirmPasteOverChars}
                    onChange={(event) => {
                      const confirmPasteOverChars = clampConfirmPasteOverChars(
                        Number(event.currentTarget.value),
                      );
                      setSettings((current) => ({ ...current, confirmPasteOverChars }));
                    }}
                  />
                </div>

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Treat bracketed paste as safe</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.bracketedPasteSafe}
                    onChange={(event) => {
                      const bracketedPasteSafe = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, bracketedPasteSafe }));
                    }}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {closeDialog ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !resolvingClose) {
              setCloseDialog(null);
            }
          }}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-dialog-title"
          >
            <h2 id="close-dialog-title">
              {closeDialog.groupClose
                ? `Close ${closeDialog.groupClose.groupName}?`
                : `Close ${closeDialog.pane.title}?`}
            </h2>
            {closeDialog.groupClose ? (
              <p>
                Closing tab{" "}
                {closeDialog.groupClose.totalCount - closeDialog.groupClose.remainingPaneIds.length}{" "}
                of {closeDialog.groupClose.totalCount}: {closeDialog.pane.title}
              </p>
            ) : null}
            {closeDialog.kind === "worktree" ? (
              <>
                <p>
                  {closeDialog.busy
                    ? "The agent is still working — closing this tab will stop it."
                    : "Closing this tab will stop the agent."}
                </p>
                <p>
                  {closeDialog.hasChanges ? (
                    <span className="confirm-dialog-changes">
                      The worktree {formatPaneDir(closeDialog.worktreeDir)} has uncommitted changes
                      that will be lost if deleted.
                    </span>
                  ) : (
                    <>
                      The worktree {formatPaneDir(closeDialog.worktreeDir)} has no uncommitted
                      changes.
                    </>
                  )}{" "}
                  Delete the worktree?
                </p>
                <div className="confirm-dialog-actions">
                  <button
                    type="button"
                    disabled={resolvingClose !== null}
                    onClick={() => setCloseDialog(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={resolvingClose !== null}
                    onClick={() => void resolveCloseDialog("delete")}
                  >
                    {resolvingClose === "delete" ? "Deleting…" : "Delete worktree"}
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    autoFocus
                    disabled={resolvingClose !== null}
                    onClick={() => void resolveCloseDialog("keep")}
                  >
                    {resolvingClose === "keep" ? "Closing…" : "Keep worktree"}
                  </button>
                </div>
              </>
            ) : closeDialog.kind === "stop" ? (
              <>
                <p>This agent {closeDialog.reason}. Close the pane and stop it?</p>
                <div className="confirm-dialog-actions">
                  <button type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="danger"
                    autoFocus
                    onClick={() => void confirmStopAndClose()}
                  >
                    Close pane
                  </button>
                </div>
              </>
            ) : closeDialog.kind === "runningProcess" ? (
              <>
                <p>
                  {closeDialog.processCount === 1
                    ? closeDialog.processSummary
                      ? `This tab has a running process: ${closeDialog.processSummary}.`
                      : "This tab has a running process."
                    : closeDialog.processSummary
                      ? `This tab has ${closeDialog.processCount} running processes, including ${closeDialog.processSummary}.`
                      : `This tab has ${closeDialog.processCount} running processes.`}
                </p>
                <p>Closing this tab will terminate running processes in it.</p>
                <div className="confirm-dialog-actions">
                  <button type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="danger"
                    autoFocus
                    onClick={() => void confirmPaneClose()}
                  >
                    Close tab
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Close this tab?</p>
                <div className="confirm-dialog-actions">
                  <button type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="danger"
                    autoFocus
                    onClick={() => void confirmPaneClose()}
                  >
                    Close tab
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {exitDialog ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setExitDialog(null);
            }
          }}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exit-dialog-title"
          >
            <h2 id="exit-dialog-title">Quit qmux?</h2>
            <p>
              Quitting will close{" "}
              {exitDialog.paneCount === 1 ? "the open tab" : `all ${exitDialog.paneCount} tabs`}{" "}
              and stop any running agents or processes.
            </p>
            <div className="confirm-dialog-actions">
              <button type="button" onClick={() => setExitDialog(null)}>
                Cancel
              </button>
              <button
                ref={exitConfirmButtonRef}
                type="button"
                className="danger"
                autoFocus
                onClick={() => void confirmExit()}
              >
                Quit qmux
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renamePaneId || renameGroupId ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeRenameDialog();
            }
          }}
        >
          <form
            className="confirm-dialog rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <h2 id="rename-dialog-title">{renameGroupId ? "Rename group" : "Rename tab"}</h2>
            <input
              ref={renameInputRef}
              className="rename-dialog-input"
              value={renameValue}
              onChange={(event) => setRenameValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeRenameDialog();
                }
              }}
              aria-label={renameGroupId ? "Group name" : "Tab name"}
            />
            <div className="confirm-dialog-actions">
              <button type="button" onClick={closeRenameDialog}>
                Cancel
              </button>
              <button type="submit">Rename</button>
            </div>
          </form>
        </div>
      ) : null}

      <section className="workspace">
        {error ? (
          <div className="error-banner" role="alert" aria-live="assertive">
            {error}
          </div>
        ) : null}

        <div ref={terminalStageRef} className="terminal-stage">
          {homeActive && !launcherOpen ? (
            <div className="terminal-empty-state">
              <div className="home-launcher">{renderLauncher("inline")}</div>
            </div>
          ) : null}
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              ref={terminalPaneRefCallback(pane.id)}
              pane={pane}
              visible={visibleTerminalPaneIdSet.has(pane.id)}
              active={pane.id === activePane?.id}
              style={terminalPaneStyle(pane.id)}
              fontSize={terminalFontSize}
              fontFamily={terminalFontFamily}
              letterSpacing={terminalLetterSpacing}
              cursorBlink={settings.cursorBlink}
              cursorStyle={settings.cursorStyle}
              cursorInactiveStyle={settings.cursorInactiveStyle}
              scrollbackRows={settings.scrollbackRows}
              scrollOnUserInput={settings.scrollOnUserInput}
              scrollSensitivity={terminalScrollSensitivity}
              scrollDurationMs={settings.scrollDurationMs}
              lineHeight={settings.lineHeight}
              copyOnSelect={settings.copyOnSelect}
              selectionClearOnCopy={settings.selectionClearOnCopy}
              pasteProtection={pasteProtection}
              inputBlocked={settingsOpen}
              requestAttach={requestPaneAttach}
              onUserInput={noteUserInput}
              onOpenLink={openPaneLink}
              onLinkContextMenu={openPaneLinkMenu}
              onAskSelection={handleTerminalAskSelection}
              onSelectionCopied={handleTerminalSelectionCopied}
              onTerminalTitleChange={handleTerminalTitleChange}
              onActivate={activateTerminalPane}
            />
          ))}
          {terminalSplitDropStyle ? (
            <div
              className="terminal-split-drop-placeholder"
              style={terminalSplitDropStyle}
              aria-hidden="true"
            />
          ) : null}
          {activePaneSplit
            ? terminalSplitDividerOffsets.map((offset, index) => (
                <div
                  key={`${activePaneSplit.id}-${index}`}
                  className="terminal-split-resizer"
                  role="separator"
                  aria-label="Resize terminal split"
                  aria-orientation="horizontal"
                  tabIndex={0}
                  style={{ top: `${offset * 100}%` }}
                  onPointerDown={(event) =>
                    startTerminalSplitResize(event, activePaneSplit, index)
                  }
                  onKeyDown={(event) =>
                    resizeTerminalSplitWithKeyboard(event, activePaneSplit, index)
                  }
                />
              ))
            : null}
          {!activeTranscriptVisibleExpanded && splitRightPaneMode && hasVisibleRightBar
            ? visibleRightBarSurfaces.map((surface) => (
                <section
                  key={surface.pane.id}
                  className={`turn-pane turn-pane-split-cell${
                    surface.pane.id === activePane?.id ? " is-active" : ""
                  }`}
                  style={turnPaneSplitCellStyle(surface)}
                  onPointerDownCapture={() => activateTerminalPane(surface.pane.id)}
                  onFocusCapture={() => activateTerminalPane(surface.pane.id)}
                >
                  {renderTurnPaneResizer()}
                  {renderTurnPaneSurface(surface, false)}
                  {renderFloatingTurnPaneControls(surface)}
                </section>
              ))
            : null}
          {!activeTranscriptVisibleExpanded && splitRightPaneMode && hasVisibleRightBar
            ? terminalSplitDividerOffsets.map((offset, index) => (
                <div
                  key={`turn-${activePaneSplit?.id ?? "split"}-${index}`}
                  className="turn-pane-split-divider turn-pane-inline-split-divider"
                  style={{ top: `${offset * 100}%` }}
                  aria-hidden="true"
                />
              ))
            : null}
        </div>
      </section>

      {hasVisibleRightBar && activeTranscriptVisibleExpanded && activeTurnPaneSurface ? (
        <aside
          className={`turn-pane is-expanded${splitRightPaneMode ? " is-headerless-expanded" : ""}`}
        >
          {renderTurnPaneSurface(activeTurnPaneSurface, !splitRightPaneMode)}
          {splitRightPaneMode ? renderFloatingTurnPaneControls(activeTurnPaneSurface) : null}
        </aside>
      ) : hasGlobalTurnSidebar && activeTurnPaneSurface ? (
        <aside className="turn-pane">
          {renderTurnPaneResizer()}
          {renderTurnPaneSurface(activeTurnPaneSurface, true)}
        </aside>
      ) : null}
      {renderFloatingRightBarRestoreButton()}

      {activePane && activeBrowserOverlay?.open ? (
        <BrowserOverlay
          url={activeBrowserOverlay.url}
          reloadNonce={activeBrowserOverlay.reloadNonce}
          sandbox={activeBrowserOverlay.sandbox}
          size={activeBrowserOverlay.size}
          toggleShortcutLabel={activePaneHasTurnPaneHeader ? null : EXPAND_TOGGLE_SHORTCUT_LABEL}
          onNavigate={navigateActiveBrowserOverlay}
          onRefresh={refreshActiveBrowserOverlay}
          onClose={toggleActiveBrowserOverlay}
          onResize={(size) => setBrowserOverlaySize(activePane.id, size)}
        />
      ) : null}
      {/* The floating toggle sits over the terminal only when the active tab has no
          visible right-pane header; otherwise the toggle lives in that header. */}
      {showFloatingBrowserControls ? (
        <BrowserOverlayControls
          open={false}
          shortcutLabel={EXPAND_TOGGLE_SHORTCUT_LABEL}
          onToggle={toggleActiveBrowserOverlay}
          onRefresh={refreshActiveBrowserOverlay}
        />
      ) : null}

      {linkMenu ? (
        <LinkContextMenu
          x={linkMenu.x}
          y={linkMenu.y}
          canOpenInternal={linkMenu.paneId !== null && canRenderInInternalBrowser(linkMenu.url)}
          onOpenInternal={() => {
            openLinkForPane(linkMenu.paneId, linkMenu.url);
            setLinkMenu(null);
          }}
          onOpenExternal={() => {
            void openExternalUrl(linkMenu.url);
            setLinkMenu(null);
          }}
          onClose={() => setLinkMenu(null)}
        />
      ) : null}

      {selectionAsk ? (
        <SelectionAskPopup
          anchor={selectionAsk.anchor}
          canAskNewThread={selectionAsk.canFork}
          // The transcript is a re-selection surface: a mousedown there keeps the popup
          // mounted so it glides to the next selection instead of flashing.
          reselectWithin=".turn-timeline"
          onAsk={() => openAskLauncher("ask")}
          onAskNewThread={() => openAskLauncher("newThread")}
          onClose={dismissSelectionAskSoon}
        />
      ) : null}

      {dictationDownload ? (
        <div className="dictation-download-toast" role="status" aria-live="polite">
          Loading voice model…
          {dictationDownload.total
            ? ` ${Math.round((dictationDownload.loaded / dictationDownload.total) * 100)}%`
            : ""}
        </div>
      ) : null}
      {appToast ? (
        <div
          className={`composer-toast app-toast${appToast.tone === "warning" ? " is-warning" : ""}`}
          role="status"
          aria-live="polite"
        >
          {appToast.message}
        </div>
      ) : null}
      {folderPickerStatus ? (
        <div className="folder-picker-status" role="status" aria-live="polite">
          <LoaderCircle size={14} aria-hidden="true" />
          <span>{folderPickerStatus}</span>
        </div>
      ) : null}
    </main>
  );
}
