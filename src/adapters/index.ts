import type { ComponentType, ReactNode } from "react";
import { claudeUiAdapter } from "./claude";
import type { AgentInfo, PaneInfo, Turn, TurnBlock } from "../types";

export type AgentStatus = AgentInfo["status"];

export interface PermissionAction {
  id: string;
  label: string;
  input: string;
}

export interface ComposerPolicy {
  readyStatuses: AgentStatus[];
  queueStatuses: AgentStatus[];
  steerStatuses: AgentStatus[];
  permissionActions: PermissionAction[];
}

export interface LauncherOptionsProps {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export interface AgentUiAdapter {
  id: string;
  label: string;
  LauncherOptions?: ComponentType<LauncherOptionsProps>;
  normalizeTurns?: (turns: Turn[]) => Turn[];
  renderBlock?: (block: TurnBlock, role: string) => ReactNode | null;
  composerPolicy: (agent: AgentInfo) => ComposerPolicy;
  contextRows?: (agent: AgentInfo, pane: PaneInfo) => Array<{ label: string; value: string }>;
}

const adapters = [claudeUiAdapter];

export function getAgentUiAdapter(adapterId: string | null | undefined): AgentUiAdapter {
  return adapters.find((adapter) => adapter.id === adapterId) ?? claudeUiAdapter;
}

export function getDefaultAgentUiAdapter(adapterId?: string | null): AgentUiAdapter {
  return getAgentUiAdapter(adapterId ?? "claude");
}
