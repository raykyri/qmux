import { useEffect, useMemo, useState } from "react";
import TerminalPane from "./components/TerminalPane";
import {
  getRuntimeConfig,
  killPane,
  listAgents,
  listGroups,
  listenToEvents,
  listPanes,
  spawnClaude,
  spawnShell,
} from "./lib/api";
import type { AgentInfo, GroupInfo, PaneInfo, RuntimeConfig } from "./types";

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

export default function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [baseRepo, setBaseRepo] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [error, setError] = useState<string | null>(null);
  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0],
    [activePaneId, panes],
  );

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const [runtimeConfig, existingPanes, existingGroups, existingAgents] = await Promise.all([
          getRuntimeConfig(),
          listPanes(),
          listGroups(),
          listAgents(),
        ]);
        if (cancelled) {
          return;
        }

        setConfig(runtimeConfig);
        setGroups(existingGroups);
        setAgents(existingAgents);

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

    await killPane(activePane.id);
    setPanes((current) => current.filter((pane) => pane.id !== activePane.id));
    setActivePaneId((current) => {
      if (current !== activePane.id) {
        return current;
      }
      return panes.find((pane) => pane.id !== activePane.id)?.id ?? null;
    });
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
      setGroups(await listGroups());
      setAgents(await listAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">q</span>
          <div>
            <h1>qmux</h1>
            <p>PTY renderer</p>
          </div>
        </div>

        <nav className="pane-list" aria-label="Panes">
          {panes.map((pane) => (
            <button
              key={pane.id}
              type="button"
              className={pane.id === activePane?.id ? "pane-tab is-selected" : "pane-tab"}
              onClick={() => setActivePaneId(pane.id)}
            >
              <span>{pane.title}</span>
              <small>{statusLabel(pane.status)}</small>
            </button>
          ))}
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

        <div className="workspace-summary">
          <strong>{groups.length}</strong>
          <span>groups</span>
          <strong>{agents.length}</strong>
          <span>agents</span>
        </div>

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
        <header className="workspace-header">
          <div>
            <h2>{activePane?.title ?? "No pane"}</h2>
            <p>{activePane?.cwd ?? "Create a shell pane to begin."}</p>
          </div>
          {activePane ? <span className="status-chip">{statusLabel(activePane.status)}</span> : null}
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="terminal-stage">
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              pane={pane}
              active={pane.id === activePane?.id}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
