// Pure timeline-item construction for the transcript pane. Extracted from
// TurnOverlay so the fold (merging, tool-call pairing, activity grouping, key
// derivation) is testable without rendering — TurnOverlay's import chain
// reaches ESM-only markdown packages that the node test runner can't load.

import type { ThreadParticipant, Turn, TurnBlock } from "../types";
import { taggedUserInstructionDetails } from "./taggedInstructions";

export type TextBlock = Extract<TurnBlock, { type: "text" }>;
export type ToolUseBlock = Extract<TurnBlock, { type: "toolUse" }>;
export type ToolResultBlock = Extract<TurnBlock, { type: "toolResult" }>;
export type RawBlock = Extract<TurnBlock, { type: "raw" }>;

export type MessageBlock = TextBlock | RawBlock;
export type TurnTimelineStatus = NonNullable<Turn["status"]>;

export interface MessageItem {
  type: "message";
  key: string;
  role: string;
  participant?: ThreadParticipant | null;
  blocks: MessageBlock[];
  activities: ActivityItem[];
  status?: TurnTimelineStatus;
}

export interface ToolEntry {
  type: "tool";
  key: string;
  id?: string | null;
  name: string;
  input?: unknown;
  result?: unknown;
  isError: boolean;
  status?: TurnTimelineStatus;
}

export interface ThinkingItem {
  type: "thinking";
  key: string;
  values: unknown[];
  status?: TurnTimelineStatus;
}

export interface ActivityGroupItem {
  type: "activityGroup";
  key: string;
  children: ActivityLeafItem[];
  toolCallCount: number;
  status?: TurnTimelineStatus;
}

export type ActivityLeafItem = ToolEntry | ThinkingItem;
export type ActivityItem = ActivityLeafItem | ActivityGroupItem;

/** Original assistant text, before Markdown rendering, in timeline order. */
export function assistantTextFromTimelineItems(items: MessageItem[]) {
  return items
    .filter((item) => item.role === "assistant")
    .flatMap((item) =>
      item.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    )
    .join("\n\n")
    .trim();
}

function containsToolActivity(item: ActivityItem) {
  return (
    item.type === "tool" ||
    (item.type === "activityGroup" && item.children.some((child) => child.type === "tool"))
  );
}

/** The user-facing answer begins after the final tool-bearing timeline item. */
export function timelineItemsAfterLastToolCall(items: MessageItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].activities.some(containsToolActivity)) {
      return items.slice(index + 1);
    }
  }
  return items;
}

