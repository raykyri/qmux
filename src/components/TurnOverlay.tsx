import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Turn, TurnBlock } from "../types";

interface TurnOverlayProps {
  turns: Turn[];
  input?: ReactNode;
}

// Gap kept between the last transcript message and the top of the composer.
const COMPOSER_CLEARANCE = 16;

export function formatTurnsTranscript(turns: Turn[]) {
  return turns.map(formatTurnTranscript).join("\n\n");
}

export default function TurnOverlay({ turns, input }: TurnOverlayProps) {
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);

  // The composer floats over the transcript, so reserve scroll room beneath the
  // last message equal to the composer's live height (it changes as the queue
  // grows and as the textarea expands). Without this, queued turns hide the
  // bottom of the transcript with no way to scroll to it.
  useEffect(() => {
    const element = inputWrapRef.current;
    if (!element) {
      setComposerHeight(0);
      return;
    }
    const measure = () => setComposerHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(input)]);

  const timelineStyle: CSSProperties | undefined =
    composerHeight > 0 ? { paddingBottom: composerHeight + COMPOSER_CLEARANCE } : undefined;

  return (
    <section className="turn-sidebar" aria-label="Agent turns">
      <div className="turn-timeline" style={timelineStyle}>
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
      {input ? (
        <div className="turn-sidebar-input" ref={inputWrapRef}>
          {input}
        </div>
      ) : null}
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

function formatTurnTranscript(turn: Turn) {
  return [turn.role, ...turn.blocks.map(formatTurnBlockTranscript)].join("\n").trimEnd();
}

function formatTurnBlockTranscript(block: TurnBlock) {
  switch (block.type) {
    case "text":
      return block.text;
    case "toolUse":
      return formatLabeledBlock(block.name, block.input);
    case "toolResult":
      return formatLabeledBlock(block.isError ? "Tool error" : "Tool result", block.content);
    case "raw":
      return formatLabeledBlock("Raw", block.value);
  }
}

function formatLabeledBlock(label: string, value: unknown) {
  const content = stringify(value);
  return content ? `${label}\n${content}` : label;
}

function stringify(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}
