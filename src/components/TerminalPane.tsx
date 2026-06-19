import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchOptions } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { listenToEvents, resizePane, writePane } from "../lib/api";
import type { PaneInfo } from "../types";

interface TerminalPaneProps {
  pane: PaneInfo;
  active: boolean;
}

export interface TerminalPaneHandle {
  focus: () => void;
}

// On macOS the find shortcut is ⌘F; on other platforms it is Ctrl-F. (Ctrl-F is
// readline's forward-char, so on the Mac we leave it for the terminal.)
const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

// Colors for the search match highlights, tuned to read against the terminal's
// dark background while echoing the cursor's amber. The overview-ruler colors are
// required by the addon's types even though we do not render a ruler.
const SEARCH_DECORATIONS = {
  matchBackground: "#665a2b",
  matchBorder: "#8a7a3a",
  matchOverviewRuler: "#8a7a3a",
  activeMatchBackground: "#a8842f",
  activeMatchBorder: "#f2d37b",
  activeMatchColorOverviewRuler: "#f2d37b",
} as const;

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
  // xterm opens into this inner mount, which fills the host's content box with no
  // padding of its own. The visual breathing room lives as padding on the host;
  // keeping it off the element FitAddon measures means rows/cols are computed from
  // the true drawable area, so the first/last rows are not pushed out and clipped.
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const stabilizeTerminalRef = useRef<(() => void) | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });

  const searchOptions = useMemo<ISearchOptions>(
    () => ({
      regex: useRegex,
      caseSensitive,
      decorations: { ...SEARCH_DECORATIONS },
    }),
    [useRegex, caseSensitive],
  );

  useImperativeHandle(ref, () => ({
    focus() {
      terminalRef.current?.focus();
      stabilizeTerminalRef.current?.();
    },
  }));

  const findNext = () => {
    if (searchTerm) {
      searchRef.current?.findNext(searchTerm, searchOptions);
    }
  };

  const findPrevious = () => {
    if (searchTerm) {
      searchRef.current?.findPrevious(searchTerm, searchOptions);
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  };

  // Re-run the search whenever the term or options change while the bar is open.
  // `incremental` keeps the current match selected as the term grows, so typing
  // does not jump the viewport around. Clearing the term wipes the highlights.
  useEffect(() => {
    const addon = searchRef.current;
    if (!addon || !searchOpen) {
      return;
    }
    if (searchTerm === "") {
      addon.clearDecorations();
      setSearchResults({ index: -1, count: 0 });
      return;
    }
    addon.findNext(searchTerm, { ...searchOptions, incremental: true });
  }, [searchTerm, searchOpen, searchOptions]);

  // Opening the bar focuses its input; closing it clears highlights and returns
  // focus to the terminal so typing keeps flowing to the PTY.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    } else {
      searchRef.current?.clearDecorations();
      terminalRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!hostRef.current || !mount || terminalRef.current) {
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
    const search = new SearchAddon();

    terminal.loadAddon(fit);
    terminal.loadAddon(unicode);
    terminal.loadAddon(serialize);
    terminal.loadAddon(search);
    terminal.unicode.activeVersion = "11";

    const resultsDisposable = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchResults({ index: resultIndex, count: resultCount });
    });

    // ⌘F (macOS) / Ctrl-F (elsewhere) opens the find bar over the scrollback.
    // Returning false stops xterm from forwarding the keystroke to the PTY.
    terminal.attachCustomKeyEventHandler((event) => {
      const findCombo = IS_MAC
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        event.type === "keydown" &&
        findCombo &&
        !event.altKey &&
        (event.key === "f" || event.key === "F")
      ) {
        event.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return false;
      }
      return true;
    });

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // The canvas renderer is fine as a fallback, especially in CI and older webviews.
    }

    terminal.open(mount);
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
      const host = hostRef.current;
      if (!host || host.offsetParent === null || host.clientWidth === 0 || host.clientHeight === 0) {
        // The pane is hidden (display: none). FitAddon measures the host via
        // getComputedStyle, which returns the computed "100%" width for an
        // unrendered element; parseInt("100%") = 100, so it proposes ~10 cols
        // and reflows the scrollback (and the PTY) down to that bogus width.
        return;
      }
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
    searchRef.current = search;
    stabilizeTerminalRef.current = scheduleSettledFits;

    // xterm paints inside requestAnimationFrame, which the OS/webview throttles or
    // pauses while the qmux window is unfocused or hidden. PTY data (e.g. Claude's
    // elapsed-time spinner) keeps arriving, but the canvas stops repainting, so the
    // on-screen timer looks frozen. While the window is not focused, nudge the
    // renderer on an interval so timers keep updating, and force a catch-up repaint
    // the moment focus/visibility returns.
    let keepAliveTimer: number | null = null;
    const forceRefresh = () => {
      if (!disposed && terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    };
    const stopRenderKeepAlive = () => {
      if (keepAliveTimer !== null) {
        window.clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    };
    const syncRenderKeepAlive = () => {
      if (document.hasFocus() && !document.hidden) {
        stopRenderKeepAlive();
        forceRefresh();
      } else if (keepAliveTimer === null) {
        keepAliveTimer = window.setInterval(forceRefresh, 250);
      }
    };
    window.addEventListener("focus", syncRenderKeepAlive);
    window.addEventListener("blur", syncRenderKeepAlive);
    document.addEventListener("visibilitychange", syncRenderKeepAlive);
    syncRenderKeepAlive();

    return () => {
      disposed = true;
      inputDisposable.dispose();
      resultsDisposable.dispose();
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
      window.removeEventListener("focus", syncRenderKeepAlive);
      window.removeEventListener("blur", syncRenderKeepAlive);
      document.removeEventListener("visibilitychange", syncRenderKeepAlive);
      stopRenderKeepAlive();
      terminal.dispose();
      terminalRef.current = null;
      serializeRef.current = null;
      searchRef.current = null;
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

  const matchLabel =
    searchTerm === ""
      ? ""
      : searchResults.count === 0
        ? "No results"
        : `${searchResults.index + 1}/${searchResults.count}`;
  const hasMatches = searchResults.count > 0;

  return (
    <div className={`terminal-pane ${active ? "is-active" : ""}`} aria-hidden={!active}>
      <div ref={hostRef} className="terminal-host">
        <div ref={mountRef} className="terminal-mount" />
      </div>
      {searchOpen ? (
        <div className="terminal-search" role="search">
          <input
            ref={searchInputRef}
            type="text"
            className="terminal-search-input"
            value={searchTerm}
            placeholder="Find in terminal"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Find in terminal"
            onChange={(event) => setSearchTerm(event.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <span className="terminal-search-count">{matchLabel}</span>
          <div className="terminal-search-toggles">
            <button
              type="button"
              className={`terminal-search-toggle ${caseSensitive ? "is-active" : ""}`}
              title="Match case"
              aria-pressed={caseSensitive}
              onClick={() => setCaseSensitive((value) => !value)}
            >
              Aa
            </button>
            <button
              type="button"
              className={`terminal-search-toggle ${useRegex ? "is-active" : ""}`}
              title="Use regular expression"
              aria-pressed={useRegex}
              onClick={() => setUseRegex((value) => !value)}
            >
              .*
            </button>
          </div>
          <div className="terminal-search-nav">
            <button
              type="button"
              className="terminal-search-button"
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
              disabled={!hasMatches}
              onClick={findPrevious}
            >
              ↑
            </button>
            <button
              type="button"
              className="terminal-search-button"
              title="Next match (Enter)"
              aria-label="Next match"
              disabled={!hasMatches}
              onClick={findNext}
            >
              ↓
            </button>
            <button
              type="button"
              className="terminal-search-button"
              title="Close (Esc)"
              aria-label="Close search"
              onClick={closeSearch}
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default TerminalPane;
