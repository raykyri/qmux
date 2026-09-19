import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { LauncherSelect } from "../LauncherSelect";
import {
  applyResearchRecapCandidate,
  generateResearchRecapCandidate,
  getResearchRecapDefaultInstructions,
  probeAgentAdapters,
} from "../../lib/api";
import { modelPresetsFor } from "../../lib/launcherModels";
import {
  Button,
  Dialog,
  DialogActions,
  DialogRoot,
  DialogTitle,
  Input,
  Popover,
  PopoverPortal,
  Textarea,
  classNames,
  nextEnabledIndex,
  useAnchoredPopover,
  useListbox,
} from "../ui";
import type {
  AgentAdapterMetadata,
  ResearchNode,
  ResearchNodeContent,
  ResearchRecapCandidate,
} from "../../types";

/** Matches MAX_RECAP_INSTRUCTIONS_CHARS in research_recap.rs, so the field
 * stops accepting text before the command rejects it. */
const MAX_INSTRUCTIONS = 4_000;

/** A free-text model field that also offers the adapter's presets. The text
 * is authoritative — the adapter accepts names the presets do not list — so
 * this is a combobox over a filtered listbox, not a select. */
function SuggestedModelInput({
  value,
  suggestions,
  disabled,
  id,
  onChange,
}: {
  value: string;
  suggestions: string[];
  disabled: boolean;
  id: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const listboxId = `research-recap-model-options-${generatedId}`;
  const options = useMemo(() => {
    const query = value.trim().toLowerCase();
    return suggestions
      .filter((suggestion) => !query || suggestion.toLowerCase().includes(query))
      .map((suggestion) => ({ value: suggestion, label: suggestion }));
  }, [suggestions, value]);
  const listbox = useListbox({
    options,
    value,
    open,
    onOpenChange: setOpen,
    onChange: (next) => {
      onChange(next);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  });
  const popoverStyle = useAnchoredPopover({
    open,
    onClose: listbox.closeListbox,
    triggerRef: inputRef,
    popoverRef,
    preferredWidth: "trigger",
  });

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const openSuggestions = () => {
    if (disabled || listbox.empty) return;
    listbox.openListbox();
  };
  const expanded = open && options.length > 0;

  return (
    <>
      <Input
        ref={inputRef}
        id={id}
        className="research-recap-control"
        value={value}
        placeholder="Agent default"
        maxLength={256}
        disabled={disabled}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={expanded ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          expanded && listbox.activeIndex >= 0
            ? `${listboxId}-option-${listbox.activeIndex}`
            : undefined
        }
        onFocus={openSuggestions}
        onClick={openSuggestions}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          openSuggestions();
        }}
        onKeyDown={(event) => {
          // Escape and Tab dismissal, outside clicks and placement all belong
          // to useAnchoredPopover; only list traversal is handled here, so the
          // field keeps ordinary text editing.
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              openSuggestions();
              return;
            }
            listbox.setActiveIndex((current) =>
              nextEnabledIndex(options, current, event.key === "ArrowDown" ? 1 : -1),
            );
            return;
          }
          if (event.key === "Enter" && expanded) {
            event.preventDefault();
            listbox.chooseIndex(listbox.activeIndex >= 0 ? listbox.activeIndex : 0);
          }
        }}
      />
      {expanded ? (
        <PopoverPortal target={inputRef.current?.closest(".confirm-dialog-backdrop")}>
          <Popover
            ref={popoverRef}
            id={listboxId}
            className="launcher-select-popover research-recap-model-suggestions"
            role="listbox"
            aria-label="Suggested models"
            style={popoverStyle ?? { left: -9999, top: -9999 }}
          >
            {options.map((option, index) => (
              <Button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                variant="menu"
                role="option"
                tabIndex={-1}
                aria-selected={index === listbox.selectedIndex}
                className={classNames(
                  "launcher-select-item",
                  index === listbox.activeIndex && "is-highlighted",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => listbox.setActiveIndex(index)}
                onClick={() => listbox.chooseIndex(index)}
              >
                <span className="launcher-select-item-label">{option.label}</span>
              </Button>
            ))}
          </Popover>
        </PopoverPortal>
      ) : null}
    </>
  );
}

