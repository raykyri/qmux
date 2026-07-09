import type {
  AgentInfo,
  ThreadBranch,
  ThreadGraph,
  ThreadNode,
  ThreadParticipant,
  Turn,
  TurnNode,
} from "../types";

export function buildSingleAgentThreadGraph(agent: AgentInfo, turns: Turn[]): ThreadGraph {
  const threadId = agent.threadId?.trim() || `thread-${agent.id}`;
  const branchId = agent.branchId?.trim() || `branch-${agent.id}`;
  const nodes: Record<string, ThreadNode> = {};
  const rootTurnIds: string[] = [];
  let previousTurnId: string | null = null;

  turns.forEach((turn, index) => {
    if (!rootTurnIds.length) {
      rootTurnIds.push(turn.id);
    }
    nodes[turn.id] = {
      kind: "turn",
      id: turn.id,
      threadId,
      branchId,
      parentTurnIds: previousTurnId ? [previousTurnId] : [],
      participant: participantForTurn(agent, turn),
      createdAt: agent.createdAt,
      createdOrder: index,
      status: turn.status ?? null,
      statusReason: turn.statusReason ?? null,
      turn: {
        role: turn.role,
        blocks: turn.blocks,
        sourceIndex: turn.sourceIndex,
      },
      native: {
        adapter: agent.adapter,
        agentId: agent.id,
        sessionId: turn.sessionId ?? agent.sessionId ?? null,
        transcriptPath: agent.transcriptPath ?? null,
        nativeId: turn.nativeId ?? null,
        parentNativeId: turn.parentNativeId ?? null,
        nativeMessageId: turn.nativeMessageId ?? null,
        sourceIndex: turn.sourceIndex,
      },
    };
    previousTurnId = turn.id;
  });

  const branch: ThreadBranch = {
    id: branchId,
    threadId,
    parentBranchId: null,
    baseTurnId: null,
    createdFromTurnId: null,
    headTurnIds: previousTurnId ? [previousTurnId] : [],
    label: null,
    createdByAgentId: agent.id,
    createdByActorId: agent.id,
    createdAt: agent.createdAt,
    status: "active",
  };

  return {
    version: 1,
    threadId,
    focusedBranchId: branchId,
    nextCreatedOrder: turns.length,
    rootTurnIds,
    branches: { [branchId]: branch },
    nodes,
  };
}

export function focusedBranchTurns(graph: ThreadGraph, agent: AgentInfo): Turn[] {
  const branchId = agent.branchId?.trim() || graph.focusedBranchId;
  const branchSelection = focusedBranchSelection(graph, branchId);
  return Object.values(graph.nodes)
    .filter(
      (node): node is TurnNode =>
        node.kind === "turn" && nodeMatchesBranchSelection(node, branchSelection),
    )
    .sort(compareThreadNodes)
    .map((node) => ({
      id: node.id,
      agentId: node.native?.agentId ?? node.participant.agentId ?? agent.id,
      sessionId: node.native?.sessionId ?? agent.sessionId ?? null,
      role: node.turn.role,
      blocks: node.turn.blocks,
      sourceIndex: node.turn.sourceIndex ?? node.native?.sourceIndex ?? 0,
      participant: node.participant,
      status: node.status === "active" ? null : node.status,
      statusReason: node.statusReason ?? null,
      nativeId: node.native?.nativeId ?? null,
      parentNativeId: node.native?.parentNativeId ?? null,
      nativeMessageId: node.native?.nativeMessageId ?? null,
    }));
}

export function focusedBranchGraphNodes(graph: ThreadGraph): ThreadNode[] {
  const branchSelection = focusedBranchSelection(graph, graph.focusedBranchId);
  return Object.values(graph.nodes)
    .filter((node) => nodeMatchesBranchSelection(node, branchSelection))
    .sort(compareThreadNodes);
}

function focusedBranchSelection(graph: ThreadGraph, branchId: string) {
  const selection = new Map<string, number | null>();
  let currentBranchId: string | null = branchId;
  let maxCreatedOrder: number | null = null;
  const visited = new Set<string>();

  while (currentBranchId && !visited.has(currentBranchId)) {
    visited.add(currentBranchId);
    selection.set(currentBranchId, maxCreatedOrder);
    const branch: ThreadBranch | undefined = graph.branches[currentBranchId];
    if (!branch) {
      break;
    }
    const baseTurnId = branch.baseTurnId ?? branch.createdFromTurnId ?? null;
    maxCreatedOrder =
      baseTurnId && graph.nodes[baseTurnId] ? graph.nodes[baseTurnId].createdOrder : null;
    currentBranchId = branch.parentBranchId ?? null;
  }

  return selection;
}

function nodeMatchesBranchSelection(node: ThreadNode, selection: Map<string, number | null>) {
  if (!selection.has(node.branchId)) {
    return false;
  }
  const maxCreatedOrder = selection.get(node.branchId);
  return maxCreatedOrder == null || node.createdOrder <= maxCreatedOrder;
}

function compareThreadNodes(left: ThreadNode, right: ThreadNode) {
  return left.createdOrder - right.createdOrder || left.id.localeCompare(right.id);
}

function participantForTurn(agent: AgentInfo, turn: Turn): ThreadParticipant {
  if (turn.role === "user") {
    return {
      kind: "user",
      actorId: "local-user",
      label: "You",
    };
  }
  return {
    kind: "assistant",
    actorId: agent.id,
    adapter: agent.adapter,
    agentId: agent.id,
    label: adapterLabel(agent.adapter),
  };
}

function adapterLabel(adapter: string) {
  switch (adapter) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "grok":
      return "Grok";
    default:
      return "Agent";
  }
}
