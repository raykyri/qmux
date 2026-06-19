import { useEffect, useRef, useState } from "react";
import { removeQueuedAgentTurn, submitAgentTurn, submitPaneInput } from "../lib/api";
import type { AgentInfo, PaneInfo } from "../types";

// The composer grows with its content up to this height, then scrolls.
const MAX_INPUT_HEIGHT = 200;

// Lucide "ellipsis" glyph (three horizontal dots), inlined to avoid pulling in a
// dependency for a single icon.
function EllipsisIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}

interface NativeInputProps {
  pane: PaneInfo;
  agent: AgentInfo;
  queuedTurns: string[];
  transcriptText: string;
  onQueueChange: (agentId: string, queuedTurns: string[]) => void;
  onError: (message: string) => void;
}

export default function NativeInput({
  pane,
  agent,
  queuedTurns,
  transcriptText,
  onQueueChange,
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
          <div className="queued-turn-stack-title">Queued</div>
          {queuedTurns.map((turn, index) => (
            <div key={`${index}-${turn}`} className="queued-turn">
              <div className="queued-turn-text">{turn}</div>
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
          ))}
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
          awaitingPermission ? "Approve or deny the pending tool use..." : "Send a turn..."
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
            <EllipsisIcon />
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
          <button
            type="button"
            disabled={submitting || !canSend || value.trim().length === 0}
            onClick={() => void submitTurn(value, "send")}
          >
            <span>Send</span>
            {canSend ? (
              <span className="shortcut-hint" aria-label="Command Enter">
                ⌘↵
              </span>
            ) : null}
          </button>
          {isWorking ? (
            <button
              type="button"
              className="steer-button"
              disabled={submitting || value.trim().length === 0}
              onClick={() => void submitTurn(value, "steer")}
              title="Send now, interrupting the agent's current work"
            >
              <span>Steer</span>
            </button>
          ) : null}
          <button
            type="button"
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
