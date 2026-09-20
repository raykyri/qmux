import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentAdapterMetadata } from "../../types";
import { LauncherSelect, type LauncherSelectOption } from "../LauncherSelect";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../ComposerSubmitShortcut";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "../../lib/adapterIcons";
import { CLAUDE_ADAPTER_ID, CLAUDE_EFFORT_OPTIONS } from "../../adapters/claude";
import { CODEX_ADAPTER_ID, CODEX_REASONING_OPTIONS } from "../../adapters/codex";
import {
  clearSessionDraft,
  loadSessionDraftJson,
  readSessionDraftJson,
  saveSessionDraftJson,
  SESSION_DRAFT_KEYS,
} from "../../lib/sessionDrafts";
import {
  CUSTOM_MODEL,
  formatLauncherModelLabel,
  modelPresetsFor,
  nextModelPreset,
  selectedModelPreset,
} from "../../lib/launcherModels";
import { launcherTabAction } from "../../lib/launcherKeyboard";
import {
  adapterCanLaunchResearch,
  adapterReadinessMessage,
  preferredResearchAdapter,
  researchReadyAdaptersFirst,
  researchReadinessLabel,
} from "../../lib/adapterReadiness";

// GPT-5.4 stops at extra high; every other Codex preset (and a custom model,
// whose ceiling is unknown here) offers the full range and lets the CLI
// reject a level the model does not support.
const GPT_5_4_REASONING_LEVELS = ["", "low", "medium", "high", "xhigh"];

// The Home composer's chips sit in a narrow overlay row, where "Medium effort"
// wastes the width the select's own "Reasoning effort" label already spends.
const CLAUDE_RESEARCH_EFFORT_OPTIONS = CLAUDE_EFFORT_OPTIONS.map((option) => ({
  ...option,
  label: option.label.replace(/ effort$/i, ""),
}));

// The reasoning/effort levels the selected model supports, or null for
// adapters without a reasoning-effort launch option. Every Claude model
// (Fable, Opus, Sonnet) shares one range; Codex ranges vary by model.
export function researchEffortOptionsFor(
  adapter: string,
  model: string,
): LauncherSelectOption[] | null {
  if (adapter === CLAUDE_ADAPTER_ID) {
    return CLAUDE_RESEARCH_EFFORT_OPTIONS;
  }
  if (adapter === CODEX_ADAPTER_ID) {
    if (model === "gpt-5.4") {
      return CODEX_REASONING_OPTIONS.filter((option) =>
        GPT_5_4_REASONING_LEVELS.includes(option.value),
      );
    }
    return CODEX_REASONING_OPTIONS;
  }
  return null;
}

