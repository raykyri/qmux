import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { EllipsisVertical, LoaderCircle, Mic, X } from "lucide-react";
import {
  listAgentTurnQueue,
  queueWaitAgentTurn,
  removeQueuedAgentTurn,
  reorderQueuedAgentTurn,
  sendNextQueuedAgentTurn,
  setQueuedTurnPause,
  submitAgentTurn,
  submitPaneInput,
  unpauseAgent,
} from "../lib/api";
import type { ComposerPolicy } from "../adapters";
import { writeClipboardText } from "../lib/clipboard";
import { inspectPaste } from "../lib/paste";
import type { PasteProtectionSettings } from "../lib/paste";
import { useDictation } from "../useDictation";
import DictationMicButton from "./DictationMicButton";
import { useConfirm } from "../hooks/useConfirm";
import type { AgentInfo, PaneInfo, QueuedTurn, SubmitAgentTurnMode, WaitTarget } from "../types";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "./ComposerSubmitShortcut";

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

function waitTargetStatusLabel(status: WaitTarget["status"]) {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "awaitingInput":
      return "Awaiting input";
    case "awaitingPermission":
      return "Awaiting decision";
    default:
      return status;
  }
}

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
  waitTargets: WaitTarget[];
  collapsedQueuedTurns: boolean[];
  // When the queue and transcript are shown together (the top-right "show both"
  // toggle), an empty queue gets a centered placeholder instead of collapsing to
  // nothing above the composer.
  queueSplit: boolean;
  requireCmdEnterToSend: boolean;
  pasteProtection: PasteProtectionSettings;
  transcriptText: string;
  transcriptCopyText: () => string;
  composerPolicy: ComposerPolicy;
  shortcutLabelForPane: (paneId?: string | null) => string | null;
  onQueueChange: (agentId: string, queuedTurns: QueuedTurn[]) => void;
  onDraftChange: (agentId: string, draft: string) => void;
  onQueuedTurnCollapseToggle: (agentId: string, index: number) => void;
  onTurnSubmitted: (agentId: string, text: string, mode: SubmitAgentTurnMode) => void;
  onUserInput: (agentId: string) => void;
  // Read/write a tab's last queue scroll position (kept in App so it survives the
  // composer unmounting when switching through a shell pane).
  getQueueScroll: (agentId: string) => number | undefined;
  saveQueueScroll: (agentId: string, scrollTop: number) => void;
  onError: (message: string) => void;
}

