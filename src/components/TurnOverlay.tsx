import {
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from "react";
import { ChevronRight, Ellipsis, WrapText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Turn, TurnBlock, TranscriptOption } from "../types";
import type { SelectionAnchor } from "../appTypes";
import { IS_MAC, isEditableTarget } from "../lib/appHelpers";
import { writeClipboardText } from "../lib/clipboard";
import { safeHref } from "../lib/links";
import { taggedUserInstructionDetails } from "../lib/taggedInstructions";
import {
  applySearchHighlights,
  clearSearchHighlights,
  collectSearchRanges,
  nearestSearchRangeIndex,
  scrollSearchRangeIntoView,
} from "../lib/transcriptSearch";
import PaneSearchBar from "./PaneSearchBar";
import TranscriptPickerLink from "./TranscriptPickerLink";
import DiagramBlock, { diagramLangFromClassName, nodeText } from "./DiagramBlock";

// Link actions for rendered markdown, supplied by App through TurnOverlay. Markdown is
// rendered deep in the timeline tree, so a context avoids threading these everywhere.
export interface LinkActions {
  // Primary (left-click) action — opens in the internal browser overlay.
  openLink: (url: string) => void;
  // Right-click — opens the internal/external chooser menu at the pointer.
  openLinkMenu: (url: string, x: number, y: number) => void;
}

const LinkActionsContext = createContext<LinkActions>({
  openLink: () => undefined,
  openLinkMenu: () => undefined,
});

interface TurnOverlayProps {
  turns: Turn[];
  assistantLabel: string;
  // Top bar pinned across the top of the pane (session id + fork/browser controls).
  header?: ReactNode;
  input?: ReactNode;
  // Identifies the agent whose transcript is shown; a change means a different
  // transcript loaded, which is when we jump the view to the latest turn.
  agentId?: string;
  // Short diagnostic shown under the empty-state placeholder when the transcript
  // tail is in an unexpected state (stalled/unreadable file, adapter failure).
  notice?: string | null;
  // Sessions offered by the empty-state "No transcript loaded" picker (same set as
  // the header session menu), the currently-loaded transcript path, and
  // the handler that loads a chosen one (or null to detach).
  transcriptOptions?: TranscriptOption[];
  transcriptPath?: string | null;
  onSelectTranscript?: (path: string | null) => void;
  // When true, the queue/composer area is reserved below the transcript instead of
  // floating over it, with a draggable divider between the two regions.
  queueSplit?: boolean;
  queueSplitHeight?: number;
  onQueueSplitHeightChange?: (height: number) => void;
  // How rendered-markdown links behave (left-click opens internally; right-click
  // opens a chooser).
  linkActions: LinkActions;
  // Called on mouse-up when the user selects non-whitespace text within the
  // transcript, with the text and its viewport bounding box, so the app can offer to
  // ask the agent about it.
  onAskSelection?: (quote: string, anchor: SelectionAnchor) => void;
  // Called on a mouse-up that leaves no usable transcript selection, so the app can
  // dismiss an open Ask popup (the popup stays mounted across re-selections, so a
  // click that just clears the selection has to be reported here to close it).
  onDismissSelection?: () => void;
  // When true, the agent is actively working, so a "Working…" indicator is pinned
  // to the bottom of the transcript. Driven by live status transitions upstream, so
  // an agent merely restored into a working status does not light it up.
  thinking?: boolean;
  thinkingLabel?: string;
  // Code-mode transcript detail: when false, hide historical tool/thinking
  // activity from the visible transcript while keeping normal messages.
  showActivityDetail?: boolean;
  // When supplied, user-message headers get a small action that asks App to
  // regenerate the tab title from that message.
  onRegenerateTitleFromUserMessage?: (message: string) => void;
  titleGenerationBusy?: boolean;
  // When true (the overlay showing the active pane), Cmd-F/Ctrl-F opens this
  // pane's find bar — unless focus is in the terminal, which owns its own find.
  searchHotkeyActive?: boolean;
}

// Gap kept between the last transcript message and the top of the composer.
const COMPOSER_CLEARANCE = 16;

// How close to the bottom (in px) the user must be for new turns or a growing
// composer to keep the transcript pinned to the bottom.
const STICK_TO_BOTTOM_THRESHOLD = 100;
const MIN_TRANSCRIPT_SPLIT_HEIGHT = 96;
const MIN_QUEUE_SPLIT_HEIGHT = 120;
const MIN_QUEUE_AREA_HEIGHT = 56;
const QUEUE_SPLIT_RESIZER_HALF_HEIGHT = 5;
const SPLIT_KEYBOARD_STEP = 16;
const LONG_USER_MESSAGE_COLLAPSE_THRESHOLD = 12_000;
const LONG_USER_MESSAGE_PREVIEW_CHARS = 1_200;
const TOOL_SUMMARY_ARGUMENT_KEYS = {
  exec_command: "cmd",
  "functions.exec_command": "cmd",
  Bash: "command",
  WebFetch: "url",
  // Claude's file tools: show the path being read/edited as the argument.
  Read: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
} as const;

const TOOL_ACTION_NAMES = {
  readFile: new Set(["read", "read_file", "glob", "grep", "ls"]),
  editFile: new Set([
    "edit",
    "multi_edit",
    "multiedit",
    "notebook_edit",
    "notebookedit",
    "write",
    "apply_patch",
  ]),
  runCommand: new Set(["bash", "exec_command", "shell", "run_command"]),
} as const;

interface QueueSplitDrag {
  pointerId: number;
  startY: number;
  startHeight: number;
}

type TextBlock = Extract<TurnBlock, { type: "text" }>;
type ToolUseBlock = Extract<TurnBlock, { type: "toolUse" }>;
type ToolResultBlock = Extract<TurnBlock, { type: "toolResult" }>;
type RawBlock = Extract<TurnBlock, { type: "raw" }>;

type MessageBlock = TextBlock | RawBlock;
type TurnTimelineStatus = NonNullable<Turn["status"]>;

interface MessageItem {
  type: "message";
  key: string;
  role: string;
  blocks: MessageBlock[];
  activities: ActivityItem[];
  status?: TurnTimelineStatus;
}

interface ToolEntry {
  type: "tool";
  key: string;
  id?: string | null;
  name: string;
  input?: unknown;
  result?: unknown;
  isError: boolean;
  status?: TurnTimelineStatus;
}

type ToolActionKind = keyof typeof TOOL_ACTION_NAMES;

interface ThinkingItem {
  type: "thinking";
  key: string;
  values: unknown[];
  status?: TurnTimelineStatus;
}

interface ActivityGroupItem {
  type: "activityGroup";
  key: string;
  children: ActivityLeafItem[];
  toolCallCount: number;
  status?: TurnTimelineStatus;
}

type ActivityLeafItem = ToolEntry | ThinkingItem;
type ActivityItem = ActivityLeafItem | ActivityGroupItem;

function MarkdownLink({ href, ...props }: ComponentPropsWithoutRef<"a">) {
  const { openLink, openLinkMenu } = useContext(LinkActionsContext);
  const safe = safeHref(href);
  if (!safe) {
    return <span {...props} />;
  }
  // The webview can't navigate out (CSP), so intercept the click. Left-click opens the
  // internal browser; right-click opens the internal/external chooser. href stays set
  // for the hover/title affordance.
  return (
    <a
      {...props}
      href={safe}
      onClick={(event) => {
        event.preventDefault();
        openLink(safe);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        openLinkMenu(safe, event.clientX, event.clientY);
      }}
    />
  );
}

function MarkdownCodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const [wrap, setWrap] = useState(false);
  const label = wrap ? "Turn off line wrap" : "Turn on line wrap";
  // The button anchors to the wrapper, not the scrolling <pre>, so it stays
  // pinned to the block's top-right corner while the code scrolls under it.
  return (
    <div className={`turn-markdown-code-block${wrap ? " is-wrapped" : ""}`}>
      <button
        type="button"
        className={`turn-markdown-code-wrap-toggle${wrap ? " is-active" : ""}`}
        title={label}
        aria-label={label}
        aria-pressed={wrap}
        onClick={() => setWrap((value) => !value)}
      >
        <WrapText aria-hidden="true" />
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) => <MarkdownLink href={href} {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="turn-markdown-table-wrap">
      <table {...props} />
    </div>
  ),
  pre: ({ node: _node, children, ...props }) => {
    // Fenced blocks arrive as <pre><code class="language-x">. Intercept mermaid/dot/graphviz
    // and render them as diagrams; everything else falls through to the normal <pre>.
    const codeEl = isValidElement(children)
      ? (children as ReactElement<{ className?: string; children?: ReactNode }>)
      : null;
    const lang = diagramLangFromClassName(codeEl?.props?.className);
    if (codeEl && lang) {
      return <DiagramBlock lang={lang} code={nodeText(codeEl.props.children)} />;
    }
    return <MarkdownCodeBlock {...props}>{children}</MarkdownCodeBlock>;
  },
};

