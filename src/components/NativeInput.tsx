import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, EllipsisVertical, X } from "lucide-react";
import {
  listAgentTurnQueue,
  queueDeliveryAgentTurn,
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
import { growComposerTextarea } from "../lib/composerTextarea";
import {
  completeComposerSlashCommand,
  matchingComposerSlashCommands,
  parseComposerSlashCommand,
  type ComposerSlashCommand,
} from "../lib/composerSlashCommands";
import { inspectPaste } from "../lib/paste";
import type { PasteProtectionSettings } from "../lib/paste";
import { useConfirm } from "../hooks/useConfirm";
import { listenToComposerInsert, requestSaveDraftAsPrompt } from "../lib/promptLibrary";
import type {
  AgentInfo,
  PaneInfo,
  QueuedTurn,
  QueuedTurnDelivery,
  SubmitAgentTurnMode,
  SubmitAgentTurnResult,
  WaitTarget,
} from "../types";
import {
  agentCanFork,
  agentStatusTone,
  placePanePopover,
  turnPaneRectFrom,
} from "../lib/appHelpers";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "./ComposerSubmitShortcut";

// Trailing debounce for pushing local composer edits to the app's draft store.
// Long enough to keep steady typing from re-rendering the app per keystroke,
// short enough that tab indicators and crash recovery stay effectively live.
const DRAFT_PUSH_DEBOUNCE_MS = 150;

// A quick, subtle ease for the queued-turn collapse/expand. CSS can't transition
// to/from `auto`, so we measure both layouts and tween between explicit pixel
// heights, then hand control back to CSS once it settles.
const QUEUED_TURN_ANIM_MS = 120;
const QUEUE_DRAG_START_THRESHOLD = 4;
const QUEUE_DRAG_CLICK_SUPPRESS_MS = 100;
const QUEUED_TURN_CLICK_DELAY_MS = 220;
// Terminal title progress markers tend to be leading glyphs and spacing; strip
// those only for the queued-turn wait footer so the stored wait target stays raw.
const WAIT_TITLE_PROGRESS_PREFIX_RE =
  /^[ \t·•●○◦∙⋅⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✣✤✥✦✧✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿\uFE0E\uFE0F]+/u;

type QueuePointerDrag = {
  pointerId: number;
  from: number;
  // The grabbed card's text, so the drop can re-derive its index if the queue
  // shifts mid-drag (e.g. the agent drains its top turn while the pointer is down).
  text: string;
  startY: number;
  active: boolean;
};

function waitTargetStatusLabel(target: WaitTarget) {
  const queueCount = target.queueCount ?? 0;
  if ((target.status === "done" || target.status === "idle") && queueCount > 0) {
    return target.queueBlocked ? "Waiting" : `${queueCount} queued`;
  }
  switch (target.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "awaitingInput":
      return "Awaiting input";
    case "awaitingPermission":
      return "Awaiting decision";
    default:
      return target.status;
  }
}

function waitTargetStatusDotClass(target: WaitTarget) {
  const statusTone = agentStatusTone(target.status);
  const statusClass = target.status === "awaitingInput" ? " status-awaiting-input" : "";
  const waitingClass = target.queueBlocked ? " is-waiting-on-pane" : "";
  return `pane-tab-dot wait-target-status-dot status-${statusTone}${statusClass}${waitingClass}`;
}

function waitFooterTitle(label: string) {
  return label.replace(WAIT_TITLE_PROGRESS_PREFIX_RE, "").trim() || label.trim();
}

function queuedTurnDeliveryLabel(delivery: QueuedTurnDelivery) {
  if (delivery.kind === "newSession") {
    return "To new session";
  }
  return delivery.useWorktree ? "Fork in worktree" : "Fork session";
}

const FORK_REQUIREMENT_TITLE =
  "Forking requires a supported agent session that has run a turn";

// The delivery choices offered by the queue dropdown, above the wait targets.
const QUEUE_DELIVERY_OPTIONS: Array<{
  label: string;
  title: string;
  needsFork: boolean;
  delivery: QueuedTurnDelivery;
}> = [
  {
    label: "Queue and fork",
    title: "When reached, fork this session and send the message to the fork",
    needsFork: true,
    delivery: { kind: "fork" },
  },
  {
    label: "Queue and fork in worktree",
    title:
      "When reached, fork this session into a fresh git worktree and send the message to the fork",
    needsFork: true,
    delivery: { kind: "fork", useWorktree: true },
  },
  {
    label: "Queue in new session",
    title: "When reached, start a fresh session in the same directory with this message",
    needsFork: false,
    delivery: { kind: "newSession" },
  },
];

function waitFooterLabelWithShortcut(label: string, shortcutLabel?: string | null) {
  const quotedTitle = `"${waitFooterTitle(label)}"`;
  return shortcutLabel ? `${quotedTitle} (${shortcutLabel})` : quotedTitle;
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

    const reduceMotion =
      el.closest(".reduce-motion") !== null ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    if (!initialized.current || reduceMotion) {
      // First mount (or a remount from reorder) and reduced-motion changes
      // should settle immediately at the target height.
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
  agentMayBeBackgrounded: boolean;
  // The app's copy of the composer text, keyed by agent so it survives tab
  // switches. The live value while typing is component-local (a keystroke must
  // not re-render the whole app); onDraftChange pushes local edits back to the
  // app store on a short debounce, and an external change to this prop (agent
  // switch, queued-turn edit, restore) is adopted into the local value.
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
  hasTranscript: boolean;
  transcriptCopyPlainText: () => string;
  transcriptCopyJsonText: () => string;
  composerPolicy: ComposerPolicy;
  shortcutLabelForPane: (paneId?: string | null) => string | null;
  onQueueChange: (agentId: string, queuedTurns: QueuedTurn[]) => void;
  // Cross-split queue-card drag: reports which other agent's split cell the drag
  // currently hovers (null when none), and moves the card there on drop.
  onQueueDropTargetChange: (agentId: string | null) => void;
  onMoveQueuedTurn: (targetAgentId: string, index: number, turn: string) => void;
  onDraftChange: (agentId: string, draft: string) => void;
  // Registers a callback the app invokes on quit/close flushes so the composer's
  // debounced local edits reach the draft store before it writes to disk.
  // Returns the unregister function.
  registerDraftFlusher: (flush: () => void) => () => void;
  onQueuedTurnCollapseToggle: (agentId: string, index: number) => void;
  onWaitTargetHover: (agentId: string | null) => void;
  onForkWithPrompt: (options: {
    useWorktree: boolean;
    prompt: string;
  }) => Promise<boolean>;
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
  agentMayBeBackgrounded,
  draft,
  queuedTurns,
  waitTargets,
  collapsedQueuedTurns,
  queueSplit,
  requireCmdEnterToSend,
  pasteProtection,
  hasTranscript,
  transcriptCopyPlainText,
  transcriptCopyJsonText,
  composerPolicy,
  shortcutLabelForPane,
  onQueueChange,
  onQueueDropTargetChange,
  onMoveQueuedTurn,
  onDraftChange,
  registerDraftFlusher,
  onQueuedTurnCollapseToggle,
  onWaitTargetHover,
  onForkWithPrompt,
  onTurnSubmitted,
  onUserInput,
  getQueueScroll,
  saveQueueScroll,
  onError,
}: NativeInputProps) {
  // The composer text is component-local while typing: a controlled value from
  // App-root state made every keystroke a full-app render, which queued the
  // typed character's DOM commit behind whatever a busy agent's event stream was
  // rendering. Local edits are pushed to the app store on a trailing debounce
  // (immediately when cleared, so a sent draft never lingers), and any change to
  // the `draft` prop this component didn't push itself — switching agents,
  // restart recovery — is adopted into the local value.
  const [localDraft, setLocalDraft] = useState(draft);
  const lastPushedDraftRef = useRef(draft);
  const draftPushTimerRef = useRef<number | null>(null);
  const pendingDraftPushRef = useRef<{ agentId: string; text: string } | null>(null);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  // Commits a still-debounced local edit to the app store right now. The pending
  // record carries the agent id captured when the edit was made, so a flush that
  // runs as part of switching to another agent still credits the right draft.
  const flushDraftPush = useCallback(() => {
    if (draftPushTimerRef.current !== null) {
      clearTimeout(draftPushTimerRef.current);
      draftPushTimerRef.current = null;
    }
    const pending = pendingDraftPushRef.current;
    if (pending) {
      pendingDraftPushRef.current = null;
      lastPushedDraftRef.current = pending.text;
      onDraftChangeRef.current(pending.agentId, pending.text);
    }
  }, []);
  // Adopt external draft changes. Runs before paint so an agent switch never
  // flashes the previous agent's text. The instance is reused across agents in
  // the global sidebar, so an agent switch always flushes the pending edit (the
  // pending record carries the agent it was typed for) and re-adopts — even
  // when both agents' stored drafts are content-equal (both empty, typically),
  // where the prop comparison alone would keep the previous agent's un-pushed
  // text on screen under the new agent.
  //
  // For the same agent, a prop change while a local edit is mid-debounce is
  // ignored outright: the prop can only be an echo of an older push (or a
  // stale external write), both by definition older than what the user just
  // typed — flushing-then-comparing here would misread that echo as external
  // and revert freshly typed characters. Only a prop that differs from our
  // newest push, arriving with no edit pending, is a genuine external write
  // (queued-turn edit, restore) and gets adopted.
  const adoptedAgentIdRef = useRef(agent.id);
  useLayoutEffect(() => {
    const agentChanged = adoptedAgentIdRef.current !== agent.id;
    adoptedAgentIdRef.current = agent.id;
    if (agentChanged) {
      flushDraftPush();
      lastPushedDraftRef.current = draft;
      setLocalDraft(draft);
      return;
    }
    if (pendingDraftPushRef.current !== null) {
      return;
    }
    if (draft !== lastPushedDraftRef.current) {
      lastPushedDraftRef.current = draft;
      setLocalDraft(draft);
    }
  }, [agent.id, draft, flushDraftPush]);
  // A draft still sitting in the debounce window when the composer unmounts
  // (pane closed, right bar collapsed) is committed rather than dropped.
  useEffect(() => flushDraftPush, [flushDraftPush]);
  // And the app's quit/close flush can pull it out before writing to disk —
  // pagehide and Cmd-Q run App-level flushes that would otherwise miss the
  // debounce window's worth of typing.
  useEffect(
    () => registerDraftFlusher(flushDraftPush),
    [flushDraftPush, registerDraftFlusher],
  );
  const value = localDraft;
  const setValue = (next: string) => {
    setLocalDraft(next);
    if (draftPushTimerRef.current !== null) {
      clearTimeout(draftPushTimerRef.current);
      draftPushTimerRef.current = null;
    }
    if (!next) {
      // Clears push through immediately: App flushes empty drafts to disk at
      // once so a sent/emptied draft never lingers in state.json.
      pendingDraftPushRef.current = null;
      lastPushedDraftRef.current = next;
      onDraftChangeRef.current(agent.id, next);
      return;
    }
    pendingDraftPushRef.current = { agentId: agent.id, text: next };
    draftPushTimerRef.current = window.setTimeout(() => {
      draftPushTimerRef.current = null;
      flushDraftPush();
    }, DRAFT_PUSH_DEBOUNCE_MS);
  };
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
  // The other agent's split cell a queued-card drag currently hovers, if any.
  const crossDropAgentIdRef = useRef<string | null>(null);
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
    maxWidth: number;
  } | null>(null);
  const [waitPos, setWaitPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const slashPopoverRef = useRef<HTMLDivElement | null>(null);
  const slashListId = useId();
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashDismissedValue, setSlashDismissedValue] = useState<string | null>(null);
  const [slashPos, setSlashPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);

  // Saved-prompt insertion requests from the pane header's library menu. The
  // caret lives here, so the splice happens here: insert at the selection (or
  // append when the textarea never had focus), then restore focus with the caret
  // after the inserted text. The draft and setter are read through latest-refs
  // so the splice always sees the current text without the effect re-subscribing
  // the listener on every keystroke (its old `value` dependency did exactly that).
  const valueForInsertRef = useRef(value);
  valueForInsertRef.current = value;
  const setValueForInsertRef = useRef(setValue);
  setValueForInsertRef.current = setValue;
  useEffect(() => {
    return listenToComposerInsert(agent.id, (text) => {
      const textarea = textareaRef.current;
      const current = valueForInsertRef.current;
      const start = textarea?.selectionStart ?? current.length;
      const end = textarea?.selectionEnd ?? current.length;
      setValueForInsertRef.current(current.slice(0, start) + text + current.slice(end));
      const caret = start + text.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) {
          return;
        }
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    });
  }, [agent.id]);

  const awaitingPermission = agent.status === "awaitingPermission";
  const paused = agent.paused ?? false;
  const canSend = composerPolicy.readyStatuses.includes(agent.status);
  const canQueue = composerPolicy.queueStatuses.includes(agent.status);
  const canSteer = composerPolicy.steerStatuses.includes(agent.status);
  const hasQueuedTurns = queuedTurns.length > 0;
  const canAppendQueue = agent.status !== "failed" && (canQueue || hasQueuedTurns);
  const hasSubmitValue = value.trim().length > 0;
  const sendDisabled = submitting || !canSend || !hasSubmitValue;
  // Delivery to a brand-new session only needs an adapter, which every agent has,
  // so the queue dropdown no longer requires wait targets to exist.
  const canQueueFork = agentCanFork(agent);
  const parsedSlashCommand = useMemo(() => parseComposerSlashCommand(value), [value]);
  const slashMatches = useMemo(() => matchingComposerSlashCommands(value), [value]);
  const activeSlashIndex = Math.min(
    slashSelectedIndex,
    Math.max(0, slashMatches.length - 1),
  );
  const slashMenuOpen =
    textareaFocused && slashMatches.length > 0 && slashDismissedValue !== value;
  const waitDisabled = submitting || agent.status === "failed" || !hasSubmitValue;
  const submitShortcutWouldTargetSend = !submitting && canSend && !hasQueuedTurns;
  const submitShortcutWouldTargetQueue =
    !submitShortcutWouldTargetSend && !submitting && canAppendQueue;
  const submitShortcutTargetsSend = submitShortcutWouldTargetSend && hasSubmitValue;
  const submitShortcutTargetsQueue = submitShortcutWouldTargetQueue && hasSubmitValue;
  const permissionActions = awaitingPermission ? composerPolicy.permissionActions : [];
  const recentMessages = recentByAgent[agent.id] ?? [];

  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [agent.id, value]);

  useEffect(() => {
    setSlashDismissedValue(null);
  }, [agent.id]);

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
      onWaitTargetHover(null);
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
  }, [onWaitTargetHover, waitOpen]);

  useEffect(() => () => onWaitTargetHover(null), [onWaitTargetHover]);

  // Place the portaled popover above the ⋮ / queue-options trigger, right-aligned
  // so it grows toward the pane center, clamped so it never spills past the pane.
  const positionMenu = useCallback(() => {
    const trigger = menuTriggerRef.current;
    const popover = menuPopoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const { width, height } = popover.getBoundingClientRect();
    setMenuPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "end",
        prefer: "above",
      }),
    );
  }, []);

  const positionWait = useCallback(() => {
    const trigger = waitTriggerRef.current;
    const popover = waitPopoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const { width, height } = popover.getBoundingClientRect();
    setWaitPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "end",
        prefer: "above",
      }),
    );
  }, []);

  const positionSlashMenu = useCallback(() => {
    const trigger = textareaRef.current;
    const popover = slashPopoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const { width, height } = popover.getBoundingClientRect();
    setSlashPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "start",
        prefer: "above",
      }),
    );
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

  useLayoutEffect(() => {
    if (!slashMenuOpen) {
      setSlashPos(null);
      return;
    }
    positionSlashMenu();
    const onReflow = () => positionSlashMenu();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [positionSlashMenu, slashMenuOpen, slashMatches.length]);

  // Grow the textarea to fit its content (capped, then it scrolls). Runs whenever
  // the value changes, including programmatic resets and queued-turn edits.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    growComposerTextarea(textarea);
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

  // If this composer unmounts mid-drag, drop the cross-split highlight it set.
  // Guarded on the ref so unmounting an idle instance never clears a highlight
  // another split's in-flight drag owns.
  useEffect(
    () => () => {
      if (crossDropAgentIdRef.current !== null) {
        crossDropAgentIdRef.current = null;
        onQueueDropTargetChange(null);
      }
    },
    [onQueueDropTargetChange],
  );

  function completeSlashCommand(command: ComposerSlashCommand) {
    const completed = completeComposerSlashCommand(command);
    setSlashDismissedValue(null);
    setValue(completed);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(completed.length, completed.length);
    });
  }

  async function submitTurn(text: string, mode: SubmitAgentTurnMode) {
    if (submitting) {
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const slashCommand = parseComposerSlashCommand(text);
    if (slashCommand.kind === "incomplete") {
      onError(`Add a message after ${slashCommand.command.token}`);
      return;
    }
    if (slashCommand.kind === "ready") {
      if (!canQueueFork) {
        onError(FORK_REQUIREMENT_TITLE);
        return;
      }
      setMenuOpen(false);
      setWaitOpen(false);
      setSubmitting(true);
      try {
        const forked = await onForkWithPrompt({
          useWorktree: slashCommand.command.useWorktree,
          prompt: slashCommand.prompt,
        });
        if (forked) {
          recordRecentMessage(trimmed);
          setValue("");
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

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

  // Shared scaffolding for the queue-dropdown submits (wait targets and delivery
  // options): close the popover, run the queue call with the trimmed composer
  // text, and reflect the result in the composer.
  async function submitQueuedFromPopover(
    queue: (text: string) => Promise<SubmitAgentTurnResult>,
  ) {
    if (submitting) {
      return;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    setWaitOpen(false);
    onWaitTargetHover(null);
    setSubmitting(true);
    try {
      const result = await queue(trimmed);
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

  function submitWaitTurn(target: WaitTarget) {
    return submitQueuedFromPopover((text) =>
      queueWaitAgentTurn(agent.id, text, target.agentId, target.paneId, target.label),
    );
  }

  function submitDeliveryTurn(delivery: QueuedTurnDelivery) {
    return submitQueuedFromPopover((text) => queueDeliveryAgentTurn(agent.id, text, delivery));
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

  async function copyTranscriptPlainText() {
    if (!hasTranscript) {
      return;
    }

    try {
      await writeClipboardText(transcriptCopyPlainText());
      showToast("Copied to clipboard");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyTranscriptJson() {
    if (!hasTranscript) {
      return;
    }

    try {
      await writeClipboardText(transcriptCopyJsonText());
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
      text: queuedTurns[index]?.text ?? "",
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
    // The pointer is captured by the source row, so other splits never see these
    // events; hit-test the point instead to find a foreign split cell under it.
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const targetAgentId = under
      ?.closest("[data-queue-drop-agent-id]")
      ?.getAttribute("data-queue-drop-agent-id");
    if (targetAgentId && targetAgentId !== agent.id) {
      setCrossDropAgent(targetAgentId);
      setQueueDropIndex(null);
      return;
    }
    setCrossDropAgent(null);
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

    const crossTargetAgentId = crossDropAgentIdRef.current;
    if (crossTargetAgentId) {
      clearQueueDrag();
      const from = currentDragIndex(drag);
      if (from !== null) {
        onMoveQueuedTurn(crossTargetAgentId, from, drag.text);
      }
      return;
    }
    const stack = queueStackRef.current;
    const gap =
      dropIndexRef.current ?? (stack ? queueDropIndexFromPoint(stack, event.clientY) : null);
    clearQueueDrag();
    if (gap === null) {
      return;
    }
    const from = currentDragIndex(drag);
    if (from !== null) {
      reorderQueuedTurn(from, gap);
    }
  }

  // The queue can shift under a drag (the agent draining its top turn, another
  // window removing an item), so resolve the grabbed card's index at drop time by
  // its text instead of trusting the position captured at pointerdown.
  function currentDragIndex(drag: QueuePointerDrag): number | null {
    if (queuedTurns[drag.from]?.text === drag.text) {
      return drag.from;
    }
    const index = queuedTurns.findIndex((turn) => turn.text === drag.text);
    return index === -1 ? null : index;
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

  function setCrossDropAgent(agentId: string | null) {
    if (crossDropAgentIdRef.current === agentId) {
      return;
    }
    crossDropAgentIdRef.current = agentId;
    onQueueDropTargetChange(agentId);
  }

  function clearQueueDrag() {
    draggingIndexRef.current = null;
    dropIndexRef.current = null;
    setDraggingIndex(null);
    setDropIndex(null);
    setCrossDropAgent(null);
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
        if (hasQueuedTurns && canAppendQueue) {
          void submitTurn(value, "queue");
        } else if (canSend) {
          void submitTurn(value, "send");
        } else if (canAppendQueue) {
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
              turn.waitFor ? "has-wait" : "",
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
                  className="control-button queued-turn-toggle"
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
                    className="control-button queued-turn-remove"
                    disabled={submitting}
                    aria-label="Remove queued turn"
                    title="Remove"
                    onClick={() => void removeQueuedTurn(index, turn.text)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                  <button className="control-button"
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
                {turn.delivery ? (
                  <div className="queued-turn-delivery-label" aria-hidden="true">
                    {queuedTurnDeliveryLabel(turn.delivery)}
                  </div>
                ) : null}
                {turn.waitFor ? (
                  <div
                    className="queued-turn-wait-label"
                    aria-hidden="true"
                    onPointerEnter={() => onWaitTargetHover(turn.waitFor?.agentId ?? null)}
                    onPointerLeave={() => onWaitTargetHover(null)}
                  >
                    {index === 0 ? "Waiting on" : "Wait on"}{" "}
                    {waitFooterLabelWithShortcut(
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
          aria-autocomplete="list"
          aria-controls={slashMenuOpen ? slashListId : undefined}
          aria-expanded={slashMenuOpen}
          aria-activedescendant={
            slashMenuOpen ? `${slashListId}-option-${activeSlashIndex}` : undefined
          }
          onFocus={() => setTextareaFocused(true)}
          onBlur={() => setTextareaFocused(false)}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            onUserInput(agent.id);
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
            if (slashMenuOpen && !event.nativeEvent.isComposing) {
              if (
                (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setSlashSelectedIndex(
                  (activeSlashIndex + step + slashMatches.length) % slashMatches.length,
                );
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSlashDismissedValue(value);
                return;
              }
              const acceptsSelection =
                event.key === "Tab" ||
                (event.key === "Enter" &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.shiftKey);
              if (acceptsSelection) {
                const command = slashMatches[activeSlashIndex];
                if (command) {
                  event.preventDefault();
                  if (canQueueFork) {
                    completeSlashCommand(command);
                  } else {
                    onError(FORK_REQUIREMENT_TITLE);
                  }
                  return;
                }
                if (event.key === "Enter") {
                  // Keep a disabled typeahead from submitting a partial command;
                  // Tab remains native so keyboard users can leave the field.
                  event.preventDefault();
                }
                return;
              }
            }
            if (isComposerSubmitShortcut(event, requireCmdEnterToSend)) {
              event.preventDefault();
              if (slashMenuOpen) {
                const command = slashMatches[activeSlashIndex];
                if (!command) {
                  return;
                }
                if (canQueueFork) {
                  completeSlashCommand(command);
                } else {
                  onError(FORK_REQUIREMENT_TITLE);
                }
              } else if (parsedSlashCommand.kind !== "none") {
                void submitTurn(value, "send");
              } else if (submitShortcutTargetsSend) {
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
            agentMayBeBackgrounded
              ? "Agent may be backgrounded"
              : awaitingPermission
                ? "Requesting approval for pending tool use..."
                : "What should we investigate next?"
          }
          rows={1}
        />
        {slashMenuOpen
          ? createPortal(
              <div
                ref={slashPopoverRef}
                id={slashListId}
                className="popover-surface composer-slash-popover"
                role="listbox"
                aria-label="qMux slash commands"
                style={
                  slashPos
                    ? {
                        left: slashPos.left,
                        top: slashPos.top,
                        maxHeight: slashPos.maxHeight,
                        maxWidth: slashPos.maxWidth,
                      }
                    : { left: -9999, top: -9999 }
                }
              >
                {slashMatches.map((command, index) => (
                  <button
                    key={command.name}
                    id={`${slashListId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSlashIndex}
                    className={`composer-slash-option${
                      index === activeSlashIndex ? " is-selected" : ""
                    }`}
                    disabled={!canQueueFork}
                    title={!canQueueFork ? FORK_REQUIREMENT_TITLE : command.description}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setSlashSelectedIndex(index)}
                    onClick={() => completeSlashCommand(command)}
                  >
                    <span className="composer-slash-token">{command.token}</span>
                    <span className="composer-slash-description">
                      {!canQueueFork ? FORK_REQUIREMENT_TITLE : command.description}
                    </span>
                  </button>
                ))}
              </div>,
              document.body,
            )
          : null}
        <div className="native-input-submit-actions">
          {paused ? <span className="composer-paused-label">Paused</span> : null}
          <div className="composer-menu" ref={menuRef}>
            <button
              ref={menuTriggerRef}
              type="button"
              className="link-button composer-menu-trigger"
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
                    className="popover-surface composer-menu-popover"
                    role="menu"
                    // Offscreen until measured so it doesn't flash at the origin.
                    style={
                      menuPos
                        ? {
                            left: menuPos.left,
                            top: menuPos.top,
                            maxHeight: menuPos.maxHeight,
                            maxWidth: menuPos.maxWidth,
                          }
                        : { left: -9999, top: -9999 }
                    }
                  >
                {queuedTurns.length > 0 ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item composer-menu-item"
                      disabled={submitting}
                      onClick={() => {
                        setMenuOpen(false);
                        void sendNextQueuedTurn();
                      }}
                    >
                      Send top queued item now!
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item composer-menu-item"
                      disabled={submitting}
                      onClick={() => {
                        setMenuOpen(false);
                        const topTurn = queuedTurns[0];
                        void setItemPauseAfter(0, topTurn, !topTurn.pauseAfter);
                      }}
                    >
                      {queuedTurns[0]?.pauseAfter
                        ? "Remove pause after top queued item"
                        : "Pause after top queued item"}
                    </button>
                    <div className="menu-divider composer-menu-divider" role="separator" />
                  </>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item composer-menu-item"
                  disabled={value.trim().length === 0}
                  onClick={() => {
                    setMenuOpen(false);
                    requestSaveDraftAsPrompt(agent.id, value);
                  }}
                >
                  Save current draft as prompt
                </button>
                <div className="composer-menu-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item composer-menu-item"
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
                  className="menu-item composer-menu-item"
                  disabled={!hasTranscript}
                  onClick={() => {
                    setMenuOpen(false);
                    void copyTranscriptPlainText();
                  }}
                >
                  Copy transcript
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item composer-menu-item"
                  disabled={!hasTranscript}
                  onClick={() => {
                    setMenuOpen(false);
                    void copyTranscriptJson();
                  }}
                >
                  Copy transcript as JSON
                </button>
                {recentMessages.length > 0 ? (
                  <>
                    <div className="composer-menu-divider" role="separator" />
                    <div className="composer-menu-label">Copy recent messages</div>
                    {recentMessages.map((message, index) => (
                      <button
                        key={`${index}-${message}`}
                        type="button"
                        role="menuitem"
                        className="menu-item composer-menu-item composer-menu-recent"
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
              <button className="control-button"
                key={action.id}
                type="button"
                onClick={() => void submitPermissionResponse(action.input)}
                disabled={submitting}
              >
                {action.label}
              </button>
            ))
          ) : null}
          {slashMenuOpen ? null : parsedSlashCommand.kind !== "none" ? (
            <button
              className="control-button"
              type="button"
              disabled={
                submitting || parsedSlashCommand.kind !== "ready" || !canQueueFork
              }
              title={!canQueueFork ? FORK_REQUIREMENT_TITLE : undefined}
              onClick={() => void submitTurn(value, "send")}
            >
              <span>
                {parsedSlashCommand.command.useWorktree
                  ? "Fork in worktree & send"
                  : "Fork & send"}
              </span>
              <ComposerSubmitShortcutGlyph
                requireCmdEnter={requireCmdEnterToSend}
                className="shortcut-hint"
              />
            </button>
          ) : (
            <>
              {!sendDisabled ? (
                <button
                  className="control-button"
                  type="button"
                  onClick={() => void submitTurn(value, "send")}
                >
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
                  className="control-button"
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
                  className="control-button queue-button"
                  disabled={submitting}
                  onClick={() => void unpause()}
                  title="Clear the pause and resume the queue"
                >
                  <span>Unpause</span>
                </button>
              ) : (
                <div className="wait-target-picker queue-button-group" ref={waitRef}>
                  <button
                    type="button"
                    className="control-button queue-button queue-button-main"
                    disabled={submitting || !canAppendQueue || value.trim().length === 0}
                    onClick={() => {
                      setWaitOpen(false);
                      void submitTurn(value, "queue");
                    }}
                  >
                    <span>Queue</span>
                    {submitShortcutWouldTargetQueue ? (
                      <ComposerSubmitShortcutGlyph
                        requireCmdEnter={requireCmdEnterToSend}
                        className="shortcut-hint"
                      />
                    ) : null}
                  </button>
                  <button
                    ref={waitTriggerRef}
                    type="button"
                    className="control-button queue-menu-button"
                    disabled={waitDisabled}
                    aria-haspopup="menu"
                    aria-expanded={waitOpen}
                    aria-label="Queue options"
                    title="Queue this turn to a fork, a new session, or after another terminal"
                    onClick={() => {
                      setMenuOpen(false);
                      setWaitOpen((open) => !open);
                    }}
                  >
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                  {waitOpen
                    ? createPortal(
                    <div
                      ref={waitPopoverRef}
                      className="popover-surface wait-target-popover"
                      role="menu"
                      style={
                        waitPos
                          ? {
                              left: waitPos.left,
                              top: waitPos.top,
                              maxHeight: waitPos.maxHeight,
                              maxWidth: waitPos.maxWidth,
                            }
                          : { left: -9999, top: -9999 }
                      }
                    >
                      {QUEUE_DELIVERY_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          role="menuitem"
                          className="menu-item composer-menu-item"
                          disabled={option.needsFork && !canQueueFork}
                          title={
                            option.needsFork && !canQueueFork
                              ? FORK_REQUIREMENT_TITLE
                              : option.title
                          }
                          onClick={() => void submitDeliveryTurn(option.delivery)}
                        >
                          {option.label}
                        </button>
                      ))}
                      {waitTargets.length > 0 ? (
                        <>
                          <div className="composer-menu-divider" role="separator" />
                          <div className="composer-menu-label wait-target-placeholder">
                            Queue after existing session...
                          </div>
                        </>
                      ) : null}
                      {waitTargets.map((target) => (
                        <button
                          key={target.agentId}
                          type="button"
                          role="menuitem"
                          className="menu-item wait-target-item"
                          title={waitLabelWithShortcut(target.label, target.shortcutLabel)}
                          onPointerEnter={() => onWaitTargetHover(target.agentId)}
                          onPointerLeave={() => onWaitTargetHover(null)}
                          onFocus={() => onWaitTargetHover(target.agentId)}
                          onBlur={() => onWaitTargetHover(null)}
                          onClick={() => void submitWaitTurn(target)}
                        >
                          <span className={waitTargetStatusDotClass(target)} aria-hidden="true" />
                          <span className="wait-target-title">
                            {waitLabelWithShortcut(target.label, target.shortcutLabel)}
                          </span>
                          <span className="wait-target-status">
                            {waitTargetStatusLabel(target)}
                          </span>
                        </button>
                      ))}
                    </div>,
                        document.body,
                      )
                    : null}
                </div>
              )}
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