export function buildTimelineItems(turns: Turn[], showActivityDetail = true): MessageItem[] {
  const items: MessageItem[] = [];
  // Tool calls awaiting a result, in arrival order. A result matches by tool-use
  // id when both sides carry one, otherwise it falls back to the oldest pending
  // call — either way the call and its result collapse into a single row.
  const pending: ToolEntry[] = [];
  // Keys derive from the originating turn id and block position, not a running
  // sequence number: when older turns are truncated (the per-agent cap) or a
  // graph refresh prepends history, sequence-numbered keys shift and React
  // transfers per-item DOM state — expanded <details>, code-wrap toggles — onto
  // unrelated content. Turn ids are stable across re-parses, so these keys
  // stick to their content. Item creation always happens while some block is
  // being processed, and each block creates at most one item per prefix, so
  // keys stay unique.
  let keyBase = "";

  const nextKey = (prefix: string) => `${prefix}-${keyBase}`;

  const createMessageItem = (
    role: string,
    block?: MessageBlock,
    status?: TurnTimelineStatus,
    participant?: ThreadParticipant | null,
  ): MessageItem => ({
    type: "message",
    key: nextKey(`message-${role}`),
    role,
    participant,
    blocks: block ? [block] : [],
    activities: [],
    status,
  });

  const pushMessageBlock = (
    role: string,
    block: MessageBlock,
    status?: TurnTimelineStatus,
    participant?: ThreadParticipant | null,
  ) => {
    const previous = items[items.length - 1];
    if (
      previous?.role === role &&
      previous.status === status &&
      participantKey(previous.participant) === participantKey(participant) &&
      previous.activities.length === 0
    ) {
      previous.blocks.push(block);
      return;
    }
    items.push(createMessageItem(role, block, status, participant));
  };

  const assistantActivityOwner = (
    status?: TurnTimelineStatus,
    participant?: ThreadParticipant | null,
  ) => {
    // Walk back only across assistant items: a user (or system) message is a
    // hard boundary. Without it, a reply that opens with thinking or a tool
    // call (the normal shape of an agent response) attaches those activities
    // to the assistant message from the PREVIOUS exchange, rendering them
    // above the user message that triggered them. Tool-result-only user turns
    // never create items, so they don't block the walk.
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].role !== "assistant") {
        break;
      }
      if (
        items[index].status === status &&
        participantKey(items[index].participant) === participantKey(participant)
      ) {
        return items[index];
      }
    }
    const fallback = createMessageItem("assistant", undefined, status, participant);
    items.push(fallback);
    return fallback;
  };

  const pushThinkingValue = (
    value: unknown,
    status?: TurnTimelineStatus,
    participant?: ThreadParticipant | null,
  ) => {
    const owner = assistantActivityOwner(status, participant);
    const previousActivity = owner.activities[owner.activities.length - 1];
    if (previousActivity?.type === "thinking" && previousActivity.status === status) {
      previousActivity.values.push(value);
      return;
    }
    owner.activities.push({
      type: "thinking",
      key: nextKey("thinking"),
      values: [value],
      status,
    });
  };

  const pushToolEntry = (
    entry: ToolEntry,
    status?: TurnTimelineStatus,
    participant?: ThreadParticipant | null,
  ) => {
    assistantActivityOwner(status, participant).activities.push(entry);
  };

  const registerToolUse = (
    block: ToolUseBlock,
    status?: TurnTimelineStatus,
    participant?: ThreadParticipant | null,
  ) => {
    const entry: ToolEntry = {
      type: "tool",
      key: nextKey("tool"),
      id: block.id ?? null,
      name: block.name,
      input: block.input,
      isError: false,
      status,
    };
    pushToolEntry(entry, status, participant);
    pending.push(entry);
  };

  const attachToolResult = (
    block: ToolResultBlock,
    status?: TurnTimelineStatus,
    participant?: ThreadParticipant | null,
  ) => {
    const toolUseId = block.toolUseId ?? null;

    // Prefer an exact tool-use id match; otherwise fall back to the oldest pending
    // call so mismatched or absent ids still collapse the result into its call.
    let index = toolUseId
      ? pending.findIndex((entry) => entry.id === toolUseId && entry.status === status)
      : -1;
    if (index === -1 && pending.length > 0) {
      index = pending.findIndex((entry) => entry.status === status);
    }

    if (index !== -1) {
      const [entry] = pending.splice(index, 1);
      entry.result = block.content;
      entry.isError = block.isError;
      return;
    }

    // A result with no pending call at all — surface it on its own row.
    pushToolEntry({
      type: "tool",
      key: nextKey("tool-result"),
      id: toolUseId,
      name: block.isError ? "Tool error" : "Tool result",
      result: block.content,
      isError: block.isError,
      status,
    }, status, participant);
  };

  for (const turn of turns) {
    const status = timelineStatus(turn.status);
    const participant = turn.participant ?? null;
    for (const [blockIndex, block] of turn.blocks.entries()) {
      keyBase = `${turn.id}:${blockIndex}`;
      switch (block.type) {
        case "text":
          pushMessageBlock(turn.role, block, status, participant);
          break;
        case "toolUse":
          if (showActivityDetail) {
            registerToolUse(block, status, participant);
          }
          break;
        case "toolResult":
          if (showActivityDetail) {
            attachToolResult(block, status, participant);
          }
          break;
        case "raw":
          if (turn.role === "assistant") {
            if (showActivityDetail) {
              pushThinkingValue(block.value, status, participant);
            }
          } else {
            pushMessageBlock(turn.role, block, status, participant);
          }
          break;
      }
    }
  }

  return items.map((item) => ({
    ...item,
    activities: groupActivityItems(item.activities),
  }));
}

function groupActivityItems(activities: ActivityItem[]): ActivityItem[] {
  if (activities.length <= 1) {
    return activities;
  }

  const children = activities.filter(isActivityLeafItem);
  if (children.length <= 1) {
    return activities;
  }

  return [
    {
      type: "activityGroup",
      key: `activity-group-${children[0].key}`,
      children,
      toolCallCount: countUniqueToolCalls(children),
      status: commonActivityStatus(children),
    },
  ];
}