export interface ResearchRecapDialogProps {
  content: ResearchNodeContent;
  onClose: () => void;
  onApplied: (node: ResearchNode) => void;
}

/** The dialog's body. Exported so rendering tests can mount it directly:
 * `DialogRoot` portals through `document`, which server rendering has none of. */
export function ResearchRecapDialogPanel({
  content,
  onClose,
  onApplied,
  applying = false,
  onApplyingChange,
}: ResearchRecapDialogProps & {
  /** Owned by the wrapper so the backdrop can refuse dismissal mid-apply. */
  applying?: boolean;
  onApplyingChange?: (applying: boolean) => void;
}) {
  // The answer revision and the recap the user is comparing against are read
  // once: both are the guards the apply is checked against, so a background
  // refresh must not move them under the open dialog.
  const baselineRef = useRef({
    responseRevision: content.responseRevision ?? "",
    recap: content.node.recap ?? null,
  });
  const baseline = baselineRef.current;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const generatedId = useId();
  const titleId = `research-recap-dialog-title-${generatedId}`;
  const instructionsId = `research-recap-instructions-${generatedId}`;
  const modelId = `research-recap-model-${generatedId}`;
  const [adapters, setAdapters] = useState<AgentAdapterMetadata[]>([]);
  const [adapter, setAdapter] = useState("");
  const [model, setModel] = useState(baseline.recap?.model?.trim() ?? "");
  const [instructions, setInstructions] = useState(baseline.recap?.instructions?.trim() ?? "");
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [candidate, setCandidate] = useState<ResearchRecapCandidate | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setApplying = (next: boolean) => onApplyingChange?.(next);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [probed, defaultInstructions] = await Promise.all([
          probeAgentAdapters({ force: true }),
          getResearchRecapDefaultInstructions(),
        ]);
        if (cancelled) return;
        const available = probed.filter(
          (candidateAdapter) =>
            candidateAdapter.supportsRecapGeneration &&
            candidateAdapter.researchReadiness === "ready",
        );
        setAdapters(available);
        const preferred =
          available.find((candidateAdapter) => candidateAdapter.id === baseline.recap?.adapter) ??
          available.find((candidateAdapter) => candidateAdapter.id === content.node.adapter) ??
          available.find((candidateAdapter) => candidateAdapter.default) ??
          available[0];
        setAdapter(preferred?.id ?? "");
        if (!baseline.recap?.instructions?.trim()) {
          setInstructions(defaultInstructions);
        }
        // Carry a model over only when the chosen agent is the one it belongs
        // to; another agent would reject it.
        if (preferred && preferred.id === baseline.recap?.adapter) {
          setModel(baseline.recap.model?.trim() ?? "");
        } else if (preferred && preferred.id === content.node.adapter) {
          setModel(content.node.model?.trim() ?? "");
        } else {
          setModel("");
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoadingOptions(false);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    baseline.recap?.adapter,
    baseline.recap?.instructions,
    baseline.recap?.model,
    content.node.adapter,
    content.node.model,
  ]);

  const selectedAdapter = adapters.find((candidateAdapter) => candidateAdapter.id === adapter);
  const modelPresets = useMemo(
    () => modelPresetsFor(adapter).filter((preset) => preset !== "custom"),
    [adapter],
  );
  const busy = loadingOptions || generating || applying;

  // A candidate belongs to the settings it was generated from; changing any of
  // them drops it rather than letting the wrong preview be applied.
  const clearCandidate = () => {
    setCandidate(null);
    setError(null);
  };

  const generate = async () => {
    if (!adapter || !instructions.trim() || !baseline.responseRevision) return;
    setGenerating(true);
    setCandidate(null);
    setError(null);
    try {
      setCandidate(
        await generateResearchRecapCandidate({
          nodeId: content.node.id,
          expectedResponseRevision: baseline.responseRevision,
          adapter,
          model: model.trim() || null,
          instructions: instructions.trim(),
        }),
      );
    } catch (generationError) {
      // The current summary is untouched: a failed generation only reports.
      setError(generationError instanceof Error ? generationError.message : String(generationError));
    } finally {
      setGenerating(false);
    }
  };

  const apply = async () => {
    if (!candidate) return;
    setApplying(true);
    setError(null);
    try {
      const node = await applyResearchRecapCandidate({
        nodeId: content.node.id,
        expectedResponseRevision: baseline.responseRevision,
        expectedCurrentRecapId: baseline.recap?.id ?? null,
        candidate,
      });
      onApplied(node);
      onClose();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog className="research-recap-dialog" aria-labelledby={titleId}>
      <header className="research-recap-dialog-header">
        <DialogTitle id={titleId}>Generate summary</DialogTitle>
        <Button
          variant="icon"
          aria-label="Close summary generation"
          title="Close"
          disabled={applying}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </header>

      <div className="research-recap-instructions-field">
        <label htmlFor={instructionsId}>Instructions</label>
        <Textarea
          ref={textareaRef}
          id={instructionsId}
          className="research-recap-instructions"
          value={instructions}
          maxLength={MAX_INSTRUCTIONS}
          disabled={busy}
          onChange={(event) => {
            setInstructions(event.currentTarget.value);
            clearCandidate();
          }}
        />
      </div>
      <div className="research-recap-dialog-controls">
        <div className="research-recap-dialog-field">
          <span>Agent</span>
          <LauncherSelect
            value={adapter}
            options={adapters.map((candidateAdapter) => ({
              value: candidateAdapter.id,
              label: candidateAdapter.label,
            }))}
            ariaLabel="Agent"
            disabled={busy || adapters.length === 0}
            onChange={(value) => {
              setAdapter(value);
              setModel("");
              clearCandidate();
            }}
          />
        </div>
        <div className="research-recap-dialog-field">
          <label htmlFor={modelId}>Model</label>
          <SuggestedModelInput
            id={modelId}
            value={model}
            suggestions={modelPresets}
            disabled={busy || !adapter}
            onChange={(value) => {
              setModel(value);
              clearCandidate();
            }}
          />
        </div>
      </div>

      {loadingOptions ? (
        <p className="research-recap-dialog-status">
          <LoaderCircle className="confirm-dialog-action-spinner" size={14} aria-hidden="true" />
          Checking available agents…
        </p>
      ) : adapters.length === 0 ? (
        <p className="confirm-dialog-error" role="alert">
          No available agent supports summary generation.
        </p>
      ) : null}

      <DialogActions>
        <Button disabled={applying} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !adapter || !instructions.trim()} onClick={() => void generate()}>
          {generating ? "Generating…" : candidate ? "Generate again" : "Generate candidate"}
        </Button>
      </DialogActions>

      <div className="research-recap-comparison">
        <hr className="research-recap-comparison-divider" />
        <section className={candidate ? "research-recap-candidate" : "is-empty"}>
          <h3>Candidate</h3>
          {generating ? (
            <p className="research-recap-dialog-status">
              <LoaderCircle
                className="confirm-dialog-action-spinner"
                size={14}
                aria-hidden="true"
              />
              Generating with {selectedAdapter?.label ?? "agent"}…
            </p>
          ) : candidate ? (
            <p>{candidate.text}</p>
          ) : (
            <p>Generate a new summary first.</p>
          )}
        </section>
        <section>
          <h3>Current</h3>
          <p>{baseline.recap?.text}</p>
        </section>
      </div>

      {error ? (
        <p className="confirm-dialog-error" role="alert">
          {error}
        </p>
      ) : null}

      {candidate ? (
        <DialogActions>
          <Button tone="primary" disabled={generating || applying} onClick={() => void apply()}>
            {applying ? "Applying…" : "Use this summary"}
          </Button>
        </DialogActions>
      ) : null}
    </Dialog>
  );
}

/** Previews a regenerated summary for one completed answer. Nothing is
 * persisted until the candidate is applied, and the apply is refused if either
 * the answer or the summary moved while the dialog was open. */
export default function ResearchRecapDialog({
  content,
  onClose,
  onApplied,
}: ResearchRecapDialogProps) {
  const [applying, setApplying] = useState(false);
  return (
    <DialogRoot onDismiss={onClose} dismissDisabled={applying}>
      <ResearchRecapDialogPanel
        content={content}
        onClose={onClose}
        onApplied={onApplied}
        applying={applying}
        onApplyingChange={setApplying}
      />
    </DialogRoot>
  );
}
