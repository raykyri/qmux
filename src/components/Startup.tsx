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
        <span className="startup-brand">qmux</span>
        <div role={failure ? "alert" : "status"} aria-live="polite">
          <h1>{progress.quitting ? "Closing qmux…" : failure ? "Couldn’t restore your session" : "Restoring your session…"}</h1>
          <p>{failure ?? (progress.quitting
            ? "Your saved session will be kept for the next launch."
            : progress.phase === "panes"
              ? `Restoring terminals (${progress.completed} of ${progress.total})`
              : progress.phase === "ready" ? "Preparing your workspace…" : "Loading your saved workspace…")}</p>
        </div>
        {!failure && !progress.quitting && <progress
          className="startup-progress"
          aria-label="Session restoration"
          max={progress.phase === "panes" && progress.total > 0 ? progress.total : undefined}
          value={progress.phase === "panes" && progress.total > 0 ? progress.completed : undefined}
        />}
        <Button disabled={progress.quitting} onClick={() => {
          void invoke("startup_quit").catch((err: unknown) => setError(String(err)));
        }}>Quit qmux</Button>
      </div>
    </main>}
  </>;
}
