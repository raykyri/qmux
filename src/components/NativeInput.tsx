import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EllipsisVertical, Rows2, SquareCenterlineDashedVertical } from "lucide-react";
import {
  listAgentTurnQueue,
  removeQueuedAgentTurn,
  reorderQueuedAgentTurn,
  sendNextQueuedAgentTurn,
  setQueuedTurnPause,
  submitAgentTurn,
  submitPaneInput,
  unpauseAgent,
} from "../lib/api";
import type { ComposerPolicy } from "../adapters";
import { largePastePrompt } from "../lib/paste";
import { useConfirm } from "../hooks/useConfirm";
import type { AgentInfo, PaneInfo, QueuedTurn, TranscriptOption } from "../types";

// The composer grows with its content up to this height, then scrolls.
const MAX_INPUT_HEIGHT = 200;

// A quick, subtle ease for the queued-turn collapse/expand. CSS can't transition
// to/from `auto`, so we measure both layouts and tween between explicit pixel
// heights, then hand control back to CSS once it settles.
const QUEUED_TURN_ANIM_MS = 120;
const QUEUE_DRAG_START_THRESHOLD = 4;
const QUEUE_DRAG_CLICK_SUPPRESS_MS = 100;
const QUEUED_TURN_CLICK_DELAY_MS = 220;

type QueuePointerDrag = {
  pointerId: number;
  from: number;
  startY: number;
  active: boolean;
};

function QueuedTurnText({ turn, collapsed }: { turn: string; collapsed: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const naturalHeight = useRef<number | null>(null);
  const initialized = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    // The ancestor's is-collapsed class has already flipped, so the element is in
    // its target layout; capture that resting height with transitions off.
    el.style.transition = "none";
    el.style.height = "auto";
    const to = el.offsetHeight;

    if (!initialized.current) {
      // First mount (or a remount from reorder): nothing to animate.
      initialized.current = true;
      naturalHeight.current = to;
      el.style.height = "";
      el.style.transition = "";
      return;
    }

    const from = naturalHeight.current ?? to;
    naturalHeight.current = to;
    if (from === to) {
      el.style.height = "";
      el.style.transition = "";
      return;
    }

    el.style.height = `${from}px`;
    // Force a reflow so the start height is registered before the ease begins.
    void el.offsetHeight;
    el.style.transition = `height ${QUEUED_TURN_ANIM_MS}ms ease`;
    el.style.height = `${to}px`;

    const handleEnd = () => {
      el.style.height = "";
      el.style.transition = "";
      naturalHeight.current = el.offsetHeight;
      el.removeEventListener("transitionend", handleEnd);
    };
    el.addEventListener("transitionend", handleEnd);
    return () => {
      el.removeEventListener("transitionend", handleEnd);
    };
  }, [collapsed]);

  return (
    <span ref={ref} className="queued-turn-text">
      {turn}
    </span>
  );
}

interface NativeInputProps {
  pane: PaneInfo;
  agent: AgentInfo;
  // Controlled composer text, owned by the app and keyed by agent so it survives
  // tab switches; onDraftChange both updates that store and schedules the disk flush.
  draft: string;
  queuedTurns: QueuedTurn[];
  collapsedQueuedTurns: boolean[];
  transcriptText: string;
  transcriptCopyText: () => string;
  composerPolicy: ComposerPolicy;
  // Sessions in this agent's folder for the bottom-left session switcher; the
  // active one is whichever matches agent.transcriptPath.
  transcriptOptions: TranscriptOption[];
  onSelectTranscript: (path: string | null) => void;
  onQueueChange: (agentId: string, queuedTurns: QueuedTurn[]) => void;
  onDraftChange: (agentId: string, draft: string) => void;
  onQueuedTurnCollapseToggle: (agentId: string, index: number) => void;
  onUserInput: (agentId: string) => void;
  onError: (message: string) => void;
}

