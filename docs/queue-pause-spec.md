# Pauses after queued turns

Let a queued turn carry a "pause after send" flag. When such a turn is sent and its
agent turn finishes, the queue enters **paused** mode instead of draining the next
item. The user resumes with an Unpause control.

## Adjustments to the original instructions

- "send the **last** queued item now" on unpause is read as "send the **next** (front)
  queued item" — i.e. resume normal draining from the front. ("last" is taken to mean
  "the still-pending item," not literally the tail.)
- Pause-after is **per queued item** (each item independently toggleable), so a queue
  can pause at several points; each pause-after turn pauses the queue when it finishes.
- "Paused" / "Unpause" show whenever the agent is in paused mode, even if the queue is
  now empty (paused mode also suppresses *future* auto-sends until unpaused). Since a
  paused agent is idle, the (idle-only) Queue button isn't shown anyway; Unpause takes
  the Queue button's slot and "Paused" sits left-aligned in that actions row.
- The per-item "Edit" button stays; only the X (remove) button becomes the ⋮ menu. The
  menu holds "Pause after send" / "Remove pause after send" (top) and "Delete".

## Data model

- Backend queue items become `QueuedTurn { text: String, pause_after: bool }` (was a
  bare `String`). Storage: `agent_turn_queues: HashMap<String, VecDeque<QueuedTurn>>`.
  Persisted `queues` become `Vec<QueuedTurn>`; `QueuedTurn` deserializes from either a
  bare string (old format) or `{ text, pauseAfter }`, so existing state loads.
- `AgentInfo` gains `paused: bool` (serde default false), surfaced to the frontend.
- `Model` gains `agent_pending_pause: HashSet<String>` — transient: a sent pause-after
  turn is "pending" until its turn finishes, at which point it flips `paused`.

## Backend ops (state.rs)

- Queue methods carry `pause_after`: `enqueue`/`prepend`/`insert` create
  `{ text, false }`; `pop_agent_turn` returns the `QueuedTurn` (drain needs its flag);
  `reorder` moves the element (flag travels); `remove` returns the removed `QueuedTurn`.
- `list_agent_turn_queue -> Vec<String>` (texts) stays for drain/expected-match/tests;
  add `agent_queued_turns -> Vec<QueuedTurn>` for events/results/frontend.
- `set_queued_turn_pause(id, index, pause_after, expected_text)` toggles one item.
- Field-scoped setters (no full-struct clobber): `set_agent_paused`, plus the existing
  `set_agent_status`. Pending-pause: `mark_agent_pending_pause`, `take_agent_pending_pause`.

## Draining + pause (turn_queue.rs)

- `drain_agent_turn_queue`: when it pops+sends a turn whose `pause_after` is set, it
  marks pending-pause on the agent.
- `advance_after_idle(state, agent_id)` (shared by both adapters' idle handlers):
  1. clear outstanding sends; 2. if pending-pause is set → take it, set `paused=true`,
  status Done (don't drain); 3. else if already `paused` → status Done (don't drain);
  4. else drain one turn (status Running if sent, else Done). Status/paused are written
  with field-scoped setters so a concurrent SessionStart/hook write isn't clobbered.
- `unpause_agent(state, agent_id)`: clear `paused`; if the agent is in a ready (idle)
  state, drain one turn now; otherwise it resumes on the next idle. Emits so the UI
  updates.

The Claude/Codex adapters' `finish_agent_after_idle`/`finish_agent_after_stop` call
`advance_after_idle` and map its result to the existing `agent.running` / `agent.done`
event (no agent payload → the frontend refetches agents, picking up `paused`).

## Commands / API

- `agent_set_queued_turn_pause`, `agent_unpause`; `list_agent_turn_queue` and the queue
  result/event `queuedTurns` now carry `QueuedTurn[]` (`{ text, pauseAfter }`).

## Frontend

- `QueuedTurn` type; per-agent queues become `QueuedTurn[]`; the parallel
  `collapsedQueuedTurns: boolean[]` is unchanged.
- NativeInput: each item's actions become **Edit** + a **⋮ menu** (narrower than the
  old X) with "Pause after send" / "Remove pause after send" and "Delete". A pause-after
  item shows a centered "Pause after send" caption at its bottom.
- Composer actions row: when `agent.paused`, show a left-aligned "Paused" label and
  replace the Queue button with **Unpause**. Unpause calls `agent_unpause`.
- `useQmuxEvents` parses `queuedTurns` as objects; `agent.unpaused` upserts the agent.

## Notes

- Moving a queued turn to another agent resets its pause-after (a pause is contextual
  to the queue it was set in).
- Pending-pause is runtime-only (not persisted); a restart mid-"pause-after-turn-running"
  forgets the pending pause, which is acceptable.
