import { useState } from "react";
import { submitPaneInput } from "../lib/api";
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

  async function submitText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    setSubmitting(true);
    try {
      await submitPaneInput(pane.id, trimmed);
      setValue("");
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
        void submitText(value);
      }}
    >
      <textarea
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        placeholder={
          awaitingPermission ? "Approve or deny the pending tool use..." : "Send a turn..."
        }
        rows={2}
      />
      <div className="native-input-actions">
        {awaitingPermission ? (
          <>
            <button type="button" onClick={() => void submitText("y")} disabled={submitting}>
              Approve
            </button>
            <button type="button" onClick={() => void submitText("n")} disabled={submitting}>
              Deny
            </button>
          </>
        ) : null}
        <button type="submit" disabled={submitting || value.trim().length === 0}>
          Send
        </button>
      </div>
    </form>
  );
}
