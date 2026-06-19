import { useState } from "react";
import { submitAgentTurn, submitPaneInput } from "../lib/api";
import type { AgentInfo, PaneInfo } from "../types";

interface NativeInputProps {
  pane: PaneInfo;
  agent: AgentInfo;
  onError: (message: string) => void;
}

export default function NativeInput({ pane, agent, onError }: NativeInputProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const awaitingPermission = agent.status === "awaitingPermission";

  async function submitTurn(text: string) {
    if (submitting) {
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    setSubmitting(true);
    try {
      await submitAgentTurn(agent.id, trimmed);
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

  return (
    <form
      className="native-input"
      onSubmit={(event) => {
        event.preventDefault();
        void submitTurn(value);
      }}
    >
      <textarea
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.metaKey && event.key === "Enter") {
            event.preventDefault();
            void submitTurn(value);
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
        <button type="submit" disabled={submitting || value.trim().length === 0}>
          <span>Send</span>
          <span className="shortcut-hint">Cmd-Enter</span>
        </button>
      </div>
    </form>
  );
}
