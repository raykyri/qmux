import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Expand,
  FileText,
  FileUp,
  Folder,
  Globe,
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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { agentUiAdapters, findAgentUiAdapter, getAgentUiAdapter } from "./adapters";
import { CLAUDE_ADAPTER_ID } from "./adapters/claude";
import { CODEX_ADAPTER_ID } from "./adapters/codex";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "./lib/adapterIcons";
import CommandPalette, { type PaletteCommand } from "./components/CommandPalette";
import GlobalTaskLauncher from "./components/GlobalTaskLauncher";
import NativeInput from "./components/NativeInput";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "./components/ComposerSubmitShortcut";
import { LauncherSelect } from "./components/LauncherSelect";
import type { LauncherSelectOption } from "./components/LauncherSelect";
import BrowserOverlay from "./components/BrowserOverlay";
import ConfirmDialogActionButton from "./components/ConfirmDialogActionButton";
import HomeCascades from "./components/HomeCascades";
import type { HomeCascadeWorkstream } from "./components/HomeCascades";
import LinkContextMenu from "./components/LinkContextMenu";
import PublishDialog, { type PublishDialogTarget } from "./components/PublishDialog";
import SidebarModeToggle from "./components/SidebarModeToggle";
import TerminalPane from "./components/TerminalPane";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import TurnOverlay, { formatTurnsTranscript } from "./components/TurnOverlay";
import TurnPaneHeader from "./components/TurnPaneHeader";
import type { LinkActions } from "./components/TranscriptMarkdown";
import RecoveredQueuePanel from "./components/RecoveredQueuePanel";
import ResearchSidebarSection, {
  type ResearchVisibilityFilter,
} from "./components/research/ResearchSidebarSection";
import ResearchFolderSwitcher from "./components/research/ResearchFolderSwitcher";
import {
  nextTreeInResearchScope,
  resolveResearchScope,
  treeForResearchScope,
  treesForResearchScope,
  type ResearchFolderScope,
  workspaceIsInResearchScope,
} from "./lib/researchScope";
import ResearchDocument from "./components/research/ResearchDocument";
import NewDocumentDialog from "./components/research/NewDocumentDialog";
import NewResearchDialog from "./components/research/NewResearchDialog";
import { isMarkdownDocumentPath } from "./lib/researchDocuments";
import {
  moveResearchTreeIdBy,
  replaceResearchTreeScopeOrder,
} from "./lib/researchOrder";
import type { OrphanedQueueGroup } from "./components/RecoveredQueuePanel";
import {
  agentStatusLabel,
  agentCanFork,
  agentStatusTone,
  clamp,
  cycleTabId,
  formatTranscriptCopyJson,
  isEditableTarget,
  IS_MAC,
  isTerminalTarget,
  measureTerminalCellSize,
  selectPaneAfterClose,
  statusLabel,
} from "./lib/appHelpers";
import { desiredNativeTerminalKeyboardOwner } from "./lib/nativeTerminalKeyboard";
import {
  appShortcutAllowsRepeat,
  appShortcutTargetsActivePane,
  contextualizeAppShortcut,
  resolveAppShortcut,
  showHideShortcutConflict,
  type AppShortcutCommand,
} from "./lib/appShortcuts";
import { requestComposerInsert } from "./lib/promptLibrary";
import {
  buildSingleAgentThreadGraph,
  focusedBranchTurns,
  pendingGraphOverlayTurns,
  threadIdForAgent,
} from "./lib/threadGraph";
import { formatPlainTextTranscript } from "./lib/turnTimeline";
import { createTranscriptPublicationDraft } from "./lib/publicationDrafts";
import type { PublicationBinding } from "./lib/publication";
import { useNativeWebOverlayRegion } from "./hooks/useNativeWebOverlayRegion";
import { useQmuxEvents } from "./hooks/useQmuxEvents";
import type {
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
} from "./appTypes";
import {
  canIndent,
  canOutdent,
  indentAt,
  isLeafPane,
  movePaneAfterSubtree,
  movePanePromotingChildrenAdjacentToPane,
  movePaneSubtreeBy,
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
import { canRenderInInternalBrowser, isFileServerUrl } from "./lib/links";
import {
  isResearchTreeSelectionChange,
  pruneResearchNavigation,
} from "./lib/researchNavigation";
import {
  groupsForScope,
  panesForScope,
  researchAttention,
  replaceScopedGroupOrder,
} from "./lib/workspaceScope";
import {
  parseSidebarMode,
  researchCycleTabIds,
  researchTreeIdFromTabId,
  researchTreeTabId,
  SIDEBAR_MODE_STORAGE_KEY,
  terminalTabForMode,
  type SidebarMode,
} from "./lib/sidebarMode";
import { stripTaggedUserInstructionBlocks } from "./lib/taggedInstructions";
import {
  bodyFontStackFor,
  clampConfirmPasteOverChars,
  clampFontSize,
  clampLineHeight,
  clampScrollbackRows,
  COLOR_THEME_OPTIONS,
  CONFIRM_PASTE_OVER_CHARS_MAX,
  CONFIRM_PASTE_OVER_CHARS_MIN,
  CURSOR_STYLE_OPTIONS,
  DEFAULT_THEME_ID,
  DEFAULT_BODY_FONT_ID,
  detectAvailableBodyFonts,
  FONT_OPTIONS,
  fontStackFor,
  nativeFontFamilyFor,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_STEP,
  letterSpacingFor,
  loadSettings,
  MOUSE_WHEEL_SENSITIVITY_OPTIONS,
  pasteProtectionFor,
  saveSettings,
  SCROLLBACK_ROWS_MAX,
  SCROLLBACK_ROWS_MIN,
  scrollSensitivityFor,
  SYSTEM_BODY_FONT_ID,
  TAB_TITLE_PROVIDER_OPTIONS,
  WORKTREE_LOCATION_OPTIONS,
  type AppSettings,
  type BodyFontOption,
} from "./lib/settings";
import {
  acknowledgeAgent,
  attachPane,
  claimNativeTerminalPointerForWebDrag,
  clearAgentWorkingStatus,
  closeWorktreePane,
  confirmAppExit,
  createGroupWithFolder,
  createResearchWorkspaceWithFolder,
  renameResearchWorkspace,
  moveResearchWorkspaceWithFolder,
  removeResearchWorkspace,
  revealResearchWorkspace,
  ensureDefaultResearchWorkspace,
  archiveResearchTree,
  cancelResearchNode,
  createResearchDocument,
  createResearchTree,
  updateResearchDocument,
  forkResearchNode,
  markResearchTreeViewed,
  renameResearchNode,
  renameResearchTree,
  reorderResearchTrees,
  removeResearchTree,
  removeResearchBranch,
  restoreResearchTree,
  forkAgent,
  getActiveTab,
  getPaneSplits,
  getLauncherAdapterPreference,
  getOpenRouterKey,
  setOpenRouterKey,
  openRouterChatCompletion,
  getAgentDraft,
  getGlobalTaskLauncherHotkey,
  openGlobalTaskLauncher,
  getShowHideShortcut,
  activatePane,
  getRuntimeConfig,
  getUseLoginShell,
  getWorktreeLocation,
  generateFoundationTabTitle,
  killPane,
  listenToMenuBarSelectPane,
  listGroups,
  listAgents,
  listShellAgentJobs,
  listClaudeSkills,
  listNativeTerminalThemes,
  listSavedPrompts,
  listAgentTranscripts,
  listAgentTurnQueue,
  listThreadGraphs,
  listTurns,
  listPanes,
  listPublications,
  listResearchActivity,
  listResearchTrees,
  getResearchTree,
  markAppWindowReady,
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
  readMarkdownDocumentFile,
  restoreLastClosedPane,
  seedNativeTerminalSettings,
  setLauncherAdapterPreference,
  setActiveTab,
  setGroupCollapsed,
  setNativeTerminalKeyboardOwner,
  setNativeTerminalStageBackstop,
  setPaneLayout,
  setPaneSplits as persistPaneSplits,
  setAgentDraft as persistAgentDraft,
  setAgentTranscript,
  setAgentTyping,
  setGlobalTaskLauncherHotkey,
  setShowHideShortcut,
  setShowHideShortcutCaptureActive,
  setPreventSleep,
  setUseLoginShell,
  setWorktreeLocation,
  spawnAgent,
  spawnShell,
  submitAgentTurn,
  updateMenuBar,
  worktreeStatus,
} from "./lib/api";
import type {
  AgentInfo,
  ClaudeSkill,
  GlobalTaskLauncherHotkey,
  GlobalTaskLauncherSetting,
  GroupInfo,
  InitialPaneSize,
  PaneInfo,
  PaneSplitInfo,
  QueuedTurn,
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
  RuntimeConfig,
  SavedPrompt,
  ShellAgentJobInfo,
  ThreadGraph,
  TranscriptHookEvent,
  TranscriptOption,
  Turn,
  WaitTarget,
} from "./types";
import type { NativeTerminalTheme, ShowHideShortcutSetting } from "./lib/api";
import type { MenuBarSnapshot, MenuBarStatusTone } from "./lib/api";

const LEFT_SIDEBAR_DEFAULT_WIDTH = 268;
const LEFT_SIDEBAR_MIN_WIDTH = 208;
const LEFT_SIDEBAR_MAX_WIDTH = 420;
// Below this width the New shell/New agent buttons drop their icons to keep the
// labels readable. (The icon-only Settings cog always keeps its icon.)
const LEFT_SIDEBAR_COMPACT_WIDTH = 270;
const PANE_TAB_DRAG_START_THRESHOLD = 4;
const PANE_TAB_DRAG_CLICK_SUPPRESS_MS = 100;
const GLOBAL_TASK_LAUNCHER_HOTKEY_OPTIONS: ReadonlyArray<{
  value: GlobalTaskLauncherHotkey;
  label: string;
  accelerator: string | null;
  /** Compact form for shortcut-hint slots (the ⌘K palette row). */
  glyph: string;
}> = [
  { value: "doubleControl", label: "Double-tap Control", accelerator: null, glyph: "⌃ ⌃" },
  { value: "doubleOption", label: "Double-tap Option", accelerator: null, glyph: "⌥ ⌥" },
  { value: "doubleCommand", label: "Double-tap Command", accelerator: null, glyph: "⌘ ⌘" },
  {
    value: "Control+Space",
    label: "Control-Space",
    accelerator: "Control+Space",
    glyph: "⌃Space",
  },
  {
    value: "Option+Space",
    label: "Option-Space",
    accelerator: "Option+Space",
    glyph: "⌥Space",
  },
  {
    value: "Command+Space",
    label: "Command-Space",
    accelerator: "Command+Space",
    glyph: "⌘Space",
  },
];
// Sentinel "active pane" value for the fixed Home tab. It's not a real pane, so it
// lives outside the `panes` list — it can't be closed, reordered, or nested, and
// selecting it shows the empty content placeholder (the launcher).
const HOME_TAB_ID = "__home__";
const RESEARCH_HOME_TAB_ID = "__research_home__";
const ACTIVE_RESEARCH_TREE_KEY = "qmux.active-research-tree.v1";
const RESEARCH_VISIBILITY_FILTER_KEY = "qmux.research-visibility-filter.v1";
const LEGACY_SHOW_ARCHIVED_RESEARCH_KEY = "qmux.show-archived-research.v1";
const RESEARCH_VISIBILITY_FILTER_OPTIONS: ReadonlyArray<{
  id: ResearchVisibilityFilter;
  label: string;
}> = [
  { id: "active", label: "Show active" },
  { id: "archived", label: "Show archived" },
  { id: "all", label: "Show all" },
];
const ACTIVE_RESEARCH_PANE_KEY = "qmux.active-research-pane.v1";
const RESEARCH_FOLDER_SCOPE_KEY = "qmux.research-folder-scope.v1";
const WARM_QMUX_TERMINAL_THEME_ID = "qmux-warm";
// Browser-overlay / link-action owner for a research tree's document. Keyed
// per tree so an overlay opened from one tree's links doesn't follow the user
// into another tree (each tree keeps its own overlay, like panes do).
const RESEARCH_BROWSER_OWNER_PREFIX = "__research_document__:";
function researchBrowserOwnerId(treeId: string) {
  return `${RESEARCH_BROWSER_OWNER_PREFIX}${treeId}`;
}
// How long after the user's last keystroke we keep holding the queue before letting a
// finished turn auto-send the next queued message.
const INPUT_DEQUEUE_HOLD_MS = 1500;
// Trailing debounce for committing native terminal title changes into React
// state (see handleTerminalTitleChange).
const TERMINAL_TITLE_COMMIT_DEBOUNCE_MS = 200;

function partitionResearchTrees(trees: ResearchTreeSummary[]) {
  return {
    active: trees.filter((tree) => !tree.archivedAt),
    archived: trees.filter((tree) => Boolean(tree.archivedAt)),
  };
}

function researchDocumentIsVisible(
  treeId: string,
  sidebarMode: SidebarMode,
  activeSurface: "pane" | "research",
  activeTreeId: string | null,
): boolean {
  return (
    sidebarMode === "research" &&
    activeSurface === "research" &&
    activeTreeId === treeId &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

// Structural equality for drag drop targets. Drop targets are recomputed as
// fresh objects on every pointermove of a tab/group drag; without an equality
// gate each move committed an identical target and re-rendered the whole app.
function paneDropTargetsEqual(
  a: PaneDropTarget | null,
  b: PaneDropTarget | null,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  switch (a.kind) {
    case "gap":
      return b.kind === "gap" && a.groupId === b.groupId && a.index === b.index;
    case "nest":
      return b.kind === "nest" && a.groupId === b.groupId && a.paneId === b.paneId;
    case "terminal-split":
      return (
        b.kind === "terminal-split" &&
        a.groupId === b.groupId &&
        a.targetPaneId === b.targetPaneId &&
        a.position === b.position
      );
  }
}

function groupDropTargetsEqual(
  a: GroupDropTarget | null,
  b: GroupDropTarget | null,
): boolean {
  return a === b || (a !== null && b !== null && a.index === b.index);
}

function claimResizePointer(event: ReactPointerEvent<HTMLDivElement>): () => void {
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  handle.setPointerCapture(pointerId);
  const releaseNativePointer = claimNativeTerminalPointerForWebDrag();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    releaseNativePointer();
  };
}

// Bounded retry for releasing a pane's output backlog (attachPane). A failure would
// otherwise leave the terminal blank forever, so retry with backoff to ride out a
// transient race (e.g. the pane not yet visible to the backend) before giving up.
const ATTACH_MAX_RETRIES = 4;
const ATTACH_INITIAL_RETRY_MS = 150;
const ATTACH_MAX_RETRY_MS = 2000;
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
const TERMINAL_SPLIT_GUTTER_PX = 8;
const DEFAULT_INITIAL_COLS = 100;
const DEFAULT_INITIAL_ROWS = 24;
const MIN_INITIAL_COLS = 20;
const MIN_INITIAL_ROWS = 5;
const MAX_INITIAL_COLS = 500;
const MAX_INITIAL_ROWS = 200;
const PANE_CONTEXT_MENU_WIDTH = 320;
const PANE_CONTEXT_MENU_ESTIMATED_HEIGHT = 400;
const GROUP_CONTEXT_MENU_WIDTH = 220;
const GROUP_CONTEXT_MENU_ESTIMATED_HEIGHT = 270;
const SETTINGS_CONTEXT_MENU_WIDTH = 180;
const SETTINGS_CONTEXT_MENU_TERMINAL_HEIGHT = 66;
const SETTINGS_CONTEXT_MENU_RESEARCH_HEIGHT = 134;
const DEFAULT_SHELL_TITLE = "Shell";
const MAX_TERMINAL_TITLE_CHARS = 160;
const MAX_FIRST_MESSAGE_TITLE_CHARS = 80;
const MAX_OPENROUTER_TITLE_SOURCE_CHARS = 4000;
const OPENROUTER_TITLE_MAX_COMPLETION_TOKENS = 1000;
const FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT = 5;
// The OpenRouter chat-completion request is proxied through the Rust backend
// (openRouterChatCompletion) so the API key is attached server-side; the renderer
// never sends it and the request timeout is enforced in the backend.
const APP_TOAST_TIMEOUT_MS = 5000;
const TITLE_GENERATION_TEST_MESSAGE =
  "Review the launch plan, identify the highest-risk blockers, and suggest next steps.";
// How long the composer can sit idle before its draft is flushed to disk. The
// in-memory copy updates on every keystroke (so tab switches never lose it); the
// disk write is debounced so a paused composer — and a restart — can recover it.
const DRAFT_FLUSH_DEBOUNCE_MS = 1000;
// Upper bound on the per-agent hook-event history. This feed accumulates for an
// agent's whole lifetime (it backs the "copy transcript as JSON" export), so
// without a cap a long-running, tool-heavy agent grows the array without limit.
// N is generous enough that the copy export stays complete for any realistic
// session.
const MAX_HOOK_EVENTS_PER_AGENT = 2000;

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
  // Formats transcript strings on first call and caches them. Only the copy
  // actions consume these, so eagerly formatting every agent's transcript on
  // every turn/status event was pure waste; use hasTranscript for emptiness.
  getTranscript: () => string;
  getPlainTextTranscript: () => string;
  hasTranscript: boolean;
}

interface TurnPaneSurface {
  pane: PaneInfo;
  agent: AgentInfo | undefined;
  turns: Turn[];
  assistantLabel: string;
  getTranscript: () => string;
  getPlainTextTranscript: () => string;
  hasTranscript: boolean;
  transcriptNotice: string | null;
  transcriptOptions: TranscriptOption[];
  queuedTurns: QueuedTurn[];
  waitTargets: WaitTarget[];
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
  // The API key is no longer carried here: the request is proxied through the backend
  // (see openRouterChatCompletion), which reads the key from the preferences file.
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
  const chars = Array.from(title);
  if (chars.length <= MAX_TERMINAL_TITLE_CHARS) {
    return title;
  }
  return `${chars.slice(0, MAX_TERMINAL_TITLE_CHARS - 1).join("").trimEnd()}…`;
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

  return `${chars.slice(0, MAX_FIRST_MESSAGE_TITLE_CHARS - 1).join("").trimEnd()}…`;
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
  // provider is the consent boundary; a configured key and model are still required
  // to make a call. The key stays out of the returned config — the backend proxy
  // attaches it — but its presence still gates whether a request is attempted.
  const hasKey = settings.openRouterKey.trim().length > 0;
  const model = settings.openRouterModel.trim();
  return hasKey && model ? { provider: "openRouter", model } : null;
}

function firstMessageTitleProviderLabel(config: FirstMessageTitleConfig): string {
  return config.provider === "appleFoundationModels" ? "Apple Foundation Models" : "OpenRouter";
}

function tabTitleProviderLabel(provider: AppSettings["tabTitleProvider"]): string {
  return (
    TAB_TITLE_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? "Tab titles"
  );
}

/** Catalog colors are bare RRGGBB hex; CSS needs the leading '#'. */
function themeCssColor(hex: string): string | null {
  if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  return hex.startsWith("#") ? hex : `#${hex}`;
}

/**
 * The swatch strip shown next to the theme select: background, foreground,
 * then the six primary ANSI accents (red through cyan) when the scheme
 * defines them.
 */
function themePreviewColors(theme: NativeTerminalTheme): string[] {
  const swatches = [theme.background, theme.foreground, ...theme.palette.slice(1, 7)];
  return swatches
    .map((color) => themeCssColor(color))
    .filter((color): color is string => color !== null);
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

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
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

// Recognizes the errors Apple Foundation Models raise when the on-device model
// can't be used at all: Apple Intelligence disabled, the model still
// downloading, an ineligible device, or qmux's own build/OS guards. These are
// not transient — retrying on the next message just reproduces the same
// failure — so the caller turns off title generation when one is seen. Returns a
// short, user-facing reason clause, or null when the error is something else.
function foundationModelsUnavailableReason(message: string): string | null {
  const lower = message.toLowerCase();
  if (lower.includes("appleintelligencenotenabled")) {
    return "Apple Intelligence is turned off";
  }
  if (lower.includes("modelnotready")) {
    return "the on-device model isn't ready yet";
  }
  if (lower.includes("devicenoteligible")) {
    return "this Mac doesn't support Apple Intelligence";
  }
  if (
    lower.includes("foundation models unavailable") ||
    lower.includes("foundation models require macos") ||
    lower.includes("foundation models are not available")
  ) {
    return "they're unavailable on this Mac";
  }
  return null;
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

function parseOpenRouterBody(raw: string, ok: boolean): unknown {
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (ok) {
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
    // Routed through the Rust backend so the API key is attached server-side and
    // never enters the renderer on the request path. The backend enforces the
    // request timeout and returns the upstream status + raw body.
    const { status, body } = await openRouterChatCompletion(payload);
    const ok = status >= 200 && status < 300;
    const responsePayload = parseOpenRouterBody(body, ok);
    if (!ok) {
      const message = openRouterPayloadErrorMessage(responsePayload) ?? `HTTP ${status}`;
      if (index < attempts.length - 1 && isOpenRouterReasoningConfigError(status, message)) {
        continue;
      }
      throw new Error(`OpenRouter request failed (${status}): ${message}`);
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
  if (turn.role !== "user" || turn.status === "superseded") {
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

function latestUserTurnText(turns: Turn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const text = firstUserTurnText(turns[index]);
    if (text) {
      return text;
    }
  }
  return null;
}

// Strips prepended/inline tagged instruction blocks (<system-reminder> …) from a turn
// for the compact cascade cards, using the same filter as the right pane. Queued turns
// keep the raw text if stripping empties them (a card should never be blank); the latest
// user turn returns null so its card falls back to the empty-state text.
function cascadeQueuedTurnText(text: string): string {
  const stripped = stripTaggedUserInstructionBlocks(text).trim();
  return stripped.length > 0 ? stripped : text;
}

function cascadeLatestUserTurn(turns: Turn[]): string | null {
  const text = latestUserTurnText(turns);
  if (!text) {
    return null;
  }
  const stripped = stripTaggedUserInstructionBlocks(text).trim();
  return stripped.length > 0 ? stripped : null;
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

function MainApp() {
  const appRef = useRef<HTMLElement | null>(null);
  const paneListRef = useRef<HTMLElement | null>(null);
  const terminalStageRef = useRef<HTMLDivElement | null>(null);
  const terminalPaneRefs = useRef(new Map<string, TerminalPaneHandle>());
  // Opening/closing the right bar resizes native terminal surfaces. Keep the
  // final focus handoff after that layout commit scoped to the pane whose bar
  // changed, especially in a split where a sibling surface is also visible.
  const rightBarFocusFrameRef = useRef<number | null>(null);
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
  const activeBrowserOwnerIdRef = useRef<string | null>(null);
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
  const researchTreeReorderPersistChainRef = useRef<Promise<void>>(Promise.resolve());
  const researchTreeReorderRequestSeqRef = useRef(0);
  const pendingFirstTitleByAgentRef = useRef<Map<string, PendingFirstMessageTitle>>(new Map());
  const titleRegenerationSeqByPaneRef = useRef<Record<string, number>>({});
  // Per-agent write generation for the queued-turns list. Bumped on every write (a
  // refresh starting, or a direct/event-driven update) so an in-flight refresh whose
  // generation was superseded drops its stale response instead of clobbering newer
  // state. Mirrors the pane/group reorder seq guards.
  const agentTurnQueueSeqRef = useRef<Record<string, number>>({});
  // Set once the OpenRouter key has been loaded from the backend, so the
  // persist-on-change effect doesn't push the pre-hydration in-memory value back.
  const openRouterKeyHydratedRef = useRef(false);
  // The backend preference is the startup/recovery source of truth. Do not let the
  // localStorage mirror write its default back before that durable value is loaded.
  const useLoginShellHydratedRef = useRef(false);
  const worktreeLocationHydratedRef = useRef(false);
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
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
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
  // Live OSC events override the recovery snapshot, including with explicit
  // null when a title sanitizes empty. Missing keys fall back to the pane's
  // persisted lastOscTitle.
  const [terminalTitleByPane, setTerminalTitleByPane] = useState<
    Record<string, string | null>
  >({});
  const [terminalOverlayBlockedPaneIds, setTerminalOverlayBlockedPaneIds] = useState<Set<string>>(
    () => new Set(),
  );
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
  const [shellJobByAgent, setShellJobByAgent] = useState<
    Record<string, ShellAgentJobInfo>
  >({});
  const shellJobEventVersionRef = useRef(0);
  const setShellJobByAgentFromEvent = useCallback(
    (update: SetStateAction<Record<string, ShellAgentJobInfo>>) => {
      shellJobEventVersionRef.current += 1;
      setShellJobByAgent(update);
    },
    [],
  );
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
  const [threadGraphs, setThreadGraphs] = useState<ThreadGraph[]>([]);
  const [queuedTurnsByAgent, setQueuedTurnsByAgentState] = useState<Record<string, QueuedTurn[]>>({});
  // Per-agent hook-event history. It backs only the "copy transcript as JSON"
  // export — nothing renders it — so it lives outside React state: hooks fire on
  // every tool call of a busy agent, and putting each one through setState was a
  // full-app re-render per event. Mutated in place; capped so a long-running,
  // tool-heavy agent bounds both memory and export size.
  const hookEventsByAgentRef = useRef<Record<string, TranscriptHookEvent[]>>({});
  const appendHookEvent = useCallback((event: TranscriptHookEvent) => {
    const store = hookEventsByAgentRef.current;
    const existing = store[event.agentId];
    if (!existing) {
      store[event.agentId] = [event];
      return;
    }
    existing.push(event);
    if (existing.length > MAX_HOOK_EVENTS_PER_AGENT) {
      existing.splice(0, existing.length - MAX_HOOK_EVENTS_PER_AGENT);
    }
  }, []);
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
  const [waitTargetHoverAgentId, setWaitTargetHoverAgentId] = useState<string | null>(null);
  // The agent whose split cell a queued-card drag is currently hovering, so that
  // cell can render as the drop target while dragging a card between splits.
  const [queueDropTargetAgentId, setQueueDropTargetAgentId] = useState<string | null>(null);
  const [draftsByAgent, setDraftsByAgentState] = useState<Record<string, string>>({});
  const [activePaneId, setActivePaneIdState] = useState<string | null>(null);
  const activePaneIdRef = useRef(activePaneId);
  activePaneIdRef.current = activePaneId;
  const [activeResearchTreeId, setActiveResearchTreeId] = useState<string | null>(null);
  const activeResearchTreeIdRef = useRef(activeResearchTreeId);
  const researchDetailRequestSeqRef = useRef(0);
  const researchNavRefreshSeqRef = useRef(0);
  const researchNavRefreshInFlightRef = useRef(0);
  activeResearchTreeIdRef.current = activeResearchTreeId;
  const [activeResearchPaneId, setActiveResearchPaneId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_RESEARCH_PANE_KEY),
  );
  const activeResearchPaneIdRef = useRef(activeResearchPaneId);
  activeResearchPaneIdRef.current = activeResearchPaneId;
  const [researchTrees, setResearchTrees] = useState<ResearchTreeSummary[]>([]);
  const [archivedResearchTrees, setArchivedResearchTrees] = useState<ResearchTreeSummary[]>([]);
  const [researchVisibilityFilter, setResearchVisibilityFilter] =
    useState<ResearchVisibilityFilter>(() => {
      const stored = localStorage.getItem(RESEARCH_VISIBILITY_FILTER_KEY);
      if (stored === "active" || stored === "archived" || stored === "all") {
        return stored;
      }
      return localStorage.getItem(LEGACY_SHOW_ARCHIVED_RESEARCH_KEY) === "true"
        ? "all"
        : "active";
    });
  const changeResearchVisibilityFilter = useCallback((filter: ResearchVisibilityFilter) => {
    setResearchVisibilityFilter(filter);
    localStorage.setItem(RESEARCH_VISIBILITY_FILTER_KEY, filter);
  }, []);
  // Read by mark-viewed acknowledgment (a stable callback) to decide whether
  // any attention badge was actually lit without threading the lists through
  // its dependencies.
  const researchTreesRef = useRef(researchTrees);
  const archivedResearchTreesRef = useRef(archivedResearchTrees);
  researchTreesRef.current = researchTrees;
  archivedResearchTreesRef.current = archivedResearchTrees;
  // Which single folder the Research sidebar is scoped to. The raw stored
  // value is resolved against live research workspaces wherever it is read.
  const [researchFolderScope, setResearchFolderScope] = useState<ResearchFolderScope>(
    () => localStorage.getItem(RESEARCH_FOLDER_SCOPE_KEY),
  );
  const changeResearchFolderScope = useCallback((scope: ResearchFolderScope) => {
    setResearchFolderScope(scope);
    if (scope) {
      localStorage.setItem(RESEARCH_FOLDER_SCOPE_KEY, scope);
    } else {
      localStorage.removeItem(RESEARCH_FOLDER_SCOPE_KEY);
    }
  }, []);
  const [researchActivity, setResearchActivity] = useState<ResearchNode[]>([]);
  const [activeResearchDetail, setActiveResearchDetail] = useState<ResearchTreeDetail | null>(null);
  // Why activeResearchDetail is null after a failed tree fetch. Without it the
  // document shows an unexplained spinner forever: the content effect can't
  // run (no detail-derived node id), so no in-document retry can recover.
  const [activeResearchDetailError, setActiveResearchDetailError] = useState<string | null>(null);
  const [sidebarMode, setSidebarModeState] = useState<SidebarMode>(() =>
    parseSidebarMode(localStorage.getItem(SIDEBAR_MODE_STORAGE_KEY)),
  );
  const sidebarModeRef = useRef(sidebarMode);
  sidebarModeRef.current = sidebarMode;
  const [activeSurface, setActiveSurfaceState] = useState<"pane" | "research">("pane");
  const activeSurfaceRef = useRef(activeSurface);
  activeSurfaceRef.current = activeSurface;
  const setActiveSurface = useCallback((surface: "pane" | "research") => {
    activeSurfaceRef.current = surface;
    setActiveSurfaceState(surface);
  }, []);
  const lastTerminalTabIdRef = useRef<string>(HOME_TAB_ID);
  const setSidebarMode = useCallback((mode: SidebarMode) => {
    sidebarModeRef.current = mode;
    setSidebarModeState(mode);
    localStorage.setItem(SIDEBAR_MODE_STORAGE_KEY, mode);
  }, []);
  const setActivePaneId = useCallback(
    (next: SetStateAction<string | null>) => {
      if (typeof next === "function") {
        setActivePaneIdState((current) => {
          const resolved = next(current);
          activePaneIdRef.current = resolved;
          activePaneRef.current =
            resolved && resolved !== HOME_TAB_ID
              ? panesRef.current.find((candidate) => candidate.id === resolved)
              : undefined;
          return resolved;
        });
        return;
      }
      setActiveSurface("pane");
      activePaneIdRef.current = next;
      activePaneRef.current =
        next && next !== HOME_TAB_ID
          ? panesRef.current.find((candidate) => candidate.id === next)
          : undefined;
      setActivePaneIdState(next);
      if (!next) {
        return;
      }
      const pane = panesRef.current.find((candidate) => candidate.id === next);
      const mode =
        next === HOME_TAB_ID
          ? "terminal"
          : (groupsRef.current.find((group) => group.id === pane?.groupId)?.scope ?? "terminal");
      setSidebarMode(mode);
      if (mode === "terminal") {
        lastTerminalTabIdRef.current = next;
      } else if (pane) {
        activeResearchPaneIdRef.current = pane.id;
        setActiveResearchPaneId(pane.id);
        localStorage.setItem(ACTIVE_RESEARCH_PANE_KEY, pane.id);
      }
    },
    [setSidebarMode],
  );
  const [shortcutHintsVisible, setShortcutHintsVisible] = useState(false);
  const [turnPaneWidth, setTurnPaneWidth] = useState(TURN_PANE_DEFAULT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  // Application-level settings, loaded from localStorage once on mount and
  // persisted on every change. Shared by every pane. Font size is also adjustable
  // in-session with Cmd-=/Cmd--.
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [availableBodyFonts, setAvailableBodyFonts] = useState<BodyFontOption[] | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newResearchOpen, setNewResearchOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentInitialMarkdown, setNewDocumentInitialMarkdown] = useState("");
  const [publicationTarget, setPublicationTarget] = useState<PublishDialogTarget | null>(null);
  const [publicationBindings, setPublicationBindings] = useState<PublicationBinding[]>([]);
  const [markdownDropTargetActive, setMarkdownDropTargetActive] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const markdownImportRequestSeqRef = useRef(0);
  const markdownDropBlockedRef = useRef(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Saved prompts shown in the palette's "Insert prompt" section, refreshed on
  // each open so edits made in the library menu or on disk show up.
  const [paletteSavedPrompts, setPaletteSavedPrompts] = useState<SavedPrompt[]>([]);
  // True while a web editable (composer, rename input, search field…) holds DOM
  // focus. Native terminal panes must never claim first responder then, or they
  // would steal the keyboard mid-typing.
  const [webEditableFocused, setWebEditableFocused] = useState(false);
  // True while a non-collapsed DOM selection exists. Folded into the
  // keyboard-ownership signal handed to terminal panes so selected web text
  // keeps WebKit as the key target (Cmd+C copies the selection instead of
  // running Ghostty's copy on the terminal).
  const [webSelectionActive, setWebSelectionActive] = useState(false);
  // Orders user-input events against page-focus gains so a focus event can be
  // classified as user-driven (a click or key since the page last became
  // focused) versus WebKit re-emitting focus on its remembered element after
  // the webview regains first responder. Surface handoffs and right-pane
  // layout transitions produce the latter constantly, and they must never be
  // read as the user activating a pane. Sequence counters, not timestamps —
  // the restoration focus can land in the same millisecond as the window
  // focus event that caused it.
  const focusOrderSeqRef = useRef(0);
  const lastUserInputSeqRef = useRef(0);
  const lastWindowFocusSeqRef = useRef(0);
  const userInputSinceWindowFocus = useCallback(
    () => lastUserInputSeqRef.current > lastWindowFocusSeqRef.current,
    [],
  );
  const [settingsTab, setSettingsTab] = useState<"basic" | "advanced">("basic");
  const [openRouterKeyVisible, setOpenRouterKeyVisible] = useState(false);
  const [showHideShortcutSetting, setShowHideShortcutSetting] =
    useState<ShowHideShortcutSetting>({
      accelerator: null,
      registered: false,
      error: null,
      captureActive: false,
    });
  const [showHideShortcutSaving, setShowHideShortcutSaving] = useState(false);
  const showHideShortcutRequestRef = useRef(0);
  const [globalTaskLauncherSetting, setGlobalTaskLauncherSetting] =
    useState<GlobalTaskLauncherSetting>({
      hotkey: "doubleOption",
      registered: false,
      error: null,
    });
  const [globalTaskLauncherHotkeySaving, setGlobalTaskLauncherHotkeySaving] =
    useState(false);
  const globalTaskLauncherHotkeyRequestRef = useRef(0);
  const showHideShortcutValue = showHideShortcutSetting.accelerator ?? "";
  const showHideShortcutMessage =
    showHideShortcutSetting.error ??
    (showHideShortcutValue &&
    !showHideShortcutSetting.registered &&
    !showHideShortcutSetting.captureActive
      ? "Shortcut is saved but not active."
      : null);
  // A system-wide hotkey consumes its chord before the app sees any key event,
  // so a registration that collides with an in-app shortcut silently disables
  // that command everywhere. Warn, don't block: the collision may be wanted.
  const showHideShortcutConflictLabel = showHideShortcutConflict(
    showHideShortcutValue || null,
  );
  const globalTaskLauncherHotkeyMessage =
    globalTaskLauncherSetting.error ??
    (!globalTaskLauncherSetting.registered ? "Global quick launch hotkey is not active." : null);
  const bodyFontFamily = bodyFontStackFor(settings.bodyFontId);
  const terminalFontSize = settings.fontSize;
  const terminalFontFamily = fontStackFor(settings.fontId);
  const terminalNativeFontFamily = nativeFontFamilyFor(settings.fontId);
  const terminalLetterSpacing = letterSpacingFor(settings.fontId);
  const terminalScrollSensitivity = scrollSensitivityFor(settings.mouseWheelSensitivity);
  // The application color theme only adjusts qmux's built-in terminal palette;
  // explicitly selected Ghostty themes keep their authored backgrounds.
  const terminalThemeName =
    settings.themeId === DEFAULT_THEME_ID && settings.colorTheme === "orange-blob"
      ? WARM_QMUX_TERMINAL_THEME_ID
      : settings.themeId;

  // Apply the app accent before paint so switching (and restoring) color themes
  // does not flash the default green palette.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.colorTheme = settings.colorTheme;
    return () => {
      delete root.dataset.colorTheme;
    };
  }, [settings.colorTheme]);

  // The selected body font must live at the document root, not only on
  // .app-shell: menus and dialogs are portaled to document.body to escape pane
  // clipping, and CSS inheritance follows their DOM parent rather than their
  // React owner. Keeping the root variable current makes those surfaces follow
  // the same font selection as the rest of the application.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-ui", bodyFontFamily);
    return () => {
      root.style.removeProperty("--font-ui");
    };
  }, [bodyFontFamily]);

  useEffect(() => {
    let disposed = false;
    void detectAvailableBodyFonts().then((availableFonts) => {
      if (disposed) {
        return;
      }

      setAvailableBodyFonts(availableFonts);
      setSettings((current) => {
        if (availableFonts.some((option) => option.id === current.bodyFontId)) {
          return current;
        }
        const fallbackBodyFontId =
          availableFonts.find((option) => option.id === DEFAULT_BODY_FONT_ID)?.id ??
          availableFonts.find((option) => option.id === SYSTEM_BODY_FONT_ID)?.id ??
          DEFAULT_BODY_FONT_ID;
        return { ...current, bodyFontId: fallbackBodyFontId };
      });
    });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void getGlobalTaskLauncherHotkey()
      .then((setting) => {
        if (!disposed) setGlobalTaskLauncherSetting(setting);
      })
      .catch((err) => {
        if (!disposed) {
          setGlobalTaskLauncherSetting((current) => ({
            ...current,
            registered: false,
            error: unknownErrorMessage(err),
          }));
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Seed the native host with the current terminal settings so a pane created
  // later can build its Ghostty surface at creation time instead of waiting
  // for its own mount-time settings round-trip (which trails pane spawn by a
  // render, a paint, and an IPC hop). Re-seeded on every settings change so
  // the cached snapshot never goes stale; failures are ignored because every
  // pane still applies its own settings on mount.
  useEffect(() => {
    void seedNativeTerminalSettings({
      fontSize: terminalFontSize,
      fontFamily: terminalNativeFontFamily,
      letterSpacing: terminalLetterSpacing,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollbackRows: settings.scrollbackRows,
      scrollOnUserInput: settings.scrollOnUserInput,
      scrollSensitivity: terminalScrollSensitivity,
      copyOnSelect: settings.copyOnSelect,
      selectionClearOnCopy: settings.selectionClearOnCopy,
      themeName: terminalThemeName,
    }).catch(() => undefined);
  }, [
    settings.copyOnSelect,
    settings.cursorBlink,
    settings.cursorStyle,
    settings.lineHeight,
    settings.scrollOnUserInput,
    settings.scrollbackRows,
    settings.selectionClearOnCopy,
    terminalThemeName,
    terminalFontSize,
    terminalLetterSpacing,
    terminalNativeFontFamily,
    terminalScrollSensitivity,
  ]);
  // The theme catalog (qmux default first, then every bundled Ghostty scheme).
  // Loaded once at startup: the theme select needs it when settings open, and
  // --terminal-bg below needs the selected theme's background right away.
  const [themeCatalog, setThemeCatalog] = useState<NativeTerminalTheme[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listNativeTerminalThemes()
      .then((themes) => {
        if (!cancelled) {
          setThemeCatalog(themes);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThemeCatalog([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const selectedTheme = useMemo(
    () => themeCatalog?.find((theme) => theme.name === settings.themeId) ?? null,
    [settings.themeId, themeCatalog],
  );
  const themeGroups = useMemo(() => {
    const named = (themeCatalog ?? []).filter((theme) => theme.name !== DEFAULT_THEME_ID);
    return {
      dark: named.filter((theme) => theme.isDark),
      light: named.filter((theme) => !theme.isDark),
    };
  }, [themeCatalog]);
  // Chrome that sits flush against terminal pixels (the stage, split gutters,
  // the empty state) follows a selected Ghostty theme. The built-in qmux theme
  // removes the inline override so the application surface token can tint it.
  useEffect(() => {
    const background =
      settings.themeId === DEFAULT_THEME_ID
        ? null
        : selectedTheme
          ? themeCssColor(selectedTheme.background)
          : null;
    if (background) {
      document.documentElement.style.setProperty("--terminal-bg", background);
    } else {
      document.documentElement.style.removeProperty("--terminal-bg");
    }
  }, [selectedTheme, settings.themeId]);
  const pasteProtection = useMemo(() => pasteProtectionFor(settings), [settings]);
  const shortcutHintsShown = settings.showShortcutHints && shortcutHintsVisible;
  // The launcher prompt is deliberately NOT React state: as app-root state it
  // re-rendered the entire component tree on every keystroke (the composer had
  // the same problem and got a component-local draft). The textarea runs
  // uncontrolled; this ref tracks the live text for submit.
  const promptRef = useRef("");
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
  // Guard for the new-agent launcher: addAgentPane awaits spawnAgent, so a held
  // Enter or double submit would otherwise spawn several agents (and worktrees)
  // from one intended launch.
  const launchingAgentRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [appToast, setAppToast] = useState<{
    message: string;
    tone: "normal" | "warning";
  } | null>(null);
  const [folderPickerStatus, setFolderPickerStatus] = useState<string | null>(null);
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  const [researchFolderRemovalError, setResearchFolderRemovalError] = useState<string | null>(null);
  // Monotonic id for worktree-dialog git-status probes (see closeDialogForPane).
  const worktreeProbeNonceRef = useRef(0);
  const closeConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Which destructive close-dialog action is mid-flight, so the dialog stays
  // open (and its buttons disabled) until the operation actually finishes.
  const [resolvingClose, setResolvingClose] = useState<
    "keep" | "delete" | "removeResearchFolder" | null
  >(null);
  const [exitDialog, setExitDialog] = useState<ExitDialogState | null>(null);
  const [quitting, setQuitting] = useState(false);
  const quittingRef = useRef(false);
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
  // Shared by every pointer drag that changes a terminal host rectangle. DOM
  // layout keeps following the pointer while the native frames stay committed
  // at their pre-drag size until pointerup/pointercancel.
  const [terminalGeometryResizing, setTerminalGeometryResizing] = useState(false);
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
  // Pane and research-document selection are independent. Switching modes restores
  // the previous selection instead of erasing the other mode's navigation context.
  const researchSurfaceActive = activeSurface === "research";
  const researchActive = researchSurfaceActive && activeResearchTreeId !== null;
  const researchHomeActive = researchSurfaceActive && activeResearchTreeId === null;
  const selectedPane = panes.find((pane) => pane.id === activePaneId);
  const homeActive =
    activeSurface === "pane" &&
    (activePaneId === HOME_TAB_ID || (!selectedPane && panes.length === 0));
  const activePane = useMemo(
    () =>
      homeActive || researchActive || activeSurface !== "pane" ? undefined : selectedPane,
    [activeSurface, homeActive, researchActive, selectedPane],
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
  // Per-agent cache behind agentTurnInfoById. Rebuilding an agent's thread graph
  // and (worse) handing out a fresh `turns` array identity invalidates the
  // transcript timeline's memoization and re-parses all of its markdown — so an
  // event about agent A must not churn agent B's entry, and a status-only change
  // to A must not churn A's own turns. Entries are reused when the inputs that
  // actually feed the computation are unchanged: the per-agent turn list
  // (element-wise — turn objects are immutable once appended), the stored graph
  // object, and the agent fields the graph builders read.
  const turnInfoCacheRef = useRef(
    new Map<
      string,
      {
        agentKey: string;
        agentTurns: Turn[];
        storedGraph: ThreadGraph | undefined;
        // focusedBranchTurns(storedGraph) materializes a Turn object per node
        // and sorts the whole branch — O(full history). Cached per stored-graph
        // identity so a streaming append (which only changes agentTurns)
        // reuses the branch prefix and pays only for the pending suffix.
        // Undefined when the agent had no stored graph.
        storedBranchTurns: Turn[] | undefined;
        info: AgentTurnInfo;
      }
    >(),
  );
  const agentTurnInfoById = useMemo(() => {
    // The fields consulted by buildSingleAgentThreadGraph / focusedBranchTurns /
    // pendingGraphOverlayTurns / participantForTurn. Status flips and other
    // activity metadata deliberately don't invalidate.
    const agentCacheKey = (agent: AgentInfo) =>
      [
        agent.id,
        agent.adapter,
        agent.threadId ?? "",
        agent.branchId ?? "",
        agent.sessionId ?? "",
        agent.transcriptPath ?? "",
        agent.createdAt,
      ].join("\0");
    const sameTurnList = (a: Turn[], b: Turn[]) =>
      a.length === b.length && a.every((turn, index) => turn === b[index]);

    const threadGraphById = new Map(threadGraphs.map((graph) => [graph.threadId, graph]));
    const turnsByAgent = new Map<string, Turn[]>();
    for (const turn of turns) {
      const agentTurns = turnsByAgent.get(turn.agentId);
      if (agentTurns) {
        agentTurns.push(turn);
      } else {
        turnsByAgent.set(turn.agentId, [turn]);
      }
    }
    const cache = turnInfoCacheRef.current;
    const liveAgentIds = new Set<string>();
    const result = new Map<string, AgentTurnInfo>();
    for (const agent of agents) {
      liveAgentIds.add(agent.id);
      const agentTurns = turnsByAgent.get(agent.id) ?? [];
      const agentKey = agentCacheKey(agent);
      // Same fallback the backend keys graph records by, so agents that never
      // got an explicit thread id still find their stored graph.
      const storedGraph = threadGraphById.get(threadIdForAgent(agent));
      const cached = cache.get(agent.id);
      if (
        cached &&
        cached.agentKey === agentKey &&
        cached.storedGraph === storedGraph &&
        sameTurnList(cached.agentTurns, agentTurns)
      ) {
        result.set(agent.id, cached.info);
        continue;
      }
      const adapter = getAgentUiAdapter(agent.adapter);
      const normalizedTurns = adapter.normalizeTurns?.(agentTurns) ?? agentTurns;
      // Prefer the stored graph whenever it can represent this history, even if
      // the newest turns haven't reached it yet (its refresh is debounced behind
      // the live stream): render the graph and overlay the pending suffix.
      // Falling back to the 200-capped turn list whenever the graph missed one
      // turn used to swap the whole visible history (full → capped → full) on
      // every append of a long transcript.
      let storedBranchTurns: Turn[] | undefined;
      let pendingTurns: Turn[] | null = null;
      if (storedGraph) {
        storedBranchTurns =
          cached && cached.agentKey === agentKey && cached.storedGraph === storedGraph
            ? cached.storedBranchTurns
            : undefined;
        storedBranchTurns ??= focusedBranchTurns(storedGraph, agent);
        pendingTurns = pendingGraphOverlayTurns(
          storedGraph,
          agent,
          storedBranchTurns,
          normalizedTurns,
        );
      }
      const usesStoredGraph = Boolean(storedGraph && pendingTurns !== null);
      const branchTurns =
        usesStoredGraph && storedBranchTurns
          ? storedBranchTurns
          : focusedBranchTurns(buildSingleAgentThreadGraph(agent, normalizedTurns), agent);
      const graphTurns =
        pendingTurns && pendingTurns.length > 0 ? [...branchTurns, ...pendingTurns] : branchTurns;
      // Stored graphs can predate an adapter's presentation normalization and
      // therefore still contain native metadata turns (Claude queue operations in
      // particular). Normalize once more at the final UI boundary so the timeline
      // and copied transcript agree regardless of which graph source won above.
      const visibleTurns = adapter.normalizeTurns?.(graphTurns) ?? graphTurns;
      const assistantLabel = adapter.label;
      // Every turn formats at least its role label, so emptiness is just "no
      // turns" — the full string is only ever built for the copy actions.
      let transcript: string | null = null;
      let plainTextTranscript: string | null = null;
      const info: AgentTurnInfo = {
        turns: visibleTurns,
        assistantLabel,
        getTranscript: () =>
          (transcript ??= formatTurnsTranscript(visibleTurns, assistantLabel)),
        getPlainTextTranscript: () =>
          (plainTextTranscript ??= formatPlainTextTranscript(visibleTurns, assistantLabel)),
        hasTranscript: visibleTurns.length > 0,
      };
      cache.set(agent.id, { agentKey, agentTurns, storedGraph, storedBranchTurns, info });
      result.set(agent.id, info);
    }
    for (const agentId of cache.keys()) {
      if (!liveAgentIds.has(agentId)) {
        cache.delete(agentId);
      }
    }
    return result;
  }, [agents, threadGraphs, turns]);
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
  const terminalGroups = useMemo(() => groupsForScope(groups, "terminal"), [groups]);
  const researchGroups = useMemo(() => groupsForScope(groups, "research"), [groups]);
  const researchScope = useMemo(
    () => resolveResearchScope(researchFolderScope, researchGroups),
    [researchFolderScope, researchGroups],
  );
  const researchScopeRef = useRef(researchScope);
  researchScopeRef.current = researchScope;
  const scopedResearchTrees = useMemo(
    () => treesForResearchScope(researchTrees, researchScope),
    [researchScope, researchTrees],
  );
  const scopedArchivedResearchTrees = useMemo(
    () => treesForResearchScope(archivedResearchTrees, researchScope),
    [archivedResearchTrees, researchScope],
  );
  // Menu badges and the folder-replace dialog both count every tree that keeps
  // a folder alive, so archived trees are included (removal is blocked on them).
  const researchFolderTreeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tree of [...researchTrees, ...archivedResearchTrees]) {
      counts.set(tree.workspaceId, (counts.get(tree.workspaceId) ?? 0) + 1);
    }
    return counts;
  }, [archivedResearchTrees, researchTrees]);
  useEffect(() => {
    // Boot-gated like the active-tab effect below: this runs on mount with the
    // pane list still empty, and ungated it would wipe the saved research-pane
    // key before the boot restore ever reads it.
    if (!activeTabPersistenceReadyRef.current) {
      return;
    }
    const visibleResearchPane =
      activeSurface === "pane" &&
      activePane &&
      groupById.get(activePane.groupId)?.scope === "research"
        ? activePane
        : null;
    if (visibleResearchPane && activeResearchPaneId !== visibleResearchPane.id) {
      activeResearchPaneIdRef.current = visibleResearchPane.id;
      setActiveResearchPaneId(visibleResearchPane.id);
      localStorage.setItem(ACTIVE_RESEARCH_PANE_KEY, visibleResearchPane.id);
    } else if (
      activeResearchPaneId &&
      !panes.some((pane) => pane.id === activeResearchPaneId)
    ) {
      activeResearchPaneIdRef.current = null;
      setActiveResearchPaneId(null);
      localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    }
  }, [activePane, activeResearchPaneId, activeSurface, groupById, panes]);
  useEffect(() => {
    if (activeSurface !== "pane" || activePaneId === HOME_TAB_ID || selectedPane) {
      return;
    }
    // A selected research terminal is intentionally short-lived. When it retires,
    // return to its durable document instead of falling across into Terminal mode
    // — including when it was the last pane of the session, where the empty-pane
    // guard below would otherwise leave the surface on "pane" and the stage
    // rendering the Home launcher against a Research sidebar.
    if (sidebarMode === "research" && activeResearchTreeId) {
      setActiveSurface("research");
      return;
    }
    if (panes.length === 0) {
      return;
    }
    const fallback = terminalTabForMode(
      panes,
      groups,
      lastTerminalTabIdRef.current,
      HOME_TAB_ID,
    );
    activePaneIdRef.current = fallback;
    setActivePaneIdState(fallback);
    setSidebarMode("terminal");
  }, [
    activePaneId,
    activeResearchTreeId,
    activeSurface,
    groups,
    panes,
    selectedPane,
    setSidebarMode,
    sidebarMode,
  ]);
  // Kept current so callbacks captured once (e.g. the events hook's first-render
  // capture) can still read the latest group collapse state through the ref.
  const groupByIdRef = useRef(groupById);
  groupByIdRef.current = groupById;
  // Picks the next active pane after one closes, honoring split membership and skipping
  // collapsed groups — the same rules forgetClosedPane uses. Stable + ref-backed so the
  // pane.removed handler (captured once by useQmuxEvents) selects consistently with the
  // user-initiated close path.
  const selectPaneAfterCloseWithContext = useCallback(
    (panesForSelection: PaneInfo[], closedPaneId: string) => {
      const closedPane = panesForSelection.find((pane) => pane.id === closedPaneId);
      const closedScope = closedPane
        ? (groupByIdRef.current.get(closedPane.groupId)?.scope ?? "terminal")
        : "terminal";
      // A research pane is not a tab among tabs: it is the transient terminal
      // view of one tree's run. Handing focus to the "nearest" research pane
      // would land on an unrelated tree's hidden terminal while the sidebar
      // still highlights the tree the user was watching. Return no successor;
      // the surface fallback then restores the durable research document.
      if (closedScope === "research") {
        return null;
      }
      const scopedPanes = panesForSelection.filter(
        (pane) =>
          (groupByIdRef.current.get(pane.groupId)?.scope ?? "terminal") === closedScope,
      );
      return selectPaneAfterClose(scopedPanes, closedPaneId, paneSplitsRef.current, {
        isPaneInCollapsedGroup: (pane) =>
          groupByIdRef.current.get(pane.groupId)?.collapsed === true,
      });
    },
    [],
  );
  const sidebarPanes = useMemo(
    () => panesForScope(panes, groups, "terminal"),
    [groups, panes],
  );
  const researchNodeByPaneId = useMemo(
    () =>
      new Map(
        researchActivity.flatMap((node) => (node.paneId ? [[node.paneId, node] as const] : [])),
      ),
    [researchActivity],
  );
  // Ref for callbacks captured once (the viewed-marking path runs from event
  // handlers and window listeners).
  const researchNodeByPaneIdRef = useRef(researchNodeByPaneId);
  researchNodeByPaneIdRef.current = researchNodeByPaneId;
  const researchPanes = useMemo(
    () => panesForScope(panes, groups, "research"),
    [groups, panes],
  );
  const scopedResearchPanes = useMemo(
    () => researchPanes.filter((pane) => pane.groupId === researchScope),
    [researchPanes, researchScope],
  );
  const cycleableResearchTabIds = useMemo(
    () =>
      researchCycleTabIds(
        panes,
        groups,
        researchVisibilityFilter === "active"
          ? researchTrees
          : researchVisibilityFilter === "archived"
            ? archivedResearchTrees
            : [...researchTrees, ...archivedResearchTrees],
        researchScope,
      ),
    [
      archivedResearchTrees,
      groups,
      panes,
      researchScope,
      researchTrees,
      researchVisibilityFilter,
    ],
  );
  const researchAttentionState = useMemo(() => researchAttention(researchTrees), [researchTrees]);
  const runningResearchCount = researchAttentionState.runningCount;
  const unseenResearchCount = researchAttentionState.unseenCount;
  const failedResearchCount = researchAttentionState.failedCount;
  // Row index per pane id, so each sidebar row doesn't linear-scan the pane
  // list (O(panes²) per render across the rows).
  const sidebarPaneIndexById = useMemo(
    () => new Map(sidebarPanes.map((pane, index) => [pane.id, index])),
    [sidebarPanes],
  );
  const cycleableSidebarPanes = useMemo(
    () =>
      sidebarPanes.filter((pane) => groupById.get(pane.groupId)?.collapsed !== true),
    [groupById, sidebarPanes],
  );
  // The panes that get a numbered jump shortcut (Cmd-1..9). A collapsed group hides its
  // tabs, and a grouped split shares one tab for all its members, so those don't get a
  // number: skip collapsed-group panes (already dropped by cycleableSidebarPanes) and
  // keep only the first member of each split.
  const numberedTabPanes = useMemo(
    () =>
      cycleableSidebarPanes.filter((pane) => {
        const split = paneSplitForPane(paneSplits, pane.id);
        return !split || split.paneIds[0] === pane.id;
      }),
    [cycleableSidebarPanes, paneSplits],
  );
  // Shortcut index per pane id: waitTargetsForAgent labels every pane with
  // active work on each render, and resolving each label with a findIndex over
  // numberedTabPanes made that O(panes²) per render while agents stream.
  const numberedTabIndexByPaneId = useMemo(
    () => new Map(numberedTabPanes.map((pane, index) => [pane.id, index])),
    [numberedTabPanes],
  );
  const shortcutLabelForPaneId = useCallback(
    (paneId?: string | null) => {
      if (!paneId) {
        return null;
      }
      // Number from the same list the Cmd-1..9 shortcut jumps through, so a tab's badge
      // matches the key that reaches it (collapsed-group and non-first split members have
      // no number).
      const index = numberedTabIndexByPaneId.get(paneId) ?? -1;
      return index >= 0 && index < 9 ? `⌘${index + 1}` : null;
    },
    [numberedTabIndexByPaneId],
  );
  const activeBrowserOwnerId = researchSurfaceActive
    ? activeResearchTreeId
      ? researchBrowserOwnerId(activeResearchTreeId)
      : null
    : (activePane?.id ?? null);
  const activeBrowserOverlay = activeBrowserOwnerId
    ? browserOverlayByPane[activeBrowserOwnerId]
    : undefined;
  useEffect(() => {
    if (
      activePane?.groupId &&
      groupById.get(activePane.groupId)?.scope === "terminal"
    ) {
      setLastActiveGroupId(activePane.groupId);
    }
  }, [activePane?.groupId, groupById]);
  useEffect(() => {
    if (!activeTabPersistenceReadyRef.current) {
      return;
    }
    const activePaneIsTerminal =
      activePane && groupById.get(activePane.groupId)?.scope === "terminal";
    const nextActiveTabId = homeActive
      ? HOME_TAB_ID
      : activePaneIsTerminal
        ? activePane.id
        : null;
    if (!nextActiveTabId) {
      return;
    }
    void setActiveTab(nextActiveTabId).catch(() => undefined);
  }, [homeActive, activePane, groupById]);
  // Keep the native opaque backstop aligned with the terminal stage. The stage's
  // webview pixels are transparent while panes are shown, and pane surfaces chase
  // their DOM rects asynchronously, so the backstop (an AppKit view below every
  // pane surface) is what shows through transient gaps — pane spawn, Home→pane
  // switches, split-resize lag — instead of the window's vibrancy material.
  useLayoutEffect(() => {
    if (!IS_MAC) {
      return;
    }
    const stage = terminalStageRef.current;
    if (!stage) {
      return;
    }
    let frame: number | null = null;
    const syncBackstop = () => {
      frame = null;
      const rect = stage.getBoundingClientRect();
      void setNativeTerminalStageBackstop({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }).catch(() => undefined);
    };
    const scheduleBackstop = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(syncBackstop);
    };
    const observer = new ResizeObserver(scheduleBackstop);
    observer.observe(stage);
    scheduleBackstop();
    return () => {
      observer.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);
  // Committed per pane on a trailing debounce rather than per event: programs
  // that stream progress into the terminal title (OSC 0/2 spinners, build
  // percentages) emit a distinct title many times a second, and committing each
  // one re-rendered the whole app and rebuilt the tray-menu snapshot per change
  // — a busy terminal made typing lag everywhere else. A tab label lagging its
  // terminal by a couple hundred milliseconds is imperceptible.
  const terminalTitleTimersRef = useRef(new Map<string, number>());
  const pendingTerminalTitlesRef = useRef(new Map<string, string | null>());
  const handleTerminalTitleChange = useCallback((paneId: string, rawTitle: string) => {
    pendingTerminalTitlesRef.current.set(paneId, sanitizeTerminalTitle(rawTitle));
    if (terminalTitleTimersRef.current.has(paneId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      terminalTitleTimersRef.current.delete(paneId);
      const pending = pendingTerminalTitlesRef.current.get(paneId);
      pendingTerminalTitlesRef.current.delete(paneId);
      if (pending === undefined) {
        return;
      }
      setTerminalTitleByPane((current) => {
        if (current[paneId] === pending) {
          return current;
        }
        return { ...current, [paneId]: pending };
      });
    }, TERMINAL_TITLE_COMMIT_DEBOUNCE_MS);
    terminalTitleTimersRef.current.set(paneId, timer);
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
    const terminalTitle = Object.prototype.hasOwnProperty.call(terminalTitleByPane, pane.id)
      ? terminalTitleByPane[pane.id]
      : pane.lastOscTitle;
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
    return agent ? agentStatusTone(agent.status) : "idle";
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

  // When Apple Foundation Models report they're unavailable (Apple Intelligence
  // off, model not ready, ineligible device), turn off automatic tab titles so
  // the failure doesn't recur on every message, and return a friendly notice for
  // the caller to surface. Returns null for any other provider or error, leaving
  // the caller to report it as usual.
  function noteFoundationTitleUnavailable(
    titleConfig: FirstMessageTitleConfig,
    message: string,
  ): string | null {
    if (titleConfig.provider !== "appleFoundationModels") {
      return null;
    }
    const reason = foundationModelsUnavailableReason(message);
    if (!reason) {
      return null;
    }
    setSettings((current) =>
      current.tabTitleProvider === "appleFoundationModels"
        ? { ...current, tabTitleProvider: "disabled" }
        : current,
    );
    return `Apple Foundation Models can't generate tab titles — ${reason}. Automatic tab titles are now off; re-enable them in Settings.`;
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
      const friendly = noteFoundationTitleUnavailable(titleConfig, message);
      setTitleGenerationTest({
        status: "error",
        providerLabel,
        message: friendly ?? message,
      });
      showAppToast(
        friendly ?? `${providerLabel} title test failed: ${message}`,
        "warning",
      );
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
      const message = unknownErrorMessage(err);
      const friendly = noteFoundationTitleUnavailable(titleConfig, message);
      showAppToast(
        friendly ?? `${firstMessageTitleProviderLabel(titleConfig)} title error: ${message}`,
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
      const message = unknownErrorMessage(err);
      const friendly = noteFoundationTitleUnavailable(titleConfig, message);
      showAppToast(
        friendly ?? `${firstMessageTitleProviderLabel(titleConfig)} title error: ${message}`,
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
    setTranscriptNoticeByAgent(pruneRecord);
    setTranscriptOptionsByAgent(pruneRecord);
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
    for (const id of Object.keys(hookEventsByAgentRef.current)) {
      if (!ids.has(id)) delete hookEventsByAgentRef.current[id];
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
        iconSrc: ADAPTER_ICON_BY_ID[adapter.id],
        iconClassName: adapterIconClassName(adapter.id),
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
    // Force the sandbox on for any token-bearing file-server URL regardless of the
    // caller's flag: only the backend browser.open event passes sandbox=true, so typed
    // navigation and link opens would otherwise load a file-server URL as a trusted
    // same-origin document and defeat the token protection. Dev-server URLs are excluded
    // by isFileServerUrl and keep their real same-origin context.
    const effectiveSandbox = sandbox || isFileServerUrl(url, configRef.current?.fileServerPort ?? null);
    setBrowserOverlayByPane((current) => ({
      ...current,
      [paneId]: {
        url,
        open: true,
        reloadNonce: (current[paneId]?.reloadNonce ?? 0) + 1,
        sandbox: effectiveSandbox,
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

  function toggleBrowserOverlay(paneId: string) {
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

  function toggleActiveBrowserOverlay() {
    if (activeBrowserOwnerId) {
      toggleBrowserOverlay(activeBrowserOwnerId);
    }
  }

  function closeActiveBrowserOverlay() {
    if (!activeBrowserOwnerId) {
      return;
    }
    setBrowserOverlayByPane((current) => {
      const prev = current[activeBrowserOwnerId];
      if (!prev?.open) {
        return current;
      }
      return { ...current, [activeBrowserOwnerId]: { ...prev, open: false } };
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

  function setRightBarCollapsedForPane(collapsed: boolean, paneId: string | null | undefined) {
    setRightBarCollapsed(collapsed);
    if (!paneId) {
      return;
    }
    if (rightBarFocusFrameRef.current !== null) {
      cancelAnimationFrame(rightBarFocusFrameRef.current);
    }
    rightBarFocusFrameRef.current = requestAnimationFrame(() => {
      rightBarFocusFrameRef.current = null;
      if (activePaneIdRef.current === paneId) {
        // TerminalPane.focus() re-checks visibility and all web/native input
        // blockers, so a composer or modal that still owns focus is preserved.
        terminalPaneRefs.current.get(paneId)?.focus();
      }
    });
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
      setRightBarCollapsedForPane(false, paneId);
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
    if (!activeBrowserOwnerId) {
      return;
    }
    setBrowserOverlayByPane((current) => {
      const prev = current[activeBrowserOwnerId];
      if (!prev) {
        return current;
      }
      return {
        ...current,
        [activeBrowserOwnerId]: { ...prev, reloadNonce: prev.reloadNonce + 1 },
      };
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
    const trimmed = rawInput.trim();
    if (!activeBrowserOwnerId || !trimmed) {
      return;
    }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    // The overlay can only render loopback http (CSP frame-src). Hand a typed external
    // URL to the OS browser rather than loading a blank, CSP-blocked iframe; the
    // external opener itself rejects anything but http(s)/mailto.
    if (canRenderInInternalBrowser(url)) {
      openBrowserOverlay(activeBrowserOwnerId, url);
    } else {
      void openExternalUrl(url);
    }
  }

  // One stable LinkActions object per transcript owner. TurnOverlay and the
  // research document feed this into the shared provider. Context changes bypass
  // memoization — a fresh object per App render re-rendered every markdown link in the
  // transcript on every unrelated state change. Actions read the opener through
  // a ref so the cached closures never go stale.
  const openLinkForPaneRef = useRef(openLinkForPane);
  openLinkForPaneRef.current = openLinkForPane;
  const linkActionsByPaneRef = useRef(new Map<string, LinkActions>());
  // Closed panes never render again, so drop their cached actions.
  useEffect(() => {
    const livePaneIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of linkActionsByPaneRef.current.keys()) {
      // Research owners are exempt from pane-based eviction (they aren't
      // panes); the cached closures are tiny and a session's tree count is
      // small, so they're simply retained.
      if (!paneId.startsWith(RESEARCH_BROWSER_OWNER_PREFIX) && !livePaneIds.has(paneId)) {
        linkActionsByPaneRef.current.delete(paneId);
      }
    }
  }, [panes]);
  function linkActionsForPane(paneId: string): LinkActions {
    const cache = linkActionsByPaneRef.current;
    let actions = cache.get(paneId);
    if (!actions) {
      actions = {
        openLink: (url) => {
          openLinkForPaneRef.current(paneId, url);
        },
        openLinkMenu: (url, x, y) => setLinkMenu({ url, x, y, paneId }),
      };
      cache.set(paneId, actions);
    }
    return actions;
  }

  function turnInfoForAgent(agent: AgentInfo | undefined): AgentTurnInfo {
    if (!agent) {
      return {
        turns: [],
        assistantLabel: "Claude",
        getTranscript: () => "",
        getPlainTextTranscript: () => "",
        hasTranscript: false,
      };
    }
    return (
      agentTurnInfoById.get(agent.id) ?? {
        turns: [],
        assistantLabel: getAgentUiAdapter(agent.adapter).label,
        getTranscript: () => "",
        getPlainTextTranscript: () => "",
        hasTranscript: false,
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
      getTranscript: turnInfo.getTranscript,
      getPlainTextTranscript: turnInfo.getPlainTextTranscript,
      hasTranscript: turnInfo.hasTranscript,
      transcriptNotice: agent ? (transcriptNoticeByAgent[agent.id] ?? null) : null,
      transcriptOptions: agent ? (transcriptOptionsByAgent[agent.id] ?? []) : [],
      queuedTurns: agent ? (queuedTurnsByAgent[agent.id] ?? []) : [],
      waitTargets: waitTargetsForAgent(agent),
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
  // The restore button floats over the native terminal surface, so its rect
  // must be registered with the native event router or its clicks would be
  // forwarded to Ghostty instead of the DOM.
  const floatingRestoreButtonVisible = rightBarCollapsed && activePaneHasTurnSidebar;
  const floatingRestoreButtonRef = useNativeWebOverlayRegion<HTMLButtonElement>(
    floatingRestoreButtonVisible,
  );
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
  const visibleTurnPaneAgentIds = visibleRightBarSurfaces
    .map((surface) => surface.agent?.id)
    .filter((agentId): agentId is string => Boolean(agentId));
  const visibleTurnPaneAgentIdsKey = visibleTurnPaneAgentIds.join("\0");
  const terminalPaneIsReadOnly = (pane: PaneInfo) =>
    groupById.get(pane.groupId)?.scope === "research" &&
    agentByPaneId.get(pane.id)?.status !== "awaitingPermission" &&
    agentByPaneId.get(pane.id)?.status !== "awaitingInput";
  const activePaneReadOnly = Boolean(activePane && terminalPaneIsReadOnly(activePane));
  // This is the shared hard-input policy for every visible native surface and
  // for the logical owner calculation below. Keeping it single-sourced avoids
  // a modal disabling pointer claims while the owner coordinator still grants
  // keyboard input (or vice versa).
  const nativeTerminalInputBlocked = Boolean(
    settingsOpen ||
      newResearchOpen ||
      newDocumentOpen ||
      publicationTarget ||
      // The palette and expanded/browser overlays must own both the DOM
      // gesture and keyboard while they cover the terminal stage.
      commandPaletteOpen ||
      activeTranscriptVisibleExpanded ||
      activeBrowserOverlay?.open ||
      closeDialog ||
      exitDialog ||
      exitPreflightRequest ||
      renamePaneId ||
      renameGroupId ||
      linkMenu ||
      paneContextMenu ||
      groupMenu ||
      settingsMenu ||
      // Drag/layout gestures and terminal-local search/confirm overlays also
      // revoke the desired owner until their web interaction completes.
      draggingPaneId !== null ||
      terminalGeometryResizing ||
      terminalOverlayBlockedPaneIds.size > 0,
  );
  const desiredNativeKeyboardOwner = desiredNativeTerminalKeyboardOwner({
    activePaneId: activePane?.id ?? null,
    paneSurfaceActive: activeSurface === "pane",
    activePaneVisible: Boolean(activePane && visibleTerminalPaneIdSet.has(activePane.id)),
    activePaneReadOnly,
    inputBlocked: nativeTerminalInputBlocked,
    webEditableFocused,
    webSelectionActive,
  });
  useLayoutEffect(() => {
    if (!IS_MAC) {
      return;
    }
    void setNativeTerminalKeyboardOwner(desiredNativeKeyboardOwner).catch(() => undefined);
  }, [desiredNativeKeyboardOwner]);
  // The body calls component-scoped helpers (turnInfoForAgent, displayPaneTitle,
  // paneTabStatus*, queuedTurnsForAgent, paneWaitsOnOtherPane) that are recreated
  // each render, so they are intentionally NOT in the dep array. Instead we depend
  // on the state atoms those helpers read — keep this list in sync when a helper
  // starts reading new state, or the memo will serve stale workstreams.
  const homeCascadeWorkstreams = useMemo<HomeCascadeWorkstream[]>(() => {
    // Only Home renders the cascades, but this memo's inputs churn with every
    // event batch — recomputing the per-agent latest-turn extraction (a regex
    // pass over each latest user message) for a hidden Home was pure waste.
    if (!homeActive) {
      return [];
    }
    return sidebarPanes.flatMap((pane) => {
      const agent = agentByPaneId.get(pane.id);
      if (!agent) {
        return [];
      }
      const statusClass = agent.status === "awaitingInput" ? "status-awaiting-input" : "";
      const turnInfo = turnInfoForAgent(agent);
      return [
        {
          agentId: agent.id,
          paneId: pane.id,
          title: displayPaneTitle(pane, agent),
          statusTone: paneTabStatusTone(agent),
          statusClass,
          waitingOnPane: paneWaitsOnOtherPane(agent),
          latestUserTurn: cascadeLatestUserTurn(turnInfo.turns),
          queuedTurns: (queuedTurnsByAgent[agent.id] ?? []).map((turn) => ({
            text: cascadeQueuedTurnText(turn.text),
            pauseAfter: turn.pauseAfter,
            waitForAgentId: turn.waitFor?.agentId ?? null,
            waitForLabel: turn.waitFor?.label ?? null,
          })),
        },
      ];
    });
  }, [
    agentByPaneId,
    agentTurnInfoById,
    homeActive,
    queuedTurnsByAgent,
    sidebarPanes,
    terminalTitleByPane,
  ]);

  // Load session lists when a pane's right side is visible so transcript pickers are ready.
  useEffect(() => {
    for (const agentId of visibleTurnPaneAgentIds) {
      void refreshTranscriptOptions(agentId);
    }
    // refreshTranscriptOptions only touches stable setters/imports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTurnPaneAgentIdsKey]);

  // Content-unchanged rebuilds are already rare here: the agents array keeps
  // its identity across no-op hook events (upsertAgent bails out), terminal
  // titles commit on a debounce, and the JSON comparison below gates the IPC
  // and AppKit rebuild. What remains is a small O(panes) structure per real
  // change, sharing the app-level agentByPaneId map instead of rebuilding one.
  const menuBarSnapshot = useMemo<MenuBarSnapshot>(() => {
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

    const snapshotGroups = terminalGroups.map((group) => ({
      id: group.id,
      label: group.nameOverride?.trim() || middleTruncatePath(formatPaneDir(groupRootDir(group))),
      tabs: sidebarPanes.filter((pane) => pane.groupId === group.id).map(tabForPane),
    }));
    const orphanTabs = sidebarPanes
      .filter((pane) => !groupedPaneIds.has(pane.id))
      .map(tabForPane);
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
    agentByPaneId,
    config,
    sidebarPanes,
    manuallyTitledPaneIds,
    terminalGroups,
    queuedTurnsByAgent,
    settings.codeMode,
    settings.showTabDirectories,
    terminalTitleByPane,
  ]);

  // The snapshot memo recomputes whenever any input's identity changes (agents
  // churn on every status hook), but the tray only needs an IPC — and AppKit
  // only needs a full menu rebuild — when the visible content actually changed.
  const lastMenuBarSnapshotJsonRef = useRef<string | null>(null);
  useEffect(() => {
    const json = JSON.stringify(menuBarSnapshot);
    if (json === lastMenuBarSnapshotJsonRef.current) {
      return;
    }
    lastMenuBarSnapshotJsonRef.current = json;
    void updateMenuBar(menuBarSnapshot).catch(() => undefined);
  }, [menuBarSnapshot]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  function replaceQueuedTurnsByAgent(nextQueues: Record<string, QueuedTurn[]>) {
    queuedTurnsByAgentRef.current = nextQueues;
    setQueuedTurnsByAgentState(nextQueues);
  }

  function setAgentQueuedTurns(agentId: string, queuedTurns: QueuedTurn[]) {
    // Any write advances the agent's queue generation so a slower in-flight
    // refreshAgentTurnQueue() sees it was superseded and drops its stale list.
    agentTurnQueueSeqRef.current[agentId] = (agentTurnQueueSeqRef.current[agentId] ?? 0) + 1;
    const previousQueues = queuedTurnsByAgentRef.current;
    const nextQueues = {
      ...previousQueues,
      [agentId]: queuedTurns,
    };
    queuedTurnsByAgentRef.current = nextQueues;
    setQueuedTurnsByAgentState(nextQueues);
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

  // Composer-local edit flushers, registered by each mounted NativeInput. The
  // composer holds keystrokes locally behind a short debounce, so a quit/close
  // flush must first pull those edits into draftsByAgentRef before writing to
  // disk — otherwise the last moments of typing are invisible to it.
  const composerDraftFlushersRef = useRef(new Set<() => void>());
  const registerComposerDraftFlusher = useCallback((flush: () => void) => {
    composerDraftFlushersRef.current.add(flush);
    return () => {
      composerDraftFlushersRef.current.delete(flush);
    };
  }, []);

  // Flushes every still-pending debounced draft right now (used when the window is
  // going away, so the last second of typing is not lost on a quick close).
  function flushPendingDrafts() {
    // Drain composer-local edits first; each flusher synchronously pushes into
    // draftsByAgentRef (and re-arms a disk timer that the loop below collects).
    for (const flush of composerDraftFlushersRef.current) {
      flush();
    }
    const timers = draftFlushTimersRef.current;
    for (const [agentId, timer] of Object.entries(timers)) {
      clearTimeout(timer);
      delete timers[agentId];
      void persistAgentDraft(agentId, draftsByAgentRef.current[agentId] ?? "").catch(
        () => undefined,
      );
    }
  }

  // Normalizes an absolute path for display by anchoring home-relative paths
  // with ~. Unlike formatPaneDir, the rest of the path is kept intact — used
  // where the full location matters (e.g. the prompt library's Project hint).
  function homeRelativePath(rawPath: string | null): string | null {
    if (!rawPath) {
      return null;
    }
    const homeDir = config?.homeDir;
    if (homeDir && rawPath === homeDir) {
      return "~";
    }
    if (homeDir && rawPath.startsWith(`${homeDir}/`)) {
      return `~/${rawPath.slice(homeDir.length + 1)}`;
    }
    return rawPath;
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

  // The directory a group's default title reflects: its root terminal (the first,
  // oldest shell pane in the group), falling back to the group's creation-time seed
  // dir when the group has no shell pane yet (empty, or agent-only — whose worktree
  // dirs shouldn't name the group). Groups are advisory, so the title tracks where
  // the group's work is rooted rather than a fixed stored directory, and is stable
  // against focus changes. Reactive: a cd in the root terminal patches panes[].cwd
  // (pane.cwd_changed), and closing it promotes the next shell — both re-derive here.
  function groupRootDir(group: GroupInfo): string {
    const rootShell = panes.find(
      (pane) => pane.groupId === group.id && pane.kind === "shell",
    );
    return rootShell?.cwd || group.dir;
  }

  function defaultGroupName(group: GroupInfo): string {
    const dir = groupRootDir(group);
    const base = dir.split("/").filter(Boolean).pop();
    return base && base.length > 0 ? base : formatPaneDir(dir);
  }

  function displayGroupName(group: GroupInfo): string {
    return group.nameOverride?.trim() || defaultGroupName(group);
  }

  function launchGroupId() {
    if (
      activePane?.groupId &&
      groupById.get(activePane.groupId)?.scope === "terminal"
    ) {
      return activePane.groupId;
    }
    if (
      lastActiveGroupId &&
      groupById.get(lastActiveGroupId)?.scope === "terminal"
    ) {
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

  function panesWithNewTabInLaunchPosition(
    pane: PaneInfo,
    targetGroupId: string | null,
  ): PaneInfo[] {
    const siblingPaneId = insertionSiblingForNewTab(targetGroupId);
    return placePaneAfterOptimistically(pane, siblingPaneId);
  }

  // Computes the spawned pane's position locally and returns the reordered
  // list without waiting for the backend to persist that order, so the new
  // pane mounts — and its terminal becomes visible — one IPC round-trip
  // sooner. The backend's authoritative result reconciles the list when it
  // arrives; if persisting fails (e.g. the pane already closed), the backend
  // keeps spawn (append) order and the next authoritative pane update applies
  // it here too, so the failure is deliberately not surfaced as a spawn error.
  function placePaneAfterOptimistically(
    pane: PaneInfo,
    siblingPaneId: string | null,
  ): PaneInfo[] {
    const current = panesRef.current.filter((existing) => existing.id !== pane.id);
    if (!siblingPaneId || siblingPaneId === pane.id) {
      return [...current, pane];
    }
    const siblingIndex = current.findIndex((existing) => existing.id === siblingPaneId);
    if (siblingIndex === -1) {
      return [...current, pane];
    }
    void placePaneAfter(pane.id, siblingPaneId)
      .then((orderedPanes) => setPanesPreservingRecoveredDismissals(orderedPanes))
      .catch(() => undefined);
    // Mirror the backend's placement: directly after the sibling, at the
    // sibling's nesting depth.
    const placed = { ...pane, depth: current[siblingIndex].depth };
    return [...current.slice(0, siblingIndex + 1), placed, ...current.slice(siblingIndex + 1)];
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

  async function createInitialShellForGroup(groupId: string) {
    const pane = await spawnShell(estimateInitialPaneSize(false), null, groupId);
    const orderedPanes = panesWithNewTabInLaunchPosition(pane, groupId);
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
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForPaintedFrame();
      const newGroup = await createGroupWithFolder(anchorGroup?.id ?? null);
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

  async function addShellPaneInGroup(groupId: string | null) {
    setError(null);
    try {
      const sourcePaneId =
        activePane?.kind === "shell" && activePane.groupId === groupId ? activePane.id : null;
      const pane = await spawnShell(estimateInitialPaneSize(false), sourcePaneId, groupId);
      const orderedPanes = panesWithNewTabInLaunchPosition(pane, groupId);
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
      const orderedPanes = placePaneAfterOptimistically(pane, sourcePane.id);
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
    const requestSeq = (agentTurnQueueSeqRef.current[agentId] ?? 0) + 1;
    agentTurnQueueSeqRef.current[agentId] = requestSeq;
    const queuedTurns = await listAgentTurnQueue(agentId);
    // A newer write (another refresh, or an event-driven queue update) landed while we
    // awaited, so our list is stale — drop it rather than overwrite fresher state.
    if (agentTurnQueueSeqRef.current[agentId] !== requestSeq) {
      return;
    }
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

  // Moves one queued turn from an agent's queue to another agent. Used both by the
  // recovered-queue panel and by dragging a queued card onto another split's cell.
  async function moveQueuedTurnToAgent(
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

  function paneIdsForSplitStatusGroup(paneId: string): string[] {
    const split = paneSplitForPane(paneSplitsRef.current, paneId);
    if (!split) {
      return [paneId];
    }
    const livePaneIds = new Set(panesRef.current.map((pane) => pane.id));
    const paneIds = split.paneIds.filter((candidate) => livePaneIds.has(candidate));
    return paneIds.length > 0 ? paneIds : [paneId];
  }

  function agentsForSplitStatusGroup(paneId: string): AgentInfo[] {
    const paneIds = new Set(paneIdsForSplitStatusGroup(paneId));
    return agentsRef.current.filter((agent) => agent.paneId && paneIds.has(agent.paneId));
  }

  function agentsForAgentStatusGroup(agentId: string): AgentInfo[] {
    const agent = agentsRef.current.find((candidate) => candidate.id === agentId);
    if (!agent) {
      return [];
    }
    if (!agent.paneId) {
      return [agent];
    }
    const groupedAgents = agentsForSplitStatusGroup(agent.paneId);
    return groupedAgents.length > 0 ? groupedAgents : [agent];
  }

  function replaceAgents(updatedAgents: AgentInfo[]) {
    if (updatedAgents.length === 0) {
      return;
    }
    const updatedById = new Map<string, AgentInfo>(
      updatedAgents.map((agent) => [agent.id, agent]),
    );
    setAgents((current) => current.map((agent) => updatedById.get(agent.id) ?? agent));
  }

  async function acknowledgeAgentStatuses(targetAgents: AgentInfo[], includeFailed = false) {
    const dismissibleAgents = targetAgents.filter(
      (agent) => agent.status === "done" || (includeFailed && agent.status === "failed"),
    );
    if (dismissibleAgents.length === 0) {
      return;
    }
    setError(null);
    try {
      replaceAgents(
        await Promise.all(
          dismissibleAgents.map((agent) => acknowledgeAgent(agent.id, includeFailed)),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function acknowledgeAgentStatus(agentId: string, includeFailed = false) {
    await acknowledgeAgentStatuses(agentsForAgentStatusGroup(agentId), includeFailed);
  }

  async function clearAgentWorkingIndicator(agentId: string) {
    const targetAgents = agentsForAgentStatusGroup(agentId).filter(
      (agent) => agent.status === "running" || agent.status === "starting",
    );
    if (targetAgents.length === 0) {
      return;
    }
    const targetAgentIds = targetAgents.map((agent) => agent.id);
    const targetAgentIdSet = new Set(targetAgentIds);
    setError(null);
    try {
      replaceAgents(await Promise.all(targetAgentIds.map((id) => clearAgentWorkingStatus(id))));
      setThinkingAgentIds((current) => {
        if (targetAgentIds.every((id) => !current.has(id))) {
          return current;
        }
        const next = new Set(current);
        for (const id of targetAgentIds) {
          next.delete(id);
        }
        return next;
      });
      setProcessingNewMessageByAgent((current) => {
        let changed = false;
        const next = { ...current };
        for (const id of targetAgentIdSet) {
          if (Object.prototype.hasOwnProperty.call(next, id)) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function acknowledgePaneIfDone(paneId: string | null) {
    if (!paneId || !document.hasFocus()) {
      return;
    }
    void acknowledgeAgentStatuses(agentsForSplitStatusGroup(paneId));
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
    // Keep the sidebar boundary on a whole CSS pixel so its 1px separator
    // cannot be antialiased across two adjacent pixel columns.
    return Math.round(clamp(width, LEFT_SIDEBAR_MIN_WIDTH, maxSidebarWidth()));
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
    "--font-ui": bodyFontFamily,
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

  // The fraction of the split container's height minus this track's share of the
  // gutters, as a CSS calc() term.
  function splitTrackExtent(fraction: number): string {
    const gutterCount = Math.max(0, (activePaneSplit?.paneIds.length ?? 1) - 1);
    const totalGutter = gutterCount * TERMINAL_SPLIT_GUTTER_PX;
    return `${fraction * 100}% - ${fraction * totalGutter}px`;
  }

  function splitTrackPosition(
    fraction: number,
    precedingGutters: number,
    inset = 0,
  ): string {
    return `calc(${splitTrackExtent(fraction)} + ${
      precedingGutters * TERMINAL_SPLIT_GUTTER_PX + inset
    }px)`;
  }

  function splitTrackSize(fraction: number): string {
    return `calc(${splitTrackExtent(fraction)})`;
  }

  // Which split panes reserve the inline turn-pane strip, keyed as a string so
  // the style memo below only invalidates when membership actually changes
  // (splitTurnPaneSurfaceByPaneId itself is rebuilt every render).
  const reservedInlineTurnPaneKey = rightBarCollapsed
    ? ""
    : splitTurnPaneSurfaces.map((surface) => surface.pane.id).join("\n");

  // Per-pane split styles with stable identities: TerminalPane receives the
  // style as a prop and lists it in its native layout-sync effect deps, so a
  // fresh object every render would defeat its memo and re-issue a layout FFI
  // call per visible pane on every unrelated App re-render.
  const terminalPaneStyleByPaneId = useMemo(() => {
    const styles = new Map<string, CSSProperties>();
    if (!activePaneSplit) {
      return styles;
    }
    const reservedInlineTurnPaneIds = new Set(
      reservedInlineTurnPaneKey ? reservedInlineTurnPaneKey.split("\n") : [],
    );
    activePaneSplit.paneIds.forEach((paneId, index) => {
      const top = activeSplitFractions
        .slice(0, index)
        .reduce((sum, value) => sum + value, 0);
      const height = activeSplitFractions[index] ?? 0;
      // Keep reserving the inline turn-pane width while the transcript is expanded:
      // the expanded overlay covers the whole stage, so the reserved strip is
      // invisible, and holding terminal geometry constant means expand/collapse
      // never resizes the PTY. A resize would SIGWINCH full-screen TUIs (Claude
      // Code clears and re-lays-out on every resize), losing their scroll position.
      styles.set(paneId, {
        top: splitTrackPosition(top, index),
        bottom: "auto",
        height: splitTrackSize(height),
        right: reservedInlineTurnPaneIds.has(paneId)
          ? "var(--inline-turn-pane-width)"
          : 0,
      });
    });
    return styles;
  }, [activePaneSplit, activeSplitFractions, reservedInlineTurnPaneKey]);

  function terminalPaneStyle(paneId: string): CSSProperties | undefined {
    return terminalPaneStyleByPaneId.get(paneId);
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
      top: splitTrackPosition(top, index),
      height: splitTrackSize(paneHeight / 2),
    };
  }

  const terminalSplitDropStyle = terminalSplitDropPlaceholderStyle();

  const terminalSplitDividerOffsets = activePaneSplit
    ? activePaneSplit.paneIds.slice(0, -1).map((_, index) =>
        activeSplitFractions.slice(0, index + 1).reduce((sum, value) => sum + value, 0),
      )
    : [];

  function terminalSplitDividerStyle(offset: number, index: number): CSSProperties {
    return {
      top: splitTrackPosition(offset, index),
      height: TERMINAL_SPLIT_GUTTER_PX,
    };
  }

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

    const contentHeight =
      stageHeight - Math.max(0, split.paneIds.length - 1) * TERMINAL_SPLIT_GUTTER_PX;
    if (contentHeight <= 0) {
      return;
    }

    const releasePointer = claimResizePointer(event);
    let latestSplit = split;
    setTerminalGeometryResizing(true);
    terminalSplitResizeRef.current = {
      splitId: split.id,
      dividerIndex,
      startY: event.clientY,
      stageHeight: contentHeight,
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
      releasePointer();
      terminalSplitResizeRef.current = null;
      setTerminalGeometryResizing(false);
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
    ? Object.prototype.hasOwnProperty.call(terminalTitleByPane, contextMenuPane.id)
      ? terminalTitleByPane[contextMenuPane.id]
      : (contextMenuPane.lastOscTitle ?? null)
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
  const canForkContextMenuPane = agentCanFork(contextMenuAgent);

  useEffect(() => {
    let cancelled = false;

    // Everything the first paint doesn't need, hydrated detached after the
    // window is revealed so startup is gated only by the pane/group/agent
    // snapshot. Two independent passes: the fast one (settings, per-agent
    // queues and drafts — small map lookups) applies within milliseconds, and
    // the heavy one (the turn store — whole transcripts including tool
    // results, by far the largest boot payload — plus thread graphs) fills in
    // whenever it lands. Keeping them independent matters: the user can
    // interact the moment the window shows, so the fast pass must not wait on
    // listTurns, and everything it applies merges UNDER live state rather than
    // clobbering edits or events that arrived while the snapshot was in
    // flight.
    async function hydrateSecondaryFast(existingAgents: AgentInfo[]) {
      try {
        const [
          storedOpenRouterKey,
          storedUseLoginShell,
          storedWorktreeLocation,
          queueEntries,
          draftEntries,
        ] =
          await Promise.all([
            getOpenRouterKey().catch(() => ""),
            getUseLoginShell().catch((): boolean | null => null),
            getWorktreeLocation().catch((): AppSettings["worktreeLocation"] | null => null),
            // Per-agent fetches are individually guarded so one failed
            // draft/queue read just falls back to empty for that agent.
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
                  [
                    agent.id,
                    await getAgentDraft(agent.id).catch((): string | null => null),
                  ] as const,
              ),
            ),
          ]);
        if (cancelled) {
          return;
        }

        // Hydrate the OpenRouter key from the backend (its durable home). If the backend
        // has none but a key survives in an old localStorage settings blob, migrate that
        // value into the backend once; either way the in-memory settings track the key.
        setSettings((current) => {
          const backendKey = storedOpenRouterKey.trim();
          const migratedKey = current.openRouterKey.trim();
          const effectiveKey = backendKey || migratedKey;
          const effectiveUseLoginShell = storedUseLoginShell ?? current.useLoginShell;
          const effectiveWorktreeLocation =
            storedWorktreeLocation ?? current.worktreeLocation;
          if (!backendKey && migratedKey) {
            void setOpenRouterKey(migratedKey).catch(() => undefined);
          }
          openRouterKeyHydratedRef.current = true;
          useLoginShellHydratedRef.current = true;
          worktreeLocationHydratedRef.current = true;
          return current.openRouterKey === effectiveKey &&
            current.useLoginShell === effectiveUseLoginShell &&
            current.worktreeLocation === effectiveWorktreeLocation
            ? current
            : {
                ...current,
                openRouterKey: effectiveKey,
                useLoginShell: effectiveUseLoginShell,
                worktreeLocation: effectiveWorktreeLocation,
              };
        });

        // Live entries win over the snapshot: a queue event or a draft the
        // user already typed since the window appeared is fresher than the
        // boot-time disk state, and clobbering a live draft would erase text
        // mid-composition (and then persist the stale value).
        replaceQueuedTurnsByAgent({
          ...Object.fromEntries(queueEntries),
          ...queuedTurnsByAgentRef.current,
        });
        const restoredDrafts = {
          ...Object.fromEntries(
            draftEntries.filter((entry): entry is [string, string] => Boolean(entry[1])),
          ),
          ...draftsByAgentRef.current,
        };
        draftsByAgentRef.current = restoredDrafts;
        setDraftsByAgentState(restoredDrafts);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    async function hydrateSecondaryHeavy() {
      try {
        const [existingTurns, existingThreadGraphs] = await Promise.all([
          listTurns(),
          listThreadGraphs().catch((): ThreadGraph[] => []),
        ]);
        if (cancelled) {
          return;
        }
        // The event stream is already live while this snapshot was in flight,
        // so keep any turns it appended in the meantime instead of clobbering
        // them with the (marginally older) snapshot.
        setTurns((current) => {
          const seen = new Set(existingTurns.map((turn) => turn.id));
          const extras = current.filter((turn) => !seen.has(turn.id));
          return extras.length === 0 ? existingTurns : [...existingTurns, ...extras];
        });
        setThreadGraphs(existingThreadGraphs);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

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
          existingResearchTrees,
          existingResearchActivity,
          existingPublications,
        ] = await Promise.all([
          getRuntimeConfig(),
          getLauncherAdapterPreference().catch(() => null),
          getActiveTab().catch(() => null),
          listGroups().catch((): GroupInfo[] => []),
          listPanes(),
          getPaneSplits().catch((): PaneSplitInfo[] => []),
          listAgents(),
          listResearchTrees(true).catch((): ResearchTreeSummary[] => []),
          listResearchActivity().catch((): ResearchNode[] => []),
          listPublications().catch((): PublicationBinding[] => []),
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
        const partitionedResearchTrees = partitionResearchTrees(existingResearchTrees);
        setResearchTrees(partitionedResearchTrees.active);
        setArchivedResearchTrees(partitionedResearchTrees.archived);
        setResearchActivity(existingResearchActivity);
        setPublicationBindings(existingPublications);
        void hydrateSecondaryFast(existingAgents);
        void hydrateSecondaryHeavy();
        const savedResearchTreeId = localStorage.getItem(ACTIVE_RESEARCH_TREE_KEY);
        const restoredResearchScope = resolveResearchScope(
          localStorage.getItem(RESEARCH_FOLDER_SCOPE_KEY),
          groupsForScope(existingGroups, "research"),
        );
        const allResearchTrees = [
          ...partitionedResearchTrees.active,
          ...partitionedResearchTrees.archived,
        ];
        const researchTreeToRestore = savedResearchTreeId
          ? sidebarModeRef.current === "research"
            ? treeForResearchScope(
                allResearchTrees,
                restoredResearchScope,
                savedResearchTreeId,
              )
            : allResearchTrees.find((tree) => tree.id === savedResearchTreeId) ?? null
          : null;
        const restoreResearchSelection = async () => {
          if (!researchTreeToRestore || cancelled) {
            if (savedResearchTreeId) {
              localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
            }
            if (!cancelled && sidebarModeRef.current === "research") {
              activeResearchTreeIdRef.current = null;
              setActiveResearchTreeId(null);
              setActiveResearchDetail(null);
              setActiveResearchDetailError(null);
              activeResearchPaneIdRef.current = null;
              setActiveResearchPaneId(null);
              localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
              setActiveSurface("research");
            }
            return;
          }
          try {
            const detail = await getResearchTree(researchTreeToRestore.id);
            if (!cancelled) {
              setActiveResearchTreeId(researchTreeToRestore.id);
              localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
              setActiveResearchDetail(detail);
              const restoredResearchPaneId = localStorage.getItem(ACTIVE_RESEARCH_PANE_KEY);
              const restoredResearchPane = existingPanes.find(
                (pane) =>
                  pane.id === restoredResearchPaneId &&
                  existingGroups.find((group) => group.id === pane.groupId)?.scope === "research" &&
                  workspaceIsInResearchScope(pane.groupId, restoredResearchScope),
              );
              if (sidebarModeRef.current === "research" && restoredResearchPane) {
                activeResearchPaneIdRef.current = restoredResearchPane.id;
                setActiveResearchPaneId(restoredResearchPane.id);
                activePaneIdRef.current = restoredResearchPane.id;
                setActivePaneIdState(restoredResearchPane.id);
                setActiveSurface("pane");
              } else if (sidebarModeRef.current === "research") {
                setActiveSurface("research");
                if (
                  researchDocumentIsVisible(
                    researchTreeToRestore.id,
                    sidebarModeRef.current,
                    "research",
                    researchTreeToRestore.id,
                  )
                ) {
                  void markResearchTreeViewed(researchTreeToRestore.id)
                    .then(() => {
                      setResearchTrees((current) =>
                        current.map((tree) =>
                          tree.id === researchTreeToRestore.id
                            ? { ...tree, hasUnseenUpdate: false, hasUnseenFailure: false }
                            : tree,
                        ),
                      );
                    })
                    .catch(() => undefined);
                }
              }
            }
          } catch (err) {
            // Mirror selectResearchTree's failure path when booting into
            // Research mode: keep the selection and surface the error inside
            // the document (which has a working Retry) — silently dropping
            // the key left the Research sidebar paired with a terminal pane
            // on the stage and nothing able to recover. A later navigation
            // refresh clears the selection if the tree is truly gone.
            if (!cancelled && sidebarModeRef.current === "research") {
              setActiveResearchTreeId(researchTreeToRestore.id);
              localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
              setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
              setActiveSurface("research");
            } else {
              localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
            }
          }
        };

        const existingTerminalPanes = panesForScope(existingPanes, existingGroups, "terminal");
        if (existingTerminalPanes.length > 0) {
          const restoredActivePane =
            preferredActiveTabId && preferredActiveTabId !== HOME_TAB_ID
              ? existingTerminalPanes.find((pane) => pane.id === preferredActiveTabId)
              : undefined;
          const fallbackPane = restoredActivePane ?? existingTerminalPanes[0];
          const nextActivePaneId =
            preferredActiveTabId === HOME_TAB_ID ? HOME_TAB_ID : fallbackPane.id;
          setPanesPreservingRecoveredDismissals(existingPanes);
          activePaneIdRef.current = nextActivePaneId;
          setActivePaneIdState(nextActivePaneId);
          lastTerminalTabIdRef.current = nextActivePaneId;
          setLastActiveGroupId(fallbackPane.groupId);
          activeTabPersistenceReadyRef.current = true;
          await restoreResearchSelection();
          return;
        }

        if (!cancelled) {
          // An empty installation starts on Home. Creating a shell is an explicit
          // user action, which lets a first-time user enter Research without qmux
          // manufacturing an unrelated Terminal workspace first.
          setPanesPreservingRecoveredDismissals(existingPanes);
          activePaneIdRef.current = HOME_TAB_ID;
          setActivePaneIdState(HOME_TAB_ID);
          lastTerminalTabIdRef.current = HOME_TAB_ID;
          activeTabPersistenceReadyRef.current = true;
          await restoreResearchSelection();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    // Reveal the hidden-at-boot window whether boot succeeded or threw — the
    // error banner is exactly what the user must see on a failed boot. The
    // effect-cancelled rerun (StrictMode, remount) leaves showing to the run
    // that actually completes; the backend watchdog covers a hung boot.
    void boot().finally(() => {
      if (!cancelled) {
        void markAppWindowReady().catch(() => undefined);
      }
    });

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
    if (!activePaneId) {
      return;
    }
    const paneIds = new Set(paneIdsForSplitStatusGroup(activePaneId));
    if (panes.some((pane) => pane.recovered && paneIds.has(pane.id))) {
      dismissRecoveredBadge(activePaneId);
    }
  }, [activePaneId, paneSplits, panes]);

  // Switching back from Research can restore the same terminal pane ID, so the
  // sidebar mode must also trigger this after the terminal rows are rendered.
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
  }, [activePaneId, sidebarMode]);

  // Report the focused pane to the backend so it can stamp `last_active_at`, which
  // feeds the group's spawn-cwd heuristic (most-recently-active shell pane). One
  // effect for every setActivePaneId call site; the Home tab is not a real pane.
  useEffect(() => {
    if (!activePaneId || activePaneId === HOME_TAB_ID) {
      return;
    }
    void activatePane(activePaneId).catch(() => {});
  }, [activePaneId]);

  useEffect(() => {
    const handleFocus = () => acknowledgePaneIfDone(activePaneId);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [activePaneId]);

  // Flushes a pane's pre-attach output backlog, retrying on failure. attachPane is
  // idempotent (a repeat call is a no-op once the pane is already flushed), so retrying
  // can't double-deliver output. A silently-swallowed failure here used to leave the
  // terminal blank with no backlog and no recovery; instead we retry with backoff to
  // ride out a transient race, and surface a persistent failure — but only when the pane
  // is still open, since a pane that closed in the meantime failing to attach is expected.
  const attachPaneWithRetry = useCallback((paneId: string) => {
    const attempt = (remaining: number, delayMs: number) => {
      void attachPane(paneId).catch((err) => {
        if (remaining <= 0) {
          const stillOpen = panesRef.current.some((pane) => pane.id === paneId);
          console.error(
            `qmux: failed to attach pane ${paneId}${stillOpen ? "" : " (pane already closed)"}:`,
            err,
          );
          if (stillOpen) {
            setError("A terminal couldn't finish loading its output — reselect the tab to retry.");
          }
          return;
        }
        window.setTimeout(
          () => attempt(remaining - 1, Math.min(delayMs * 2, ATTACH_MAX_RETRY_MS)),
          delayMs,
        );
      });
    };
    attempt(ATTACH_MAX_RETRIES, ATTACH_INITIAL_RETRY_MS);
  }, []);

  // Releases a pane's pre-attach output backlog. While the backend subscription is
  // still being set up, the request is parked and flushed by handleEventsReady, so
  // no cold-start output is delivered before a listener exists to receive it.
  const requestPaneAttach = useCallback(
    (paneId: string) => {
      if (eventsReadyRef.current) {
        attachPaneWithRetry(paneId);
      } else {
        pendingAttachRef.current.add(paneId);
      }
    },
    [attachPaneWithRetry],
  );

  const hydrateShellAgentJobs = useCallback(async () => {
    // Subscribe first, then hydrate. If a foreground/background transition lands
    // while the snapshot is in flight, retry instead of letting that older snapshot
    // overwrite the live event (or dropping some other recovered job entirely).
    for (;;) {
      const eventVersion = shellJobEventVersionRef.current;
      const jobs = await listShellAgentJobs();
      if (eventVersion !== shellJobEventVersionRef.current) {
        continue;
      }
      setShellJobByAgent(Object.fromEntries(jobs.map((job) => [job.agentId, job])));
      return;
    }
  }, []);

  const handleEventsReady = useCallback(() => {
    eventsReadyRef.current = true;
    const pending = pendingAttachRef.current;
    pendingAttachRef.current = new Set();
    for (const paneId of pending) {
      attachPaneWithRetry(paneId);
    }
    void hydrateShellAgentJobs().catch(() => undefined);
  }, [attachPaneWithRetry, hydrateShellAgentJobs]);

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

  const openNativeTerminalSearch = useCallback((paneId: string) => {
    terminalPaneRefs.current.get(paneId)?.openSearch();
  }, []);
  const requestNativeTerminalPaste = useCallback((paneId: string, text: string | null) => {
    terminalPaneRefs.current.get(paneId)?.requestPaste(text);
  }, []);
  const reportNativeTerminalInput = useCallback((paneId: string) => {
    terminalPaneRefs.current.get(paneId)?.reportUserInput();
  }, []);
  const activateTerminalPane = useCallback((paneId: string) => {
    setActivePaneId(paneId);
  }, []);
  const clearResearchUnseen = useCallback((treeId: string) => {
    // Both attention flags: viewing acknowledges failures exactly like
    // ordinary settlements (the backend clears both by advancing
    // last_viewed_at). Clearing only the update dot left the sidebar and
    // mode-toggle "!" lit forever — mark_research_tree_viewed emits no
    // event, so no refetch ever corrected the local copy.
    const clear = (trees: ResearchTreeSummary[]) =>
      trees.map((tree) =>
        tree.id === treeId && (tree.hasUnseenUpdate || tree.hasUnseenFailure)
          ? { ...tree, hasUnseenUpdate: false, hasUnseenFailure: false }
          : tree,
      );
    setResearchTrees(clear);
    setArchivedResearchTrees(clear);
  }, []);
  const refreshResearchNavigation = useCallback(async () => {
    // Bump-and-check like every other refetch here (agents, panes, groups,
    // the research detail): refreshes overlap — the debounced event refresh
    // races the direct calls from archive/remove/submit — and the two list
    // invokes below resolve independently, so without the guard a slower,
    // older snapshot can be applied last and sit there (a stale "running"
    // badge, a resurrected unseen flag, a re-listed removed tree) until the
    // next research event.
    const requestSeq = researchNavRefreshSeqRef.current + 1;
    researchNavRefreshSeqRef.current = requestSeq;
    researchNavRefreshInFlightRef.current += 1;
    try {
      const [trees, activity] = await Promise.all([
        listResearchTrees(true),
        listResearchActivity(),
      ]);
      if (researchNavRefreshSeqRef.current !== requestSeq) {
        return;
      }
      const partitioned = partitionResearchTrees(trees);
      setResearchTrees(partitioned.active);
      setArchivedResearchTrees(partitioned.archived);
      setResearchActivity(activity);
      // The backend can remove the selected tree out from under the UI (a root
      // launch that failed removes its never-launched tree). Left selected, the
      // document would spin on a tree that no longer exists with nothing able to
      // recover it — clear the selection so the empty state takes over.
      const activeTreeId = activeResearchTreeIdRef.current;
      if (activeTreeId && !trees.some((tree) => tree.id === activeTreeId)) {
        activeResearchTreeIdRef.current = null;
        setActiveResearchTreeId(null);
        setActiveResearchDetail(null);
        setActiveResearchDetailError(null);
        localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
      }
      // Navigation restoration state for trees that no longer exist would
      // otherwise accumulate in localStorage forever.
      pruneResearchNavigation(trees.map((tree) => tree.id));
    } finally {
      researchNavRefreshInFlightRef.current -= 1;
    }
  }, []);
  const applyResearchTreeOrder = useCallback(
    (archived: boolean, workspaceId: string, orderedTreeIds: string[]) => {
      const current = archived
        ? archivedResearchTreesRef.current
        : researchTreesRef.current;
      const currentScopedIds = current
        .filter((tree) => tree.workspaceId === workspaceId)
        .map((tree) => tree.id);
      if (sameStringList(currentScopedIds, orderedTreeIds)) {
        return;
      }
      const next = replaceResearchTreeScopeOrder(current, workspaceId, orderedTreeIds);
      if (next === current) {
        return;
      }
      if (archived) {
        archivedResearchTreesRef.current = next;
        setArchivedResearchTrees(next);
      } else {
        researchTreesRef.current = next;
        setResearchTrees(next);
      }

      const requestSeq = researchTreeReorderRequestSeqRef.current + 1;
      researchTreeReorderRequestSeqRef.current = requestSeq;
      // Invalidate a navigation refresh that started before this optimistic
      // move; its pre-reorder list must not snap the row back mid-drag.
      researchNavRefreshSeqRef.current += 1;
      const persist = researchTreeReorderPersistChainRef.current
        .catch(() => undefined)
        .then(() => reorderResearchTrees(workspaceId, archived, orderedTreeIds));
      researchTreeReorderPersistChainRef.current = persist
        .then(() => {
          if (researchTreeReorderRequestSeqRef.current === requestSeq) {
            void refreshResearchNavigation().catch(() => undefined);
          }
        })
        .catch(() => {
          if (researchTreeReorderRequestSeqRef.current !== requestSeq) {
            return;
          }
          void refreshResearchNavigation().catch(() => undefined);
        });
    },
    [refreshResearchNavigation],
  );
  const moveActiveResearchTree = useCallback(
    (direction: -1 | 1) => {
      if (sidebarModeRef.current !== "research") {
        return;
      }
      const treeId = activeResearchTreeIdRef.current;
      if (!treeId) {
        return;
      }
      const archived = archivedResearchTreesRef.current.some((tree) => tree.id === treeId);
      const current = archived
        ? archivedResearchTreesRef.current
        : researchTreesRef.current;
      const tree = current.find((candidate) => candidate.id === treeId);
      if (!tree) {
        return;
      }
      const scopedIds = current
        .filter((candidate) => candidate.workspaceId === tree.workspaceId)
        .map((candidate) => candidate.id);
      const nextIds = moveResearchTreeIdBy(scopedIds, treeId, direction);
      if (nextIds !== scopedIds) {
        applyResearchTreeOrder(archived, tree.workspaceId, nextIds);
      }
    },
    [applyResearchTreeOrder],
  );
  const markVisibleResearchTreeViewed = useCallback(
    async (treeId: string) => {
      const documentVisible = researchDocumentIsVisible(
        treeId,
        sidebarModeRef.current,
        activeSurfaceRef.current,
        activeResearchTreeIdRef.current,
      );
      // Watching the run's own terminal counts as viewing the tree: the user
      // reached that pane from this document and is looking at the same run,
      // so the unseen badge must not survive it.
      const activePaneId = activePaneIdRef.current;
      const paneVisible =
        sidebarModeRef.current === "research" &&
        activeSurfaceRef.current === "pane" &&
        activeResearchTreeIdRef.current === treeId &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        activePaneId !== null &&
        researchNodeByPaneIdRef.current.get(activePaneId)?.treeId === treeId;
      if (!documentVisible && !paneVisible) {
        return;
      }
      const hadUnseen = [
        ...researchTreesRef.current,
        ...archivedResearchTreesRef.current,
      ].some(
        (tree) => tree.id === treeId && (tree.hasUnseenUpdate || tree.hasUnseenFailure),
      );
      await markResearchTreeViewed(treeId);
      // A refresh can already hold a pre-view snapshot even when its unseen
      // flag has not reached React state yet. Capture that after the mark
      // completes: if the request finishes before this continuation, the
      // local clear below corrects its result; if it is still running, the
      // replacement refresh supersedes it by sequence number.
      const staleNavigationMayStillLand = researchNavRefreshInFlightRef.current > 0;
      clearResearchUnseen(treeId);
      // A navigation refresh started before the view was recorded holds a
      // snapshot with the badges still lit; applied after the local clear it
      // would resurrect them — and with the run settled, no later event would
      // ever correct it. Refetch when a badge was already lit or a navigation
      // request can still land: the fresh request supersedes any pre-view
      // snapshot (bump-and-check above) and carries the acknowledged flags.
      // With neither condition, streaming traffic avoids a duplicate fetch.
      if (hadUnseen || staleNavigationMayStillLand) {
        void refreshResearchNavigation().catch(() => undefined);
      }
    },
    [clearResearchUnseen, refreshResearchNavigation],
  );
  useEffect(() => {
    const markCurrent = () => {
      const treeId = activeResearchTreeIdRef.current;
      if (treeId) {
        void markVisibleResearchTreeViewed(treeId).catch(() => undefined);
      }
    };
    window.addEventListener("focus", markCurrent);
    document.addEventListener("visibilitychange", markCurrent);
    return () => {
      window.removeEventListener("focus", markCurrent);
      document.removeEventListener("visibilitychange", markCurrent);
    };
  }, [markVisibleResearchTreeViewed]);
  const selectResearchTree = useCallback(async (treeId: string) => {
    const requestSeq = researchDetailRequestSeqRef.current + 1;
    researchDetailRequestSeqRef.current = requestSeq;
    setSidebarMode("research");
    setActiveSurface("research");
    activeResearchPaneIdRef.current = null;
    setActiveResearchPaneId(null);
    localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    activeResearchTreeIdRef.current = treeId;
    setActiveResearchTreeId(treeId);
    localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, treeId);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    try {
      const detail = await getResearchTree(treeId);
      if (
        researchDetailRequestSeqRef.current === requestSeq &&
        activeResearchTreeIdRef.current === treeId
      ) {
        setActiveResearchDetail(detail);
        // Selection can arrive from outside the scoped sidebar (archive
        // restore, a remembered tree on mode switch). Follow it with the
        // folder scope, or the document would show a tree the sidebar
        // doesn't list — with nothing highlighted anywhere.
        if (researchScopeRef.current !== detail.tree.workspaceId) {
          changeResearchFolderScope(detail.tree.workspaceId);
        }
        void markVisibleResearchTreeViewed(treeId).catch(() => undefined);
      }
    } catch (err) {
      // Surfaced inside the document (with a working Retry) rather than as a
      // global banner: without detail the document has no node to load, so
      // the error and its recovery belong where the user is looking.
      if (
        researchDetailRequestSeqRef.current === requestSeq &&
        activeResearchTreeIdRef.current === treeId
      ) {
        setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [changeResearchFolderScope, markVisibleResearchTreeViewed, setSidebarMode]);
  const retryActiveResearchDetail = useCallback(() => {
    const treeId = activeResearchTreeIdRef.current;
    if (treeId) {
      void selectResearchTree(treeId);
    }
  }, [selectResearchTree]);
  const focusResearchHome = useCallback(() => {
    // Invalidate a tree request that may still be landing while Home is
    // selected; otherwise its detail can repaint behind the launcher.
    researchDetailRequestSeqRef.current += 1;
    setSidebarMode("research");
    setActiveSurface("research");
    activeResearchPaneIdRef.current = null;
    setActiveResearchPaneId(null);
    localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    activeResearchTreeIdRef.current = null;
    setActiveResearchTreeId(null);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
  }, [setActiveSurface, setSidebarMode]);
  const changeSidebarMode = useCallback(
    (mode: SidebarMode) => {
      setPaneContextMenu(null);
      setGroupMenu(null);
      setSettingsMenu(null);
      if (mode === "terminal") {
        const target = terminalTabForMode(
          panesRef.current,
          groupsRef.current,
          lastTerminalTabIdRef.current,
          HOME_TAB_ID,
        );
        if (target === HOME_TAB_ID) {
          focusHomeTab();
        } else {
          focusPaneTab(target);
        }
        return;
      }

      setSidebarMode("research");
      const researchPaneId = activeResearchPaneIdRef.current;
      const researchPane = panesRef.current.find((pane) => pane.id === researchPaneId);
      if (
        researchPane &&
        groupsRef.current.find((group) => group.id === researchPane.groupId)?.scope === "research" &&
        workspaceIsInResearchScope(researchPane.groupId, researchScopeRef.current)
      ) {
        focusPaneTab(researchPane.id);
        return;
      }
      setActiveSurface("research");
      const currentTreeId = activeResearchTreeIdRef.current;
      if (!currentTreeId) {
        focusResearchHome();
        return;
      }
      const tree = treeForResearchScope(
        [...researchTrees, ...archivedResearchTrees],
        researchScopeRef.current,
        currentTreeId,
      );
      if (tree) {
        void selectResearchTree(tree.id);
      } else {
        activeResearchTreeIdRef.current = null;
        setActiveResearchTreeId(null);
        setActiveResearchDetail(null);
        setActiveResearchDetailError(null);
        localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
      }
    },
    [
      archivedResearchTrees,
      focusResearchHome,
      researchTrees,
      selectResearchTree,
      setActivePaneId,
      setSidebarMode,
    ],
  );
  const createResearchFromSidebar = useCallback(() => {
    setSidebarMode("research");
    setNewResearchOpen(true);
  }, [setSidebarMode]);
  const createDocumentFromSidebar = useCallback(() => {
    setSidebarMode("research");
    setNewDocumentInitialMarkdown("");
    setNewDocumentOpen(true);
  }, [setSidebarMode]);

  // Native drag events bypass DOM modal backdrops. Keep the always-on listener
  // from stacking a document composer over another modal or replacing a draft
  // that is already being edited.
  const markdownDropBlocked =
    settingsOpen ||
    newResearchOpen ||
    newDocumentOpen ||
    Boolean(publicationTarget) ||
    commandPaletteOpen ||
    Boolean(
      closeDialog ||
        exitDialog ||
        exitPreflightRequest ||
        renamePaneId ||
        renameGroupId ||
        settingsMenu ||
        groupMenu ||
        paneContextMenu ||
        linkMenu,
    );
  markdownDropBlockedRef.current = markdownDropBlocked;

  useEffect(() => {
    if (!markdownDropBlocked && sidebarMode === "research") {
      return;
    }
    // Cancel a read even if the intervening modal/mode switch closes before
    // its backend work finishes; that stale completion must not reopen a
    // composer after the user has moved on.
    markdownImportRequestSeqRef.current += 1;
    setMarkdownDropTargetActive(false);
  }, [markdownDropBlocked, sidebarMode]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlistenDrop: (() => void) | null = null;
    let unlistenScale: (() => void) | null = null;
    let markdownDragEligible = false;
    let scaleFactor = globalThis.devicePixelRatio || 1;
    let scaleFactorRevision = 0;

    const isOverSidebar = (position: { x: number; y: number }) => {
      const bounds = sidebarRef.current?.getBoundingClientRect();
      if (!bounds) {
        return false;
      }
      const x = position.x / scaleFactor;
      const y = position.y / scaleFactor;
      return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    };
    const showDropTarget = (position: { x: number; y: number }) => {
      const active =
        markdownDragEligible &&
        !markdownDropBlockedRef.current &&
        sidebarModeRef.current === "research" &&
        isOverSidebar(position);
      setMarkdownDropTargetActive(active);
      return active;
    };

    const initialScaleFactorRevision = scaleFactorRevision;
    void appWindow
      .scaleFactor()
      .then((factor) => {
        if (!disposed && factor > 0 && scaleFactorRevision === initialScaleFactorRevision) {
          scaleFactor = factor;
        }
      })
      .catch(() => undefined);
    void appWindow
      .onScaleChanged(({ payload }) => {
        if (disposed) {
          return;
        }
        scaleFactorRevision += 1;
        scaleFactor = payload.scaleFactor;
        // Wait for the next native `over` event to re-evaluate the physical
        // pointer against the CSS bounds using the new display scale.
        setMarkdownDropTargetActive(false);
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlistenScale = stopListening;
        }
      })
      .catch(() => undefined);
    void appWindow
      .onDragDropEvent(({ payload }) => {
        if (disposed) {
          return;
        }
        if (payload.type === "leave") {
          markdownDragEligible = false;
          setMarkdownDropTargetActive(false);
          return;
        }
        if (payload.type === "enter") {
          markdownDragEligible =
            payload.paths.length === 1 && isMarkdownDocumentPath(payload.paths[0]);
          showDropTarget(payload.position);
          return;
        }
        if (payload.type === "over") {
          showDropTarget(payload.position);
          return;
        }

        const droppedPath = payload.paths.length === 1 ? payload.paths[0] : null;
        const shouldImport =
          Boolean(droppedPath && isMarkdownDocumentPath(droppedPath)) &&
          !markdownDropBlockedRef.current &&
          sidebarModeRef.current === "research" &&
          isOverSidebar(payload.position);
        markdownDragEligible = false;
        setMarkdownDropTargetActive(false);
        if (!shouldImport || !droppedPath) {
          return;
        }
        const requestSeq = ++markdownImportRequestSeqRef.current;
        setError(null);
        void readMarkdownDocumentFile(droppedPath)
          .then((markdown) => {
            if (
              disposed ||
              requestSeq !== markdownImportRequestSeqRef.current ||
              markdownDropBlockedRef.current ||
              sidebarModeRef.current !== "research"
            ) {
              return;
            }
            setNewDocumentInitialMarkdown(markdown);
            setNewDocumentOpen(true);
          })
          .catch((err) => {
            if (
              !disposed &&
              requestSeq === markdownImportRequestSeqRef.current &&
              !markdownDropBlockedRef.current
            ) {
              setError(err instanceof Error ? err.message : String(err));
            }
          });
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlistenDrop = stopListening;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlistenDrop?.();
      unlistenScale?.();
    };
  }, []);
  const chooseResearchWorkspaceFolder = useCallback(async (): Promise<GroupInfo | null> => {
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForPaintedFrame();
      const workspace = await createResearchWorkspaceWithFolder();
      if (workspace) {
        setGroups((current) =>
          current.some((group) => group.id === workspace.id) ? current : [...current, workspace],
        );
        void refreshResearchNavigation().catch(() => undefined);
      }
      return workspace;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setFolderPickerStatus(null);
    }
  }, [refreshResearchNavigation]);
  const openResearchWorkspaceFolder = useCallback(async (workspace: GroupInfo) => {
    setError(null);
    try {
      await revealResearchWorkspace(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const moveResearchWorkspaceFolder = useCallback(async (workspace: GroupInfo) => {
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForPaintedFrame();
      const updated = await moveResearchWorkspaceWithFolder(workspace.id);
      if (updated) {
        setGroups((current) =>
          current.map((group) => (group.id === updated.id ? updated : group)),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderPickerStatus(null);
    }
  }, []);
  // A streaming run emits research events several times a second, and each
  // refresh is two IPC round-trips (navigation collections + active tree).
  // Coalesce bursts onto one trailing refresh instead of one per event.
  const researchRefreshTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (researchRefreshTimerRef.current !== null) {
        window.clearTimeout(researchRefreshTimerRef.current);
      }
    },
    [],
  );
  const scheduleResearchRefresh = useCallback(() => {
    if (researchRefreshTimerRef.current !== null) {
      return;
    }
    researchRefreshTimerRef.current = window.setTimeout(() => {
      researchRefreshTimerRef.current = null;
      void refreshResearchNavigation().catch(() => undefined);
      const treeId = activeResearchTreeIdRef.current;
      if (treeId) {
        const requestSeq = researchDetailRequestSeqRef.current + 1;
        researchDetailRequestSeqRef.current = requestSeq;
        void getResearchTree(treeId)
          .then((detail) => {
            if (
              researchDetailRequestSeqRef.current === requestSeq &&
              activeResearchTreeIdRef.current === treeId
            ) {
              setActiveResearchDetail(detail);
              setActiveResearchDetailError(null);
              void markVisibleResearchTreeViewed(treeId).catch(() => undefined);
            }
          })
          .catch(() => undefined);
      }
    }, 250);
  }, [markVisibleResearchTreeViewed, refreshResearchNavigation]);
  // Research titles reuse the terminal tab-title pipeline: same provider
  // config, source-message stripping, and sanitization. Returns null when
  // generation is disabled, unavailable, or fails — the prompt-derived
  // default title is already a reasonable fallback, so failures stay silent.
  const generateResearchTitle = useCallback(async (prompt: string): Promise<string | null> => {
    const titleConfig = firstMessageTitleConfig(settingsRef.current, configRef.current);
    if (!titleConfig) {
      return null;
    }
    const sourceMessage = firstMessageTitleSource(prompt);
    if (!sourceMessage) {
      return null;
    }
    try {
      return await generateFirstMessageTitle(sourceMessage, titleConfig);
    } catch (err) {
      // Research titles fail silently, but a Foundation Models-unavailable error
      // still warrants turning generation off so it doesn't recur every time.
      noteFoundationTitleUnavailable(titleConfig, unknownErrorMessage(err));
      return null;
    }
  }, []);
  const applyGeneratedResearchTreeTitle = useCallback(
    async (treeId: string, prompt: string, originalTitle: string) => {
      const title = await generateResearchTitle(prompt);
      if (!title || title === originalTitle) {
        return;
      }
      try {
        // Generation spans a network/model round trip; skip if the user
        // renamed the tree in the meantime.
        const current = await getResearchTree(treeId);
        if (current.tree.title !== originalTitle) {
          return;
        }
        await renameResearchTree(treeId, title);
      } catch {
        return;
      }
      scheduleResearchRefresh();
    },
    [generateResearchTitle, scheduleResearchRefresh],
  );
  const applyGeneratedResearchNodeTitle = useCallback(
    async (nodeId: string, prompt: string) => {
      const title = await generateResearchTitle(prompt);
      if (!title) {
        return;
      }
      try {
        await renameResearchNode(nodeId, title);
      } catch {
        return;
      }
      scheduleResearchRefresh();
    },
    [generateResearchTitle, scheduleResearchRefresh],
  );
  // Shared by the research and document composers: the folder the item lands
  // in — the picked one, or the default folder (created on first use).
  const resolveResearchComposerWorkspace = useCallback(
    async (workspaceId: string | null): Promise<GroupInfo> => {
      const group = workspaceId
        ? groups.find((candidate) => candidate.id === workspaceId)
        : await ensureDefaultResearchWorkspace();
      if (!group || group.scope !== "research") {
        throw new Error("The selected research folder is no longer available.");
      }
      setGroups((current) =>
        current.some((candidate) => candidate.id === group.id) ? current : [...current, group],
      );
      return group;
    },
    [groups],
  );
  // Focuses a tree that a composer just created: research surface active, the
  // new tree selected with its detail already in hand, and the sidebar scoped
  // to its folder (a first item creates its private default folder — follow it
  // so the single-folder sidebar immediately lists the new tree).
  const adoptCreatedResearchTree = useCallback(
    (detail: ResearchTreeDetail) => {
      researchDetailRequestSeqRef.current += 1;
      setSidebarMode("research");
      setActiveSurface("research");
      activeResearchPaneIdRef.current = null;
      setActiveResearchPaneId(null);
      localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
      activeResearchTreeIdRef.current = detail.tree.id;
      setActiveResearchTreeId(detail.tree.id);
      localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, detail.tree.id);
      setActiveResearchDetail(detail);
      setActiveResearchDetailError(null);
      if (researchScopeRef.current !== detail.tree.workspaceId) {
        changeResearchFolderScope(detail.tree.workspaceId);
      }
      void refreshResearchNavigation().catch(() => undefined);
    },
    [changeResearchFolderScope, refreshResearchNavigation, setSidebarMode],
  );
  const submitNewResearch = useCallback(
    async (input: {
      prompt: string;
      adapter: string;
      model: string | null;
      workspaceId: string | null;
    }) => {
      const group = await resolveResearchComposerWorkspace(input.workspaceId);
      let detail: ResearchTreeDetail;
      try {
        detail = await createResearchTree({
          prompt: input.prompt,
          adapter: input.adapter,
          model: input.model,
          workspaceId: group.id,
        });
      } catch (err) {
        // The dialog displays the rethrown error itself — the global banner
        // renders behind the modal backdrop where it reads as a dead button.
        void refreshResearchNavigation().catch(() => undefined);
        throw err;
      }
      adoptCreatedResearchTree(detail);
      void applyGeneratedResearchTreeTitle(detail.tree.id, input.prompt, detail.tree.title);
    },
    [
      adoptCreatedResearchTree,
      applyGeneratedResearchTreeTitle,
      refreshResearchNavigation,
      resolveResearchComposerWorkspace,
    ],
  );
  const submitNewDocument = useCallback(
    async (input: {
      markdown: string;
      title: string | null;
      workspaceId: string | null;
    }) => {
      const group = await resolveResearchComposerWorkspace(input.workspaceId);
      let detail: ResearchTreeDetail;
      try {
        detail = await createResearchDocument({
          markdown: input.markdown,
          title: input.title,
          workspaceId: group.id,
        });
      } catch (err) {
        // Same reconciliation as the research composer: resolving the
        // workspace may have just created the default folder, so the sidebar
        // needs a refresh even though the failed create committed nothing.
        void refreshResearchNavigation().catch(() => undefined);
        throw err;
      }
      // No generated-title pass: a document's title comes from its own content
      // (or the composer's explicit field).
      adoptCreatedResearchTree(detail);
    },
    [adoptCreatedResearchTree, refreshResearchNavigation, resolveResearchComposerWorkspace],
  );
  const editResearchDocument = useCallback(
    async (input: {
      nodeId: string;
      markdown: string;
      title: string | null;
      expectedResponseRevision: string;
      expectedTitle: string;
      expectedHighlightIds: string[];
    }) => {
      const result = await updateResearchDocument(input);
      if (activeResearchTreeIdRef.current === result.tree.id) {
        // Apply the authoritative metadata immediately. The document component
        // separately refetches the body when its snapshot revision changed.
        setActiveResearchDetail((current) =>
          current?.tree.id === result.tree.id
            ? {
                tree: result.tree,
                nodes: current.nodes.map((node) =>
                  node.id === result.node.id ? result.node : node,
                ),
              }
            : current,
        );
      }
      void refreshResearchNavigation().catch(() => undefined);
      return result;
    },
    [refreshResearchNavigation],
  );
  // Mirrors the backend's adapters::default_fork_adapter — the adapter that
  // document follow-ups launch on — so adapter-specific composer affordances
  // (the deep-research skill command) resolve against the right adapter.
  const defaultForkAdapterId = useMemo(() => {
    const forkable = (config?.adapters ?? []).filter((adapter) => adapter.supportsFork);
    return (forkable.find((adapter) => adapter.default) ?? forkable[0])?.id ?? null;
  }, [config?.adapters]);
  const cancelResearchRun = useCallback(
    async (nodeId: string) => {
      await cancelResearchNode(nodeId);
      scheduleResearchRefresh();
    },
    [scheduleResearchRefresh],
  );
  const renameResearchTreeTitle = useCallback(
    async (treeId: string, title: string) => {
      try {
        await renameResearchTree(treeId, title);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      scheduleResearchRefresh();
    },
    [scheduleResearchRefresh],
  );
  const regenerateResearchTreeTitle = useCallback(
    async (treeId: string) => {
      try {
        const detail = await getResearchTree(treeId);
        const rootNode = detail.nodes.find((node) => node.id === detail.tree.rootNodeId);
        if (!rootNode) {
          throw new Error("The research's original query is unavailable.");
        }
        const title = await generateResearchTitle(rootNode.prompt);
        if (!title) {
          throw new Error("Unable to generate a research title.");
        }
        await renameResearchTree(treeId, title);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      scheduleResearchRefresh();
    },
    [generateResearchTitle, scheduleResearchRefresh],
  );
  const archiveResearchTreeFromSidebar = useCallback(
    async (treeId: string) => {
      try {
        await archiveResearchTree(treeId);
        if (activeResearchTreeIdRef.current === treeId) {
          const nextTree = nextTreeInResearchScope(
            researchTrees,
            researchScopeRef.current,
            treeId,
          );
          if (nextTree) {
            await selectResearchTree(nextTree.id);
          } else {
            activeResearchTreeIdRef.current = null;
            setActiveResearchTreeId(null);
            setActiveResearchDetail(null);
            setActiveResearchDetailError(null);
            localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
            setSidebarMode("research");
            setActiveSurface("research");
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      await refreshResearchNavigation().catch(() => undefined);
    },
    [refreshResearchNavigation, researchTrees, selectResearchTree, setSidebarMode],
  );
  const restoreResearchTreeFromSidebar = useCallback(
    async (treeId: string) => {
      try {
        await restoreResearchTree(treeId);
        await refreshResearchNavigation();
        await selectResearchTree(treeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshResearchNavigation, selectResearchTree],
  );
  // Both delete entry points must reconcile the active document identically.
  // Keeping this in one path prevents the document menu from falling to an
  // empty state while the sidebar menu selects the next tree (or vice versa).
  const removeResearchTreeAndSelectFallback = useCallback(
    async (treeId: string) => {
      setError(null);
      await removeResearchTree(treeId);
      if (activeResearchTreeIdRef.current === treeId) {
        const nextTree = nextTreeInResearchScope(
          researchTreesRef.current,
          researchScopeRef.current,
          treeId,
        );
        if (nextTree) {
          await selectResearchTree(nextTree.id);
        } else {
          activeResearchTreeIdRef.current = null;
          setActiveResearchTreeId(null);
          setActiveResearchDetail(null);
          setActiveResearchDetailError(null);
          localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
          setSidebarMode("research");
          setActiveSurface("research");
        }
      }
      await refreshResearchNavigation().catch(() => undefined);
    },
    [refreshResearchNavigation, selectResearchTree, setSidebarMode],
  );
  const removeResearchTreeFromSidebar = useCallback(
    async (treeId: string) => {
      setError(null);
      try {
        await removeResearchTreeAndSelectFallback(treeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [removeResearchTreeAndSelectFallback],
  );
  const createResearchFollowup = useCallback(
    async (
      parentNodeId: string,
      prompt: string,
      publicationProposal?: {
        publicationId: string;
        commentId: number;
      } | null,
    ) => {
      const node = await forkResearchNode(
        parentNodeId,
        prompt,
        publicationProposal,
      );
      void applyGeneratedResearchNodeTitle(node.id, prompt);
      void refreshResearchNavigation().catch(() => undefined);
      const treeId = activeResearchTreeIdRef.current;
      if (treeId) {
        const requestSeq = researchDetailRequestSeqRef.current + 1;
        researchDetailRequestSeqRef.current = requestSeq;
        void getResearchTree(treeId)
          .then((detail) => {
            if (
              researchDetailRequestSeqRef.current === requestSeq &&
              activeResearchTreeIdRef.current === treeId
            ) {
              setActiveResearchDetail(detail);
            }
          })
          .catch(() => undefined);
      }
      return node;
    },
    [applyGeneratedResearchNodeTitle, refreshResearchNavigation],
  );
  const removeResearchBranchFromDocument = useCallback(
    async (nodeId: string) => {
      setError(null);
      const removal = await removeResearchBranch(nodeId);
      const treeId = activeResearchTreeIdRef.current;
      if (treeId === removal.treeId) {
        // The delete already committed. Prune the live detail immediately so a
        // failed follow-up refetch cannot leave clickable, already-deleted
        // cards on screen until the next unrelated research event.
        const removedNodeIds = new Set(removal.removedNodeIds);
        setActiveResearchDetail((current) =>
          current?.tree.id === removal.treeId
            ? {
                ...current,
                nodes: current.nodes.filter((node) => !removedNodeIds.has(node.id)),
              }
            : current,
        );
        const requestSeq = researchDetailRequestSeqRef.current + 1;
        researchDetailRequestSeqRef.current = requestSeq;
        try {
          const detail = await getResearchTree(treeId);
          if (
            researchDetailRequestSeqRef.current === requestSeq &&
            activeResearchTreeIdRef.current === treeId
          ) {
            setActiveResearchDetail(detail);
            setActiveResearchDetailError(null);
          }
        } catch (err) {
          setError(`The branch was deleted, but Research could not refresh: ${unknownErrorMessage(err)}`);
        }
      }
      void refreshResearchNavigation().catch(() => undefined);
      return removal;
    },
    [refreshResearchNavigation],
  );
  const nativeTerminalShortcutHandlerRef = useRef<
    (paneId: string, command: AppShortcutCommand, repeat: boolean) => void
  >(() => undefined);
  const nativeAppShortcutHandlerRef = useRef<
    (command: AppShortcutCommand, repeat: boolean) => void
  >(() => undefined);
  const handleNativeTerminalShortcut = useCallback(
    (paneId: string, command: AppShortcutCommand, repeat: boolean) => {
      nativeTerminalShortcutHandlerRef.current(paneId, command, repeat);
    },
    [],
  );
  const handleNativeAppShortcut = useCallback(
    (command: AppShortcutCommand, repeat: boolean) => {
      nativeAppShortcutHandlerRef.current(command, repeat);
    },
    [],
  );
  const handleNativeTerminalCommandModifier = useCallback(
    (paneId: string, active: boolean) => {
      if (
        !active ||
        (activeSurfaceRef.current === "pane" && activePaneRef.current?.id === paneId)
      ) {
        setShortcutHintsVisible(active);
      }
    },
    [],
  );

  useQmuxEvents({
    appendHookEvent,
    setPanes: setPanesPreservingRecoveredDismissals,
    // PTY lifecycle bookkeeping must not implicitly leave a research document when
    // some unrelated terminal exits. User-driven pane activation uses the wrapper.
    setActivePaneId: setActivePaneIdState,
    setPaneContextMenu,
    setExitPreflightRequest,
    setAgents,
    setGroups,
    setThinkingAgentIds,
    setTurns,
    setThreadGraphs,
    setTranscriptNoticeByAgent,
    setShellJobByAgent: setShellJobByAgentFromEvent,
    setAgentQueuedTurns,
    // Reads through agentsRef (not the captured `agents` render value) because
    // useQmuxEvents captures its handlers once on mount. threadIdForAgent
    // mirrors the backend's thread-id fallback so agents without an explicit
    // threadId still resolve.
    getAgentThreadId: (agentId: string) => {
      const agent = agentsRef.current.find((candidate) => candidate.id === agentId);
      return agent ? threadIdForAgent(agent) : null;
    },
    refreshAgentTurnQueue,
    refreshTranscriptOptions,
    openBrowserOverlay,
    selectPaneAfterClose: selectPaneAfterCloseWithContext,
    onEventsReady: handleEventsReady,
    onAgentSpawned: registerShellCodexFirstMessageTitle,
    onAgentPromptSubmitted: handleAgentPromptSubmitted,
    onTerminalSearchRequested: openNativeTerminalSearch,
    onTerminalPasteRequested: requestNativeTerminalPaste,
    onTerminalUserInput: reportNativeTerminalInput,
    onTerminalActivated: activateTerminalPane,
    onTerminalShortcut: handleNativeTerminalShortcut,
    onAppShortcut: handleNativeAppShortcut,
    onTerminalCommandModifier: handleNativeTerminalCommandModifier,
    onTerminalOpenUrl: openPaneLink,
    onTerminalTitleChanged: handleTerminalTitleChange,
    onResearchChanged: scheduleResearchRefresh,
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

      const [latestPanes, latestAgents, latestTurns, latestThreadGraphs, latestGroups] =
        await Promise.all([
          listPanes(),
          listAgents(),
          listTurns(),
          listThreadGraphs().catch((): ThreadGraph[] => []),
          listGroups(),
        ]);
      setPanesPreservingRecoveredDismissals(latestPanes);
      setAgents(latestAgents);
      setTurns(latestTurns);
      setThreadGraphs(latestThreadGraphs);
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
    requestAnimationFrame(() => {
      terminalPaneRefs.current.get(paneId)?.focus();
    });
  }

  function focusHomeTab() {
    setActivePaneId(HOME_TAB_ID);
    focusLauncherInput();
  }

  function openResearchPaneTab(paneId: string) {
    // The research detail that renders the "Open terminal" button trails
    // pane.removed by a debounced refresh, so the pane can already be gone
    // when the button is clicked. Falling through to focusPaneTab would
    // classify the unknown id as a terminal-scope tab (setActivePaneId's
    // recovery fallback) and evict the user from Research mode entirely;
    // acknowledge and stay put instead.
    if (!panesRef.current.some((pane) => pane.id === paneId)) {
      showAppToast("That research terminal has already closed.", "warning");
      return;
    }
    focusPaneTab(paneId);
  }

  // The prompt library's project scope follows the pane's group directory; a
  // worktree group resolves to its base repo so prompts don't fork with the
  // tree. Null (no pane, or group without a dir) hides the Project section.
  function promptProjectDirForPane(pane: PaneInfo | undefined): string | null {
    if (!pane) {
      return null;
    }
    const group = groupById.get(pane.groupId);
    if (!group) {
      return null;
    }
    const baseRepo = group.baseRepo?.trim();
    return baseRepo ? baseRepo : group.dir || null;
  }

  // The ⌘K palette's command list, rebuilt on each open from live state: tab
  // navigation, pane/session actions gated on what the active pane supports,
  // and saved prompts that insert into the active agent's composer.
  function buildPaletteCommands(): PaletteCommand[] {
    const commands: PaletteCommand[] = [];
    const visiblePane = researchSurfaceActive ? undefined : activePane;
    const visibleAgent = researchSurfaceActive ? undefined : activeAgent;
    commands.push({
      id: "nav:home",
      section: "Go to",
      title: "Home",
      hint: "⇧⌘H",
      action: () => {
        if (sidebarMode === "research") {
          focusResearchHome();
        } else {
          focusHomeTab();
        }
      },
    });
    for (const tree of researchTrees) {
      commands.push({
        id: `research:${tree.id}`,
        section: "Research",
        title: tree.title,
        hint: tree.runningCount > 0 ? `${tree.runningCount} running` : undefined,
        action: () => void selectResearchTree(tree.id),
      });
    }
    for (const pane of sidebarPanes) {
      commands.push({
        id: `nav:${pane.id}`,
        section: "Go to",
        title: pane.title,
        hint: groupById.get(pane.groupId)?.name,
        action: () => focusPaneTab(pane.id),
      });
    }
    commands.push({
      id: "action:quick-launch",
      section: "Actions",
      title: "Quick launch: dispatch a task to an agent tab",
      hint: GLOBAL_TASK_LAUNCHER_HOTKEY_OPTIONS.find(
        (option) => option.value === globalTaskLauncherSetting.hotkey,
      )?.glyph,
      action: () => void openGlobalTaskLauncher().catch(() => undefined),
    });
    commands.push({
      id: "action:new-tab",
      section: "Actions",
      title: "New agent",
      hint: !settings.codeMode && sidebarMode === "terminal" ? "⌘T" : undefined,
      action: () => focusHomeTab(),
    });
    commands.push({
      id: "action:new-research",
      section: "Actions",
      title: "New research",
      hint: sidebarMode === "research" ? "⌘T" : undefined,
      action: () => void createResearchFromSidebar(),
    });
    commands.push({
      id: "action:new-document",
      section: "Actions",
      title: "New document",
      action: () => void createDocumentFromSidebar(),
    });
    commands.push({
      id: "action:new-terminal",
      section: "Actions",
      title: "New shell",
      hint: settings.codeMode && sidebarMode === "terminal" ? "⌘T" : undefined,
      action: () => void addShellPane(),
    });
    if (
      agentCanFork(visibleAgent) &&
      visiblePane &&
      groupById.get(visiblePane.groupId)?.scope === "terminal"
    ) {
      commands.push({
        id: "action:fork",
        section: "Actions",
        title: "Fork session",
        action: () => void forkActivePane({ nest: true, useWorktree: false }),
      });
      commands.push({
        id: "action:fork-worktree",
        section: "Actions",
        title: "Fork session in worktree",
        action: () => void forkActivePane({ nest: true, useWorktree: true }),
      });
    }
    if (activeBrowserOwnerId) {
      commands.push({
        id: "action:toggle-browser",
        section: "Actions",
        title: "Toggle browser overlay",
        action: () => toggleActiveBrowserOverlay(),
      });
    }
    if (visiblePane) {
      commands.push({
        id: "action:close-pane",
        section: "Actions",
        title: "Close tab",
        hint: "⌘W",
        action: () => requestClosePaneRef.current(visiblePane),
      });
    }
    if (visibleAgent) {
      commands.push({
        id: "action:toggle-transcript",
        section: "Actions",
        title: "Expand or restore transcript",
        hint: EXPAND_TOGGLE_SHORTCUT_LABEL,
        action: () => toggleActiveTranscriptExpanded(),
      });
    }
    commands.push({
      id: "action:restore-closed",
      section: "Actions",
      title: "Reopen closed tab",
      hint: sidebarMode === "research" ? undefined : "⇧⌘T",
      action: () => void restoreClosedPane(),
    });
    commands.push({
      id: "action:settings",
      section: "Actions",
      title: "Open Settings",
      hint: "⌘,",
      action: () => {
        setSettingsMenu(null);
        setSettingsOpen(true);
      },
    });
    if (visibleAgent) {
      for (const prompt of paletteSavedPrompts) {
        commands.push({
          id: `prompt:${prompt.scope}:${prompt.name}`,
          section: "Insert prompt",
          // Prompts are titleless; their first line stands in for a name.
          title: prompt.content.trim().split("\n", 1)[0] || "(empty prompt)",
          hint: prompt.scope === "global" ? "Global" : "Project",
          action: () => requestComposerInsert(visibleAgent.id, prompt.content),
        });
      }
    }
    return commands;
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
    const researchNode = researchNodeByPaneId.get(paneId);
    if (researchNode && researchNode.treeId !== activeResearchTreeIdRef.current) {
      // Keep the durable document paired with the short-lived terminal. If the
      // pane retires while selected, the fallback effect returns to this tree.
      void selectResearchTree(researchNode.treeId);
    }
    focusPaneTab(paneId);
    acknowledgePaneIfDone(paneId);
  }

  function handlePaneTabDoubleClick(pane: PaneInfo) {
    if (suppressPaneTabClickRef.current) {
      return;
    }
    openRenameDialog(pane);
  }

  function updatePaneDropTarget(target: PaneDropTarget | null) {
    if (paneDropTargetsEqual(paneDropTargetRef.current, target)) {
      return;
    }
    paneDropTargetRef.current = target;
    setPaneDropTarget(target);
  }

  function updateGroupDropTarget(target: GroupDropTarget | null) {
    if (groupDropTargetsEqual(groupDropTargetRef.current, target)) {
      return;
    }
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
    const dragIndex = terminalGroups.findIndex((group) => group.id === dragGroupId);
    if (rows.length === 0 || dragIndex < 0) {
      return null;
    }

    const gapTarget = (index: number): GroupDropTarget | null =>
      index === dragIndex || index === dragIndex + 1 ? null : { index };

    for (const row of rows) {
      const rowIndex = terminalGroups.findIndex((group) => group.id === row.dataset.groupId);
      if (rowIndex < 0) {
        continue;
      }
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top) {
        return gapTarget(rowIndex);
      }
      if (clientY <= rect.bottom) {
        return gapTarget(clientY < rect.top + rect.height / 2 ? rowIndex : rowIndex + 1);
      }
    }
    const lastVisibleIndex = terminalGroups.findIndex(
      (group) => group.id === rows[rows.length - 1]?.dataset.groupId,
    );
    return gapTarget(lastVisibleIndex >= 0 ? lastVisibleIndex + 1 : terminalGroups.length);
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
        child.dataset.paneDragDisabled !== "true" &&
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
    const dragIndex = terminalGroups.findIndex((group) => group.id === dragGroupId);
    if (dragIndex < 0 || target.index === dragIndex || target.index === dragIndex + 1) {
      return;
    }

    const withoutDragged = terminalGroups.filter((group) => group.id !== dragGroupId);
    const insertIndex = clamp(
      target.index > dragIndex ? target.index - 1 : target.index,
      0,
      withoutDragged.length,
    );
    const dragGroup = terminalGroups[dragIndex];
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
    const layoutChanged = !sameLayout(nextLayout, toLayout(panes));
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

  function panesWithGroupOrder(
    groupId: string,
    nextGroupPanes: PaneInfo[],
    paneSnapshot = panes,
  ) {
    const next = groups.flatMap((group) =>
      group.id === groupId
        ? nextGroupPanes
        : paneSnapshot.filter((pane) => pane.groupId === group.id),
    );
    const groupedIds = new Set(next.map((pane) => pane.id));
    next.push(...paneSnapshot.filter((pane) => !groupedIds.has(pane.id)));
    return next;
  }

  // Optimistically applies a new tab layout (order + depth) and persists it, with the
  // same request-sequence guard the old reorder used so stale responses never clobber
  // a newer local state.
  function applyPaneLayout(
    groupId: string,
    nextGroupPanes: PaneInfo[],
    paneSnapshot = panes,
  ) {
    const next = panesWithGroupOrder(groupId, nextGroupPanes, paneSnapshot);
    const nextLayout = toLayout(next);
    if (sameLayout(nextLayout, toLayout(paneSnapshot))) {
      return; // structural no-op — don't churn a backend round-trip
    }
    const requestSeq = paneReorderRequestSeqRef.current + 1;
    paneReorderRequestSeqRef.current = requestSeq;
    // Keyboard repeats can arrive before React commits the optimistic state.
    // Keep the imperative snapshot current so each press advances one slot.
    panesRef.current = next;
    setPanesPreservingRecoveredDismissals(next);

    const persist = paneReorderPersistChainRef.current
      .catch(() => undefined)
      .then(() => setPaneLayout(nextLayout));
    paneReorderPersistChainRef.current = persist
      .then((orderedPanes) => {
        if (paneReorderRequestSeqRef.current === requestSeq) {
          panesRef.current = orderedPanes;
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
              panesRef.current = latest;
              setPanesPreservingRecoveredDismissals(latest);
            }
          })
          .catch(() => undefined);
      });
  }

  function moveActiveTerminalPane(direction: -1 | 1) {
    if (sidebarModeRef.current !== "terminal") {
      return;
    }
    const paneId = activePaneIdRef.current;
    if (!paneId || paneId === HOME_TAB_ID) {
      return;
    }
    const currentPanes = panesRef.current;
    const pane = currentPanes.find((candidate) => candidate.id === paneId);
    if (
      !pane ||
      groupsRef.current.find((group) => group.id === pane.groupId)?.scope !== "terminal"
    ) {
      return;
    }
    const groupPanes = currentPanes.filter((candidate) => candidate.groupId === pane.groupId);
    const nextGroupPanes = movePaneSubtreeBy(groupPanes, paneId, direction);
    if (nextGroupPanes !== groupPanes) {
      applyPaneLayout(pane.groupId, nextGroupPanes, currentPanes);
    }
  }

  function applyGroupOrder(nextTerminalGroups: GroupInfo[]) {
    const nextGroups = replaceScopedGroupOrder(groups, "terminal", nextTerminalGroups);
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
  // when its pane or split group is selected (see the activePaneId effect). Clearing
  // the flag locally and recording the pane ids keeps later backend pane refetches
  // from resurrecting the badge during this app session.
  function dismissRecoveredBadge(paneId: string) {
    const paneIds = paneIdsForSplitStatusGroup(paneId);
    for (const id of paneIds) {
      dismissedRecoveredPaneIdsRef.current.add(id);
    }
    const paneIdSet = new Set(paneIds);
    setPanesPreservingRecoveredDismissals((current) => {
      let changed = false;
      const next = current.map((pane) => {
        if (pane.recovered && paneIdSet.has(pane.id)) {
          changed = true;
          return { ...pane, recovered: false };
        }
        return pane;
      });
      return changed ? next : current;
    });
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
        const updated =
          previous.scope === "research"
            ? await renameResearchWorkspace(groupId, nextNameOverride)
            : await renameGroup(groupId, nextNameOverride);
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
        return selectPaneAfterCloseWithContext(current, paneToClose.id);
      });
      return nextPanes;
    });
    setPaneContextMenu((current) => (current?.paneId === paneToClose.id ? null : current));
  }

  async function closePane(paneToClose: PaneInfo): Promise<boolean> {
    setError(null);
    // Surviving split members are about to be relaid out (the splits normalizer
    // drops the closed id and their fractions renormalize), so save their
    // viewports first — mirroring what removePaneFromSplit does for the detach
    // path — and let the resize restore from a trusted position.
    const split = paneSplitForPane(paneSplits, paneToClose.id);
    if (split) {
      for (const splitPaneId of split.paneIds) {
        if (splitPaneId !== paneToClose.id) {
          terminalPaneRefs.current.get(splitPaneId)?.preserveViewport();
        }
      }
    }
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

  async function removeResearchWorkspaceFromSidebar(workspace: GroupInfo) {
    setError(null);
    const detachedTreeIds = new Set(await removeResearchWorkspace(workspace.id));
    const remainingGroups = groupsRef.current.filter((group) => group.id !== workspace.id);
    const remainingTrees = researchTreesRef.current.filter(
      (tree) => !detachedTreeIds.has(tree.id),
    );
    setGroups(remainingGroups);
    setResearchTrees(remainingTrees);
    setArchivedResearchTrees((current) =>
      current.filter((tree) => !detachedTreeIds.has(tree.id)),
    );
    setResearchActivity((current) =>
      current.filter((node) => !detachedTreeIds.has(node.treeId)),
    );
    const activeTreeId = activeResearchTreeIdRef.current;
    const activeTreeWasRemoved = Boolean(activeTreeId && detachedTreeIds.has(activeTreeId));
    const scopeWasRemoved = researchScopeRef.current === workspace.id;
    const nextScope = scopeWasRemoved
      ? (remainingGroups.find(
          (group) => group.scope === "research" && group.id !== workspace.id,
        )?.id ?? null)
      : researchScopeRef.current;
    if (scopeWasRemoved) {
      changeResearchFolderScope(nextScope);
      activeResearchPaneIdRef.current = null;
      setActiveResearchPaneId(null);
      localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    }
    // Removing the selected folder/tree should land on an available research
    // item in the surviving scope, not leave an unexplained empty document.
    if (scopeWasRemoved || activeTreeWasRemoved) {
      const nextTree = treeForResearchScope(
        remainingTrees,
        nextScope,
        activeTreeWasRemoved ? null : activeTreeId,
      );
      if (nextTree) {
        await selectResearchTree(nextTree.id);
      } else {
        activeResearchTreeIdRef.current = null;
        setActiveResearchTreeId(null);
        setActiveResearchDetail(null);
        setActiveResearchDetailError(null);
        localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
        setActiveSurface("research");
      }
    }
    void refreshResearchNavigation().catch(() => undefined);
  }

  async function confirmResearchFolderRemoval() {
    const dialog = closeDialog;
    if (!dialog || dialog.kind !== "researchFolderRemove" || resolvingClose) {
      return;
    }
    setResearchFolderRemovalError(null);
    setResolvingClose("removeResearchFolder");
    try {
      await removeResearchWorkspaceFromSidebar(dialog.workspace);
      setCloseDialog(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResearchFolderRemovalError(message);
      setError(message);
    } finally {
      setResolvingClose(null);
    }
  }

  async function expandGroup(group: GroupInfo) {
    await applyGroupCollapsed(group, false);
  }

  async function closeDialogForPane(
    paneToClose: PaneInfo,
    options?: { confirmAlways?: boolean; checkWorktreeStatus?: boolean },
  ): Promise<CloseDialogState | null> {
    const researchNode = researchNodeByPaneId.get(paneToClose.id);
    if (
      researchNode &&
      (researchNode.status === "queued" ||
        researchNode.status === "starting" ||
        researchNode.status === "running")
    ) {
      return { kind: "researchCancel", pane: paneToClose };
    }
    // A settled node's pane is already on its way out (retirement kills it
    // within seconds). Closing it early is a plain close — the process probe
    // below would otherwise see the still-live adapter and raise a spurious
    // "running process" confirmation in that window.
    if (researchNode) {
      return null;
    }
    // A research pane whose node hasn't reached the debounced index yet is
    // still a research run — closing it cancels, and must say so rather than
    // falling through to the ordinary agent-close dialog.
    if (groupById.get(paneToClose.groupId)?.scope === "research") {
      return { kind: "researchCancel", pane: paneToClose };
    }
    const agent = agentsRef.current.find((candidate) => candidate.paneId === paneToClose.id);
    if (agent && agent.branch) {
      const checkingChanges = options?.checkWorktreeStatus !== false;
      const probeNonce = (worktreeProbeNonceRef.current += 1);
      if (checkingChanges) {
        // The dialog opens immediately and the git-status verdict patches in:
        // awaiting the probe here left ⌘W with no visible response for as
        // long as `git status` takes on the worktree (seconds on large or
        // cold-cache repos). A probe failure keeps the unknown state so the
        // dialog cannot falsely assure the user that deleting is safe. The
        // nonce ties the patch to this dialog generation: a probe from a
        // dismissed dialog (cancel → reopen the same pane) must not land its
        // older verdict on the newer dialog.
        void worktreeStatus(agent.id)
          .then(
            (status): boolean | null => status.hasChanges,
            (): boolean | null => null,
          )
          .then((hasChanges) => {
            setCloseDialog((current) =>
              current?.kind === "worktree" &&
              current.probeNonce === probeNonce &&
              current.checkingChanges
                ? { ...current, hasChanges, checkingChanges: false }
                : current,
            );
          });
      }
      return {
        kind: "worktree",
        pane: paneToClose,
        agentId: agent.id,
        worktreeDir: agent.worktreeDir,
        hasChanges: null,
        checkingChanges,
        probeNonce,
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

    // Pending queued turns that would be parked (and easy to lose track of) on close —
    // surface them through the same stop dialog rather than closing silently. This
    // covers both the closing pane's own live agent, whose own queue is otherwise not
    // counted once it goes idle, and any recovered (orphaned) queues already parked here.
    const ownQueuedCount = agent
      ? (queuedTurnsByAgentRef.current[agent.id]?.length ?? 0)
      : 0;
    const recoveredTurnCount = agents
      .filter((candidate) => candidate.orphanedQueuePaneId === paneToClose.id)
      .reduce(
        (total, candidate) =>
          total + (queuedTurnsByAgentRef.current[candidate.id]?.length ?? 0),
        0,
      );
    const pendingQueuedCount = ownQueuedCount + recoveredTurnCount;

    const reason =
      liveReason ??
      (pendingQueuedCount > 0
        ? `has ${pendingQueuedCount} queued ${
            pendingQueuedCount === 1 ? "turn" : "turns"
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
      const message = err instanceof Error ? err.message : String(err);
      // Worktree deletion runs after the pane is killed. If cleanup fails, the
      // command reports an error even though the backend no longer has the pane;
      // reconcile that partial success so the UI cannot retain a dead tab/agent.
      try {
        const [latestPanes, latestAgents, latestGroups] = await Promise.all([
          listPanes(),
          listAgents(),
          listGroups(),
        ]);
        if (!latestPanes.some((pane) => pane.id === dialog.pane.id)) {
          setPanesPreservingRecoveredDismissals(latestPanes);
          setAgents(latestAgents);
          setGroups(latestGroups);
        }
      } catch {
        // Preserve the cleanup error; a later backend event/resync can reconcile
        // state if this best-effort read also fails.
      }
      setError(message);
      setCloseDialog(null);
    } finally {
      setResolvingClose(null);
    }
  }

  // Confirms stopping a live agent that has no worktree to clean up.
  async function confirmStopAndClose() {
    const dialog = closeDialog;
    if (!dialog || (dialog.kind !== "stop" && dialog.kind !== "researchCancel")) {
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
    if (quittingRef.current) {
      return;
    }
    quittingRef.current = true;
    setQuitting(true);
    setError(null);
    // Let React commit the pending button and give WebKit a full paint before
    // AppKit begins the comparatively slow application teardown.
    await waitForNextPaint();
    flushPendingDrafts();
    try {
      const activeResearchNodeIds = researchActivity
        .filter((node) => ["queued", "starting", "running"].includes(node.status))
        .map((node) => node.id);
      // Settled, not fail-fast: the activity snapshot can be moments stale, so
      // a run that finished (and lost its pane) in the meantime rejects with
      // "not active" — which must not abort the quit. Runs whose cancel truly
      // failed are killed by app teardown and reconciled to Failed on the next
      // start, so proceeding is safe either way.
      const cancellations = await Promise.allSettled(
        activeResearchNodeIds.map((nodeId) => cancelResearchNode(nodeId)),
      );
      for (const cancellation of cancellations) {
        if (cancellation.status === "rejected") {
          console.warn("research cancellation during quit failed:", cancellation.reason);
        }
      }
      await confirmAppExit();
    } catch (err) {
      quittingRef.current = false;
      setQuitting(false);
      setExitDialog(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addAgentPane() {
    // Re-entry guard: spawnAgent is awaited below before the launcher closes, so a
    // held Enter or a rapid double submit would otherwise spawn several agents (and
    // worktrees) from one launch. Reset in `finally` so a failed launch can retry.
    if (launchingAgentRef.current) {
      return;
    }
    launchingAgentRef.current = true;
    const trimmed = promptRef.current.trim();
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
      const orderedPanes = panesWithNewTabInLaunchPosition(pane, targetGroupId);
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
      clearLauncherPrompt();
      setSelectedSkillId(null);
      const [latestAgents] = await Promise.all([listAgents(), refreshGroups()]);
      setAgents(latestAgents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      launchingAgentRef.current = false;
    }
  }

  // Forks the active session into a new tab (resuming it) — as a sibling right
  // after the current tab, or nested under it when `nest` is set — and focuses the
  // fork. The backend also emits agent.forked, which refetches the ordered pane
  // list, so the optimistic append below is just to avoid a flicker.
  async function forkPane(
    pane: PaneInfo,
    options: { nest: boolean; useWorktree: boolean; prompt?: string },
  ): Promise<boolean> {
    setError(null);
    try {
      const fork = await forkAgent(pane.id, options);
      setPanesPreservingRecoveredDismissals((current) =>
        current.some((existing) => existing.id === fork.id) ? current : [...current, fork],
      );
      setActivePaneId(fork.id);
      expandNewAgentTranscriptByDefault(fork);
      if (options.prompt && fork.agentId) {
        pendingFirstTitleByAgentRef.current.set(
          fork.agentId,
          createPendingFirstMessageTitle(fork.id),
        );
        applyPendingFirstMessageTitle(fork.agentId, options.prompt);
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function forkActivePane(options: { nest: boolean; useWorktree: boolean }) {
    if (!activePane || !activeAgent) {
      return;
    }
    await forkPane(activePane, options);
  }

  // Stable identity for the terminal input handler. The impl above is a plain
  // function that closes over fresh state / unstable helpers, so passing it directly
  // gives a new identity every render — defeating TerminalPane's React.memo (making
  // every mounted pane reconcile on unrelated App re-renders) and re-subscribing
  // event hooks. Routing through a latest-ref wrapper is behavior-neutral; it just
  // lets the memo hold.
  const terminalHandlersRef = useRef({
    noteUserInput,
  });
  terminalHandlersRef.current = {
    noteUserInput,
  };
  const stableNoteUserInput = useCallback(
    (agentId: string) => terminalHandlersRef.current.noteUserInput(agentId),
    [],
  );
  const updateTerminalOverlayState = useCallback((paneId: string, open: boolean) => {
    setTerminalOverlayBlockedPaneIds((current) => {
      if (current.has(paneId) === open) {
        return current;
      }
      const next = new Set(current);
      if (open) {
        next.add(paneId);
      } else {
        next.delete(paneId);
      }
      return next;
    });
  }, []);
  // Mirror active-tab state into refs so the always-on keydown listener never reads
  // stale state.
  useEffect(() => {
    activePaneRef.current = activePane;
    browserOverlayByPaneRef.current = browserOverlayByPane;
    activeBrowserOwnerIdRef.current = activeBrowserOwnerId;
    toggleActiveBrowserOverlayRef.current = toggleActiveBrowserOverlay;
    closeActiveBrowserOverlayRef.current = closeActiveBrowserOverlay;
    requestClosePaneRef.current = requestClosePane;
    splitPaneBelowRef.current = splitPaneBelow;
    canToggleActiveTranscriptExpandedRef.current = Boolean(
      activeSurfaceRef.current === "pane" && activePane && activePaneHasTurnSidebar,
    );
    toggleActiveTranscriptExpandedRef.current = toggleActiveTranscriptExpanded;
  });

  // Keyboard-ownership arbitration between the webview and the native terminal
  // surfaces. Two responsibilities:
  //
  // 1. Track whether a web editable element really holds DOM focus (composer,
  //    rename input, search field…). While it does, the native pane must not
  //    claim AppKit first responder — see the `focused` layout flag.
  //
  // 2. Recover from first-responder theft. WKWebView grabs first responder on
  //    its own schedule (initial page load, engine-internal focus churn); when
  //    that happens without any web editable claiming the keyboard, the active
  //    terminal still owns it, so bounce first responder straight back. The
  //    theft itself is the signal: the page receives a window `focus` event.
  //    Focus-in claims web ownership synchronously from the event target so the
  //    first typed key cannot race the native layout update. Focus-out and
  //    window-focus recovery sample one frame later, after activeElement settles.
  useEffect(() => {
    let frame: number | null = null;
    const sample = () => {
      frame = null;
      setWebEditableFocused(
        document.hasFocus() && isEditableTarget(document.activeElement),
      );
    };
    const schedule = () => {
      if (frame === null) {
        frame = requestAnimationFrame(sample);
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      setWebEditableFocused(document.hasFocus() && isEditableTarget(event.target));
    };
    const bounceStolenFocus = () => {
      lastWindowFocusSeqRef.current = ++focusOrderSeqRef.current;
      schedule();
      requestAnimationFrame(() => {
        if (isEditableTarget(document.activeElement)) {
          return;
        }
        // A live DOM selection means the user is selecting (or has selected)
        // web text; bouncing focus back to the terminal here would route the
        // upcoming Cmd+C into Ghostty's copy instead of WebKit's.
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed) {
          return;
        }
        const pane = activePaneRef.current;
        if (pane) {
          // TerminalPane.focus() re-checks active/visible/inputBlocked itself.
          terminalPaneRefs.current.get(pane.id)?.focus();
        }
      });
    };
    // Also stamps the input-vs-window-focus ordering used to tell user-driven
    // focus from WebKit's own restoration churn (see the refs' declaration).
    const noteUserIntent = () => {
      lastUserInputSeqRef.current = ++focusOrderSeqRef.current;
      schedule();
    };
    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("focusout", schedule);
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", bounceStolenFocus);
    // Recovery backstop for editables that vanish on a path the explicit
    // re-samples (pane membership, the known modals) don't cover: WebKit emits
    // no focusout when a focused element's subtree is removed, so
    // webEditableFocused can wedge true with focus back on <body>, leaving
    // every terminal keyboard-dead. Keys and clicks only reach the DOM at all
    // while the native surface doesn't own the keyboard, so re-sampling on
    // them is cheap (rAF-coalesced, no-op state update) and heals any such
    // wedge on the user's next keystroke or click, whatever overlay caused it.
    window.addEventListener("keydown", noteUserIntent, true);
    window.addEventListener("pointerdown", noteUserIntent, true);
    sample();
    return () => {
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("focusout", schedule);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", bounceStolenFocus);
      window.removeEventListener("keydown", noteUserIntent, true);
      window.removeEventListener("pointerdown", noteUserIntent, true);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);

  // Track whether a non-collapsed DOM selection exists, rAF-coalesced since
  // selectionchange fires for every caret move during a drag-select. Clicking
  // a native terminal collapses the DOM selection (the webview still sees the
  // mousedown), so the flag drops and the terminal reclaims the keyboard.
  useEffect(() => {
    let frame: number | null = null;
    const sample = () => {
      frame = null;
      const selection = document.getSelection();
      setWebSelectionActive(Boolean(selection && !selection.isCollapsed));
    };
    const schedule = () => {
      if (frame === null) {
        frame = requestAnimationFrame(sample);
      }
    };
    document.addEventListener("selectionchange", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);

  // Backstop for editables that unmount together with a closing pane (the
  // terminal and transcript find inputs live inside pane subtrees): WebKit
  // emits no focusout when a focused element is removed, so without this a
  // pane closing under a focused find input leaves webEditableFocused wedged
  // true and every remaining terminal keyboard-dead. Re-sample focus whenever
  // pane membership changes.
  const paneIdsKey = panes.map((pane) => pane.id).join("\n");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setWebEditableFocused(
        document.hasFocus() && isEditableTarget(document.activeElement),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [paneIdsKey]);

  // The same backstop for editables that unmount with a closing modal: the ⌘K
  // palette, rename dialog, settings, and new-research dialogs all hold DOM
  // focus in a text input, and dismissing them (Escape, submit, backdrop)
  // removes that input with no focusout. Without a re-sample the active
  // terminal stays keyboard-dead until the next real focus event.
  const modalEditorOpen =
    commandPaletteOpen ||
    settingsOpen ||
    newResearchOpen ||
    newDocumentOpen ||
    Boolean(publicationTarget) ||
    Boolean(renamePaneId || renameGroupId);
  useEffect(() => {
    if (modalEditorOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setWebEditableFocused(
        document.hasFocus() && isEditableTarget(document.activeElement),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [modalEditorOpen]);

  // Backstop for the right-pane mount/unmount layout transition: an agent
  // quitting unmounts its turn-pane cell, and starting a terminal over a split
  // unmounts the whole strip, while every terminal tab stays open. That
  // transition can strand keyboard state two ways. An editable unmounting
  // with its cell leaves webEditableFocused wedged true (WebKit emits no
  // focusout for removed subtrees — same hazard as the pane-membership
  // backstop above). And the first-responder churn of the surfaces resizing
  // can park focus on a remembered right-pane editable no one re-focused,
  // silently moving the keyboard to a sibling pane's composer. Once layout
  // settles: drop an intent-less editable restore inside the right pane,
  // re-sample the editable flag, and re-assert the active pane's keyboard —
  // TerminalPane.focus() re-checks every web/native input blocker itself.
  const mountedTurnPaneCellsKey = visibleRightBarSurfaces
    .map((surface) => surface.pane.id)
    .join("\n");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const restored = document.activeElement;
      if (
        !userInputSinceWindowFocus() &&
        restored instanceof HTMLElement &&
        isEditableTarget(restored) &&
        restored.closest(".turn-pane")
      ) {
        restored.blur();
      }
      setWebEditableFocused(
        document.hasFocus() && isEditableTarget(document.activeElement),
      );
      const paneId = activePaneIdRef.current;
      if (paneId) {
        terminalPaneRefs.current.get(paneId)?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [mountedTurnPaneCellsKey, userInputSinceWindowFocus]);

  // Live snapshot of the app-level overlay state for the Escape dispatcher
  // below, which is registered exactly once. Mirrored every render, read only
  // at event time.
  const escapeOverlayStateRef = useRef({
    paneContextMenu,
    groupMenu,
    settingsMenu,
    closeDialog,
    exitDialog,
    renamePaneId,
    renameGroupId,
    resolvingClose,
    quitting,
    settingsOpen,
    error,
  });
  useEffect(() => {
    escapeOverlayStateRef.current = {
      paneContextMenu,
      groupMenu,
      settingsMenu,
      closeDialog,
      exitDialog,
      renamePaneId,
      renameGroupId,
      resolvingClose,
      quitting,
      settingsOpen,
      error,
    };
  });

  // One capture-phase listener dispatches Escape across the app-level
  // overlays in a fixed order. These used to be independent window listeners
  // whose effects re-registered when their deps changed, so their relative
  // position in the same-target capture order silently followed registration
  // history; state lives in the ref above so this listener never re-registers
  // and the order below is the whole story.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const overlays = escapeOverlayStateRef.current;

      // The browser overlay claims Escape exclusively, including from
      // component-level listeners registered after this one.
      const browserOwnerId = activeBrowserOwnerIdRef.current;
      const browserOpen = browserOwnerId
        ? browserOverlayByPaneRef.current[browserOwnerId]?.open === true
        : false;
      if (browserOpen) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeActiveBrowserOverlayRef.current();
        return;
      }

      // The remaining overlays dismiss together on one Escape, as they did as
      // independent listeners that each observed the same keydown.
      const menusOpen = Boolean(
        overlays.paneContextMenu || overlays.groupMenu || overlays.settingsMenu,
      );
      const dialogsOpen = Boolean(overlays.closeDialog || overlays.exitDialog);
      let stopPropagation = false;
      if (menusOpen) {
        event.preventDefault();
        setPaneContextMenu(null);
        setGroupMenu(null);
        setSettingsMenu(null);
      }
      if (dialogsOpen) {
        stopPropagation = true;
        event.preventDefault();
        // Don't dismiss the worktree dialog while its close/delete is running.
        if (!overlays.resolvingClose) {
          setCloseDialog(null);
        }
        if (!overlays.quitting) {
          setExitDialog(null);
        }
      }
      if (overlays.settingsOpen) {
        stopPropagation = true;
        event.preventDefault();
        setSettingsOpen(false);
      }
      // The workspace error banner is lowest priority: it only takes Escape
      // when nothing above it (menus, dialogs, a rename editor) wanted it.
      if (
        overlays.error &&
        !menusOpen &&
        !dialogsOpen &&
        !overlays.renamePaneId &&
        !overlays.renameGroupId
      ) {
        stopPropagation = true;
        event.preventDefault();
        setError(null);
      }
      if (stopPropagation) {
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // The error banner floats over the terminal stage. Register its rect as a
  // web-owned pointer region so clicks on the banner (and its dismiss control)
  // hit WKWebView instead of being forwarded to Ghostty under the transparent
  // hole. A region, not a global pointer claim: claiming all routing made the
  // entire terminal mouse-dead (no clicks, scrolling, or selection) for as long
  // as any error banner stayed up.
  const errorBannerRegionRef = useNativeWebOverlayRegion<HTMLDivElement>(Boolean(error));

  useEffect(() => {
    if (!paneContextMenu && !groupMenu && !settingsMenu) {
      return;
    }
    // Sidebar menus are position:fixed and can extend over the native terminal.
    // Claim web pointer routing so clicks on the overlapping portion hit the
    // menu instead of Ghostty.
    const releaseNativePointer = claimNativeTerminalPointerForWebDrag();
    const handleDismiss = () => {
      setPaneContextMenu(null);
      setGroupMenu(null);
      setSettingsMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape is handled by the app-level Escape dispatcher; this listener
      // only owns the group menu's single-key actions.
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
      releaseNativePointer();
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

  // Persist the OpenRouter key to the backend (its durable, owner-only home) whenever it
  // changes — but only after it has been hydrated from the backend, so the initial
  // in-memory value doesn't clobber the stored key before boot loads it.
  useEffect(() => {
    if (!openRouterKeyHydratedRef.current) {
      return;
    }
    void setOpenRouterKey(settings.openRouterKey).catch(() => undefined);
  }, [settings.openRouterKey]);

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
            captureActive: false,
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Closing Settings can unmount the focused capture input without a reliable
  // blur event. Always restore the configured global shortcut in that case.
  useEffect(() => {
    if (!settingsOpen && showHideShortcutSetting.captureActive) {
      setShowHideShortcutCapturing(false);
    }
  }, [settingsOpen, showHideShortcutSetting.captureActive]);

  useEffect(
    () => () => {
      if (appToastTimerRef.current !== null) {
        window.clearTimeout(appToastTimerRef.current);
      }
    },
    [],
  );
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
  // before this fires). Hydrate that durable value first, then mirror later changes
  // so a fresh spawn — and the next restart's recovery — honors what the dialog shows.
  useEffect(() => {
    if (!useLoginShellHydratedRef.current) {
      return;
    }
    void setUseLoginShell(settings.useLoginShell).catch((err) => {
      setError(`Could not save the login-shell setting: ${unknownErrorMessage(err)}`);
    });
  }, [settings.useLoginShell]);

  // The backend owns this preference because worktrees can also be created by
  // CLI/control-socket and queued forks without a frontend request in flight.
  useEffect(() => {
    if (!worktreeLocationHydratedRef.current) {
      return;
    }
    void setWorktreeLocation(settings.worktreeLocation).catch((err) => {
      setError(`Could not save the worktree-location setting: ${unknownErrorMessage(err)}`);
    });
  }, [settings.worktreeLocation]);

  // Escape handling for the worktree close/exit dialogs and the settings panel
  // lives in the app-level Escape dispatcher; this effect only resets the
  // settings panel's transient state when it closes.
  useEffect(() => {
    if (!settingsOpen) {
      setOpenRouterKeyVisible(false);
      setSettingsTab("basic");
      setShowHideShortcutCapturing(false);
    }
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
      const currentActivePaneId = activePaneIdRef.current;
      const listedIndex = tabIds.indexOf(currentActivePaneId ?? "");
      let fallbackIndex: number;
      if (listedIndex !== -1) {
        fallbackIndex = listedIndex;
      } else if (includeHome) {
        fallbackIndex = direction === 1 ? 0 : Math.min(1, tabIds.length - 1);
      } else {
        fallbackIndex = direction === 1 ? -1 : 0;
      }
      const nextTabId = cycleTabId(
        tabIds,
        currentActivePaneId,
        direction,
        paneSplits,
        fallbackIndex,
      );
      if (nextTabId) {
        focusTabById(nextTabId);
      }
    };

    const focusResearchTabById = (tabId: string) => {
      if (tabId === RESEARCH_HOME_TAB_ID) {
        focusResearchHome();
        return;
      }
      const treeId = researchTreeIdFromTabId(tabId);
      if (treeId) {
        void selectResearchTree(treeId);
        return;
      }
      // Mirror handlePaneTabClick: keep the durable document paired with the
      // short-lived terminal, so viewing the pane clears its tree's badge and
      // the fallback effect returns to this tree when the pane retires.
      const researchNode = researchNodeByPaneIdRef.current.get(tabId);
      if (
        researchNode &&
        researchNode.treeId !== activeResearchTreeIdRef.current
      ) {
        void selectResearchTree(researchNode.treeId);
      }
      focusPaneTab(tabId);
    };

    const cycleResearchTab = (direction: -1 | 1) => {
      const currentResearchTreeId = activeResearchTreeIdRef.current;
      const currentResearchSurfaceActive = activeSurfaceRef.current === "research";
      const activeTabId =
        currentResearchSurfaceActive && currentResearchTreeId
          ? researchTreeTabId(currentResearchTreeId)
          : currentResearchSurfaceActive
            ? RESEARCH_HOME_TAB_ID
            : activePaneIdRef.current;
      const researchTabIds = [RESEARCH_HOME_TAB_ID, ...cycleableResearchTabIds];
      const nextTabId = cycleTabId(
        researchTabIds,
        activeTabId,
        direction,
        paneSplits,
      );
      if (!nextTabId || nextTabId === activeTabId) {
        return;
      }
      focusResearchTabById(nextTabId);
    };

    const executeShortcut = (rawCommand: AppShortcutCommand, repeat: boolean) => {
      const currentSidebarMode = sidebarModeRef.current;
      const command = contextualizeAppShortcut(rawCommand, currentSidebarMode);
      if (repeat && !appShortcutAllowsRepeat(command)) {
        return;
      }
      switch (command.type) {
        case "fontZoomIn":
        case "fontZoomOut":
        case "fontZoomReset":
          setSettings((current) => ({
            ...current,
            fontSize:
              command.type === "fontZoomReset"
                ? TERMINAL_FONT_SIZE
                : clampFontSize(
                    current.fontSize + (command.type === "fontZoomOut" ? -1 : 1),
                  ),
          }));
          return;
        case "focusTab": {
          const pane = numberedTabPanes[command.tabIndex];
          if (pane) {
            focusPaneTab(pane.id);
          }
          return;
        }
        case "focusResearchTab": {
          const tabId = cycleableResearchTabIds[command.tabIndex];
          if (tabId) {
            focusResearchTabById(tabId);
          }
          return;
        }
        case "homeOrCycleAdapter":
          if (
            activeSurfaceRef.current === "pane" &&
            activePaneIdRef.current === HOME_TAB_ID
          ) {
            cycleLauncherAdapter();
          } else {
            focusHomeTab();
          }
          return;
        case "openNewResearch":
          createResearchFromSidebar();
          return;
        case "focusHome":
          focusHomeTab();
          return;
        case "focusResearchHome":
          focusResearchHome();
          return;
        case "focusTerminalMode":
          changeSidebarMode("terminal");
          return;
        case "focusResearchMode":
          changeSidebarMode("research");
          return;
        case "toggleSidebarMode":
          changeSidebarMode(currentSidebarMode === "terminal" ? "research" : "terminal");
          return;
        case "cyclePaneTab":
          if (currentSidebarMode === "research") {
            cycleResearchTab(command.direction);
          } else {
            cycleTab(command.direction, false, cycleableSidebarPanes);
          }
          return;
        case "cycleAllTab":
          cycleTab(command.direction, true, cycleableSidebarPanes);
          return;
        case "moveSidebarItem":
          if (currentSidebarMode === "terminal") {
            moveActiveTerminalPane(command.direction);
          } else {
            moveActiveResearchTree(command.direction);
          }
          return;
        case "openSettings":
          setSettingsMenu(null);
          setSettingsOpen(true);
          return;
        case "openCommandPalette":
          setCommandPaletteOpen(true);
          return;
        case "toggleTranscriptOrBrowser":
          if (
            activeSurfaceRef.current === "pane" &&
            canToggleActiveTranscriptExpandedRef.current
          ) {
            toggleActiveTranscriptExpandedRef.current();
          } else {
            const browserOwnerId =
              activeSurfaceRef.current === "research"
                ? activeResearchTreeIdRef.current
                  ? researchBrowserOwnerId(activeResearchTreeIdRef.current)
                  : null
                : (activePaneRef.current?.id ?? null);
            if (browserOwnerId) {
              toggleBrowserOverlay(browserOwnerId);
            }
          }
          return;
        case "splitPaneBelow": {
          const pane =
            activeSurfaceRef.current === "pane" ? activePaneRef.current : undefined;
          if (
            pane &&
            groupsRef.current.find((group) => group.id === pane.groupId)?.scope === "terminal"
          ) {
            void splitPaneBelowRef.current(pane);
          }
          return;
        }
        case "restoreClosedPane":
          void restoreClosedPane();
          return;
        case "closePane": {
          const pane =
            activeSurfaceRef.current === "pane" ? activePaneRef.current : undefined;
          if (pane) {
            requestClosePaneRef.current(pane);
          }
          return;
        }
        case "newGroup":
          void createGroupFromSettingsMenu();
          return;
        case "newPane":
          if (!settingsRef.current.codeMode) {
            focusHomeTab();
          } else {
            void addShellPane();
          }
      }
    };

    nativeTerminalShortcutHandlerRef.current = (paneId, command, repeat) => {
      if (activePaneRef.current?.id !== paneId) {
        // The native monitor already consumed this chord's keyDown (and will
        // swallow its keyUp) on behalf of `paneId`, so dropping it here eats
        // the keystroke entirely. A mismatch means React's activation state
        // is still catching up to the surface that really owns the keyboard
        // (click-then-chord on a split, right-click activation in flight):
        // adopt the native side's authority — activate that pane, then run
        // the command against it. setActivePaneId updates activePaneRef /
        // activePaneIdRef synchronously, so executeShortcut below targets it.
        // A pane React no longer knows can still run commands that don't act
        // on the active pane (mode toggles, Home, settings…); pane-targeted
        // commands stay dropped rather than hitting a pane the user never
        // aimed at.
        if (!panesRef.current.some((pane) => pane.id === paneId)) {
          if (!appShortcutTargetsActivePane(command)) {
            executeShortcut(command, repeat);
          }
          return;
        }
        setActivePaneId(paneId);
      }
      executeShortcut(command, repeat);
    };
    nativeAppShortcutHandlerRef.current = executeShortcut;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShowHideShortcutCaptureTarget(event.target) || event.defaultPrevented) {
        return;
      }
      const command = resolveAppShortcut({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        terminalTarget: isTerminalTarget(event.target),
        editableTarget: isEditableTarget(event.target),
      });
      if (!command) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      executeShortcut(command, event.repeat);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      nativeTerminalShortcutHandlerRef.current = () => undefined;
      nativeAppShortcutHandlerRef.current = () => undefined;
    };
  }, [
    activePaneId,
    panes,
    sidebarPanes,
    cycleableSidebarPanes,
    cycleableResearchTabIds,
    numberedTabPanes,
    activePane,
    lastActiveGroupId,
    groupById,
    homeActive,
    launcherAdapterOptions,
    launchAdapter.id,
    paneSplits,
    changeSidebarMode,
    researchSurfaceActive,
    researchHomeActive,
    activeResearchTreeId,
    focusResearchHome,
    createResearchFromSidebar,
    moveActiveResearchTree,
    selectResearchTree,
    sidebarMode,
  ]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      return;
    }
    void listSavedPrompts(promptProjectDirForPane(activePane))
      .then((library) => setPaletteSavedPrompts(library.prompts))
      .catch(() => setPaletteSavedPrompts([]));
  }, [commandPaletteOpen, activePane, groupById]);

  useEffect(() => {
    if (!homeActive) {
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
  }, [homeActive]);

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
  }, [selectedSkill, homeActive]);

  // Grow the launcher textarea to fit its content so a multi-line prompt expands the
  // whole launcher (the CSS max-height caps it, after which the field scrolls). Runs
  // from the (uncontrolled) textarea's onChange for typing; this effect covers the
  // remaining triggers — the launcher appearing and the skill prefix changing the
  // first line's indent.
  const growLauncherInput = useCallback(() => {
    const textarea = launcherInputRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);
  const clearLauncherPrompt = useCallback(() => {
    promptRef.current = "";
    const textarea = launcherInputRef.current;
    if (textarea) {
      textarea.value = "";
    }
    growLauncherInput();
  }, [growLauncherInput]);
  useLayoutEffect(() => {
    if (!homeActive) {
      return;
    }
    growLauncherInput();
  }, [growLauncherInput, homeActive, skillPrefixWidth]);

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
    const request = ++showHideShortcutRequestRef.current;
    setShowHideShortcutSaving(true);
    setShowHideShortcutSetting((current) => ({
      ...current,
      accelerator,
      error: null,
    }));
    try {
      const setting = await setShowHideShortcut(accelerator);
      if (showHideShortcutRequestRef.current === request) {
        setShowHideShortcutSetting(setting);
      }
    } catch (err) {
      if (showHideShortcutRequestRef.current === request) {
        setShowHideShortcutSetting((current) => ({
          ...current,
          error: unknownErrorMessage(err),
        }));
      }
    } finally {
      setShowHideShortcutSaving(false);
    }
  }

  async function updateGlobalTaskLauncherHotkey(hotkey: GlobalTaskLauncherHotkey) {
    const request = ++globalTaskLauncherHotkeyRequestRef.current;
    setGlobalTaskLauncherHotkeySaving(true);
    setGlobalTaskLauncherSetting((current) => ({ ...current, hotkey, error: null }));
    try {
      const setting = await setGlobalTaskLauncherHotkey(hotkey);
      if (globalTaskLauncherHotkeyRequestRef.current === request) {
        setGlobalTaskLauncherSetting(setting);
      }
    } catch (err) {
      if (globalTaskLauncherHotkeyRequestRef.current === request) {
        setGlobalTaskLauncherSetting((current) => ({
          ...current,
          error: unknownErrorMessage(err),
        }));
      }
    } finally {
      if (globalTaskLauncherHotkeyRequestRef.current === request) {
        setGlobalTaskLauncherHotkeySaving(false);
      }
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
    const request = ++showHideShortcutRequestRef.current;
    setShowHideShortcutSetting((current) => ({ ...current, captureActive: active }));
    void setShowHideShortcutCaptureActive(active)
      .then((setting) => {
        if (showHideShortcutRequestRef.current === request) {
          setShowHideShortcutSetting(setting);
        }
      })
      .catch((err) => {
        if (showHideShortcutRequestRef.current === request) {
          setShowHideShortcutSetting((current) => ({
            ...current,
            captureActive: false,
            error: unknownErrorMessage(err),
          }));
        }
      });
  }

  function startTurnPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const releasePointer = claimResizePointer(event);
    const startX = event.clientX;
    const startWidth = turnPaneWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setTerminalGeometryResizing(true);

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
      releasePointer();
      setTerminalGeometryResizing(false);
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
    const releasePointer = claimResizePointer(event);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setTerminalGeometryResizing(true);

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
      releasePointer();
      setTerminalGeometryResizing(false);
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

  // The launcher form lives on Home and creates a new agent in the selected group.
  const renderLauncher = () => (
    <form
      className="command-launcher"
      role="dialog"
      aria-label="New agent"
      onKeyDown={(event) => {
        // Swallow Undo/Redo (⌘Z / ⌘⇧Z, Ctrl on other platforms). The prompt is
        // cleared programmatically on launch (outside the WebView's undo
        // history), so native undo could resurrect a sent prompt — or, with no
        // applicable history, blur the textarea and hand focus back to the
        // terminal. Trapping the combo keeps focus (and the caret) put.
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
        defaultValue={promptRef.current}
        onChange={(event) => {
          promptRef.current = event.currentTarget.value;
          growLauncherInput();
        }}
        rows={2}
        placeholder="What should we investigate next?"
        style={selectedSkill ? { textIndent: `${skillPrefixWidth}px` } : undefined}
      />
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
            className="control-button command-launcher-send"
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
    const menuHeight =
      sidebarMode === "terminal"
        ? SETTINGS_CONTEXT_MENU_TERMINAL_HEIGHT
        : SETTINGS_CONTEXT_MENU_RESEARCH_HEIGHT;
    const maxX = Math.max(8, window.innerWidth - SETTINGS_CONTEXT_MENU_WIDTH - 8);
    const maxY = Math.max(8, window.innerHeight - menuHeight - 8);
    const x = clamp(rect.right - SETTINGS_CONTEXT_MENU_WIDTH, 8, maxX);
    const upwardY = rect.top - menuHeight - 6;
    const downwardY = rect.bottom + 6;
    const y = clamp(upwardY >= 8 ? upwardY : downwardY, 8, maxY);
    setPaneContextMenu(null);
    setGroupMenu(null);
    setSettingsMenu((current) => (current ? null : { x, y }));
  }

  function renderPaneTabRow(
    pane: PaneInfo,
    index: number,
    groupPanes: PaneInfo[],
    groupId: string,
    allowDrag = true,
  ) {
    const paneAgent = agentByPaneId.get(pane.id);
    const paneDisplayTitle = displayPaneTitle(pane, paneAgent);
    const paneTitleIsUserSet = paneHasUserSetTitle(pane, paneAgent);
    const paneAgentStatusTone = paneTabStatusTone(paneAgent);
    const paneAgentStatusClass =
      paneAgent?.status === "awaitingInput" ? " status-awaiting-input" : "";
    const canClearWorkingStatus =
      allowDrag && (paneAgent?.status === "running" || paneAgent?.status === "starting");
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
      allowDrag && paneDropTarget?.kind === "gap" && paneDropTarget.groupId === groupId
        ? paneDropTarget.index
        : null;
    const isNestTarget =
      allowDrag &&
      paneDropTarget?.kind === "nest" &&
      paneDropTarget.groupId === groupId &&
      paneDropTarget.paneId === pane.id;
    const isDraggingRow =
      allowDrag &&
      draggingPaneGroup === groupId &&
      draggingPaneIndex >= 0 &&
      index >= draggingPaneIndex &&
      index < draggingSubtreeEnd;
    const shortcutIndex = sidebarPaneIndexById.get(pane.id) ?? -1;
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
        data-pane-drag-disabled={allowDrag ? undefined : "true"}
        style={{ "--pane-depth": pane.depth ?? 0 } as CSSProperties}
        onContextMenu={
          allowDrag
            ? (event) => openPaneContextMenu(event, pane)
            : (event) => event.preventDefault()
        }
        onPointerDown={allowDrag ? (event) => handlePaneTabPointerDown(event, pane.id) : undefined}
        onPointerMove={allowDrag ? handlePaneTabPointerMove : undefined}
        onPointerUp={allowDrag ? handlePaneTabPointerUp : undefined}
        onPointerCancel={allowDrag ? handlePaneTabPointerCancel : undefined}
        onClick={() => handlePaneTabClick(pane.id)}
        onDoubleClick={allowDrag ? () => handlePaneTabDoubleClick(pane) : undefined}
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
          className="control-button pane-tab"
          onClick={(event) => {
            event.stopPropagation();
            handlePaneTabClick(pane.id);
          }}
          onDoubleClick={
            allowDrag
              ? (event) => {
                  event.stopPropagation();
                  handlePaneTabDoubleClick(pane);
                }
              : undefined
          }
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
            className="control-button pane-tab-clear-status pane-tab-dot-button"
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
    const index = activePaneSplit?.paneIds.indexOf(surface.pane.id) ?? -1;
    return {
      top: splitTrackPosition(surface.topFraction, Math.max(0, index)),
      height: splitTrackSize(surface.heightFraction),
    };
  }

  function renderFloatingTurnPaneControls(surface: TurnPaneSurface) {
    const expanded = surface.pane.id === activePane?.id && activeTranscriptExpanded;
    const label = expanded ? "Restore transcript" : "Expand transcript";
    return (
      <div className="turn-pane-floating-controls">
        <button
          type="button"
          className={`control-button turn-pane-header-button turn-pane-floating-expand-button${
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
          className="icon-button turn-pane-header-button turn-pane-floating-collapse-button"
          title="Collapse right bar"
          aria-label="Collapse right bar"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            activateTerminalPane(surface.pane.id);
            setRightBarCollapsedForPane(true, surface.pane.id);
          }}
        >
          <PanelRightClose size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }

  function renderFloatingRightBarRestoreButton() {
    if (!floatingRestoreButtonVisible || !activeTurnPaneSurface) {
      return null;
    }

    const surface = activeTurnPaneSurface;
    const splitIndex =
      activePaneSplit ? activePaneSplit.paneIds.indexOf(surface.pane.id) : -1;
    // In split mode this control must remain in the active pane's track. Leaving
    // it at the stage-wide `top: 8px` puts a lower pane's restore control over
    // the top terminal; native pointer routing can then grant that sibling the
    // keyboard during the opening gesture before the web overlay registration
    // has crossed the bridge.
    const style =
      splitRightPaneMode && splitIndex >= 0
        ? { top: splitTrackPosition(surface.topFraction, splitIndex, 8) }
        : undefined;

    return (
      <button
        ref={floatingRestoreButtonRef}
        type="button"
        className="icon-button turn-pane-header-button turn-pane-floating-restore-button"
        title="Show right bar"
        aria-label="Show right bar"
        style={style}
        onClick={() => {
          activateTerminalPane(surface.pane.id);
          setRightBarCollapsedForPane(false, surface.pane.id);
        }}
      >
        <PanelRightOpen size={14} aria-hidden="true" />
      </button>
    );
  }

  function renderTurnPaneSurface(surface: TurnPaneSurface, showHeader: boolean) {
    const agent = surface.agent;
    // Scope-based, not node-based: the node index refreshes on a 250ms
    // debounce, so a freshly spawned research pane would briefly present
    // fork/queue affordances (and a composer below) that its run rejects.
    // Group scope arrives with the pane itself.
    const researchBound = groupById.get(surface.pane.groupId)?.scope === "research";
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
        stickyUserMessages={settings.stickyUserMessages}
        agentId={agent?.id ?? surface.pane.id}
        // The save request is a window event handled only by the prompt
        // library menu inside TurnPaneHeader. Headerless surfaces (split
        // cells, split right-pane mode) mount no listener, so offering the
        // menu item there would dispatch into the void — hide it instead.
        savePromptAgentId={showHeader ? (agent?.id ?? null) : null}
        searchHotkeyActive={activeSurface === "pane" && surface.pane.id === activePane?.id}
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
              agentId={agent?.id ?? null}
              sessionId={agent?.sessionId ?? null}
              transcriptOptions={agent ? surface.transcriptOptions : []}
              transcriptPath={agent?.transcriptPath ?? null}
              onSelectTranscript={(path) => {
                if (agent) {
                  void handleSelectTranscript(agent.id, path);
                }
              }}
              canFork={!researchBound && agentCanFork(agent)}
              onFork={(options) => void forkActivePane(options)}
              showQueueSplit={Boolean(agent) && !researchBound}
              queueSplit={surface.queueSplit}
              onToggleQueueSplit={toggleActiveQueueSplit}
              browserOpen={surface.browserOverlay?.open ?? false}
              onToggleBrowser={toggleActiveBrowserOverlay}
              transcriptExpanded={activeTranscriptExpanded}
              transcriptShortcutLabel={EXPAND_TOGGLE_SHORTCUT_LABEL}
              onToggleTranscriptExpanded={toggleActiveTranscriptExpanded}
              onCollapseRightBar={() =>
                setRightBarCollapsedForPane(true, surface.pane.id)
              }
              onInsertPrompt={
                agent ? (text) => requestComposerInsert(agent.id, text) : undefined
              }
              promptProjectDir={promptProjectDirForPane(surface.pane)}
              promptProjectPath={homeRelativePath(promptProjectDirForPane(surface.pane))}
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
                  void moveQueuedTurnToAgent(agentId, agent?.id, index, turn)
                }
                onDiscardTurn={(agentId, index, turn) =>
                  void discardRecoveredQueuedTurn(agentId, index, turn)
                }
              />
            ) : null}
            {/* Research runs take one prompt at launch: hide the composer so
                turns can't be queued into an agent that never drains them
                (follow-ups branch from the research document instead). Keyed
                off group scope so the composer never flashes in the debounce
                window before the node index catches up. */}
            {agent && groupById.get(surface.pane.groupId)?.scope !== "research" ? (
              <NativeInput
                pane={surface.pane}
                agent={agent}
                agentMayBeBackgrounded={
                  shellJobByAgent[agent.id]?.paneId === surface.pane.id &&
                  (shellJobByAgent[agent.id]?.state === "backgrounded" ||
                    shellJobByAgent[agent.id]?.state === "stopped")
                }
                draft={surface.draft}
                queuedTurns={surface.queuedTurns}
                waitTargets={surface.waitTargets}
                queueSplit={queueSplit}
                requireCmdEnterToSend={settings.requireCmdEnterToSend}
                pasteProtection={pasteProtection}
                hasTranscript={surface.hasTranscript}
                transcriptCopyPlainText={() => surface.getPlainTextTranscript()}
                transcriptCopyJsonText={() =>
                  formatTranscriptCopyJson({
                    agent,
                    pane: surface.pane,
                    transcriptText: surface.getTranscript(),
                    turns: surface.turns,
                    hooks: hookEventsByAgentRef.current[agent.id] ?? [],
                  })
                }
                onPublishTranscript={() => {
                  const turnsSnapshot = surface.turns;
                  const title =
                    surface.pane.title.trim() ||
                    `${surface.assistantLabel} transcript`;
                  setPublicationTarget({
                    kindLabel: "transcript",
                    initialTitle: title,
                    previewText: surface.getPlainTextTranscript(),
                    buildDraft: (publicationTitle) =>
                      createTranscriptPublicationDraft({
                        title: publicationTitle,
                        pane: surface.pane,
                        agent,
                        turns: turnsSnapshot,
                        assistantLabel: surface.assistantLabel,
                      }),
                  });
                }}
                composerPolicy={getAgentUiAdapter(agent.adapter).composerPolicy(agent)}
                shortcutLabelForPane={shortcutLabelForPaneId}
                onQueueChange={setAgentQueuedTurns}
                onQueueDropTargetChange={setQueueDropTargetAgentId}
                onMoveQueuedTurn={(targetAgentId, index, turn) =>
                  void moveQueuedTurnToAgent(agent.id, targetAgentId, index, turn)
                }
                onDraftChange={setAgentDraft}
                registerDraftFlusher={registerComposerDraftFlusher}
                onWaitTargetHover={setWaitTargetHoverAgentId}
                onForkWithPrompt={({ useWorktree, prompt }) =>
                  forkPane(surface.pane, {
                    nest: true,
                    useWorktree,
                    prompt,
                  })
                }
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
                onUserInput={stableNoteUserInput}
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

  const renamingGroup = renameGroupId ? groupById.get(renameGroupId) : undefined;
  const renamingResearchFolder =
    renamingGroup?.scope === "research" ? renamingGroup : undefined;

  return (
    <main
      ref={appRef}
      className={`app-shell ${hasGlobalTurnSidebar ? "has-turn-sidebar" : ""}${
        activeTranscriptVisibleExpanded ? " has-expanded-transcript" : ""
      }${settings.reduceMotion ? " reduce-motion" : ""}${
        IS_MAC ? " is-native-terminals" : ""
      }`}
      style={appStyle}
    >
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
      <aside
        ref={sidebarRef}
        className={`sidebar${sidebarWidth < LEFT_SIDEBAR_COMPACT_WIDTH ? " is-narrow" : ""}${
          settings.codeMode ? " is-code-mode" : ""
        }${sidebarMode === "research" ? " is-research-mode" : ""}`}
      >
        <div className="titlebar-drag" data-tauri-drag-region aria-hidden="true" />
        <SidebarModeToggle
          mode={sidebarMode}
          shortcutHintsShown={shortcutHintsShown}
          runningResearchCount={runningResearchCount}
          unseenResearchCount={unseenResearchCount}
          failedResearchCount={failedResearchCount}
          onChange={changeSidebarMode}
        />
        {sidebarMode === "research" ? (
          <div
            className={`pane-tab-row pane-home-row research-home-row${
              researchHomeActive ? " is-selected" : ""
            }`}
            data-research-home-tab="true"
            onClick={focusResearchHome}
          >
            <button
              type="button"
              className="control-button pane-tab"
              aria-current={researchHomeActive ? "page" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                focusResearchHome();
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
        ) : null}
        {sidebarMode === "research" ? (
          <ResearchFolderSwitcher
            folders={researchGroups}
            scope={researchScope}
            treeCounts={researchFolderTreeCounts}
            folderPickerBusy={folderPickerStatus !== null}
            onSelectScope={(scope) => {
              changeResearchFolderScope(scope);
              // Keep the selection inside the new scope: an active document
              // from another folder would otherwise sit with no sidebar row.
              const allTrees = [...researchTrees, ...archivedResearchTrees];
              const scopedTrees = treesForResearchScope(allTrees, scope);
              const activeInScope = scopedTrees.some(
                (tree) => tree.id === activeResearchTreeId,
              );
              const activeResearchPane = panesRef.current.find(
                (pane) => pane.id === activeResearchPaneIdRef.current,
              );
              const activePaneInScope =
                !activeResearchPane ||
                workspaceIsInResearchScope(activeResearchPane.groupId, scope);
              if (!activePaneInScope) {
                activeResearchPaneIdRef.current = null;
                setActiveResearchPaneId(null);
                localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
              }
              if (researchHomeActive) {
                return;
              }
              if (!activeInScope || !activePaneInScope) {
                const tree = treeForResearchScope(allTrees, scope, activeResearchTreeId);
                if (tree) {
                  void selectResearchTree(tree.id);
                } else {
                  activeResearchTreeIdRef.current = null;
                  setActiveResearchTreeId(null);
                  setActiveResearchDetail(null);
                  setActiveResearchDetailError(null);
                  localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
                  setActiveSurface("research");
                }
              }
            }}
            onNewFolder={chooseResearchWorkspaceFolder}
            onOpenFolder={openResearchWorkspaceFolder}
            onRenameFolder={openGroupRenameDialog}
            onMoveFolder={moveResearchWorkspaceFolder}
            onRemoveFolder={(workspace) => {
              setResearchFolderRemovalError(null);
              setCloseDialog({ kind: "researchFolderRemove", workspace });
            }}
          />
        ) : null}
        <nav
          ref={paneListRef}
          className={`pane-list${draggingPaneId || draggingGroupId ? " is-dragging" : ""}`}
          aria-label={sidebarMode === "terminal" ? "Terminal tabs" : "Research"}
        >
          {/* Fixed Home tab: not a real pane, so it can't be closed, reordered, or
              nested. Selecting it shows the empty content placeholder (the launcher). */}
          {sidebarMode === "terminal" ? (
            <div
              className={`pane-tab-row pane-home-row${homeActive ? " is-selected" : ""}`}
              data-home-tab="true"
              onClick={() => setActivePaneId(HOME_TAB_ID)}
            >
              <button
                type="button"
                className="control-button pane-tab"
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
          ) : null}
          {sidebarMode === "research" ? (
            <ResearchSidebarSection
              trees={scopedResearchTrees}
              archivedTrees={scopedArchivedResearchTrees}
              visibilityFilter={researchVisibilityFilter}
              activeTreeId={activeResearchTreeId}
              onSelect={(treeId) => {
                if (
                  isResearchTreeSelectionChange(
                    activeResearchTreeId,
                    researchSurfaceActive,
                    treeId,
                  )
                ) {
                  void selectResearchTree(treeId);
                }
              }}
              onRename={renameResearchTreeTitle}
              onArchive={archiveResearchTreeFromSidebar}
              onRegenerateTitle={regenerateResearchTreeTitle}
              onRestore={restoreResearchTreeFromSidebar}
              onRemove={removeResearchTreeFromSidebar}
              onReorder={(archived, orderedTreeIds) => {
                if (researchScope) {
                  applyResearchTreeOrder(archived, researchScope, orderedTreeIds);
                }
              }}
            />
          ) : null}
          {sidebarMode === "terminal" ? terminalGroups.map((group, groupIndex) => {
            const groupPanes = panes.filter((pane) => pane.groupId === group.id);
            const hasGroupPanes = groupPanes.length > 0;
            const isActiveGroup = activePane?.groupId === group.id;
            const isCollapsedGroup = group.collapsed;
            const groupDisplayName = displayGroupName(group);
            const groupRootPath = groupRootDir(group);
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
                  groupDropGap === terminalGroups.length &&
                  groupIndex === terminalGroups.length - 1
                    ? " is-group-drop-after"
                    : ""
                }`}
                data-group-id={group.id}
                onContextMenu={(event) => openGroupMenu(event, group)}
              >
                <div
                  className="pane-group-header"
                  title={groupRootPath}
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
                      className="control-button pane-group-collapse-button"
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
                      className="control-button pane-group-menu-button"
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
          }) : null}
          {sidebarMode === "research" && scopedResearchPanes.length > 0 ? (
            <section className="research-live-terminals" aria-label="Live research terminals">
              <div className="research-sidebar-heading">
                <span>Live terminals</span>
                <span
                  className="research-workspace-total"
                  aria-label={`${scopedResearchPanes.length} live research terminals`}
                >
                  {scopedResearchPanes.length}
                </span>
              </div>
              <div className="pane-list-body">
                {scopedResearchPanes.map((pane, index) =>
                  renderPaneTabRow(pane, index, scopedResearchPanes, pane.groupId, false),
                )}
              </div>
            </section>
          ) : null}
        </nav>

        <div
          className={`sidebar-actions${
            sidebarMode === "terminal" && !settings.codeMode ? " is-agent-only" : ""
          }`}
        >
          {sidebarMode === "terminal" ? (
            <>
              {settings.codeMode ? (
                <div className="sidebar-action-with-hint">
                  <button className="control-button" type="button" onClick={addShellPane}>
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
                <button className="control-button" type="button" onClick={focusHomeTab}>
                  <MessageSquareText size={14} aria-hidden="true" />
                  <span>New agent</span>
                </button>
                {shortcutHintsShown ? (
                  <span
                    className="pane-tab-shortcut-hint sidebar-action-shortcut-hint"
                    aria-hidden="true"
                  >
                    {settings.codeMode ? "⌘N" : "⌘N · ⌘T"}
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="sidebar-action-with-hint">
                <button className="control-button" type="button" onClick={() => void createResearchFromSidebar()}>
                  <Plus size={14} aria-hidden="true" />
                  <span>New query</span>
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
              <div className="sidebar-action-with-hint">
                <button className="control-button" type="button" onClick={() => void createDocumentFromSidebar()}>
                  <FileText size={14} aria-hidden="true" />
                  <span>New doc</span>
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            className="control-button sidebar-settings-button"
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
        {markdownDropTargetActive ? (
          <div className="research-markdown-drop-overlay" role="status" aria-live="polite">
            <FileUp size={34} strokeWidth={1.5} aria-hidden="true" />
            <strong>Drop Markdown file</strong>
            <span>Open it in a new document</span>
          </div>
        ) : null}
      </aside>

      {settingsMenu ? (
        <div
          className="popover-surface popover-surface--context pane-context-menu settings-context-menu"
          role="menu"
          aria-label="Settings menu"
          style={{ left: settingsMenu.x, top: settingsMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="group-context-actions">
            {sidebarMode === "terminal" ? (
              <button
                type="button"
                role="menuitem"
                className="control-button context-menu-has-shortcut"
                disabled={folderPickerStatus !== null}
                onClick={() => {
                  void createGroupFromSettingsMenu();
                }}
              >
                <Plus size={13} aria-hidden="true" />
                <span>New group...</span>
                <kbd className="context-menu-shortcut">⌘⇧N</kbd>
              </button>
            ) : null}
            {sidebarMode === "research" ? (
              <>
                {RESEARCH_VISIBILITY_FILTER_OPTIONS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    className="control-button settings-research-filter-option"
                    aria-checked={researchVisibilityFilter === id}
                    onClick={() => {
                      setSettingsMenu(null);
                      changeResearchVisibilityFilter(id);
                    }}
                  >
                    {researchVisibilityFilter === id ? (
                      <Check size={13} aria-hidden="true" />
                    ) : null}
                    <span>{label}</span>
                  </button>
                ))}
                <div className="context-menu-divider" role="separator" />
              </>
            ) : null}
            <button className="control-button"
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
          className="popover-surface popover-surface--context pane-context-menu group-context-menu"
          role="menu"
          aria-label="Group options"
          style={{ left: groupMenu.x, top: groupMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="group-context-actions">
            <button className="control-button"
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
              className="control-button context-menu-has-shortcut"
              onClick={() => {
                setGroupMenu(null);
                openGroupRenameDialog(groupMenuGroup);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
              <span>Rename group</span>
              <kbd className="context-menu-shortcut is-keycap">R</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              className="control-button context-menu-has-shortcut"
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
              {groupMenuGroup.collapsed ? (
                <span className="context-menu-shortcut-options" aria-label="C or E">
                  <kbd className="context-menu-shortcut is-keycap">C</kbd>
                  <span aria-hidden="true">/</span>
                  <kbd className="context-menu-shortcut is-keycap">E</kbd>
                </span>
              ) : (
                <kbd className="context-menu-shortcut is-keycap">C</kbd>
              )}
            </button>
            <div className="context-menu-divider" role="separator" />
            {settings.codeMode ? (
              <button className="control-button"
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
            <button className="control-button"
              type="button"
              role="menuitem"
              onClick={() => {
                setGroupMenu(null);
                setActivePaneId(HOME_TAB_ID);
                setLastActiveGroupId(groupMenuGroup.id);
                focusLauncherInput();
              }}
            >
              <MessageSquareText size={13} aria-hidden="true" />
              <span>New agent</span>
            </button>
            <div className="context-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="control-button context-menu-has-shortcut"
              disabled={folderPickerStatus !== null}
              onClick={() => {
                setGroupMenu(null);
                void createGroupAfterWithFolder(groupMenuGroup);
              }}
            >
              <Plus size={13} aria-hidden="true" />
              <span>New group...</span>
              <kbd className="context-menu-shortcut">⌘⇧N</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              className="control-button context-menu-danger"
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
          className="popover-surface popover-surface--context pane-context-menu"
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
              className="control-button context-menu-has-shortcut"
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
              <button className="control-button"
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
              <button className="control-button"
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
            <button className="control-button"
              type="button"
              role="menuitem"
              onClick={() => {
                setPaneContextMenu(null);
                setActivePaneId(contextMenuPane.id);
                toggleBrowserOverlay(contextMenuPane.id);
              }}
            >
              <Globe size={13} aria-hidden="true" />
              <span>
                {browserOverlayByPane[contextMenuPane.id]?.open
                  ? "Hide browser"
                  : "Show browser"}
              </span>
            </button>
            <div className="context-menu-divider" role="separator" />
            <button className="control-button"
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
            <button className="control-button"
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
            {canForkContextMenuPane ? (
              <>
                <div className="context-menu-divider" role="separator" />
                <button className="control-button"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPaneContextMenu(null);
                    void forkPane(contextMenuPane, { nest: true, useWorktree: false });
                  }}
                >
                  <GitBranch size={13} aria-hidden="true" />
                  <span>Fork session</span>
                </button>
                <button className="control-button"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPaneContextMenu(null);
                    void forkPane(contextMenuPane, { nest: true, useWorktree: true });
                  }}
                >
                  <GitBranch size={13} aria-hidden="true" />
                  <span>Fork session in worktree</span>
                </button>
              </>
            ) : null}
            <div className="context-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="control-button context-menu-danger"
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

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commandPaletteOpen ? buildPaletteCommands() : []}
      />

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
                className="control-button settings-close"
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
                className={`control-button${settingsTab === "basic" ? " is-active" : ""}`}
                onClick={() => setSettingsTab("basic")}
              >
                Basic
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === "advanced"}
                className={`control-button${settingsTab === "advanced" ? " is-active" : ""}`}
                onClick={() => setSettingsTab("advanced")}
              >
                Advanced
              </button>
            </div>

            {settingsTab === "basic" ? (
              <div className="settings-content" role="tabpanel">
            <div className="settings-row">
              <label htmlFor="settings-color-theme" className="settings-label">
                Color theme
              </label>
              <select
                id="settings-color-theme"
                className="settings-select"
                value={settings.colorTheme}
                onChange={(event) => {
                  const colorTheme = event.currentTarget.value as AppSettings["colorTheme"];
                  setSettings((current) => ({ ...current, colorTheme }));
                }}
              >
                {COLOR_THEME_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="settings-theme" className="settings-label">
                Terminal theme
              </label>
              <div className="settings-theme-field">
                {selectedTheme ? (
                  <span className="settings-theme-preview" aria-hidden="true">
                    {themePreviewColors(selectedTheme).map((color, index) => (
                      <span key={index} style={{ background: color }} />
                    ))}
                  </span>
                ) : null}
                <select
                  id="settings-theme"
                  className="settings-select"
                  value={settings.themeId}
                  onChange={(event) => {
                    // Read the value synchronously before React resets currentTarget.
                    const themeId = event.currentTarget.value;
                    setSettings((current) => ({ ...current, themeId }));
                  }}
                >
                  <option value={DEFAULT_THEME_ID}>qmux (default)</option>
                  {selectedTheme === null && settings.themeId !== DEFAULT_THEME_ID ? (
                    // A stored theme the catalog doesn't have (or the catalog
                    // is still loading): keep the select controlled without
                    // silently jumping the visible selection to the default.
                    <option value={settings.themeId}>{settings.themeId}</option>
                  ) : null}
                  {themeGroups.dark.length > 0 ? (
                    <optgroup label="Dark">
                      {themeGroups.dark.map((theme) => (
                        <option key={theme.name} value={theme.name}>
                          {theme.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {themeGroups.light.length > 0 ? (
                    <optgroup label="Light">
                      {themeGroups.light.map((theme) => (
                        <option key={theme.name} value={theme.name}>
                          {theme.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>
            </div>

            <div className="settings-row">
              <label htmlFor="settings-body-font" className="settings-label">
                Body font
              </label>
              <select
                id="settings-body-font"
                className="settings-select"
                value={availableBodyFonts === null ? "" : settings.bodyFontId}
                disabled={availableBodyFonts === null}
                onChange={(event) => {
                  const bodyFontId = event.currentTarget.value;
                  setSettings((current) => ({ ...current, bodyFontId }));
                }}
              >
                {availableBodyFonts === null ? (
                  <option value="">Detecting installed fonts…</option>
                ) : (
                  availableBodyFonts.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="settings-font" className="settings-label">
                Terminal font
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
                <button className="control-button"
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
                <button className="control-button"
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

            <div className="settings-row">
              <label htmlFor="settings-worktree-location" className="settings-label">
                Worktree location
              </label>
              <select
                id="settings-worktree-location"
                className="settings-select"
                value={settings.worktreeLocation}
                onChange={(event) => {
                  const worktreeLocation =
                    event.currentTarget.value as AppSettings["worktreeLocation"];
                  setSettings((current) => ({ ...current, worktreeLocation }));
                }}
              >
                {WORKTREE_LOCATION_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="settings-hint">
              {settings.worktreeLocation === "localQmux"
                ? "New worktrees stored in <project>/.qmux/worktrees/<name>."
                : settings.worktreeLocation === "localClaude"
                  ? "New worktrees stored in <project>/.claude/worktrees/<name>."
                  : "New worktrees stored in qmux’s global workspace directory."}
            </p>

            <label className="settings-row settings-toggle">
              <span className="settings-label">
                Code mode (enables worktrees, extra shell UI, etc.)
              </span>
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
                    stickyUserMessages: codeMode,
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
              <span className="settings-label settings-label-indented">
                Pin latest user message on top of transcripts
              </span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.stickyUserMessages}
                onChange={(event) => {
                  const stickyUserMessages = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, stickyUserMessages }));
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
              <label htmlFor="settings-global-task-launcher-hotkey" className="settings-label">
                Global quick launch hotkey
              </label>
              <select
                id="settings-global-task-launcher-hotkey"
                className="form-field settings-input"
                value={globalTaskLauncherSetting.hotkey}
                disabled={globalTaskLauncherHotkeySaving}
                aria-invalid={globalTaskLauncherHotkeyMessage ? true : undefined}
                aria-describedby={
                  globalTaskLauncherHotkeyMessage
                    ? "settings-global-task-launcher-hotkey-message"
                    : undefined
                }
                onChange={(event) =>
                  void updateGlobalTaskLauncherHotkey(
                    event.currentTarget.value as GlobalTaskLauncherHotkey,
                  )
                }
              >
                {GLOBAL_TASK_LAUNCHER_HOTKEY_OPTIONS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={Boolean(
                      option.accelerator && option.accelerator === showHideShortcutValue,
                    )}
                  >
                    {option.label}
                    {option.accelerator === showHideShortcutValue ? " (used by Show/hide)" : ""}
                  </option>
                ))}
              </select>
            </div>
            {globalTaskLauncherHotkeyMessage || globalTaskLauncherHotkeySaving ? (
              <p
                id="settings-global-task-launcher-hotkey-message"
                className={`settings-hint settings-shortcut-message${
                  globalTaskLauncherHotkeyMessage ? " is-error" : ""
                }`}
              >
                {globalTaskLauncherHotkeySaving
                  ? "Saving hotkey..."
                  : globalTaskLauncherHotkeyMessage}
              </p>
            ) : null}

            <div className="settings-row settings-shortcut-row">
              <label htmlFor="settings-show-hide-shortcut" className="settings-label">
                Show/hide app shortcut
              </label>
              <div className="settings-shortcut-control">
                <input
                  id="settings-show-hide-shortcut"
                  className="form-field settings-input settings-shortcut-input"
                  data-shortcut-capture="show-hide"
                  value={showHideShortcutValue}
                  placeholder="e.g. Option+Space"
                  readOnly
                  aria-invalid={showHideShortcutMessage ? true : undefined}
                  aria-describedby={
                    showHideShortcutMessage ? "settings-show-hide-shortcut-message" : undefined
                  }
                  onPointerDown={() => setShowHideShortcutCapturing(true)}
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
            {showHideShortcutConflictLabel ? (
              <p className="settings-hint settings-shortcut-message">
                {`qmux also uses this shortcut to ${showHideShortcutConflictLabel}; while registered system-wide, it will show/hide the app instead.`}
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
                      className="form-field settings-input"
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
                      className="control-button settings-secret-toggle"
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
                    className="form-field settings-input"
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
                    className="control-button settings-test-button"
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
                  <span className="settings-label">Use login shell</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.useLoginShell}
                    onChange={(event) => {
                      const useLoginShell = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, useLoginShell }));
                    }}
                  />
                </label>

                <div className="settings-divider" role="separator" />

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
                  <label htmlFor="settings-scrollback-rows" className="settings-label">
                    Scrollback rows (new tabs)
                  </label>
                  <input
                    id="settings-scrollback-rows"
                    className="form-field settings-input settings-number-input"
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
                  <span className="settings-label">Line height</span>
                  <div className="settings-stepper" role="group" aria-label="Line height">
                    <button className="control-button"
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
                    <button className="control-button"
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
                    className="form-field settings-input settings-number-input"
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
              {closeDialog.kind === "researchFolderRemove"
                ? `Remove ${displayGroupName(closeDialog.workspace)}?`
                : closeDialog.groupClose
                ? `Close ${closeDialog.groupClose.groupName}?`
                : `Close "${closeDialog.pane.title}?"`}
            </h2>
            {closeDialog.kind !== "researchFolderRemove" && closeDialog.groupClose ? (
              <p>
                Closing tab{" "}
                {closeDialog.groupClose.totalCount - closeDialog.groupClose.remainingPaneIds.length}{" "}
                of {closeDialog.groupClose.totalCount}: {closeDialog.pane.title}
              </p>
            ) : null}
            {closeDialog.kind === "researchFolderRemove" ? (
              <>
                <p>Remove this folder from qmux?</p>
                <p>The folder and its files will remain on disk, with history in the .qmux directory.</p>
                {researchFolderRemovalError ? (
                  <p className="confirm-dialog-error" role="alert">
                    {researchFolderRemovalError}
                  </p>
                ) : null}
                <div className="confirm-dialog-actions">
                  <button className="control-button"
                    type="button"
                    disabled={resolvingClose !== null}
                    onClick={() => setCloseDialog(null)}
                  >
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    disabled={resolvingClose !== null}
                    onClick={() => void confirmResearchFolderRemoval()}
                  >
                    {resolvingClose === "removeResearchFolder" ? "Removing…" : "Remove folder"}
                  </button>
                </div>
              </>
            ) : closeDialog.kind === "worktree" ? (
              <>
                <p>
                  {closeDialog.busy
                    ? "The agent is still working — closing this tab will stop it."
                    : "Closing this tab will stop the agent."}
                </p>
                <p>
                  {closeDialog.checkingChanges ? (
                    <>
                      Checking the worktree {formatPaneDir(closeDialog.worktreeDir)} for
                      uncommitted changes…
                    </>
                  ) : closeDialog.hasChanges === true ? (
                    <span className="confirm-dialog-changes">
                      The worktree {formatPaneDir(closeDialog.worktreeDir)} has uncommitted changes
                      that will be lost if deleted.
                    </span>
                  ) : closeDialog.hasChanges === false ? (
                    <>
                      The worktree {formatPaneDir(closeDialog.worktreeDir)} has no uncommitted
                      changes.
                    </>
                  ) : (
                    <span className="confirm-dialog-changes">
                      Qmux could not check the worktree {formatPaneDir(closeDialog.worktreeDir)} for
                      uncommitted changes. Deleting it may discard work.
                    </span>
                  )}{" "}
                  Delete the worktree?
                </p>
                <div className="confirm-dialog-actions">
                  <button className="control-button"
                    type="button"
                    disabled={resolvingClose !== null}
                    onClick={() => setCloseDialog(null)}
                  >
                    Cancel
                  </button>
                  <ConfirmDialogActionButton
                    type="button"
                    className="danger"
                    // Deleting stays gated on the status verdict: before the
                    // dialog opened eagerly the user could never delete ahead
                    // of the probe, so keep that ordering.
                    disabled={resolvingClose !== null || closeDialog.checkingChanges}
                    pending={resolvingClose === "delete"}
                    pendingLabel="Deleting…"
                    onClick={() => void resolveCloseDialog("delete")}
                  >
                    Delete worktree
                  </ConfirmDialogActionButton>
                  <ConfirmDialogActionButton
                    ref={closeConfirmButtonRef}
                    type="button"
                    autoFocus
                    disabled={resolvingClose !== null}
                    pending={resolvingClose === "keep"}
                    pendingLabel="Closing…"
                    onClick={() => void resolveCloseDialog("keep")}
                  >
                    Keep worktree
                  </ConfirmDialogActionButton>
                </div>
              </>
            ) : closeDialog.kind === "researchCancel" ? (
              <>
                <p>Closing cancels this research run. Its completed work and follow-up history remain available.</p>
                <div className="confirm-dialog-actions">
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Keep running
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    onClick={() => void confirmStopAndClose()}
                  >
                    Cancel research
                  </button>
                </div>
              </>
            ) : closeDialog.kind === "stop" ? (
              <>
                <p>This agent {closeDialog.reason}. Close the tab and stop it?</p>
                <div className="confirm-dialog-actions">
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    onClick={() => void confirmStopAndClose()}
                  >
                    Close tab
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
                    : `This tab has ${closeDialog.processCount} running processes.`}
                </p>
                <p>Closing this tab will terminate running processes in it.</p>
                <div className="confirm-dialog-actions">
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
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
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
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
            if (event.target === event.currentTarget && !quitting) {
              setExitDialog(null);
            }
          }}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exit-dialog-title"
            aria-busy={quitting}
          >
            <h2 id="exit-dialog-title">Quit qmux?</h2>
            <p>
              Quitting will close{" "}
              {exitDialog.paneCount === 1 ? "the open tab" : `all ${exitDialog.paneCount} tabs`}{" "}
              and stop any running agents or processes.
            </p>
            {runningResearchCount > 0 ? (
              <p>
                {runningResearchCount} active research run
                {runningResearchCount === 1 ? "" : "s"} will be cancelled and kept in Research
                history.
              </p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button className="control-button" type="button" disabled={quitting} onClick={() => setExitDialog(null)}>
                Cancel
              </button>
              <ConfirmDialogActionButton
                ref={exitConfirmButtonRef}
                type="button"
                className="danger"
                autoFocus
                pending={quitting}
                pendingLabel="Closing terminals..."
                onClick={() => void confirmExit()}
              >
                Quit qmux
              </ConfirmDialogActionButton>
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
            <h2 id="rename-dialog-title">
              {renamingResearchFolder
                ? "Rename folder"
                : renameGroupId
                  ? "Rename group"
                  : "Rename tab"}
            </h2>
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
              aria-describedby={renamingResearchFolder ? "rename-folder-hint" : undefined}
            />
            {renamingResearchFolder ? (
              <p id="rename-folder-hint" className="rename-dialog-hint">
                Contents will remain in {renamingResearchFolder.dir}
              </p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button className="control-button" type="button" onClick={closeRenameDialog}>
                Cancel
              </button>
              <button className="control-button" type="submit">Rename</button>
            </div>
          </form>
        </div>
      ) : null}

      <section className="workspace">
        {error ? (
          <div
            ref={errorBannerRegionRef}
            className="error-banner"
            role="alert"
            aria-live="assertive"
          >
            <span className="error-banner-message">{error}</span>
            <button
              type="button"
              className="control-button error-banner-dismiss"
              title="Dismiss (Esc)"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div
          ref={terminalStageRef}
          className={`terminal-stage${IS_MAC ? " is-native" : ""}${homeActive ? " is-home" : ""}${researchSurfaceActive ? " is-research" : ""}`}
        >
          {researchSurfaceActive && activeResearchTreeId ? (
            // Keyed by tree: the document's per-tree state (selection, fetched
            // content, follow-up draft) must not survive a tree switch. Without
            // the remount, the new tree's detail landing paints one frame of the
            // previous tree's node (selection/content only reset in effects,
            // after paint) and the content loader refetches the departed node.
            <ResearchDocument
              key={activeResearchTreeId}
              detail={activeResearchDetail}
              treeTitle={
                activeResearchDetail?.tree.title ??
                researchTrees.find((tree) => tree.id === activeResearchTreeId)?.title ??
                archivedResearchTrees.find((tree) => tree.id === activeResearchTreeId)?.title
              }
              archived={Boolean(activeResearchDetail?.tree.archivedAt)}
              detailError={activeResearchDetailError}
              onRetryDetail={retryActiveResearchDetail}
              onFork={createResearchFollowup}
              onRemoveBranch={removeResearchBranchFromDocument}
              onRemoveTree={removeResearchTreeAndSelectFallback}
              onUpdateDocument={editResearchDocument}
              onCancel={cancelResearchRun}
              onOpenPane={openResearchPaneTab}
              linkActions={linkActionsForPane(researchBrowserOwnerId(activeResearchTreeId))}
              defaultForkAdapterId={defaultForkAdapterId}
              onError={setError}
              onToast={showAppToast}
              onPublish={setPublicationTarget}
              publicationBinding={
                publicationBindings.find(
                  (binding) =>
                    binding.source.kind === "researchTree" &&
                    binding.source.treeId === activeResearchTreeId,
                ) ?? null
              }
              onPublicationBindingChange={(binding) => {
                setPublicationBindings((current) => [
                  binding,
                  ...current.filter(
                    (candidate) =>
                      candidate.publicationId !== binding.publicationId,
                  ),
                ]);
              }}
            />
          ) : null}
          {researchSurfaceActive && !activeResearchTreeId ? (
            <div className="research-empty-state">
              <NewResearchDialog
                open
                inline
                adapters={config?.adapters ?? []}
                requireCmdEnterToSend={settings.requireCmdEnterToSend}
                workspaceId={researchScope}
                onClose={() => undefined}
                onCreate={submitNewResearch}
              />
            </div>
          ) : null}
          {homeActive ? (
            <div
              className={`terminal-empty-state${
                homeCascadeWorkstreams.length === 0 ? " is-launcher-only" : ""
              }`}
            >
              <div className="home-launcher">{renderLauncher()}</div>
              {homeCascadeWorkstreams.length > 0 ? (
                <HomeCascades
                  workstreams={homeCascadeWorkstreams}
                  onActivatePane={focusPaneTab}
                />
              ) : null}
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
              fontFamily={terminalNativeFontFamily}
              letterSpacing={terminalLetterSpacing}
              cursorBlink={settings.cursorBlink}
              cursorStyle={settings.cursorStyle}
              scrollbackRows={settings.scrollbackRows}
              scrollOnUserInput={settings.scrollOnUserInput}
              scrollSensitivity={terminalScrollSensitivity}
              lineHeight={settings.lineHeight}
              copyOnSelect={settings.copyOnSelect}
              selectionClearOnCopy={settings.selectionClearOnCopy}
              themeName={terminalThemeName}
              pasteProtection={pasteProtection}
              deferGeometryUpdates={terminalGeometryResizing}
              // The expanded transcript is an opaque overlay covering the whole
              // stage; a visible pane under it must hold its native reveal one
              // frame on switch so the overlay paints before the surface appears.
              coveredByOverlay={
                activeTranscriptVisibleExpanded && visibleTerminalPaneIdSet.has(pane.id)
              }
              readOnly={terminalPaneIsReadOnly(pane)}
              // Only visible panes take the blocking signal: a hidden pane's
              // surface neither owns the keyboard nor receives pointer events,
              // and keeping its prop pinned false means opening a dialog/menu
              // re-renders (and re-issues layout FFI for) only the panes on
              // screen instead of every mounted tab.
              inputBlocked={
                visibleTerminalPaneIdSet.has(pane.id) &&
                nativeTerminalInputBlocked
              }
              // A live web selection cedes the keyboard to WebKit just like a
              // focused editable: the pane releases ownership, first responder
              // hands to the webview, and Cmd+C copies the selected web text.
              // Pinned false for hidden panes (like inputBlocked above): their
              // surface can't own the keyboard regardless, so a composer focus
              // or selection flip re-renders — and re-issues layout FFI for —
              // only the panes on screen instead of every mounted tab.
              webEditableFocused={
                visibleTerminalPaneIdSet.has(pane.id) &&
                (webEditableFocused || webSelectionActive)
              }
              requestAttach={requestPaneAttach}
              onUserInput={stableNoteUserInput}
              onActivate={activateTerminalPane}
              onOverlayStateChange={updateTerminalOverlayState}
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
                  style={terminalSplitDividerStyle(offset, index)}
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
                  }${
                    surface.agent && surface.agent.id === queueDropTargetAgentId
                      ? " is-queue-drop-target"
                      : ""
                  }`}
                  data-queue-drop-agent-id={surface.agent?.id}
                  style={turnPaneSplitCellStyle(surface)}
                  onPointerDownCapture={() => activateTerminalPane(surface.pane.id)}
                  onFocusCapture={() => {
                    // WebKit re-emits focus on its remembered element whenever
                    // the webview regains first responder — which every
                    // right-pane unmount/layout transition does. Only focus
                    // the user caused (a click or key since the page became
                    // focused) may switch the active pane, or quitting an
                    // agent / starting a terminal would yank activation to
                    // whichever sibling last held a composer or resizer.
                    if (userInputSinceWindowFocus()) {
                      activateTerminalPane(surface.pane.id);
                    }
                  }}
                >
                  {renderTurnPaneResizer()}
                  {renderTurnPaneSurface(surface, false)}
                  {renderFloatingTurnPaneControls(surface)}
                </section>
              ))
            : null}
          {!activeTranscriptVisibleExpanded && splitRightPaneMode && hasVisibleRightBar
            ? terminalSplitDividerOffsets.map((offset, index) => {
                // The right-pane-colored gutter cover only reads correctly
                // between two right panes. Against a full-width terminal it
                // would float a right-pane patch over that terminal's resize
                // handle instead.
                const abovePaneId = activePaneSplit?.paneIds[index];
                const belowPaneId = activePaneSplit?.paneIds[index + 1];
                if (
                  !abovePaneId ||
                  !belowPaneId ||
                  !splitTurnPaneSurfaceByPaneId.has(abovePaneId) ||
                  !splitTurnPaneSurfaceByPaneId.has(belowPaneId)
                ) {
                  return null;
                }
                return (
                  <div
                    key={`turn-${activePaneSplit?.id ?? "split"}-${index}`}
                    className="turn-pane-split-divider turn-pane-inline-split-divider"
                    style={terminalSplitDividerStyle(offset, index)}
                    aria-hidden="true"
                  />
                );
              })
            : null}
        </div>
      </section>

      {/* One aside serves both the expanded overlay and the docked right pane,
          with stable child positions, so toggling Expand transcript restyles
          the same TurnOverlay instance instead of remounting it — a remount
          reset the scroll position to the bottom and dropped the find bar and
          every open tool/thinking disclosure. (In split mode the docked
          transcripts live in the split cells above, so entering/leaving the
          expanded overlay still remounts there.) showHeader is
          !splitRightPaneMode for both variants: the docked pane only renders
          in single-pane mode, where that is always true. */}
      {activeTurnPaneSurface &&
      hasVisibleRightBar &&
      (activeTranscriptVisibleExpanded || !splitRightPaneMode) ? (
        <aside
          className={
            activeTranscriptVisibleExpanded
              ? `turn-pane is-expanded${splitRightPaneMode ? " is-headerless-expanded" : ""}`
              : "turn-pane"
          }
        >
          {activeTranscriptVisibleExpanded ? null : renderTurnPaneResizer()}
          {renderTurnPaneSurface(activeTurnPaneSurface, !splitRightPaneMode)}
          {activeTranscriptVisibleExpanded && splitRightPaneMode
            ? renderFloatingTurnPaneControls(activeTurnPaneSurface)
            : null}
        </aside>
      ) : null}
      {renderFloatingRightBarRestoreButton()}

      {activeBrowserOwnerId && activeBrowserOverlay?.open ? (
        <BrowserOverlay
          url={activeBrowserOverlay.url}
          reloadNonce={activeBrowserOverlay.reloadNonce}
          sandbox={activeBrowserOverlay.sandbox}
          bodyFontId={settings.bodyFontId}
          size={activeBrowserOverlay.size}
          toggleShortcutLabel={activePaneHasTurnPaneHeader ? null : EXPAND_TOGGLE_SHORTCUT_LABEL}
          onNavigate={navigateActiveBrowserOverlay}
          onRefresh={refreshActiveBrowserOverlay}
          onOpenExternal={() => {
            // Never leak a token-bearing file-server URL to the OS browser (the button is
            // also disabled for these, and the backend refuses them as the real boundary).
            if (
              activeBrowserOverlay.url &&
              !isFileServerUrl(activeBrowserOverlay.url, configRef.current?.fileServerPort ?? null)
            ) {
              void openExternalUrl(activeBrowserOverlay.url);
            }
          }}
          onClose={toggleActiveBrowserOverlay}
          onResize={(size) => setBrowserOverlaySize(activeBrowserOwnerId, size)}
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

      <NewResearchDialog
        open={newResearchOpen}
        adapters={config?.adapters ?? []}
        requireCmdEnterToSend={settings.requireCmdEnterToSend}
        workspaceId={researchScope}
        onClose={() => setNewResearchOpen(false)}
        onCreate={submitNewResearch}
      />

      <NewDocumentDialog
        open={newDocumentOpen}
        initialMarkdown={newDocumentInitialMarkdown}
        workspaceId={researchScope}
        onClose={() => {
          setNewDocumentOpen(false);
          setNewDocumentInitialMarkdown("");
        }}
        onCreate={submitNewDocument}
      />

      <PublishDialog
        target={publicationTarget}
        onClose={() => setPublicationTarget(null)}
        onPublished={(binding) => {
          setPublicationBindings((current) => [
            binding,
            ...current.filter(
              (candidate) => candidate.publicationId !== binding.publicationId,
            ),
          ]);
          if (binding.warning) {
            showAppToast(binding.warning, "warning");
          } else {
            showAppToast(
              publicationTarget?.binding
                ? `Updated ${binding.shareUrl}`
                : `Published to ${binding.shareUrl}`,
            );
          }
        }}
      />

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

export default function App() {
  if (new URLSearchParams(window.location.search).has("global-task-launcher")) {
    return <GlobalTaskLauncher />;
  }
  return <MainApp />;
}
