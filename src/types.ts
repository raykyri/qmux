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
}

export interface SpawnClaudeRequest {
  prompt: string;
  cwd?: string | null;
  model?: string | null;
  permissionMode?: string | null;
}

export interface QmuxEvent {
  type: string;
  paneId?: string | null;
  agentId?: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
}
