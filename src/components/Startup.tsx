import { useEffect, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
// Use the shared button directly so the bootstrap chunk doesn't traverse the
// UI barrel's popover/dialog dependencies back into the full application.
import Button from "./ui/Button";

type StartupProgress = {
  phase: "loading" | "panes" | "ready" | "failed";
  completed: number;
  total: number;
  error: string | null;
  quitting: boolean;
};

const initialProgress: StartupProgress = {
  phase: "loading", completed: 0, total: 0, error: null, quitting: false,
};

type Application = ComponentType<{ onReady?: () => void }>;
const loadApplication = async (): Promise<Application> => (await import("../App")).default;

export default function Startup({ loadApp = loadApplication }: { loadApp?: () => Promise<Application> }) {
  const [progress, setProgress] = useState(initialProgress);
  const [App, setApp] = useState<Application | null>(null);
  const [interfaceReady, setInterfaceReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quickLaunch = new URLSearchParams(window.location.search).has("global-task-launcher");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Load the full interface concurrently, but don't mount its effects until
    // the backend owns a complete recovered session.
    void loadApp().then((app) => {
      if (!cancelled) setApp(() => app);
    }).catch((err: unknown) => {
      if (!cancelled) setError(String(err));
    });
    if (!quickLaunch) {
      // The status DOM is committed when this effect runs. Don't wait for an
      // animation frame: WebKit can suspend frames in a still-hidden window.
      void invoke("app_window_ready").catch(() => undefined);
    }
    async function poll() {
      try {
        const next = await invoke<StartupProgress>("startup_progress");
        if (cancelled) return;
        setProgress(next);
        if (next.phase !== "ready" && next.phase !== "failed") {
          timer = setTimeout(() => void poll(), 150);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [quickLaunch, loadApp]);

  const failure = error ?? progress.error;
  const ready = progress.phase === "ready" && !progress.quitting && !failure && App;
  return <>
    {ready && <div className="startup-app" inert={!interfaceReady && !quickLaunch}>
      <App onReady={() => setInterfaceReady(true)} />
    </div>}
    {!(ready && (interfaceReady || quickLaunch)) && <main className="startup-screen">
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="startup-content">
        <div role={failure ? "alert" : "status"} aria-live="polite">
          {failure
            ? <>
              <h1>Couldn’t restore your session</h1>
              <p>{failure}</p>
            </>
            : progress.quitting
              ? <>
                <h1>Closing qmux…</h1>
                <p>Your saved session will be kept for the next launch.</p>
              </>
              : <div className="startup-status">
                <div className="startup-status-row">
                  <span className="startup-status-label">
                    {progress.phase === "ready" ? "Preparing workspace" : "Restoring session"}
                  </span>
                  {progress.phase === "panes" && progress.total > 0 && (
                    <span className="startup-status-badge">{progress.completed} / {progress.total}</span>
                  )}
                </div>
                <div className="startup-progress-track">
                  <div
                    className={`startup-progress-fill${progress.phase !== "panes" || progress.total === 0 ? " indeterminate" : ""}`}
                    style={progress.phase === "panes" && progress.total > 0
                      ? { width: `${(progress.completed / progress.total) * 100}%` }
                      : undefined}
                    role="progressbar"
                    aria-label="Session restoration"
                    aria-valuenow={progress.phase === "panes" ? progress.completed : undefined}
                    aria-valuemax={progress.phase === "panes" ? progress.total : undefined}
                  />
                </div>
              </div>
          }
        </div>
        <Button disabled={progress.quitting} onClick={() => {
          void invoke("startup_quit").catch((err: unknown) => setError(String(err)));
        }}>Quit</Button>
      </div>
    </main>}
  </>;
}
