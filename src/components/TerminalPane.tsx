import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { IBufferLine, IBufferRange, ILink, ILinkProvider, ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { getPaneScrollback, pastePaneInput, resizePane, writePane } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { inspectPaste } from "../lib/paste";
import type { PasteProtectionSettings } from "../lib/paste";
import { useConfirm } from "../hooks/useConfirm";
import { loadTerminalFont } from "../lib/terminalFont";
import type { PaneInfo } from "../types";
import type { SelectionAnchor } from "../appTypes";
import { bytesFromBase64 } from "../lib/appHelpers";
import { safeHref } from "../lib/links";
import {
  RESTORED_SCROLLBACK_TERMINAL_RESET,
  sanitizeRestoredScrollback,
} from "../lib/terminalScrollback";

interface TerminalPaneProps {
  pane: PaneInfo;
  visible?: boolean;
  active: boolean;
  style?: CSSProperties;
  fontSize: number;
  fontFamily: string;
  /** Extra inter-character spacing in px, passed to xterm's `letterSpacing`. */
  letterSpacing: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  cursorInactiveStyle: "outline" | "block" | "bar" | "underline" | "none";
  scrollbackRows: number;
  scrollOnUserInput: boolean;
  scrollSensitivity: number;
  scrollDurationMs: number;
  lineHeight: number;
  copyOnSelect: boolean;
  selectionClearOnCopy: boolean;
  pasteProtection: PasteProtectionSettings;
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
  onOpenLink?: (paneId: string, url: string) => void;
  /** Right-click on a terminal link: open the internal/external chooser. */
  onLinkContextMenu?: (paneId: string, url: string, x: number, y: number) => void;
  /** Called on mouse-up when the user has a non-whitespace selection in this
   *  terminal, with the selected text and its viewport bounding box, so the app
   *  can offer to ask the agent about it. */
  onAskSelection?: (paneId: string, quote: string, anchor: SelectionAnchor) => void;
  /** Called after copy-on-select successfully writes a terminal selection. */
  onSelectionCopied?: (paneId: string) => void;
  /** Called when xterm parses an OSC 0/2 window-title update from PTY output. */
  onTerminalTitleChange?: (paneId: string, title: string) => void;
  onActivate?: (paneId: string) => void;
}

// Matches http(s)/mailto URLs in terminal text. Conservative: stops at whitespace and a few
// delimiters so it doesn't swallow surrounding punctuation/markup.
const TERMINAL_URL_REGEX = /\b(?:https?:\/\/|mailto:)[^\s<>"'`)\]}]+/gi;
const OSC_TITLE_MAX_BUFFER_CHARS = 8192;

function decodeTerminalDataText(decoder: TextDecoder, data: string | Uint8Array) {
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

function domSelectionAnchorWithin(root: HTMLElement): SelectionAnchor | null {
  const selection = window.getSelection();
  const range =
    selection && selection.rangeCount > 0 && !selection.isCollapsed
      ? selection.getRangeAt(0)
      : null;
  if (!range || !root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const rects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  const box = rects.length
    ? {
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      }
    : range.getBoundingClientRect();
  return box.right > box.left || box.bottom > box.top
    ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
    : null;
}

function terminalSelectionAnchor(term: Terminal): SelectionAnchor | null {
  const selection = term.getSelectionPosition();
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!selection || !screen || term.cols <= 0 || term.rows <= 0) {
    return null;
  }

  const screenRect = screen.getBoundingClientRect();
  if (screenRect.width <= 0 || screenRect.height <= 0) {
    return null;
  }

  const visibleTop = term.buffer.active.viewportY;
  const visibleBottom = visibleTop + term.rows;
  const startY = Math.max(selection.start.y, visibleTop);
  const endY = Math.min(selection.end.y, visibleBottom - 1);
  if (startY > endY) {
    return null;
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (let y = startY; y <= endY; y += 1) {
    const colStart = y === selection.start.y ? selection.start.x : 0;
    const colEnd = y === selection.end.y ? selection.end.x : term.cols;
    const clampedStart = Math.max(0, Math.min(colStart, term.cols));
    const clampedEnd = Math.max(0, Math.min(colEnd, term.cols));
    if (clampedEnd <= clampedStart) {
      continue;
    }

    const viewportRow = y - visibleTop;
    left = Math.min(left, screenRect.left + clampedStart * cellWidth);
    right = Math.max(right, screenRect.left + clampedEnd * cellWidth);
    top = Math.min(top, screenRect.top + viewportRow * cellHeight);
    bottom = Math.max(bottom, screenRect.top + (viewportRow + 1) * cellHeight);
  }

  const hasAnchor =
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Number.isFinite(top) &&
    Number.isFinite(bottom);
  return hasAnchor ? { left, right, top, bottom } : null;
}

interface TerminalLineLink {
  url: string;
  y: number;
  startX: number;
  endX: number;
}

interface XtermCellWithExtendedAttrs {
  extended?: {
    urlId?: number;
  };
}

interface XtermLineInternals {
  getTrimmedLength?: () => number;
}

interface XtermLineViewInternals {
  _line?: XtermLineInternals;
}

interface XtermOscLinkService {
  getLinkData(linkId: number): { uri?: unknown } | undefined;
}

interface XtermLinkifierInternals {
  _activeLine?: number;
  _activeProviderReplies?: Map<number, unknown> | undefined;
  _clearCurrentLink?: () => void;
  _lastBufferCell?: unknown;
}

interface XtermCoreInternals {
  _linkProviderService?: {
    linkProviders?: ILinkProvider[];
  };
  _oscLinkService?: XtermOscLinkService;
  linkifier?: XtermLinkifierInternals;
}

interface XtermTerminalInternals {
  _core?: XtermCoreInternals;
}

function terminalLineLinkKey(link: TerminalLineLink): string {
  return `${link.y}:${link.startX}:${link.endX}:${link.url}`;
}

function xtermCore(terminal: Terminal): XtermCoreInternals | undefined {
  return (terminal as unknown as XtermTerminalInternals)._core;
}

function removeDefaultOscLinkProvider(terminal: Terminal) {
  const providers = xtermCore(terminal)?._linkProviderService?.linkProviders;
  // The OSC 8 provider is registered by xterm's constructor before app code can
  // add providers. Replace that instance so OSC links follow qmux's Cmd gate too.
  if (providers?.length === 1) {
    providers.splice(0, 1);
  }
}

function resetXtermLinkHover(terminal: Terminal) {
  const linkifier = xtermCore(terminal)?.linkifier;
  linkifier?._clearCurrentLink?.();
  if (linkifier) {
    linkifier._lastBufferCell = undefined;
    linkifier._activeProviderReplies = undefined;
    linkifier._activeLine = -1;
  }
  terminal.element?.classList.remove("xterm-cursor-pointer");
  terminal.element
    ?.querySelector<HTMLElement>(".xterm-screen")
    ?.classList.remove("xterm-cursor-pointer");
}

function terminalMouseEventClone(event: MouseEvent, metaKey: boolean): MouseEvent {
  return new MouseEvent("mousemove", {
    altKey: event.altKey,
    bubbles: true,
    button: event.button,
    buttons: event.buttons,
    cancelable: true,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    metaKey,
    screenX: event.screenX,
    screenY: event.screenY,
    shiftKey: event.shiftKey,
    view: window,
  });
}

function replayTerminalMouseMove(
  terminal: Terminal,
  event: MouseEvent | null,
  metaKey: boolean,
) {
  if (!event) {
    return;
  }
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) {
    return;
  }
  const rect = screen.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX >= rect.right ||
    event.clientY < rect.top ||
    event.clientY >= rect.bottom
  ) {
    return;
  }
  screen.dispatchEvent(terminalMouseEventClone(event, metaKey));
}

function oscLinkCellId(cell: unknown): number {
  const linkId = (cell as XtermCellWithExtendedAttrs | undefined)?.extended?.urlId;
  return typeof linkId === "number" ? linkId : 0;
}

function oscLineLength(line: IBufferLine, terminal: Terminal): number {
  const internalLength = (line as unknown as XtermLineViewInternals)._line?.getTrimmedLength?.();
  const lineLength = typeof internalLength === "number" ? internalLength : line.length;
  return Math.min(lineLength, line.length, terminal.cols);
}

function findOscLineLinks(
  terminal: Terminal,
  y: number,
  activate: (event: MouseEvent, url: string) => void,
  hover: (event: MouseEvent, url: string) => void,
  leave: () => void,
): ILink[] {
  const line = terminal.buffer.active.getLine(y - 1);
  const oscLinkService = xtermCore(terminal)?._oscLinkService;
  if (!line || !oscLinkService) {
    return [];
  }

  const links: ILink[] = [];
  const lineLength = oscLineLength(line, terminal);
  let currentLinkId = 0;
  let currentStart = -1;
  let finishLink = false;

  for (let x = 0; x < lineLength; x += 1) {
    const linkId = oscLinkCellId(line.getCell(x));
    if (linkId) {
      if (currentStart === -1) {
        currentStart = x;
        currentLinkId = linkId;
        continue;
      }
      finishLink = linkId !== currentLinkId;
    } else if (currentStart !== -1) {
      finishLink = true;
    }

    if (finishLink || (currentStart !== -1 && x === lineLength - 1)) {
      const url = safeHref(oscLinkService.getLinkData(currentLinkId)?.uri);
      if (url) {
        const range: IBufferRange = {
          start: { x: currentStart + 1, y },
          end: {
            x: x + (!finishLink && x === lineLength - 1 ? 1 : 0),
            y,
          },
        };
        links.push({
          text: url,
          range,
          activate: (event, text) => {
            if (event.metaKey) {
              activate(event, text);
            }
          },
          hover,
          leave,
        });
      }

      finishLink = false;
      if (linkId) {
        currentStart = x;
        currentLinkId = linkId;
      } else {
        currentStart = -1;
        currentLinkId = 0;
      }
    }
  }

  return links;
}

// Finds links in one terminal line (1-based buffer row `y`). Single-line only: a URL
// wrapped across rows is detected per-row (the common case - a URL on one line - works
// exactly). x/y are 1-based; endX is inclusive of the last cell.
function findTerminalLineLinks(lineText: string, y: number): TerminalLineLink[] {
  const links: TerminalLineLink[] = [];
  for (const match of lineText.matchAll(TERMINAL_URL_REGEX)) {
    const start = match.index ?? 0;
    // Drop trailing punctuation that's usually sentence/markup, not part of the URL.
    const displayUrl = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    const url = safeHref(displayUrl);
    if (!url) {
      continue;
    }
    links.push({
      url,
      y,
      startX: start + 1,
      endX: start + displayUrl.length,
    });
  }
  return links;
}

function findLineLinks(lineText: string, y: number, activate: (url: string) => void): ILink[] {
  return findTerminalLineLinks(lineText, y).map((link) => ({
    text: link.url,
    range: { start: { x: link.startX, y }, end: { x: link.endX, y } },
    activate: (event, text) => {
      if (event.metaKey && !event.defaultPrevented) {
        activate(text);
      }
    },
  }));
}

function terminalBufferCellFromMouseEvent(
  term: Terminal,
  event: MouseEvent,
): { x: number; y: number } | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) {
    return null;
  }

  const screenRect = screen.getBoundingClientRect();
  if (
    screenRect.width <= 0 ||
    screenRect.height <= 0 ||
    event.clientX < screenRect.left ||
    event.clientX >= screenRect.right ||
    event.clientY < screenRect.top ||
    event.clientY >= screenRect.bottom
  ) {
    return null;
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportColumn = Math.floor((event.clientX - screenRect.left) / cellWidth);
  const viewportRow = Math.floor((event.clientY - screenRect.top) / cellHeight);
  if (
    viewportColumn < 0 ||
    viewportColumn >= term.cols ||
    viewportRow < 0 ||
    viewportRow >= term.rows
  ) {
    return null;
  }

  return {
    x: viewportColumn + 1,
    y: term.buffer.active.viewportY + viewportRow + 1,
  };
}

function terminalLinkAtMouseEvent(term: Terminal, event: MouseEvent): TerminalLineLink | null {
  const cell = terminalBufferCellFromMouseEvent(term, event);
  if (!cell) {
    return null;
  }

  const line = term.buffer.active.getLine(cell.y - 1);
  if (!line) {
    return null;
  }

  return (
    findTerminalLineLinks(line.translateToString(true), cell.y).find(
      (link) => cell.x >= link.startX && cell.x <= link.endX,
    ) ?? null
  );
}

export interface TerminalPaneHandle {
  focus: () => void;
  // Capture the current xterm viewport and re-apply it on the next frame. Used by
  // split layout changes that keep the terminal mounted but alter its geometry.
  preserveViewport: () => void;
  // Writes a decoded PTY chunk into this pane, buffering until xterm has opened so
  // cold-start output is never dropped. Called by the app's central event dispatch.
  write: (data: string | Uint8Array) => void;
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

interface TerminalScrollSnapshot {
  viewportY: number;
  bottomOffset: number;
  cols: number;
  followingBottom: boolean;
}

function snapshotTerminalScroll(terminal: Terminal): TerminalScrollSnapshot {
  const buffer = terminal.buffer.active;
  const bottomOffset = Math.max(0, buffer.baseY - buffer.viewportY);
  return {
    viewportY: buffer.viewportY,
    bottomOffset,
    cols: terminal.cols,
    followingBottom: bottomOffset === 0,
  };
}

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
    visible: visibleProp,
    active,
    style,
    fontSize,
    fontFamily,
    letterSpacing,
    cursorBlink,
    cursorStyle,
    cursorInactiveStyle,
    scrollbackRows,
    scrollOnUserInput,
    scrollSensitivity,
    scrollDurationMs,
    lineHeight,
    copyOnSelect,
    selectionClearOnCopy,
    pasteProtection,
    inputBlocked,
    requestAttach,
    onUserInput,
    onOpenLink,
    onLinkContextMenu,
    onAskSelection,
    onSelectionCopied,
    onTerminalTitleChange,
    onActivate,
  },
  ref,
) {
  const visible = visibleProp ?? active;
  // The setup effect runs once (keyed on pane.id) and closes over its render's
  // font settings; read the latest values through refs so a terminal created
  // while the user has changed the font/size opens with the current choice.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fontFamilyRef = useRef(fontFamily);
  fontFamilyRef.current = fontFamily;
  const letterSpacingRef = useRef(letterSpacing);
  letterSpacingRef.current = letterSpacing;
  const cursorBlinkRef = useRef(cursorBlink);
  cursorBlinkRef.current = cursorBlink;
  const cursorStyleRef = useRef(cursorStyle);
  cursorStyleRef.current = cursorStyle;
  const cursorInactiveStyleRef = useRef(cursorInactiveStyle);
  cursorInactiveStyleRef.current = cursorInactiveStyle;
  const scrollbackRowsRef = useRef(scrollbackRows);
  scrollbackRowsRef.current = scrollbackRows;
  const scrollOnUserInputRef = useRef(scrollOnUserInput);
  scrollOnUserInputRef.current = scrollOnUserInput;
  const scrollSensitivityRef = useRef(scrollSensitivity);
  scrollSensitivityRef.current = scrollSensitivity;
  const scrollDurationMsRef = useRef(scrollDurationMs);
  scrollDurationMsRef.current = scrollDurationMs;
  const lineHeightRef = useRef(lineHeight);
  lineHeightRef.current = lineHeight;
  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;
  const selectionClearOnCopyRef = useRef(selectionClearOnCopy);
  selectionClearOnCopyRef.current = selectionClearOnCopy;
  const pasteProtectionRef = useRef(pasteProtection);
  pasteProtectionRef.current = pasteProtection;
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
  const onSelectionCopiedRef = useRef(onSelectionCopied);
  onSelectionCopiedRef.current = onSelectionCopied;
  const onTerminalTitleChangeRef = useRef(onTerminalTitleChange);
  onTerminalTitleChangeRef.current = onTerminalTitleChange;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const activeRef = useRef(active);
  activeRef.current = active;
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
  const pendingDataRef = useRef<Array<string | Uint8Array>>([]);
  const inactiveDataBufferRef = useRef<Array<string | Uint8Array>>([]);
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
  const scrollSnapshotRef = useRef<TerminalScrollSnapshot>({
    viewportY: 0,
    bottomOffset: 0,
    cols: pane.cols,
    followingBottom: true,
  });

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

  const captureTerminalScroll = useCallback((terminal: Terminal | null = terminalRef.current) => {
    if (!terminal) {
      return;
    }
    scrollSnapshotRef.current = snapshotTerminalScroll(terminal);
  }, []);

  const restoreTerminalViewport = useCallback(
    (
      snapshot: TerminalScrollSnapshot = scrollSnapshotRef.current,
      terminal: Terminal | null = terminalRef.current,
    ) => {
      if (!terminal) {
        return;
      }
      if (restoreScrollToBottomPendingRef.current || snapshot.followingBottom) {
        terminal.scrollToBottom();
      } else {
        const currentBaseY = terminal.buffer.active.baseY;
        const targetViewportY =
          terminal.cols === snapshot.cols
            ? snapshot.viewportY
            : currentBaseY - snapshot.bottomOffset;
        const targetLine = Math.max(0, Math.min(targetViewportY, currentBaseY));
        terminal.scrollToLine(targetLine);
      }
      captureTerminalScroll(terminal);
    },
    [captureTerminalScroll],
  );

  const scrollRestoredTerminalToBottom = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.scrollToBottom();
    captureTerminalScroll(terminal);
  }, [captureTerminalScroll]);

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

  const writeTerminalData = useCallback((data: string | Uint8Array) => {
    const terminal = terminalRef.current;
    if (terminal && terminalReadyRef.current) {
      if (restoreScrollToBottomPendingRef.current) {
        terminal.write(data, scheduleRestoreScrollToBottom);
      } else {
        terminal.write(data);
      }
    } else {
      // Output can arrive before the bundled font loads and xterm opens; buffer
      // it and flush once the terminal is ready (see the setup effect).
      pendingDataRef.current.push(data);
    }
  }, [scheduleRestoreScrollToBottom]);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        if (!activeRef.current || !visibleRef.current) {
          return;
        }
        terminalRef.current?.focus();
        stabilizeTerminalRef.current?.();
      },
      preserveViewport() {
        const terminal = terminalRef.current;
        if (!terminal) {
          return;
        }
        const snapshot = snapshotTerminalScroll(terminal);
        scrollSnapshotRef.current = snapshot;
        const restore = () => {
          const currentTerminal = terminalRef.current;
          if (!currentTerminal) {
            return;
          }
          restoreTerminalViewport(snapshot, currentTerminal);
          stabilizeTerminalRef.current?.();
        };
        restore();
        window.requestAnimationFrame(restore);
      },
      write: writeTerminalData,
    }),
    [restoreTerminalViewport, writeTerminalData],
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
      let hoveredOscLink: string | null = null;
      let terminalLinkModifierActive = false;
      let lastTerminalMouseEvent: MouseEvent | null = null;
      let terminalForSelection: Terminal | null = null;
      let lastCopiedSelection = "";
      let clearingSelection = false;
      const clearTerminalSelection = () => {
        const currentTerminal = terminalForSelection;
        if (!currentTerminal?.hasSelection()) {
          return;
        }
        lastCopiedSelection = "";
        clearingSelection = true;
        currentTerminal.clearSelection();
        window.setTimeout(() => {
          clearingSelection = false;
        }, 0);
      };
      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cols: pane.cols,
        cursorBlink: cursorBlinkRef.current,
        cursorStyle: cursorStyleRef.current,
        cursorInactiveStyle: cursorInactiveStyleRef.current,
        fontFamily: fontFamilyRef.current,
        fontSize: fontSizeRef.current,
        letterSpacing: letterSpacingRef.current,
        linkHandler: {
          allowNonHttpProtocols: true,
          activate: (event, text) => {
            if (!event.metaKey) {
              return;
            }
            const url = safeHref(text);
            if (!url) {
              return;
            }
            event.preventDefault();
            clearTerminalSelection();
            onOpenLinkRef.current?.(pane.id, url);
          },
          hover: (event, text) => {
            hoveredOscLink = event.metaKey ? safeHref(text) ?? null : null;
          },
          leave: () => {
            hoveredOscLink = null;
          },
        },
        lineHeight: lineHeightRef.current,
        rows: pane.rows,
        scrollback: scrollbackRowsRef.current,
        scrollOnUserInput: scrollOnUserInputRef.current,
        scrollSensitivity: scrollSensitivityRef.current,
        smoothScrollDuration: scrollDurationMsRef.current,
        theme: TERMINAL_THEME,
      });
      terminalForSelection = terminal;

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
      let copyOnSelectTimer: number | null = null;
      const clearCopyOnSelectTimer = () => {
        if (copyOnSelectTimer !== null) {
          window.clearTimeout(copyOnSelectTimer);
          copyOnSelectTimer = null;
        }
      };
      const copySelectionNow = () => {
        const text = terminal.getSelection();
        if (!text) {
          lastCopiedSelection = "";
          return;
        }
        if (text === lastCopiedSelection) {
          return;
        }
        lastCopiedSelection = text;
        void writeClipboardText(text)
          .then(() => {
            onSelectionCopiedRef.current?.(pane.id);
            if (!selectionClearOnCopyRef.current) {
              return;
            }
            lastCopiedSelection = "";
            clearingSelection = true;
            terminal.clearSelection();
            window.setTimeout(() => {
              clearingSelection = false;
            }, 0);
          })
          .catch(() => undefined);
      };
      const selectionDisposable = terminal.onSelectionChange(() => {
        if (!copyOnSelectRef.current || clearingSelection) {
          return;
        }
        clearCopyOnSelectTimer();
        // Trailing debounce covers keyboard/programmatic selection changes;
        // mouse selections copy immediately on release below.
        copyOnSelectTimer = window.setTimeout(() => {
          copyOnSelectTimer = null;
          copySelectionNow();
        }, 120);
      });
      // Mouse selections copy the moment the drag ends instead of waiting out
      // the debounce. Track the press on this pane so a release anywhere
      // (drags often end outside the pane) finalizes only this pane's
      // selection.
      let selectionDragActive = false;
      const handleCopySelectMouseDown = () => {
        selectionDragActive = true;
      };
      const handleCopySelectMouseUp = () => {
        if (!selectionDragActive) {
          return;
        }
        selectionDragActive = false;
        if (!copyOnSelectRef.current || clearingSelection) {
          return;
        }
        clearCopyOnSelectTimer();
        copySelectionNow();
      };
      hostEl.addEventListener("mousedown", handleCopySelectMouseDown, true);
      window.addEventListener("mouseup", handleCopySelectMouseUp, true);

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
      if (activeRef.current && visibleRef.current) {
        terminal.focus();
      }

      terminalRef.current = terminal;
      terminalReadyRef.current = true;
      searchRef.current = search;
      captureTerminalScroll(terminal);
      resolveTerminalReady();

      const pending = pendingDataRef.current;
      pendingDataRef.current = [];
      for (const chunk of pending) {
        if (restoreScrollToBottomPendingRef.current) {
          terminal.write(chunk, scheduleRestoreScrollToBottom);
        } else {
          terminal.write(chunk);
        }
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
          !visibleRef.current ||
          hostEl.offsetParent === null ||
          hostEl.clientWidth === 0 ||
          hostEl.clientHeight === 0
        ) {
          // Only visible panes should drive terminal layout. Hidden panes can still
          // receive ResizeObserver callbacks as the app grid changes; fitting them
          // while invisible can reflow scrollback before the user returns.
          return;
        }
        const scrollSnapshot = snapshotTerminalScroll(terminal);
        fit.fit();
        if (terminal.cols !== syncedCols || terminal.rows !== syncedRows) {
          syncedCols = terminal.cols;
          syncedRows = terminal.rows;
          void resizePane(pane.id, terminal.cols, terminal.rows);
        }
        restoreTerminalViewport(scrollSnapshot, terminal);
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
        if (inputBlockedRef.current) {
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
      const scrollDisposable = terminal.onScroll(() => {
        captureTerminalScroll(terminal);
      });

      removeDefaultOscLinkProvider(terminal);

      const setTerminalLinkModifierActive = (active: boolean, replayHover = true) => {
        if (terminalLinkModifierActive === active) {
          return;
        }
        terminalLinkModifierActive = active;
        hostEl.classList.toggle("terminal-link-modifier-active", active);
        resetXtermLinkHover(terminal);
        if (active && replayHover) {
          replayTerminalMouseMove(terminal, lastTerminalMouseEvent, active);
        }
      };
      const handleTerminalMouseMove = (event: MouseEvent) => {
        lastTerminalMouseEvent = event;
        if (event.metaKey !== terminalLinkModifierActive) {
          setTerminalLinkModifierActive(event.metaKey, false);
        }
      };
      const handleTerminalMouseLeave = () => {
        lastTerminalMouseEvent = null;
      };
      const handleTerminalLinkModifierKeyDown = (event: KeyboardEvent) => {
        if (event.metaKey || event.key === "Meta") {
          setTerminalLinkModifierActive(true);
        }
      };
      const handleTerminalLinkModifierKeyUp = (event: KeyboardEvent) => {
        if (!event.metaKey || event.key === "Meta") {
          setTerminalLinkModifierActive(false);
        }
      };
      const handleTerminalLinkModifierBlur = () => {
        setTerminalLinkModifierActive(false);
      };
      hostEl.addEventListener("mousemove", handleTerminalMouseMove, true);
      hostEl.addEventListener("mouseleave", handleTerminalMouseLeave, true);
      window.addEventListener("keydown", handleTerminalLinkModifierKeyDown, true);
      window.addEventListener("keyup", handleTerminalLinkModifierKeyUp, true);
      window.addEventListener("blur", handleTerminalLinkModifierBlur);

      const oscLinkProviderDisposable = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          if (!terminalLinkModifierActive) {
            callback(undefined);
            return;
          }
          const links = findOscLineLinks(
            terminal,
            bufferLineNumber,
            (event, url) => {
              event.preventDefault();
              clearTerminalSelection();
              onOpenLinkRef.current?.(pane.id, url);
            },
            (_event, url) => {
              hoveredOscLink = url;
            },
            () => {
              hoveredOscLink = null;
            },
          );
          callback(links.length > 0 ? links : undefined);
        },
      });

      // Make http(s)/mailto URLs in the scrollback look clickable only while
      // Cmd is held. Mouse handlers below resolve activation from the actual event.
      const linkProviderDisposable = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          if (!terminalLinkModifierActive) {
            callback(undefined);
            return;
          }
          const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const links = findLineLinks(line.translateToString(true), bufferLineNumber, (url) => {
            clearTerminalSelection();
            onOpenLinkRef.current?.(pane.id, url);
          });
          callback(links.length > 0 ? links : undefined);
        },
      });

      // Handle terminal links through qmux so they match transcript links. xterm's link
      // provider still supplies hover decorations, but activation is resolved from the
      // actual mouse event to avoid depending on hover state being current.
      let pressedLinkKey: string | null = null;
      const handleLinkMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || !event.metaKey) {
          pressedLinkKey = null;
          return;
        }
        const link = terminalLinkAtMouseEvent(terminal, event);
        pressedLinkKey = link ? terminalLineLinkKey(link) : null;
      };
      const handleLinkMouseUp = (event: MouseEvent) => {
        if (event.button !== 0) {
          return;
        }
        if (!event.metaKey) {
          pressedLinkKey = null;
          return;
        }
        const link = terminalLinkAtMouseEvent(terminal, event);
        const linkKey = link ? terminalLineLinkKey(link) : null;
        if (!link || !pressedLinkKey || pressedLinkKey !== linkKey) {
          pressedLinkKey = null;
          return;
        }
        pressedLinkKey = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        clearTerminalSelection();
        onOpenLinkRef.current?.(pane.id, link.url);
      };
      const handleContextMenu = (event: MouseEvent) => {
        if (!event.metaKey) {
          return;
        }
        const link = terminalLinkAtMouseEvent(terminal, event);
        const url = link?.url ?? hoveredOscLink;
        if (!url) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        clearTerminalSelection();
        onLinkContextMenuRef.current?.(pane.id, url, event.clientX, event.clientY);
      };
      hostEl.addEventListener("mousedown", handleLinkMouseDown, true);
      hostEl.addEventListener("mouseup", handleLinkMouseUp, true);
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
        // Prefer the DOM selection when present; WebGL paints selection on a canvas,
        // so derive a viewport box from xterm's selected buffer cells there.
        const selectionAnchor =
          domSelectionAnchorWithin(hostEl) ?? terminalSelectionAnchor(term);
        const anchor: SelectionAnchor =
          selectionAnchor ?? {
            // Last resort only: older/broken render states may not expose geometry.
            // This can drift within the selected text, but keeps the action available.
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
        if (inputBlockedRef.current) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const text = event.clipboardData?.getData("text") ?? "";
        if (!text) {
          return;
        }
        const bracketed = terminal.modes.bracketedPasteMode;
        const verdict = inspectPaste(text, {
          ...pasteProtectionRef.current,
          bracketedPasteActive: bracketed,
        });
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
        void confirmRef.current({ message: verdict.message, confirmLabel: "Paste" }).then((ok) => {
          if (ok) {
            void pastePaneInput(pane.id, text, bracketed).catch(() => undefined);
          }
        });
      };
      hostEl.addEventListener("paste", handlePaste, true);
      const handleCopy = () => {
        if (selectionClearOnCopyRef.current && terminal.hasSelection()) {
          lastCopiedSelection = "";
          window.setTimeout(() => terminal.clearSelection(), 0);
        }
      };
      hostEl.addEventListener("copy", handleCopy, true);

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
        hostEl.removeEventListener("copy", handleCopy, true);
        hostEl.removeEventListener("wheel", handleRestoreScrollWheel);
        hostEl.removeEventListener("mousemove", handleTerminalMouseMove, true);
        hostEl.removeEventListener("mouseleave", handleTerminalMouseLeave, true);
        hostEl.removeEventListener("mousedown", handleLinkMouseDown, true);
        hostEl.removeEventListener("mouseup", handleLinkMouseUp, true);
        hostEl.removeEventListener("contextmenu", handleContextMenu, true);
        hostEl.removeEventListener("mouseup", handleSelectionMouseUp, true);
        hostEl.removeEventListener("mousedown", handleCopySelectMouseDown, true);
        window.removeEventListener("mouseup", handleCopySelectMouseUp, true);
        window.removeEventListener("keydown", handleTerminalLinkModifierKeyDown, true);
        window.removeEventListener("keyup", handleTerminalLinkModifierKeyUp, true);
        window.removeEventListener("blur", handleTerminalLinkModifierBlur);
        if (copyOnSelectTimer !== null) {
          window.clearTimeout(copyOnSelectTimer);
        }
        inputDisposable.dispose();
        titleDisposable.dispose();
        scrollDisposable.dispose();
        oscLinkProviderDisposable.dispose();
        linkProviderDisposable.dispose();
        selectionDisposable.dispose();
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
      restoreScrollToBottomPendingRef.current = false;
      clearRestoreScrollToBottomTimers();
    };
  }, [
    pane.id,
    resolveTerminalReady,
    clearRestoreScrollToBottomTimers,
    scheduleRestoreScrollToBottom,
    cancelRestoreScrollToBottom,
    captureTerminalScroll,
    restoreTerminalViewport,
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

  useLayoutEffect(() => {
    const restoreSavedViewport = () => restoreTerminalViewport();

    if (!visible) {
      captureTerminalScroll();
      return;
    }

    stabilizeTerminalRef.current?.();
    if (!active) {
      return;
    }

    terminalRef.current?.focus();
    restoreSavedViewport();
    const frame = requestAnimationFrame(restoreSavedViewport);
    const settle = window.setTimeout(restoreSavedViewport, 80);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      captureTerminalScroll();
    };
  }, [active, visible, pane.id, captureTerminalScroll, restoreTerminalViewport]);

  // Apply live terminal settings to an already-open terminal, then re-fit when
  // cell metrics change so rows/cols and the PTY size track the new grid.
  // On first mount the terminal may not exist yet (it opens after the font
  // loads); the constructor already used the current values.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    let metricsChanged = false;
    if (terminal.options.fontSize !== fontSize) {
      terminal.options.fontSize = fontSize;
      metricsChanged = true;
    }
    if (terminal.options.fontFamily !== fontFamily) {
      terminal.options.fontFamily = fontFamily;
      metricsChanged = true;
    }
    if (terminal.options.letterSpacing !== letterSpacing) {
      terminal.options.letterSpacing = letterSpacing;
      metricsChanged = true;
    }
    if (terminal.options.lineHeight !== lineHeight) {
      terminal.options.lineHeight = lineHeight;
      metricsChanged = true;
    }
    if (terminal.options.cursorBlink !== cursorBlink) {
      terminal.options.cursorBlink = cursorBlink;
    }
    if (terminal.options.cursorStyle !== cursorStyle) {
      terminal.options.cursorStyle = cursorStyle;
    }
    if (terminal.options.cursorInactiveStyle !== cursorInactiveStyle) {
      terminal.options.cursorInactiveStyle = cursorInactiveStyle;
    }
    if (terminal.options.scrollback !== scrollbackRows) {
      terminal.options.scrollback = scrollbackRows;
    }
    if (terminal.options.scrollOnUserInput !== scrollOnUserInput) {
      terminal.options.scrollOnUserInput = scrollOnUserInput;
    }
    if (terminal.options.scrollSensitivity !== scrollSensitivity) {
      terminal.options.scrollSensitivity = scrollSensitivity;
    }
    if (terminal.options.smoothScrollDuration !== scrollDurationMs) {
      terminal.options.smoothScrollDuration = scrollDurationMs;
    }
    if (metricsChanged) {
      // The WebGL renderer caches rasterized glyphs in a texture atlas keyed to
      // the old font/size. Without clearing it the new font draws from stale (or
      // empty) cells, which on WKWebView can blank the canvas entirely. Clearing
      // forces the atlas to rebuild for the new metrics.
      webglAddonRef.current?.clearTextureAtlas();
      stabilizeTerminalRef.current?.();
    }
  }, [
    fontSize,
    fontFamily,
    letterSpacing,
    lineHeight,
    cursorBlink,
    cursorStyle,
    cursorInactiveStyle,
    scrollbackRows,
    scrollOnUserInput,
    scrollSensitivity,
    scrollDurationMs,
  ]);

  const matchLabel =
    searchTerm === ""
      ? ""
      : searchResults.count === 0
        ? "No results"
        : `${searchResults.index + 1}/${searchResults.count}`;
  const hasMatches = searchResults.count > 0;

  return (
    <div
      className={`terminal-pane ${visible ? "is-visible" : ""} ${active ? "is-focused" : ""}`}
      aria-hidden={!visible}
      style={style}
      onPointerDown={() => onActivateRef.current?.(pane.id)}
    >
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
