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
import { agentCanFork, agentStatusLabel } from "../lib/appHelpers";
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

function targetStatus(target: LauncherTarget): string {
  const tabKind = target.pane.kind === "shell" ? "Shell tab" : "Agent tab";
  const status = agentStatusLabel(target.agent.status);
  const queue = target.queue.length > 0 ? ` · ${target.queue.length} queued` : "";
  const shell = target.shellJob
    ? ` · shell ${target.shellJob.state === "foreground" ? "foreground" : target.shellJob.state}`
    : "";
  return `${tabKind} · ${status}${queue}${shell}`;
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
      <section className="global-task-launcher-surface" aria-label="Quick launch task">
        <div className="global-task-launcher-target-row">
          <label htmlFor="global-task-launcher-target">Send task to</label>
          <select
            id="global-task-launcher-target"
            value={selectedAgentId}
            disabled={loading || targets.length === 0}
            onChange={(event) => {
              setSelectedAgentId(event.currentTarget.value);
              setQueueMenuOpen(false);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
          >
            {targets.length === 0 ? <option value="">No live agent tabs</option> : null}
            {targets.map((target) => (
              <option key={target.agent.id} value={target.agent.id}>
                {`${target.group?.name ? `${target.group.name} › ` : ""}${targetTitle(target)} — ${targetStatus(target)}`}
              </option>
            ))}
          </select>
        </div>

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
              {canSend && hasValue ? (
                <button
                  type="button"
                  className="control-button"
                  disabled={submitting}
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
              {canSteer ? (
                <button
                  type="button"
                  className="control-button"
                  disabled={submitting || !hasValue}
                  onClick={() => submit("steer")}
                  title="Send now, interrupting the agent's current work"
                >
                  Send Now
                </button>
              ) : null}
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
                <div className="global-task-launcher-queue-group">
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
