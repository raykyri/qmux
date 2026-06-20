import type { AgentUiAdapter, ComposerPolicy, LauncherOptionsProps } from ".";
import type { Turn } from "../types";

export const CLAUDE_ADAPTER_ID = "claude";

const claudeComposerPolicy: ComposerPolicy = {
  readyStatuses: ["awaitingInput", "done", "idle"],
  queueStatuses: ["starting", "running", "awaitingPermission"],
  steerStatuses: ["starting", "running"],
  permissionActions: [
    { id: "approve", label: "Approve", input: "y" },
    { id: "deny", label: "Deny", input: "n" },
  ],
};

export const claudeUiAdapter: AgentUiAdapter = {
  id: CLAUDE_ADAPTER_ID,
  label: "Claude",
  LauncherOptions: ClaudeLauncherOptions,
  normalizeTurns: normalizeClaudeTurns,
  composerPolicy: () => claudeComposerPolicy,
};

function ClaudeLauncherOptions({ value, onChange }: LauncherOptionsProps) {
  const permissionMode = typeof value.permissionMode === "string" ? value.permissionMode : "";

  return (
    <label className="command-launcher-option">
      <span>Permission</span>
      <select
        value={permissionMode}
        onChange={(event) => {
          const next = { ...value };
          if (event.currentTarget.value) {
            next.permissionMode = event.currentTarget.value;
          } else {
            delete next.permissionMode;
          }
          onChange(next);
        }}
      >
        <option value="">Default</option>
        <option value="auto">Auto</option>
        <option value="acceptEdits">Accept edits</option>
        <option value="dontAsk">Don't ask</option>
        <option value="plan">Plan</option>
        <option value="bypassPermissions">Bypass</option>
      </select>
    </label>
  );
}

// Claude's transcript logs a queued prompt twice: once as a `queue-operation`
// entry when it is enqueued, then again as a `user` turn when it is actually
// submitted. With the empty bookkeeping entries filtered out, those two land
// next to each other with identical text, so drop the queue-operation duplicate.
// Any queue-operation turn that survives is still just the user's queued prompt,
// so relabel it to render as a plain user message.
function normalizeClaudeTurns(turns: Turn[]): Turn[] {
  const result: Turn[] = [];
  turns.forEach((turn, index) => {
    if (turn.role !== "queue-operation") {
      result.push(turn);
      return;
    }
    const text = turnText(turn);
    if (!text) {
      result.push(turn);
      return;
    }
    const hasAdjacentUserDuplicate = [turns[index - 1], turns[index + 1]].some(
      (neighbor) => neighbor?.role === "user" && turnText(neighbor) === text,
    );
    if (hasAdjacentUserDuplicate) {
      return;
    }
    result.push({ ...turn, role: "user" });
  });
  return result;
}

function turnText(turn: Turn): string {
  return turn.blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      return "";
    })
    .join("")
    .trim();
}
