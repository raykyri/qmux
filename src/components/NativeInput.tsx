import { useEffect, useRef, useState } from "react";
import { EllipsisVertical } from "lucide-react";
import { removeQueuedAgentTurn, submitAgentTurn, submitPaneInput } from "../lib/api";
import type { AgentInfo, PaneInfo } from "../types";

// The composer grows with its content up to this height, then scrolls.
const MAX_INPUT_HEIGHT = 200;

interface NativeInputProps {
  pane: PaneInfo;
  agent: AgentInfo;
  queuedTurns: string[];
  collapsedQueuedTurns: boolean[];
  transcriptText: string;
  onQueueChange: (agentId: string, queuedTurns: string[]) => void;
  onQueuedTurnCollapseToggle: (agentId: string, index: number) => void;
  onError: (message: string) => void;
}

export default function NativeInput({
  pane,
  agent,
  queuedTurns,
  collapsedQueuedTurns,
  transcriptText,
  onQueueChange,
  onQueuedTurnCollapseToggle,
  onError,
}: NativeInputProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
      await writeClipboardText(transcriptText);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
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
        <div className="queued-turn-stack" aria-label="Queued turns">
          {queuedTurns.map((turn, index) => {
            const collapsed = collapsedQueuedTurns[index] ?? false;
            return (
              <div
                key={`${index}-${turn}`}
                className={`queued-turn${collapsed ? " is-collapsed" : ""}`}
              >
                <button
                  type="button"
                  className="queued-turn-toggle"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand queued turn" : "Collapse queued turn"}
                  onClick={() => onQueuedTurnCollapseToggle(agent.id, index)}
                >
                  <span className="queued-turn-text">{turn}</span>
                </button>
                <div className="queued-turn-actions">
                  <button
                    type="button"
                    aria-label="Remove queued turn"
                    disabled={submitting}
                    onClick={() => void removeQueuedTurn(index, turn)}
                  >
                    x
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
            : "What should we implement next?"
        }
        rows={1}
      />
      <div className="native-input-actions">
        <div className="composer-menu" ref={menuRef}>
          <a
            href="#"
            className="composer-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            onClick={(event) => {
              event.preventDefault();
              setMenuOpen((open) => !open);
            }}
          >
            <EllipsisVertical size={18} aria-hidden="true" />
          </a>
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
