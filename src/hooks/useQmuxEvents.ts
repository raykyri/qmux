import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listAgents, listenToEvents } from "../lib/api";
import { isTurn, transcriptHookEvent } from "../lib/appHelpers";
import type { ExitDialogState, PaneContextMenuState } from "../appTypes";
import type { AgentInfo, PaneInfo, TranscriptHookEvent, Turn } from "../types";

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
  setExitDialog: Dispatch<SetStateAction<ExitDialogState | null>>;
  setAgents: Dispatch<SetStateAction<AgentInfo[]>>;
  setTurns: Dispatch<SetStateAction<Turn[]>>;
  setTranscriptNoticeByAgent: Dispatch<SetStateAction<Record<string, string | null>>>;
  setAgentQueuedTurns: (agentId: string, queuedTurns: string[]) => void;
  refreshAgentTurnQueue: (agentId: string) => Promise<void>;
  refreshTranscriptOptions: (agentId: string) => Promise<void>;
}

export function useQmuxEvents(handlers: UseQmuxEventsHandlers) {
  const {
    setHookEventsByAgent,
    setPanes,
    setActivePaneId,
    setPaneContextMenu,
    setExitDialog,
    setAgents,
    setTurns,
    setTranscriptNoticeByAgent,
    setAgentQueuedTurns,
    refreshAgentTurnQueue,
    refreshTranscriptOptions,
  } = handlers;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenToEvents((event) => {
      if (disposed) {
        return;
      }
      const hookEvent = transcriptHookEvent(event);
      if (hookEvent) {
        setHookEventsByAgent((current) => ({
          ...current,
          [hookEvent.agentId]: [...(current[hookEvent.agentId] ?? []), hookEvent],
        }));
      }
      if (event.type === "pty.exit" && event.paneId) {
        const exitedPaneId = event.paneId;
        setPanes((current) => {
          const nextPanes = current.filter((pane) => pane.id !== exitedPaneId);
          setActivePaneId((currentActivePaneId) => {
            if (currentActivePaneId !== exitedPaneId) {
              return currentActivePaneId;
            }
            return nextPanes[0]?.id ?? null;
          });
          return nextPanes;
        });
        setPaneContextMenu((current) => (current?.paneId === exitedPaneId ? null : current));
      }
      if (event.type === "app.exit_confirmation_requested") {
        const paneCount =
          typeof event.payload.paneCount === "number" ? event.payload.paneCount : 1;
        setExitDialog({ paneCount });
      }
      if (event.type.startsWith("agent.")) {
        void listAgents().then(setAgents).catch(() => undefined);
      }
      if (
        event.agentId &&
        (event.type === "agent.turn_queued" ||
          event.type === "agent.queued_turn_sent" ||
          event.type === "agent.queued_turn_removed" ||
          event.type === "agent.queued_turn_reordered" ||
          event.type === "agent.queue_error")
      ) {
        const queuedTurns = Array.isArray(event.payload.queuedTurns)
          ? event.payload.queuedTurns.filter((turn): turn is string => typeof turn === "string")
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
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
