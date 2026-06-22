export type PaneKind = "shell" | "agent";

export interface RuntimeConfig {
  workspaceRoot: string;
  socketPath: string;
  adapters: AgentAdapterMetadata[];
  // The user's home directory (empty if HOME is unset), used to render
  // home-relative paths as ~/… rather than bare relative segments.
  homeDir: string;
}

export interface AgentAdapterMetadata {
  id: string;
  label: string;
  default: boolean;
}

export interface ClaudeSkill {
  id: string;
  name: string;
  command: string;
}

export interface PaneInfo {
  id: string;
  title: string;
  kind: PaneKind;
  agentId?: string | null;
  cwd: string;
  cols: number;
  rows: number;
  status: "starting" | "running" | "exited" | "killed" | "failed";
  // True for panes recreated from persisted state after a qmux restart.
  recovered?: boolean;
  // Sidebar nesting depth (0 = root). Stamped by the backend.
  depth?: number;
}

export interface InitialPaneSize {
  cols: number;
  rows: number;
}

export interface GroupInfo {
  id: string;
  name: string;
  dir: string;
  baseRepo?: string | null;
  baseRef?: string | null;
  parentId?: string | null;
  createdAt: number;
  agents: string[];
}

export interface AgentInfo {
  id: string;
  groupId: string;
  adapter: string;
  worktreeDir: string;
  branch?: string | null;
  paneId?: string | null;
  orphanedQueuePaneId?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  status:
    | "starting"
    | "running"
    | "awaitingInput"
    | "awaitingPermission"
    | "done"
    | "idle"
    | "failed";
  model?: string | null;
  // True when the queue has paused after a pause-after turn finished.
  paused?: boolean;
  createdAt: number;
}

export interface RecentSessionInfo {
  id: string;
  adapter: string;
  groupId?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  worktreeDir: string;
  branch?: string | null;
  model?: string | null;
  parentId?: string | null;
  forkPoint?: string | null;
  rootSessionId?: string | null;
  preview?: string | null;
  lineCount: number;
  lastActiveAt: number;
  createdAt: number;
  paneId?: string | null;
  agentId?: string | null;
  status?: AgentInfo["status"] | null;
  missing: boolean;
}

export interface QueuedTurn {
  text: string;
  pauseAfter: boolean;
}

export type TurnBlock =
  | { type: "text"; text: string }
  | { type: "toolUse"; id?: string | null; name: string; input: unknown }
  | { type: "toolResult"; toolUseId?: string | null; content: unknown; isError: boolean }
  | { type: "raw"; value: unknown };

export interface Turn {
  id: string;
  agentId: string;
  sessionId?: string | null;
  role: string;
  blocks: TurnBlock[];
  sourceIndex: number;
}

// A selectable past/parallel session for the right pane's transcript picker, used
// to correct an agent that auto-recovered onto the wrong session file.
export interface TranscriptOption {
  path: string;
  sessionId?: string | null;
  modifiedMs: number;
  preview?: string | null;
  lineCount: number;
  // The transcript the agent is currently bound to.
  isActive: boolean;
  // Another agent is tailing this file; selecting it would collide.
  boundToOtherAgent: boolean;
}

export interface SpawnAgentRequest {
  adapterId: string;
  prompt: string;
  groupId?: string | null;
  baseRepo?: string | null;
  baseRef?: string | null;
  cwd?: string | null;
  model?: string | null;
  initialSize?: InitialPaneSize | null;
  useWorktree?: boolean | null;
  options?: Record<string, unknown> | null;
}

export interface WorktreeStatus {
  hasChanges: boolean;
  changedFiles: number;
}

export type SubmitAgentTurnMode = "auto" | "send" | "queue" | "steer";

export interface SubmitAgentTurnResult {
  queued: boolean;
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface RemoveQueuedAgentTurnResult {
  removedTurn: string;
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface ReorderQueuedAgentTurnResult {
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface SendNextQueuedAgentTurnResult {
  sent: boolean;
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface MoveQueuedAgentTurnResult {
  sent: boolean;
  sourceQueuedTurns: QueuedTurn[];
  targetQueuedTurns: QueuedTurn[];
}

export interface TranscriptHookEvent {
  type: string;
  paneId?: string | null;
  agentId: string;
  hookEvent: string;
  payload: unknown;
  timestamp: number;
}

export interface TranscriptCopyPayload {
  version: 1;
  exportedAt: string;
  agent: AgentInfo;
  pane: PaneInfo;
  transcriptText: string;
  turns: Turn[];
  hooks: TranscriptHookEvent[];
}

export interface QmuxEvent {
  type: string;
  paneId?: string | null;
  agentId?: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
}
