import { Terminal } from "ghostty-web";
import type { ITheme } from "ghostty-web";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { listenToEvents, resizePane, writePane } from "../lib/api";
import { ensureGhosttyReady } from "../lib/ghostty";
import {
  loadTerminalFont,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from "../lib/terminalFont";
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

type SearchMatch = { row: number; col: number; length: number };

// Cap how many matches we track so a pathological search (e.g. "." as a regex)
// over a long scrollback cannot lock up the UI building a huge array.
const MAX_SEARCH_MATCHES = 5000;

const TERMINAL_THEME: ITheme = {
  background: "#111315",
  foreground: "#e7e7e2",
  cursor: "#f2d37b",
  cursorAccent: "#111315",
  selectionBackground: "#3d4a52",
  selectionForeground: "#f4f4ef",

  // ghostty-web passes unspecified palette entries to the WASM parser as black,
  // and its canvas renderer treats RGB 0/0/0 backgrounds as transparent. Keep
  // the palette explicit so ANSI-backed CLI tints render instead of disappearing.
  black: "#1b1f21",
  red: "#e0796d",
  green: "#6cae9d",
  yellow: "#d8b878",
  blue: "#6aa4d8",
  magenta: "#c586c0",
  cyan: "#63b3c2",
  white: "#d7d7d2",
  brightBlack: "#7f8884",
  brightRed: "#ef8a80",
  brightGreen: "#7bc8b2",
  brightYellow: "#f0c97a",
  brightBlue: "#8ab5e1",
  brightMagenta: "#d7a0d3",
  brightCyan: "#83ced9",
  brightWhite: "#f4f4ef",
};

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

// ghostty-web has no SearchAddon, so we implement find over its public buffer
// API. We scan every line of the active buffer (scrollback + screen) and record
// each hit as an absolute (row, col, length). The active match is highlighted
// with the terminal's own selection; unlike xterm's SearchAddon we cannot paint
// every match at once (ghostty has a single selection, no decoration layer).
function computeSearchMatches(
  terminal: Terminal,
  term: string,
  useRegex: boolean,
  caseSensitive: boolean,
): SearchMatch[] {
  if (!term) {
    return [];
  }

  const buffer = terminal.buffer.active;
  const matches: SearchMatch[] = [];

  let findInLine: (text: string) => Array<{ col: number; length: number }>;
  if (useRegex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(term, caseSensitive ? "g" : "gi");
    } catch {
      // Incomplete/invalid regex while the user is still typing: no matches.
      return [];
    }
    findInLine = (text) => {
      const hits: Array<{ col: number; length: number }> = [];
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        if (match[0].length === 0) {
          // Avoid an infinite loop on zero-width matches (e.g. "a*").
          pattern.lastIndex += 1;
          continue;
        }
        hits.push({ col: match.index, length: match[0].length });
      }
      return hits;
    };
  } else {
    const needle = caseSensitive ? term : term.toLowerCase();
    findInLine = (text) => {
      const hits: Array<{ col: number; length: number }> = [];
      const haystack = caseSensitive ? text : text.toLowerCase();
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        hits.push({ col: index, length: term.length });
        index = haystack.indexOf(needle, index + needle.length);
      }
      return hits;
    };
  }

  const lineCount = buffer.length;
  for (let row = 0; row < lineCount; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }
    const text = line.translateToString(true);
    if (!text) {
      continue;
    }
    for (const hit of findInLine(text)) {
      matches.push({ row, col: hit.col, length: hit.length });
      if (matches.length >= MAX_SEARCH_MATCHES) {
        return matches;
      }
    }
  }

  return matches;
}

function highlightSearchMatch(terminal: Terminal, match: SearchMatch) {
  try {
    terminal.select(match.col, match.row, match.length);
    // scrollToLine takes an absolute buffer line (0 = top of scrollback). Pulling
    // the match a little below the top leaves a line of context above it.
    if (typeof terminal.scrollToLine === "function") {
      terminal.scrollToLine(Math.max(0, match.row - 1));
    }
  } catch {
    // Selection/scroll APIs are best-effort; never let find crash the pane.
  }
}

