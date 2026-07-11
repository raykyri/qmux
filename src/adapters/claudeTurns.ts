import type { Turn } from "../types";

// Claude writes native queue bookkeeping into the session JSONL. Those records
// describe composer state, not conversation turns; the eventual submitted prompt
// is recorded separately as a normal user turn.
export function normalizeClaudeTurns(turns: Turn[]): Turn[] {
  return turns.filter((turn) => turn.role !== "queue-operation");
}
