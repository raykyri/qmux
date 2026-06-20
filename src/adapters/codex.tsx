import { LauncherSelect } from "../components/LauncherSelect";
import type { LauncherSelectOption } from "../components/LauncherSelect";
import type { AgentUiAdapter, ComposerPolicy, LauncherOptionsProps } from ".";

export const CODEX_ADAPTER_ID = "codex";

const CODEX_SANDBOX_OPTIONS: LauncherSelectOption[] = [
  { value: "workspace-write", label: "Workspace access" },
  { value: "danger-full-access", label: "Full access" },
];

const CODEX_APPROVAL_OPTIONS: LauncherSelectOption[] = [
  { value: "", label: "Default approvals" },
  { value: "on-request", label: "Allow approval requests" },
  { value: "never", label: "Block approval requests" },
];

const codexComposerPolicy: ComposerPolicy = {
  readyStatuses: ["awaitingInput", "done", "idle"],
  queueStatuses: ["starting", "running", "awaitingPermission"],
  steerStatuses: ["starting", "running"],
  permissionActions: [],
};

export const codexUiAdapter: AgentUiAdapter = {
  id: CODEX_ADAPTER_ID,
  label: "Codex",
  LauncherOptions: CodexLauncherOptions,
  composerPolicy: () => codexComposerPolicy,
};

function CodexLauncherOptions({ value, onChange }: LauncherOptionsProps) {
  const sandbox = stringOption(value.sandbox) || "workspace-write";
  const approvalPolicy = stringOption(value.approvalPolicy);

  return (
    <>
      <LauncherSelect
        ariaLabel="Sandbox access"
        value={sandbox}
        options={CODEX_SANDBOX_OPTIONS}
        onChange={(next) => setOption(value, onChange, "sandbox", next)}
      />
      <LauncherSelect
        ariaLabel="Approval policy"
        value={approvalPolicy}
        options={CODEX_APPROVAL_OPTIONS}
        onChange={(next) => setOption(value, onChange, "approvalPolicy", next)}
      />
    </>
  );
}

function stringOption(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function setOption(
  value: Record<string, unknown>,
  onChange: (next: Record<string, unknown>) => void,
  key: string,
  nextValue: string | boolean,
) {
  const next = { ...value };
  if (nextValue === "" || nextValue === false) {
    delete next[key];
  } else {
    next[key] = nextValue;
  }
  onChange(next);
}