// ghostty-web has no public refresh(); its CanvasRenderer repaints inside its own
// requestAnimationFrame loop. To force a frame (see the keep-alive below) we drive
// the renderer directly with the same arguments the internal loop uses. These
// fields are public on the Terminal instance but the call shape is internal, so
// it is wrapped defensively.
interface GhosttyRenderInternals {
  renderer?: {
    render: (
      buffer: unknown,
      forceAll: boolean,
      viewportY: number,
      scrollbackProvider: unknown,
      scrollbarOpacity: number,
    ) => void;
    // Measured cell box, e.g. { width, height, baseline }. Used to size the grid
    // ourselves (see fitTerminalToMount).
    getMetrics?: () => { width: number; height: number };
  };
  wasmTerm?: unknown;
  viewportY?: number;
  scrollbarOpacity?: number;
}

// ghostty-web's bundled FitAddon always carves a fixed 15px off the width for a
// scrollbar (its internal `gA` constant), even though ghostty paints its
// scrollbar as a fading overlay *inside* the canvas (and only while scrolling).
// That reservation is permanent dead space pinned to the right edge — and since
// the terminal-stage shares the canvas's background color, it just reads as a
// terminal that won't fill the pane. So we skip the FitAddon and size the grid
// ourselves from the mount's content box and the renderer's measured cell box.
function fitTerminalToMount(terminal: Terminal, mountEl: HTMLElement) {
  const width = mountEl.clientWidth;
  const height = mountEl.clientHeight;
  if (width === 0 || height === 0) {
    return;
  }
  const metrics = (terminal as unknown as GhosttyRenderInternals).renderer?.getMetrics?.();
  if (!metrics || !metrics.width || !metrics.height) {
    return;
  }
  // Match the FitAddon's floors (2 cols / 1 row) so a momentarily tiny mount
  // never proposes a zero-sized grid.
  const cols = Math.max(2, Math.floor(width / metrics.width));
  const rows = Math.max(1, Math.floor(height / metrics.height));
  if (cols !== terminal.cols || rows !== terminal.rows) {
    terminal.resize(cols, rows);
  }
}

function forceRender(terminal: Terminal) {
  const internals = terminal as unknown as GhosttyRenderInternals;
  if (!internals.renderer || !internals.wasmTerm) {
    return;
  }
  try {
    internals.renderer.render(
      internals.wasmTerm,
      true,
      internals.viewportY ?? 0,
      terminal,
      internals.scrollbarOpacity ?? 0,
    );
  } catch {
    // Renderer internals shifted between library versions; keep-alive is optional.
  }
}

// ghostty-web snaps the viewport to the bottom on every write while you are
// scrolled up (its writeInternal runs `viewportY !== 0 && scrollToBottom()`), so
// streaming PTY output yanks you out of the scrollback. We instead keep the same
// content anchored: viewportY counts lines up from the live bottom, so when a
// write pushes N lines into the scrollback we add N back to where we were. At the
// live bottom (viewportY === 0) we leave it alone so auto-follow still works.
function writePreservingScroll(terminal: Terminal, data: string | Uint8Array) {
  const previousViewportY = terminal.getViewportY();
  if (previousViewportY === 0) {
    terminal.write(data);
    return;
  }
  const before = terminal.getScrollbackLength();
  terminal.write(data);
  const after = terminal.getScrollbackLength();
  // `after - before` undercounts only once the scrollback hits its cap (lines
  // then evict from the top instead of growing the length), so parking while
  // >10k lines stream past drifts slowly — an acceptable edge for a rare case.
  const added = Math.max(0, after - before);
  // Re-anchor by writing the field directly: scrollToLine() would also pulse the
  // scrollbar visible on every chunk, keeping it lit for the whole stream.
  (terminal as unknown as { viewportY: number }).viewportY = Math.min(
    after,
    previousViewportY + added,
  );
}

