export type PaneKind = "shell" | "agent";

export interface RuntimeConfig {
  workspaceRoot: string;
  socketPath: string;
  adapters: AgentAdapterMetadata[];
  // The user's home directory (empty if HOME is unset), used to render
  // home-relative paths as ~/… rather than bare relative segments.
  homeDir: string;
  tabTitleGeneration: TabTitleGenerationRuntimeConfig;
  // Port of the loopback file server, so the UI can recognize token-bearing file-server
  // URLs (see isFileServerUrl) and always sandbox them. Null until the server has bound.
  fileServerPort: number | null;
}

export interface TabTitleGenerationRuntimeConfig {
  appleFoundationModelsAvailable: boolean;
}

export interface AgentAdapterMetadata {
  id: string;
  label: string;
  default: boolean;
  /** Whether the adapter can fork a session — required for research follow-ups. */
  supportsFork: boolean;
}

export interface ClaudeSkill {
  id: string;
  name: string;
  command: string;
}

export interface PaneInfo {
  id: string;
  title: string;
  /** Last sanitized OSC 0/2 title reported by the terminal program. */
  lastOscTitle?: string | null;
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
  scope: "terminal" | "research";
  importedResearchArchiveId?: string | null;
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
  threadId?: string | null;
  branchId?: string | null;
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

export type ShellAgentJobState = "foreground" | "backgrounded" | "stopped";

export interface ShellAgentJobInfo {
  jobId: string;
  agentId: string;
  paneId: string;
  state: ShellAgentJobState;
}

export type ResearchNodeStatus =
  | "queued"
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

/** What produced a node's content: an agent run, or user-authored markdown.
 * The backend omits the field for runs, so absence means "run". */
export type ResearchNodeKind = "run" | "document";

export interface ResearchTree {
  id: string;
  title: string;
  rootNodeId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  lastViewedAt?: number | null;
}

export interface ResearchNode {
  id: string;
  treeId: string;
  parentNodeId?: string | null;
  prompt: string;
  /** Short generated title for breadcrumbs and menus; the document body still
   * shows the full prompt. */
  title?: string | null;
  responsePreview?: string | null;
  adapter: string;
  model?: string | null;
  groupId: string;
  worktreeDir: string;
  nativeSessionId?: string | null;
  transcriptPath?: string | null;
  promptNativeId?: string | null;
  agentId?: string | null;
  paneId?: string | null;
  /** The run agent's thread-graph record id, kept for backend reaping. */
  threadId?: string | null;
  kind?: ResearchNodeKind;
  status: ResearchNodeStatus;
  error?: string | null;
  /** Set when the durable response snapshot lands — the viewer's signal to
   * refetch content it may have read before the adapter finished flushing. */
  responseSnapshotAt?: number | null;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  highlights: ResearchHighlight[];
}

export interface ResearchHighlight {
  id: string;
  anchor: ResearchHighlightAnchor;
  createdAt: number;
}

export interface ResearchHighlightAnchor {
  version: 1;
  projection: "answer-v1";
  responseRevision: string;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

export interface ResearchTreeSummary {
  id: string;
  title: string;
  rootNodeId: string;
  /** The root node's kind — what this sidebar item fundamentally is. */
  kind: ResearchNodeKind;
  workspaceId: string;
  runningCount: number;
  failedCount: number;
  completedCount: number;
  cancelledCount: number;
  updatedAt: number;
  archivedAt?: number | null;
  hasUnseenUpdate: boolean;
  /** A failure settled after the tree was last viewed. Attention flag —
   * viewing the tree acknowledges it — unlike failedCount, a lifetime total. */
  hasUnseenFailure: boolean;
}

export interface ResearchTreeDetail {
  tree: ResearchTree;
  nodes: ResearchNode[];
}

export interface ResearchBranchRemoval {
  treeId: string;
  parentNodeId: string;
  removedNodeIds: string[];
}

export interface ResearchNodeCard {
  id: string;
  prompt: string;
  responsePreview?: string | null;
  status: ResearchNodeStatus;
  createdAt: number;
}

export interface ResearchNodeContent {
  node: ResearchNode;
  turns: Turn[];
  children: ResearchNodeCard[];
  /** Why turns is empty for a finished node (snapshot and transcript both unavailable). */
  sourceError?: string;
  /** Present only when the displayed turns came from a durable full snapshot. */
  responseRevision?: string;
}

export interface UpdateResearchDocumentResult {
  tree: ResearchTree;
  node: ResearchNode;
  responseRevision: string;
  markdownChanged: boolean;
  removedHighlightCount: number;
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
  participant?: ThreadParticipant | null;
  status?: "superseded" | "interrupted" | "uncertain" | null;
  statusReason?: "codexRollback" | "interrupted" | "claudePromptBranch" | "unknownBranch" | null;
  nativeId?: string | null;
  parentNativeId?: string | null;
  nativeMessageId?: string | null;
}

export interface ThreadGraph {
  version: 1;
  threadId: string;
  focusedBranchId: string;
  nextCreatedOrder: number;
  rootTurnIds: string[];
  branches: Record<string, ThreadBranch>;
  nodes: Record<string, ThreadNode>;
}

export interface ThreadBranch {
  id: string;
  threadId: string;
  parentBranchId?: string | null;
  baseTurnId?: string | null;
  createdFromTurnId?: string | null;
  headTurnIds: string[];
  label?: string | null;
  createdByAgentId?: string | null;
  createdByActorId?: string | null;
  createdAt: number;
  status: "active" | "archived";
}

export type ThreadNode = TurnNode | HandoffNode | BranchStartNode;

export interface BaseThreadNode {
  id: string;
  threadId: string;
  branchId: string;
  parentTurnIds: string[];
  participant: ThreadParticipant;
  createdAt: number;
  createdOrder: number;
  status?: "active" | "superseded" | "interrupted" | "uncertain" | null;
  statusReason?: "codexRollback" | "interrupted" | "claudePromptBranch" | "unknownBranch" | null;
}

export interface TurnNode extends BaseThreadNode {
  kind: "turn";
  turn: {
    role: string;
    blocks: TurnBlock[];
    sourceIndex?: number | null;
  };
  native?: NativeTurnRef | null;
}

export interface HandoffNode extends BaseThreadNode {
  kind: "handoff";
  participant: { kind: "qmux"; actorId: "qmux"; label: "qmux" };
  handoff: HandoffPayload;
}

export interface BranchStartNode extends BaseThreadNode {
  kind: "branchStart";
  participant: { kind: "qmux"; actorId: "qmux"; label: "qmux" };
  branchStart: {
    parentBranchId?: string | null;
    baseTurnId?: string | null;
    targetBranchId: string;
  };
}

export interface ThreadParticipant {
  kind: "user" | "assistant" | "qmux";
  actorId: string;
  adapter?: string | null;
  agentId?: string | null;
  label?: string | null;
}

export interface HandoffPayload {
  sourceAgentId: string;
  sourceAdapter: "claude" | "codex";
  sourceBranchId: string;
  sourceTurnId: string;
  targetAgentId: string;
  targetAdapter: "claude" | "codex";
  targetBranchId: string;
  contextPath: string;
}

export interface NativeTurnRef {
  adapter: string;
  agentId: string;
  sessionId?: string | null;
  transcriptPath?: string | null;
  nativeId?: string | null;
  parentNativeId?: string | null;
  nativeMessageId?: string | null;
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

// Where a saved prompt lives: "global" is ~/.qmux/prompts/ (visible from every
// workspace), "project" is <workspaceRoot>/.qmux/prompts/ (this workspace only).
export type PromptScope = "global" | "project";

// A reusable composer message from the prompt library. Backed by a markdown file
// whose filename stem is the name; see PromptScope for where it lives. Prompts
// are titleless in the UI — the name is derived from the content's first line
// and only surfaces as the filename on disk.
export interface SavedPrompt {
  name: string;
  content: string;
  modifiedMs: number;
  scope: PromptScope;
}

export interface PromptLibrary {
  prompts: SavedPrompt[];
  // False when the workspace root is the home directory, making the two scopes
  // one folder — the UI then collapses to a single Global section.
  hasProjectScope: boolean;
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
