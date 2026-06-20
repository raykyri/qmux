import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Sparkles, SquareTerminal, X } from "lucide-react";
import NativeInput from "./components/NativeInput";
import TerminalPane from "./components/TerminalPane";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import TurnOverlay, { formatTurnsTranscript } from "./components/TurnOverlay";
import {
  getRuntimeConfig,
  killPane,
  listAgents,
  listAgentTurnQueue,
  listTurns,
  listenToEvents,
  listPanes,
  removeWorktree,
  spawnClaude,
  spawnShell,
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
} from "./types";

const LEFT_SIDEBAR_DEFAULT_WIDTH = 268;
const LEFT_SIDEBAR_MIN_WIDTH = 208;
const LEFT_SIDEBAR_MAX_WIDTH = 420;
const TERMINAL_MIN_WIDTH = 380;
const TURN_PANE_MIN_WIDTH = 300;
const TURN_PANE_DEFAULT_WIDTH = 420;
const TURN_PANE_MAX_WIDTH = 720;
const TERMINAL_HORIZONTAL_PADDING = 20;
const TERMINAL_VERTICAL_PADDING = 20;
const TERMINAL_FONT_SIZE = 13;
const TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
const DEFAULT_INITIAL_COLS = 100;
const DEFAULT_INITIAL_ROWS = 24;
const MIN_INITIAL_COLS = 20;
const MIN_INITIAL_ROWS = 5;
const MAX_INITIAL_COLS = 500;
const MAX_INITIAL_ROWS = 200;
const PANE_CONTEXT_MENU_WIDTH = 320;
const PANE_CONTEXT_MENU_ESTIMATED_HEIGHT = 250;
const TRANSCRIPT_COPY_VERSION = 1;

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
  return target instanceof HTMLElement && target.closest(".xterm") !== null;
}

