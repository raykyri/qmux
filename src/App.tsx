import { useEffect, useMemo, useState } from "react";
import NativeInput from "./components/NativeInput";
import TerminalPane from "./components/TerminalPane";
import TurnOverlay from "./components/TurnOverlay";
import {
  getRuntimeConfig,
  killPane,
  listAgents,
  listTurns,
  listenToEvents,
  listPanes,
  spawnClaude,
  spawnShell,
} from "./lib/api";
import type { AgentInfo, PaneInfo, RuntimeConfig, Turn } from "./types";

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
    case "stopped":
      return null;
    case "failed":
      return "Failed";
  }
}

export default function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [turnOverlayVisible, setTurnOverlayVisible] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [baseRepo, setBaseRepo] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
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

        if (existingPanes.length > 0) {
          setPanes(existingPanes);
          setActivePaneId(existingPanes[0].id);
          return;
        }

        const pane = await spawnShell();
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
      const pane = await spawnShell();
      setPanes((current) => [...current, pane]);
      setActivePaneId(pane.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function closeActivePane() {
    if (!activePane) {
      return;
    }

    setError(null);
    try {
      await killPane(activePane.id);
      setPanes((current) => current.filter((pane) => pane.id !== activePane.id));
      setActivePaneId((current) => {
        if (current !== activePane.id) {
          return current;
        }
        return panes.find((pane) => pane.id !== activePane.id)?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addClaudePane() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Enter a prompt before launching Claude.");
      return;
    }

    setError(null);
    try {
      const pane = await spawnClaude({
        prompt: trimmed,
        baseRepo: baseRepo.trim() || null,
        baseRef: baseRef.trim() || "HEAD",
      });
      setPanes((current) => [...current, pane]);
      setActivePaneId(pane.id);
      setPrompt("");
      setAgents(await listAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "w") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (key === "t") {
        void addShellPane();
      } else {
        void closeActivePane();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activePane, panes]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <nav className="pane-list" aria-label="Panes">
          {panes.map((pane) => {
            const paneAgent = agents.find((agent) => agent.paneId === pane.id);
            const paneStatus = paneAgent
              ? agentStatusLabel(paneAgent.status)
              : statusLabel(pane.status);
            return (
              <button
                key={pane.id}
                type="button"
                className={pane.id === activePane?.id ? "pane-tab is-selected" : "pane-tab"}
                onClick={() => setActivePaneId(pane.id)}
              >
                <span>{pane.title}</span>
                {paneStatus ? <small>{paneStatus}</small> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-actions">
          <button type="button" onClick={addShellPane}>
            New shell
          </button>
          <button type="button" onClick={closeActivePane} disabled={!activePane}>
            Close pane
          </button>
        </div>

        <form
          className="launcher"
          onSubmit={(event) => {
            event.preventDefault();
            void addClaudePane();
          }}
        >
          <label htmlFor="claude-prompt">Claude prompt</label>
          <textarea
            id="claude-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            rows={5}
            placeholder="Ask Claude Code to work on this checkout..."
          />
          <div className="launcher-options">
            <label htmlFor="base-repo">Base repo</label>
            <input
              id="base-repo"
              value={baseRepo}
              onChange={(event) => setBaseRepo(event.currentTarget.value)}
              placeholder="Default: this checkout"
            />
            <label htmlFor="base-ref">Base ref</label>
            <input
              id="base-ref"
              value={baseRef}
              onChange={(event) => setBaseRef(event.currentTarget.value)}
            />
          </div>
          <button type="submit">Launch Claude</button>
        </form>

        {config ? (
          <dl className="runtime-info">
            <div>
              <dt>Workspace</dt>
              <dd>{config.workspaceRoot}</dd>
            </div>
            <div>
              <dt>Socket</dt>
              <dd>{config.socketPath}</dd>
            </div>
          </dl>
        ) : null}
      </aside>

      <section className="workspace">
        {error ? <div className="error-banner">{error}</div> : null}

        <div className="terminal-stage">
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              pane={pane}
              active={pane.id === activePane?.id}
            />
          ))}
          {activeAgent ? (
            <>
              <TurnOverlay
                turns={activeTurns}
                visible={turnOverlayVisible}
                onToggle={() => setTurnOverlayVisible((visible) => !visible)}
                input={
                  activePane ? (
                    <NativeInput pane={activePane} agent={activeAgent} onError={setError} />
                  ) : null
                }
              />
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