export function isActivityLeafItem(item: ActivityItem): item is ActivityLeafItem {
  return item.type === "tool" || item.type === "thinking";
}

function countUniqueToolCalls(items: ActivityLeafItem[]) {
  const counted = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool") {
      continue;
    }
    counted.add(item.id ? `id:${item.id}` : `entry:${item.key}`);
  }
  return counted.size;
}

function commonActivityStatus(items: ActivityLeafItem[]): TurnTimelineStatus | undefined {
  const [first] = items;
  if (!first?.status) {
    return undefined;
  }
  return items.every((item) => item.status === first.status) ? first.status : undefined;
}

function timelineStatus(status: Turn["status"]): TurnTimelineStatus | undefined {
  return status === "superseded" || status === "interrupted" || status === "uncertain"
    ? status
    : undefined;
}

// Includes the label: the header renders participant.label when present, so
// two participants that differ only by label must neither merge into one
// message item nor compare equal in the memo below.
export function participantKey(participant: ThreadParticipant | null | undefined) {
  if (!participant) {
    return "";
  }
  return `${participant.kind}:${participant.actorId}:${participant.label ?? ""}`;
}

// Structural equality for rebuilt timeline items. buildTimelineItems re-runs on
// every turns change (every parsed line while an agent streams) and always
// allocates fresh item wrappers, so an identity-based memo would miss for
// every message on every turn event — re-running the markdown render over the
// entire transcript per event. The block/value objects *inside* the wrappers
// keep their identity for unchanged turns (turn reconciliation reuses turn
// objects), so wrappers are compared structurally with reference equality at
// the leaves: an append then re-renders only the items whose content actually
// changed. Keys derive from the originating turn id and block position, so key
// equality is a real content signal (and survives truncation/prepending).
function sameMessageBlockList(a: MessageBlock[], b: MessageBlock[]) {
  return a.length === b.length && a.every((block, index) => block === b[index]);
}

function sameActivityLeaf(a: ActivityLeafItem, b: ActivityLeafItem): boolean {
  if (a.key !== b.key || a.status !== b.status) {
    return false;
  }
  if (a.type === "tool" && b.type === "tool") {
    return (
      a.id === b.id &&
      a.name === b.name &&
      a.input === b.input &&
      a.result === b.result &&
      a.isError === b.isError
    );
  }
  if (a.type === "thinking" && b.type === "thinking") {
    return (
      a.values.length === b.values.length &&
      a.values.every((value, index) => value === b.values[index])
    );
  }
  return false;
}

function sameActivityItem(a: ActivityItem, b: ActivityItem): boolean {
  if (a.type === "activityGroup" || b.type === "activityGroup") {
    return (
      a.type === "activityGroup" &&
      b.type === "activityGroup" &&
      a.key === b.key &&
      a.status === b.status &&
      a.toolCallCount === b.toolCallCount &&
      a.children.length === b.children.length &&
      a.children.every((child, index) => sameActivityLeaf(child, b.children[index]))
    );
  }
  return sameActivityLeaf(a, b);
}

export function sameMessageItem(a: MessageItem, b: MessageItem): boolean {
  return (
    a.key === b.key &&
    a.role === b.role &&
    a.status === b.status &&
    participantKey(a.participant) === participantKey(b.participant) &&
    sameMessageBlockList(a.blocks, b.blocks) &&
    a.activities.length === b.activities.length &&
    a.activities.every((activity, index) => sameActivityItem(activity, b.activities[index]))
  );
}

export function messageItemText(item: MessageItem): string | null {
  const text = item.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  return text.trim() ? text : null;
}

export function messageItemIsTaggedInstruction(item: MessageItem) {
  if (item.role !== "user" || item.blocks.length !== 1) {
    return false;
  }
  const [block] = item.blocks;
  return block.type === "text" && taggedUserInstructionDetails(block.text) !== null;
}

// True when the item carries a tool call (a tool row, or a tool inside a grouped
// activity) — used to spot a continued agent turn whose name should be dropped.
export function hasToolCall(item: MessageItem): boolean {
  return item.activities.some(
    (activity) =>
      activity.type === "tool" ||
      (activity.type === "activityGroup" &&
        activity.children.some((child) => child.type === "tool")),
  );
}