export function formatTurnsTranscript(turns: Turn[], assistantLabel: string) {
  return turns.map((turn) => formatTurnTranscript(turn, assistantLabel)).join("\n\n");
}

export default function TurnOverlay({
  turns,
  assistantLabel,
  header,
  input,
  agentId,
  notice,
  transcriptOptions = [],
  transcriptPath = null,
  onSelectTranscript,
  queueSplit = false,
  queueSplitHeight,
  onQueueSplitHeightChange,
  linkActions,
  onAskSelection,
  onDismissSelection,
  thinking = false,
  thinkingLabel = "Working…",
  showActivityDetail = true,
  onRegenerateTitleFromUserMessage,
  titleGenerationBusy = false,
  searchHotkeyActive = false,
}: TurnOverlayProps) {
  const sidebarRef = useRef<HTMLElement | null>(null);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const regenerateTitleFromUserMessageRef = useRef(onRegenerateTitleFromUserMessage);
  regenerateTitleFromUserMessageRef.current = onRegenerateTitleFromUserMessage;
  const titleGenerationEnabled = Boolean(onRegenerateTitleFromUserMessage);
  const handleRegenerateTitleFromUserMessage = useCallback((message: string) => {
    regenerateTitleFromUserMessageRef.current?.(message);
  }, []);

  // On mouse-up, offer an "ask about this" action for any non-whitespace selection
  // within the transcript — any message (user, assistant, or system), tool output, or
  // thinking. Only the composer/input below the transcript is excluded.
  const handleSelectionMouseUp = () => {
    if (!onAskSelection) {
      return;
    }
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const selection = document.getSelection();
    const text = selection ? selection.toString() : "";
    // Require the selection to *start* inside the transcript, so a drag that begins in a
    // message but is released over the composer still registers, while a selection made
    // inside the composer itself is ignored. The start (not the mouse-up target) is what
    // matters, since the highlighted text stays in the transcript even when the release
    // lands below it.
    const range =
      selection && !selection.isCollapsed && selection.rangeCount > 0 && text.trim()
        ? selection.getRangeAt(0)
        : null;
    if (!range || !timeline.contains(range.startContainer)) {
      // No usable transcript selection (e.g. a click that collapsed the previous one).
      // The popup stays mounted across re-selections, so dismiss it explicitly rather
      // than leaving it stranded over text that is no longer highlighted.
      onDismissSelection?.();
      return;
    }
    // Anchor over the highlighted text. A triple-click selects a whole block and leaves
    // a zero-width caret rect at the start of the following block, which would stretch
    // the box past the selection, so union only the rects that actually cover something.
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const box = rects.length
      ? {
          left: Math.min(...rects.map((r) => r.left)),
          right: Math.max(...rects.map((r) => r.right)),
          top: Math.min(...rects.map((r) => r.top)),
          bottom: Math.max(...rects.map((r) => r.bottom)),
        }
      : range.getBoundingClientRect();
    onAskSelection(text, {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
    });
  };
  const queueSplitDragRef = useRef<QueueSplitDrag | null>(null);
  // Whether the view is parked near the bottom, so incoming content can keep it
  // pinned there. Starts true (we load at the bottom) and tracks user scrolling.
  const stickToBottomRef = useRef(true);
  const [composerHeight, setComposerHeight] = useState(0);
  const [composerBaseHeight, setComposerBaseHeight] = useState(0);

  // Find-in-transcript. Matches are DOM ranges over the rendered timeline; the
  // range list lives in a ref (ranges are live DOM handles, not render state)
  // while index/count drive the bar's label and the highlight repaint.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchUseRegex, setSearchUseRegex] = useState(false);
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });
  // The term actually fed to the (expensive) rescan, debounced behind searchTerm so
  // typing doesn't walk the whole timeline DOM and read per-match geometry on every
  // keystroke. The input shows searchTerm immediately; only the scan waits.
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  // Bumped when a <details> in the timeline toggles: that reveals or hides text,
  // which changes the set of searchable (rendered) matches.
  const [searchDomNonce, setSearchDomNonce] = useState(0);
  const searchRangesRef = useRef<Range[]>([]);
  // A stable per-instance token identifying this overlay's ownership of the (global)
  // search highlight registry. See lib/transcriptSearch.ts.
  const searchOwnerRef = useRef<object>({});
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const scrollToBottom = () => {
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  };

  const handleTimelineScroll = () => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD;
  };

  const splitBounds = () => {
    const sidebar = sidebarRef.current;
    const timeline = timelineRef.current;
    const totalHeight = Math.max(0, (sidebar?.clientHeight ?? 0) - (timeline?.offsetTop ?? 0));
    const composerMinHeight = Math.ceil(composerBaseHeight || 0);
    const min = Math.max(MIN_QUEUE_SPLIT_HEIGHT, composerMinHeight + MIN_QUEUE_AREA_HEIGHT);
    const max = Math.max(min, totalHeight - MIN_TRANSCRIPT_SPLIT_HEIGHT);
    return { min, max };
  };

  const clampQueueSplitHeight = (height: number) => {
    const { min, max } = splitBounds();
    return Math.max(min, Math.min(max, Math.round(height)));
  };

  const defaultQueueSplitHeight = () => {
    const sidebar = sidebarRef.current;
    const timeline = timelineRef.current;
    const totalHeight = Math.max(0, (sidebar?.clientHeight ?? 0) - (timeline?.offsetTop ?? 0));
    const preferred = totalHeight > 0 ? Math.round(totalHeight * 0.38) : 320;
    return clampQueueSplitHeight(Math.max(preferred, composerBaseHeight + 180));
  };

  const effectiveQueueSplitHeight = queueSplit
    ? clampQueueSplitHeight(queueSplitHeight ?? defaultQueueSplitHeight())
    : 0;

  const startQueueSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!queueSplit) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    queueSplitDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: effectiveQueueSplitHeight,
    };
  };

  const moveQueueSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = queueSplitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const nextHeight = drag.startHeight + (drag.startY - event.clientY);
    onQueueSplitHeightChange?.(clampQueueSplitHeight(nextHeight));
  };

  const endQueueSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = queueSplitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    queueSplitDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeQueueSplitWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!queueSplit || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? SPLIT_KEYBOARD_STEP : -SPLIT_KEYBOARD_STEP;
    onQueueSplitHeightChange?.(clampQueueSplitHeight(effectiveQueueSplitHeight + delta));
  };

  // When a different transcript loads, start at the bottom so the latest turn is
  // in view. useLayoutEffect runs before paint, so the pane never flashes at the
  // top first; the rAF re-assert catches the composer's reserved-space reflow.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    scrollToBottom();
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
  }, [agentId]);

  // Keep pinned to the bottom when new turns arrive or the composer grows (e.g. a
  // queued message), but only while the user is already near the bottom — instant,
  // so reading older turns is never interrupted.
  useLayoutEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom();
    }
  }, [turns, composerHeight, effectiveQueueSplitHeight, queueSplit, thinking]);

  // The composer normally floats over the transcript, so reserve scroll room
  // beneath the last message equal to the live input height. In split mode, also
  // measure the composer-only portion so the divider cannot be dragged down over it.
  useEffect(() => {
    const element = inputWrapRef.current;
    if (!element) {
      setComposerHeight(0);
      setComposerBaseHeight(0);
      return;
    }
    const measure = () => {
      setComposerHeight(element.offsetHeight);
      const composer = element.querySelector(".native-input-composer") as HTMLElement | null;
      const styles = window.getComputedStyle(element);
      const paddingY =
        Number.parseFloat(styles.paddingTop || "0") +
        Number.parseFloat(styles.paddingBottom || "0");
      setComposerBaseHeight((composer?.offsetHeight ?? 0) + paddingY);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const composer = element.querySelector(".native-input-composer");
    if (composer) {
      observer.observe(composer);
    }
    return () => observer.disconnect();
  }, [Boolean(input)]);

  useLayoutEffect(() => {
    if (!queueSplit || !onQueueSplitHeightChange) {
      return;
    }
    const clamped = clampQueueSplitHeight(queueSplitHeight ?? defaultQueueSplitHeight());
    if (queueSplitHeight !== clamped) {
      onQueueSplitHeightChange(clamped);
    }
    const sidebar = sidebarRef.current;
    if (!sidebar) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const next = clampQueueSplitHeight(queueSplitHeight ?? clamped);
      if (next !== queueSplitHeight) {
        onQueueSplitHeightChange(next);
      }
    });
    observer.observe(sidebar);
    return () => observer.disconnect();
    // The clamp intentionally depends on live measurements read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueSplit, queueSplitHeight, composerBaseHeight, agentId, Boolean(input)]);

  const timelineStyle: CSSProperties | undefined = queueSplit
    ? { bottom: effectiveQueueSplitHeight, paddingBottom: 10 }
    : composerHeight > 0
      ? { paddingBottom: composerHeight + COMPOSER_CLEARANCE }
      : undefined;
  const inputStyle: CSSProperties | undefined = queueSplit
    ? { height: effectiveQueueSplitHeight }
    : undefined;
  const splitBoundsNow = queueSplit ? splitBounds() : null;
  const timelineItems = useMemo(
    () => buildTimelineItems(turns, showActivityDetail),
    [turns, showActivityDetail],
  );

  // Cmd-F (macOS) / Ctrl-F opens the find bar for the active pane's transcript.
  // Captured on window because clicking transcript text leaves focus on <body>,
  // so a section-level key handler would never see the combo.
  useEffect(() => {
    if (!searchHotkeyActive) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const findCombo = IS_MAC
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        event.defaultPrevented ||
        !findCombo ||
        event.altKey ||
        (event.key !== "f" && event.key !== "F")
      ) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        // The terminal owns find while focused (xterm's handler opens its bar),
        // and editable fields outside this pane (ask modal, settings, Home)
        // keep the combo for themselves.
        if (target.closest(".terminal-mount")) {
          return;
        }
        if (!sidebarRef.current?.contains(target) && isEditableTarget(target)) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      // Refocus/select even when the bar is already open, matching the terminal.
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [searchHotkeyActive]);

  // Opening the bar focuses its input; a different transcript closes it.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchOpen]);

  useEffect(() => {
    setSearchOpen(false);
  }, [agentId]);

  // Expanding/collapsing a tool call or thinking block changes which text is
  // rendered, so rescan on any <details> toggle within the timeline. `toggle`
  // does not bubble, but capture listeners still see it.
  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const handleToggle = () => setSearchDomNonce((nonce) => nonce + 1);
    timeline.addEventListener("toggle", handleToggle, true);
    return () => timeline.removeEventListener("toggle", handleToggle, true);
  }, [searchOpen]);

  // Debounce the term into debouncedSearchTerm so the rescan below fires once typing
  // settles, not per keystroke. Clearing the term takes effect immediately (no scan
  // cost, and the user expects the highlights gone at once).
  useEffect(() => {
    if (searchTerm === "") {
      setDebouncedSearchTerm("");
      return;
    }
    const handle = window.setTimeout(() => setDebouncedSearchTerm(searchTerm), 120);
    return () => window.clearTimeout(handle);
  }, [searchTerm]);

  // Rescan whenever the debounced term/options change or the rendered timeline does
  // (new turns, toggled details). Runs after the DOM commit, so ranges are built over
  // current text nodes. The active match snaps to the one nearest the viewport, so
  // typing refines the term without yanking the view to the top.
  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const ranges =
      debouncedSearchTerm === ""
        ? []
        : collectSearchRanges(timeline, debouncedSearchTerm, {
            caseSensitive: searchCaseSensitive,
            regex: searchUseRegex,
          });
    searchRangesRef.current = ranges;
    setSearchResults({ index: nearestSearchRangeIndex(timeline, ranges), count: ranges.length });
  }, [
    searchOpen,
    debouncedSearchTerm,
    searchCaseSensitive,
    searchUseRegex,
    timelineItems,
    searchDomNonce,
  ]);

  // Repaint highlights and bring the active match into view on every result change.
  // Only the active pane paints: the highlight registry has one slot per name, so in
  // split view two open find bars would otherwise overwrite and clear each other's
  // highlights. An inactive (or closed) bar releases its paint but still navigates by
  // scrolling. Closing the bar or unmounting clears our own highlights.
  useEffect(() => {
    const owner = searchOwnerRef.current;
    if (!searchOpen || !searchHotkeyActive) {
      clearSearchHighlights(owner);
      return;
    }
    const ranges = searchRangesRef.current;
    applySearchHighlights(owner, ranges, searchResults.index);
    const active = ranges[searchResults.index];
    const timeline = timelineRef.current;
    if (active && timeline) {
      scrollSearchRangeIntoView(timeline, active);
    }
    return () => clearSearchHighlights(owner);
  }, [searchOpen, searchHotkeyActive, searchResults]);

  const stepSearch = (delta: 1 | -1) => {
    setSearchResults((current) => {
      if (current.count === 0) {
        return current;
      }
      return { ...current, index: (current.index + delta + current.count) % current.count };
    });
  };

  return (
    <LinkActionsContext.Provider value={linkActions}>
    <section
      ref={sidebarRef}
      className={`turn-sidebar${header ? " has-header" : ""}${queueSplit ? " has-queue-split" : ""}`}
      aria-label="Agent turns"
      // Listen on the whole pane, not just the timeline, so a selection that starts
      // in a message but is released over the composer below still registers. The
      // Ask popup is portaled outside this section, so clicking it can't re-fire.
      onMouseUp={handleSelectionMouseUp}
    >
      {header}
      {searchOpen ? (
        <PaneSearchBar
          inputRef={searchInputRef}
          placeholder="Find in transcript"
          term={searchTerm}
          onTermChange={setSearchTerm}
          matchIndex={searchResults.index}
          matchCount={searchResults.count}
          caseSensitive={searchCaseSensitive}
          onCaseSensitiveChange={setSearchCaseSensitive}
          useRegex={searchUseRegex}
          onUseRegexChange={setSearchUseRegex}
          onFindNext={() => stepSearch(1)}
          onFindPrevious={() => stepSearch(-1)}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {queueSplit ? (
        <div
          className="turn-queue-resizer"
          role="separator"
          aria-label="Resize queue split"
          aria-orientation="horizontal"
          aria-valuemin={splitBoundsNow?.min ?? 0}
          aria-valuemax={splitBoundsNow?.max ?? 0}
          aria-valuenow={effectiveQueueSplitHeight}
          tabIndex={0}
          style={{ bottom: effectiveQueueSplitHeight - QUEUE_SPLIT_RESIZER_HALF_HEIGHT }}
          onPointerDown={startQueueSplitResize}
          onPointerMove={moveQueueSplitResize}
          onPointerUp={endQueueSplitResize}
          onPointerCancel={endQueueSplitResize}
          onKeyDown={resizeQueueSplitWithKeyboard}
        />
      ) : null}
      <div
        ref={timelineRef}
        className={`turn-timeline${timelineItems.length === 0 && !thinking ? " is-empty" : ""}`}
        style={timelineStyle}
        onScroll={handleTimelineScroll}
      >
        {timelineItems.length === 0 && !thinking ? (
          <div className="empty-state turn-empty-state">
            <span>No activity yet</span>
            {notice === "Transcript unavailable" && onSelectTranscript ? (
              <TranscriptPickerLink
                options={transcriptOptions}
                activePath={transcriptPath}
                onSelect={onSelectTranscript}
              />
            ) : (
              <span className="turn-empty-notice">Send a message to continue</span>
            )}
          </div>
        ) : (
          timelineItems.map((item, index) => {
            // A continued agent turn — agent text, then a tool-call group, then
            // more agent text — is still the same speaker, so drop the repeated
            // name on the continuation. (Consecutive agent messages only stay
            // separate when activities sit between them; see buildTimelineItems.)
            const previous = timelineItems[index - 1];
            const showName = !(
              item.role === "assistant" &&
              previous?.role === "assistant" &&
              previous.blocks.length > 0 &&
              hasToolCall(previous)
            );
            return (
              <MessageTimelineItemView
                key={item.key}
                item={item}
                assistantLabel={assistantLabel}
                showName={showName}
                titleGenerationEnabled={titleGenerationEnabled}
                onRegenerateTitleFromUserMessage={handleRegenerateTitleFromUserMessage}
                titleGenerationBusy={titleGenerationBusy}
              />
            );
          })
        )}
        {thinking ? (
          <div className="turn-thinking" aria-live="polite">
            <span className="turn-thinking-dot" aria-hidden="true" />
            <span className="turn-thinking-label">{thinkingLabel}</span>
          </div>
        ) : null}
      </div>
      {input ? (
        <div
          className={`turn-sidebar-input${queueSplit ? " is-split" : ""}`}
          ref={inputWrapRef}
          style={inputStyle}
        >
          <div className="turn-sidebar-input-rail">{input}</div>
        </div>
      ) : null}
    </section>
    </LinkActionsContext.Provider>
  );
}

function buildTimelineItems(turns: Turn[], showActivityDetail = true): MessageItem[] {
  const items: MessageItem[] = [];
  // Tool calls awaiting a result, in arrival order. A result matches by tool-use
  // id when both sides carry one, otherwise it falls back to the oldest pending
  // call — either way the call and its result collapse into a single row.
  const pending: ToolEntry[] = [];
  let sequence = 0;

  const nextKey = (prefix: string) => `${prefix}-${sequence++}`;

  const createMessageItem = (
    role: string,
    block?: MessageBlock,
    status?: TurnTimelineStatus,
  ): MessageItem => ({
    type: "message",
    key: nextKey(`message-${role}`),
    role,
    blocks: block ? [block] : [],
    activities: [],
    status,
  });

  const pushMessageBlock = (role: string, block: MessageBlock, status?: TurnTimelineStatus) => {
    const previous = items[items.length - 1];
    if (previous?.role === role && previous.status === status && previous.activities.length === 0) {
      previous.blocks.push(block);
      return;
    }
    items.push(createMessageItem(role, block, status));
  };

  const assistantActivityOwner = (status?: TurnTimelineStatus) => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].role === "assistant" && items[index].status === status) {
        return items[index];
      }
    }
    const fallback = createMessageItem("assistant", undefined, status);
    items.push(fallback);
    return fallback;
  };

  const pushThinkingValue = (value: unknown, status?: TurnTimelineStatus) => {
    const owner = assistantActivityOwner(status);
    const previousActivity = owner.activities[owner.activities.length - 1];
    if (previousActivity?.type === "thinking" && previousActivity.status === status) {
      previousActivity.values.push(value);
      return;
    }
    owner.activities.push({
      type: "thinking",
      key: nextKey("thinking"),
      values: [value],
      status,
    });
  };

  const pushToolEntry = (entry: ToolEntry, status?: TurnTimelineStatus) => {
    assistantActivityOwner(status).activities.push(entry);
  };

  const registerToolUse = (block: ToolUseBlock, status?: TurnTimelineStatus) => {
    const entry: ToolEntry = {
      type: "tool",
      key: nextKey("tool"),
      id: block.id ?? null,
      name: block.name,
      input: block.input,
      isError: false,
      status,
    };
    pushToolEntry(entry, status);
    pending.push(entry);
  };

  const attachToolResult = (block: ToolResultBlock, status?: TurnTimelineStatus) => {
    const toolUseId = block.toolUseId ?? null;

    // Prefer an exact tool-use id match; otherwise fall back to the oldest pending
    // call so mismatched or absent ids still collapse the result into its call.
    let index = toolUseId
      ? pending.findIndex((entry) => entry.id === toolUseId && entry.status === status)
      : -1;
    if (index === -1 && pending.length > 0) {
      index = pending.findIndex((entry) => entry.status === status);
    }

    if (index !== -1) {
      const [entry] = pending.splice(index, 1);
      entry.result = block.content;
      entry.isError = block.isError;
      return;
    }

    // A result with no pending call at all — surface it on its own row.
    pushToolEntry({
      type: "tool",
      key: nextKey("tool-result"),
      id: toolUseId,
      name: block.isError ? "Tool error" : "Tool result",
      result: block.content,
      isError: block.isError,
      status,
    }, status);
  };

  for (const turn of turns) {
    const status = timelineStatus(turn.status);
    for (const block of turn.blocks) {
      switch (block.type) {
        case "text":
          pushMessageBlock(turn.role, block, status);
          break;
        case "toolUse":
          if (showActivityDetail) {
            registerToolUse(block, status);
          }
          break;
        case "toolResult":
          if (showActivityDetail) {
            attachToolResult(block, status);
          }
          break;
        case "raw":
          if (turn.role === "assistant") {
            if (showActivityDetail) {
              pushThinkingValue(block.value, status);
            }
          } else {
            pushMessageBlock(turn.role, block, status);
          }
          break;
      }
    }
  }

  return items.map((item) => ({
    ...item,
    activities: groupActivityItems(item.activities),
  }));
}

