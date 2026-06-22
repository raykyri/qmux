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
  GitBranch,
  House,
  MessageSquareText,
  Minus,
  Plus,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import { agentUiAdapters, findAgentUiAdapter, getAgentUiAdapter } from "./adapters";
import { CLAUDE_ADAPTER_ID } from "./adapters/claude";
import NativeInput from "./components/NativeInput";
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
  CloseDialogState,
  ExitDialogState,
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
  moveToGap,
  nestUnder,
  outdentAt,
  type PaneLayoutItem,
  subtreeEnd,
  toLayout,
} from "./lib/paneTree";
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "./lib/terminalFont";
import {
  clampFontSize,
  FONT_OPTIONS,
  fontStackFor,
  letterSpacingFor,
  loadSettings,
  saveSettings,
  type AppSettings,
} from "./lib/settings";
import {
  acknowledgeAgent,
  attachPane,
  confirmAppExit,
  forkAgent,
  getLauncherAdapterPreference,
  getAgentDraft,
  getRuntimeConfig,
  killPane,
  listAgents,
  listClaudeSkills,
  listAgentTranscripts,
  listAgentTurnQueue,
  listTurns,
  listPanes,
  moveQueuedAgentTurn,
  openExternalUrl,
  removeQueuedAgentTurn,
  removeWorktree,
  renamePane,
  setLauncherAdapterPreference,
  setPaneLayout,
  setAgentDraft as persistAgentDraft,
  setAgentTranscript,
  setAgentTyping,
  setPreventSleep,
  spawnAgent,
  spawnShell,
  submitAgentTurn,
  worktreeStatus,
} from "./lib/api";
import type {
  AgentInfo,
  ClaudeSkill,
  InitialPaneSize,
  PaneInfo,
  QueuedTurn,
  RuntimeConfig,
  TranscriptHookEvent,
  TranscriptOption,
  Turn,
  WorktreeStatus,
} from "./types";

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
// Left strip of the sidebar the browser overlay leaves uncovered, so the first few
// chars of each tab stay visible and clickable for switching tabs.
const BROWSER_OVERLAY_LEFT_MARGIN = 64;
const TERMINAL_MIN_WIDTH = 380;
const TURN_PANE_MIN_WIDTH = 300;
const TURN_PANE_DEFAULT_WIDTH = 420;
const TURN_PANE_MAX_WIDTH = 720;
const TERMINAL_HORIZONTAL_PADDING = 10;
const TERMINAL_VERTICAL_PADDING = 20;
const DEFAULT_INITIAL_COLS = 100;
const DEFAULT_INITIAL_ROWS = 24;
const MIN_INITIAL_COLS = 20;
const MIN_INITIAL_ROWS = 5;
const MAX_INITIAL_COLS = 500;
const MAX_INITIAL_ROWS = 200;
const PANE_CONTEXT_MENU_WIDTH = 320;
const PANE_CONTEXT_MENU_ESTIMATED_HEIGHT = 250;
const DEFAULT_SHELL_TITLE = "Shell";
const MAX_TERMINAL_TITLE_CHARS = 160;
// How long the composer can sit idle before its draft is flushed to disk. The
// in-memory copy updates on every keystroke (so tab switches never lose it); the
// disk write is debounced so a paused composer — and a restart — can recover it.
const DRAFT_FLUSH_DEBOUNCE_MS = 1000;

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