export default function NativeInput({
  pane,
  agent,
  draft,
  queuedTurns,
  collapsedQueuedTurns,
  transcriptText,
  transcriptCopyText,
  composerPolicy,
  transcriptOptions,
  onSelectTranscript,
  onQueueChange,
  onDraftChange,
  onQueuedTurnCollapseToggle,
  onUserInput,
  onError,
}: NativeInputProps) {
  const value = draft;
  const setValue = (next: string) => onDraftChange(agent.id, next);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [submitting, setSubmitting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The open queued-item ⋮ menu: its row index and the fixed-position anchor
  // (computed from the trigger so the overflow:auto stack can't clip the popover).
  const [openItemMenu, setOpenItemMenu] = useState<{
    index: number;
    right: number;
    bottom: number;
  } | null>(null);
  // Drag-to-reorder of the queued turns. draggingIndex is the row being dragged;
  // dropIndex is the gap (0..length) it would land in.
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const draggingIndexRef = useRef<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const queuePointerDragRef = useRef<QueuePointerDrag | null>(null);
  const suppressQueuedTurnClickRef = useRef(false);
  const queuedTurnClickTimer = useRef<number | null>(null);
  // Recently sent or removed messages, per agent, so the menu can offer them for
  // quick re-copy. Kept here (not in the backend) as a session convenience.
  const [recentByAgent, setRecentByAgent] = useState<Record<string, string[]>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const queueStackRef = useRef<HTMLDivElement | null>(null);
  // Queue-height cap: when capped (default), the queue stack is limited to half the
  // right pane; the toggle lets it grow freely. `queueOverflows` gates the toggle's
  // visibility (only shown when the queue would actually exceed the cap), and
  // `queueCapPx` is the measured 50%-of-pane pixel cap applied while capped.
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [queueOverflows, setQueueOverflows] = useState(false);
  const [queueCapPx, setQueueCapPx] = useState<number | null>(null);
  const previousQueueLength = useRef(queuedTurns.length);
  const previousAgentId = useRef(agent.id);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const awaitingPermission = agent.status === "awaitingPermission";
  const paused = agent.paused ?? false;
  const canSend = composerPolicy.readyStatuses.includes(agent.status);
  const canQueue = composerPolicy.queueStatuses.includes(agent.status);
  const canSteer = composerPolicy.steerStatuses.includes(agent.status);
  const hasTranscript = transcriptText.trim().length > 0;
  const sendDisabled = submitting || !canSend || value.trim().length === 0;
  const permissionActions = awaitingPermission ? composerPolicy.permissionActions : [];
  const recentMessages = recentByAgent[agent.id] ?? [];
  // Sorted newest first so recent sessions appear at the top of the menu.
  const sessionOptions = [...transcriptOptions].sort((a, b) => b.modifiedMs - a.modifiedMs);

  // Close the actions menu on an outside click or Escape while it is open.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  // Close an open per-item ⋮ menu on an outside click or Escape. Also close on scroll
  // or resize: the popover is position:fixed at coordinates captured when it opened,
  // so once the row moves under it those coordinates are stale — closing is cleaner
  // than letting it strand over an unrelated row.
  useEffect(() => {
    if (openItemMenu === null) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".queued-turn-menu")) {
        setOpenItemMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenItemMenu(null);
      }
    };
    const close = () => setOpenItemMenu(null);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    // Capture phase so a scroll on the inner queue stack (not just window) closes it.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [openItemMenu]);

  // The menu is keyed by queue index; if the queue changes (a drain, reorder, or new
  // turn) or the agent switches, that index would point at a different turn, so close.
  useEffect(() => {
    setOpenItemMenu(null);
  }, [queuedTurns, agent.id]);

  // Grow the textarea to fit its content (capped, then it scrolls). Runs whenever
  // the value changes, including programmatic resets and queued-turn edits.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [value]);

  // When a new turn is queued (appended to the bottom), scroll the stack down so
  // the latest item is visible. Skip removals/reorders and agent switches.
  useEffect(() => {
    const grew =
      previousAgentId.current === agent.id && queuedTurns.length > previousQueueLength.current;
    previousQueueLength.current = queuedTurns.length;
    previousAgentId.current = agent.id;
    if (grew && queueStackRef.current) {
      queueStackRef.current.scrollTop = queueStackRef.current.scrollHeight;
    }
  }, [queuedTurns.length, agent.id]);

  // Measures whether the queue's content would exceed half the right pane (the cap),
  // and records that 50% height in pixels. `scrollHeight` is the full content height
  // regardless of the applied cap, so this stays stable across the cap toggle (no
  // feedback loop). Cheap (two layout reads) and called sparingly — see below.
  const measureQueueOverflow = useCallback(() => {
    const stack = queueStackRef.current;
    if (!stack) {
      setQueueOverflows(false);
      setQueueCapPx(null);
      return;
    }
    const pane = stack.closest(".turn-sidebar") as HTMLElement | null;
    const paneHeight = pane?.clientHeight ?? 0;
    if (paneHeight <= 0) {
      setQueueOverflows(false);
      setQueueCapPx(null);
      return;
    }
    const cap = Math.round(paneHeight * 0.5);
    setQueueCapPx(cap);
    setQueueOverflows(stack.scrollHeight > cap);
  }, []);

  // Re-measure when the queue's content could have changed (items added/removed,
  // collapsed/expanded). These are user-paced, so measuring per change is cheap.
  useEffect(() => {
    measureQueueOverflow();
  }, [queuedTurns, collapsedQueuedTurns, measureQueueOverflow]);

  // Re-measure when the pane resizes, but debounced: dragging the pane resizer fires
  // a flood of events, and it's fine for the button to lag a touch. Only active while
  // a queue exists (its stack must be mounted to find the pane).
  const hasQueue = queuedTurns.length > 0;
  useEffect(() => {
    if (!hasQueue) {
      setQueueOverflows(false);
      return;
    }
    const pane = queueStackRef.current?.closest(".turn-sidebar") as HTMLElement | null;
    if (!pane) {
      return;
    }
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measureQueueOverflow, 200);
    });
    observer.observe(pane);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [hasQueue, measureQueueOverflow]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
      clearQueuedTurnClickTimer();
    };
  }, []);

  async function submitTurn(text: string, mode: "send" | "queue" | "steer") {
    if (submitting) {
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitAgentTurn(agent.id, trimmed, mode);
      onQueueChange(agent.id, result.queuedTurns);
      recordRecentMessage(trimmed);
      setValue("");
      // Return focus to the composer once it clears. Deferred to the next frame
      // so it lands after the submit buttons re-render — clicking one disables or
      // unmounts it, which briefly bounces focus to <body>.
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPermissionResponse(response: string) {
    setSubmitting(true);
    try {
      await submitPaneInput(pane.id, response);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeQueuedTurn(index: number, turn: string) {
    if (submitting) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await removeQueuedAgentTurn(agent.id, index, turn);
      onQueueChange(agent.id, result.queuedTurns);
      recordRecentMessage(turn);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function editQueuedTurn(index: number, turn: string) {
    if (submitting) {
      return;
    }

    if (
      value.length > 0 &&
      !(await confirm({
        message: "Replace the current input with this queued item?",
        confirmLabel: "Replace",
      }))
    ) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await removeQueuedAgentTurn(agent.id, index, turn);
      onQueueChange(agent.id, result.queuedTurns);
      setValue(result.removedTurn);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        const end = result.removedTurn.length;
        textarea.focus();
        textarea.setSelectionRange(end, end);
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyTranscript() {
    if (!hasTranscript) {
      return;
    }

    try {
      await writeClipboardText(transcriptCopyText());
      showToast("Copied to clipboard");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyQueued() {
    if (queuedTurns.length === 0) {
      return;
    }

    try {
      await writeClipboardText(queuedTurns.map((turn) => turn.text).join("\n\n"));
      showToast("Copied to clipboard");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendNextQueuedTurn() {
    if (submitting || queuedTurns.length === 0) {
      return;
    }

    const nextTurn = queuedTurns[0];
    setSubmitting(true);
    try {
      const result = await sendNextQueuedAgentTurn(agent.id);
      onQueueChange(agent.id, result.queuedTurns);
      if (result.sent) {
        recordRecentMessage(nextTurn.text);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Push a message onto this agent's recent list: most-recent first, de-duplicated,
  // capped at five.
  function recordRecentMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setRecentByAgent((current) => {
      const existing = current[agent.id] ?? [];
      const next = [trimmed, ...existing.filter((entry) => entry !== trimmed)].slice(0, 5);
      return { ...current, [agent.id]: next };
    });
  }

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 1600);
  }

  async function copyRecentMessage(message: string) {
    try {
      await writeClipboardText(message);
      showToast("Copied to clipboard");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleQueuePointerDown(event: ReactPointerEvent<HTMLDivElement>, index: number) {
    if (event.button !== 0) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".queued-turn-actions")
    ) {
      return;
    }
    queuePointerDragRef.current = {
      pointerId: event.pointerId,
      from: index,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleQueuePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = queuePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < QUEUE_DRAG_START_THRESHOLD) {
        return;
      }
      drag.active = true;
      draggingIndexRef.current = drag.from;
      dropIndexRef.current = null;
      setDraggingIndex(drag.from);
      setDropIndex(null);
    }

    event.preventDefault();
    const stack = queueStackRef.current;
    if (!stack) {
      return;
    }
    setQueueDropIndex(queueDropIndexFromPoint(stack, event.clientY));
  }

  function handleQueuePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = queuePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the platform.
    }

    queuePointerDragRef.current = null;
    if (!drag.active) {
      return;
    }

    event.preventDefault();
    suppressQueuedTurnClickRef.current = true;
    window.setTimeout(() => {
      suppressQueuedTurnClickRef.current = false;
    }, QUEUE_DRAG_CLICK_SUPPRESS_MS);

    const stack = queueStackRef.current;
    const gap =
      dropIndexRef.current ?? (stack ? queueDropIndexFromPoint(stack, event.clientY) : null);
    clearQueueDrag();
    if (gap === null) {
      return;
    }
    reorderQueuedTurn(drag.from, gap);
  }

  function handleQueuePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = queuePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    queuePointerDragRef.current = null;
    clearQueueDrag();
  }

  function clearQueuedTurnClickTimer() {
    if (queuedTurnClickTimer.current === null) {
      return;
    }
    window.clearTimeout(queuedTurnClickTimer.current);
    queuedTurnClickTimer.current = null;
  }

  function handleQueuedTurnToggleClick(
    event: ReactMouseEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (suppressQueuedTurnClickRef.current) {
      suppressQueuedTurnClickRef.current = false;
      return;
    }
    if (event.detail > 1) {
      return;
    }
    clearQueuedTurnClickTimer();
    queuedTurnClickTimer.current = window.setTimeout(() => {
      queuedTurnClickTimer.current = null;
      onQueuedTurnCollapseToggle(agent.id, index);
    }, QUEUED_TURN_CLICK_DELAY_MS);
  }

  function handleQueuedTurnDoubleClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    clearQueuedTurnClickTimer();

    const text = event.currentTarget.querySelector(".queued-turn-text");
    if (!text) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function reorderQueuedTurn(from: number, gap: number) {
    if (from < 0 || from >= queuedTurns.length) {
      return;
    }
    const to = from < gap ? gap - 1 : gap;
    if (to === from || to < 0 || to >= queuedTurns.length) {
      return;
    }
    const next = [...queuedTurns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // Reorder the displayed queue immediately, then persist so a reload keeps it.
    onQueueChange(agent.id, next);
    void persistQueueReorder(from, to, moved.text);
  }

  function setQueueDropIndex(index: number | null) {
    dropIndexRef.current = index;
    setDropIndex(index);
  }

  function clearQueueDrag() {
    draggingIndexRef.current = null;
    dropIndexRef.current = null;
    setDraggingIndex(null);
    setDropIndex(null);
  }

  function queueDropIndexFromPoint(container: HTMLDivElement, clientY: number) {
    const rows = Array.from(container.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains("queued-turn"),
    );
    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    }
    return rows.length;
  }

  async function persistQueueReorder(from: number, to: number, turn: string) {
    try {
      const result = await reorderQueuedAgentTurn(agent.id, from, to, turn);
      onQueueChange(agent.id, result.queuedTurns);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      // The optimistic order may now be wrong; pull the backend's truth back.
      try {
        onQueueChange(agent.id, await listAgentTurnQueue(agent.id));
      } catch {
        // Best-effort resync; leave the optimistic order if this also fails.
      }
    }
  }

  async function setItemPauseAfter(index: number, turn: QueuedTurn, pauseAfter: boolean) {
    setOpenItemMenu(null);
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const queued = await setQueuedTurnPause(agent.id, index, pauseAfter, turn.text);
      onQueueChange(agent.id, queued);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function unpause() {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await unpauseAgent(agent.id);
      onQueueChange(agent.id, result.queuedTurns);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="native-input"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) {
          void submitTurn(value, "send");
        } else if (canQueue) {
          void submitTurn(value, "queue");
        }
      }}
    >
      {queuedTurns.length > 0 ? (
        <div
          ref={queueStackRef}
          className={`queued-turn-stack${draggingIndex !== null ? " is-dragging" : ""}`}
          aria-label="Queued turns"
          style={
            queueOverflows && !queueExpanded && queueCapPx
              ? { maxHeight: queueCapPx }
              : undefined
          }
        >
          {queuedTurns.map((turn, index) => {
            const collapsed = collapsedQueuedTurns[index] ?? false;
            // Suppress the drop line at the dragged row's own current position.
            const activeDrop =
              dropIndex === null || dropIndex === draggingIndex || dropIndex === (draggingIndex ?? -1) + 1
                ? null
                : dropIndex;
            const className = [
              "queued-turn",
              collapsed ? "is-collapsed" : "",
              index === draggingIndex ? "is-dragging" : "",
              activeDrop === index ? "is-drop-before" : "",
              activeDrop === queuedTurns.length && index === queuedTurns.length - 1
                ? "is-drop-after"
                : "",
            ]
              .filter(Boolean)
              .join(" ");
            const menuOpenHere = openItemMenu?.index === index;
            return (
              <div
                key={`${index}-${turn.text}`}
                className={className}
                onPointerDown={(event) => handleQueuePointerDown(event, index)}
                onPointerMove={handleQueuePointerMove}
                onPointerUp={handleQueuePointerUp}
                onPointerCancel={handleQueuePointerCancel}
              >
                <button
                  type="button"
                  className="queued-turn-toggle"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand queued turn" : "Collapse queued turn"}
                  onClick={(event) => handleQueuedTurnToggleClick(event, index)}
                  onDoubleClick={handleQueuedTurnDoubleClick}
                >
                  <QueuedTurnText turn={turn.text} collapsed={collapsed} />
                </button>
                <div className="queued-turn-actions">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void editQueuedTurn(index, turn.text)}
                  >
                    Edit
                  </button>
                  <div className="queued-turn-menu">
                    <button
                      type="button"
                      className="queued-turn-menu-trigger"
                      aria-haspopup="menu"
                      aria-expanded={menuOpenHere}
                      aria-label="Queued turn actions"
                      onClick={(event) => {
                        if (menuOpenHere) {
                          setOpenItemMenu(null);
                          return;
                        }
                        const rect = event.currentTarget.getBoundingClientRect();
                        setOpenItemMenu({
                          index,
                          right: window.innerWidth - rect.right,
                          bottom: window.innerHeight - rect.top + 4,
                        });
                      }}
                    >
                      <EllipsisVertical size={13} aria-hidden="true" />
                    </button>
                    {menuOpenHere && openItemMenu ? (
                      <div
                        className="queued-turn-menu-popover"
                        role="menu"
                        style={{
                          right: `${openItemMenu.right}px`,
                          bottom: `${openItemMenu.bottom}px`,
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="composer-menu-item"
                          disabled={submitting}
                          onClick={() =>
                            void setItemPauseAfter(index, turn, !turn.pauseAfter)
                          }
                        >
                          {turn.pauseAfter ? "Remove pause after send" : "Pause after send"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="composer-menu-item"
                          disabled={submitting}
                          onClick={() => {
                            setOpenItemMenu(null);
                            void removeQueuedTurn(index, turn.text);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
                {turn.pauseAfter ? (
                  <div className="queued-turn-pause-label" aria-hidden="true">
                    Pause after send
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          onUserInput(agent.id);
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          const prompt = largePastePrompt(text);
          if (!prompt) {
            // Small paste: let the browser insert it normally.
            return;
          }
          // Large paste: the in-app confirm is async, so cancel the native paste now
          // and re-insert at the caret only if the user accepts.
          event.preventDefault();
          const start = event.currentTarget.selectionStart ?? value.length;
          const end = event.currentTarget.selectionEnd ?? value.length;
          void confirm({ message: prompt, confirmLabel: "Paste" }).then((ok) => {
            if (!ok) {
              return;
            }
            setValue(value.slice(0, start) + text + value.slice(end));
            requestAnimationFrame(() => {
              const textarea = textareaRef.current;
              if (!textarea) {
                return;
              }
              const caret = start + text.length;
              textarea.focus();
              textarea.setSelectionRange(caret, caret);
            });
          });
        }}
        onKeyDown={(event) => {
          if (event.metaKey && event.key === "Enter") {
            event.preventDefault();
            if (canSend) {
              void submitTurn(value, "send");
            } else if (canQueue) {
              void submitTurn(value, "queue");
            }
            return;
          }
          // With an empty composer, Up pulls the most recently queued item back in
          // to edit (dequeuing it), like recalling the last line in a shell.
          if (
            event.key === "ArrowUp" &&
            !event.repeat &&
            value.length === 0 &&
            queuedTurns.length > 0
          ) {
            event.preventDefault();
            const lastIndex = queuedTurns.length - 1;
            void editQueuedTurn(lastIndex, queuedTurns[lastIndex].text);
          }
        }}
        placeholder={
          awaitingPermission
            ? "Approve or deny the pending tool use..."
            : "What’s next?"
        }
        rows={1}
      />
      <div className="native-input-actions">
        {queueOverflows ? (
          <button
            type="button"
            className="queue-height-toggle"
            aria-pressed={queueExpanded}
            aria-label={queueExpanded ? "Limit queue height to half the pane" : "Let the queue grow past half the pane"}
            title={queueExpanded ? "Limit queue height to half the pane" : "Let the queue grow past half the pane"}
            onClick={() => setQueueExpanded((expanded) => !expanded)}
          >
            {queueExpanded ? (
              <Rows2 size={15} aria-hidden="true" />
            ) : (
              <SquareCenterlineDashedVertical size={15} aria-hidden="true" />
            )}
          </button>
        ) : null}
        {paused ? <span className="composer-paused-label">Paused</span> : null}
        <div className="composer-menu" ref={menuRef}>
          <button
            type="button"
            className="composer-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <EllipsisVertical size={15} aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div className="composer-menu-popover" role="menu">
              {queuedTurns.length > 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  className="composer-menu-item"
                  disabled={submitting}
                  onClick={() => {
                    setMenuOpen(false);
                    void sendNextQueuedTurn();
                  }}
                >
                  Send next queued
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="composer-menu-item"
                disabled={queuedTurns.length === 0}
                onClick={() => {
                  setMenuOpen(false);
                  void copyQueued();
                }}
              >
                Copy queued
              </button>
              <button
                type="button"
                role="menuitem"
                className="composer-menu-item"
                disabled={!hasTranscript}
                onClick={() => {
                  setMenuOpen(false);
                  void copyTranscript();
                }}
              >
                Copy transcript
              </button>
              {transcriptOptions.length > 0 ? (
                <>
                  <div className="composer-menu-divider" role="separator" />
                  <div className="composer-menu-label">Past sessions</div>
                  <div className="composer-menu-sessions" role="group" aria-label="Past sessions">
                    {sessionOptions.map((option) => {
                      const active = option.path === agent.transcriptPath;
                      return (
                        <button
                          key={option.path}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={active}
                          className={`composer-menu-item session-menu-item${
                            active ? " is-active" : ""
                          }`}
                          onClick={() => {
                            setMenuOpen(false);
                            onSelectTranscript(active ? null : option.path);
                          }}
                        >
                          <span className="session-menu-title">{sessionMenuTitle(option)}</span>
                          <span className="session-menu-meta">
                            {formatRelativeTime(option.modifiedMs)}
                            {option.boundToOtherAgent ? " · in use by another agent" : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}
              {recentMessages.length > 0 ? (
                <>
                  <div className="composer-menu-divider" role="separator" />
                  <div className="composer-menu-label">Recent messages</div>
                  {recentMessages.map((message, index) => (
                    <button
                      key={`${index}-${message}`}
                      type="button"
                      role="menuitem"
                      className="composer-menu-item composer-menu-recent"
                      title={message}
                      onClick={() => {
                        setMenuOpen(false);
                        void copyRecentMessage(message);
                      }}
                    >
                      {message}
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="native-input-submit-actions">
          {permissionActions.length > 0 ? (
            permissionActions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => void submitPermissionResponse(action.input)}
                disabled={submitting}
              >
                {action.label}
              </button>
            ))
          ) : null}
          {!sendDisabled ? (
            <button type="button" onClick={() => void submitTurn(value, "send")}>
              <span>Send</span>
              <span className="shortcut-hint" aria-label="Command Enter">
                ⌘<span className="enter-glyph" aria-hidden="true">↵</span>
              </span>
            </button>
          ) : null}
          {canSteer ? (
            <button
              type="button"
              disabled={submitting || value.trim().length === 0}
              onClick={() => void submitTurn(value, "steer")}
              title="Send now, interrupting the agent's current work"
            >
              <span>Send Now</span>
            </button>
          ) : null}
          {paused ? (
            <button
              type="button"
              className="queue-button"
              disabled={submitting}
              onClick={() => void unpause()}
              title="Clear the pause and resume the queue"
            >
              <span>Unpause</span>
            </button>
          ) : (
            <button
              type="button"
              className="queue-button"
              disabled={submitting || !canQueue || value.trim().length === 0}
              onClick={() => void submitTurn(value, "queue")}
            >
              <span>Queue</span>
              {canQueue ? (
                <span className="shortcut-hint" aria-label="Command Enter">
                  ⌘<span className="enter-glyph" aria-hidden="true">↵</span>
                </span>
              ) : null}
            </button>
          )}
        </div>
      </div>
      {toast ? (
        <div className="composer-toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      {confirmDialog}
    </form>
  );
}

// Title shown for a session row: its first user message, falling back to a short
// session id when the transcript has no readable prompt yet.
function sessionMenuTitle(option: TranscriptOption): string {
  const preview = option.preview?.trim();
  if (preview) {
    return preview;
  }
  const shortId = option.sessionId ? option.sessionId.split("-")[0] : null;
  return shortId ? `Session ${shortId}` : "Untitled session";
}

// Coarse "x ago" label for a session's last-modified time, shown as gray
// subordinate text under each session title.
function formatRelativeTime(modifiedMs: number): string {
  const diffMs = Date.now() - modifiedMs;
  if (diffMs < 45_000) {
    return "just now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} wk ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} yr ago`;
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy command for WebViews without clipboard permission.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command was rejected");
    }
  } finally {
    textarea.remove();
  }
}
