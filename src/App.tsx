import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Bot, SquareTerminal, X } from "lucide-react";
import { agentUiAdapters, findAgentUiAdapter, getAgentUiAdapter } from "./adapters";
import NativeInput from "./components/NativeInput";
import TerminalPane from "./components/TerminalPane";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import TurnOverlay, { formatTurnsTranscript } from "./components/TurnOverlay";
import {
  isTerminalFontLoaded,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from "./lib/terminalFont";
import {
  acknowledgeAgent,
  confirmAppExit,
  getAgentDraft,
  getRuntimeConfig,
  killPane,
  listAgents,
  listAgentTurnQueue,
  listTurns,
  listenToEvents,
  listPanes,
  removeQueuedAgentTurn,
  removeWorktree,
  renamePane,
  reorderPanes,
  setAgentDraft as persistAgentDraft,
  spawnAgent,
  spawnShell,
  submitAgentTurn,
  worktreeStatus,
} from "./lib/api";
import type {
  AgentInfo,
  InitialPaneSize,
  PaneInfo,
  QmuxEvent,
  RuntimeConfig,
  TranscriptCopyPayload,
  TranscriptHookEvent,
  Turn,
  WorktreeStatus,
} from "./types";

const LEFT_SIDEBAR_DEFAULT_WIDTH = 268;
const LEFT_SIDEBAR_MIN_WIDTH = 208;
const LEFT_SIDEBAR_MAX_WIDTH = 420;
// Below this width the New shell/New agent buttons drop their icons to keep the
// labels readable.
const LEFT_SIDEBAR_COMPACT_WIDTH = 230;
const PANE_TAB_DRAG_START_THRESHOLD = 4;
const PANE_TAB_DRAG_CLICK_SUPPRESS_MS = 100;
const TERMINAL_MIN_WIDTH = 380;
const TURN_PANE_MIN_WIDTH = 300;
const TURN_PANE_DEFAULT_WIDTH = 420;
const TURN_PANE_MAX_WIDTH = 720;
const TERMINAL_HORIZONTAL_PADDING = 20;
const TERMINAL_VERTICAL_PADDING = 20;
const DEFAULT_INITIAL_COLS = 100;
const DEFAULT_INITIAL_ROWS = 24;
const MIN_INITIAL_COLS = 20;
const MIN_INITIAL_ROWS = 5;
const MAX_INITIAL_COLS = 500;
const MAX_INITIAL_ROWS = 200;
const PANE_CONTEXT_MENU_WIDTH = 320;
const PANE_CONTEXT_MENU_ESTIMATED_HEIGHT = 250;
const TRANSCRIPT_COPY_VERSION = 1;
// How long the composer can sit idle before its draft is flushed to disk. The
// in-memory copy updates on every keystroke (so tab switches never lose it); the
// disk write is debounced so a paused composer — and a restart — can recover it.
const DRAFT_FLUSH_DEBOUNCE_MS = 1000;

let measuredTerminalCellSize: { width: number; height: number } | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function reconcileQueuedTurnCollapse(
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

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function isTerminalTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && target.closest(".terminal-mount") !== null;
}

function measureTerminalCellSize() {
  if (measuredTerminalCellSize && isTerminalFontLoaded()) {
    return measuredTerminalCellSize;
  }

  const probe = document.createElement("span");
  probe.textContent = "mmmmmmmmmm";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = TERMINAL_FONT_FAMILY;
  probe.style.fontSize = `${TERMINAL_FONT_SIZE}px`;
  document.body.appendChild(probe);

  const rect = probe.getBoundingClientRect();
  probe.remove();

  const cellSize = {
    width: rect.width > 0 ? rect.width / 10 : 8,
    height: rect.height > 0 ? rect.height : 16,
  };
  if (isTerminalFontLoaded()) {
    measuredTerminalCellSize = cellSize;
  }
  return cellSize;
}

function statusLabel(status: PaneInfo["status"]) {
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

function agentStatusLabel(status: AgentInfo["status"], reviewStatus?: WorktreeStatus | null) {
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
function agentStatusTone(status: AgentInfo["status"]) {
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

function transcriptHookEvent(event: QmuxEvent): TranscriptHookEvent | null {
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

function formatTranscriptCopyJson(
  input: Omit<TranscriptCopyPayload, "version" | "exportedAt">,
) {
  const payload: TranscriptCopyPayload = {
    version: TRANSCRIPT_COPY_VERSION,
    exportedAt: new Date().toISOString(),
    ...input,
  };
  return JSON.stringify(payload, null, 2);
}

// The close-confirmation dialog covers two cases: a worktree agent (offer to keep
// or delete the worktree) and a live agent without a worktree (just confirm the
// stop). Both render in-app — window.confirm is a no-op in the Tauri webview.
type CloseDialogState =
  | {
      kind: "worktree";
      pane: PaneInfo;
      agentId: string;
      worktreeDir: string;
      hasChanges: boolean;
      busy: boolean;
    }
  | { kind: "stop"; pane: PaneInfo; reason: string };

type ExitDialogState = {
  paneCount: number;
};

type PaneContextMenuState = {
  paneId: string;
  x: number;
  y: number;
};

type PaneTabPointerDrag = {
  pointerId: number;
  paneId: string;
  startY: number;
  active: boolean;
};

type OrphanedQueueGroup = {
  agent: AgentInfo;
  queuedTurns: string[];
};

interface RecoveredQueuePanelProps {
  queues: OrphanedQueueGroup[];
  hasTargetAgent: boolean;
  agentLabel: string;
  onMoveTurn: (agentId: string, index: number, turn: string) => void;
  onDiscardTurn: (agentId: string, index: number, turn: string) => void;
}

function RecoveredQueuePanel({
  queues,
  hasTargetAgent,
  agentLabel,
  onMoveTurn,
  onDiscardTurn,
}: RecoveredQueuePanelProps) {
  const totalTurns = queues.reduce((total, queue) => total + queue.queuedTurns.length, 0);

  return (
    <section className="recovered-queue-panel" aria-label="Recovered queued turns">
      <header>
        <h2>Recovered queued turns</h2>
        <span>{totalTurns}</span>
      </header>
      <div className="recovered-queue-list">
        {queues.map(({ agent, queuedTurns }) => (
          <div key={agent.id} className="recovered-queue-group">
            {queuedTurns.map((turn, index) => (
              <div key={`${agent.id}-${index}-${turn}`} className="recovered-queue-item">
                <p>{turn}</p>
                <div className="recovered-queue-actions">
                  <button
                    type="button"
                    disabled={!hasTargetAgent}
                    title={
                      hasTargetAgent
                        ? "Queue to the current agent"
                        : `Launch ${agentLabel} in this tab before queueing`
                    }
                    onClick={() => onMoveTurn(agent.id, index, turn)}
                  >
                    Queue
                  </button>
                  <button type="button" onClick={() => onDiscardTurn(agent.id, index, turn)}>
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const appRef = useRef<HTMLElement | null>(null);
  const paneListRef = useRef<HTMLElement | null>(null);
  const terminalStageRef = useRef<HTMLDivElement | null>(null);
  const terminalPaneRefs = useRef(new Map<string, TerminalPaneHandle>());
  const agentsRef = useRef<AgentInfo[]>([]);
  const queuedTurnsByAgentRef = useRef<Record<string, string[]>>({});
  // Composer drafts live here keyed by agent so they survive tab switches; the
  // ref mirrors the state for synchronous reads from the debounced disk flush.
  const draftsByAgentRef = useRef<Record<string, string>>({});
  const draftFlushTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const wasLauncherOpenRef = useRef(false);
  const launcherInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Keep the latest active pane / close handler reachable from the global keydown
  // listener without re-registering it on every state change.
  const activePaneRef = useRef<PaneInfo | undefined>(undefined);
  const requestClosePaneRef = useRef<(pane: PaneInfo) => void>(() => {});
  const paneTabPointerDragRef = useRef<PaneTabPointerDrag | null>(null);
  const paneTabDropIndexRef = useRef<number | null>(null);
  const paneReorderPersistChainRef = useRef<Promise<void>>(Promise.resolve());
  const paneReorderRequestSeqRef = useRef(0);
  const suppressPaneTabClickRef = useRef(false);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [queuedTurnsByAgent, setQueuedTurnsByAgentState] = useState<Record<string, string[]>>({});
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
  const [collapsedQueuedTurnsByAgent, setCollapsedQueuedTurnsByAgent] = useState<
    Record<string, boolean[]>
  >({});
  const [draftsByAgent, setDraftsByAgentState] = useState<Record<string, string>>({});
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [turnPaneWidth, setTurnPaneWidth] = useState(TURN_PANE_DEFAULT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  const [prompt, setPrompt] = useState("");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherAdapterId, setLauncherAdapterId] = useState<string | null>(null);
  const [launcherOptionsByAdapter, setLauncherOptionsByAdapter] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [createInWorktree, setCreateInWorktree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  const [exitDialog, setExitDialog] = useState<ExitDialogState | null>(null);
  const [renamePaneId, setRenamePaneId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<PaneContextMenuState | null>(null);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [paneDropIndex, setPaneDropIndex] = useState<number | null>(null);
  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0],
    [activePaneId, panes],
  );
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.paneId === activePane?.id),
    [activePane?.id, agents],
  );
  const runtimeDefaultAdapterId =
    config?.adapters.find((adapter) => adapter.default)?.id ?? config?.adapters[0]?.id ?? "claude";
  const selectedLauncherAdapterId = launcherAdapterId ?? runtimeDefaultAdapterId;
  const launchAdapter = useMemo(
    () => getAgentUiAdapter(selectedLauncherAdapterId),
    [selectedLauncherAdapterId],
  );
  const launcherOptions = launcherOptionsByAdapter[launchAdapter.id] ?? {};
  const LauncherOptions = launchAdapter.LauncherOptions;
  const launcherAdapters = useMemo(() => {
    const runtimeAdapters = config?.adapters
      .map((adapter) => findAgentUiAdapter(adapter.id))
      .filter((adapter): adapter is NonNullable<typeof adapter> => Boolean(adapter));
    return runtimeAdapters && runtimeAdapters.length > 0 ? runtimeAdapters : agentUiAdapters;
  }, [config]);
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
  const activeTranscript = useMemo(() => formatTurnsTranscript(activeTurns), [activeTurns]);
  const activeHookEvents = useMemo(
    () => (activeAgent ? hookEventsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, hookEventsByAgent],
  );
  const activeTranscriptNotice = useMemo(
    () => (activeAgent ? transcriptNoticeByAgent[activeAgent.id] ?? null : null),
    [activeAgent?.id, transcriptNoticeByAgent],
  );
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
  const activeOrphanedQueues = useMemo(
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

  function replaceQueuedTurnsByAgent(nextQueues: Record<string, string[]>) {
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

  function setAgentQueuedTurns(agentId: string, queuedTurns: string[]) {
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
  // are shown relative to it (e.g. "group-1/agent-1"); other paths fall back to
  // their last two segments so the meaningful tail stays visible. The full path
  // is preserved in the tab's title attribute.
  function formatPaneDir(rawPath: string): string {
    const workspaceRoot = config?.workspaceRoot;
    if (workspaceRoot && rawPath.startsWith(`${workspaceRoot}/`)) {
      return rawPath.slice(workspaceRoot.length + 1);
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
      const submitResult = await submitAgentTurn(targetAgent.id, turn);
      setAgentQueuedTurns(targetAgent.id, submitResult.queuedTurns);
      const removeResult = await removeQueuedAgentTurn(agentId, index, turn);
      setAgentQueuedTurns(agentId, removeResult.queuedTurns);
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
    const cell = measureTerminalCellSize();
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

  const appStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    ...(hasTurnSidebar ? { "--turn-pane-width": `${turnPaneWidth}px` } : {}),
  } as CSSProperties;
  const contextMenuPane = paneContextMenu
    ? panes.find((pane) => pane.id === paneContextMenu.paneId)
    : undefined;
  const contextMenuAgent = contextMenuPane
    ? agents.find((agent) => agent.paneId === contextMenuPane.id)
    : undefined;
  const draggingPaneIndex = draggingPaneId
    ? panes.findIndex((pane) => pane.id === draggingPaneId)
    : -1;

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const [runtimeConfig, existingPanes, existingAgents, existingTurns] = await Promise.all([
          getRuntimeConfig(),
          listPanes(),
          listAgents(),
          listTurns(),
        ]);
        if (cancelled) {
          return;
        }

        setConfig(runtimeConfig);
        setAgents(existingAgents);
        setTurns(existingTurns);
        const [queueEntries, draftEntries] = await Promise.all([
          Promise.all(
            existingAgents.map(async (agent) => [
              agent.id,
              await listAgentTurnQueue(agent.id),
            ] as const),
          ),
          Promise.all(
            existingAgents.map(async (agent) => [agent.id, await getAgentDraft(agent.id)] as const),
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
          setPanes(existingPanes);
          setActivePaneId(existingPanes[0].id);
          return;
        }

        const pane = await spawnShell(estimateInitialPaneSize(false));
        if (!cancelled) {
          setPanes([pane]);
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

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenToEvents((event) => {
      if (disposed) {
        return;
      }
      const hookEvent = transcriptHookEvent(event);
      if (hookEvent) {
        setHookEventsByAgent((current) => ({
          ...current,
          [hookEvent.agentId]: [...(current[hookEvent.agentId] ?? []), hookEvent],
        }));
      }
      if (event.type === "pty.exit" && event.paneId) {
        setPanes((current) =>
          current.map((pane) =>
            pane.id === event.paneId ? { ...pane, status: "exited" } : pane,
          ),
        );
      }
      if (event.type === "app.exit_confirmation_requested") {
        const paneCount =
          typeof event.payload.paneCount === "number" ? event.payload.paneCount : 1;
        setExitDialog({ paneCount });
      }
      if (event.type.startsWith("agent.")) {
        void listAgents().then(setAgents).catch(() => undefined);
      }
      if (
        event.agentId &&
        (event.type === "agent.turn_queued" ||
          event.type === "agent.queued_turn_sent" ||
          event.type === "agent.queued_turn_removed" ||
          event.type === "agent.queued_turn_reordered" ||
          event.type === "agent.queue_error")
      ) {
        const queuedTurns = Array.isArray(event.payload.queuedTurns)
          ? event.payload.queuedTurns.filter((turn): turn is string => typeof turn === "string")
          : null;
        if (queuedTurns) {
          setAgentQueuedTurns(event.agentId, queuedTurns);
        } else {
          void refreshAgentTurnQueue(event.agentId).catch(() => undefined);
        }
      }
      if (event.type === "turn.appended") {
        const turn = event.payload.turn as Turn | undefined;
        if (turn) {
          setTurns((current) =>
            current.some((existing) => existing.id === turn.id) ? current : [...current, turn],
          );
        }
      }
      if (event.type === "turn.updated" && event.payload.reset) {
        const agentId = event.agentId;
        const replacementTurns = Array.isArray(event.payload.turns)
          ? (event.payload.turns as Turn[])
          : [];
        setTurns((current) => [
          ...current.filter((turn) => turn.agentId !== agentId),
          ...replacementTurns,
        ]);
      }
      if (
        event.agentId &&
        (event.type === "transcript.notice" || event.type === "transcript.error")
      ) {
        const agentId = event.agentId;
        // transcript.error carries `error`; transcript.notice carries `message`
        // (null/absent means the tail recovered, so the notice is cleared).
        const message =
          event.type === "transcript.error"
            ? typeof event.payload.error === "string"
              ? event.payload.error
              : "Failed to load transcript"
            : typeof event.payload.message === "string"
              ? event.payload.message
              : null;
        setTranscriptNoticeByAgent((current) => ({ ...current, [agentId]: message }));
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function addShellPane() {
    setError(null);
    try {
      const pane = await spawnShell(estimateInitialPaneSize(false));
      setPanes((current) => [...current, pane]);
      setActivePaneId(pane.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handlePaneTabPointerDown(event: ReactPointerEvent<HTMLDivElement>, paneId: string) {
    if (event.button !== 0) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".pane-tab-close, .pane-tab-recovered, .pane-tab-status-clickable")
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
      setPaneTabDropIndex(null);
    }

    event.preventDefault();
    const list = paneListRef.current;
    if (!list) {
      return;
    }
    setPaneTabDropIndex(paneTabDropIndexFromPoint(list, event.clientY));
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
    const gap =
      paneTabDropIndexRef.current ?? (list ? paneTabDropIndexFromPoint(list, event.clientY) : null);
    clearPaneTabDrag();
    if (gap === null) {
      return;
    }
    reorderPaneTab(drag.paneId, gap);
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

  function setPaneTabDropIndex(index: number | null) {
    paneTabDropIndexRef.current = index;
    setPaneDropIndex(index);
  }

  function clearPaneTabDrag() {
    paneTabDropIndexRef.current = null;
    setDraggingPaneId(null);
    setPaneDropIndex(null);
  }

  function paneTabDropIndexFromPoint(container: HTMLElement, clientY: number) {
    const rows = Array.from(container.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains("pane-tab-row"),
    );
    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    }
    return rows.length;
  }

  function reorderPaneTab(paneId: string, gap: number) {
    const from = panes.findIndex((pane) => pane.id === paneId);
    if (from === -1) {
      return;
    }
    const to = from < gap ? gap - 1 : gap;
    if (to === from || to < 0 || to >= panes.length) {
      return;
    }

    const next = [...panes];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const requestSeq = paneReorderRequestSeqRef.current + 1;
    paneReorderRequestSeqRef.current = requestSeq;
    setPanes(next);

    const persist = paneReorderPersistChainRef.current
      .catch(() => undefined)
      .then(() => reorderPanes(next.map((pane) => pane.id)));
    paneReorderPersistChainRef.current = persist
      .then((orderedPanes) => {
        if (paneReorderRequestSeqRef.current === requestSeq) {
          setPanes(orderedPanes);
        }
      })
      .catch((err) => {
        if (paneReorderRequestSeqRef.current === requestSeq) {
          setError(err instanceof Error ? err.message : String(err));
          void listPanes().then(setPanes).catch(() => undefined);
        }
      });
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

  // The "Recovered" badge is a one-time, post-restart hint. Clicking it just
  // clears the flag locally (panes are only fetched once at startup), so the
  // acknowledgement sticks for the session.
  function dismissRecoveredBadge(paneId: string) {
    setPanes((current) =>
      current.map((pane) => (pane.id === paneId ? { ...pane, recovered: false } : pane)),
    );
  }

  function openRenameDialog(pane: PaneInfo) {
    setRenameValue(pane.title);
    setRenamePaneId(pane.id);
  }

  async function submitRename() {
    const paneId = renamePaneId;
    if (!paneId) {
      return;
    }
    const title = renameValue.trim();
    const previous = panes.find((pane) => pane.id === paneId);
    setRenamePaneId(null);
    if (!title || previous?.title === title) {
      return;
    }
    // Optimistically rename, then persist; revert if the backend rejects it.
    setPanes((current) =>
      current.map((pane) => (pane.id === paneId ? { ...pane, title } : pane)),
    );
    try {
      const updated = await renamePane(paneId, title);
      setPanes((current) =>
        current.map((pane) => (pane.id === paneId ? { ...pane, title: updated.title } : pane)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPanes((current) =>
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
      setPanes((current) => {
        const nextPanes = current.filter((pane) => pane.id !== paneToClose.id);
        setActivePaneId((currentActivePaneId) => {
          if (currentActivePaneId !== paneToClose.id) {
            return currentActivePaneId;
          }
          return nextPanes[0]?.id ?? null;
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
  async function requestClosePane(paneToClose: PaneInfo) {
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
    await closePane(paneToClose);
  }

  // Resolves the worktree close dialog: always closes the pane, and additionally
  // deletes the worktree when the user chose to.
  async function resolveCloseDialog(choice: "keep" | "delete") {
    const dialog = closeDialog;
    if (!dialog || dialog.kind !== "worktree") {
      return;
    }
    setCloseDialog(null);
    setError(null);
    try {
      await closePane(dialog.pane);
      if (choice === "delete") {
        await removeWorktree(dialog.agentId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    const trimmed = prompt.trim();
    setError(null);
    try {
      const pane = await spawnAgent({
        adapterId: launchAdapter.id,
        prompt: trimmed,
        baseRepo: null,
        baseRef: "HEAD",
        initialSize: estimateInitialPaneSize(true),
        useWorktree: createInWorktree,
        options: launcherOptions,
      });
      setPanes((current) => [...current, pane]);
      setActivePaneId(pane.id);
      if (pane.agentId) {
        setAgentQueuedTurns(pane.agentId, []);
      }
      setPrompt("");
      setLauncherOpen(false);
      setAgents(await listAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        setCloseDialog(null);
        setExitDialog(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeDialog, exitDialog]);

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
      if (event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey)) {
        return;
      }

      const key = event.key.toLowerCase();

      // Ctrl-Tab / Ctrl-Shift-Tab cycle through the open tabs like a browser.
      // Claimed here in the capture phase (before the terminal/editable bail) so
      // it works regardless of focus; Tab with Ctrl is never a text-editing key.
      if (key === "tab" && event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        if (panes.length > 0) {
          const direction = event.shiftKey ? -1 : 1;
          setActivePaneId((current) => {
            const index = panes.findIndex((pane) => pane.id === current);
            const base = index === -1 ? 0 : index;
            return panes[(base + direction + panes.length) % panes.length].id;
          });
        }
        return;
      }

      // Cmd-Shift-[ / Cmd-Shift-] cycle backward/forward through the open tabs.
      // Claimed in the capture phase so it works regardless of focus.
      if ((key === "[" || key === "]") && event.metaKey && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (panes.length > 0) {
          const direction = key === "[" ? -1 : 1;
          setActivePaneId((current) => {
            const index = panes.findIndex((pane) => pane.id === current);
            const base = index === -1 ? 0 : index;
            return panes[(base + direction + panes.length) % panes.length].id;
          });
        }
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

      if (key !== "t" && key !== "n" && key !== "w") {
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

      // Cmd-T / Cmd-N open a new shell pane.
      if (!event.metaKey || event.ctrlKey) {
        return;
      }
      void addShellPane();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [panes]);

  useEffect(() => {
    if (!launcherOpen) {
      return;
    }

    // New agents default to no worktree each time the launcher opens.
    setCreateInWorktree(false);
    requestAnimationFrame(() => {
      launcherInputRef.current?.focus();
      launcherInputRef.current?.select();
    });
  }, [launcherOpen]);

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
          {panes.length === 0 ? <div className="empty-state pane-list-empty">No tabs</div> : null}
          {panes.map((pane, index) => {
            const paneAgent = agents.find((agent) => agent.paneId === pane.id);
            const paneAgentWorktreeStatus = paneAgent
              ? worktreeStatusByAgent[paneAgent.id]
              : undefined;
            const paneAgentStatusTone = paneAgent ? agentStatusTone(paneAgent.status) : "idle";
            const rawStatus = paneAgent
              ? agentStatusLabel(paneAgent.status, paneAgentWorktreeStatus)
              : statusLabel(pane.status);
            // "Running" is the steady state for every pane, so it is just noise.
            const paneStatus = rawStatus === "Running" ? null : rawStatus;
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
            const activeDrop =
              paneDropIndex === null ||
              paneDropIndex === draggingPaneIndex ||
              paneDropIndex === draggingPaneIndex + 1
                ? null
                : paneDropIndex;
            const className = [
              "pane-tab-row",
              pane.id === activePane?.id ? "is-selected" : "",
              pane.id === draggingPaneId ? "is-dragging" : "",
              activeDrop === index ? "is-drop-before" : "",
              activeDrop === panes.length && index === panes.length - 1
                ? "is-drop-after"
                : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={pane.id}
                className={className}
                onContextMenu={(event) => openPaneContextMenu(event, pane)}
                onPointerDown={(event) => handlePaneTabPointerDown(event, pane.id)}
                onPointerMove={handlePaneTabPointerMove}
                onPointerUp={handlePaneTabPointerUp}
                onPointerCancel={handlePaneTabPointerCancel}
                onClick={() => handlePaneTabClick(pane.id)}
                onDoubleClick={() => handlePaneTabDoubleClick(pane)}
              >
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
                  <span className="pane-tab-line">
                    <span
                      className={`pane-tab-dot status-${paneAgentStatusTone}`}
                      aria-hidden="true"
                    />
                    <span className="pane-tab-title">{pane.title}</span>
                    <span className="pane-tab-meta">
                      {pane.recovered ? (
                        <small
                          className="pane-tab-recovered"
                          role="button"
                          tabIndex={0}
                          title="Recovered after restart — click to dismiss"
                          aria-label="Dismiss recovered label"
                          onClick={(event) => {
                            event.stopPropagation();
                            dismissRecoveredBadge(pane.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              dismissRecoveredBadge(pane.id);
                            }
                          }}
                        >
                          Recovered
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
                </button>
                <button
                  type="button"
                  className="pane-tab-close"
                  aria-label={`Close ${pane.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void requestClosePane(pane);
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-actions">
          <button type="button" onClick={addShellPane}>
            <SquareTerminal size={14} aria-hidden="true" />
            <span>New shell</span>
          </button>
          <button type="button" onClick={() => setLauncherOpen(true)}>
            <Bot size={14} aria-hidden="true" />
            <span>New agent</span>
          </button>
        </div>
      </aside>

      {paneContextMenu && contextMenuPane ? (
        <div
          className="pane-context-menu"
          role="dialog"
          aria-label={`${contextMenuPane.title} details`}
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
              <dd>{contextMenuPane.title}</dd>
            </div>
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
          <form
            className="command-launcher"
            role="dialog"
            aria-modal="true"
            aria-label="New agent"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setLauncherOpen(false);
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
            <textarea
              ref={launcherInputRef}
              id="agent-prompt"
              className="command-launcher-input"
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              rows={2}
              placeholder="What do you want to do next?"
            />
            <div className="command-launcher-overlay">
              <div className="command-launcher-overlay-group">
                <label className="command-launcher-worktree">
                  <input
                    type="checkbox"
                    checked={createInWorktree}
                    onChange={(event) => setCreateInWorktree(event.currentTarget.checked)}
                  />
                  <span>New worktree</span>
                </label>
                {LauncherOptions ? (
                  <div className="command-launcher-options">
                    <LauncherOptions
                      value={launcherOptions}
                      onChange={(next) =>
                        setLauncherOptionsByAdapter((current) => ({
                          ...current,
                          [launchAdapter.id]: next,
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
              <div className="command-launcher-controls">
                <div className="command-launcher-adapter-picker" role="group" aria-label="Agent">
                  {launcherAdapters.map((adapter) => (
                    <button
                      key={adapter.id}
                      type="button"
                      className={adapter.id === launchAdapter.id ? "is-active" : ""}
                      aria-pressed={adapter.id === launchAdapter.id}
                      onClick={() => setLauncherAdapterId(adapter.id)}
                    >
                      {adapter.label}
                    </button>
                  ))}
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
        </div>
      ) : null}

      {closeDialog ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
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
                  <button type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void resolveCloseDialog("delete")}
                  >
                    Delete worktree
                  </button>
                  <button type="button" autoFocus onClick={() => void resolveCloseDialog("keep")}>
                    Keep worktree
                  </button>
                </div>
              </>
            ) : (
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
          {panes.length === 0 ? (
            <div className="empty-state terminal-empty-state">No active tab</div>
          ) : null}
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              ref={(handle) => {
                if (handle) {
                  terminalPaneRefs.current.set(pane.id, handle);
                } else {
                  terminalPaneRefs.current.delete(pane.id);
                }
              }}
              pane={pane}
              active={pane.id === activePane?.id}
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
            notice={activeAgent ? activeTranscriptNotice : null}
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
                    onQueueChange={setAgentQueuedTurns}
                    onDraftChange={setAgentDraft}
                    onQueuedTurnCollapseToggle={toggleQueuedTurnCollapsed}
                    onError={setError}
                  />
                ) : null}
              </div>
            }
          />
        </aside>
      ) : null}
    </main>
  );
}
