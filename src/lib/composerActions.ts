import type { QueuedTurnDelivery } from "../types";

export const FORK_REQUIREMENT_TITLE =
  "Forking requires a supported agent session that has run a turn";

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