function measureTerminalCellSize() {
  if (measuredTerminalCellSize) {
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

  measuredTerminalCellSize = {
    width: rect.width > 0 ? rect.width / 10 : 8,
    height: rect.height > 0 ? rect.height : 16,
  };
  return measuredTerminalCellSize;
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

function agentStatusLabel(status: AgentInfo["status"]) {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "awaitingInput":
      return "Awaiting input";
    case "awaitingPermission":
      return "Approval needed";
    case "stopped":
      return null;
    case "failed":
      return "Failed";
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

type PaneContextMenuState = {
  paneId: string;
  x: number;
  y: number;
};

export default function App() {
  const appRef = useRef<HTMLElement | null>(null);
  const terminalStageRef = useRef<HTMLDivElement | null>(null);
  const terminalPaneRefs = useRef(new Map<string, TerminalPaneHandle>());
  const queuedTurnsByAgentRef = useRef<Record<string, string[]>>({});
  const wasLauncherOpenRef = useRef(false);
  const launcherInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Keep the latest active pane / close handler reachable from the global keydown
  // listener without re-registering it on every state change.
  const activePaneRef = useRef<PaneInfo | undefined>(undefined);
  const requestClosePaneRef = useRef<(pane: PaneInfo) => void>(() => {});
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [queuedTurnsByAgent, setQueuedTurnsByAgentState] = useState<Record<string, string[]>>({});
  const [hookEventsByAgent, setHookEventsByAgent] = useState<
    Record<string, TranscriptHookEvent[]>
  >({});
  const [collapsedQueuedTurnsByAgent, setCollapsedQueuedTurnsByAgent] = useState<
    Record<string, boolean[]>
  >({});
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [turnPaneWidth, setTurnPaneWidth] = useState(TURN_PANE_DEFAULT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  const [prompt, setPrompt] = useState("");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [createInWorktree, setCreateInWorktree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<PaneContextMenuState | null>(null);
  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0],
    [activePaneId, panes],
  );
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.paneId === activePane?.id),
    [activePane?.id, agents],
  );
  const activeTurns = useMemo(
    () => turns.filter((turn) => turn.agentId === activeAgent?.id),
    [activeAgent?.id, turns],
  );
  const activeTranscript = useMemo(() => formatTurnsTranscript(activeTurns), [activeTurns]);
  const activeHookEvents = useMemo(
    () => (activeAgent ? hookEventsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, hookEventsByAgent],
  );
  const activeQueuedTurns = useMemo(
    () => (activeAgent ? queuedTurnsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, queuedTurnsByAgent],
  );
  const activeCollapsedQueuedTurns = useMemo(
    () => (activeAgent ? collapsedQueuedTurnsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, collapsedQueuedTurnsByAgent],
  );

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
    const reservedTurnPane = activeAgent ? turnPaneWidth : 0;
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
    ...(activeAgent ? { "--turn-pane-width": `${turnPaneWidth}px` } : {}),
  } as CSSProperties;
  const contextMenuPane = paneContextMenu
    ? panes.find((pane) => pane.id === paneContextMenu.paneId)
    : undefined;
  const contextMenuAgent = contextMenuPane
    ? agents.find((agent) => agent.paneId === contextMenuPane.id)
    : undefined;

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
        const queueEntries = await Promise.all(
          existingAgents.map(async (agent) => [
            agent.id,
            await listAgentTurnQueue(agent.id),
          ] as const),
        );
        if (cancelled) {
          return;
        }
        replaceQueuedTurnsByAgent(Object.fromEntries(queueEntries));

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
      if (event.type.startsWith("agent.")) {
        void listAgents().then(setAgents).catch(() => undefined);
      }
      if (
        event.agentId &&
        (event.type === "agent.turn_queued" ||
          event.type === "agent.queued_turn_sent" ||
          event.type === "agent.queued_turn_removed" ||
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

    const reason =
      agent?.status === "awaitingPermission"
        ? "is waiting for you to approve a tool use"
        : agent?.status === "awaitingInput"
          ? "is waiting for your input"
          : agent?.status === "running" || agent?.status === "starting"
            ? "is still working"
            : null;
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

  async function addClaudePane() {
    const trimmed = prompt.trim();
    setError(null);
    try {
      const pane = await spawnClaude({
        prompt: trimmed,
        baseRepo: null,
        baseRef: "HEAD",
        initialSize: estimateInitialPaneSize(true),
        useWorktree: createInWorktree,
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
    if (!closeDialog) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCloseDialog(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeDialog]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "k" && key !== "w") {
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

      // The terminal owns ⌘K (clear) and Ctrl-K (kill-line), so never hijack K there.
      if (key === "k" && isTerminalTarget(event.target)) {
        return;
      }

      // Ctrl-based shortcuts collide with native text editing (e.g. Ctrl-K kill-line) in
      // any editable element, so let those through; the documented ⌘ shortcuts keep working.
      if (event.ctrlKey && !event.metaKey && isEditableTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (key === "t") {
        if (!event.metaKey || event.ctrlKey) {
          return;
        }
        void addShellPane();
      } else {
        setLauncherOpen(true);
      }
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
    if (wasLauncherOpenRef.current && !launcherOpen) {
      focusActiveTerminal();
    }
    wasLauncherOpenRef.current = launcherOpen;
  }, [launcherOpen, activePane?.id]);

  useEffect(() => {
    if (!activeAgent) {
      return;
    }

    const handleResize = () => {
      setTurnPaneWidth((current) => clampTurnPaneWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeAgent]);

  // Keep the sidebar within bounds as the window resizes or the turn pane claims
  // space (deps refresh the clamp's view of available width).
  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeAgent, turnPaneWidth]);

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
      className={`app-shell ${activeAgent ? "has-turn-sidebar" : ""}`}
      style={appStyle}
    >
      <aside className="sidebar">
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
        <nav className="pane-list" aria-label="Panes">
          {panes.map((pane) => {
            const paneAgent = agents.find((agent) => agent.paneId === pane.id);
            const rawStatus = paneAgent
              ? agentStatusLabel(paneAgent.status)
              : statusLabel(pane.status);
            // "Running" is the steady state for every pane, so it is just noise.
            const paneStatus = rawStatus === "Running" ? null : rawStatus;
            // Agent panes live in a worktree; shells show the directory they
            // launched in (their spawn-time cwd).
            const paneDir = paneAgent?.worktreeDir ?? pane.cwd;
            return (
              <div
                key={pane.id}
                className={pane.id === activePane?.id ? "pane-tab-row is-selected" : "pane-tab-row"}
                onContextMenu={(event) => openPaneContextMenu(event, pane)}
              >
                <button
                  type="button"
                  className="pane-tab"
                  onClick={() => setActivePaneId(pane.id)}
                >
                  <span className="pane-tab-line">
                    <span className="pane-tab-title">{pane.title}</span>
                    <span className="pane-tab-meta">
                      {pane.recovered ? (
                        <small className="pane-tab-recovered" title="Recovered after restart">
                          Recovered
                        </small>
                      ) : null}
                      {paneStatus ? <small>{paneStatus}</small> : null}
                    </span>
                  </span>
                  {paneDir ? (
                    <span className="pane-tab-path" title={paneDir}>
                      {formatPaneDir(paneDir)}
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
            <Sparkles size={14} aria-hidden="true" />
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
          {contextMenuAgent ? (
            <div className="pane-context-status">
              <span>Agent status</span>
              <strong>{agentStatusLabel(contextMenuAgent.status) ?? "Stopped"}</strong>
            </div>
          ) : null}
          <dl className="pane-context-details">
            <div>
              <dt>Tab</dt>
              <dd>{contextMenuPane.title}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{contextMenuAgent?.branch ?? "None"}</dd>
            </div>
            <div>
              <dt>Worktree</dt>
              <dd>{contextMenuAgent?.branch ? contextMenuAgent.worktreeDir : "None"}</dd>
            </div>
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
                void addClaudePane();
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void addClaudePane();
            }}
          >
            <textarea
              ref={launcherInputRef}
              id="claude-prompt"
              className="command-launcher-input"
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              rows={3}
              placeholder="What’s next?"
            />
            <div className="command-launcher-overlay">
              <label className="command-launcher-worktree">
                <input
                  type="checkbox"
                  checked={createInWorktree}
                  onChange={(event) => setCreateInWorktree(event.currentTarget.checked)}
                />
                <span>Worktree</span>
              </label>
              <button
                type="submit"
                className="command-launcher-send"
                aria-label="Launch Claude"
                title="Launch Claude"
              >
                <span aria-hidden="true">⌘↵</span>
              </button>
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

      <section className="workspace">
        {error ? <div className="error-banner">{error}</div> : null}

        <div ref={terminalStageRef} className="terminal-stage">
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

      {activeAgent ? (
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
            turns={activeTurns}
            agentId={activeAgent.id}
            input={
              activePane ? (
                <NativeInput
                  pane={activePane}
                  agent={activeAgent}
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
                  onQueueChange={setAgentQueuedTurns}
                  onQueuedTurnCollapseToggle={toggleQueuedTurnCollapsed}
                  onError={setError}
                />
              ) : null
            }
          />
        </aside>
      ) : null}
    </main>
  );
}
