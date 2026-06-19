import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
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
  spawnClaude,
  spawnShell,
} from "./lib/api";
import type { AgentInfo, InitialPaneSize, PaneInfo, RuntimeConfig, Turn } from "./types";

const LEFT_SIDEBAR_WIDTH = 268;
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

let measuredTerminalCellSize: { width: number; height: number } | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

export default function App() {
  const appRef = useRef<HTMLElement | null>(null);
  const terminalStageRef = useRef<HTMLDivElement | null>(null);
  const terminalPaneRefs = useRef(new Map<string, TerminalPaneHandle>());
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
  const [queuedTurnsByAgent, setQueuedTurnsByAgent] = useState<Record<string, string[]>>({});
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [turnPaneWidth, setTurnPaneWidth] = useState(TURN_PANE_DEFAULT_WIDTH);
  const [prompt, setPrompt] = useState("");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const activeQueuedTurns = useMemo(
    () => (activeAgent ? queuedTurnsByAgent[activeAgent.id] ?? [] : []),
    [activeAgent?.id, queuedTurnsByAgent],
  );

  function setAgentQueuedTurns(agentId: string, queuedTurns: string[]) {
    setQueuedTurnsByAgent((current) => ({
      ...current,
      [agentId]: queuedTurns,
    }));
  }

  // Compact directory label for a pane tab. Worktrees under the workspace root
  // are shown relative to it (e.g. "group-1/agent-1"); home paths use ~/ and
  // other paths fall back to their last two segments so the meaningful tail stays
  // visible. The full path is preserved in the tab's title attribute.
  function formatPaneDir(rawPath: string): string {
    const workspaceRoot = config?.workspaceRoot;
    if (workspaceRoot && rawPath.startsWith(`${workspaceRoot}/`)) {
      return rawPath.slice(workspaceRoot.length + 1);
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
    const available = Math.floor(appWidth - LEFT_SIDEBAR_WIDTH - TERMINAL_MIN_WIDTH);
    return Math.max(TURN_PANE_MIN_WIDTH, Math.min(TURN_PANE_MAX_WIDTH, available));
  }

  function clampTurnPaneWidth(width: number) {
    return clamp(width, TURN_PANE_MIN_WIDTH, maxTurnPaneWidth());
  }

  function estimateInitialPaneSize(willShowTurnPane: boolean): InitialPaneSize {
    const stageRect = terminalStageRef.current?.getBoundingClientRect();
    const appWidth = appRef.current?.getBoundingClientRect().width;
    const reservedTurnPaneWidth = willShowTurnPane ? clampTurnPaneWidth(turnPaneWidth) : 0;
    const terminalWidth =
      appWidth !== undefined
        ? appWidth - LEFT_SIDEBAR_WIDTH - reservedTurnPaneWidth
        : (stageRect?.width ?? window.innerWidth - LEFT_SIDEBAR_WIDTH - reservedTurnPaneWidth);
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

  const appStyle = activeAgent
    ? ({
        "--turn-pane-width": `${turnPaneWidth}px`,
      } as CSSProperties)
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
        setQueuedTurnsByAgent(Object.fromEntries(queueEntries));

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

  async function closePane(paneToClose: PaneInfo) {
    setError(null);
    try {
      await killPane(paneToClose.id);
      setPanes((current) => current.filter((pane) => pane.id !== paneToClose.id));
      setActivePaneId((current) => {
        if (current !== paneToClose.id) {
          return current;
        }
        return panes.find((pane) => pane.id !== paneToClose.id)?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Closing a live agent pane interrupts it, so confirm first when the agent is
  // working or waiting on the user (awaiting input or a yes/no approval). Shell
  // panes and finished/failed agents close without a prompt.
  async function requestClosePane(paneToClose: PaneInfo) {
    const agent = agents.find((candidate) => candidate.paneId === paneToClose.id);
    const reason =
      agent?.status === "awaitingPermission"
        ? "is waiting for you to approve a tool use"
        : agent?.status === "awaitingInput"
          ? "is waiting for your input"
          : agent?.status === "running" || agent?.status === "starting"
            ? "is still working"
            : null;
    if (reason && !window.confirm(`This agent ${reason}. Close the pane and stop it?`)) {
      return;
    }
    await closePane(paneToClose);
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

  return (
    <main
      ref={appRef}
      className={`app-shell ${activeAgent ? "has-turn-sidebar" : ""}`}
      style={appStyle}
    >
      <aside className="sidebar">
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
                  x
                </button>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-actions">
          <button type="button" onClick={addShellPane}>
            New shell
          </button>
          <button type="button" onClick={() => setLauncherOpen(true)}>
            New agent
          </button>
        </div>
      </aside>

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
            aria-labelledby="claude-launcher-title"
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
            <div className="command-launcher-header">
              <h2 id="claude-launcher-title">New agent</h2>
              <span className="shortcut-hint" aria-label="Command K">
                ⌘K
              </span>
            </div>
            <textarea
              ref={launcherInputRef}
              id="claude-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              rows={5}
              placeholder="Ask Claude Code to work on this checkout..."
            />
            <div className="command-launcher-actions">
              <button type="button" onClick={() => setLauncherOpen(false)}>
                Cancel
              </button>
              <button type="submit">
                <span>Launch Claude</span>
                <span className="shortcut-hint" aria-label="Command Enter">
                  ⌘↵
                </span>
              </button>
            </div>
          </form>
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
            input={
              activePane ? (
                <NativeInput
                  pane={activePane}
                  agent={activeAgent}
                  queuedTurns={activeQueuedTurns}
                  transcriptText={activeTranscript}
                  onQueueChange={setAgentQueuedTurns}
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
