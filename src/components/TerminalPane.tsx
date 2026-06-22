import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { ILink, ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getPaneScrollback, pastePaneInput, resizePane, writePane } from "../lib/api";
import { inspectPaste } from "../lib/paste";
import { useConfirm } from "../hooks/useConfirm";
import { loadTerminalFont } from "../lib/terminalFont";
import type { PaneInfo } from "../types";
import type { SelectionAnchor } from "../appTypes";
import { bytesFromBase64 } from "../lib/appHelpers";
import {
  RESTORED_SCROLLBACK_TERMINAL_RESET,
  sanitizeRestoredScrollback,
} from "../lib/terminalScrollback";

interface TerminalPaneProps {
  pane: PaneInfo;
  active: boolean;
  fontSize: number;
  fontFamily: string;
  /** Extra inter-character spacing in px, passed to xterm's `letterSpacing`. */
  letterSpacing: number;
  /** When true (e.g. the settings panel is open), keystrokes and pastes are
   *  dropped instead of being forwarded to the PTY. */
  inputBlocked: boolean;
  /** Releases this pane's pre-attach output backlog once the app's single event
   *  subscription is live. The app calls attachPane on our behalf so we no longer
   *  each register a listener that filters the whole pty.data stream. */
  requestAttach: (paneId: string) => void;
  /** Called with the owning agent id on each user keystroke into this pane's
   *  terminal, so the app can hold the agent's queue while the user is typing. */
  onUserInput?: (agentId: string) => void;
  /** Primary action for a clicked terminal link (left-click opens it). */
  onOpenLink?: (url: string) => void;
  /** Right-click on a terminal link: open the internal/external chooser. */
  onLinkContextMenu?: (url: string, x: number, y: number) => void;
  /** Called on mouse-up when the user has a non-whitespace selection in this
   *  terminal, with the selected text and its viewport bounding box, so the app
   *  can offer to ask the agent about it. */
  onAskSelection?: (paneId: string, quote: string, anchor: SelectionAnchor) => void;
  /** Called when xterm parses an OSC 0/2 window-title update from PTY output. */
  onTerminalTitleChange?: (paneId: string, title: string) => void;
}

// Matches http(s) URLs in terminal text. Conservative: stops at whitespace and a few
// delimiters so it doesn't swallow surrounding punctuation/markup.
const TERMINAL_URL_REGEX = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;
const OSC_TITLE_MAX_BUFFER_CHARS = 8192;

type TerminalData = string | Uint8Array;

interface PendingTerminalData {
  data: TerminalData;
  titleAlreadyTeed: boolean;
}

function decodeTerminalDataText(decoder: TextDecoder, data: TerminalData) {
  return typeof data === "string" ? data : decoder.decode(data, { stream: true });
}

function capOscTitlePartial(partial: string) {
  return partial.length > OSC_TITLE_MAX_BUFFER_CHARS ? "" : partial;
}

function consumeOscTitleText(buffer: string, emitTitle: (title: string) => void) {
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf("\x1b]", cursor);
    if (start === -1) {
      const lastEscape = buffer.lastIndexOf("\x1b");
      return lastEscape >= cursor && lastEscape >= buffer.length - 1
        ? buffer.slice(lastEscape)
        : "";
    }

    const commandStart = start + 2;
    const separator = buffer.indexOf(";", commandStart);
    if (separator === -1) {
      return capOscTitlePartial(buffer.slice(start));
    }

    const contentStart = separator + 1;
    const bellEnd = buffer.indexOf("\x07", contentStart);
    const stEnd = buffer.indexOf("\x1b\\", contentStart);
    const useBell = bellEnd !== -1 && (stEnd === -1 || bellEnd < stEnd);
    const end = useBell ? bellEnd : stEnd;
    if (end === -1) {
      return capOscTitlePartial(buffer.slice(start));
    }

    const command = buffer.slice(commandStart, separator);
    if (command === "0" || command === "2") {
      emitTitle(buffer.slice(contentStart, end));
    }
    cursor = end + (useBell ? 1 : 2);
  }

  return "";
}

interface LinkHandlers {
  activate: (url: string) => void;
  // Track which link the mouse is over so a right-click can target it.
  hover: (url: string) => void;
  leave: () => void;
}

