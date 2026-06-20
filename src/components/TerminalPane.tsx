import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { attachPane, listenToEvents, resizePane, writePane } from "../lib/api";
import { confirmLargePaste } from "../lib/paste";
import { loadTerminalFont } from "../lib/terminalFont";
import type { PaneInfo } from "../types";

interface TerminalPaneProps {
  pane: PaneInfo;
  active: boolean;
  fontSize: number;
  fontFamily: string;
}

export interface TerminalPaneHandle {
  focus: () => void;
}

// On macOS the find shortcut is Cmd-F; on other platforms it is Ctrl-F. (Ctrl-F
// is readline's forward-char, so on the Mac we leave it for the terminal.)
const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

// Prefix for the terminal renderer/font diagnostics. These trace the WebGL
// lifecycle and font changes so an app-blanking report can be pinned to a
// context loss, a renderer fallback, or a specific font switch.
const LOG_PREFIX = "[qmux:terminal]";

// Colors for search highlights, tuned to read against the terminal background.
// The overview-ruler colors are required by the addon's types even though qmux
// does not render a ruler.
const SEARCH_DECORATIONS = {
  matchBackground: "#665a2b",
  matchBorder: "#8a7a3a",
  matchOverviewRuler: "#8a7a3a",
  activeMatchBackground: "#a8842f",
  activeMatchBorder: "#f2d37b",
  activeMatchColorOverviewRuler: "#f2d37b",
} as const;

