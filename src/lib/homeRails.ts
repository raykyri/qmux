import type { HomeRailPastTurn } from "../components/HomeRails";
import type { Turn } from "../types";
import { firstUserTurnText } from "./appHelpers";
import { stripTaggedUserInstructionBlocks } from "./taggedInstructions";

// Strips prepended/inline tagged instruction blocks (<system-reminder> …) from
// a turn for the compact home rail cards, using the same filter as the right
// pane. Queued turns keep the raw text if stripping empties them (a card
// should never be blank).
export function railQueuedTurnText(text: string): string {
  const stripped = stripTaggedUserInstructionBlocks(text).trim();
  return stripped.length > 0 ? stripped : text;
}

// The latest prompt, for the rail's current card; null when stripping empties
// it so the card falls back to its empty-state text.
export function railLatestUserTurn(turns: Turn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const text = firstUserTurnText(turns[index]);
    if (text) {
      const stripped = stripTaggedUserInstructionBlocks(text).trim();
      return stripped.length > 0 ? stripped : null;
    }
  }
  return null;
}

// When the latest prompt was sent — feeds the current rail card's elapsed time.
export function latestUserTurnTimestamp(turns: Turn[]): number | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (firstUserTurnText(turns[index])) {
      return turns[index].timestamp ?? null;
    }
  }
  return null;
}

// Past prompts for a home rail: every non-superseded user turn before the
// latest one (which renders as the workstream's current card), stripped like
// the cards above; prompts that strip to nothing (pure tagged instructions)
// are dropped rather than shown raw. settledAt is the timestamp of the
// exchange's last record before the next prompt, falling back to the prompt's
// own. Cached by the turns array's identity — agentTurnInfoById hands back the
// same array while an agent's turns are unchanged, so an event batch only
// re-walks agents that actually gained turns.
const railPastTurnsCache = new WeakMap<Turn[], HomeRailPastTurn[]>();

export function railPastTurns(turns: Turn[]): HomeRailPastTurn[] {
  const cached = railPastTurnsCache.get(turns);
  if (cached) {
    return cached;
  }
  const result: HomeRailPastTurn[] = [];
  let pending: HomeRailPastTurn | null = null;
  let exchangeLastTimestamp: number | null = null;
  for (const turn of turns) {
    const text = firstUserTurnText(turn);
    if (text) {
      if (pending) {
        pending.settledAt = exchangeLastTimestamp ?? pending.settledAt;
        result.push(pending);
      }
      const stripped = stripTaggedUserInstructionBlocks(text).trim();
      pending =
        stripped.length > 0
          ? { id: turn.id, text: stripped, settledAt: turn.timestamp ?? null }
          : null;
      exchangeLastTimestamp = null;
    } else if (turn.status !== "superseded" && typeof turn.timestamp === "number") {
      exchangeLastTimestamp = turn.timestamp;
    }
  }
  // The dangling pending prompt is the latest user turn — the current card.
  railPastTurnsCache.set(turns, result);
  return result;
}