// The internal browser overlay can only load what the webview CSP's frame-src allows:
// http over loopback (127.0.0.1 / localhost), which covers file-server URLs and local
// dev servers. Anything else — external hosts, https, mailto, custom schemes — would be
// blocked by CSP and render as a blank iframe, so it must hand off to the OS browser.
// Keep this in lockstep with `frame-src` in tauri.conf.json.
function canRenderInInternalBrowser(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
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
  // Keep the latest active pane / close handler reachable from the global keydown
  // listener without re-registering it on every state change.
  const activePaneRef = useRef<PaneInfo | undefined>(undefined);
  const requestClosePaneRef = useRef<(pane: PaneInfo) => void>(() => {});
  const paneTabPointerDragRef = useRef<PaneTabPointerDrag | null>(null);
  // Debounced "user is typing" hold per agent: while active the backend won't
  // auto-drain that agent's queue. Holds the agent id + the pending release timer.
  const agentTypingRef = useRef<{ agentId: string; timer: number } | null>(null);
  const paneDropTargetRef = useRef<PaneDropTarget | null>(null);
  const paneReorderPersistChainRef = useRef<Promise<void>>(Promise.resolve());
  const paneReorderRequestSeqRef = useRef(0);
  const suppressPaneTabClickRef = useRef(false);
  const dismissedRecoveredPaneIdsRef = useRef<Set<string>>(new Set());
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
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
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [queuedTurnsByAgent, setQueuedTurnsByAgentState] = useState<Record<string, QueuedTurn[]>>({});
  const [worktreeStatusByAgent, setWorktreeStatusByAgent] = useState<
    Record<string, WorktreeStatus>
  >({});
  const [hookEventsByAgent, setHookEventsByAgent] = useState<
    Record<string, TranscriptHookEvent[]>
  >({});
  // Latest unexpected-state message per agent (stalled/unreadable transcript,
  // adapter failure). Shown under the right pane's "No turns yet" placeholder;
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
  const [draftsByAgent, setDraftsByAgentState] = useState<Record<string, string>>({});
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [turnPaneWidth, setTurnPaneWidth] = useState(TURN_PANE_DEFAULT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  // Application-level UI settings (terminal font + size), loaded from localStorage
  // once on mount and persisted on every change. Shared by every pane. Font size
  // is also adjustable in-session with Cmd-=/Cmd--.
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const terminalFontSize = settings.fontSize;
  const terminalFontFamily = fontStackFor(settings.fontId);
  const terminalLetterSpacing = letterSpacingFor(settings.fontId);
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
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  // Which worktree-dialog action is mid-flight, so the dialog stays open (and its
  // buttons disabled) until the close/delete actually finishes.
  const [resolvingClose, setResolvingClose] = useState<"keep" | "delete" | null>(null);
  const [exitDialog, setExitDialog] = useState<ExitDialogState | null>(null);
  const [renamePaneId, setRenamePaneId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<PaneContextMenuState | null>(null);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [paneDropTarget, setPaneDropTarget] = useState<PaneDropTarget | null>(null);
  // Per-pane browser overlay state, so each tab keeps its own page and open/closed.
  const [browserOverlayByPane, setBrowserOverlayByPane] = useState<
    Record<string, BrowserOverlayState>
  >({});
  const [queueSplitByAgent, setQueueSplitByAgent] = useState<Record<string, boolean>>({});
  const [queueSplitHeightByAgent, setQueueSplitHeightByAgent] = useState<Record<string, number>>(
    {},
  );
  // Right-click chooser for a link (transcript or terminal): internal vs external.
  const [linkMenu, setLinkMenu] = useState<{ url: string; x: number; y: number } | null>(null);
  // The Home tab is selected explicitly, or implicitly whenever there are no real
  // panes to fall back to. While Home is active there is no active terminal pane.
  const homeActive = activePaneId === HOME_TAB_ID || panes.length === 0;
  const activePane = useMemo(
    () => (homeActive ? undefined : (panes.find((pane) => pane.id === activePaneId) ?? panes[0])),
    [homeActive, activePaneId, panes],
  );
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.paneId === activePane?.id),
    [activePane?.id, agents],
  );
  const activeBrowserOverlay = activePane ? browserOverlayByPane[activePane.id] : undefined;
  const activeQueueSplit = activeAgent ? (queueSplitByAgent[activeAgent.id] ?? false) : false;
  const activeQueueSplitHeight = activeAgent ? queueSplitHeightByAgent[activeAgent.id] : undefined;
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
    if (manuallyTitledPaneIds.has(pane.id)) {
      return false;
    }
    const defaultTitle = defaultPaneTitle(pane, agent, config);
    return defaultTitle !== null && pane.title === defaultTitle;
  }

  function paneHasUserSetTitle(pane: PaneInfo, agent: AgentInfo | undefined): boolean {
    if (manuallyTitledPaneIds.has(pane.id)) {
      return true;
    }
    const defaultTitle = defaultPaneTitle(pane, agent, config);
    return defaultTitle !== null && pane.title !== defaultTitle;
  }

  function displayPaneTitle(pane: PaneInfo, agent: AgentInfo | undefined): string {
    const terminalTitle = terminalTitleByPane[pane.id];
    return terminalTitle && paneUsesDefaultTitle(pane, agent) ? terminalTitle : pane.title;
  }

  // Drop per-pane UI state for panes that have closed so it can't leak or resurface.
  useEffect(() => {
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
    setBrowserOverlayByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [panes]);

  // Drop per-agent UI state for agents that no longer exist, so these maps and refs
  // don't grow unbounded across a long session of spawning and closing agents.
  useEffect(() => {
    const ids = new Set(agents.map((agent) => agent.id));
    const pruneRecord = <T,>(current: Record<string, T>): Record<string, T> => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    };
    setWorktreeStatusByAgent(pruneRecord);
    setHookEventsByAgent(pruneRecord);
    setTranscriptNoticeByAgent(pruneRecord);
    setTranscriptOptionsByAgent(pruneRecord);
    setCollapsedQueuedTurnsByAgent(pruneRecord);
    for (const id of Object.keys(queuedTurnsByAgentRef.current)) {
      if (!ids.has(id)) delete queuedTurnsByAgentRef.current[id];
    }
    for (const id of Object.keys(draftsByAgentRef.current)) {
      if (!ids.has(id)) delete draftsByAgentRef.current[id];
    }
    for (const id of Object.keys(queueScrollByAgentRef.current)) {
      if (!ids.has(id)) delete queueScrollByAgentRef.current[id];
    }
  }, [agents]);
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
    () => launcherAdapters.map((adapter) => ({ value: adapter.id, label: adapter.label })),
    [launcherAdapters],
  );
  function rememberLauncherAdapter(adapterId: string) {
    setLauncherAdapterId(adapterId);
    void setLauncherAdapterPreference(adapterId).catch(() => undefined);
  }
  function focusLauncherInput() {
    requestAnimationFrame(() => launcherInputRef.current?.focus());
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
  function openBrowserOverlay(paneId: string, url: string, sandbox = false) {
    setBrowserOverlayByPane((current) => ({
      ...current,
      [paneId]: { url, open: true, reloadNonce: (current[paneId]?.reloadNonce ?? 0) + 1, sandbox },
    }));
  }

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
        },
      };
    });
  }

  function toggleActiveQueueSplit() {
    const agentId = activeAgent?.id;
    if (!agentId) {
      return;
    }
    setQueueSplitByAgent((current) => ({ ...current, [agentId]: !(current[agentId] ?? false) }));
  }

  function setActiveQueueSplitHeight(height: number) {
    const agentId = activeAgent?.id;
    if (!agentId) {
      return;
    }
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

  // Link actions shared by transcript markdown and the terminal. Left-click opens
  // http(s) in the internal overlay (bound to the active tab); anything the overlay
  // can't render (mailto, etc.) falls back to the OS browser. Right-click opens the
  // chooser. Memoized on the active pane so the markdown context value is stable.
  const linkActions = useMemo<LinkActions>(
    () => ({
      openLink: (url) => {
        const paneId = activePane?.id;
        if (paneId && canRenderInInternalBrowser(url)) {
          openBrowserOverlay(paneId, url);
        } else {
          void openExternalUrl(url);
        }
      },
      openLinkMenu: (url, x, y) => setLinkMenu({ url, x, y }),
    }),
    // openBrowserOverlay just wraps a stable state setter; only the active pane matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePane?.id],
  );

  const activeTurns = useMemo(
    () => {
      const agentTurns = turns.filter((turn) => turn.agentId === activeAgent?.id);
      if (!activeAgent) {
        return agentTurns;
      }
      const adapter = getAgentUiAdapter(activeAgent.adapter);
      return adapter.normalizeTurns?.(agentTurns) ?? agentTurns;
    },
    [activeAgent?.id, activeAgent?.adapter, turns],
  );
  const activeAssistantLabel = activeAgent ? getAgentUiAdapter(activeAgent.adapter).label : "Claude";
  const activeTranscript = useMemo(
    () => formatTurnsTranscript(activeTurns, activeAssistantLabel),
    [activeTurns, activeAssistantLabel],
  );
  const activeHookEvents = useMemo(
    () => (activeAgent ? hookEventsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, hookEventsByAgent],
  );
  const activeTranscriptNotice = useMemo(
    () => (activeAgent ? transcriptNoticeByAgent[activeAgent.id] ?? null : null),
    [activeAgent?.id, transcriptNoticeByAgent],
  );
  const activeTranscriptOptions = useMemo(
    () => (activeAgent ? transcriptOptionsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, transcriptOptionsByAgent],
  );
  // Load the session list when an agent's pane is opened so the picker is ready
  // without waiting for a recovery event.
  const activeAgentId = activeAgent?.id;
  useEffect(() => {
    if (activeAgentId) {
      void refreshTranscriptOptions(activeAgentId);
    }
    // refreshTranscriptOptions only touches stable setters/imports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);
  const activeQueuedTurns = useMemo(
    () => (activeAgent ? queuedTurnsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, queuedTurnsByAgent],
  );
  const activeCollapsedQueuedTurns = useMemo(
    () => (activeAgent ? collapsedQueuedTurnsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, collapsedQueuedTurnsByAgent],
  );
  const activeDraft = useMemo(
    () => (activeAgent ? draftsByAgent[activeAgent.id] ?? "" : ""),
    [activeAgent?.id, draftsByAgent],
  );
  const activeOrphanedQueues = useMemo<OrphanedQueueGroup[]>(
    () =>
      activePane
        ? agents
            .filter((agent) => agent.orphanedQueuePaneId === activePane.id)
            .map((agent) => ({
              agent,
              queuedTurns: queuedTurnsByAgent[agent.id] ?? [],
            }))
            .filter((queue) => queue.queuedTurns.length > 0)
        : [],
    [activePane?.id, agents, queuedTurnsByAgent],
  );
  const hasTurnSidebar = Boolean(activeAgent) || activeOrphanedQueues.length > 0;

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

  async function moveRecoveredQueuedTurn(agentId: string, index: number, turn: string) {
    const targetAgent = activeAgent;
    if (!targetAgent || targetAgent.id === agentId) {
      return;
    }

    setError(null);
    try {
      // One atomic backend call removes from the source and hands the turn to the
      // target (rolling back on failure), so the turn can't end up in both queues.
      const result = await moveQueuedAgentTurn(agentId, targetAgent.id, index, turn);
      setAgentQueuedTurns(agentId, result.sourceQueuedTurns);
      setAgentQueuedTurns(targetAgent.id, result.targetQueuedTurns);
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
    const reservedTurnPane = hasTurnSidebar ? turnPaneWidth : 0;
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

  // Grow the right pane's text by 0.5px for every 1px the terminal font is above
  // its base size, capped at +1.5px, so the transcript/composer track the terminal
  // zoom without overpowering it. No change at or below the base size.
  const turnFontDelta = Math.min(1.5, Math.max(0, (terminalFontSize - TERMINAL_FONT_SIZE) * 0.5));

  const appStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--browser-overlay-left": `${BROWSER_OVERLAY_LEFT_MARGIN}px`,
    "--turn-font-delta": `${turnFontDelta}px`,
    ...(hasTurnSidebar ? { "--turn-pane-width": `${turnPaneWidth}px` } : {}),
  } as CSSProperties;
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
  const draggingPaneIndex = draggingPaneId
    ? panes.findIndex((pane) => pane.id === draggingPaneId)
    : -1;
  // The dragged tab moves with its whole subtree, so dim that contiguous range.
  const draggingSubtreeEnd =
    draggingPaneIndex >= 0 ? subtreeEnd(panes, draggingPaneIndex) : -1;
  // Context-menu pane index, for enabling/disabling Indent/Outdent.
  const contextMenuPaneIndex = paneContextMenu
    ? panes.findIndex((pane) => pane.id === paneContextMenu.paneId)
    : -1;

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const [
          runtimeConfig,
          preferredLauncherAdapterId,
          existingPanes,
          existingAgents,
          existingTurns,
        ] = await Promise.all([
          getRuntimeConfig(),
          getLauncherAdapterPreference().catch(() => null),
          listPanes(),
          listAgents(),
          listTurns(),
        ]);
        if (cancelled) {
          return;
        }

        setConfig(runtimeConfig);
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
          setPanesPreservingRecoveredDismissals(existingPanes);
          setActivePaneId(existingPanes[0].id);
          return;
        }

        const pane = await spawnShell(estimateInitialPaneSize(false));
        if (!cancelled) {
          setPanesPreservingRecoveredDismissals([pane]);
          setActivePaneId(pane.id);
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

  useEffect(() => {
    const handleFocus = () => acknowledgePaneIfDone(activePaneId);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [activePaneId]);

  useEffect(() => {
    const doneWorktreeAgents = agents.filter((agent) => agent.status === "done");
    const doneWorktreeAgentIds = new Set(doneWorktreeAgents.map((agent) => agent.id));

    setWorktreeStatusByAgent((current) => {
      let changed = false;
      const next: Record<string, WorktreeStatus> = {};
      for (const [agentId, status] of Object.entries(current)) {
        if (doneWorktreeAgentIds.has(agentId)) {
          next[agentId] = status;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });

    let cancelled = false;
    for (const agent of doneWorktreeAgents) {
      if (worktreeStatusByAgent[agent.id]) {
        continue;
      }
      void worktreeStatus(agent.id)
        .then((status) => {
          if (cancelled) {
            return;
          }
          setWorktreeStatusByAgent((current) => ({ ...current, [agent.id]: status }));
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          setWorktreeStatusByAgent((current) => ({
            ...current,
            [agent.id]: { hasChanges: false, changedFiles: 0 },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [agents, worktreeStatusByAgent]);

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
    setExitDialog,
    setAgents,
    setTurns,
    setTranscriptNoticeByAgent,
    setAgentQueuedTurns,
    refreshAgentTurnQueue,
    refreshTranscriptOptions,
    dispatchPtyData,
    openBrowserOverlay,
    onEventsReady: handleEventsReady,
  });

  async function addShellPane() {
    setError(null);
    try {
      const pane = await spawnShell(estimateInitialPaneSize(false));
      setPanesPreservingRecoveredDismissals((current) => [...current, pane]);
      setActivePaneId(pane.id);
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

  function focusHomeTab() {
    setActivePaneId(HOME_TAB_ID);
    setLauncherOpen(false);
    focusLauncherInput();
  }

  function openAgentLauncher() {
    if (homeActive) {
      focusHomeTab();
      return;
    }
    setLauncherOpen(true);
  }

  function handlePaneTabPointerDown(event: ReactPointerEvent<HTMLDivElement>, paneId: string) {
    if (event.button !== 0) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".pane-tab-close, .pane-tab-status-clickable")
    ) {
      return;
    }
    paneTabPointerDragRef.current = {
      pointerId: event.pointerId,
      paneId,
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
      if (Math.abs(event.clientY - drag.startY) < PANE_TAB_DRAG_START_THRESHOLD) {
        return;
      }
      drag.active = true;
      setDraggingPaneId(drag.paneId);
      updatePaneDropTarget(null);
    }

    event.preventDefault();
    const list = paneListRef.current;
    if (!list) {
      return;
    }
    updatePaneDropTarget(computeDropTarget(list, event.clientY, drag.paneId));
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

    const list = paneListRef.current;
    const target =
      paneDropTargetRef.current ??
      (list ? computeDropTarget(list, event.clientY, drag.paneId) : null);
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

  function clearPaneTabDrag() {
    paneDropTargetRef.current = null;
    setDraggingPaneId(null);
    setPaneDropTarget(null);
  }

  // Classifies a pointer position during a drag into a drop target: the top/bottom
  // ~30% of a row is a reorder gap, the middle ~40% nests into that row. Rows inside
  // the dragged tab's own subtree are never targets (can't nest into self), and gaps
  // adjacent to that block are suppressed (would be a no-op move).
  function computeDropTarget(
    container: HTMLElement,
    clientY: number,
    dragId: string,
  ): PaneDropTarget | null {
    const rows = Array.from(container.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains("pane-tab-row") &&
        // The fixed Home row isn't a reorder/nest target and isn't in `panes`, so
        // excluding it keeps the row index aligned with the panes array below.
        !child.classList.contains("pane-home-row"),
    );
    if (rows.length === 0) {
      return null;
    }
    const dragIndex = panes.findIndex((pane) => pane.id === dragId);
    const dragEnd = dragIndex >= 0 ? subtreeEnd(panes, dragIndex) : -1;
    const inDraggedSubtree = (index: number) =>
      dragIndex >= 0 && index >= dragIndex && index < dragEnd;

    const gapTarget = (index: number): PaneDropTarget | null =>
      dragIndex >= 0 && index >= dragIndex && index <= dragEnd
        ? null // dropping into/adjacent to its own block is a no-op
        : { kind: "gap", index };

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
      const pane = panes[index];
      if (!pane || inDraggedSubtree(index)) {
        return null;
      }
      return { kind: "nest", paneId: pane.id };
    }
    return gapTarget(rows.length);
  }

  function applyDropTarget(dragId: string, target: PaneDropTarget) {
    const next =
      target.kind === "nest"
        ? nestUnder(panes, dragId, target.paneId)
        : moveToGap(panes, dragId, target.index);
    applyPaneLayout(next);
  }

  // Optimistically applies a new tab layout (order + depth) and persists it, with the
  // same request-sequence guard the old reorder used so stale responses never clobber
  // a newer local state.
  function applyPaneLayout(next: PaneInfo[]) {
    const nextLayout = toLayout(next);
    if (sameLayout(nextLayout, toLayout(panes))) {
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

  function sameLayout(a: PaneLayoutItem[], b: PaneLayoutItem[]) {
    return (
      a.length === b.length &&
      a.every(
        (item, index) => item.paneId === b[index].paneId && item.depth === b[index].depth,
      )
    );
  }

  function indentContextMenuPane() {
    if (contextMenuPaneIndex < 0) {
      return;
    }
    applyPaneLayout(indentAt(panes, contextMenuPaneIndex));
  }

  function outdentContextMenuPane() {
    if (contextMenuPaneIndex < 0) {
      return;
    }
    applyPaneLayout(outdentAt(panes, contextMenuPaneIndex));
  }

  function openPaneContextMenu(event: ReactMouseEvent, pane: PaneInfo) {
    event.preventDefault();
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
    setRenamePaneId(pane.id);
  }

  async function submitRename() {
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
    setRenamePaneId(null);
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

  async function closePane(paneToClose: PaneInfo) {
    setError(null);
    try {
      await killPane(paneToClose.id);
      setPanesPreservingRecoveredDismissals((current) => {
        const nextPanes = current.filter((pane) => pane.id !== paneToClose.id);
        setActivePaneId((currentActivePaneId) => {
          if (currentActivePaneId !== paneToClose.id) {
            return currentActivePaneId;
          }
          return selectPaneAfterClose(current, paneToClose.id);
        });
        return nextPanes;
      });
      setPaneContextMenu((current) => (current?.paneId === paneToClose.id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Closing a tab that owns a git worktree opens a dialog: check the worktree for
  // uncommitted changes first, then let the user delete or keep it (or cancel).
  // Other agent panes confirm only when a live agent would be interrupted; shell
  // panes and finished/failed agents close without a prompt.
  async function requestClosePane(paneToClose: PaneInfo, options?: { confirmAlways?: boolean }) {
    const agent = agents.find((candidate) => candidate.paneId === paneToClose.id);

    if (agent && agent.branch) {
      let hasChanges = false;
      try {
        hasChanges = (await worktreeStatus(agent.id)).hasChanges;
      } catch {
        // If the status check fails, still offer the choice rather than blocking
        // the close; treat the change state as unknown (assume none).
        hasChanges = false;
      }
      setCloseDialog({
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
      });
      return;
    }

    const liveReason =
      agent?.status === "awaitingPermission"
        ? "is waiting for you to approve a tool use"
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
      setCloseDialog({ kind: "stop", pane: paneToClose, reason });
      return;
    }
    if (options?.confirmAlways) {
      setCloseDialog({ kind: "pane", pane: paneToClose });
      return;
    }
    await closePane(paneToClose);
  }

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
    setError(null);
    setResolvingClose(choice);
    try {
      await closePane(dialog.pane);
      if (choice === "delete") {
        // Keep the dialog up until the worktree is actually gone, so it never
        // dismisses while the deletion is still running.
        await removeWorktree(dialog.agentId);
      }
      setCloseDialog(null);
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
    setCloseDialog(null);
    await closePane(dialog.pane);
  }

  async function confirmPaneClose() {
    const dialog = closeDialog;
    if (!dialog || dialog.kind !== "pane") {
      return;
    }
    setCloseDialog(null);
    await closePane(dialog.pane);
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
      const pane = await spawnAgent({
        adapterId: launchAdapter.id,
        prompt: finalPrompt,
        baseRepo: null,
        baseRef: "HEAD",
        initialSize: estimateInitialPaneSize(true),
        useWorktree: createInWorktree,
        options: launcherOptions,
      });
      setPanesPreservingRecoveredDismissals((current) => [...current, pane]);
      setActivePaneId(pane.id);
      if (pane.agentId) {
        setAgentQueuedTurns(pane.agentId, []);
      }
      setPrompt("");
      setSelectedSkillId(null);
      setLauncherOpen(false);
      setAgents(await listAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Forks the active Claude session into a new tab (resuming it) — as a sibling
  // right after the current tab, or nested under it when `nest` is set — and
  // focuses the fork. The backend also emits agent.forked, which refetches the
  // ordered pane list, so the optimistic append below is just to avoid a flicker.
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Show the floating Ask popup for a selection. Both surfaces (terminal and
  // transcript) route here; the selection is always within the active agent's pane,
  // and we require an active agent (shell panes have nothing to ask).
  function showSelectionAsk(quote: string, anchor: SelectionAnchor) {
    if (!activeAgent || !activePane) {
      return;
    }
    const trimmed = quote.trim();
    if (!trimmed) {
      return;
    }
    setSelectionAsk({
      quote: trimmed,
      anchor,
      sourceAgentId: activeAgent.id,
      sourcePaneId: activePane.id,
      // "Ask in new thread" forks, which only Claude (with a recorded session)
      // supports — gate the button so it's never a dead end.
      canFork: activeAgent.adapter === CLAUDE_ADAPTER_ID && Boolean(activeAgent.sessionId),
    });
  }
  function handleTerminalAskSelection(paneId: string, quote: string, anchor: SelectionAnchor) {
    // Ignore selections from a non-active pane (only the active terminal is
    // interactive, but guard regardless).
    if (activePane?.id !== paneId) {
      return;
    }
    showSelectionAsk(quote, anchor);
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
    setSelectionAsk(null);
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
    const skill =
      target.mode === "newThread" && askSelectedSkillId
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
        });
        setPanesPreservingRecoveredDismissals((current) =>
          current.some((existing) => existing.id === pane.id) ? current : [...current, pane],
        );
        setActivePaneId(pane.id);
        // Land focus on the fork we just switched to, not the source pane.
        focusPaneId = pane.id;
        if (pane.agentId) {
          const result = await submitAgentTurn(pane.agentId, message, "auto");
          setAgentQueuedTurns(pane.agentId, result.queuedTurns);
        } else {
          // A forkable Claude pane always comes back with an agent id; surface it
          // rather than silently dropping the question if that ever doesn't hold.
          // (Closing anyway avoids a retry re-forking; the new tab is already open
          // for the user to ask in directly.)
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

  // Mirror the latest active pane and close handler into refs so the always-on
  // keydown listener (registered once) never reads stale state.
  useEffect(() => {
    activePaneRef.current = activePane;
    requestClosePaneRef.current = requestClosePane;
  });

  useEffect(() => {
    if (!paneContextMenu) {
      return;
    }
    const handleDismiss = () => setPaneContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPaneContextMenu(null);
      }
    };
    window.addEventListener("mousedown", handleDismiss);
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handleDismiss);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [paneContextMenu]);

  useEffect(() => {
    if (paneContextMenu && !panes.some((pane) => pane.id === paneContextMenu.paneId)) {
      setPaneContextMenu(null);
    }
  }, [paneContextMenu, panes]);

  // Persist application settings (font + size) whenever they change, so the
  // choice survives a restart. Writing on the initial value is harmless.
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

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
    if (renamePaneId) {
      const input = renameInputRef.current;
      input?.focus();
      input?.select();
    }
  }, [renamePaneId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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

      const cycleTab = (direction: -1 | 1, includeHome: boolean) => {
        const tabIds = includeHome
          ? [HOME_TAB_ID, ...panes.map((pane) => pane.id)]
          : panes.map((pane) => pane.id);
        if (tabIds.length === 0) {
          return;
        }
        const listedIndex = tabIds.indexOf(activePaneId ?? "");
        let currentIndex: number;
        if (listedIndex !== -1) {
          currentIndex = listedIndex;
        } else if (includeHome) {
          // Active tab not in the list (e.g. null): default to the first real pane.
          currentIndex = panes.length > 0 ? 1 : 0;
        } else {
          // Skipping Home while Home is active: position so forward lands on the
          // first pane and backward on the last.
          currentIndex = direction === 1 ? -1 : 0;
        }
        focusTabById(tabIds[(currentIndex + direction + tabIds.length) % tabIds.length]);
      };

      // Cmd-1..9 / Ctrl-1..9 jump to real pane tabs in sidebar order. Claimed
      // before the editable-target bail so the app-level tab shortcuts keep
      // working from terminal and composer focus.
      if (/^[1-9]$/.test(key) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const pane = panes[Number(key) - 1];
        if (pane) {
          focusPaneTab(pane.id);
        }
        return;
      }

      // Cmd-N jumps to Home, replacing the old Cmd-0 Home shortcut.
      if (commandOnly && key === "n") {
        event.preventDefault();
        event.stopPropagation();
        focusHomeTab();
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

      // Ctrl-Tab / Ctrl-Shift-Tab cycle through the open tabs like a browser,
      // skipping Home. Claimed here in the capture phase (before the
      // terminal/editable bail) so it works regardless of focus; Tab with Ctrl is
      // never a text-editing key.
      if (key === "tab" && event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(event.shiftKey ? -1 : 1, false);
        return;
      }

      // Cmd-Shift-[ / Cmd-Shift-] cycle backward/forward through Home and the open
      // tabs (Home included). Claimed in the capture phase so it works regardless
      // of focus.
      if ((key === "[" || key === "]") && event.metaKey && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(key === "[" ? -1 : 1, true);
        return;
      }

      // Cmd-; / Ctrl-; opens qmux's agent picker, even from terminal focus.
      // Claimed in the capture phase so focus doesn't matter; ⌘K is left alone
      // for the terminal to handle (e.g. clear-screen).
      if (key === ";") {
        event.preventDefault();
        event.stopPropagation();
        setLauncherOpen(true);
        return;
      }

      // Cmd-, / Ctrl-, opens the settings panel from anywhere, including terminal
      // focus. Claimed in the capture phase so focus doesn't matter; Escape (handled
      // separately) closes it again.
      if (key === ",") {
        event.preventDefault();
        event.stopPropagation();
        setSettingsOpen(true);
        return;
      }

      if (key !== "t" && key !== "w") {
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

      // Cmd-T opens a new shell pane.
      if (!event.metaKey || event.ctrlKey) {
        return;
      }
      void addShellPane();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activePaneId, panes]);

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
  }, [launcherVisible]);

  // The ask launcher's "new thread" mode shows the same Claude skill toggles, but
  // opening it doesn't pass through the launcher-visible effect above — so load the
  // skills here too, otherwise the toggles are empty until the main launcher has
  // been opened once this session.
  useEffect(() => {
    if (askLauncher?.mode !== "newThread") {
      return;
    }
    void listClaudeSkills()
      .then(setAvailableSkills)
      .catch(() => setAvailableSkills([]));
  }, [askLauncher?.mode]);

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
    if (!hasTurnSidebar) {
      return;
    }

    const handleResize = () => {
      setTurnPaneWidth((current) => clampTurnPaneWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hasTurnSidebar]);

  // Keep the sidebar within bounds as the window resizes or the turn pane claims
  // space (deps refresh the clamp's view of available width).
  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hasTurnSidebar, turnPaneWidth]);

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
        if (event.metaKey && event.key === "Enter") {
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
        placeholder="What should we look at next?"
        style={selectedSkill ? { textIndent: `${skillPrefixWidth}px` } : undefined}
      />
      <DictationMicButton dictation={launcherDictation} className="command-launcher-mic" />
      <div className="command-launcher-overlay">
        <div className="command-launcher-overlay-group">
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
            <span aria-hidden="true">⌘<span className="enter-glyph">↵</span></span>
          </button>
        </div>
      </div>
    </form>
  );

  // The ask launcher: a launcher-style modal seeded with a quoted selection. In
  // "ask" mode only the question field, mic, and submit show; in "newThread" mode
  // (fork-then-send) the worktree checkbox and skill toggles are also shown. The
  // adapter select is intentionally omitted — a fork inherits the source's adapter.
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
        if (event.metaKey && event.key === "Enter" && !event.repeat) {
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
              {availableSkills.length > 0 ? (
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
            <span aria-hidden="true">
              ⌘<span className="enter-glyph">↵</span>
            </span>
          </button>
        </div>
      </div>
    </form>
  );

  return (
    <main
      ref={appRef}
      className={`app-shell ${hasTurnSidebar ? "has-turn-sidebar" : ""}`}
      style={appStyle}
    >
      <aside className={`sidebar${sidebarWidth < LEFT_SIDEBAR_COMPACT_WIDTH ? " is-narrow" : ""}`}>
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
          className={`pane-list${draggingPaneId ? " is-dragging" : ""}`}
          aria-label="Panes"
        >
          {/* Fixed Home tab: not a real pane, so it can't be closed, reordered, or
              nested. Selecting it shows the empty content placeholder (the launcher). */}
          <div
            className={`pane-tab-row pane-home-row${homeActive ? " is-selected" : ""}`}
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
              <House size={13} aria-hidden="true" />
              <span className="pane-tab-title">Home</span>
            </button>
          </div>
          {panes.map((pane, index) => {
            const paneAgent = agents.find((agent) => agent.paneId === pane.id);
            const paneDisplayTitle = displayPaneTitle(pane, paneAgent);
            const paneTitleIsUserSet = paneHasUserSetTitle(pane, paneAgent);
            const paneAgentWorktreeStatus = paneAgent
              ? worktreeStatusByAgent[paneAgent.id]
              : undefined;
            const paneAgentStatusTone = paneAgent ? agentStatusTone(paneAgent.status) : "idle";
            const paneQueueCount = paneAgent
              ? (queuedTurnsByAgent[paneAgent.id]?.length ?? 0)
              : 0;
            const rawStatus = paneAgent
              ? agentStatusLabel(paneAgent.status, paneAgentWorktreeStatus)
              : statusLabel(pane.status);
            // "Running" is the steady state for every pane, so it is just noise —
            // except while turns are queued to send once the agent finishes, in
            // which case surface the pending count in that otherwise-empty slot.
            const paneStatus =
              paneAgent?.status === "running" && paneQueueCount > 0
                ? `${paneQueueCount} queued`
                : rawStatus === "Running"
                  ? null
                  : rawStatus;
            // Agent panes live in a worktree; shells show the directory they
            // launched in (their spawn-time cwd).
            const paneDir = paneAgent?.worktreeDir ?? pane.cwd;
            // Git context shown under the path for worktree agents. The pane runs
            // in the worktree, so label it by the worktree's folder name rather
            // than repeating the full path; the tooltip carries the full dir.
            const paneBranch = paneAgent?.branch ?? null;
            const paneWorktreeName =
              paneBranch && paneAgent?.worktreeDir
                ? (paneAgent.worktreeDir.split("/").filter(Boolean).pop() ?? null)
                : null;
            const paneGitMeta = [paneBranch, paneWorktreeName].filter(Boolean).join(" · ");
            const paneGitMetaTitle = [paneBranch, paneBranch ? paneAgent?.worktreeDir : null]
              .filter(Boolean)
              .join(" · ");
            const dropGap = paneDropTarget?.kind === "gap" ? paneDropTarget.index : null;
            const isNestTarget =
              paneDropTarget?.kind === "nest" && paneDropTarget.paneId === pane.id;
            const isDraggingRow =
              draggingPaneIndex >= 0 &&
              index >= draggingPaneIndex &&
              index < draggingSubtreeEnd;
            const className = [
              "pane-tab-row",
              pane.id === activePane?.id ? "is-selected" : "",
              isDraggingRow ? "is-dragging" : "",
              dropGap === index ? "is-drop-before" : "",
              dropGap === panes.length && index === panes.length - 1 ? "is-drop-after" : "",
              isNestTarget ? "is-drop-nest" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={pane.id}
                className={className}
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
                    className={`pane-tab-dot status-${paneAgentStatusTone}`}
                    aria-hidden="true"
                  />
                  <span className="pane-tab-content">
                    <span
                      className={`pane-tab-title${paneTitleIsUserSet ? " is-user-set" : ""}`}
                    >
                      {paneDisplayTitle}
                    </span>
                    {paneDir ? (
                      <span className="pane-tab-path" title={paneDir}>
                        {formatPaneDir(paneDir)}
                      </span>
                    ) : null}
                    {paneGitMeta ? (
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
              </div>
            );
          })}
        </nav>

        <div className="sidebar-actions">
          <button type="button" onClick={addShellPane}>
            <SquareTerminal size={14} aria-hidden="true" />
            <span>New shell</span>
          </button>
          <button type="button" onClick={openAgentLauncher}>
            <MessageSquareText size={14} aria-hidden="true" />
            <span>New agent</span>
          </button>
          <button
            type="button"
            className="sidebar-settings-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={14} aria-hidden="true" />
          </button>
        </div>
      </aside>

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
                <dt>Agent status</dt>
                <dd>
                  {agentStatusLabel(
                    contextMenuAgent.status,
                    worktreeStatusByAgent[contextMenuAgent.id],
                  ) ?? "Idle"}
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
          <div className="pane-context-actions">
            <button
              type="button"
              disabled={!canOutdent(panes, contextMenuPaneIndex)}
              onClick={outdentContextMenuPane}
            >
              <ChevronLeft size={13} aria-hidden="true" />
              <span>Outdent</span>
            </button>
            <button
              type="button"
              disabled={!canIndent(panes, contextMenuPaneIndex)}
              onClick={indentContextMenuPane}
            >
              <ChevronRight size={13} aria-hidden="true" />
              <span>Indent</span>
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
            <h2 id="close-dialog-title">Close {closeDialog.pane.title}?</h2>
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
                    autoFocus
                    disabled={resolvingClose !== null}
                    onClick={() => void resolveCloseDialog("delete")}
                  >
                    {resolvingClose === "delete" ? "Deleting…" : "Delete worktree"}
                  </button>
                  <button
                    type="button"
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
                    type="button"
                    className="danger"
                    autoFocus
                    onClick={() => void confirmStopAndClose()}
                  >
                    Close pane
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
              {exitDialog.paneCount === 1
                ? "There is 1 open tab."
                : `There are ${exitDialog.paneCount} open tabs.`}{" "}
              Quitting will stop them.
            </p>
            <div className="confirm-dialog-actions">
              <button type="button" autoFocus onClick={() => setExitDialog(null)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => void confirmExit()}>
                Quit qmux
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renamePaneId ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setRenamePaneId(null);
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
            <h2 id="rename-dialog-title">Rename tab</h2>
            <input
              ref={renameInputRef}
              className="rename-dialog-input"
              value={renameValue}
              onChange={(event) => setRenameValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setRenamePaneId(null);
                }
              }}
              aria-label="Tab name"
            />
            <div className="confirm-dialog-actions">
              <button type="button" onClick={() => setRenamePaneId(null)}>
                Cancel
              </button>
              <button type="submit">Rename</button>
            </div>
          </form>
        </div>
      ) : null}

      <section className="workspace">
        {error ? <div className="error-banner">{error}</div> : null}

        <div ref={terminalStageRef} className="terminal-stage">
          {homeActive && !launcherOpen ? (
            <div className="terminal-empty-state">
              <div className="home-launcher">
                <h1 className="home-title">qmux</h1>
                {renderLauncher("inline")}
              </div>
            </div>
          ) : null}
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              ref={terminalPaneRefCallback(pane.id)}
              pane={pane}
              active={pane.id === activePane?.id}
              fontSize={terminalFontSize}
              fontFamily={terminalFontFamily}
              letterSpacing={terminalLetterSpacing}
              inputBlocked={settingsOpen}
              requestAttach={requestPaneAttach}
              onUserInput={noteUserInput}
              onOpenLink={linkActions.openLink}
              onLinkContextMenu={linkActions.openLinkMenu}
              onAskSelection={handleTerminalAskSelection}
              onTerminalTitleChange={handleTerminalTitleChange}
            />
          ))}
        </div>
      </section>

      {hasTurnSidebar ? (
        <aside className="turn-pane">
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
          <TurnOverlay
            turns={activeAgent ? activeTurns : []}
            agentId={activeAgent?.id ?? activePane?.id}
            assistantLabel={activeAssistantLabel}
            notice={activeAgent ? activeTranscriptNotice : null}
            transcriptOptions={activeAgent ? activeTranscriptOptions : []}
            transcriptPath={activeAgent?.transcriptPath ?? null}
            onSelectTranscript={
              activeAgent
                ? (path) => void handleSelectTranscript(activeAgent.id, path)
                : undefined
            }
            queueSplit={activeQueueSplit}
            queueSplitHeight={activeQueueSplitHeight}
            onQueueSplitHeightChange={setActiveQueueSplitHeight}
            linkActions={linkActions}
            onAskSelection={showSelectionAsk}
            header={
              <TurnPaneHeader
                sessionId={activeAgent?.sessionId ?? null}
                canFork={Boolean(
                  activePane && activeAgent?.adapter === "claude" && activeAgent?.sessionId,
                )}
                onFork={(options) => void forkActivePane(options)}
                showQueueSplit={Boolean(activeAgent)}
                queueSplit={activeQueueSplit}
                onToggleQueueSplit={toggleActiveQueueSplit}
                browserOpen={activeBrowserOverlay?.open ?? false}
                onToggleBrowser={toggleActiveBrowserOverlay}
              />
            }
            input={
              <div className="turn-pane-input-stack">
                {activeOrphanedQueues.length > 0 ? (
                  <RecoveredQueuePanel
                    queues={activeOrphanedQueues}
                    hasTargetAgent={Boolean(activeAgent)}
                    agentLabel={launchAdapter.label}
                    onMoveTurn={(agentId, index, turn) =>
                      void moveRecoveredQueuedTurn(agentId, index, turn)
                    }
                    onDiscardTurn={(agentId, index, turn) =>
                      void discardRecoveredQueuedTurn(agentId, index, turn)
                    }
                  />
                ) : null}
                {activeAgent && activePane ? (
                  <NativeInput
                    pane={activePane}
                    agent={activeAgent}
                    draft={activeDraft}
                    queuedTurns={activeQueuedTurns}
                    collapsedQueuedTurns={activeCollapsedQueuedTurns}
                    queueSplit={activeQueueSplit}
                    transcriptText={activeTranscript}
                    transcriptCopyText={() =>
                      formatTranscriptCopyJson({
                        agent: activeAgent,
                        pane: activePane,
                        transcriptText: activeTranscript,
                        turns: activeTurns,
                        hooks: activeHookEvents,
                      })
                    }
                    composerPolicy={getAgentUiAdapter(activeAgent.adapter).composerPolicy(
                      activeAgent,
                    )}
                    transcriptOptions={activeTranscriptOptions}
                    onSelectTranscript={(path) =>
                      void handleSelectTranscript(activeAgent.id, path)
                    }
                    onQueueChange={setAgentQueuedTurns}
                    onDraftChange={setAgentDraft}
                    onQueuedTurnCollapseToggle={toggleQueuedTurnCollapsed}
                    onUserInput={noteUserInput}
                    getQueueScroll={getQueueScroll}
                    saveQueueScroll={saveQueueScroll}
                    onError={setError}
                  />
                ) : null}
              </div>
            }
          />
        </aside>
      ) : null}

      {activePane && activeBrowserOverlay?.open ? (
        <BrowserOverlay
          url={activeBrowserOverlay.url}
          reloadNonce={activeBrowserOverlay.reloadNonce}
          sandbox={activeBrowserOverlay.sandbox}
          onNavigate={navigateActiveBrowserOverlay}
          onRefresh={refreshActiveBrowserOverlay}
          onClose={toggleActiveBrowserOverlay}
        />
      ) : null}
      {/* The floating toggle sits over the terminal only when the right pane is
          closed; otherwise the toggle lives in the right pane's top bar. */}
      {activePane && !activeBrowserOverlay?.open && !hasTurnSidebar ? (
        <BrowserOverlayControls
          open={false}
          onToggle={toggleActiveBrowserOverlay}
          onRefresh={refreshActiveBrowserOverlay}
        />
      ) : null}

      {linkMenu ? (
        <LinkContextMenu
          x={linkMenu.x}
          y={linkMenu.y}
          canOpenInternal={canRenderInInternalBrowser(linkMenu.url)}
          onOpenInternal={() => {
            linkActions.openLink(linkMenu.url);
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
          showNewThread={selectionAsk.canFork}
          onAsk={() => openAskLauncher("ask")}
          onAskNewThread={() => openAskLauncher("newThread")}
          onClose={() => setSelectionAsk(null)}
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
    </main>
  );
}
