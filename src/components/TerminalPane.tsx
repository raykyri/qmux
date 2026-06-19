import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { listenToEvents, resizePane, writePane } from "../lib/api";
import type { PaneInfo } from "../types";

interface TerminalPaneProps {
  pane: PaneInfo;
  active: boolean;
}

export interface TerminalPaneHandle {
  focus: () => void;
}

function terminalDataFromPayload(data: unknown): string | Uint8Array | null {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  if (
    Array.isArray(data) &&
    data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return Uint8Array.from(data);
  }

  return null;
}

const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  { pane, active },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const stabilizeTerminalRef = useRef<(() => void) | null>(null);

  useImperativeHandle(ref, () => ({
    focus() {
      terminalRef.current?.focus();
      stabilizeTerminalRef.current?.();
    },
  }));

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cols: pane.cols,
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      fontSize: 13,
      rows: pane.rows,
      theme: {
        background: "#111315",
        foreground: "#e7e7e2",
        cursor: "#f2d37b",
        selectionBackground: "#3d4a52",
      },
    });

    const fit = new FitAddon();
    const unicode = new Unicode11Addon();
    const serialize = new SerializeAddon();

    terminal.loadAddon(fit);
    terminal.loadAddon(unicode);
    terminal.loadAddon(serialize);
    terminal.unicode.activeVersion = "11";

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // The canvas renderer is fine as a fallback, especially in CI and older webviews.
    }

    terminal.open(hostRef.current);
    terminal.focus();

    let resizeFrame: number | null = null;
    let settleFrame: number | null = null;
    const settleTimers = new Set<number>();
    let disposed = false;

    let syncedCols = pane.cols;
    let syncedRows = pane.rows;
    const refreshTerminal = () => {
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    };
    const fitAndSyncSize = () => {
      fit.fit();
      if (terminal.cols !== syncedCols || terminal.rows !== syncedRows) {
        syncedCols = terminal.cols;
        syncedRows = terminal.rows;
        void resizePane(pane.id, terminal.cols, terminal.rows);
      }
      refreshTerminal();
    };
    const scheduleFit = () => {
      if (disposed) {
        return;
      }
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitAndSyncSize();
      });
    };
    const scheduleSettledFits = () => {
      if (disposed) {
        return;
      }
      scheduleFit();

      if (settleFrame !== null) {
        window.cancelAnimationFrame(settleFrame);
      }
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = null;
        scheduleFit();
      });

      for (const delay of [50, 250]) {
        const timer = window.setTimeout(() => {
          settleTimers.delete(timer);
          scheduleFit();
        }, delay);
        settleTimers.add(timer);
      }
    };

    scheduleSettledFits();
    void document.fonts.ready.then(() => {
      scheduleSettledFits();
    });

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(hostRef.current);

    const inputDisposable = terminal.onData((data) => {
      void writePane(pane.id, data);
    });

    terminalRef.current = terminal;
    serializeRef.current = serialize;
    stabilizeTerminalRef.current = scheduleSettledFits;

    return () => {
      disposed = true;
      inputDisposable.dispose();
      resizeObserver.disconnect();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (settleFrame !== null) {
        window.cancelAnimationFrame(settleFrame);
      }
      for (const timer of settleTimers) {
        window.clearTimeout(timer);
      }
      terminal.dispose();
      terminalRef.current = null;
      serializeRef.current = null;
      stabilizeTerminalRef.current = null;
    };
  }, [pane.id]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenToEvents((event) => {
      if (disposed || event.type !== "pty.data" || event.paneId !== pane.id) {
        return;
      }

      const data = terminalDataFromPayload(event.payload.data);
      if (data) {
        terminalRef.current?.write(data);
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
  }, [pane.id]);

  useEffect(() => {
    if (active) {
      terminalRef.current?.focus();
      stabilizeTerminalRef.current?.();
    }
  }, [active, pane.id]);

  return (
    <div className={`terminal-pane ${active ? "is-active" : ""}`} aria-hidden={!active}>
      <div ref={hostRef} className="terminal-host" />
    </div>
  );
});

export default TerminalPane;
