import type { ReactNode } from "react";
import type { Turn, TurnBlock } from "../types";

interface TurnOverlayProps {
  turns: Turn[];
  input?: ReactNode;
}

export default function TurnOverlay({ turns, input }: TurnOverlayProps) {
  return (
    <section className="turn-sidebar" aria-label="Agent turns">
      <div className="turn-timeline">
        {turns.length === 0 ? (
          <p className="empty-turns">No turns yet</p>
        ) : (
          turns.map((turn) => (
            <article key={turn.id} className={`turn-card role-${turn.role}`}>
              <header>{turn.role}</header>
              <div className="turn-blocks">
                {turn.blocks.map((block, index) => (
                  <TurnBlockView key={`${turn.id}-${index}`} block={block} />
                ))}
              </div>
            </article>
          ))
        )}
      </div>
      {input ? <div className="turn-sidebar-input">{input}</div> : null}
    </section>
  );
}

function TurnBlockView({ block }: { block: TurnBlock }) {
  switch (block.type) {
    case "text":
      return <p className="turn-text">{block.text}</p>;
    case "toolUse":
      return (
        <details className="tool-block">
          <summary>{block.name}</summary>
          <pre>{stringify(block.input)}</pre>
        </details>
      );
    case "toolResult":
      return (
        <details className={`tool-block ${block.isError ? "is-error" : ""}`}>
          <summary>{block.isError ? "Tool error" : "Tool result"}</summary>
          <pre>{stringify(block.content)}</pre>
        </details>
      );
    case "raw":
      return (
        <details className="tool-block">
          <summary>Raw</summary>
          <pre>{stringify(block.value)}</pre>
        </details>
      );
  }
}

function stringify(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}
