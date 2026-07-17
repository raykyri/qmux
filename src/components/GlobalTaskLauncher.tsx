import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getAgentUiAdapter } from "../adapters";
import {
  dismissGlobalTaskLauncher,
  forkAgent,
  listAgentTurnQueue,
  listAgents,
  listGroups,
  listPanes,
  listShellAgentJobs,
  listenToEvents,
  queueDeliveryAgentTurn,
  queueWaitAgentTurn,
  submitAgentTurn,
  submitPaneInput,
  unpauseAgent,
} from "../lib/api";
import { agentCanFork, agentStatusLabel, agentStatusTone } from "../lib/appHelpers";
import {
  FORK_REQUIREMENT_TITLE,
  QUEUE_DELIVERY_OPTIONS,
  deriveComposerGating,
  planComposerSubmission,
  waitTargetStatusDotClass,
  waitTargetStatusLabel,
} from "../lib/composerActions";
import { parseComposerSlashCommand } from "../lib/composerSlashCommands";
import { bodyFontStackFor, loadSettings } from "../lib/settings";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "./ComposerSubmitShortcut";
import type {
  AgentInfo,
  GroupInfo,
  PaneInfo,
  QueuedTurn,
  ShellAgentJobInfo,
  SubmitAgentTurnMode,
  WaitTarget,
} from "../types";

interface LauncherTarget {
  agent: AgentInfo;
  pane: PaneInfo;
  group: GroupInfo | undefined;
  shellJob: ShellAgentJobInfo | undefined;
  queue: QueuedTurn[];
}

function targetTitle(target: LauncherTarget): string {
  return target.pane.lastOscTitle?.trim() || target.pane.title;
}

function targetWaitsOnOtherPane(target: LauncherTarget): boolean {
  const firstQueued = target.queue[0];
  return Boolean(firstQueued?.waitFor && firstQueued.waitFor.agentId !== target.agent.id);
}

/** Status pill text for a target row, following the sidebar tab rule: queue
 * count while working or idle, otherwise the status label — with "Running"
 * left to the pulsing dot alone. */
function targetStatusPill(target: LauncherTarget): string | null {
  const queued = target.queue.length;
  if ((target.agent.status === "running" || target.agent.status === "idle") && queued > 0) {
    return `${queued} ${targetWaitsOnOtherPane(target) ? "waiting" : "queued"}`;
  }
  const label = agentStatusLabel(target.agent.status);
  return label === "Running" ? null : label;
}

function targetStatusDotClass(target: LauncherTarget): string {
  const awaitingInput =
    target.agent.status === "awaitingInput" ? " status-awaiting-input" : "";
  const waiting = targetWaitsOnOtherPane(target) ? " is-waiting-on-pane" : "";
  return `pane-tab-dot status-${agentStatusTone(target.agent.status)}${awaitingInput}${waiting}`;
}

/** Hover summary for a target row: the detail the old dropdown label spelled
 * out (tab kind, status, queue depth, shell job) now lives in the tooltip. */
function targetDetails(target: LauncherTarget): string {
  const kind = target.pane.kind === "shell" ? "Shell tab" : "Agent tab";
  const queued = target.queue.length > 0 ? `${target.queue.length} queued` : null;
  const shell = target.shellJob ? `shell ${target.shellJob.state}` : null;
  return [targetTitle(target), kind, agentStatusLabel(target.agent.status), queued, shell]
    .filter(Boolean)
    .join(" · ");
}

