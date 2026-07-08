import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listAgents, listGroups, listPanes, listenToEvents } from "../lib/api";
import {
  isAgentInfo,
  isQueuedTurn,
  isTurn,
  ptyDataFromPayload,
  transcriptHookEvent,
  upsertAgent,
} from "../lib/appHelpers";
import type { ExitPreflightRequest, PaneContextMenuState } from "../appTypes";
import type { AgentInfo, GroupInfo, PaneInfo, QueuedTurn, TranscriptHookEvent, Turn } from "../types";

// Upper bound on the per-agent hook-event history. This feed accumulates for an
// agent's whole lifetime (it backs the "copy transcript as JSON" export), so
// without a cap a long-running, tool-heavy agent grows the array without limit
// and pays an O(n) copy on every single hook event. Keeping the most recent N
// bounds both memory and the per-event copy; N is generous enough that the copy
// export stays complete for any realistic session.
const MAX_HOOK_EVENTS_PER_AGENT = 2000;

// The backend event stream drives most of the app's live state. This hook owns
// the single global subscription: it is intentionally set up once (empty deps),
// so every callback it touches is passed in and captured at first render,
// matching how the inline effect behaved before it was extracted. State setters
// from useState are stable, and the three helper callbacks read through refs
// internally, so the first-render capture stays correct.
export interface UseQmuxEventsHandlers {
  setHookEventsByAgent: Dispatch<SetStateAction<Record<string, TranscriptHookEvent[]>>>;
  setPanes: Dispatch<SetStateAction<PaneInfo[]>>;
  setActivePaneId: Dispatch<SetStateAction<string | null>>;
  setPaneContextMenu: Dispatch<SetStateAction<PaneContextMenuState | null>>;
  setExitPreflightRequest: Dispatch<SetStateAction<ExitPreflightRequest | null>>;
  setAgents: Dispatch<SetStateAction<AgentInfo[]>>;
  setGroups: Dispatch<SetStateAction<GroupInfo[]>>;
  // Tracks which agents are actively working, for the transcript "Working…"
  // indicator. Only live transitions into a working status flip it on, so an
  // agent restored into a working status never falsely shows it (see below).
  setThinkingAgentIds: Dispatch<SetStateAction<Set<string>>>;
  setTurns: Dispatch<SetStateAction<Turn[]>>;
  setTranscriptNoticeByAgent: Dispatch<SetStateAction<Record<string, string | null>>>;
  setAgentQueuedTurns: (agentId: string, queuedTurns: QueuedTurn[]) => void;
  refreshAgentTurnQueue: (agentId: string) => Promise<void>;
  refreshTranscriptOptions: (agentId: string) => Promise<void>;
  // Routes a decoded PTY chunk to the pane that owns it. Replaces the previous
  // one-listener-per-pane model where every pane filtered the whole pty.data stream.
  dispatchPtyData: (paneId: string, data: Uint8Array) => void;
  // Binds a browser-overlay URL to a pane (the backend emits the fully-formed URL).
  // `sandbox` marks token-bearing file-server URLs so the iframe is sandboxed.
  openBrowserOverlay: (paneId: string, url: string, sandbox?: boolean) => void;
  // Picks the next active pane when a pane closes, honoring split membership and
  // collapsed groups. Supplied by App so the pty.exit path selects consistently with
  // the user-initiated close path (forgetClosedPane).
  selectPaneAfterClose: (panes: PaneInfo[], closedPaneId: string) => string | null;
  // Fired once the single backend subscription is live, so panes can safely flush
  // their pre-attach output backlog (attachPane) without dropping cold-start bytes.
  onEventsReady: () => void;
  onAgentSpawned?: (agent: AgentInfo, paneId: string | null, source: string | null) => void;
  onAgentPromptSubmitted?: (agentId: string, prompt: string) => void;
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : null;
}

function agentPromptSubmittedText(payload: Record<string, unknown>): string | null {
  const hookPayload = payload.payload;
  return stringField(hookPayload, "prompt") ?? stringField(hookPayload, "input");
}

