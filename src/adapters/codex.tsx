import type { AgentUiAdapter, ComposerPolicy, LauncherOptionsProps } from ".";

export const CODEX_ADAPTER_ID = "codex";

const codexComposerPolicy: ComposerPolicy = {
  readyStatuses: ["running", "awaitingInput", "done", "idle"],
  queueStatuses: ["starting", "awaitingPermission"],
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
  const sandbox = stringOption(value.sandbox);
  const approvalPolicy = stringOption(value.approvalPolicy);
  const search = value.search === true;

  return (
    <>
      <label className="command-launcher-option">
        <span>Sandbox</span>
        <select
          value={sandbox}
          onChange={(event) => setOption(value, onChange, "sandbox", event.currentTarget.value)}
        >
          <option value="">Default</option>
          <option value="read-only">Read-only</option>
          <option value="workspace-write">Workspace</option>
          <option value="danger-full-access">Full access</option>
        </select>
      </label>
      <label className="command-launcher-option">
        <span>Approval</span>
        <select
          value={approvalPolicy}
          onChange={(event) =>
            setOption(value, onChange, "approvalPolicy", event.currentTarget.value)
          }
        >
          <option value="">Default</option>
          <option value="untrusted">Untrusted</option>
          <option value="on-request">On request</option>
          <option value="never">Never</option>
        </select>
      </label>
      <label className="command-launcher-option command-launcher-option-toggle">
        <input
          type="checkbox"
          checked={search}
          onChange={(event) => setOption(value, onChange, "search", event.currentTarget.checked)}
        />
        <span>Search</span>
      </label>
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