function groupActivityItems(activities: ActivityItem[]): ActivityItem[] {
  if (activities.length <= 1) {
    return activities;
  }

  const children = activities.filter(isActivityLeafItem);
  if (children.length <= 1) {
    return activities;
  }

  return [
    {
      type: "activityGroup",
      key: `activity-group-${children[0].key}`,
      children,
      toolCallCount: countUniqueToolCalls(children),
      status: commonActivityStatus(children),
    },
  ];
}

function isActivityLeafItem(item: ActivityItem): item is ActivityLeafItem {
  return item.type === "tool" || item.type === "thinking";
}

function countUniqueToolCalls(items: ActivityLeafItem[]) {
  const counted = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool") {
      continue;
    }
    counted.add(item.id ? `id:${item.id}` : `entry:${item.key}`);
  }
  return counted.size;
}

function commonActivityStatus(items: ActivityLeafItem[]): TurnTimelineStatus | undefined {
  const [first] = items;
  if (!first?.status) {
    return undefined;
  }
  return items.every((item) => item.status === first.status) ? first.status : undefined;
}

function timelineStatus(status: Turn["status"]): TurnTimelineStatus | undefined {
  return status === "superseded" || status === "interrupted" || status === "uncertain"
    ? status
    : undefined;
}

function turnStatusClass(status: TurnTimelineStatus | undefined) {
  return status ? ` is-status-${status}` : "";
}

