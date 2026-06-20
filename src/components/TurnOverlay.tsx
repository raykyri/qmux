import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Turn, TurnBlock } from "../types";

interface TurnOverlayProps {
  turns: Turn[];
  input?: ReactNode;
  // Identifies the agent whose transcript is shown; a change means a different
  // transcript loaded, which is when we jump the view to the latest turn.
  agentId?: string;
}

// Gap kept between the last transcript message and the top of the composer.
const COMPOSER_CLEARANCE = 16;

// How close to the bottom (in px) the user must be for new turns or a growing
// composer to keep the transcript pinned to the bottom.
const STICK_TO_BOTTOM_THRESHOLD = 100;

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
  activities: ActivityItem[];
}

interface ToolEntry {
  type: "tool";
  key: string;
  id?: string | null;
  name: string;
  input?: unknown;
  result?: unknown;
  isError: boolean;
}

interface ThinkingItem {
  type: "thinking";
  key: string;
  values: unknown[];
}

type ActivityItem = ToolEntry | ThinkingItem;

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="turn-markdown-table-wrap">
      <table {...props} />
    </div>
  ),
};

export function formatTurnsTranscript(turns: Turn[]) {
  return turns.map(formatTurnTranscript).join("\n\n");
}

export default function TurnOverlay({ turns, input, agentId }: TurnOverlayProps) {
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  // Whether the view is parked near the bottom, so incoming content can keep it
  // pinned there. Starts true (we load at the bottom) and tracks user scrolling.
  const stickToBottomRef = useRef(true);
  const [composerHeight, setComposerHeight] = useState(0);

  const scrollToBottom = () => {
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  };

  const handleTimelineScroll = () => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD;
  };

  // When a different transcript loads, start at the bottom so the latest turn is
  // in view. useLayoutEffect runs before paint, so the pane never flashes at the
  // top first; the rAF re-assert catches the composer's reserved-space reflow.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    scrollToBottom();
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
  }, [agentId]);

  // Keep pinned to the bottom when new turns arrive or the composer grows (e.g. a
  // queued message), but only while the user is already near the bottom — instant,
  // so reading older turns is never interrupted.
  useLayoutEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom();
    }
  }, [turns, composerHeight]);

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
  const timelineItems = useMemo(
    () => buildTimelineItems(normalizeQueuedTurns(turns)),
    [turns],
  );

  return (
    <section className="turn-sidebar" aria-label="Agent turns">
      <div
        ref={timelineRef}
        className="turn-timeline"
        style={timelineStyle}
        onScroll={handleTimelineScroll}
      >
        {timelineItems.length === 0 ? (
          <p className="empty-turns">No turns yet</p>
        ) : (
          timelineItems.map((item) => <MessageTimelineItemView key={item.key} item={item} />)
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

function turnText(turn: Turn): string {
  return turn.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

// Claude's transcript logs a queued prompt twice: once as a `queue-operation`
// entry when it is enqueued, then again as a `user` turn when it is actually
// submitted. With the empty bookkeeping entries filtered out, those two land
// next to each other with identical text — drop the queue-operation duplicate.
// Any queue-operation turn that survives is still just the user's queued prompt,
// so relabel it to render as a plain user message rather than a "queue-operation".
function normalizeQueuedTurns(turns: Turn[]): Turn[] {
  const result: Turn[] = [];
  turns.forEach((turn, index) => {
    if (turn.role !== "queue-operation") {
      result.push(turn);
      return;
    }
    const text = turnText(turn);
    if (!text) {
      result.push(turn);
      return;
    }
    const hasAdjacentUserDuplicate = [turns[index - 1], turns[index + 1]].some(
      (neighbor) => neighbor?.role === "user" && turnText(neighbor) === text,
    );
    if (hasAdjacentUserDuplicate) {
      return;
    }
    result.push({ ...turn, role: "user" });
  });
  return result;
}

function buildTimelineItems(turns: Turn[]): MessageItem[] {
  const items: MessageItem[] = [];
  const pendingById = new Map<string, ToolEntry>();
  const pendingWithoutId: ToolEntry[] = [];
  let sequence = 0;

  const nextKey = (prefix: string) => `${prefix}-${sequence++}`;

  const createMessageItem = (role: string, block?: MessageBlock): MessageItem => ({
    type: "message",
    key: nextKey(`message-${role}`),
    role,
    blocks: block ? [block] : [],
    activities: [],
  });

  const pushMessageBlock = (role: string, block: MessageBlock) => {
    const previous = items[items.length - 1];
    if (previous?.role === role && previous.activities.length === 0) {
      previous.blocks.push(block);
      return;
    }
    items.push(createMessageItem(role, block));
  };

  const assistantActivityOwner = () => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].role === "assistant") {
        return items[index];
      }
    }
    const fallback = createMessageItem("assistant");
    items.push(fallback);
    return fallback;
  };

  const pushThinkingValue = (value: unknown) => {
    const owner = assistantActivityOwner();
    const previousActivity = owner.activities[owner.activities.length - 1];
    if (previousActivity?.type === "thinking") {
      previousActivity.values.push(value);
      return;
    }
    owner.activities.push({
      type: "thinking",
      key: nextKey("thinking"),
      values: [value],
    });
  };

  const pushToolEntry = (entry: ToolEntry) => {
    // Each tool call is its own activity row — no "N tool calls" grouping layer.
    assistantActivityOwner().activities.push(entry);
  };

  const registerToolUse = (block: ToolUseBlock) => {
    const entry: ToolEntry = {
      type: "tool",
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
      type: "tool",
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

function MessageTimelineItemView({ item }: { item: MessageItem }) {
  return (
    <>
      {item.blocks.length > 0 ? <MessageItemView item={item} /> : null}
      {item.activities.map((activity) => (
        <ActivityItemView key={activity.key} item={activity} />
      ))}
    </>
  );
}

function MessageItemView({ item }: { item: MessageItem }) {
  return (
    <article className={`turn-card role-${item.role}`}>
      <header>{item.role}</header>
      <div className="turn-blocks">
        {item.blocks.map((block, index) => (
          <MessageBlockView key={`${item.key}-${index}`} block={block} role={item.role} />
        ))}
      </div>
    </article>
  );
}

function ActivityItemView({ item }: { item: ActivityItem }) {
  switch (item.type) {
    case "tool":
      return <ToolEntryView entry={item} />;
    case "thinking":
      return <ThinkingView item={item} />;
  }
}

function MessageBlockView({ block, role }: { block: MessageBlock; role: string }) {
  if (block.type === "text") {
    if (role !== "assistant") {
      return <p className="turn-text">{block.text}</p>;
    }
    return (
      <div className="turn-markdown">
        <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm, remarkBreaks]}>
          {block.text}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <details className="tool-block">
      <summary>
        <DisclosureChevron />
        <span>Raw</span>
      </summary>
      <pre>{stringify(block.value)}</pre>
    </details>
  );
}

function ToolEntryView({ entry }: { entry: ToolEntry }) {
  return (
    <details className={`tool-block tool-pair ${entry.isError ? "is-error" : ""}`}>
      <summary>
        <DisclosureChevron />
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
      <summary>
        <DisclosureChevron />
        <span>Thinking...</span>
      </summary>
      {item.values.map((value, index) => (
        <pre key={`${item.key}-${index}`}>{stringify(value)}</pre>
      ))}
    </details>
  );
}

function DisclosureChevron() {
  return <ChevronRight className="disclosure-chevron" size={13} aria-hidden="true" />;
}

function toolEntryStatus(entry: ToolEntry) {
  if (entry.result === undefined) {
    return "running";
  }
  const status = entry.isError ? "error" : "done";
  return `${status}, ${stringify(entry.result).length} chars`;
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
