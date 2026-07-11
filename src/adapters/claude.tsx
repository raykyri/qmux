import { LauncherSelect } from "../components/LauncherSelect";
import type { LauncherSelectOption } from "../components/LauncherSelect";
import type { AgentUiAdapter, ComposerPolicy, LauncherOptionsProps } from ".";
import { normalizeClaudeTurns } from "./claudeTurns";

const CLAUDE_PERMISSION_OPTIONS: LauncherSelectOption[] = [
  { value: "auto", label: "Auto mode" },
  { value: "manual", label: "Ask for approval" },
  { value: "acceptEdits", label: "Only accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "dontAsk", label: "Block approval requests" },
  { value: "bypassPermissions", label: "Bypass permissions", tone: "danger" },
];

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
  const permissionMode = typeof value.permissionMode === "string" ? value.permissionMode : "auto";

  return (
    <LauncherSelect
      ariaLabel="Permission mode"
      value={permissionMode}
      options={CLAUDE_PERMISSION_OPTIONS}
      onChange={(next) => {
        const updated = { ...value };
        if (next) {
          updated.permissionMode = next;
        } else {
          delete updated.permissionMode;
        }
        onChange(updated);
      }}
    />
  );
}