function targetOptionDomId(agentId: string): string {
  return `global-task-launcher-option-${agentId}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function GlobalTaskLauncher() {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  // The launcher window is created hidden and kept alive for the whole app
  // lifetime, so without this gate its webview would refetch panes, agents,
  // groups, shell jobs, and every agent's turn queue on every backend event —
  // ~12×/second under a busy agent — while never on screen. Only the visible
  // window needs live data; focus/blur drive this flag.
  const visibleRef = useRef(false);
  const [targets, setTargets] = useState<LauncherTarget[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [value, setValue] = useState("");
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Mirror the composer's submit shortcut ("Require ⌘↵ to send"). Settings live
  // in localStorage, which this window shares with the main one; re-read on
  // each focus so a change made in Settings applies to the next launch.
  const [requireCmdEnterToSend, setRequireCmdEnterToSend] = useState(
    () => loadSettings().requireCmdEnterToSend,
  );

  useLayoutEffect(() => {
    const settings = loadSettings();
    const root = document.documentElement;
    root.dataset.colorTheme = settings.colorTheme;
    root.style.setProperty("--font-ui", bodyFontStackFor(settings.bodyFontId));
    return () => {
      delete root.dataset.colorTheme;
      root.style.removeProperty("--font-ui");
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [panes, agents, groups, shellJobs] = await Promise.all([
        listPanes(),
        listAgents(),
        listGroups(),
        listShellAgentJobs().catch((): ShellAgentJobInfo[] => []),
      ]);
      const paneById = new Map(panes.map((pane) => [pane.id, pane]));
      const groupById = new Map(groups.map((group) => [group.id, group]));
      const shellJobByAgent = new Map(shellJobs.map((job) => [job.agentId, job]));
      const live = agents.filter(
        (agent) =>
          agent.paneId &&
          agent.status !== "failed" &&
          paneById.has(agent.paneId) &&
          paneById.get(agent.paneId)?.status !== "exited" &&
          paneById.get(agent.paneId)?.status !== "killed",
      );
      const queues = await Promise.all(
        live.map((agent) => listAgentTurnQueue(agent.id).catch((): QueuedTurn[] => [])),
      );
      const next = live
        .map((agent, index): LauncherTarget => {
          const pane = paneById.get(agent.paneId as string) as PaneInfo;
          return {
            agent,
            pane,
            group: groupById.get(pane.groupId),
            shellJob: shellJobByAgent.get(agent.id),
            queue: queues[index],
          };
        })
        .sort((left, right) => {
          const paneOrder = panes.indexOf(left.pane) - panes.indexOf(right.pane);
          return paneOrder || left.agent.createdAt - right.agent.createdAt;
        });
      setTargets(next);
      setSelectedAgentId((current) =>
        next.some((target) => target.agent.id === current) ? current : (next[0]?.agent.id ?? ""),
      );
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const launcherWindow = getCurrentWindow();
    let disposed = false;
    let unlistenFocus: (() => void) | undefined;
    let unlistenEvents: (() => void) | undefined;

    void launcherWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        visibleRef.current = true;
        setRequireCmdEnterToSend(loadSettings().requireCmdEnterToSend);
        // Focus immediately: the textarea stays enabled through the refresh so
        // the first keystrokes after the hotkey land in the draft.
        requestAnimationFrame(() => textareaRef.current?.focus());
        void refresh();
      } else {
        visibleRef.current = false;
        if (refreshTimerRef.current !== null) {
          window.clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        setQueueMenuOpen(false);
        void launcherWindow.hide();
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenFocus = unlisten;
    });
    void listenToEvents(() => {
      // Skip the refetch while hidden; the focus handler refreshes on show.
      if (!visibleRef.current) return;
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => void refresh(), 80);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenEvents = unlisten;
    });
    // One-time pre-warm so the first show renders instantly; ongoing refreshes
    // are gated on visibility above.
    void refresh();
    return () => {
      disposed = true;
      unlistenFocus?.();
      unlistenEvents?.();
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    };
  }, [refresh]);

  const selected = targets.find((target) => target.agent.id === selectedAgentId) ?? null;
  const policy = selected
    ? getAgentUiAdapter(selected.agent.adapter).composerPolicy(selected.agent)
    : null;
  const {
    canSend,
    canSteer,
    canAppendQueue,
    submitShortcutWouldTargetSend,
    submitShortcutWouldTargetQueue,
  } = deriveComposerGating(
    policy,
    selected?.agent.status ?? null,
    selected?.queue.length ?? 0,
    submitting,
  );
  const canFork = agentCanFork(selected?.agent);
  const hasValue = value.trim().length > 0;
  const parsedSlashCommand = useMemo(() => parseComposerSlashCommand(value), [value]);
  const permissionActions =
    selected?.agent.status === "awaitingPermission" ? (policy?.permissionActions ?? []) : [];

  // Targets bucketed into contiguous runs per group (the sorted list keeps a
  // group's panes together), so the column can label groups like the sidebar.
  const targetGroups = useMemo(() => {
    const buckets: { key: string; name: string | null; targets: LauncherTarget[] }[] = [];
    const bucketByKey = new Map<string, (typeof buckets)[number]>();
    for (const target of targets) {
      const key = target.group?.id ?? "";
      let bucket = bucketByKey.get(key);
      if (!bucket) {
        bucket = { key, name: target.group?.name?.trim() || null, targets: [] };
        bucketByKey.set(key, bucket);
        buckets.push(bucket);
      }
      bucket.targets.push(target);
    }
    return buckets;
  }, [targets]);

  const waitTargets = useMemo<WaitTarget[]>(
    () =>
      targets.flatMap((target) => {
        if (!selected || target.agent.id === selected.agent.id) return [];
        const active =
          ["starting", "running", "awaitingInput", "awaitingPermission"].includes(
            target.agent.status,
          ) || target.queue.length > 0;
        if (!active) return [];
        return [
          {
            agentId: target.agent.id,
            paneId: target.pane.id,
            label: targetTitle(target),
            status: target.agent.status,
            queueCount: target.queue.length,
            queueBlocked: Boolean(target.queue[0]?.waitFor),
          },
        ];
      }),
    [selected, targets],
  );

  function selectTarget(agentId: string, focus: "textarea" | "option") {
    setSelectedAgentId(agentId);
    setQueueMenuOpen(false);
    requestAnimationFrame(() => {
      if (focus === "textarea") textareaRef.current?.focus();
      else document.getElementById(targetOptionDomId(agentId))?.focus();
    });
  }

  async function finishSubmission(operation: () => Promise<unknown>, allowEmpty = false) {
    if (!selected || submitting || (!allowEmpty && !hasValue)) return;
    setSubmitting(true);
    setError(null);
    try {
      await operation();
      setValue("");
      setQueueMenuOpen(false);
      // Explicit dismissal: hand focus back to the app the launcher was
      // summoned from rather than leaving qmux activated.
      await dismissGlobalTaskLauncher();
    } catch (cause) {
      setError(errorMessage(cause));
      requestAnimationFrame(() => textareaRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  }

  function submit(mode: SubmitAgentTurnMode) {
    if (!selected) return;
    const plan = planComposerSubmission(parsedSlashCommand, canFork);
    if (plan.kind === "reject") {
      setError(plan.message);
      return;
    }
    if (plan.kind === "fork") {
      void finishSubmission(() =>
        forkAgent(selected.pane.id, {
          nest: true,
          useWorktree: plan.useWorktree,
          prompt: plan.prompt,
        }),
      );
      return;
    }
    void finishSubmission(() => submitAgentTurn(selected.agent.id, value.trim(), mode));
  }

  function submitDefault() {
    if (submitShortcutWouldTargetSend) submit("send");
    else if (submitShortcutWouldTargetQueue) submit("queue");
  }

  return (
    <main
      className="global-task-launcher"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void dismissGlobalTaskLauncher();
        }
      }}
    >
      <aside className="global-task-launcher-targets">
        <div
          className="global-task-launcher-targets-header"
          id="global-task-launcher-targets-label"
        >
          Send task to
        </div>
        <div
          className="global-task-launcher-target-list"
          role="listbox"
          aria-labelledby="global-task-launcher-targets-label"
          onKeyDown={(event) => {
            if (
              targets.length === 0 ||
              !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            ) {
              return;
            }
            event.preventDefault();
            const index = targets.findIndex((target) => target.agent.id === selectedAgentId);
            const next =
              event.key === "ArrowDown"
                ? Math.min(index + 1, targets.length - 1)
                : event.key === "ArrowUp"
                  ? Math.max(index - 1, 0)
                  : event.key === "Home"
                    ? 0
                    : targets.length - 1;
            const target = targets[next];
            if (target && target.agent.id !== selectedAgentId) {
              selectTarget(target.agent.id, "option");
            }
          }}
        >
          {targets.length === 0 ? (
            <div className="global-task-launcher-target-empty">
              {loading ? "Loading agent tabs…" : "No live agent tabs"}
            </div>
          ) : null}
          {targetGroups.map((bucket) => (
            <div
              key={bucket.key || "ungrouped"}
              className="global-task-launcher-target-group"
            >
              {bucket.name ? (
                <div className="global-task-launcher-group-label" title={bucket.name}>
                  {bucket.name}
                </div>
              ) : null}
              {bucket.targets.map((target) => {
                const isSelected = target.agent.id === selectedAgentId;
                const pill = targetStatusPill(target);
                return (
                  <div
                    key={target.agent.id}
                    className={`pane-tab-row${isSelected ? " is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      role="option"
                      id={targetOptionDomId(target.agent.id)}
                      aria-selected={isSelected}
                      tabIndex={isSelected ? 0 : -1}
                      className="control-button pane-tab"
                      title={targetDetails(target)}
                      onClick={() => selectTarget(target.agent.id, "textarea")}
                    >
                      <span className={targetStatusDotClass(target)} aria-hidden="true" />
                      <span className="pane-tab-content">
                        <span className="pane-tab-title">{targetTitle(target)}</span>
                        {pill ? <small>{pill}</small> : null}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <section className="global-task-launcher-compose" aria-label="Quick launch task">
        <textarea
          ref={textareaRef}
          value={value}
          disabled={!selected && !loading}
          placeholder={loading ? "Loading agent tabs…" : "Describe a task…"}
          rows={5}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (isComposerSubmitShortcut(event, requireCmdEnterToSend)) {
              event.preventDefault();
              submitDefault();
            }
          }}
        />

        {error ? <div className="global-task-launcher-error" role="alert">{error}</div> : null}

        <div className="global-task-launcher-actions">
          {permissionActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="control-button"
              disabled={submitting || !selected}
              onClick={() => {
                if (!selected) return;
                // Unlike a task submission, answering a permission prompt keeps
                // the window open and the typed draft intact, mirroring the
                // composer.
                setSubmitting(true);
                setError(null);
                void submitPaneInput(selected.pane.id, action.input)
                  .then(() => refresh())
                  .catch((cause) => setError(errorMessage(cause)))
                  .finally(() => setSubmitting(false));
              }}
            >
              {action.label}
            </button>
          ))}
          {parsedSlashCommand.kind !== "none" ? (
            <button
              type="button"
              className="control-button"
              disabled={submitting || parsedSlashCommand.kind !== "ready" || !canFork}
              title={!canFork ? FORK_REQUIREMENT_TITLE : undefined}
              onClick={() => submit("send")}
            >
              <span>
                {parsedSlashCommand.command.useWorktree
                  ? "Fork in worktree & send"
                  : "Fork & send"}
              </span>
              <ComposerSubmitShortcutGlyph
                requireCmdEnter={requireCmdEnterToSend}
                className="shortcut-hint"
              />
            </button>
          ) : (
            <>
              {canSend ? (
                <button
                  type="button"
                  className="control-button"
                  disabled={submitting || !hasValue}
                  onClick={() => submit("send")}
                >
                  <span>Send</span>
                  {submitShortcutWouldTargetSend ? (
                    <ComposerSubmitShortcutGlyph
                      requireCmdEnter={requireCmdEnterToSend}
                      className="shortcut-hint"
                    />
                  ) : null}
                </button>
              ) : null}
              <button
                type="button"
                className="control-button"
                disabled={submitting || !canSteer || !hasValue}
                onClick={() => submit("steer")}
                title={
                  canSteer
                    ? "Send now, interrupting the agent's current work"
                    : "Send Now is available while the agent is working"
                }
              >
                Send Now
              </button>
              {selected?.agent.paused ? (
                <button
                  type="button"
                  className="control-button queue-button"
                  disabled={submitting}
                  onClick={() => {
                    setSubmitting(true);
                    void unpauseAgent(selected.agent.id)
                      .then(() => refresh())
                      .catch((cause) => setError(errorMessage(cause)))
                      .finally(() => setSubmitting(false));
                  }}
                >
                  Unpause
                </button>
              ) : (
                <div className="global-task-launcher-queue-group queue-button-group">
                  <button
                    type="button"
                    className="control-button queue-button queue-button-main"
                    disabled={submitting || !canAppendQueue || !hasValue}
                    onClick={() => submit("queue")}
                  >
                    <span>Queue</span>
                    {submitShortcutWouldTargetQueue ? (
                      <ComposerSubmitShortcutGlyph
                        requireCmdEnter={requireCmdEnterToSend}
                        className="shortcut-hint"
                      />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="control-button queue-menu-button"
                    aria-label="Queue options"
                    aria-haspopup="menu"
                    aria-expanded={queueMenuOpen}
                    title="Queue this turn to a fork, a new session, or after another terminal"
                    disabled={submitting || !selected || !hasValue}
                    onClick={() => setQueueMenuOpen((open) => !open)}
                  >
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                  {queueMenuOpen ? (
                    <div className="global-task-launcher-queue-menu popover-surface" role="menu">
                      {QUEUE_DELIVERY_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          role="menuitem"
                          className="menu-item composer-menu-item"
                          disabled={option.needsFork && !canFork}
                          title={
                            option.needsFork && !canFork
                              ? FORK_REQUIREMENT_TITLE
                              : option.title
                          }
                          onClick={() => {
                            if (!selected) return;
                            const text = value.trim();
                            void finishSubmission(() =>
                              queueDeliveryAgentTurn(
                                selected.agent.id,
                                text,
                                option.delivery,
                              ),
                            );
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                      {waitTargets.length > 0 ? (
                        <>
                          <div className="composer-menu-divider" role="separator" />
                          <div className="composer-menu-label wait-target-placeholder">
                            Queue after existing session…
                          </div>
                        </>
                      ) : null}
                      {waitTargets.map((target) => (
                        <button
                          key={target.agentId}
                          type="button"
                          role="menuitem"
                          className="menu-item wait-target-item"
                          title={target.label}
                          onClick={() => {
                            if (!selected) return;
                            const text = value.trim();
                            void finishSubmission(() =>
                              queueWaitAgentTurn(
                                selected.agent.id,
                                text,
                                target.agentId,
                                target.paneId,
                                target.label,
                              ),
                            );
                          }}
                        >
                          <span
                            className={waitTargetStatusDotClass(target)}
                            aria-hidden="true"
                          />
                          <span className="wait-target-title">{target.label}</span>
                          <span className="wait-target-status">
                            {waitTargetStatusLabel(target)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
