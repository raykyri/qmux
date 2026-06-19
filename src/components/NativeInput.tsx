import { useState } from "react";
import { removeQueuedAgentTurn, submitAgentTurn, submitPaneInput } from "../lib/api";
import type { AgentInfo, PaneInfo } from "../types";

interface NativeInputProps {
  pane: PaneInfo;
  agent: AgentInfo;
  queuedTurns: string[];
  onQueueChange: (agentId: string, queuedTurns: string[]) => void;
  onError: (message: string) => void;
}

export default function NativeInput({
  pane,
  agent,
  queuedTurns,
  onQueueChange,
  onError,
}: NativeInputProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const awaitingPermission = agent.status === "awaitingPermission";
  const canSend = agent.status === "awaitingInput" || agent.status === "stopped";
  const canQueue =
    agent.status === "starting" ||
    agent.status === "running" ||
    agent.status === "awaitingPermission";

  async function submitTurn(text: string, mode: "send" | "queue") {
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
        rows={2}
      />
      <div className="native-input-actions">
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
    </form>
  );
}
