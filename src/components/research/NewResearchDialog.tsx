import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentAdapterMetadata, GroupInfo } from "../../types";
import { LauncherSelect, type LauncherSelectOption } from "../LauncherSelect";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../ComposerSubmitShortcut";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "../../lib/adapterIcons";

interface NewResearchDialogProps {
  open: boolean;
  adapters: AgentAdapterMetadata[];
  requireCmdEnterToSend: boolean;
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
// Sentinel option value in the folder picker that opens the native folder
// chooser instead of selecting; never stored as the workspace value.
const CHOOSE_FOLDER_OPTION = "__choose_research_folder__";

// Same folder glyph the launcher selects use as a select lead icon, encoded for
// an <img src> so LauncherSelect options can carry it.
const FOLDER_ICON_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#9ca6a1' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'/></svg>",
)}`;

export default function NewResearchDialog({
  open,
  adapters: allAdapters,
  requireCmdEnterToSend,
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
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
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

  // Grow the textarea to fit its content, like the Home launcher: multi-line
  // prompts expand the composer until the CSS max-height caps it.
  const growPromptInput = useCallback(() => {
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => {
    if (open) {
      growPromptInput();
    }
  }, [growPromptInput, open]);

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

  const folderOptions: LauncherSelectOption[] = [
    {
      value: DEFAULT_RESEARCH_FOLDER,
      label: "Default research folder",
      iconSrc: FOLDER_ICON_SRC,
    },
    ...workspaces.map((workspace) => ({
      value: workspace.id,
      label: workspace.nameOverride || workspace.name,
      iconSrc: FOLDER_ICON_SRC,
    })),
    {
      value: CHOOSE_FOLDER_OPTION,
      label: choosingWorkspace ? "Choosing…" : "Choose folder…",
      dividerBefore: true,
    },
  ];

  const adapterOptions: LauncherSelectOption[] = adapters.map((candidate) => ({
    value: candidate.id,
    label: candidate.label,
    iconSrc: ADAPTER_ICON_BY_ID[candidate.id],
    iconClassName: adapterIconClassName(candidate.id),
  }));

  return (
    <div
      className="confirm-dialog-backdrop new-research-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting && !choosingWorkspace) {
          onClose();
        }
      }}
    >
      <form
        className="command-launcher new-research-launcher"
        role="dialog"
        aria-modal="true"
        aria-label="New research"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !submitting && !choosingWorkspace) {
            onClose();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="new-research-composer">
          <textarea
            ref={promptRef}
            autoFocus
            className="command-launcher-input"
            rows={2}
            value={prompt}
            placeholder="What would you like to investigate?"
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
              growPromptInput();
            }}
            onKeyDown={(event) => {
              if (isComposerSubmitShortcut(event, requireCmdEnterToSend)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="command-launcher-overlay">
            <div className="command-launcher-overlay-group">
              <div className="command-launcher-options">
                <LauncherSelect
                  value={workspaceId}
                  options={folderOptions}
                  ariaLabel="Run in folder"
                  onChange={(value) => {
                    if (value === CHOOSE_FOLDER_OPTION) {
                      void chooseWorkspace();
                      return;
                    }
                    setWorkspaceId(value);
                  }}
                />
              </div>
            </div>
            <div className="command-launcher-controls">
              <div className="command-launcher-adapter-select">
                <LauncherSelect
                  value={adapter}
                  options={adapterOptions}
                  ariaLabel="Agent"
                  onChange={setAdapter}
                />
              </div>
              <button
                type="submit"
                className="command-launcher-send new-research-send"
                disabled={
                  !prompt.trim() || !adapter || !workspaceId || submitting || choosingWorkspace
                }
              >
                <span>{submitting ? "Starting…" : "Start research"}</span>
                <ComposerSubmitShortcutGlyph
                  requireCmdEnter={requireCmdEnterToSend}
                  ariaHidden
                />
              </button>
            </div>
          </div>
        </div>
        <div className="new-research-footer">
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
          <p className="new-research-hint" title={selectedWorkspace?.dir}>
            {selectedWorkspace ? (
              <span className="new-research-hint-path">{selectedWorkspace.dir}</span>
            ) : (
              <span>An empty private qmux folder, created when you start.</span>
            )}{" "}
            The agent can access this folder using its normal permissions.
          </p>
          <details className="new-research-advanced">
            <summary>Advanced</summary>
            <label className="new-research-model">
              <span>Model (optional)</span>
              <input
                type="text"
                value={model}
                placeholder="Agent default"
                onChange={(event) => setModel(event.currentTarget.value)}
              />
            </label>
          </details>
        </div>
      </form>
    </div>
  );
}