// Finds clickable links in one terminal line (1-based buffer row `y`). Single-line
// only: a URL wrapped across rows is detected per-row (the common case — a URL on one
// line — works exactly). x/y are 1-based; end.x is inclusive of the last cell.
function findLineLinks(lineText: string, y: number, handlers: LinkHandlers): ILink[] {
  const links: ILink[] = [];
  for (const match of lineText.matchAll(TERMINAL_URL_REGEX)) {
    const start = match.index ?? 0;
    // Drop trailing punctuation that's usually sentence/markup, not part of the URL.
    const url = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    if (url.length === 0) {
      continue;
    }
    links.push({
      text: url,
      range: { start: { x: start + 1, y }, end: { x: start + url.length, y } },
      activate: (_event, text) => handlers.activate(text),
      hover: (_event, text) => handlers.hover(text),
      leave: () => handlers.leave(),
    });
  }
  return links;
}

export interface TerminalPaneHandle {
  focus: () => void;
  // Writes a decoded PTY chunk into this pane, buffering until xterm has opened so
  // cold-start output is never dropped. Called by the app's central event dispatch.
  write: (data: TerminalData) => void;
}

// On macOS the find shortcut is Cmd-F; on other platforms it is Ctrl-F. (Ctrl-F
// is readline's forward-char, so on the Mac we leave it for the terminal.)
const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

// A recovered pane keeps snapping to the bottom while restore output (scrollback
// replay, then the attach backlog, then live PTY writes) is still flowing. The
// window closes once restore writes stay idle this long; each write re-arms it so
// a large backlog that streams in past the timeout still lands at the bottom.
const RESTORE_SCROLL_IDLE_MS = 750;
// Re-snap shortly after each restore write to catch xterm reflow and late layout
// that nudge the viewport after the synchronous scroll.
const RESTORE_SCROLL_CATCHUP_DELAYS_MS = [80, 250];
const INACTIVE_FLUSH_CHUNKS_PER_FRAME = 32;

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

