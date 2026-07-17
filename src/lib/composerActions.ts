import type { QueuedTurnDelivery, WaitTarget } from "../types";
import { agentStatusTone } from "./appHelpers";

export const FORK_REQUIREMENT_TITLE =
  "Forking requires a supported agent session that has run a turn";

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
