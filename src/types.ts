export type PaneKind = "shell" | "agent";

export interface RuntimeConfig {
  workspaceRoot: string;
  socketPath: string;
  adapters: AgentAdapterMetadata[];
  // The user's home directory (empty if HOME is unset), used to render
  // home-relative paths as ~/… rather than bare relative segments.
  homeDir: string;
  tabTitleGeneration: TabTitleGenerationRuntimeConfig;
}

export interface TabTitleGenerationRuntimeConfig {
  appleFoundationModelsAvailable: boolean;
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
  groupId: string;
  cwd: string;
  cols: number;
  rows: number;
  status: "starting" | "running" | "exited" | "killed" | "failed";
  // Wall-clock millis when the pane was last focused. Stamped by the backend at
  // spawn and on activation; feeds the group spawn-cwd heuristic.
  lastActiveAt?: number;
  // True for panes recreated from persisted state after a qmux restart.
  recovered?: boolean;
  // Sidebar nesting depth (0 = root). Stamped by the backend.
  depth?: number;
}

export type PaneSplitIntentSource = "command" | "join" | "drag-half" | "drag-divider";

export type PaneSplitIntentPosition = "above" | "below";

export interface PaneSplitIntent {
  kind: "inserted-relative";
  anchorPaneId: string;
  position: PaneSplitIntentPosition;
  source: PaneSplitIntentSource;
  createdAt: number;
}

export interface PaneSplitInfo {
  id: string;
  paneIds: string[];
  sizes: Record<string, number>;
  intent?: Record<string, PaneSplitIntent>;
}

export type PaneActivity =
  | {
      kind: "idle";
      processCount: 0;
      processSummary?: null;
    }
  | {
      kind: "runningProcess";
      processCount: number;
      processSummary?: string | null;
    };

export interface InitialPaneSize {
  cols: number;
  rows: number;
}

export interface GroupInfo {
  id: string;
  name: string;
  nameOverride?: string | null;
  dir: string;
  managedDir: string;
  baseRepo?: string | null;
  baseRef?: string | null;
  parentId?: string | null;
  createdAt: number;
  collapsed: boolean;
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

// Where a queued turn is delivered when it is reached: absent means the agent's
// own composer; "fork" resumes the session into a new forked pane (optionally in a
// fresh worktree); "newSession" starts a fresh session in the same directory.
export type QueuedTurnDelivery =
  | { kind: "fork"; useWorktree?: boolean }
  | { kind: "newSession" };

export interface QueuedTurn {
  text: string;
  pauseAfter: boolean;
  waitFor?: QueuedTurnWait | null;
  delivery?: QueuedTurnDelivery | null;
}

export interface QueuedTurnWait {
  agentId: string;
  paneId?: string | null;
  label?: string | null;
}

export interface WaitTarget {
  agentId: string;
  paneId: string;
  label: string;
  shortcutLabel?: string | null;
  status: AgentInfo["status"];
  queueCount?: number;
  queueBlocked?: boolean;
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