const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  { pane, active },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // ghostty opens into this inner mount (it appends a <canvas> and a hidden
  // <textarea> for input/IME). The mount fills the host's content box with no
  // padding of its own; the visual breathing room lives as padding on the host.
  // Keeping it off the element we measure means rows/cols are computed from the
  // true drawable area, so the first/last rows are not pushed out and clipped.
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalReadyRef = useRef(false);
  // PTY output can arrive before the (async) terminal finishes initializing. We
  // buffer it here and flush once the terminal is open so nothing is dropped.
  const pendingDataRef = useRef<Array<string | Uint8Array>>([]);
  const searchMatchesRef = useRef<SearchMatch[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const stabilizeTerminalRef = useRef<(() => void) | null>(null);
  const requestRedrawRef = useRef<(() => void) | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });

  useImperativeHandle(ref, () => ({
    focus() {
      terminalRef.current?.focus();
      stabilizeTerminalRef.current?.();
    },
  }));

  const showMatch = (index: number) => {
    const terminal = terminalRef.current;
    const matches = searchMatchesRef.current;
    if (!terminal) {
      return;
    }
    if (!matches.length || index < 0) {
      terminal.clearSelection();
      setSearchResults({ index: -1, count: matches.length });
      return;
    }
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    highlightSearchMatch(terminal, matches[wrapped]);
    setSearchResults({ index: wrapped, count: matches.length });
  };

  const findNext = () => {
    if (searchMatchesRef.current.length) {
      showMatch(searchResults.index + 1);
    }
  };

  const findPrevious = () => {
    if (searchMatchesRef.current.length) {
      showMatch(searchResults.index - 1);
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
  // We default the active match to the most recent (bottom-most) hit, which keeps
  // the viewport near the live output; ↑ walks back through earlier matches.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !searchOpen) {
      return;
    }
    if (searchTerm === "") {
      searchMatchesRef.current = [];
      terminal.clearSelection();
      setSearchResults({ index: -1, count: 0 });
      return;
    }
    const matches = computeSearchMatches(terminal, searchTerm, useRegex, caseSensitive);
    searchMatchesRef.current = matches;
    if (!matches.length) {
      terminal.clearSelection();
      setSearchResults({ index: -1, count: 0 });
      return;
    }
    showMatch(matches.length - 1);
    // showMatch is intentionally excluded; it reads only refs/state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, searchOpen, useRegex, caseSensitive]);

  // Opening the bar focuses its input; closing it clears the highlight and returns
  // focus to the terminal so typing keeps flowing to the PTY.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    } else {
      searchMatchesRef.current = [];
      terminalRef.current?.clearSelection();
      terminalRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    const mount = mountRef.current;
    const host = hostRef.current;
    if (!mount || !host || terminalRef.current) {
      return;
    }

    let cancelled = false;
    let teardown: (() => void) | null = null;

    void Promise.all([ensureGhosttyReady(), loadTerminalFont()])
      .then(() => {
        if (cancelled || !mountRef.current) {
          return;
        }
        teardown = setUpTerminal(mount, host);
        if (cancelled) {
          teardown();
          teardown = null;
        }
      })
      .catch((error) => {
        console.error("Failed to initialize ghostty terminal", error);
      });

    function setUpTerminal(mountEl: HTMLDivElement, hostEl: HTMLDivElement): () => void {
      const terminal = new Terminal({
        convertEol: false,
        cols: pane.cols,
        rows: pane.rows,
        cursorBlink: false,
        scrollback: 10000,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        theme: TERMINAL_THEME,
      });

      // ⌘F (macOS) / Ctrl-F (elsewhere) opens the find bar over the scrollback.
      // ghostty's custom key handler is inverted from xterm's: returning true calls
      // preventDefault() and stops the key from reaching the PTY, returning false
      // lets ghostty handle it normally (so ⌘C/⌘V copy & paste keep working).
      terminal.attachCustomKeyEventHandler((event) => {
        const findCombo = IS_MAC
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
        if (findCombo && !event.altKey && (event.key === "f" || event.key === "F")) {
          setSearchOpen(true);
          window.requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          });
          return true;
        }
        return false;
      });

      terminal.open(mountEl);
      terminal.focus();

      // Flush any PTY output that arrived while the WASM engine was still loading.
      terminalRef.current = terminal;
      terminalReadyRef.current = true;
      let redrawFrame: number | null = null;
      const scheduleForcedRedraw = () => {
        if (cancelled || redrawFrame !== null) {
          return;
        }
        redrawFrame = window.requestAnimationFrame(() => {
          redrawFrame = null;
          forceRender(terminal);
        });
      };
      requestRedrawRef.current = scheduleForcedRedraw;

      const pending = pendingDataRef.current;
      pendingDataRef.current = [];
      for (const chunk of pending) {
        writePreservingScroll(terminal, chunk);
        scheduleForcedRedraw();
      }

      let resizeFrame: number | null = null;
      let settleFrame: number | null = null;
      const settleTimers = new Set<number>();

      let syncedCols = pane.cols;
      let syncedRows = pane.rows;
      const fitAndSyncSize = () => {
        if (
          hostEl.offsetParent === null ||
          hostEl.clientWidth === 0 ||
          hostEl.clientHeight === 0
        ) {
          // The pane is hidden (display: none). Measuring it would propose a bogus
          // tiny size and reflow the scrollback (and the PTY) down to it.
          return;
        }
        fitTerminalToMount(terminal, mountEl);
        if (terminal.cols !== syncedCols || terminal.rows !== syncedRows) {
          syncedCols = terminal.cols;
          syncedRows = terminal.rows;
          void resizePane(pane.id, terminal.cols, terminal.rows);
        }
        forceRender(terminal);
      };
      const scheduleFit = () => {
        if (cancelled) {
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
        if (cancelled) {
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
      resizeObserver.observe(hostEl);

      const inputDisposable = terminal.onData((data) => {
        void writePane(pane.id, data);
      });

      stabilizeTerminalRef.current = scheduleSettledFits;

      // ghostty paints inside requestAnimationFrame, which the OS/webview throttles
      // or pauses while the qmux window is unfocused or hidden. PTY data (e.g.
      // Claude's elapsed-time spinner) keeps arriving, but the canvas stops
      // repainting, so the on-screen timer looks frozen. While the window is not
      // focused, drive the renderer on an interval so timers keep updating, and
      // force a catch-up repaint the moment focus/visibility returns.
      let keepAliveTimer: number | null = null;
      const stopRenderKeepAlive = () => {
        if (keepAliveTimer !== null) {
          window.clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
      };
      const syncRenderKeepAlive = () => {
        if (document.hasFocus() && !document.hidden) {
          stopRenderKeepAlive();
          forceRender(terminal);
        } else if (keepAliveTimer === null) {
          keepAliveTimer = window.setInterval(() => forceRender(terminal), 250);
        }
      };
      window.addEventListener("focus", syncRenderKeepAlive);
      window.addEventListener("blur", syncRenderKeepAlive);
      document.addEventListener("visibilitychange", syncRenderKeepAlive);
      syncRenderKeepAlive();

      return () => {
        inputDisposable.dispose();
        resizeObserver.disconnect();
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
        }
        if (settleFrame !== null) {
          window.cancelAnimationFrame(settleFrame);
        }
        if (redrawFrame !== null) {
          window.cancelAnimationFrame(redrawFrame);
        }
        for (const timer of settleTimers) {
          window.clearTimeout(timer);
        }
        window.removeEventListener("focus", syncRenderKeepAlive);
        window.removeEventListener("blur", syncRenderKeepAlive);
        document.removeEventListener("visibilitychange", syncRenderKeepAlive);
        stopRenderKeepAlive();
        terminal.dispose();
        terminalReadyRef.current = false;
        terminalRef.current = null;
        stabilizeTerminalRef.current = null;
        if (requestRedrawRef.current === scheduleForcedRedraw) {
          requestRedrawRef.current = null;
        }
        searchMatchesRef.current = [];
      };
    }

    return () => {
      cancelled = true;
      teardown?.();
      teardown = null;
      // If output is still buffered because the terminal never finished opening,
      // drop it; a fresh terminal will be created for the next pane.id.
      pendingDataRef.current = [];
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
      if (!data) {
        return;
      }
      const terminal = terminalRef.current;
      if (terminal && terminalReadyRef.current) {
        writePreservingScroll(terminal, data);
        requestRedrawRef.current?.();
      } else {
        pendingDataRef.current.push(data);
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
