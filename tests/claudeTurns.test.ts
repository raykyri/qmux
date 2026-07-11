import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaudeTurns } from "../src/adapters/claudeTurns";
import type { Turn } from "../src/types";

function turn(id: string, role: string, text: string): Turn {
  return {
    id,
    agentId: "agent-1",
    role,
    blocks: [{ type: "text", text }],
    sourceIndex: Number(id.replace(/\D/g, "")) || 0,
  };
}

test("hides Claude queue bookkeeping before and after prompt submission", () => {
  const queued = turn("turn-1", "queue-operation", "steer the current turn");
  const assistant = turn("turn-2", "assistant", "current response");
  const submitted = turn("turn-3", "user", "steer the current turn");

  assert.deepEqual(normalizeClaudeTurns([queued, assistant]), [assistant]);
  assert.deepEqual(normalizeClaudeTurns([queued, assistant, submitted]), [assistant, submitted]);
});

test("preserves repeated real user prompts", () => {
  const first = turn("turn-1", "user", "try again");
  const second = turn("turn-2", "user", "try again");

  assert.deepEqual(normalizeClaudeTurns([first, second]), [first, second]);
});
