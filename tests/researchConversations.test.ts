import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_TOOL_ACTIVITY_TYPE,
  conversationActivityToolCalls,
  conversationToolCallCount,
  conversationToolCallLabel,
} from "../src/lib/researchConversations";
import { buildTimelineItems } from "../src/lib/turnTimeline";
import type { Turn, TurnBlock } from "../src/types";

function turn(id: string, role: string, blocks: TurnBlock[]): Turn {
  return {
    id,
    agentId: "node-1",
    role,
    blocks,
    sourceIndex: Number(id.split("-").pop() ?? 0),
  };
}

function marker(toolCalls: number): TurnBlock {
  return { type: "raw", value: { type: CONVERSATION_TOOL_ACTIVITY_TYPE, toolCalls } };
}

test("marker values identify and count; foreign values do not", () => {
  assert.equal(conversationToolCallCount({ type: CONVERSATION_TOOL_ACTIVITY_TYPE, toolCalls: 3 }), 3);
  // A malformed count still identifies as a marker so raw JSON never renders.
  assert.equal(
    conversationToolCallCount({ type: CONVERSATION_TOOL_ACTIVITY_TYPE, toolCalls: "3" }),
    0,
  );
  assert.equal(conversationToolCallCount({ type: "thinking", text: "hidden" }), null);
  assert.equal(conversationToolCallCount(null), null);
  assert.equal(conversationToolCallCount("qmuxToolActivity"), null);
});

test("labels pluralize", () => {
  assert.equal(conversationToolCallLabel(1), "1 tool call");
  assert.equal(conversationToolCallLabel(4), "4 tool calls");
});

test("exported marker turns surface as countable activities on the timeline", () => {
  // Snapshot shape produced by the backend export: text turns with marker
  // turns between them. buildTimelineItems routes assistant raw blocks into
  // thinking activities; the conversation renderer must recognize those as
  // collapsed tool activity.
  const items = buildTimelineItems([
    turn("node-1-0", "user", [{ type: "text", text: "Question" }]),
    turn("node-1-1", "assistant", [{ type: "text", text: "Let me check." }]),
    turn("node-1-2", "assistant", [marker(2)]),
    turn("node-1-3", "user", [{ type: "text", text: "Follow-up" }]),
    turn("node-1-4", "assistant", [{ type: "text", text: "Answer" }]),
  ]);
  const activities = items.flatMap((item) => item.activities);
  assert.equal(activities.length, 1);
  assert.equal(conversationActivityToolCalls(activities[0]), 2);
  // Every text turn survives as a message item in order.
  assert.deepEqual(
    items.filter((item) => item.blocks.length > 0).map((item) => item.role),
    ["user", "assistant", "user", "assistant"],
  );
});

test("non-marker thinking falls back to ordinary activity rendering", () => {
  const items = buildTimelineItems([
    turn("node-1-0", "assistant", [
      { type: "raw", value: { type: "thinking", text: "reasoning" } },
    ]),
  ]);
  const activities = items.flatMap((item) => item.activities);
  assert.equal(activities.length, 1);
  assert.equal(conversationActivityToolCalls(activities[0]), null);
});

test("mixed marker and non-marker values refuse the chip", () => {
  const items = buildTimelineItems([
    turn("node-1-0", "assistant", [
      marker(1),
      { type: "raw", value: { type: "thinking", text: "reasoning" } },
    ]),
  ]);
  const activities = items.flatMap((item) => item.activities);
  assert.equal(activities.length, 1);
  assert.equal(conversationActivityToolCalls(activities[0]), null);
});