const TERMINAL_THEME: ITheme = {
  background: "#111315",
  foreground: "#e7e7e2",
  cursor: "#f2d37b",
  cursorAccent: "#111315",
  selectionBackground: "#3d4a52",
  selectionForeground: "#f4f4ef",
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

const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  { pane, active, fontSize, fontFamily },
  ref,
) {
  // The setup effect runs once (keyed on pane.id) and closes over its render's
  // font settings; read the latest values through refs so a terminal created
  // while the user has changed the font/size opens with the current choice.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fontFamilyRef = useRef(fontFamily);
  fontFamilyRef.current = fontFamily;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // xterm opens into this inner mount, which fills the host's content box with no
  // padding of its own. The visual breathing room lives as padding on the host;
  // keeping it off the element FitAddon measures means rows/cols are computed from
  // the true drawable area, so the first/last rows are not pushed out and clipped.
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Kept so font changes can clear the WebGL glyph atlas (see the font effect),
  // and so a lost context can dispose the addon and fall back to the DOM renderer.
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const terminalReadyRef = useRef(false);
  // PTY output can arrive while the terminal waits for the bundled font to load.
  // Buffer it and flush once xterm is open so startup output is not dropped.
  const pendingDataRef = useRef<Array<string | Uint8Array>>([]);
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

  // Loads a fresh WebGL renderer onto the terminal. Kept as a single helper so
  // the initial setup and the font-change path build it identically (same
  // context-loss handling). The canvas renderer is a fine fallback if WebGL is
  // unavailable, so any failure is swallowed.
  const attachWebglAddon = useCallback(
    (terminal: Terminal) => {
      try {
        const webgl = new WebglAddon();
        // macOS WKWebView can drop the GL context (e.g. while rebuilding the glyph
        // atlas for a new font). xterm leaves a blank/gray canvas behind, which —
        // because the window is translucent — reads as the app going see-through.
        // Dispose the addon to fall back to the DOM renderer, then force a repaint
        // since the fallback won't redraw on its own.
        webgl.onContextLoss(() => {
          console.warn(`${LOG_PREFIX} WebGL context lost; falling back to DOM renderer`, {
            paneId: pane.id,
          });
          webgl.dispose();
          if (webglAddonRef.current === webgl) {
            webglAddonRef.current = null;
          }
          stabilizeTerminalRef.current?.();
        });
        terminal.loadAddon(webgl);
        webglAddonRef.current = webgl;
        console.info(`${LOG_PREFIX} WebGL renderer attached`, { paneId: pane.id });
      } catch (err) {
        webglAddonRef.current = null;
        console.warn(`${LOG_PREFIX} WebGL renderer unavailable; using DOM renderer`, {
          paneId: pane.id,
          error: err,
        });
      }
    },
    [pane.id],
  );

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
    const host = hostRef.current;
    if (!mount || !host || terminalRef.current) {
      return;
    }

    let cancelled = false;
    let teardown: (() => void) | null = null;

    void loadTerminalFont()
      .catch(() => undefined)
      .then(() => {
        if (cancelled || !mountRef.current) {
          return;
        }
        teardown = setUpTerminal(mount, host);
        if (cancelled) {
          teardown();
          teardown = null;
        }
      });

    function setUpTerminal(mountEl: HTMLDivElement, hostEl: HTMLDivElement): () => void {
      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cols: pane.cols,
        cursorBlink: false,
        fontFamily: fontFamilyRef.current,
        fontSize: fontSizeRef.current,
        rows: pane.rows,
        scrollback: 10000,
        theme: TERMINAL_THEME,
      });

      const fit = new FitAddon();
      const unicode = new Unicode11Addon();
      const search = new SearchAddon();

      terminal.loadAddon(fit);
      terminal.loadAddon(unicode);
      terminal.loadAddon(search);
      terminal.unicode.activeVersion = "11";

      const resultsDisposable = search.onDidChangeResults(({ resultIndex, resultCount }) => {
        setSearchResults({ index: resultIndex, count: resultCount });
      });

      // Cmd-F (macOS) / Ctrl-F (elsewhere) opens the find bar over the scrollback.
      // Returning false stops xterm from forwarding the keystroke to the PTY.
      terminal.attachCustomKeyEventHandler((event) => {
        const findCombo = IS_MAC
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
        if (
          event.type === "keydown" &&
          IS_MAC &&
          event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          (event.key === "k" || event.key === "K")
        ) {
          event.preventDefault();
          terminal.clear();
          return false;
        }
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

      attachWebglAddon(terminal);

      terminal.open(mountEl);
      terminal.focus();

      terminalRef.current = terminal;
      terminalReadyRef.current = true;
      searchRef.current = search;

      const pending = pendingDataRef.current;
      pendingDataRef.current = [];
      for (const chunk of pending) {
        terminal.write(chunk);
      }

      let resizeFrame: number | null = null;
      let settleFrame: number | null = null;
      const settleTimers = new Set<number>();

      let syncedCols = pane.cols;
      let syncedRows = pane.rows;
      const refreshTerminal = () => {
        if (terminal.rows > 0) {
          terminal.refresh(0, terminal.rows - 1);
        }
      };
      const fitAndSyncSize = () => {
        if (
          hostEl.offsetParent === null ||
          hostEl.clientWidth === 0 ||
          hostEl.clientHeight === 0
        ) {
          // The pane is hidden (display: none). FitAddon measures the host via
          // getComputedStyle, which returns the computed "100%" width for an
          // unrendered element; parseInt("100%") = 100, so it proposes a bogus
          // tiny grid and reflows the scrollback (and the PTY) down to it.
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

      // xterm paints inside requestAnimationFrame, which the OS/webview throttles
      // or pauses while the qmux window is unfocused or hidden. PTY data (e.g.
      // an elapsed-time spinner) keeps arriving, but the canvas can stop
      // repainting, so the on-screen timer looks frozen. While the window is not
      // focused, nudge the renderer on an interval and force a catch-up repaint
      // the moment focus/visibility returns.
      let keepAliveTimer: number | null = null;
      const forceRefresh = () => {
        if (!cancelled && terminal.rows > 0) {
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

      // Guard accidental giant pastes into the PTY. xterm reads the clipboard from
      // its own textarea during the event's bubble phase, so a preventDefault is
      // not enough — it pastes programmatically. We intercept one level up in the
      // capture phase instead: declining stops the event before it descends to
      // xterm, which never sees the paste.
      const handlePaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text") ?? "";
        if (text && !confirmLargePaste(text)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      hostEl.addEventListener("paste", handlePaste, true);

      return () => {
        hostEl.removeEventListener("paste", handlePaste, true);
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
        webglAddonRef.current = null;
        terminalReadyRef.current = false;
        terminalRef.current = null;
        searchRef.current = null;
        stabilizeTerminalRef.current = null;
      };
    }

    return () => {
      cancelled = true;
      teardown?.();
      teardown = null;
      pendingDataRef.current = [];
    };
  }, [pane.id, attachWebglAddon]);

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
        terminal.write(data);
      } else {
        pendingDataRef.current.push(data);
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
        // The listener is live now, so it is safe to release the backend's
        // pre-attach buffer: any output produced before this point is flushed
        // through the listener (into pendingDataRef until the terminal opens),
        // and everything after streams live.
        void attachPane(pane.id).catch(() => undefined);
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

  // Apply live font changes (settings panel / Cmd-+/Cmd--) to an already-open
  // terminal, then re-fit so rows/cols and the PTY size track the new cell
  // metrics. On first mount the terminal may not exist yet (it opens after the
  // font loads); the constructor already used the current values, so the no-op
  // here is fine.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const previousFontFamily = terminal.options.fontFamily;
    const previousFontSize = terminal.options.fontSize;
    let changed = false;
    if (terminal.options.fontSize !== fontSize) {
      terminal.options.fontSize = fontSize;
      changed = true;
    }
    if (terminal.options.fontFamily !== fontFamily) {
      terminal.options.fontFamily = fontFamily;
      changed = true;
    }
    if (changed) {
      const recreatedWebgl = webglAddonRef.current !== null;
      console.info(`${LOG_PREFIX} applying font change`, {
        paneId: pane.id,
        from: { fontFamily: previousFontFamily, fontSize: previousFontSize },
        to: { fontFamily, fontSize },
        recreatedWebgl,
      });
      // The WebGL renderer's glyph atlas and GL state are keyed to the previous
      // font metrics. Clearing the atlas in place is not enough on macOS
      // WKWebView — it can blank the canvas to a translucent gray — so tear the
      // renderer down and load a fresh one, which reinitializes cleanly for the
      // new font. A missing addon (WebGL unavailable) just skips to the re-fit.
      if (webglAddonRef.current) {
        webglAddonRef.current.dispose();
        webglAddonRef.current = null;
        attachWebglAddon(terminal);
      }
      stabilizeTerminalRef.current?.();
    }
  }, [fontSize, fontFamily, attachWebglAddon, pane.id]);

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
