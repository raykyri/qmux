import { useEffect, useMemo, useState } from "react";
import type { AgentAdapterMetadata, GroupInfo } from "../../types";

interface NewResearchDialogProps {
  open: boolean;
  adapters: AgentAdapterMetadata[];
  workspaces: GroupInfo[];
  initialWorkspaceId?: string | null;
  onClose: () => void;
  onChooseWorkspace: () => Promise<GroupInfo | null>;
  onCreate: (input: {
    prompt: string;
    adapter: string;
    model: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
}

const DEFAULT_RESEARCH_FOLDER = "__default_research_folder__";

export default function NewResearchDialog({
  open,
  adapters: allAdapters,
  workspaces,
  initialWorkspaceId,
  onClose,
  onChooseWorkspace,
  onCreate,
}: NewResearchDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [adapter, setAdapter] = useState("");
  const [model, setModel] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  // Shown inside the dialog: a global banner renders behind the modal
  // backdrop, so a failed launch (bad model name, missing folder…) looked
  // like an unresponsive Start button. Fields are kept for the retry.
  const [error, setError] = useState<string | null>(null);
  // Research is built on branching follow-ups, which require the adapter's
  // native fork command; offering a non-forkable adapter here would only be
  // discovered when the first follow-up fails after a completed root run.
  const adapters = useMemo(
    () => allAdapters.filter((candidate) => candidate.supportsFork),
    [allAdapters],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setPrompt("");
    setModel("");
    setError(null);
    setAdapter(adapters.find((candidate) => candidate.default)?.id ?? adapters[0]?.id ?? "");
    setWorkspaceId(
      workspaces.some((workspace) => workspace.id === initialWorkspaceId)
        ? initialWorkspaceId!
        : workspaces[0]?.id ?? DEFAULT_RESEARCH_FOLDER,
    );
  }, [open]);

  useEffect(() => {
    if (
      !open ||
      workspaceId === DEFAULT_RESEARCH_FOLDER ||
      workspaces.some((workspace) => workspace.id === workspaceId)
    ) {
      return;
    }
    setWorkspaceId(
      workspaces.some((workspace) => workspace.id === initialWorkspaceId)
        ? initialWorkspaceId!
        : workspaces[0]?.id ?? DEFAULT_RESEARCH_FOLDER,
    );
  }, [initialWorkspaceId, open, workspaceId, workspaces]);

  useEffect(() => {
    if (!open || adapters.some((candidate) => candidate.id === adapter)) {
      return;
    }
    setAdapter(adapters.find((candidate) => candidate.default)?.id ?? adapters[0]?.id ?? "");
  }, [adapter, adapters, open]);

  if (!open) {
    return null;
  }

  async function submit() {
    if (!prompt.trim() || !adapter || !workspaceId || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        prompt: prompt.trim(),
        adapter,
        model: model.trim() || null,
        workspaceId: workspaceId === DEFAULT_RESEARCH_FOLDER ? null : workspaceId,
      });
      onClose();
    } catch (err) {
      // Surfaced here, where the user is looking; the dialog stays open with
      // every field intact for the retry.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function chooseWorkspace() {
    if (choosingWorkspace || submitting) {
      return;
    }
    setChoosingWorkspace(true);
    try {
      const workspace = await onChooseWorkspace();
      if (workspace) {
        setWorkspaceId(workspace.id);
      }
    } finally {
      setChoosingWorkspace(false);
    }
  }

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting && !choosingWorkspace) {
          onClose();
        }
      }}
    >
      <form
        className="confirm-dialog new-research-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-research-title"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="new-research-title">New research</h2>
        <textarea
          autoFocus
          value={prompt}
          placeholder="What would you like to investigate?"
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !submitting && !choosingWorkspace) {
              onClose();
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="new-research-workspace-option">
          <div>
            <label>
              <span>Run in folder</span>
              <select
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.currentTarget.value)}
              >
                <option value={DEFAULT_RESEARCH_FOLDER}>Default research folder</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.nameOverride || workspace.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedWorkspace ? (
              <small title={selectedWorkspace.dir}>{selectedWorkspace.dir}</small>
            ) : (
              <small>An empty private qmux folder, created when you start.</small>
            )}
          </div>
          <button
            type="button"
            disabled={choosingWorkspace || submitting}
            onClick={() => void chooseWorkspace()}
          >
            {choosingWorkspace ? "Choosing…" : "Choose folder…"}
          </button>
        </div>
        <p className="new-research-permissions">
          The agent can access this folder using its normal permissions.
        </p>
        <details className="new-research-advanced">
          <summary>Advanced</summary>
          <div className="new-research-options">
            <label>
              <span>Agent</span>
              <select value={adapter} onChange={(event) => setAdapter(event.currentTarget.value)}>
                {adapters.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Model (optional)</span>
              <input
                type="text"
                value={model}
                placeholder="Agent default"
                onChange={(event) => setModel(event.currentTarget.value)}
              />
            </label>
          </div>
        </details>
        {adapters.length === 0 ? (
          <p className="new-research-unavailable" role="alert">
            No installed agent supports research follow-ups.
          </p>
        ) : null}
        {error ? (
          <p className="new-research-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button type="button" disabled={submitting || choosingWorkspace} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!prompt.trim() || !adapter || !workspaceId || submitting || choosingWorkspace}
          >
            {submitting ? "Starting…" : "Start research"}
          </button>
        </div>
      </form>
    </div>
  );
}
