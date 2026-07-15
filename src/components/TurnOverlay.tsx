import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import type { ThreadParticipant, Turn, TurnBlock, TranscriptOption } from "../types";
import {
  placePanePopover,
  turnPaneRectFrom,
} from "../lib/appHelpers";
import { claimNativeTerminalPointerForWebDrag } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { requestSaveDraftAsPrompt } from "../lib/promptLibrary";
import {
  stripTaggedUserInstructionBlocks,
  taggedUserInstructionDetails,
} from "../lib/taggedInstructions";
import {
  buildTimelineItems,
  hasToolCall,
  messageItemIsTaggedInstruction,
  messageItemText,
  sameMessageItem,
} from "../lib/turnTimeline";
import type { MessageBlock, MessageItem } from "../lib/turnTimeline";
import DomSearchBar from "./DomSearchBar";
import TranscriptPickerLink from "./TranscriptPickerLink";
import TranscriptMarkdown, {
  TranscriptLinkActionsProvider,
  type LinkActions,
  type OversizedMarkdownPolicy,
} from "./TranscriptMarkdown";
import {
  DisclosureChevron,
  RawTranscriptDisclosure,
  TranscriptActivityItem,
  timelineStatusClass,
} from "./TranscriptActivity";

export type { LinkActions } from "./TranscriptMarkdown";

