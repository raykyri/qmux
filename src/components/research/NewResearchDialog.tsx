import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentAdapterMetadata } from "../../types";
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
  workspaceId: string | null;
  onClose: () => void;
  onCreate: (input: {
    prompt: string;
    adapter: string;
    model: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
}

export default function NewResearchDialog({
  open,
  adapters: allAdapters,
  requireCmdEnterToSend,
  workspaceId,
  onClose,
  onCreate,
}: NewResearchDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [adapter, setAdapter] = useState("");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
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
  }, [open]);

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
    if (!prompt.trim() || !adapter || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        prompt: prompt.trim(),
        adapter,
        model: model.trim() || null,
        workspaceId,
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
        if (event.target === event.currentTarget && !submitting) {
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
          if (event.key === "Escape" && !submitting) {
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
                  !prompt.trim() || !adapter || submitting
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
