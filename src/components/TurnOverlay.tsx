import {
  createContext,
  memo,
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
  ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Turn, TurnBlock, TranscriptOption } from "../types";
import type { SelectionAnchor } from "../appTypes";
import { isTaggedUserInstruction } from "../lib/taggedInstructions";
import TranscriptPickerLink from "./TranscriptPickerLink";

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
  // When true, the agent is actively working, so a "Thinking…" indicator is pinned
  // to the bottom of the transcript. Driven by live status transitions upstream, so
  // an agent merely restored into a working status does not light it up.
  thinking?: boolean;
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

interface MessageItem {
  type: "message";
  key: string;
  role: string;
  blocks: MessageBlock[];
  activities: ActivityItem[];
}

interface ToolEntry {
  type: "tool";
  key: string;
  id?: string | null;
  name: string;
  input?: unknown;
  result?: unknown;
  isError: boolean;
}

type ToolActionKind = keyof typeof TOOL_ACTION_NAMES;

interface ThinkingItem {
  type: "thinking";
  key: string;
  values: unknown[];
}

interface ActivityGroupItem {
  type: "activityGroup";
  key: string;
  children: ActivityLeafItem[];
  toolCallCount: number;
}

type ActivityLeafItem = ToolEntry | ThinkingItem;
type ActivityItem = ActivityLeafItem | ActivityGroupItem;

// Only let links through that the webview can safely open. Transcript markdown is
// untrusted (an agent emits arbitrary text, and the picker can repoint to arbitrary
// session files), and a javascript:/file:/tauri: URL clicked inside the Tauri
// webview reaches a JS context with access to native IPC. Anything that isn't
// http/https/mailto is rendered as plain, non-navigable text.
function safeHref(href: unknown): string | undefined {
  if (typeof href !== "string") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(href, "https://qmux.invalid/");
  } catch {
    return undefined;
  }
  // Return the resolved absolute URL, not the raw href: a relative ("/path") or
  // protocol-relative ("//host") href passes the protocol check once resolved
  // against the base, but handing the raw string downstream would let it resolve
  // unpredictably. Normalizing here means openLink always receives a fully
  // qualified http(s)/mailto URL.
  return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
    ? url.href
    : undefined;
}

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

