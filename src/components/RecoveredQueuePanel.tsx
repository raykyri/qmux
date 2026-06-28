import type { AgentInfo, QueuedTurn } from "../types";

export type OrphanedQueueGroup = {
  agent: AgentInfo;
  queuedTurns: QueuedTurn[];
};

interface RecoveredQueuePanelProps {
  queues: OrphanedQueueGroup[];
  hasTargetAgent: boolean;
  agentLabel: string;
  onMoveTurn: (agentId: string, index: number, turn: string) => void;
  onDiscardTurn: (agentId: string, index: number, turn: string) => void;
}

export default function RecoveredQueuePanel({
  queues,
  hasTargetAgent,
  agentLabel,
  onMoveTurn,
  onDiscardTurn,
}: RecoveredQueuePanelProps) {
  const totalTurns = queues.reduce((total, queue) => total + queue.queuedTurns.length, 0);

  return (
    <section className="recovered-queue-panel" aria-label="Recovered queued turns">
      <header>
        <h2>Recovered queued turns ({totalTurns})</h2>
      </header>
      <div className="recovered-queue-list">
        {queues.map(({ agent, queuedTurns }) => (
          <div key={agent.id} className="recovered-queue-group">
            {queuedTurns.map((turn, index) => (
              <div key={`${agent.id}-${index}-${turn.text}`} className="recovered-queue-item">
                <p>{turn.text}</p>
                <div className="recovered-queue-actions">
                  <button
                    type="button"
                    disabled={!hasTargetAgent}
                    title={
                      hasTargetAgent
                        ? "Queue to the current agent"
                        : `Launch ${agentLabel} in this tab before queueing`
                    }
                    onClick={() => onMoveTurn(agent.id, index, turn.text)}
                  >
                    Queue
                  </button>
                  <button type="button" onClick={() => onDiscardTurn(agent.id, index, turn.text)}>
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