function uniqueToolEntries(items: ActivityLeafItem[]) {
  const seen = new Set<string>();
  const entries: ToolEntry[] = [];
  for (const item of items) {
    if (item.type !== "tool") {
      continue;
    }
    const key = item.id ? `id:${item.id}` : `entry:${item.key}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(item);
  }
  return entries;
}

// Memoized on the item: buildTimelineItems is itself memoized on `turns`, so item
// references are stable while turns are unchanged. That lets a re-render driven by
// something else (e.g. each composer keystroke, which lives in a parent) skip
// re-rendering — and re-running ReactMarkdown over — the whole timeline.
const MessageTimelineItemView = memo(function MessageTimelineItemView({
  item,
  assistantLabel,
  showName,
  titleGenerationEnabled,
  onRegenerateTitleFromUserMessage,
  titleGenerationBusy,
}: {
  item: MessageItem;
  assistantLabel: string;
  showName: boolean;
  titleGenerationEnabled: boolean;
  onRegenerateTitleFromUserMessage: (message: string) => void;
  titleGenerationBusy: boolean;
}) {
  return (
    <>
      {item.blocks.length > 0 ? (
        <MessageItemView
          item={item}
          assistantLabel={assistantLabel}
          showName={showName}
          titleGenerationEnabled={titleGenerationEnabled}
          onRegenerateTitleFromUserMessage={onRegenerateTitleFromUserMessage}
          titleGenerationBusy={titleGenerationBusy}
        />
      ) : null}
      {item.activities.map((activity) => (
        <ActivityItemView key={activity.key} item={activity} isRootActivity />
      ))}
    </>
  );
});

function MessageItemView({
  item,
  assistantLabel,
  showName,
  titleGenerationEnabled,
  onRegenerateTitleFromUserMessage,
  titleGenerationBusy,
}: {
  item: MessageItem;
  assistantLabel: string;
  showName: boolean;
  titleGenerationEnabled: boolean;
  onRegenerateTitleFromUserMessage: (message: string) => void;
  titleGenerationBusy: boolean;
}) {
  const taggedInstructionMessage = messageItemIsTaggedInstruction(item);
  const titleSourceText =
    item.role === "user" && titleGenerationEnabled ? messageItemText(item) : null;
  const showTitleAction = Boolean(showName && !taggedInstructionMessage && titleSourceText);
  return (
    <article
      className={`turn-card role-${item.role}${
        taggedInstructionMessage ? " is-tagged-instruction-message" : ""
      }${turnStatusClass(item.status)}`}
    >
      {showName && !taggedInstructionMessage ? (
        <header>
          <span className="turn-card-role-label">{turnRoleLabel(item.role, assistantLabel)}</span>
          {showTitleAction && titleSourceText ? (
            <MessageTitleMenu
              titleSourceText={titleSourceText}
              titleGenerationBusy={titleGenerationBusy}
              onRegenerateTitleFromUserMessage={onRegenerateTitleFromUserMessage}
            />
          ) : null}
        </header>
      ) : null}
      <div className="turn-blocks">
        {item.blocks.map((block, index) => (
          <MessageBlockView key={`${item.key}-${index}`} block={block} role={item.role} />
        ))}
      </div>
    </article>
  );
}

// The "..." menu shown at the right of a user message header. Opens a small popover
// with actions for this message: regenerate the tab title from it, or copy its text.
function MessageTitleMenu({
  titleSourceText,
  titleGenerationBusy,
  onRegenerateTitleFromUserMessage,
}: {
  titleSourceText: string;
  titleGenerationBusy: boolean;
  onRegenerateTitleFromUserMessage: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <span ref={containerRef} className="turn-title-menu">
      <button
        type="button"
        className="turn-title-regenerate-button"
        title="Title options"
        aria-label="Title options"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="turn-title-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            className="turn-title-menu-item"
            disabled={titleGenerationBusy}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onRegenerateTitleFromUserMessage?.(titleSourceText);
            }}
          >
            {titleGenerationBusy ? "Regenerating title…" : "Regenerate title"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="turn-title-menu-item"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              void writeClipboardText(titleSourceText);
            }}
          >
            Copy message
          </button>
        </div>
      ) : null}
    </span>
  );
}

function messageItemText(item: MessageItem): string | null {
  const text = item.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  return text.trim() ? text : null;
}

function messageItemIsTaggedInstruction(item: MessageItem) {
  if (item.role !== "user" || item.blocks.length !== 1) {
    return false;
  }
  const [block] = item.blocks;
  return block.type === "text" && taggedUserInstructionDetails(block.text) !== null;
}

// True when the item carries a tool call (a tool row, or a tool inside a grouped
// activity) — used to spot a continued agent turn whose name should be dropped.
function hasToolCall(item: MessageItem): boolean {
  return item.activities.some(
    (activity) =>
      activity.type === "tool" ||
      (activity.type === "activityGroup" &&
        activity.children.some((child) => child.type === "tool")),
  );
}

function turnRoleLabel(role: string, assistantLabel: string) {
  if (role === "assistant") {
    return assistantLabel;
  }
  if (role === "system") {
    return "System";
  }
  return role;
}

function ActivityItemView({
  item,
  isRootActivity = false,
}: {
  item: ActivityItem;
  isRootActivity?: boolean;
}) {
  switch (item.type) {
    case "tool":
      return <ToolEntryView entry={item} showChevron={!isRootActivity} />;
    case "thinking":
      return <ThinkingView item={item} showChevron={!isRootActivity} />;
    case "activityGroup":
      return <ActivityGroupView group={item} showChevron={!isRootActivity} />;
  }
}

function ActivityGroupView({
  group,
  showChevron,
}: {
  group: ActivityGroupItem;
  showChevron: boolean;
}) {
  return (
    <details
      className={`activity-group-block${showChevron ? "" : " is-root-activity"}${turnStatusClass(
        group.status,
      )}`}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span
          className={`activity-group-label ${
            group.toolCallCount > 0 ? "is-tool-group" : "is-thinking-group"
          }`}
        >
          {activityGroupLabel(group)}
        </span>
      </summary>
      <div className="activity-group-children">
        {group.children.map((child) => (
          <ActivityItemView key={child.key} item={child} />
        ))}
      </div>
    </details>
  );
}

function activityGroupLabel(group: ActivityGroupItem) {
  const entries = uniqueToolEntries(group.children);
  if (entries.length === 0) {
    return "Thought for a while";
  }
  return toolActionGroupLabel(entries) ?? calledToolsLabel(group.toolCallCount);
}

function toolActionGroupLabel(entries: ToolEntry[]) {
  const counts: Record<ToolActionKind, number> = {
    readFile: 0,
    editFile: 0,
    runCommand: 0,
  };
  let unknownCount = 0;

  for (const entry of entries) {
    const kind = classifyToolAction(entry);
    if (kind) {
      counts[kind] += 1;
    } else {
      unknownCount += 1;
    }
  }

  const recognizedCount = counts.readFile + counts.editFile + counts.runCommand;
  if (recognizedCount === 0) {
    return null;
  }

  const parts = [
    fileActionLabel("read", counts.readFile),
    fileActionLabel("edited", counts.editFile),
    commandActionLabel(counts.runCommand),
    unknownCount > 0
      ? `called ${unknownCount} other tool${unknownCount === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => Boolean(part));
  return capitalizeSentence(parts.join(", "));
}

function classifyToolAction(entry: ToolEntry): ToolActionKind | null {
  const name = normalizedToolName(entry.name);
  for (const [kind, names] of Object.entries(TOOL_ACTION_NAMES) as [
    ToolActionKind,
    ReadonlySet<string>,
  ][]) {
    if (names.has(name)) {
      return kind;
    }
  }
  return null;
}

function normalizedToolName(name: string) {
  const raw = name.trim();
  const dotted = raw.includes(".") ? (raw.split(".").pop() ?? raw) : raw;
  const namespaced = dotted.includes("__") ? (dotted.split("__").pop() ?? dotted) : dotted;
  return namespaced.replace(/[\s-]+/g, "_").toLowerCase();
}

function fileActionLabel(verb: "read" | "edited", count: number) {
  if (count === 0) {
    return null;
  }
  return count === 1 ? `${verb} a file` : `${verb} files`;
}

function commandActionLabel(count: number) {
  if (count === 0) {
    return null;
  }
  return count === 1 ? "ran a command" : `ran ${count} commands`;
}

function calledToolsLabel(count: number) {
  return `Called ${count} tool${count === 1 ? "" : "s"}`;
}

function capitalizeSentence(label: string) {
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function MessageBlockView({ block, role }: { block: MessageBlock; role: string }) {
  if (block.type === "text") {
    if (role !== "assistant") {
      const taggedInstruction =
        role === "user" ? taggedUserInstructionDetails(block.text) : null;
      if (taggedInstruction) {
        return (
          <CollapsedTaggedUserInstruction label={taggedInstruction.label} text={block.text} />
        );
      }
      if (role === "user" && block.text.length > LONG_USER_MESSAGE_COLLAPSE_THRESHOLD) {
        return <CollapsedUserText text={block.text} />;
      }
      return <p className="turn-text">{block.text}</p>;
    }
    return (
      <div className="turn-markdown">
        <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm, remarkBreaks]}>
          {block.text}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <details className="tool-block">
      <summary>
        <DisclosureChevron />
        <span>Raw</span>
      </summary>
      <pre>{stringify(block.value)}</pre>
    </details>
  );
}

function CollapsedTaggedUserInstruction({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const title = expanded ? `Collapse ${label}` : `Show ${label}`;

  return (
    <div className={`tagged-user-instruction${expanded ? " is-expanded" : " is-collapsed"}`}>
      <button
        type="button"
        className="tagged-user-instruction-toggle"
        aria-expanded={expanded}
        title={title}
        onClick={() => setExpanded((current) => !current)}
      >
        {label}
      </button>
      {expanded ? <p className="turn-text is-tagged-instruction">{text}</p> : null}
    </div>
  );
}

function CollapsedUserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => collapsedUserTextPreview(text), [text]);
  const sizeLabel = formatCharacterSize(text.length);

  return (
    <div className="long-user-message">
      <button
        type="button"
        className="long-user-message-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <DisclosureChevron />
        <span>{expanded ? "Collapse long message" : "Expand long message"}</span>
        <span className="long-user-message-size">{sizeLabel}</span>
      </button>
      {expanded ? (
        <p className="turn-text">{text}</p>
      ) : (
        <p className="long-user-message-preview">{preview}</p>
      )}
    </div>
  );
}