interface TurnOverlayProps {
  turns: Turn[];
  assistantLabel: string;
  // Top bar pinned across the top of the pane (session id + fork/browser controls).
  header?: ReactNode;
  input?: ReactNode;
  // Identifies the agent whose transcript is shown; a change means a different
  // transcript loaded, which is when we jump the view to the latest turn.
  agentId?: string;
  // Identifies the prompt-library listener that can handle "save message as
  // prompt" requests. Unlike agentId, this is absent for detached transcripts.
  savePromptAgentId?: string | null;
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
  // When true, the agent is actively working, so a "Working…" indicator is pinned
  // to the bottom of the transcript. Driven by live status transitions upstream, so
  // an agent merely restored into a working status does not light it up.
  thinking?: boolean;
  thinkingLabel?: string;
  // Code-mode transcript detail: when false, hide historical tool/thinking
  // activity from the visible transcript while keeping normal messages.
  showActivityDetail?: boolean;
  // When false, the latest user message never pins to the top of the pane —
  // it scrolls with the rest of the transcript (Settings → sticky messages).
  stickyUserMessages?: boolean;
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
// Assistant messages past this size render as plain preformatted text instead
// of markdown (same limit as research documents): react-markdown re-parses the
// whole message on every streamed append, so a pathological multi-hundred-KB
// message would otherwise stall the stream per event batch. Hoisted so the
// memoized renderer sees a stable prop identity.
const OVERSIZED_ASSISTANT_MARKDOWN: OversizedMarkdownPolicy = {
  maxCharacters: 100_000,
  fallbackClassName: "turn-text",
};
// A pinned last-user-message taller than this share of the pane would blanket
// the reply scrolling beneath it, so sticking is disabled for tall bubbles.
const STICKY_USER_MAX_HEIGHT_RATIO = 0.4;
interface QueueSplitDrag {
  pointerId: number;
  startY: number;
  startHeight: number;
}

export function formatTurnsTranscript(turns: Turn[], assistantLabel: string) {
  return turns.map((turn) => formatTurnTranscript(turn, assistantLabel)).join("\n\n");
}

export default function TurnOverlay({
  turns,
  assistantLabel,
  header,
  input,
  agentId,
  savePromptAgentId,
  notice,
  transcriptOptions = [],
  transcriptPath = null,
  onSelectTranscript,
  queueSplit = false,
  queueSplitHeight,
  onQueueSplitHeightChange,
  linkActions,
  thinking = false,
  thinkingLabel = "Working…",
  showActivityDetail = true,
  stickyUserMessages = true,
  onRegenerateTitleFromUserMessage,
  titleGenerationBusy = false,
  searchHotkeyActive = false,
}: TurnOverlayProps) {
  const sidebarRef = useRef<HTMLElement | null>(null);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  // Zero-height marker after the last timeline row; see the observer effect below.
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const regenerateTitleFromUserMessageRef = useRef(onRegenerateTitleFromUserMessage);
  regenerateTitleFromUserMessageRef.current = onRegenerateTitleFromUserMessage;
  const titleGenerationEnabled = Boolean(onRegenerateTitleFromUserMessage);
  const handleRegenerateTitleFromUserMessage = useCallback((message: string) => {
    regenerateTitleFromUserMessageRef.current?.(message);
  }, []);

  const queueSplitDragRef = useRef<QueueSplitDrag | null>(null);
  const queueSplitPointerReleaseRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!queueSplit) {
      queueSplitDragRef.current = null;
      queueSplitPointerReleaseRef.current?.();
      queueSplitPointerReleaseRef.current = null;
    }
  }, [queueSplit]);
  useEffect(
    () => () => {
      queueSplitPointerReleaseRef.current?.();
      queueSplitPointerReleaseRef.current = null;
    },
    [],
  );
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
    // The stick-to-bottom ref must update synchronously (layout effects read it
    // on the very next commit); the sticky-message geometry can wait for the
    // next frame — see scheduleStickyUserStuckUpdate.
    const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD;
    scheduleStickyUserStuckUpdate();
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
    queueSplitPointerReleaseRef.current?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    queueSplitPointerReleaseRef.current = claimNativeTerminalPointerForWebDrag();
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
    queueSplitPointerReleaseRef.current?.();
    queueSplitPointerReleaseRef.current = null;
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

  // Re-pin outside React commits too. Content grows asynchronously — diagrams
  // render once their chunk loads, images decode late — and the scroller
  // itself resizes with the window and pane dividers; none of that passes
  // through the layout effects above, so a pinned view drifted off the
  // bottom. The sentinel observer fires whenever the timeline's bottom edge
  // crosses the viewport, but re-pins only when scrollHeight actually changed:
  // plain user scrolling flips the sentinel's visibility too and must never
  // be fought. Growth right after a pointer/key interaction inside the
  // timeline is also left alone — that shape is a disclosure being expanded
  // (a details toggle, a long-message reveal), and yanking to the bottom
  // would pull the view off the content the user just opened. Scroller
  // resizes re-pin on stickiness alone — a resize isn't a scroll gesture, so
  // being pinned beforehand is the only signal that matters. Timeline and
  // sentinel are rendered unconditionally, so the empty deps are safe.
  useEffect(() => {
    const timeline = timelineRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!timeline) {
      return;
    }
    let lastScrollHeight = timeline.scrollHeight;
    let suppressAutoPinUntil = 0;
    const noteUserInteraction = () => {
      suppressAutoPinUntil = performance.now() + 250;
    };
    timeline.addEventListener("pointerdown", noteUserInteraction, true);
    timeline.addEventListener("keydown", noteUserInteraction, true);
    const contentObserver =
      sentinel && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            () => {
              const grew = timeline.scrollHeight !== lastScrollHeight;
              lastScrollHeight = timeline.scrollHeight;
              if (
                grew &&
                stickToBottomRef.current &&
                performance.now() >= suppressAutoPinUntil
              ) {
                scrollToBottom();
              }
            },
            { root: timeline },
          )
        : null;
    if (sentinel && contentObserver) {
      contentObserver.observe(sentinel);
    }
    const resizeObserver = new ResizeObserver(() => {
      lastScrollHeight = timeline.scrollHeight;
      if (stickToBottomRef.current) {
        scrollToBottom();
      }
    });
    resizeObserver.observe(timeline);
    return () => {
      timeline.removeEventListener("pointerdown", noteUserInteraction, true);
      timeline.removeEventListener("keydown", noteUserInteraction, true);
      contentObserver?.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

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

  const queueSplitHeightRef = useRef(queueSplitHeight);
  queueSplitHeightRef.current = queueSplitHeight;
  const onQueueSplitHeightChangeRef = useRef(onQueueSplitHeightChange);
  onQueueSplitHeightChangeRef.current = onQueueSplitHeightChange;
  useLayoutEffect(() => {
    if (!queueSplit || !onQueueSplitHeightChange) {
      return;
    }
    const clamped = clampQueueSplitHeight(queueSplitHeight ?? defaultQueueSplitHeight());
    if (queueSplitHeight !== clamped) {
      onQueueSplitHeightChange(clamped);
    }
    // The clamp intentionally depends on live measurements read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueSplit, queueSplitHeight, composerBaseHeight, agentId, Boolean(input)]);
  // Re-clamp when the pane itself resizes. Split off from the effect above and
  // reading the live height through a ref, so a divider drag (which changes
  // queueSplitHeight on every pointermove) doesn't tear down and recreate the
  // ResizeObserver once per frame.
  useLayoutEffect(() => {
    if (!queueSplit || !onQueueSplitHeightChange) {
      return;
    }
    const sidebar = sidebarRef.current;
    if (!sidebar) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const current = queueSplitHeightRef.current;
      const next = clampQueueSplitHeight(current ?? defaultQueueSplitHeight());
      if (next !== current) {
        onQueueSplitHeightChangeRef.current?.(next);
      }
    });
    observer.observe(sidebar);
    return () => observer.disconnect();
    // The clamp intentionally depends on live measurements read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueSplit, composerBaseHeight, agentId, Boolean(input)]);

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

  // The last real user message (a bubble — not a tagged instruction, not a
  // dropped turn) is the sticky candidate: it pins to the top of the pane while
  // the turn beneath it scrolls, and releases as the view scrolls back up to
  // its original slot.
  const stickyUserKey = useMemo(() => {
    // A null key disables the whole pipeline downstream: no candidate class on
    // the card, no fit measurement, no stuck tracking.
    if (!stickyUserMessages) {
      return null;
    }
    for (let index = timelineItems.length - 1; index >= 0; index -= 1) {
      const item = timelineItems[index];
      if (
        item.role === "user" &&
        item.blocks.length > 0 &&
        !item.status &&
        !messageItemIsTaggedInstruction(item)
      ) {
        return item.key;
      }
    }
    return null;
  }, [stickyUserMessages, timelineItems]);
  const [stickyUserFits, setStickyUserFits] = useState(false);
  const [stickyUserStuck, setStickyUserStuck] = useState(false);
  const stickyUserEnabled = Boolean(stickyUserKey) && stickyUserFits;

  // Whether the candidate is pinned right now. Drives the stuck-only styling
  // (shadow + backfill mask) so the bubble renders exactly as before whenever
  // it sits in its flow position. Sticky offsets resolve against the scroller's
  // content edge, so the pinned card rests just below the timeline's top
  // padding — the threshold must include it.
  //
  // Scroll events fire this continuously while streaming output is also
  // mutating layout, so the check is coalesced to one run per animation frame
  // and reuses the cached card element (stable for a given stickyUserKey
  // thanks to keyed reconciliation; refreshed by the measurement effect below)
  // instead of re-querying the DOM every event. The top padding is re-read per
  // run — it varies with pane modes (split, headerless-expanded) and font
  // scale that no cache key here observes — but at most once per frame.
  const stickyUserCardRef = useRef<HTMLElement | null>(null);
  const stickyUserStuckFrameRef = useRef<number | null>(null);
  const updateStickyUserStuckRef = useRef(() => {});
  updateStickyUserStuckRef.current = () => {
    const timeline = timelineRef.current;
    const card = stickyUserCardRef.current;
    if (!timeline || !card || !stickyUserEnabled) {
      setStickyUserStuck(false);
      return;
    }
    const paddingTop = Number.parseFloat(window.getComputedStyle(timeline).paddingTop || "0");
    setStickyUserStuck(
      card.getBoundingClientRect().top <=
        timeline.getBoundingClientRect().top + paddingTop + 1,
    );
  };
  const scheduleStickyUserStuckUpdate = () => {
    if (stickyUserStuckFrameRef.current !== null) {
      return;
    }
    stickyUserStuckFrameRef.current = requestAnimationFrame(() => {
      stickyUserStuckFrameRef.current = null;
      updateStickyUserStuckRef.current();
    });
  };
  useEffect(
    () => () => {
      if (stickyUserStuckFrameRef.current !== null) {
        cancelAnimationFrame(stickyUserStuckFrameRef.current);
      }
    },
    [],
  );

  // Sticky is armed only while the candidate bubble is short relative to the
  // visible transcript strip; re-measured when the bubble, the pane, or the
  // floating queue/composer resizes (font scale, queue split, expand, a
  // collapsed long message being expanded, messages queueing up). Unsplit, the
  // queue/composer floats over the timeline's bottom, so subtract it — that
  // also keeps a pinned card from ever reaching the queue, which would paint
  // beneath it. In split mode the timeline already ends above the queue.
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const card = timeline?.querySelector<HTMLElement>(".turn-card.is-sticky-user-message");
    stickyUserCardRef.current = card ?? null;
    if (!timeline || !card) {
      setStickyUserFits(false);
      return;
    }
    const inputWrap = queueSplit ? null : inputWrapRef.current;
    const measure = () => {
      const visibleHeight = timeline.clientHeight - (inputWrap?.offsetHeight ?? 0);
      setStickyUserFits(card.offsetHeight <= visibleHeight * STICKY_USER_MAX_HEIGHT_RATIO);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(timeline);
    observer.observe(card);
    if (inputWrap) {
      observer.observe(inputWrap);
    }
    return () => observer.disconnect();
  }, [stickyUserKey, agentId, queueSplit]);

  // Re-evaluate pinning outside scroll events too: content growing below the
  // bubble or a transcript swap moves it without firing onScroll. Direct call
  // (not the rAF-coalesced schedule): this runs once per commit, and layout
  // effects should settle the state before paint.
  useLayoutEffect(() => {
    updateStickyUserStuckRef.current();
    // The update reads live geometry from refs; these deps are the renders
    // after which that geometry can have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickyUserEnabled, timelineItems, composerHeight, effectiveQueueSplitHeight, agentId, thinking]);

  return (
    <section
      ref={sidebarRef}
      className={`turn-sidebar${header ? " has-header" : ""}${queueSplit ? " has-queue-split" : ""}`}
      aria-label="Agent turns"
    >
      {header}
      <DomSearchBar
        active={searchHotkeyActive}
        placeholder="Find in transcript"
        rootRef={timelineRef}
        hotkeyScopeRef={sidebarRef}
        resetKey={agentId}
      />
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
      <TranscriptLinkActionsProvider actions={linkActions}>
        <div
          ref={timelineRef}
          className={`turn-timeline${timelineItems.length === 0 && !thinking ? " is-empty" : ""}${
            stickyUserEnabled ? " has-sticky-user" : ""
          }`}
          style={timelineStyle}
          onScroll={handleTimelineScroll}
        >
        {timelineItems.length === 0 && !thinking ? (
          <div className="empty-state turn-empty-state">
            <span>No activity yet</span>
            {/* Adapters emit both the bare "Transcript unavailable" and
                detailed variants ("Transcript unavailable: <reason>"), and
                transcript.error relays arbitrary failure text. Show the
                diagnostic whenever it says more than the picker already
                does, and offer the session picker for every
                transcript-unavailable flavor — an exact-string match here
                used to swallow the detailed ones and misleadingly render
                "Send a message to continue" over a broken transcript. */}
            {notice && notice !== "Transcript unavailable" ? (
              <span className="turn-empty-notice">{notice}</span>
            ) : null}
            {notice?.startsWith("Transcript unavailable") && onSelectTranscript ? (
              <TranscriptPickerLink
                options={transcriptOptions}
                activePath={transcriptPath}
                onSelect={onSelectTranscript}
              />
            ) : notice ? null : (
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
            // The candidate keeps its marker class even while sticky is
            // disarmed (the height measurement finds it by this class); the
            // sticky styling only activates under the timeline's
            // has-sticky-user class.
            const stickyClassName =
              item.key === stickyUserKey
                ? ` is-sticky-user-message${stickyUserStuck ? " is-stuck" : ""}`
                : "";
            return (
              <MessageTimelineItemView
                key={item.key}
                item={item}
                agentId={agentId}
                savePromptAgentId={savePromptAgentId}
                assistantLabel={assistantLabel}
                showName={showName}
                stickyClassName={stickyClassName}
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
        <div ref={bottomSentinelRef} className="turn-timeline-sentinel" aria-hidden="true" />
        </div>
      </TranscriptLinkActionsProvider>
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
  );
}

const MessageTimelineItemView = memo(function MessageTimelineItemView({
  item,
  agentId,
  savePromptAgentId,
  assistantLabel,
  showName,
  stickyClassName = "",
  titleGenerationEnabled,
  onRegenerateTitleFromUserMessage,
  titleGenerationBusy,
}: {
  item: MessageItem;
  agentId?: string;
  savePromptAgentId?: string | null;
  assistantLabel: string;
  showName: boolean;
  stickyClassName?: string;
  titleGenerationEnabled: boolean;
  onRegenerateTitleFromUserMessage: (message: string) => void;
  titleGenerationBusy: boolean;
}) {
  return (
    <>
      {item.blocks.length > 0 ? (
        <MessageItemView
          item={item}
          agentId={agentId}
          savePromptAgentId={savePromptAgentId}
          assistantLabel={assistantLabel}
          showName={showName}
          stickyClassName={stickyClassName}
          titleGenerationEnabled={titleGenerationEnabled}
          onRegenerateTitleFromUserMessage={onRegenerateTitleFromUserMessage}
          titleGenerationBusy={titleGenerationBusy}
        />
      ) : null}
      {item.activities.map((activity) => (
        // deferPayloads keeps collapsed thinking bodies out of the DOM until
        // opened (tool entries already defer their payloads internally). A
        // long transcript carries megabytes of thinking text, and mounting it
        // all inside closed <details> made tab switches pay for content
        // nobody had asked to see. Collapsed payloads were never findable by
        // Cmd-F anyway (unrendered ranges have no client rects), so search
        // behavior is unchanged.
        <TranscriptActivityItem key={activity.key} item={activity} isRootActivity deferPayloads />
      ))}
    </>
  );
},
(previous, next) =>
  previous.assistantLabel === next.assistantLabel &&
  previous.agentId === next.agentId &&
  previous.savePromptAgentId === next.savePromptAgentId &&
  previous.showName === next.showName &&
  previous.stickyClassName === next.stickyClassName &&
  previous.titleGenerationEnabled === next.titleGenerationEnabled &&
  previous.titleGenerationBusy === next.titleGenerationBusy &&
  previous.onRegenerateTitleFromUserMessage === next.onRegenerateTitleFromUserMessage &&
  (previous.item === next.item || sameMessageItem(previous.item, next.item)));

function MessageItemView({
  item,
  agentId,
  savePromptAgentId,
  assistantLabel,
  showName,
  stickyClassName = "",
  titleGenerationEnabled,
  onRegenerateTitleFromUserMessage,
  titleGenerationBusy,
}: {
  item: MessageItem;
  agentId?: string;
  savePromptAgentId?: string | null;
  assistantLabel: string;
  showName: boolean;
  stickyClassName?: string;
  titleGenerationEnabled: boolean;
  onRegenerateTitleFromUserMessage: (message: string) => void;
  titleGenerationBusy: boolean;
}) {
  const taggedInstructionMessage = messageItemIsTaggedInstruction(item);
  const messageText = item.role === "user" ? messageItemText(item) : null;
  const showMessageActions = Boolean(
    showName &&
      !taggedInstructionMessage &&
      messageText &&
      (titleGenerationEnabled || savePromptAgentId),
  );
  return (
    <article
      className={`turn-card role-${item.role}${
        taggedInstructionMessage ? " is-tagged-instruction-message" : ""
      }${timelineStatusClass(item.status)}${stickyClassName}`}
    >
      {showName && !taggedInstructionMessage ? (
        <header>
          <span className="turn-card-role-label">
            {turnRoleLabel(item.role, assistantLabel, item.participant)}
          </span>
          {showMessageActions && messageText ? (
            <MessageTitleMenu
              savePromptAgentId={savePromptAgentId}
              messageText={messageText}
              titleGenerationEnabled={titleGenerationEnabled}
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

// Preferred natural width for the message "..." menu; placement clamps to the pane.
const TITLE_MENU_PREFERRED_WIDTH = 180;

// The "..." menu shown at the right of a user message header. Opens a small popover
// with actions for regenerating the tab title, copying the message, or saving it to
// the prompt library.
// Portaled so the scrollable timeline cannot clip it; right-aligned so it grows
// toward the pane center.
function MessageTitleMenu({
  savePromptAgentId,
  messageText,
  titleGenerationEnabled,
  titleGenerationBusy,
  onRegenerateTitleFromUserMessage,
}: {
  savePromptAgentId?: string | null;
  messageText: string;
  titleGenerationEnabled: boolean;
  titleGenerationBusy: boolean;
  onRegenerateTitleFromUserMessage: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const { height } = popover.getBoundingClientRect();
    setPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width: TITLE_MENU_PREFERRED_WIDTH, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "end",
        prefer: "below",
      }),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
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

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    positionMenu();
    const onReflow = () => positionMenu();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, positionMenu]);

  return (
    <span className="turn-title-menu">
      <button
        ref={triggerRef}
        type="button"
        className="control-button turn-title-regenerate-button"
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
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="popover-surface popover-surface--context turn-title-menu-popover"
              role="menu"
              style={
                pos
                  ? {
                      left: pos.left,
                      top: pos.top,
                      maxHeight: pos.maxHeight,
                      width: Math.min(TITLE_MENU_PREFERRED_WIDTH, pos.maxWidth),
                      maxWidth: pos.maxWidth,
                    }
                  : { left: -9999, top: -9999 }
              }
            >
              {titleGenerationEnabled ? (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item turn-title-menu-item"
                  disabled={titleGenerationBusy}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    onRegenerateTitleFromUserMessage?.(messageText);
                  }}
                >
                  {titleGenerationBusy ? "Regenerating title…" : "Regenerate title"}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="menu-item turn-title-menu-item"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  void writeClipboardText(stripTaggedUserInstructionBlocks(messageText));
                }}
              >
                Copy message
              </button>
              {savePromptAgentId ? (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item turn-title-menu-item"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    requestSaveDraftAsPrompt(
                      savePromptAgentId,
                      stripTaggedUserInstructionBlocks(messageText),
                      { lockToGlobal: false },
                    );
                  }}
                >
                  Save to prompt library
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function turnRoleLabel(
  role: string,
  assistantLabel: string,
  participant?: ThreadParticipant | null,
) {
  if (participant?.label) {
    return participant.label;
  }
  if (role === "assistant") {
    return assistantLabel;
  }
  if (role === "system") {
    return "System";
  }
  return role;
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
    return <TranscriptMarkdown text={block.text} oversizedContent={OVERSIZED_ASSISTANT_MARKDOWN} />;
  }
  return <RawTranscriptDisclosure value={block.value} deferPayload />;
}

function CollapsedTaggedUserInstruction({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const title = expanded ? `Collapse ${label}` : `Show ${label}`;

  return (
    <div className={`tagged-user-instruction${expanded ? " is-expanded" : " is-collapsed"}`}>
      <button
        type="button"
        className="control-button tagged-user-instruction-toggle"
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
        className="control-button long-user-message-toggle"
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

function formatTurnTranscript(turn: Turn, assistantLabel: string) {
  return [
    turnRoleLabel(turn.role, assistantLabel, turn.participant),
    ...turn.blocks.map(formatTurnBlockTranscript),
  ]
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
