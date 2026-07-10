import { LauncherSelect } from "../components/LauncherSelect";
import type { LauncherSelectOption } from "../components/LauncherSelect";
import type { AgentUiAdapter, ComposerPolicy, LauncherOptionsProps } from ".";

export const CODEX_ADAPTER_ID = "codex";

const CODEX_SANDBOX_OPTIONS: LauncherSelectOption[] = [
  { value: "workspace-write", label: "Workspace access" },
  { value: "read-only", label: "Read-only access" },
  { value: "danger-full-access", label: "System access" },
];

const CODEX_AUTO_REVIEW_APPROVAL = "auto-review";
const CODEX_AUTO_REVIEWER = "auto_review";

const CODEX_APPROVAL_OPTIONS: LauncherSelectOption[] = [
  { value: CODEX_AUTO_REVIEW_APPROVAL, label: "Auto approvals" },
  { value: "", label: "Default approvals", dividerBefore: true },
  { value: "untrusted", label: "Ask for untrusted commands" },
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
  const approvalSelection = codexApprovalSelection(value);

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
        value={approvalSelection}
        options={CODEX_APPROVAL_OPTIONS}
        onChange={(next) => setApprovalOption(value, onChange, next)}
      />
    </>
  );
}

function stringOption(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function codexApprovalSelection(value: Record<string, unknown>): string {
  if (stringOption(value.approvalsReviewer) === CODEX_AUTO_REVIEWER) {
    return CODEX_AUTO_REVIEW_APPROVAL;
  }
  const approvalPolicy = stringOption(value.approvalPolicy);
  return approvalPolicy === "untrusted" ||
    approvalPolicy === "on-request" ||
    approvalPolicy === "never"
    ? approvalPolicy
    : "";
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

function setApprovalOption(
  value: Record<string, unknown>,
  onChange: (next: Record<string, unknown>) => void,
  nextValue: string,
) {
  const next = { ...value };
  delete next.approvalPolicy;
  delete next.approvalsReviewer;

  if (nextValue === CODEX_AUTO_REVIEW_APPROVAL) {
    next.approvalsReviewer = CODEX_AUTO_REVIEWER;
  } else if (nextValue) {
    next.approvalPolicy = nextValue;
  }

  onChange(next);
}