function collapsedUserTextPreview(text: string) {
  const trimmedPreview = text.slice(0, LONG_USER_MESSAGE_PREVIEW_CHARS).trimEnd();
  return `${trimmedPreview}\n...`;
}

function formatCharacterSize(characters: number) {
  if (characters < 1_000) {
    return `${characters} chars`;
  }
  if (characters < 100_000) {
    return `${(characters / 1_000).toFixed(1)}k chars`;
  }
  return `${Math.round(characters / 1_000)}k chars`;
}

function ToolEntryView({
  entry,
  showChevron,
}: {
  entry: ToolEntry;
  showChevron: boolean;
}) {
  const summaryArgument = toolSummaryArgument(entry);
  const toolNameLabel = showChevron ? entry.name : `Called ${entry.name}`;
  const summaryLabel = summaryArgument ? `${toolNameLabel} ${summaryArgument}` : toolNameLabel;
  return (
    <details
      className={`tool-block tool-pair${entry.isError ? " is-error" : ""}${
        showChevron ? "" : " is-root-activity"
      }${turnStatusClass(entry.status)}`}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span className="tool-summary">
          <span className="tool-summary-main" title={summaryLabel}>
            <span>{toolNameLabel}</span>
            {summaryArgument ? <span className="tool-summary-arg"> {summaryArgument}</span> : null}
          </span>
          <ToolEntryStatus entry={entry} showCharCount={showChevron} />
        </span>
      </summary>
      {entry.input !== undefined ? <ToolPayload label="Input" value={entry.input} /> : null}
      {entry.result !== undefined ? (
        <ToolPayload label={entry.isError ? "Error" : "Result"} value={entry.result} />
      ) : null}
    </details>
  );
}

