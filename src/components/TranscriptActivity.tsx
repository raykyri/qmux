import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type {
  ActivityGroupItem,
  ActivityItem,
  ActivityLeafItem,
  ThinkingItem,
  ToolEntry,
  TurnTimelineStatus,
} from "../lib/turnTimeline";

const TOOL_SUMMARY_ARGUMENT_KEYS = {
  exec_command: "cmd",
  "functions.exec_command": "cmd",
  Bash: "command",
  WebFetch: "url",
  Read: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
} as const;

const TOOL_ACTION_NAMES = {
  readFile: new Set(["read", "read_file", "glob", "grep", "ls"]),
  editFile: new Set([
    "edit",
    "multi_edit",
    "multiedit",
    "notebook_edit",
    "notebookedit",
    "write",
    "apply_patch",
  ]),
  runCommand: new Set(["bash", "exec_command", "shell", "run_command"]),
} as const;

type ToolActionKind = keyof typeof TOOL_ACTION_NAMES;

export function timelineStatusClass(status: TurnTimelineStatus | undefined) {
  return status ? ` is-status-${status}` : "";
}

export function serializeActivityValue(value: unknown, maxCharacters?: number) {
  let serialized: string;
  try {
    if (typeof value === "string") {
      serialized = value;
    } else {
      serialized = JSON.stringify(value, null, 2) ?? String(value);
    }
  } catch {
    serialized = "(payload could not be serialized)";
  }
  if (maxCharacters && serialized.length > maxCharacters) {
    return `${serialized.slice(0, maxCharacters)}\n… (truncated)`;
  }
  return serialized;
}

export function TranscriptActivityItem({
  item,
  isRootActivity = false,
  maxPayloadCharacters,
  deferPayloads = false,
  showResultCharacterCount = true,
}: {
  item: ActivityItem;
  isRootActivity?: boolean;
  maxPayloadCharacters?: number;
  deferPayloads?: boolean;
  showResultCharacterCount?: boolean;
}) {
  switch (item.type) {
    case "tool":
      return (
        <ToolEntryView
          entry={item}
          showChevron={!isRootActivity}
          maxPayloadCharacters={maxPayloadCharacters}
          showResultCharacterCount={showResultCharacterCount}
        />
      );
    case "thinking":
      return (
        <ThinkingView
          item={item}
          showChevron={!isRootActivity}
          maxPayloadCharacters={maxPayloadCharacters}
          deferPayloads={deferPayloads}
        />
      );
    case "activityGroup":
      return (
        <ActivityGroupView
          group={item}
          showChevron={!isRootActivity}
          maxPayloadCharacters={maxPayloadCharacters}
          deferPayloads={deferPayloads}
          showResultCharacterCount={showResultCharacterCount}
        />
      );
  }
}

function ActivityGroupView({
  group,
  showChevron,
  maxPayloadCharacters,
  deferPayloads,
  showResultCharacterCount,
}: {
  group: ActivityGroupItem;
  showChevron: boolean;
  maxPayloadCharacters?: number;
  deferPayloads: boolean;
  showResultCharacterCount: boolean;
}) {
  return (
    <details
      className={`activity-group-block${showChevron ? "" : " is-root-activity"}${timelineStatusClass(
        group.status,
      )}`}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span
          className={`activity-group-label ${
            group.toolCallCount > 0 ? "is-tool-group" : "is-thinking-group"
          }`}
        >
          {activityGroupLabel(group)}
        </span>
      </summary>
      <div className="activity-group-children">
        {group.children.map((child) => (
          <TranscriptActivityItem
            key={child.key}
            item={child}
            maxPayloadCharacters={maxPayloadCharacters}
            deferPayloads={deferPayloads}
            showResultCharacterCount={showResultCharacterCount}
          />
        ))}
      </div>
    </details>
  );
}

