// Pure helpers for rendering exported-conversation research nodes. An export
// collapses tool activity into marker turns (a Raw block whose value is
// `{ type: "qmuxToolActivity", toolCalls: N }`, written by
// src-tauri/src/research.rs); buildTimelineItems routes assistant Raw blocks
// into thinking activities, so the viewer needs to recognize those markers
// inside activity items and render them as quiet "N tool calls" chips instead
// of thinking disclosures.

import type { ActivityItem } from "./turnTimeline";

/** Mirror of research.rs CONVERSATION_TOOL_ACTIVITY_TYPE. */
export const CONVERSATION_TOOL_ACTIVITY_TYPE = "qmuxToolActivity";

/** The collapsed tool-call count carried by one marker value, or null when
 * the value is not an export activity marker. A marker with a malformed
 * count still identifies as a marker (count 0) so it renders as a chip
 * rather than leaking raw JSON into the document. */
export function conversationToolCallCount(value: unknown): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as { type?: unknown; toolCalls?: unknown };
  if (record.type !== CONVERSATION_TOOL_ACTIVITY_TYPE) {
    return null;
  }
  return typeof record.toolCalls === "number" &&
    Number.isFinite(record.toolCalls) &&
    record.toolCalls > 0
    ? Math.floor(record.toolCalls)
    : 0;
}

/** Total collapsed tool calls carried by a timeline activity when every leaf
 * value is an export activity marker; null when anything else is present, so
 * the caller falls back to ordinary activity rendering. */
export function conversationActivityToolCalls(activity: ActivityItem): number | null {
  const leaves = activity.type === "activityGroup" ? activity.children : [activity];
  let total = 0;
  for (const leaf of leaves) {
    if (leaf.type !== "thinking") {
      return null;
    }
    for (const value of leaf.values) {
      const count = conversationToolCallCount(value);
      if (count === null) {
        return null;
      }
      total += count;
    }
  }
  return total;
}

export function conversationToolCallLabel(count: number) {
  if (count === 0) {
    // A marker whose count did not survive (malformed archive data) still
    // records that activity happened.
    return "tool activity";
  }
  return count === 1 ? "1 tool call" : `${count} tool calls`;
}
