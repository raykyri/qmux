import { useState } from "react";
import type { AgentInfo, QueuedTurn } from "../types";

export type OrphanedQueueGroup = {
  agent: AgentInfo;
  queuedTurns: QueuedTurn[];
};

interface RecoveredQueuePanelProps {
  queues: OrphanedQueueGroup[];
  hasTargetAgent: boolean;
  agentLabel: string;
  onMoveTurn: (agentId: string, index: number, turn: string, expectedId: string) => void;
  onDiscardTurn: (agentId: string, index: number, turn: string, expectedId: string) => void;
}

export default function RecoveredQueuePanel({
  queues,
  hasTargetAgent,
  agentLabel,
  onMoveTurn,
  onDiscardTurn,
}: RecoveredQueuePanelProps) {
  const totalTurns = queues.reduce((total, queue) => total + queue.queuedTurns.length, 0);
  // Rows with an action already dispatched. Both buttons disable synchronously
  // so a rapid double click (or a concurrent queue shift) can't fire a second
  // operation that, with duplicate text, would land on a different turn.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  return (
    <section className="recovered-queue-panel" aria-label="Recovered queued turns">
      <header>
        <h2>Recovered queued turns ({totalTurns})</h2>
      </header>
      <div className="recovered-queue-list">
        {queues.map(({ agent, queuedTurns }) => (
          <div key={agent.id} className="recovered-queue-group">
            {queuedTurns.map((turn, index) => {
              const rowKey = `${agent.id}:${turn.id}`;
              const isPending = pending.has(rowKey);
              const run = (action: () => void) => {
                if (isPending) {
                  return;
                }
                setPending((current) => new Set(current).add(rowKey));
                action();
              };
              return (
                <div key={rowKey} className="recovered-queue-item">
                  <p>{turn.text}</p>
                  <div className="recovered-queue-actions">
                    <button className="control-button"
                      type="button"
                      disabled={!hasTargetAgent || isPending}
                      title={
                        hasTargetAgent
                          ? "Queue to the current agent"
                          : `Launch ${agentLabel} in this tab before queueing`
                      }
                      onClick={() => run(() => onMoveTurn(agent.id, index, turn.text, turn.id))}
                    >
                      Queue
                    </button>
                    <button
                      className="control-button"
                      type="button"
                      disabled={isPending}
                      onClick={() => run(() => onDiscardTurn(agent.id, index, turn.text, turn.id))}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