const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  {
    pane,
    active,
    fontSize,
    fontFamily,
    letterSpacing,
    inputBlocked,
    requestAttach,
    onUserInput,
    onOpenLink,
    onLinkContextMenu,
    onAskSelection,
    onTerminalTitleChange,
  },
  ref,
) {
  // The setup effect runs once (keyed on pane.id) and closes over its render's
  // font settings; read the latest values through refs so a terminal created
  // while the user has changed the font/size opens with the current choice.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fontFamilyRef = useRef(fontFamily);
  fontFamilyRef.current = fontFamily;
  const letterSpacingRef = useRef(letterSpacing);
  letterSpacingRef.current = letterSpacing;
  // Read through a ref so the once-per-pane setup effect's input handlers always
  // see the current blocked state without being torn down and rebuilt.
  const inputBlockedRef = useRef(inputBlocked);
  inputBlockedRef.current = inputBlocked;
  // Likewise read the typing-notifier through a ref so the once-per-pane input
  // handler always calls the latest one.
  const onUserInputRef = useRef(onUserInput);
  onUserInputRef.current = onUserInput;
  // Same for the link handlers: the link provider is registered once per pane.
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const onLinkContextMenuRef = useRef(onLinkContextMenu);
  onLinkContextMenuRef.current = onLinkContextMenu;
  const onAskSelectionRef = useRef(onAskSelection);
  onAskSelectionRef.current = onAskSelection;
  const onTerminalTitleChangeRef = useRef(onTerminalTitleChange);
  onTerminalTitleChangeRef.current = onTerminalTitleChange;
  const activeRef = useRef(active);
  activeRef.current = active;
  // The URL the mouse is currently over (set by the link provider's hover/leave), so a
  // right-click can target it for the chooser menu.
  const hoveredLinkRef = useRef<string | null>(null);
  // In-app confirm (window.confirm is a no-op in the webview), reached from the
  // paste handler inside the once-per-pane setup effect via a ref so it stays current.
  const { confirm, dialog: confirmDialog } = useConfirm();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
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
  const terminalReadyWaitersRef = useRef<Array<() => void>>([]);
  // PTY output can arrive while the terminal waits for the bundled font to load.
  // Buffer it and flush once xterm is open so startup output is not dropped.
  const pendingDataRef = useRef<PendingTerminalData[]>([]);
  const inactiveDataBufferRef = useRef<TerminalData[]>([]);
  const flushingInactiveDataRef = useRef(false);
  const inactiveFlushGenerationRef = useRef(0);
  const oscTitleDecoderRef = useRef(new TextDecoder());
  const oscTitleBufferRef = useRef("");
  const scrollbackBytesPromiseRef = useRef<Promise<Uint8Array | null> | null>(null);
  const scrollbackReplayedRef = useRef(false);
  // Captured once at mount: whether this pane was restored after a restart. The
  // `recovered` prop later flips to false when its "Restored" badge is dismissed,
  // but that must not re-run the terminal setup effect (which would dispose and
  // rebuild the pane), so the snap-to-bottom window keys off this stable snapshot.
  const initialRecoveredRef = useRef(pane.recovered);
  const restoreScrollToBottomPendingRef = useRef(false);
  const restoreScrollToBottomFrameRef = useRef<number | null>(null);
  const restoreScrollToBottomTimersRef = useRef<Set<number>>(new Set());
  const restoreScrollToBottomDoneTimerRef = useRef<number | null>(null);
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

  const waitForTerminalReady = useCallback(() => {
    if (terminalRef.current && terminalReadyRef.current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      terminalReadyWaitersRef.current.push(resolve);
    });
  }, []);

  const resolveTerminalReady = useCallback(() => {
    const waiters = terminalReadyWaitersRef.current;
    terminalReadyWaitersRef.current = [];
    for (const resolve of waiters) {
      resolve();
    }
  }, []);

  const clearRestoreScrollToBottomTimers = useCallback(() => {
    if (restoreScrollToBottomFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreScrollToBottomFrameRef.current);
      restoreScrollToBottomFrameRef.current = null;
    }
    for (const timer of restoreScrollToBottomTimersRef.current) {
      window.clearTimeout(timer);
    }
    restoreScrollToBottomTimersRef.current.clear();
    if (restoreScrollToBottomDoneTimerRef.current !== null) {
      window.clearTimeout(restoreScrollToBottomDoneTimerRef.current);
      restoreScrollToBottomDoneTimerRef.current = null;
    }
  }, []);

  const scrollRestoredTerminalToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
  }, []);

  // End the window without a final snap — used when the user scrolls up to read
  // back, so we release control instead of yanking them to the bottom once more.
  const cancelRestoreScrollToBottom = useCallback(() => {
    restoreScrollToBottomPendingRef.current = false;
    clearRestoreScrollToBottomTimers();
  }, [clearRestoreScrollToBottomTimers]);

  const finishRestoreScrollToBottom = useCallback(() => {
    scrollRestoredTerminalToBottom();
    cancelRestoreScrollToBottom();
  }, [cancelRestoreScrollToBottom, scrollRestoredTerminalToBottom]);

  // Close the snap-to-bottom window once restore writes go idle. Re-armed on every
  // restore write, so a backlog that streams in over more than RESTORE_SCROLL_IDLE_MS
  // keeps us pinned to the bottom until the writes actually stop.
  const armRestoreScrollDeadline = useCallback(() => {
    if (restoreScrollToBottomDoneTimerRef.current !== null) {
      window.clearTimeout(restoreScrollToBottomDoneTimerRef.current);
    }
    restoreScrollToBottomDoneTimerRef.current = window.setTimeout(() => {
      restoreScrollToBottomDoneTimerRef.current = null;
      finishRestoreScrollToBottom();
    }, RESTORE_SCROLL_IDLE_MS);
  }, [finishRestoreScrollToBottom]);

  const scheduleRestoreScrollToBottom = useCallback(() => {
    if (!restoreScrollToBottomPendingRef.current) {
      return;
    }
    scrollRestoredTerminalToBottom();
    if (restoreScrollToBottomFrameRef.current === null) {
      restoreScrollToBottomFrameRef.current = window.requestAnimationFrame(() => {
        restoreScrollToBottomFrameRef.current = null;
        scrollRestoredTerminalToBottom();
      });
    }
    for (const timer of restoreScrollToBottomTimersRef.current) {
      window.clearTimeout(timer);
    }
    restoreScrollToBottomTimersRef.current.clear();
    for (const delay of RESTORE_SCROLL_CATCHUP_DELAYS_MS) {
      const timer = window.setTimeout(() => {
        restoreScrollToBottomTimersRef.current.delete(timer);
        scrollRestoredTerminalToBottom();
      }, delay);
      restoreScrollToBottomTimersRef.current.add(timer);
    }
    armRestoreScrollDeadline();
  }, [armRestoreScrollDeadline, scrollRestoredTerminalToBottom]);

  const startRestoreScrollToBottom = useCallback(() => {
    if (!restoreScrollToBottomPendingRef.current) {
      return;
    }
    scheduleRestoreScrollToBottom();
  }, [scheduleRestoreScrollToBottom]);

  const terminalInputDisabled = useCallback(
    () =>
      inputBlockedRef.current ||
      flushingInactiveDataRef.current ||
      inactiveDataBufferRef.current.length > 0,
    [],
  );

  const teeOscTitleChanges = useCallback((data: TerminalData) => {
    const text = decodeTerminalDataText(oscTitleDecoderRef.current, data);
    if (!text) {
      return;
    }
    oscTitleBufferRef.current = consumeOscTitleText(
      oscTitleBufferRef.current + text,
      (title) => onTerminalTitleChangeRef.current?.(pane.id, title),
    );
  }, [pane.id]);

  const bufferInactiveTerminalData = useCallback(
    (data: TerminalData, options?: { titleAlreadyTeed?: boolean }) => {
      if (!options?.titleAlreadyTeed) {
        teeOscTitleChanges(data);
      }
      inactiveDataBufferRef.current.push(data);
    },
    [teeOscTitleChanges],
  );

  const flushInactiveTerminalData = useCallback((onDone?: () => void) => {
    const terminal = terminalRef.current;
    if (
      !terminal ||
      !terminalReadyRef.current ||
      !activeRef.current ||
      flushingInactiveDataRef.current ||
      inactiveDataBufferRef.current.length === 0
    ) {
      return false;
    }

    flushingInactiveDataRef.current = true;
    const generation = (inactiveFlushGenerationRef.current += 1);
    const shouldStickToBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;

    const finish = () => {
      if (generation !== inactiveFlushGenerationRef.current) {
        return;
      }
      flushingInactiveDataRef.current = false;
      if (shouldStickToBottom) {
        terminalRef.current?.scrollToBottom();
      }
      if (terminalRef.current?.rows) {
        terminalRef.current.refresh(0, terminalRef.current.rows - 1);
      }
      onDone?.();
    };

    const writeNext = (chunksWrittenThisFrame = 0) => {
      const currentTerminal = terminalRef.current;
      if (
        generation !== inactiveFlushGenerationRef.current ||
        !currentTerminal ||
        !terminalReadyRef.current ||
        !activeRef.current
      ) {
        flushingInactiveDataRef.current = false;
        return;
      }

      const chunk = inactiveDataBufferRef.current.shift();
      if (chunk === undefined) {
        finish();
        return;
      }

      currentTerminal.write(chunk, () => {
        if (shouldStickToBottom) {
          currentTerminal.scrollToBottom();
        }
        if (inactiveDataBufferRef.current.length === 0) {
          finish();
        } else {
          const nextChunksWrittenThisFrame = chunksWrittenThisFrame + 1;
          if (nextChunksWrittenThisFrame >= INACTIVE_FLUSH_CHUNKS_PER_FRAME) {
            window.requestAnimationFrame(() => writeNext());
          } else {
            writeNext(nextChunksWrittenThisFrame);
          }
        }
      });
    };

    writeNext();
    return true;
  }, []);

  const writeTerminalData = useCallback(
    (data: TerminalData, options?: { titleAlreadyTeed?: boolean }) => {
      const terminal = terminalRef.current;
      if (terminal && terminalReadyRef.current) {
        if (
          !activeRef.current ||
          flushingInactiveDataRef.current ||
          inactiveDataBufferRef.current.length > 0
        ) {
          bufferInactiveTerminalData(data, options);
          return;
        }
        if (restoreScrollToBottomPendingRef.current) {
          terminal.write(data, scheduleRestoreScrollToBottom);
        } else {
          terminal.write(data);
        }
      } else {
        let titleAlreadyTeed = options?.titleAlreadyTeed ?? false;
        if (!activeRef.current) {
          teeOscTitleChanges(data);
          titleAlreadyTeed = true;
        }
        // Output can arrive before the bundled font loads and xterm opens; buffer
        // it and flush once the terminal is ready (see the setup effect).
        pendingDataRef.current.push({ data, titleAlreadyTeed });
      }
    },
    [bufferInactiveTerminalData, scheduleRestoreScrollToBottom, teeOscTitleChanges],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        terminalRef.current?.focus();
        stabilizeTerminalRef.current?.();
      },
      write: writeTerminalData,
    }),
    [writeTerminalData],
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
    clearRestoreScrollToBottomTimers();
    restoreScrollToBottomPendingRef.current = Boolean(initialRecoveredRef.current);

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
        letterSpacing: letterSpacingRef.current,
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
        if (
          event.type === "keydown" &&
          (flushingInactiveDataRef.current || inactiveDataBufferRef.current.length > 0)
        ) {
          event.preventDefault();
          return false;
        }
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

      try {
        const webgl = new WebglAddon();
        // On macOS WKWebView the GPU can drop the WebGL context (e.g. after a
        // font swap rebuilds the glyph atlas). xterm leaves a blank/transparent
        // canvas behind when that happens, which—because the window is
        // translucent—reads as the whole app going see-through. Disposing the
        // addon on context loss falls the terminal back to the DOM renderer
        // instead of stranding it blank.
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (webglAddonRef.current === webgl) {
            webglAddonRef.current = null;
          }
        });
        terminal.loadAddon(webgl);
        webglAddonRef.current = webgl;
      } catch {
        // The canvas renderer is fine as a fallback, especially in CI and older webviews.
      }

      terminal.open(mountEl);
      terminal.focus();

      terminalRef.current = terminal;
      terminalReadyRef.current = true;
      searchRef.current = search;
      resolveTerminalReady();

      const pending = pendingDataRef.current;
      pendingDataRef.current = [];
      for (const chunk of pending) {
        writeTerminalData(chunk.data, { titleAlreadyTeed: chunk.titleAlreadyTeed });
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
        if (terminalInputDisabled()) {
          return;
        }
        // A keystroke into an agent pane's terminal counts as the user typing, so
        // hold that agent's queue from auto-draining mid-input.
        if (pane.agentId) {
          onUserInputRef.current?.(pane.agentId);
        }
        void writePane(pane.id, data);
      });
      const titleDisposable = terminal.onTitleChange((title) => {
        onTerminalTitleChangeRef.current?.(pane.id, title);
      });

      // Make http(s) URLs in the scrollback clickable (hover underlines them).
      const linkProviderDisposable = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const links = findLineLinks(line.translateToString(true), bufferLineNumber, {
            activate: (url) => onOpenLinkRef.current?.(url),
            hover: (url) => {
              hoveredLinkRef.current = url;
            },
            leave: () => {
              hoveredLinkRef.current = null;
            },
          });
          callback(links.length > 0 ? links : undefined);
        },
      });

      // Right-click over a link opens the internal/external chooser instead of the
      // default menu; right-clicks elsewhere are left untouched.
      const handleContextMenu = (event: MouseEvent) => {
        const url = hoveredLinkRef.current;
        if (!url) {
          return;
        }
        event.preventDefault();
        onLinkContextMenuRef.current?.(url, event.clientX, event.clientY);
      };
      hostEl.addEventListener("contextmenu", handleContextMenu, true);

      // Offer an "ask the agent about this" action when the user selects terminal
      // text. Fire on mouse-up (selection finalized) rather than on every
      // intermediate change during a drag.
      const handleSelectionMouseUp = (event: MouseEvent) => {
        const handler = onAskSelectionRef.current;
        const term = terminalRef.current;
        if (!handler || !term || !term.hasSelection()) {
          return;
        }
        const text = term.getSelection();
        if (!text.trim()) {
          return;
        }
        // Prefer the DOM range's rect (DOM renderer); the WebGL renderer paints the
        // selection on a canvas with no DOM range, so fall back to the mouse-up
        // point, which is at the end of the drag.
        const selection = window.getSelection();
        const rect =
          selection && selection.rangeCount > 0 && !selection.isCollapsed
            ? selection.getRangeAt(0).getBoundingClientRect()
            : null;
        const anchor: SelectionAnchor =
          rect && (rect.width > 0 || rect.height > 0)
            ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
            : {
                left: event.clientX,
                right: event.clientX,
                top: event.clientY,
                bottom: event.clientY,
              };
        handler(pane.id, text, anchor);
      };
      hostEl.addEventListener("mouseup", handleSelectionMouseUp, true);

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
        if (terminalInputDisabled()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const text = event.clipboardData?.getData("text") ?? "";
        if (!text) {
          return;
        }
        const verdict = inspectPaste(text);
        if (verdict.action === "accept") {
          // Small paste: let xterm handle it normally.
          return;
        }
        // Large/oversized paste: stop xterm from pasting now (the in-app dialog is
        // async) and handle it ourselves.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (verdict.action === "reject") {
          void confirmRef.current({ message: verdict.message, confirmLabel: "OK" });
          return;
        }
        // Confirmed-large: re-inject to the PTY only if the user accepts, matching
        // xterm's own bracketed-paste framing so the program sees the same input.
        const bracketed = terminal.modes.bracketedPasteMode;
        void confirmRef.current({ message: verdict.message, confirmLabel: "Paste" }).then((ok) => {
          if (ok) {
            void pastePaneInput(pane.id, text, bracketed).catch(() => undefined);
          }
        });
      };
      hostEl.addEventListener("paste", handlePaste, true);

      // While a recovered pane is still snapping to the bottom, an upward wheel
      // gesture means the user wants to read back — hand scroll control to them by
      // ending the restore window instead of yanking the viewport down again.
      const handleRestoreScrollWheel = (event: WheelEvent) => {
        if (restoreScrollToBottomPendingRef.current && event.deltaY < 0) {
          cancelRestoreScrollToBottom();
        }
      };
      hostEl.addEventListener("wheel", handleRestoreScrollWheel, { passive: true });

      return () => {
        hostEl.removeEventListener("paste", handlePaste, true);
        hostEl.removeEventListener("wheel", handleRestoreScrollWheel);
        hostEl.removeEventListener("contextmenu", handleContextMenu, true);
        hostEl.removeEventListener("mouseup", handleSelectionMouseUp, true);
        inputDisposable.dispose();
        titleDisposable.dispose();
        linkProviderDisposable.dispose();
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
        terminalReadyWaitersRef.current = [];
        terminalRef.current = null;
        searchRef.current = null;
        stabilizeTerminalRef.current = null;
        inactiveDataBufferRef.current = [];
        flushingInactiveDataRef.current = false;
        inactiveFlushGenerationRef.current += 1;
        scrollbackReplayedRef.current = false;
        restoreScrollToBottomPendingRef.current = false;
        clearRestoreScrollToBottomTimers();
      };
    }

    return () => {
      cancelled = true;
      teardown?.();
      teardown = null;
      terminalReadyWaitersRef.current = [];
      pendingDataRef.current = [];
      inactiveDataBufferRef.current = [];
      flushingInactiveDataRef.current = false;
      inactiveFlushGenerationRef.current += 1;
      restoreScrollToBottomPendingRef.current = false;
      clearRestoreScrollToBottomTimers();
    };
  }, [
    pane.id,
    resolveTerminalReady,
    clearRestoreScrollToBottomTimers,
    scheduleRestoreScrollToBottom,
    cancelRestoreScrollToBottom,
    terminalInputDisabled,
    writeTerminalData,
  ]);

  // Replay durable scrollback before releasing the backend's pre-attach backlog.
  // A recovered pane starts a fresh PTY immediately, but its output stays buffered
  // backend-side until `pane_attach`; fetching the log first avoids interleaving
  // old scrollback with the recovered process's startup prompt. The promise ref
  // also keeps React StrictMode's effect replay from duplicating the restored text.
  useEffect(() => {
    let cancelled = false;
    if (!scrollbackBytesPromiseRef.current) {
      scrollbackBytesPromiseRef.current = getPaneScrollback(pane.id)
        .then((encoded) => bytesFromBase64(encoded))
        .catch(() => null);
    }
    void Promise.all([scrollbackBytesPromiseRef.current, waitForTerminalReady()]).then(
      ([restored]) => {
        if (!cancelled && !scrollbackReplayedRef.current && restored && restored.length > 0) {
          const sanitized = sanitizeRestoredScrollback(restored);
          if (sanitized.length > 0) {
            writeTerminalData(sanitized);
          }
          writeTerminalData(RESTORED_SCROLLBACK_TERMINAL_RESET);
          scrollbackReplayedRef.current = true;
        }
        if (!cancelled) {
          requestAttach(pane.id);
          startRestoreScrollToBottom();
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pane.id, requestAttach, startRestoreScrollToBottom, waitForTerminalReady, writeTerminalData]);

  useEffect(() => {
    if (!active) {
      inactiveFlushGenerationRef.current += 1;
      flushingInactiveDataRef.current = false;
      return;
    }
    // While this pane was inactive it was display:none, so PTY output kept growing the
    // buffer but xterm's viewport metrics went stale (its cached viewport height drops
    // toward 0 on a 0x0 element). After re-showing, fit()+refresh() repaint the rows
    // but don't re-sync the scroll area, so the scrollbar can't reach the true bottom
    // and the first scroll jumps — until a keypress nudges it. Replicate that nudge:
    // scrollToBottom() fires onScroll, which re-measures the now-visible viewport. If
    // the user had scrolled up, restore that position afterward (both happen in one
    // frame, so there's no visible jump). Run after the fit's frame, and again once
    // layout/fonts settle.
    const resync = () => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      const buffer = terminal.buffer.active;
      const previousTop = buffer.viewportY;
      const wasFollowing = previousTop >= buffer.baseY;
      terminal.scrollToBottom();
      if (!wasFollowing) {
        terminal.scrollToLine(previousTop);
      }
    };
    const focusAndResync = () => {
      terminalRef.current?.focus();
      resync();
    };
    const startFlushOrFocus = () => {
      stabilizeTerminalRef.current?.();
      if (!flushInactiveTerminalData(focusAndResync)) {
        focusAndResync();
      }
    };
    stabilizeTerminalRef.current?.();
    const frame = requestAnimationFrame(startFlushOrFocus);
    const settle = window.setTimeout(() => {
      stabilizeTerminalRef.current?.();
      if (!flushingInactiveDataRef.current && inactiveDataBufferRef.current.length === 0) {
        resync();
      }
    }, 80);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [active, flushInactiveTerminalData, pane.id]);

  // Apply live font changes (settings panel / Cmd-=/Cmd--) to an already-open
  // terminal, then re-fit so rows/cols and the PTY size track the new cell
  // metrics. On first mount the terminal may not exist yet (it opens after the
  // font loads); the constructor already used the current values, so the no-op
  // here is fine.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    let changed = false;
    if (terminal.options.fontSize !== fontSize) {
      terminal.options.fontSize = fontSize;
      changed = true;
    }
    if (terminal.options.fontFamily !== fontFamily) {
      terminal.options.fontFamily = fontFamily;
      changed = true;
    }
    if (terminal.options.letterSpacing !== letterSpacing) {
      terminal.options.letterSpacing = letterSpacing;
      changed = true;
    }
    if (changed) {
      // The WebGL renderer caches rasterized glyphs in a texture atlas keyed to
      // the old font/size. Without clearing it the new font draws from stale (or
      // empty) cells, which on WKWebView can blank the canvas entirely. Clearing
      // forces the atlas to rebuild for the new metrics.
      webglAddonRef.current?.clearTextureAtlas();
      stabilizeTerminalRef.current?.();
    }
  }, [fontSize, fontFamily, letterSpacing]);

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
      {confirmDialog}
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

// Memoized so the frequent App re-renders (agent status, turns, draft typing) don't
// reconcile every pane. Props are primitives plus the stable `pane` object and the
// stable requestAttach/ref callbacks, so a pane only re-renders when its own inputs
// (e.g. active state or font) actually change.
export default memo(TerminalPane);
