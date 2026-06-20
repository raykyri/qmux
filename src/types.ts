export type PaneKind = "shell" | "agent";

export interface RuntimeConfig {
  workspaceRoot: string;
  socketPath: string;
  claudeBinary: string;
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
    | "stopped"
    | "failed";
  model?: string | null;
  createdAt: number;
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

export interface SpawnClaudeRequest {
  prompt: string;
  groupId?: string | null;
  baseRepo?: string | null;
  baseRef?: string | null;
  cwd?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  initialSize?: InitialPaneSize | null;
  useWorktree?: boolean | null;
}

export interface WorktreeStatus {
  hasChanges: boolean;
  changedFiles: number;
}

export type SubmitAgentTurnMode = "auto" | "send" | "queue" | "steer";

export interface SubmitAgentTurnResult {
  queued: boolean;
  pendingTurns: number;
  queuedTurns: string[];
}

export interface RemoveQueuedAgentTurnResult {
  removedTurn: string;
  pendingTurns: number;
  queuedTurns: string[];
}

export interface ReorderQueuedAgentTurnResult {
  pendingTurns: number;
  queuedTurns: string[];
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
