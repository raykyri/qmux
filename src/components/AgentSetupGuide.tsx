import { useId, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import type { AgentAdapterMetadata } from "../types";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "../lib/adapterIcons";
import {
  adapterNeedsUpdate,
  adapterSetupIsComplete,
  adapterStatusChecked,
  agentSetupIntro,
  agentSetupStatusLabel,
  agentSetupSteps,
} from "../lib/agentSetup";
import { openExternalUrl } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { Button } from "./ui";

interface AgentSetupGuideProps {
  adapters: readonly AgentAdapterMetadata[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCopied: (message: string) => void;
  onError: (message: string) => void;
}

function CommandLine({
  command,
  onCopied,
  onError,
}: {
  command: string;
  onCopied: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-setup-command">
      <code>{command}</code>
      <Button
        variant="unstyled"
        className="agent-setup-copy"
        aria-label="Copy command"
        title="Copy command"
        onClick={() => {
          void writeClipboardText(command)
            .then(() => {
              onCopied("Command copied");
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
            .catch((err) => {
              onError(err instanceof Error ? err.message : String(err));
            });
        }}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </Button>
    </div>
  );
}

/** One agent at a time, with ordered install / sign-in / refresh steps. Shown
 * in the Agents dialog and under an empty Home feed. The tablist is hand-built
 * because qmux has no shared tabs primitive; every other control here is a
 * shared ui/Button. */
export default function AgentSetupGuide({
  adapters,
  loading,
  error,
  onRefresh,
  onCopied,
  onError,
}: AgentSetupGuideProps) {
  const tabsId = useId();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const intro = agentSetupIntro(adapters);
  const selected =
    adapters.find((adapter) => adapter.instanceId === selectedInstanceId) ??
    adapters.find((adapter) => !adapterSetupIsComplete(adapter)) ??
    adapters[0] ??
    null;

  function selectNextAgent() {
    if (!selected || adapters.length < 2) {
      return;
    }
    const index = adapters.findIndex((adapter) => adapter.instanceId === selected.instanceId);
    setSelectedInstanceId(adapters[(index + 1) % adapters.length].instanceId);
  }

  const steps = selected ? agentSetupSteps(selected) : [];
  const activeIndex = steps.findIndex((step) => !step.done);
  const selectedIndex = selected
    ? adapters.findIndex((adapter) => adapter.instanceId === selected.instanceId)
    : -1;
  const panelId = `${tabsId}-panel`;

  /** Roving tablist: only the selected tab is tabbable, and the arrow keys move
   * the selection the way a tablist is expected to. */
  function focusTab(index: number) {
    const adapter = adapters[index];
    if (!adapter) {
      return;
    }
    setSelectedInstanceId(adapter.instanceId);
    document.getElementById(`${tabsId}-tab-${index}`)?.focus();
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const last = adapters.length - 1;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        focusTab(index === last ? 0 : index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        focusTab(index === 0 ? last : index - 1);
        break;
      case "Home":
        focusTab(0);
        break;
      case "End":
        focusTab(last);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div className="agent-setup">
      <div className="agent-setup-head">
        <div className="agent-setup-intro">
          <h3>{intro.heading}</h3>
          <p>{intro.body}</p>
        </div>
      </div>
      {error ? (
        <p className="agent-setup-error" role="alert">
          {error}
        </p>
      ) : null}
      {selected ? (
        <>
          <div className="agent-setup-tabs-row">
            <div className="agent-setup-tabs" role="tablist" aria-label="Agents">
              {adapters.map((adapter, index) => (
                <Button
                  key={adapter.instanceId}
                  id={`${tabsId}-tab-${index}`}
                  variant="unstyled"
                  role="tab"
                  className="agent-setup-tab"
                  aria-selected={adapter.instanceId === selected.instanceId}
                  aria-controls={panelId}
                  tabIndex={adapter.instanceId === selected.instanceId ? 0 : -1}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  onClick={() => setSelectedInstanceId(adapter.instanceId)}
                >
                  <span
                    className={`agent-setup-dot${adapterSetupIsComplete(adapter) ? " is-ready" : ""}`}
                    aria-hidden="true"
                  />
                  {adapter.label}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              className="agent-setup-refresh"
              disabled={loading}
              aria-label={loading ? "Checking all agent statuses" : "Refresh all agent statuses"}
              title={loading ? "Checking all agent statuses" : "Refresh all agent statuses"}
              onClick={onRefresh}
            >
              <RefreshCw
                size={13}
                className={loading ? "is-spinning" : undefined}
                aria-hidden="true"
              />
            </Button>
          </div>
          <div
            id={panelId}
            className="agent-setup-panel"
            role="tabpanel"
            aria-labelledby={`${tabsId}-tab-${selectedIndex}`}
          >
            <div className="agent-setup-panel-head">
              <img
                src={ADAPTER_ICON_BY_ID[selected.id]}
                className={`agent-setup-icon ${adapterIconClassName(selected.id) ?? ""}`}
                alt=""
                aria-hidden="true"
              />
              <h4>{selected.label}</h4>
              <span
                className={`agent-setup-status is-${
                  adapterNeedsUpdate(selected)
                    ? "unsupportedVersion"
                    : adapterStatusChecked(selected)
                      ? selected.readiness
                      : "unchecked"
                }`}
              >
                {agentSetupStatusLabel(selected)}
              </span>
            </div>
            <ol className="agent-setup-steps">
              {steps.map((step, index) => {
                const state = step.done ? "is-done" : index === activeIndex ? "is-active" : "";
                return (
                  <li key={step.title} className={`agent-setup-step ${state}`}>
                    <span className="agent-setup-step-number" aria-hidden="true">
                      {step.done ? <Check size={12} /> : index + 1}
                    </span>
                    <div className="agent-setup-step-body">
                      <span className="agent-setup-step-title">{step.title}</span>
                      {step.command && index === activeIndex ? (
                        <CommandLine command={step.command} onCopied={onCopied} onError={onError} />
                      ) : null}
                      {step.hint && index === activeIndex ? (
                        <span className="agent-setup-hint">{step.hint}</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="agent-setup-foot">
              {selected.installUrl ? (
                <Button
                  size="sm"
                  onClick={() => {
                    void openExternalUrl(selected.installUrl ?? "").catch((err) => {
                      onError(err instanceof Error ? err.message : String(err));
                    });
                  }}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  <span>Setup guide</span>
                </Button>
              ) : (
                <span />
              )}
              <div className="agent-setup-foot-actions">
                {adapters.length > 1 ? (
                  <Button size="sm" onClick={selectNextAgent}>
                    Next agent
                  </Button>
                ) : null}
                <Button
                  tone="primary"
                  size="sm"
                  className="agent-setup-refresh-current"
                  disabled={loading}
                  aria-label={loading ? "Checking agent status" : "Refresh agent status"}
                  title={loading ? "Checking agent status" : "Refresh agent status"}
                  onClick={onRefresh}
                >
                  <RefreshCw
                    size={13}
                    className={loading ? "is-spinning" : undefined}
                    aria-hidden="true"
                  />
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="agent-setup-hint">No agent CLIs are configured.</p>
      )}
    </div>
  );
}