export function uniqueToolEntries(items: ActivityLeafItem[]) {
  const seen = new Set<string>();
  const entries: ToolEntry[] = [];
  for (const item of items) {
    if (item.type !== "tool") {
      continue;
    }
    const key = item.id ? `id:${item.id}` : `entry:${item.key}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(item);
  }
  return entries;
}

export function activityGroupLabel(group: ActivityGroupItem) {
  const entries = uniqueToolEntries(group.children);
  if (entries.length === 0) {
    return "Thought for a while";
  }
  return toolActionGroupLabel(entries) ?? calledToolsLabel(group.toolCallCount);
}

export function toolActionGroupLabel(entries: ToolEntry[]) {
  const counts: Record<ToolActionKind, number> = {
    readFile: 0,
    editFile: 0,
    runCommand: 0,
  };
  let unknownCount = 0;

  for (const entry of entries) {
    const kind = classifyToolAction(entry);
    if (kind) {
      counts[kind] += 1;
    } else {
      unknownCount += 1;
    }
  }

  const recognizedCount = counts.readFile + counts.editFile + counts.runCommand;
  if (recognizedCount === 0) {
    return null;
  }

  const parts = [
    fileActionLabel("read", counts.readFile),
    fileActionLabel("edited", counts.editFile),
    commandActionLabel(counts.runCommand),
    unknownCount > 0
      ? `called ${unknownCount} other tool${unknownCount === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => Boolean(part));
  return capitalizeSentence(parts.join(", "));
}

function classifyToolAction(entry: ToolEntry): ToolActionKind | null {
  const name = normalizedToolName(entry.name);
  for (const [kind, names] of Object.entries(TOOL_ACTION_NAMES) as [
    ToolActionKind,
    ReadonlySet<string>,
  ][]) {
    if (names.has(name)) {
      return kind;
    }
  }
  return null;
}

function normalizedToolName(name: string) {
  const raw = name.trim();
  const dotted = raw.includes(".") ? (raw.split(".").pop() ?? raw) : raw;
  const namespaced = dotted.includes("__") ? (dotted.split("__").pop() ?? dotted) : dotted;
  return namespaced.replace(/[\s-]+/g, "_").toLowerCase();
}

function fileActionLabel(verb: "read" | "edited", count: number) {
  if (count === 0) {
    return null;
  }
  return count === 1 ? `${verb} a file` : `${verb} files`;
}

function commandActionLabel(count: number) {
  if (count === 0) {
    return null;
  }
  return count === 1 ? "ran a command" : `ran ${count} commands`;
}

function calledToolsLabel(count: number) {
  return `Called ${count} tool${count === 1 ? "" : "s"}`;
}

function capitalizeSentence(label: string) {
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function ToolEntryView({
  entry,
  showChevron,
  maxPayloadCharacters,
  showResultCharacterCount,
}: {
  entry: ToolEntry;
  showChevron: boolean;
  maxPayloadCharacters?: number;
  showResultCharacterCount: boolean;
}) {
  const summaryArgument = toolSummaryArgument(entry);
  const toolNameLabel = showChevron ? entry.name : `Called ${entry.name}`;
  const summaryLabel = summaryArgument ? `${toolNameLabel} ${summaryArgument}` : toolNameLabel;
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className={`tool-block tool-pair${entry.isError ? " is-error" : ""}${
        showChevron ? "" : " is-root-activity"
      }${timelineStatusClass(entry.status)}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span className="tool-summary">
          <span className="tool-summary-main" title={summaryLabel}>
            <span>{toolNameLabel}</span>
            {summaryArgument ? <span className="tool-summary-arg"> {summaryArgument}</span> : null}
          </span>
          <ToolEntryStatus
            entry={entry}
            showCharCount={showChevron && showResultCharacterCount}
          />
        </span>
      </summary>
      {expanded && entry.input !== undefined ? (
        <ToolPayload
          label="Input"
          value={entry.input}
          maxPayloadCharacters={maxPayloadCharacters}
        />
      ) : null}
      {expanded && entry.result !== undefined ? (
        <ToolPayload
          label={entry.isError ? "Error" : "Result"}
          value={entry.result}
          maxPayloadCharacters={maxPayloadCharacters}
        />
      ) : null}
    </details>
  );
}

function toolSummaryArgument(entry: ToolEntry) {
  const key =
    TOOL_SUMMARY_ARGUMENT_KEYS[entry.name as keyof typeof TOOL_SUMMARY_ARGUMENT_KEYS] ?? null;
  if (!key) {
    return null;
  }
  const input = objectValue(entry.input);
  if (!input) {
    return null;
  }
  return inlineSummaryValue(input[key]);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inlineSummaryValue(value: unknown) {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function ToolPayload({
  label,
  value,
  maxPayloadCharacters,
}: {
  label: string;
  value: unknown;
  maxPayloadCharacters?: number;
}) {
  return (
    <div className="tool-payload">
      <div className="tool-payload-label">{label}</div>
      <pre>{serializeActivityValue(value, maxPayloadCharacters)}</pre>
    </div>
  );
}

function ThinkingView({
  item,
  showChevron,
  maxPayloadCharacters,
  deferPayloads,
}: {
  item: ThinkingItem;
  showChevron: boolean;
  maxPayloadCharacters?: number;
  deferPayloads: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className={`thinking-block${showChevron ? "" : " is-root-activity"}${timelineStatusClass(
        item.status,
      )}`}
      onToggle={
        deferPayloads ? (event) => setExpanded(event.currentTarget.open) : undefined
      }
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span>Thought for a while</span>
      </summary>
      {!deferPayloads || expanded
        ? item.values.map((value, index) => (
            <pre key={`${item.key}-${index}`}>
              {serializeActivityValue(value, maxPayloadCharacters)}
            </pre>
          ))
        : null}
    </details>
  );
}

export function RawTranscriptDisclosure({
  value,
  maxPayloadCharacters,
  deferPayload = false,
}: {
  value: unknown;
  maxPayloadCharacters?: number;
  deferPayload?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="tool-block"
      onToggle={deferPayload ? (event) => setExpanded(event.currentTarget.open) : undefined}
    >
      <summary>
        <DisclosureChevron />
        <span>Raw</span>
      </summary>
      {!deferPayload || expanded ? (
        <pre>{serializeActivityValue(value, maxPayloadCharacters)}</pre>
      ) : null}
    </details>
  );
}

export function DisclosureChevron() {
  return <ChevronRight className="disclosure-chevron" size={12} aria-hidden="true" />;
}

function ToolEntryStatus({
  entry,
  showCharCount,
}: {
  entry: ToolEntry;
  showCharCount: boolean;
}) {
  const charCount = useMemo(
    () =>
      showCharCount && entry.result !== undefined
        ? `${serializeActivityValue(entry.result).length} chars`
        : null,
    [entry.result, showCharCount],
  );
  if (entry.result === undefined) {
    return <span className="tool-summary-meta">running</span>;
  }
  if (!showCharCount || charCount === null) {
    return entry.isError ? <span className="tool-summary-meta">error</span> : null;
  }
  if (entry.isError) {
    return <span className="tool-summary-meta">error, {charCount}</span>;
  }
  return <span className="tool-summary-meta">{charCount}</span>;
}
