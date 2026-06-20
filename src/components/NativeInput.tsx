import { type DragEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EllipsisVertical, X } from "lucide-react";
import {
  listAgentTurnQueue,
  removeQueuedAgentTurn,
  reorderQueuedAgentTurn,
  submitAgentTurn,
  submitPaneInput,
} from "../lib/api";
import type { AgentInfo, PaneInfo } from "../types";

// The composer grows with its content up to this height, then scrolls.
const MAX_INPUT_HEIGHT = 200;

// A quick, subtle ease for the queued-turn collapse/expand. CSS can't transition
// to/from `auto`, so we measure both layouts and tween between explicit pixel
// heights, then hand control back to CSS once it settles.
const QUEUED_TURN_ANIM_MS = 120;

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
  queuedTurns: string[];
  collapsedQueuedTurns: boolean[];
  transcriptText: string;
  transcriptCopyText: () => string;
  onQueueChange: (agentId: string, queuedTurns: string[]) => void;
  onDraftChange: (agentId: string, draft: string) => void;
  onQueuedTurnCollapseToggle: (agentId: string, index: number) => void;
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
  onQueueChange,
  onDraftChange,
  onQueuedTurnCollapseToggle,
  onError,
}: NativeInputProps) {
  const value = draft;
  const setValue = (next: string) => onDraftChange(agent.id, next);
  const [submitting, setSubmitting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Drag-to-reorder of the queued turns. draggingIndex is the row being dragged;
  // dropIndex is the gap (0..length) it would land in.
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const queueStackRef = useRef<HTMLDivElement | null>(null);
  const previousQueueLength = useRef(queuedTurns.length);
  const previousAgentId = useRef(agent.id);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const awaitingPermission = agent.status === "awaitingPermission";
  const canSend = agent.status === "awaitingInput" || agent.status === "stopped";
  const canQueue =
    agent.status === "starting" ||
    agent.status === "running" ||
    agent.status === "awaitingPermission";
  // Send is disabled while the agent is actively working; offer Steer to inject
  // the message into the running turn anyway instead of only being able to queue.
  const isWorking = agent.status === "starting" || agent.status === "running";
  const hasTranscript = transcriptText.trim().length > 0;
  const sendDisabled = submitting || !canSend || value.trim().length === 0;

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
      !window.confirm("Replace the current input with this queued item?")
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
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleQueueDragStart(event: DragEvent<HTMLDivElement>, index: number) {
    setDraggingIndex(index);
    setDropIndex(null);
    event.dataTransfer.effectAllowed = "move";
    // Firefox only begins a drag once some data has been set.
    try {
      event.dataTransfer.setData("text/plain", String(index));
    } catch {
      // Some platforms reject setData here; the drag still works without it.
    }
  }

  function handleQueueDragOver(event: DragEvent<HTMLDivElement>, index: number) {
    if (draggingIndex === null) {
      return;
    }
    // Permit the drop and mark the gap the row would land in — above or below the
    // hovered row depending on which half the cursor is over.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY - rect.top > rect.height / 2;
    setDropIndex(after ? index + 1 : index);
  }

  function handleQueueDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const from = draggingIndex;
    const gap = dropIndex;
    setDraggingIndex(null);
    setDropIndex(null);
    if (from === null || gap === null) {
      return;
    }
    const to = from < gap ? gap - 1 : gap;
    if (to === from) {
      return;
    }
    const next = [...queuedTurns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // Reorder the displayed queue immediately, then persist so a reload keeps it.
    onQueueChange(agent.id, next);
    void persistQueueReorder(from, to, moved);
  }

  function handleQueueDragEnd() {
    setDraggingIndex(null);
    setDropIndex(null);
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
                key={`${index}-${turn}`}
                className={className}
                draggable
                onDragStart={(event) => handleQueueDragStart(event, index)}
                onDragOver={(event) => handleQueueDragOver(event, index)}
                onDrop={handleQueueDrop}
                onDragEnd={handleQueueDragEnd}
              >
                <button
                  type="button"
                  className="queued-turn-toggle"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand queued turn" : "Collapse queued turn"}
                  onClick={() => onQueuedTurnCollapseToggle(agent.id, index)}
                >
                  <QueuedTurnText turn={turn} collapsed={collapsed} />
                </button>
                <div className="queued-turn-actions">
                  <button
                    type="button"
                    className="queued-turn-remove"
                    aria-label="Remove queued turn"
                    disabled={submitting}
                    onClick={() => void removeQueuedTurn(index, turn)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void editQueuedTurn(index, turn)}
                  >
                    Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.metaKey && event.key === "Enter") {
            event.preventDefault();
            if (canSend) {
              void submitTurn(value, "send");
            } else if (canQueue) {
              void submitTurn(value, "queue");
            }
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
        <div className="composer-menu" ref={menuRef}>
          <button
            type="button"
            className="composer-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <EllipsisVertical size={16} aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div className="composer-menu-popover" role="menu">
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
            </div>
          ) : null}
        </div>
        <div className="native-input-submit-actions">
          {awaitingPermission ? (
            <>
              <button
                type="button"
                onClick={() => void submitPermissionResponse("y")}
                disabled={submitting}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void submitPermissionResponse("n")}
                disabled={submitting}
              >
                Deny
              </button>
            </>
          ) : null}
          {!sendDisabled ? (
            <button type="button" onClick={() => void submitTurn(value, "send")}>
              <span>Send</span>
              <span className="shortcut-hint" aria-label="Command Enter">
                ⌘↵
              </span>
            </button>
          ) : null}
          {isWorking ? (
            <button
              type="button"
              disabled={submitting || value.trim().length === 0}
              onClick={() => void submitTurn(value, "steer")}
              title="Send now, interrupting the agent's current work"
            >
              <span>Steer</span>
            </button>
          ) : null}
          <button
            type="button"
            className="queue-button"
            disabled={submitting || !canQueue || value.trim().length === 0}
            onClick={() => void submitTurn(value, "queue")}
          >
            <span>Queue</span>
            {canQueue ? (
              <span className="shortcut-hint" aria-label="Command Enter">
                ⌘↵
              </span>
            ) : null}
          </button>
        </div>
      </div>
    </form>
  );
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
