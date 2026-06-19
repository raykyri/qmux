import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Turn, TurnBlock } from "../types";

interface TurnOverlayProps {
  turns: Turn[];
  input?: ReactNode;
}

// Gap kept between the last transcript message and the top of the composer.
const COMPOSER_CLEARANCE = 16;

type TextBlock = Extract<TurnBlock, { type: "text" }>;
type ToolUseBlock = Extract<TurnBlock, { type: "toolUse" }>;
type ToolResultBlock = Extract<TurnBlock, { type: "toolResult" }>;
type RawBlock = Extract<TurnBlock, { type: "raw" }>;

type MessageBlock = TextBlock | RawBlock;

interface MessageItem {
  type: "message";
  key: string;
  role: string;
  blocks: MessageBlock[];
}

interface ToolEntry {
  key: string;
  id?: string | null;
  name: string;
  input?: unknown;
  result?: unknown;
  isError: boolean;
}

interface ToolRunItem {
  type: "toolRun";
  key: string;
  entries: ToolEntry[];
}

interface ThinkingItem {
  type: "thinking";
  key: string;
  values: unknown[];
}

type TimelineItem = MessageItem | ToolRunItem | ThinkingItem;

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
  const timelineItems = useMemo(() => buildTimelineItems(turns), [turns]);

  return (
    <section className="turn-sidebar" aria-label="Agent turns">
      <div className="turn-timeline" style={timelineStyle}>
        {timelineItems.length === 0 ? (
          <p className="empty-turns">No turns yet</p>
        ) : (
          timelineItems.map((item) => <TimelineItemView key={item.key} item={item} />)
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

function buildTimelineItems(turns: Turn[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const pendingById = new Map<string, ToolEntry>();
  const pendingWithoutId: ToolEntry[] = [];
  let sequence = 0;

  const nextKey = (prefix: string) => `${prefix}-${sequence++}`;

  const pushMessageBlock = (role: string, block: MessageBlock) => {
    const previous = items[items.length - 1];
    if (previous?.type === "message" && previous.role === role) {
      previous.blocks.push(block);
      return;
    }
    items.push({
      type: "message",
      key: nextKey(`message-${role}`),
      role,
      blocks: [block],
    });
  };

  const pushThinkingValue = (value: unknown) => {
    const previous = items[items.length - 1];
    if (previous?.type === "thinking") {
      previous.values.push(value);
      return;
    }
    items.push({
      type: "thinking",
      key: nextKey("thinking"),
      values: [value],
    });
  };

  const pushToolEntry = (entry: ToolEntry) => {
    const previous = items[items.length - 1];
    if (previous?.type === "toolRun") {
      previous.entries.push(entry);
      return;
    }
    items.push({
      type: "toolRun",
      key: nextKey("tool-run"),
      entries: [entry],
    });
  };

  const registerToolUse = (block: ToolUseBlock) => {
    const entry: ToolEntry = {
      key: nextKey("tool"),
      id: block.id ?? null,
      name: block.name,
      input: block.input,
      isError: false,
    };
    pushToolEntry(entry);
    if (entry.id) {
      pendingById.set(entry.id, entry);
    } else {
      pendingWithoutId.push(entry);
    }
  };

  const attachToolResult = (block: ToolResultBlock) => {
    let entry: ToolEntry | undefined;
    const toolUseId = block.toolUseId ?? null;

    if (toolUseId) {
      entry = pendingById.get(toolUseId);
      pendingById.delete(toolUseId);
    } else {
      entry = pendingWithoutId.shift();
    }

    if (entry) {
      entry.result = block.content;
      entry.isError = block.isError;
      return;
    }

    pushToolEntry({
      key: nextKey("tool-result"),
      id: toolUseId,
      name: block.isError ? "Tool error" : "Tool result",
      result: block.content,
      isError: block.isError,
    });
  };

  for (const turn of turns) {
    for (const block of turn.blocks) {
      switch (block.type) {
        case "text":
          pushMessageBlock(turn.role, block);
          break;
        case "toolUse":
          registerToolUse(block);
          break;
        case "toolResult":
          attachToolResult(block);
          break;
        case "raw":
          if (turn.role === "assistant") {
            pushThinkingValue(block.value);
          } else {
            pushMessageBlock(turn.role, block);
          }
          break;
      }
    }
  }

  return items;
}

function TimelineItemView({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "message":
      return <MessageItemView item={item} />;
    case "toolRun":
      return <ToolRunView item={item} />;
    case "thinking":
      return <ThinkingView item={item} />;
  }
}

function MessageItemView({ item }: { item: MessageItem }) {
  return (
    <article className={`turn-card role-${item.role}`}>
      <header>{item.role}</header>
      <div className="turn-blocks">
        {item.blocks.map((block, index) => (
          <MessageBlockView key={`${item.key}-${index}`} block={block} />
        ))}
      </div>
    </article>
  );
}

function MessageBlockView({ block }: { block: MessageBlock }) {
  if (block.type === "text") {
    return <p className="turn-text">{block.text}</p>;
  }

  return (
    <details className="tool-block">
      <summary>Raw</summary>
      <pre>{stringify(block.value)}</pre>
    </details>
  );
}

function ToolRunView({ item }: { item: ToolRunItem }) {
  if (item.entries.length === 1) {
    return <ToolEntryView entry={item.entries[0]} />;
  }

  return (
    <details
      className={`tool-run-block ${item.entries.some((entry) => entry.isError) ? "is-error" : ""}`}
    >
      <summary>
        <span className="tool-summary">
          <span className="tool-summary-main">{item.entries.length} tool calls</span>
          <span className="tool-summary-meta">{summarizeToolNames(item.entries)}</span>
        </span>
      </summary>
      <div className="tool-run-items">
        {item.entries.map((entry) => (
          <ToolEntryView key={entry.key} entry={entry} nested />
        ))}
      </div>
    </details>
  );
}

function ToolEntryView({ entry, nested = false }: { entry: ToolEntry; nested?: boolean }) {
  return (
    <details
      className={`tool-block tool-pair ${nested ? "is-nested" : ""} ${entry.isError ? "is-error" : ""}`}
    >
      <summary>
        <span className="tool-summary">
          <span className="tool-summary-main">{entry.name}</span>
          <span className="tool-summary-meta">{toolEntryStatus(entry)}</span>
        </span>
      </summary>
      {entry.input !== undefined ? <ToolPayload label="Input" value={entry.input} /> : null}
      {entry.result !== undefined ? (
        <ToolPayload label={entry.isError ? "Error" : "Result"} value={entry.result} />
      ) : null}
    </details>
  );
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="tool-payload">
      <div className="tool-payload-label">{label}</div>
      <pre>{stringify(value)}</pre>
    </div>
  );
}

function ThinkingView({ item }: { item: ThinkingItem }) {
  return (
    <details className="thinking-block">
      <summary>Thinking...</summary>
      {item.values.map((value, index) => (
        <pre key={`${item.key}-${index}`}>{stringify(value)}</pre>
      ))}
    </details>
  );
}

function toolEntryStatus(entry: ToolEntry) {
  if (entry.result === undefined) {
    return "running";
  }
  const status = entry.isError ? "error" : "done";
  return `${status}, ${stringify(entry.result).length} chars`;
}

function summarizeToolNames(entries: ToolEntry[]) {
  const names = entries.map((entry) => entry.name);
  const visibleNames = names.slice(0, 4).join(", ");
  const remaining = names.length - 4;
  return remaining > 0 ? `${visibleNames}, +${remaining}` : visibleNames;
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
