import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { listenToEvents, resizePane, writePane } from "../lib/api";
import type { PaneInfo } from "../types";

interface TerminalPaneProps {
  pane: PaneInfo;
  active: boolean;
}

export default function TerminalPane({ pane, active }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      fontSize: 13,
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
    const fitAndSyncSize = () => {
      fit.fit();
      void resizePane(pane.id, terminal.cols, terminal.rows);
    };
    const scheduleFit = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitAndSyncSize();
      });
    };

    scheduleFit();

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(hostRef.current);

    const inputDisposable = terminal.onData((data) => {
      void writePane(pane.id, data);
    });

    terminalRef.current = terminal;
    fitRef.current = fit;
    serializeRef.current = serialize;

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      serializeRef.current = null;
    };
  }, [pane.id]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenToEvents((event) => {
      if (disposed || event.type !== "pty.data" || event.paneId !== pane.id) {
        return;
      }

      const data = typeof event.payload.data === "string" ? event.payload.data : "";
      terminalRef.current?.write(data);
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
      window.requestAnimationFrame(() => {
        fitRef.current?.fit();
        const terminal = terminalRef.current;
        if (terminal) {
          void resizePane(pane.id, terminal.cols, terminal.rows);
        }
      });
    }
  }, [active, pane.id]);

  return (
    <div className={`terminal-pane ${active ? "is-active" : ""}`} aria-hidden={!active}>
      <div ref={hostRef} className="terminal-host" />
    </div>
  );
}