interface ResearchQueryComposerProps {
  adapters: AgentAdapterMetadata[];
  requireCmdEnterToSend: boolean;
  workspaceId: string | null;
  onOpenAgentSettings: () => void;
  onCreate: (input: {
    prompt: string;
    adapter: string;
    model: string | null;
    effort: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
}

/** The Home page's query composer. Not a modal: it is the first row of the
 * Home feed, so it has no open/close state and no scrim — the page it lives on
 * is what comes and goes. */
export default function ResearchQueryComposer({
  adapters: allAdapters,
  requireCmdEnterToSend,
  workspaceId,
  onOpenAgentSettings,
  onCreate,
}: ResearchQueryComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [adapter, setAdapter] = useState("");
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [effortChoice, setEffortChoice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sessionDraftReady, setSessionDraftReady] = useState(false);
  const sessionDraftTouchedRef = useRef(false);
  const draftKey = SESSION_DRAFT_KEYS.newResearchInline;
  // Launch errors stay beside the Home composer so every field remains
  // available for a retry.
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  // General terminal-session fork support is intentionally wider than the
  // runtimes supported by research.
  const adapters = useMemo(
    () =>
      researchReadyAdaptersFirst(
        allAdapters.filter((candidate) => candidate.supportsResearch),
      ),
    [allAdapters],
  );
  const selectedAdapter = adapters.find((candidate) => candidate.id === adapter) ?? null;
  const adapterReady = adapterCanLaunchResearch(selectedAdapter);

  useEffect(() => {
    sessionDraftTouchedRef.current = false;
    const restored = readSessionDraftJson<{
      prompt: string;
      adapter: string;
      modelChoice: string | null;
      customModel: string;
    }>(draftKey);
    setPrompt(restored?.prompt ?? "");
    setModelChoice(restored?.modelChoice ?? null);
    setCustomModel(restored?.customModel ?? "");
    setEffortChoice("");
    setError(null);
    setAdapter(
      preferredResearchAdapter(adapters, restored?.adapter)?.id ??
        adapters.find((candidate) => candidate.default)?.id ??
        adapters[0]?.id ??
        "",
    );
    let disposed = false;
    void loadSessionDraftJson<{
      prompt: string;
      adapter: string;
      modelChoice: string | null;
      customModel: string;
    }>(draftKey)
      .then((backendDraft) => {
        if (!disposed && backendDraft && !sessionDraftTouchedRef.current) {
          setPrompt(backendDraft.prompt);
          setAdapter(backendDraft.adapter);
          setModelChoice(backendDraft.modelChoice);
          setCustomModel(backendDraft.customModel);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) {
          setSessionDraftReady(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [draftKey]);

  useEffect(() => {
    if (!sessionDraftReady) {
      return;
    }
    if (!prompt && !modelChoice && !customModel) {
      clearSessionDraft(draftKey);
      return;
    }
    saveSessionDraftJson(draftKey, { prompt, adapter, modelChoice, customModel });
  }, [adapter, customModel, draftKey, modelChoice, prompt, sessionDraftReady]);

  useEffect(() => {
    if (adapterCanLaunchResearch(adapters.find((candidate) => candidate.id === adapter))) {
      return;
    }
    setAdapter(preferredResearchAdapter(adapters)?.id ?? adapters[0]?.id ?? "");
  }, [adapter, adapters]);

  // Grow the textarea to fit the committed prompt value. Measuring directly in
  // onChange can catch WebKit between its native edit and React restoring the
  // controlled value, briefly sizing the field for a different wrap count.
  // useLayoutEffect keeps the value and height in the same pre-paint commit.
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [prompt]);

  // A stale choice (left over from another adapter) silently falls back to the
  // adapter's first preset, so the trigger always shows what will launch.
  const modelPresets = modelPresetsFor(adapter);
  const selectedModel = selectedModelPreset(adapter, modelChoice);
  const resolvedModel =
    selectedModel === CUSTOM_MODEL ? customModel.trim() || null : selectedModel;
  // Same stale-choice contract as the model picker: a level left over from
  // another adapter or model silently falls back to the default, so the
  // trigger always shows what will launch.
  const effortOptions = researchEffortOptionsFor(adapter, selectedModel);
  const selectedEffort =
    effortOptions && effortOptions.some((option) => option.value === effortChoice)
      ? effortChoice
      : "";
  const resolvedEffort = selectedEffort || null;

  async function submit() {
    if (!prompt.trim() || !adapter || !adapterReady || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        prompt: prompt.trim(),
        adapter,
        model: resolvedModel,
        effort: resolvedEffort,
        workspaceId,
      });
      // A successful launch opens its research page. The composer stays mounted
      // on Home, so clear it explicitly: returning here starts a fresh draft.
      setPrompt("");
      setModelChoice(null);
      setCustomModel("");
      setError(null);
      clearSessionDraft(draftKey);
    } catch (err) {
      // Surfaced here, where the user is looking, with every field intact for
      // the retry.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const adapterOptions: LauncherSelectOption[] = adapters.map((candidate, index) => ({
    value: candidate.id,
    label: candidate.label,
    iconSrc: ADAPTER_ICON_BY_ID[candidate.id],
    iconClassName: adapterIconClassName(candidate.id),
    detail: researchReadinessLabel(candidate),
    disabled: !adapterCanLaunchResearch(candidate),
    dividerBefore:
      !adapterCanLaunchResearch(candidate) &&
      index > 0 &&
      adapterCanLaunchResearch(adapters[index - 1]),
  }));

  function cycleAdapter() {
    if (adapterOptions.length === 0) {
      return;
    }
    const enabledOptions = adapterOptions.filter((option) => !option.disabled);
    const currentIndex = enabledOptions.findIndex((option) => option.value === adapter);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % enabledOptions.length;
    const nextAdapter = enabledOptions[nextIndex]?.value;
    if (nextAdapter && nextAdapter !== adapter) {
      sessionDraftTouchedRef.current = true;
      setAdapter(nextAdapter);
    }
    window.requestAnimationFrame(() => promptRef.current?.focus());
  }

  function cycleModel() {
    sessionDraftTouchedRef.current = true;
    setModelChoice(nextModelPreset(adapter, selectedModel));
    window.requestAnimationFrame(() => promptRef.current?.focus());
  }

  return (
    <form
      className="command-launcher new-research-launcher"
      aria-label="New research"
      onKeyDown={(event) => {
        const tabAction = launcherTabAction(event, true);
        if (tabAction) {
          event.preventDefault();
          event.stopPropagation();
          if (tabAction === "cycle-provider") {
            cycleAdapter();
          } else if (tabAction === "cycle-model") {
            cycleModel();
          }
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
          className="command-launcher-input"
          rows={2}
          value={prompt}
          placeholder="What would you like to investigate?"
          onChange={(event) => {
            sessionDraftTouchedRef.current = true;
            setPrompt(event.currentTarget.value);
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
            <div className="command-launcher-options new-research-model-controls">
              <LauncherSelect
                value={selectedModel}
                options={modelPresets.map((preset) => ({
                  value: preset,
                  label: formatLauncherModelLabel(adapter, preset),
                }))}
                ariaLabel="Model"
                onChange={(choice) => {
                  sessionDraftTouchedRef.current = true;
                  setModelChoice(choice);
                }}
                submenu={
                  effortOptions
                    ? {
                        label: "Effort",
                        ariaLabel: "Reasoning effort",
                        value: selectedEffort,
                        options: effortOptions,
                        onChange: setEffortChoice,
                      }
                    : undefined
                }
              />
              {selectedModel === CUSTOM_MODEL ? (
                <input
                  type="text"
                  value={customModel}
                  placeholder="Model name"
                  aria-label="Custom model"
                  onChange={(event) => {
                    sessionDraftTouchedRef.current = true;
                    setCustomModel(event.currentTarget.value);
                  }}
                />
              ) : null}
            </div>
          </div>
          <div className="command-launcher-controls">
            <div className="command-launcher-adapter-select">
              <LauncherSelect
                value={adapter}
                options={adapterOptions}
                ariaLabel="Agent"
                onChange={(nextAdapter) => {
                  sessionDraftTouchedRef.current = true;
                  setError(null);
                  setAdapter(nextAdapter);
                }}
              />
            </div>
            <button
              type="submit"
              className="control-button command-launcher-send new-research-send"
              disabled={!prompt.trim() || !adapter || !adapterReady || submitting}
              aria-label={submitting ? "Starting research" : "Start research"}
              title={submitting ? "Starting research" : "Start research"}
            >
              <ComposerSubmitShortcutGlyph
                requireCmdEnter={requireCmdEnterToSend}
                ariaHidden
              />
            </button>
          </div>
        </div>
      </div>
      {!adapters.some(adapterCanLaunchResearch) || error ? (
        <div className="new-research-footer">
          {!adapters.some(adapterCanLaunchResearch) ? (
            <p className="new-research-unavailable" role="alert">
              {selectedAdapter
                ? adapterReadinessMessage(selectedAdapter)
                : "No supported research agent is available."}
            </p>
          ) : null}
          {error ? (
            <p className="new-research-error" role="alert">
              {error}
            </p>
          ) : null}
          {!adapters.some(adapterCanLaunchResearch) ? (
            <button
              type="button"
              className="control-button new-research-setup-button"
              onClick={onOpenAgentSettings}
            >
              Review agents
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