export default function NativeInput({
  pane,
  agent,
  draft,
  queuedTurns,
  waitTargets,
  collapsedQueuedTurns,
  queueSplit,
  requireCmdEnterToSend,
  pasteProtection,
  transcriptText,
  transcriptCopyText,
  composerPolicy,
  shortcutLabelForPane,
  onQueueChange,
  onDraftChange,
  onQueuedTurnCollapseToggle,
  onTurnSubmitted,
  onUserInput,
  getQueueScroll,
  saveQueueScroll,
  onError,
}: NativeInputProps) {
  const value = draft;
  const setValue = (next: string) => onDraftChange(agent.id, next);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [submitting, setSubmitting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [waitOpen, setWaitOpen] = useState(false);
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
  const previousQueueLength = useRef(queuedTurns.length);
  const previousAgentId = useRef(agent.id);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuPopoverRef = useRef<HTMLDivElement | null>(null);
  const waitRef = useRef<HTMLDivElement | null>(null);
  const waitTriggerRef = useRef<HTMLButtonElement | null>(null);
  const waitPopoverRef = useRef<HTMLDivElement | null>(null);
  // The actions popover is portaled to <body> (to escape the right pane's
  // overflow:hidden clipping) and positioned in fixed coordinates, clamped to
  // stay within the right pane. Null until measured, so it stays offscreen.
  const [menuPos, setMenuPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const [waitPos, setWaitPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Live voice dictation streamed into the composer at the caret. The mic is
  // hidden where the environment can't run local speech recognition (see
  // useDictation). Reads/writes go through the live textarea element so each
  // re-transcription pass overwrites the previous one in place.
  const dictation = useDictation({
    getText: () => textareaRef.current?.value ?? value,
    getCaret: () => {
      const ta = textareaRef.current;
      if (!ta) {
        return value.length;
      }
      // If the composer isn't focused, append at the end rather than wherever
      // selectionStart happens to sit (0 for a never-focused field).
      return document.activeElement === ta ? ta.selectionStart : ta.value.length;
    },
    setText: (text, caret) => {
      setValue(text);
      onUserInput(agent.id);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) {
          return;
        }
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    },
    focus: () => textareaRef.current?.focus(),
  });

  const awaitingPermission = agent.status === "awaitingPermission";
  const paused = agent.paused ?? false;
  const canSend = composerPolicy.readyStatuses.includes(agent.status);
  const canQueue = composerPolicy.queueStatuses.includes(agent.status);
  const canSteer = composerPolicy.steerStatuses.includes(agent.status);
  const hasTranscript = transcriptText.trim().length > 0;
  const hasSubmitValue = value.trim().length > 0;
  const sendDisabled = submitting || !canSend || !hasSubmitValue;
  const waitDisabled =
    submitting || agent.status === "failed" || !hasSubmitValue || waitTargets.length === 0;
  const submitShortcutWouldTargetSend = !submitting && canSend;
  const submitShortcutWouldTargetQueue =
    !submitShortcutWouldTargetSend && !submitting && canQueue;
  const submitShortcutTargetsSend = submitShortcutWouldTargetSend && hasSubmitValue;
  const submitShortcutTargetsQueue = submitShortcutWouldTargetQueue && hasSubmitValue;
  const permissionActions = awaitingPermission ? composerPolicy.permissionActions : [];
  const recentMessages = recentByAgent[agent.id] ?? [];

  function waitLabelWithShortcut(label: string, shortcutLabel?: string | null) {
    return shortcutLabel ? `${label} (${shortcutLabel})` : label;
  }

  // Close the actions menu on an outside click or Escape while it is open. The
  // popover is portaled out of menuRef, so a click counts as "inside" if it lands
  // on either the trigger wrapper or the portaled popover.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideTrigger = menuRef.current?.contains(target);
      const insidePopover = menuPopoverRef.current?.contains(target);
      if (!insideTrigger && !insidePopover) {
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

  useEffect(() => {
    if (!waitOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideTrigger = waitRef.current?.contains(target);
      const insidePopover = waitPopoverRef.current?.contains(target);
      if (!insideTrigger && !insidePopover) {
        setWaitOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWaitOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [waitOpen]);

  // Place the portaled popover above the ⋮ trigger, opening upward (away from the
  // bottom edge). It right-aligns to the trigger, then clamps horizontally within
  // the right pane (falling back to the viewport) so it never spills off either
  // edge. If there isn't room above, it caps its height and scrolls.
  const positionMenu = useCallback(() => {
    const trigger = menuTriggerRef.current;
    const popover = menuPopoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const margin = 8;
    const gap = 6;
    const triggerRect = trigger.getBoundingClientRect();
    const pane = trigger.closest(".turn-pane");
    const paneRect = pane?.getBoundingClientRect();
    const boundLeft = (paneRect ? paneRect.left : 0) + margin;
    const boundRight = (paneRect ? paneRect.right : window.innerWidth) - margin;
    const { width, height } = popover.getBoundingClientRect();
    let left = triggerRect.right - width;
    left = Math.max(boundLeft, Math.min(left, boundRight - width));
    const availableAbove = triggerRect.top - gap - margin;
    const top = Math.max(margin, triggerRect.top - gap - height);
    setMenuPos({ left, top, maxHeight: availableAbove });
  }, []);

  const positionWait = useCallback(() => {
    const trigger = waitTriggerRef.current;
    const popover = waitPopoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const margin = 8;
    const gap = 6;
    const triggerRect = trigger.getBoundingClientRect();
    const pane = trigger.closest(".turn-pane");
    const paneRect = pane?.getBoundingClientRect();
    const boundLeft = (paneRect ? paneRect.left : 0) + margin;
    const boundRight = (paneRect ? paneRect.right : window.innerWidth) - margin;
    const { width, height } = popover.getBoundingClientRect();
    let left = triggerRect.right - width;
    left = Math.max(boundLeft, Math.min(left, boundRight - width));
    const availableAbove = triggerRect.top - gap - margin;
    const top = Math.max(margin, triggerRect.top - gap - height);
    setWaitPos({ left, top, maxHeight: availableAbove });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
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
  }, [menuOpen, positionMenu]);

  useLayoutEffect(() => {
    if (!waitOpen) {
      setWaitPos(null);
      return;
    }
    positionWait();
    const onReflow = () => positionWait();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [waitOpen, positionWait]);

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

  // Restore this tab's saved queue scroll position on switch. A layout effect so it
  // lands before paint; it keys only on agent.id, so same-agent content changes are
  // left to the scroll-to-bottom effect above (which an agent switch skips).
  useLayoutEffect(() => {
    const stack = queueStackRef.current;
    if (!stack) {
      return;
    }
    stack.scrollTop = getQueueScroll(agent.id) ?? 0;
  }, [agent.id, getQueueScroll]);

  // After queueing a long item, older turns collapse and the stack gets shorter —
  // which can strand the scroll position past the new end, leaving the queue stuck
  // showing empty space below the last item. Watch the stack and its rows for size
  // changes and, whenever the scroll has fallen past the bottom, snap it back down
  // so the latest item stays in view. Only acts on the invalid over-scrolled
  // region, so it never fights a user who has scrolled up to read earlier items.
  useEffect(() => {
    const stack = queueStackRef.current;
    if (!stack) {
      return;
    }
    const clampToBottom = () => {
      const max = stack.scrollHeight - stack.clientHeight;
      if (max >= 0 && stack.scrollTop > max + 1) {
        stack.scrollTop = stack.scrollHeight;
      }
    };
    const observer = new ResizeObserver(clampToBottom);
    observer.observe(stack);
    // The stack's own box doesn't change when a row collapses; observe the rows so
    // their height animations are caught too.
    for (const child of Array.from(stack.children)) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [queuedTurns.length]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
      clearQueuedTurnClickTimer();
    };
  }, []);

  async function submitTurn(text: string, mode: SubmitAgentTurnMode) {
    if (submitting) {
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    // End any in-flight dictation so it can't keep writing into the cleared
    // composer after the turn is sent.
    dictation.stop();
    setSubmitting(true);
    try {
      const result = await submitAgentTurn(agent.id, trimmed, mode);
      onQueueChange(agent.id, result.queuedTurns);
      onTurnSubmitted(agent.id, trimmed, mode);
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

  async function submitWaitTurn(target: WaitTarget) {
    if (submitting) {
      return;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    dictation.stop();
    setWaitOpen(false);
    setSubmitting(true);
    try {
      const result = await queueWaitAgentTurn(
        agent.id,
        trimmed,
        target.agentId,
        target.paneId,
        target.label,
      );
      onQueueChange(agent.id, result.queuedTurns);
      onTurnSubmitted(agent.id, trimmed, "queue");
      recordRecentMessage(trimmed);
      setValue("");
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
    // Use Element, not HTMLElement: clicking the X button hits its <svg>/<path>
    // (SVGElement, not HTMLElement), which would otherwise skip this guard and
    // start a drag — swallowing the Remove click.
    if (event.target instanceof Element && event.target.closest(".queued-turn-actions")) {
      return;
    }
    queuePointerDragRef.current = {
      pointerId: event.pointerId,
      from: index,
      startY: event.clientY,
      active: false,
    };
    // Don't capture the pointer yet — capturing here would hijack the gesture from
    // the text and break double-click-to-select on the queued turn. Capture only
    // once an actual drag starts (see handleQueuePointerMove).
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
      // Now that it's a real drag, capture the pointer so moves keep arriving even
      // when the cursor leaves the row. Deferred to here (not pointerdown) so a
      // click/double-click on the text isn't hijacked from the native selection.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been released.
      }
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
          onScroll={(event) => saveQueueScroll(agent.id, event.currentTarget.scrollTop)}
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
                    className="queued-turn-remove"
                    disabled={submitting}
                    aria-label="Remove queued turn"
                    title="Remove"
                    onClick={() => void removeQueuedTurn(index, turn.text)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void editQueuedTurn(index, turn.text)}
                  >
                    Edit
                  </button>
                </div>
                {turn.pauseAfter ? (
                  <div className="queued-turn-pause-label" aria-hidden="true">
                    Pause after send
                  </div>
                ) : null}
                {turn.waitFor ? (
                  <div className="queued-turn-wait-label" aria-hidden="true">
                    {index === 0 ? "Waiting on" : "Wait on"}{" "}
                    {waitLabelWithShortcut(
                      turn.waitFor.label ?? "selected terminal",
                      shortcutLabelForPane(turn.waitFor.paneId),
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : queueSplit ? (
        <div className="empty-state turn-empty-state queue-empty-state">
          <span>No turns queued</span>
        </div>
      ) : null}
      <div className="native-input-composer">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            onUserInput(agent.id);
          }}
          // While dictation is live, the first real keystroke hands control back to
          // the keyboard: stop transcribing so it stops overwriting the caret, then
          // let the key do its normal thing. Bare modifiers don't count — holding
          // Shift to capitalize the next spoken word shouldn't end dictation.
          onKeyDownCapture={(event) => {
            if (!dictation.listening) {
              return;
            }
            if (
              event.key === "Shift" ||
              event.key === "Control" ||
              event.key === "Alt" ||
              event.key === "Meta" ||
              event.key === "CapsLock"
            ) {
              return;
            }
            dictation.stop();
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            const verdict = inspectPaste(text, pasteProtection);
            if (verdict.action === "accept") {
              // Small paste: let the browser insert it normally.
              return;
            }
            // Large/oversized paste: the in-app dialog is async, so cancel the
            // native paste now and handle it ourselves.
            event.preventDefault();
            if (verdict.action === "reject") {
              void confirm({ message: verdict.message, confirmLabel: "OK" });
              return;
            }
            // Confirmed-large: re-insert at the caret only if the user accepts.
            const start = event.currentTarget.selectionStart ?? value.length;
            const end = event.currentTarget.selectionEnd ?? value.length;
            void confirm({ message: verdict.message, confirmLabel: "Paste" }).then((ok) => {
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
            if (isComposerSubmitShortcut(event, requireCmdEnterToSend)) {
              event.preventDefault();
              if (submitShortcutTargetsSend) {
                void submitTurn(value, "send");
              } else if (submitShortcutTargetsQueue) {
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
              : "What should we investigate next?"
          }
          rows={1}
        />
        <div className="native-input-submit-actions">
          <DictationMicButton dictation={dictation} className="native-input-mic" />
          {paused ? <span className="composer-paused-label">Paused</span> : null}
          <div className="composer-menu" ref={menuRef}>
            <button
              ref={menuTriggerRef}
              type="button"
              className="composer-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <EllipsisVertical size={15} aria-hidden="true" />
            </button>
            {menuOpen
              ? createPortal(
                  <div
                    ref={menuPopoverRef}
                    className="composer-menu-popover"
                    role="menu"
                    // Offscreen until measured so it doesn't flash at the origin.
                    style={
                      menuPos
                        ? {
                            left: menuPos.left,
                            top: menuPos.top,
                            maxHeight: menuPos.maxHeight,
                          }
                        : { left: -9999, top: -9999 }
                    }
                  >
                {queuedTurns.length > 0 ? (
                  <>
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
                    <button
                      type="button"
                      role="menuitem"
                      className="composer-menu-item"
                      disabled={submitting}
                      onClick={() => {
                        setMenuOpen(false);
                        const lastIndex = queuedTurns.length - 1;
                        const lastTurn = queuedTurns[lastIndex];
                        void setItemPauseAfter(lastIndex, lastTurn, !lastTurn.pauseAfter);
                      }}
                    >
                      {queuedTurns[queuedTurns.length - 1]?.pauseAfter
                        ? "Remove pause after send"
                        : "Pause after send"}
                    </button>
                    <div className="composer-menu-divider" role="separator" />
                  </>
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
                  Copy queued messages
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
                  </div>,
                  document.body,
                )
              : null}
          </div>
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
              {submitShortcutWouldTargetSend ? (
                <ComposerSubmitShortcutGlyph
                  requireCmdEnter={requireCmdEnterToSend}
                  className="shortcut-hint"
                />
              ) : null}
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
            <>
              <div className="wait-target-picker" ref={waitRef}>
                <button
                  ref={waitTriggerRef}
                  type="button"
                  className="wait-target-button"
                  disabled={waitDisabled}
                  aria-haspopup="menu"
                  aria-expanded={waitOpen}
                  title={
                    waitTargets.length > 0
                      ? "Queue this turn after another terminal is done"
                      : "No other terminals are working"
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    setWaitOpen((open) => !open);
                  }}
                >
                  Queue after…
                </button>
                {waitOpen
                  ? createPortal(
                      <div
                        ref={waitPopoverRef}
                        className="wait-target-popover"
                        role="menu"
                        style={
                          waitPos
                            ? {
                                left: waitPos.left,
                                top: waitPos.top,
                                maxHeight: waitPos.maxHeight,
                              }
                            : { left: -9999, top: -9999 }
                        }
                      >
                        <div className="composer-menu-label">Wait on terminal</div>
                        {waitTargets.map((target) => (
                          <button
                            key={target.agentId}
                            type="button"
                            role="menuitem"
                            className="wait-target-item"
                            title={waitLabelWithShortcut(target.label, target.shortcutLabel)}
                            onClick={() => void submitWaitTurn(target)}
                          >
                            <span className="wait-target-title">
                              {waitLabelWithShortcut(target.label, target.shortcutLabel)}
                            </span>
                            <span className="wait-target-status">
                              {waitTargetStatusLabel(target.status)}
                            </span>
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
              <button
                type="button"
                className="queue-button"
                disabled={submitting || !canQueue || value.trim().length === 0}
                onClick={() => void submitTurn(value, "queue")}
              >
                <span>Queue</span>
                {submitShortcutWouldTargetQueue ? (
                  <ComposerSubmitShortcutGlyph
                    requireCmdEnter={requireCmdEnterToSend}
                    className="shortcut-hint"
                  />
                ) : null}
              </button>
            </>
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
