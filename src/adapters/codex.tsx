import type { AgentUiAdapter, ComposerPolicy } from ".";

export const CODEX_ADAPTER_ID = "codex";

const codexComposerPolicy: ComposerPolicy = {
  readyStatuses: ["awaitingInput", "done", "idle"],
  queueStatuses: ["starting", "running", "awaitingPermission"],
  steerStatuses: ["starting", "running"],
  permissionActions: [],
};

export const codexUiAdapter: AgentUiAdapter = {
  id: CODEX_ADAPTER_ID,
  label: "Codex",
  composerPolicy: () => codexComposerPolicy,
};