export function useQmuxEvents(handlers: UseQmuxEventsHandlers) {
  const {
    setHookEventsByAgent,
    setPanes,
    setActivePaneId,
    setPaneContextMenu,
    setExitPreflightRequest,
    setAgents,
    setGroups,
    setThinkingAgentIds,
    setTurns,
    setTranscriptNoticeByAgent,
    setAgentQueuedTurns,
    refreshAgentTurnQueue,
    refreshTranscriptOptions,
    dispatchPtyData,
    openBrowserOverlay,
    selectPaneAfterClose: selectPaneAfterCloseWithContext,
    onEventsReady,
    onAgentSpawned,
    onAgentPromptSubmitted,
  } = handlers;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Sequences full agent-list refetches so a slow response can't overwrite a
    // newer snapshot. Only bumped on events that don't already carry the agent.
    let agentRefreshSeq = 0;
    // Same idea for pane-list refetches (a fork adds a pane backend-side).
    let panesRefreshSeq = 0;
    let groupsRefreshSeq = 0;

    void listenToEvents((event) => {
      if (disposed) {
        return;
      }
      // pty.data is by far the highest-frequency event; handle and return early so
      // it never runs the slower per-type matching below.
      if (event.type === "pty.data" && event.paneId) {
        const data = ptyDataFromPayload(event.payload);
        if (data) {
          dispatchPtyData(event.paneId, data);
        }
        return;
      }
      const hookEvent = transcriptHookEvent(event);
      if (hookEvent) {
        setHookEventsByAgent((current) => {
          const existing = current[hookEvent.agentId] ?? [];
          const appended = [...existing, hookEvent];
          // Bound the history so a busy agent can't grow it without limit (and so
          // each append copies at most MAX_HOOK_EVENTS_PER_AGENT elements, not the
          // whole session's worth). Drop the oldest events past the cap.
          const next =
            appended.length > MAX_HOOK_EVENTS_PER_AGENT
              ? appended.slice(appended.length - MAX_HOOK_EVENTS_PER_AGENT)
              : appended;
          return { ...current, [hookEvent.agentId]: next };
        });
      }
      if (event.type === "pty.exit" && event.paneId) {
        const exitedPaneId = event.paneId;
        setPanes((current) => {
          const nextPanes = current.filter((pane) => pane.id !== exitedPaneId);
          setActivePaneId((currentActivePaneId) => {
            if (currentActivePaneId !== exitedPaneId) {
              return currentActivePaneId;
            }
            return selectPaneAfterCloseWithContext(current, exitedPaneId);
          });
          return nextPanes;
        });
        setPaneContextMenu((current) => (current?.paneId === exitedPaneId ? null : current));
      }
      if (event.type === "pane.cwd_changed" && event.paneId) {
        // A shell tab reported a directory change (the user cd'd). The backend has
        // already persisted it for restart recovery; patch the live pane so the tab
        // path and context-menu working dir track the current directory instead of
        // lagging at the spawn-time cwd until the next full pane-list load.
        const cwdPaneId = event.paneId;
        const nextCwd = event.payload.cwd;
        if (typeof nextCwd === "string") {
          setPanes((current) =>
            current.map((pane) =>
              pane.id === cwdPaneId ? { ...pane, cwd: nextCwd } : pane,
            ),
          );
        }
      }
      if (event.type === "app.exit_confirmation_requested") {
        const paneCount =
          typeof event.payload.paneCount === "number" ? event.payload.paneCount : 1;
        setExitPreflightRequest((current) => ({
          paneCount,
          nonce: (current?.nonce ?? 0) + 1,
        }));
      }
      if (event.type.startsWith("agent.")) {
        // Status events now carry the updated agent: apply it surgically so a busy
        // agent's stream of hook events doesn't refetch and replace the entire list
        // (with the re-renders and ordering hazards that caused). Events without an
        // agent fall back to a sequenced refetch.
        const updatedAgent = event.payload.agent;
        if (isAgentInfo(updatedAgent)) {
          setAgents((current) => upsertAgent(current, updatedAgent));
          if (event.type === "agent.spawned") {
            onAgentSpawned?.(
              updatedAgent,
              event.paneId ?? updatedAgent.paneId ?? null,
              stringField(event.payload, "source"),
            );
          }
          // Light up "Working…" only on a *live* transition into a working
          // status. The boot snapshot loads agents via setAgents(list) (the
          // else-branch below), which never touches this set, so a stale
          // working status restored from disk can't trigger it. "agent.recovered"
          // is excluded too: a recovered agent is waiting for input, not working,
          // even if it momentarily carries a working status.
          const working =
            updatedAgent.status === "running" || updatedAgent.status === "starting";
          setThinkingAgentIds((prev) => {
            const shouldThink = working && event.type !== "agent.recovered";
            if (shouldThink === prev.has(updatedAgent.id)) {
              return prev;
            }
            const next = new Set(prev);
            if (shouldThink) {
              next.add(updatedAgent.id);
            } else {
              next.delete(updatedAgent.id);
            }
            return next;
          });
        } else {
          const seq = (agentRefreshSeq += 1);
          void listAgents()
            .then((list) => {
              if (!disposed && seq === agentRefreshSeq) {
                setAgents(list);
              }
            })
            .catch(() => undefined);
        }
      }
      if (event.agentId && event.type === "agent.prompt_submitted") {
        const prompt = agentPromptSubmittedText(event.payload);
        if (prompt) {
          onAgentPromptSubmitted?.(event.agentId, prompt);
        }
      }
      if (event.type === "browser.open" && event.paneId) {
        const url = event.payload.url;
        if (typeof url === "string") {
          openBrowserOverlay(event.paneId, url, event.payload.sandbox === true);
        }
      }
      if (
        event.type === "group.created" ||
        event.type === "group.updated" ||
        event.type === "group.removed"
      ) {
        const seq = (groupsRefreshSeq += 1);
        void listGroups()
          .then((latest) => {
            if (!disposed && seq === groupsRefreshSeq) {
              setGroups(latest);
            }
          })
          .catch(() => undefined);
      }
      if (
        event.type === "agent.forked" ||
        (event.type === "agent.spawned" && event.payload.source === "queue")
      ) {
        // The fork — or a queue-dispatched new-session spawn — created a new pane
        // backend-side with no frontend caller holding it; refetch the ordered list
        // so the nested tab appears (with its depth) without stealing focus from
        // the source.
        const seq = (panesRefreshSeq += 1);
        void listPanes()
          .then((latest) => {
            if (!disposed && seq === panesRefreshSeq) {
              setPanes(latest);
            }
          })
          .catch(() => undefined);
      }
      if (
        event.agentId &&
        (event.type === "agent.turn_queued" ||
          event.type === "agent.queued_turn_sent" ||
          event.type === "agent.queued_turn_removed" ||
          event.type === "agent.queued_turn_reordered" ||
          event.type === "agent.unpaused" ||
          event.type === "agent.queue_error")
      ) {
        const queuedTurns = Array.isArray(event.payload.queuedTurns)
          ? event.payload.queuedTurns.filter(isQueuedTurn)
          : null;
        if (queuedTurns) {
          setAgentQueuedTurns(event.agentId, queuedTurns);
        } else {
          void refreshAgentTurnQueue(event.agentId).catch(() => undefined);
        }
      }
      if (event.type === "turn.appended") {
        const turn = event.payload.turn;
        if (isTurn(turn)) {
          setTurns((current) =>
            current.some((existing) => existing.id === turn.id) ? current : [...current, turn],
          );
        }
      }
      if (event.type === "turn.updated" && event.payload.reset) {
        const agentId = event.agentId;
        const replacementTurns = Array.isArray(event.payload.turns)
          ? event.payload.turns.filter(isTurn)
          : [];
        setTurns((current) => [
          ...current.filter((turn) => turn.agentId !== agentId),
          ...replacementTurns,
        ]);
      }
      if (
        event.agentId &&
        (event.type === "transcript.notice" || event.type === "transcript.error")
      ) {
        const agentId = event.agentId;
        // transcript.error carries `error`; transcript.notice carries `message`
        // (null/absent means the tail recovered, so the notice is cleared).
        const message =
          event.type === "transcript.error"
            ? typeof event.payload.error === "string"
              ? event.payload.error
              : "Failed to load transcript"
            : typeof event.payload.message === "string"
              ? event.payload.message
              : null;
        setTranscriptNoticeByAgent((current) => ({ ...current, [agentId]: message }));
        // A notice usually follows a recovery/rotation; refresh the picker so the
        // active session and any new candidates are reflected.
        void refreshTranscriptOptions(agentId).catch(() => undefined);
      }
      if (event.agentId && event.type === "agent.transcript_recovered") {
        void refreshTranscriptOptions(event.agentId).catch(() => undefined);
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
        onEventsReady();
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