const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) => <MarkdownLink href={href} {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="turn-markdown-table-wrap">
      <table {...props} />
    </div>
  ),
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
}: TurnOverlayProps) {
  const sidebarRef = useRef<HTMLElement | null>(null);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

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
  const timelineItems = useMemo(() => buildTimelineItems(turns), [turns]);

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
        className={`turn-timeline${timelineItems.length === 0 ? " is-empty" : ""}`}
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
            ) : notice ? (
              <span className="turn-empty-notice">{notice}</span>
            ) : null}
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
              />
            );
          })
        )}
        {thinking ? (
          <div className="turn-thinking" aria-live="polite">
            <span className="turn-thinking-dot" aria-hidden="true" />
            <span className="turn-thinking-label">Thinking…</span>
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

function buildTimelineItems(turns: Turn[]): MessageItem[] {
  const items: MessageItem[] = [];
  // Tool calls awaiting a result, in arrival order. A result matches by tool-use
  // id when both sides carry one, otherwise it falls back to the oldest pending
  // call — either way the call and its result collapse into a single row.
  const pending: ToolEntry[] = [];
  let sequence = 0;

  const nextKey = (prefix: string) => `${prefix}-${sequence++}`;

  const createMessageItem = (role: string, block?: MessageBlock): MessageItem => ({
    type: "message",
    key: nextKey(`message-${role}`),
    role,
    blocks: block ? [block] : [],
    activities: [],
  });

  const pushMessageBlock = (role: string, block: MessageBlock) => {
    const previous = items[items.length - 1];
    if (previous?.role === role && previous.activities.length === 0) {
      previous.blocks.push(block);
      return;
    }
    items.push(createMessageItem(role, block));
  };

  const assistantActivityOwner = () => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].role === "assistant") {
        return items[index];
      }
    }
    const fallback = createMessageItem("assistant");
    items.push(fallback);
    return fallback;
  };

  const pushThinkingValue = (value: unknown) => {
    const owner = assistantActivityOwner();
    const previousActivity = owner.activities[owner.activities.length - 1];
    if (previousActivity?.type === "thinking") {
      previousActivity.values.push(value);
      return;
    }
    owner.activities.push({
      type: "thinking",
      key: nextKey("thinking"),
      values: [value],
    });
  };

  const pushToolEntry = (entry: ToolEntry) => {
    assistantActivityOwner().activities.push(entry);
  };

  const registerToolUse = (block: ToolUseBlock) => {
    const entry: ToolEntry = {
      type: "tool",
      key: nextKey("tool"),
      id: block.id ?? null,
      name: block.name,
      input: block.input,
      isError: false,
    };
    pushToolEntry(entry);
    pending.push(entry);
  };

  const attachToolResult = (block: ToolResultBlock) => {
    const toolUseId = block.toolUseId ?? null;

    // Prefer an exact tool-use id match; otherwise fall back to the oldest pending
    // call so mismatched or absent ids still collapse the result into its call.
    let index = toolUseId ? pending.findIndex((entry) => entry.id === toolUseId) : -1;
    if (index === -1 && pending.length > 0) {
      index = 0;
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
    });
  };

  for (const turn of turns) {
    for (const block of turn.blocks) {
      switch (block.type) {
        case "text":
          pushMessageBlock(turn.role, block);
          break;
        case "toolUse":
          registerToolUse(block);
          break;
        case "toolResult":
          attachToolResult(block);
          break;
        case "raw":
          if (turn.role === "assistant") {
            pushThinkingValue(block.value);
          } else {
            pushMessageBlock(turn.role, block);
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
}: {
  item: MessageItem;
  assistantLabel: string;
  showName: boolean;
}) {
  return (
    <>
      {item.blocks.length > 0 ? (
        <MessageItemView item={item} assistantLabel={assistantLabel} showName={showName} />
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
}: {
  item: MessageItem;
  assistantLabel: string;
  showName: boolean;
}) {
  return (
    <article className={`turn-card role-${item.role}`}>
      {showName ? <header>{turnRoleLabel(item.role, assistantLabel)}</header> : null}
      <div className="turn-blocks">
        {item.blocks.map((block, index) => (
          <MessageBlockView key={`${item.key}-${index}`} block={block} role={item.role} />
        ))}
      </div>
    </article>
  );
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
  return role === "assistant" ? assistantLabel : role;
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
    <details className={`activity-group-block${showChevron ? "" : " is-root-activity"}`}>
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
    return "Thinking...";
  }
  return toolActionGroupLabel(entries) ?? usedToolsLabel(group.toolCallCount);
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
    unknownCount > 0 ? `used ${unknownCount} other tool${unknownCount === 1 ? "" : "s"}` : null,
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

function usedToolsLabel(count: number) {
  return `Used ${count} tool${count === 1 ? "" : "s"}`;
}

function capitalizeSentence(label: string) {
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function MessageBlockView({ block, role }: { block: MessageBlock; role: string }) {
  if (block.type === "text") {
    if (role !== "assistant") {
      const muted = role === "user" && isTaggedUserInstruction(block.text);
      return <p className={`turn-text${muted ? " is-tagged-instruction" : ""}`}>{block.text}</p>;
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

function ToolEntryView({
  entry,
  showChevron,
}: {
  entry: ToolEntry;
  showChevron: boolean;
}) {
  const summaryArgument = toolSummaryArgument(entry);
  const toolNameLabel = showChevron ? entry.name : `Used ${entry.name}`;
  const summaryLabel = summaryArgument ? `${toolNameLabel} ${summaryArgument}` : toolNameLabel;
  return (
    <details
      className={`tool-block tool-pair${entry.isError ? " is-error" : ""}${showChevron ? "" : " is-root-activity"}`}
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
    <details className={`thinking-block${showChevron ? "" : " is-root-activity"}`}>
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span>Thinking...</span>
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
