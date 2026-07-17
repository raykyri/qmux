import type { AgentStatus, ComposerPolicy } from "../adapters";
import type { QueuedTurnDelivery, WaitTarget } from "../types";
import { agentStatusTone } from "./appHelpers";
import type { ParsedComposerSlashCommand } from "./composerSlashCommands";

export const FORK_REQUIREMENT_TITLE =
  "Forking requires a supported agent session that has run a turn";

/** Capability gating shared by the right-pane composer and the global task
 * launcher, derived in one place so both surfaces enable Send/Send Now/Queue
 * and route the submit shortcut identically. */
export interface ComposerGating {
  canSend: boolean;
  canSteer: boolean;
  canAppendQueue: boolean;
  submitShortcutWouldTargetSend: boolean;
  submitShortcutWouldTargetQueue: boolean;
}

export function deriveComposerGating(
  policy: ComposerPolicy | null,
  status: AgentStatus | null,
  queueLength: number,
  submitting: boolean,
): ComposerGating {
  const canSend = Boolean(policy && status && policy.readyStatuses.includes(status));
  const canQueue = Boolean(policy && status && policy.queueStatuses.includes(status));
  const canSteer = Boolean(policy && status && policy.steerStatuses.includes(status));
  const hasQueue = queueLength > 0;
  const canAppendQueue = Boolean(status && status !== "failed" && (canQueue || hasQueue));
  // Where the submit shortcut lands: send to a ready agent with an empty
  // queue, queue behind everything else.
  const submitShortcutWouldTargetSend = !submitting && canSend && !hasQueue;
  const submitShortcutWouldTargetQueue =
    !submitShortcutWouldTargetSend && !submitting && canAppendQueue;
  return {
    canSend,
    canSteer,
    canAppendQueue,
    submitShortcutWouldTargetSend,
    submitShortcutWouldTargetQueue,
  };
}

/** How a composer submission dispatches given its parsed slash command, shared
 * so /fork and /worktree behave identically in the composer and the launcher. */
export type ComposerSubmissionPlan =
  | { kind: "reject"; message: string }
  | { kind: "fork"; useWorktree: boolean; prompt: string }
  | { kind: "turn" };

export function planComposerSubmission(
  parsed: ParsedComposerSlashCommand,
  canFork: boolean,
): ComposerSubmissionPlan {
  if (parsed.kind === "incomplete") {
    return { kind: "reject", message: `Add a message after ${parsed.command.token}` };
  }
  if (parsed.kind === "ready") {
    if (!canFork) {
      return { kind: "reject", message: FORK_REQUIREMENT_TITLE };
    }
    return { kind: "fork", useWorktree: parsed.command.useWorktree, prompt: parsed.prompt };
  }
  return { kind: "turn" };
}

/** Status text for a queue-after wait target, shared by the right-pane
 * composer's queue dropdown and the global task launcher's. */
export function waitTargetStatusLabel(target: WaitTarget) {
  const queueCount = target.queueCount ?? 0;
  if ((target.status === "done" || target.status === "idle") && queueCount > 0) {
    return target.queueBlocked ? "Waiting" : `${queueCount} queued`;
  }
  switch (target.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "awaitingInput":
      return "Awaiting input";
    case "awaitingPermission":
      return "Awaiting decision";
    default:
      return target.status;
  }
}

export function waitTargetStatusDotClass(target: WaitTarget) {
  const statusTone = agentStatusTone(target.status);
  const statusClass = target.status === "awaitingInput" ? " status-awaiting-input" : "";
  const waitingClass = target.queueBlocked ? " is-waiting-on-pane" : "";
  return `pane-tab-dot wait-target-status-dot status-${statusTone}${statusClass}${waitingClass}`;
}

/** Delivery choices shared by the right-pane composer and global launcher. */
export const QUEUE_DELIVERY_OPTIONS: ReadonlyArray<{
  label: string;
  title: string;
  needsFork: boolean;
  delivery: QueuedTurnDelivery;
}> = [
  {
    label: "Queue and fork",
    title: "When reached, fork this session and send the message to the fork",
    needsFork: true,
    delivery: { kind: "fork" },
  },
  {
    label: "Queue and fork in worktree",
    title:
      "When reached, fork this session into a fresh git worktree and send the message to the fork",
    needsFork: true,
    delivery: { kind: "fork", useWorktree: true },
  },
  {
    label: "Queue in new session",
    title: "When reached, start a fresh session in the same directory with this message",
    needsFork: false,
    delivery: { kind: "newSession" },
  },
];