function toolSummaryArgument(entry: ToolEntry) {
  const key =
    TOOL_SUMMARY_ARGUMENT_KEYS[entry.name as keyof typeof TOOL_SUMMARY_ARGUMENT_KEYS] ?? null;
  if (!key) {
    return null;
  }
  const input = objectValue(entry.input);
  if (!input) {
    return null;
  }
  return inlineSummaryValue(input[key]);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inlineSummaryValue(value: unknown) {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="tool-payload">
      <div className="tool-payload-label">{label}</div>
      <pre>{stringify(value)}</pre>
    </div>
  );
}

function ThinkingView({
  item,
  showChevron,
}: {
  item: ThinkingItem;
  showChevron: boolean;
}) {
  return (
    <details
      className={`thinking-block${showChevron ? "" : " is-root-activity"}${turnStatusClass(
        item.status,
      )}`}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span>Thought for a while</span>
      </summary>
      {item.values.map((value, index) => (
        <pre key={`${item.key}-${index}`}>{stringify(value)}</pre>
      ))}
    </details>
  );
}

function DisclosureChevron() {
  return <ChevronRight className="disclosure-chevron" size={12} aria-hidden="true" />;
}

function ToolEntryStatus({
  entry,
  showCharCount,
}: {
  entry: ToolEntry;
  showCharCount: boolean;
}) {
  if (entry.result === undefined) {
    return <span className="tool-summary-meta">running</span>;
  }
  if (!showCharCount) {
    return entry.isError ? <span className="tool-summary-meta">error</span> : null;
  }
  const charCount = `${stringify(entry.result).length} chars`;
  if (entry.isError) {
    return <span className="tool-summary-meta">error, {charCount}</span>;
  }
  return <span className="tool-summary-meta">{charCount}</span>;
}

function formatTurnTranscript(turn: Turn, assistantLabel: string) {
  return [turnRoleLabel(turn.role, assistantLabel), ...turn.blocks.map(formatTurnBlockTranscript)]
    .join("\n")
    .trimEnd();
}

function formatTurnBlockTranscript(block: TurnBlock) {
  switch (block.type) {
    case "text":
      return block.text;
    case "toolUse":
      return formatLabeledBlock(block.name, block.input);
    case "toolResult":
      return formatLabeledBlock(block.isError ? "Tool error" : "Tool result", block.content);
    case "raw":
      return formatLabeledBlock("Raw", block.value);
  }
}

function formatLabeledBlock(label: string, value: unknown) {
  const content = stringify(value);
  return content ? `${label}\n${content}` : label;
}

function stringify(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}
