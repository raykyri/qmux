import type { AgentInfo, PaneInfo, Turn } from "../types";
import type {
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
} from "../types";
import {
  PUBLICATION_INDEX_FILE,
  PUBLICATION_README_FILE,
  PUBLICATION_SCHEMA_VERSION,
  PUBLICATION_TRANSCRIPT_FILE,
  generatePublicNodeId,
  generatePublicationId,
  normalizePublicationTitle,
  publicationJson,
  sha256Hex,
  validatePublicationFiles,
  validatePublication,
  withPublicationContentHash,
  type PublicationDraft,
  type PublishedResearchNode,
  type ResearchPublication,
  type TranscriptPublication,
} from "./publication";
import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  formatPlainTextTranscript,
  plainTextTranscriptMessages,
  timelineItemsAfterLastToolCall,
} from "./turnTimeline";

interface TranscriptPublicationInput {
  title: string;
  pane: PaneInfo;
  agent: AgentInfo;
  turns: Turn[];
  assistantLabel: string;
  publicationId?: string;
  createdAt?: string;
}

export async function createTranscriptPublicationDraft(
  input: TranscriptPublicationInput,
): Promise<PublicationDraft> {
  const title = normalizePublicationTitle(input.title, "Published transcript");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const publicationId = input.publicationId ?? generatePublicationId();
  const messages = plainTextTranscriptMessages(input.turns, input.assistantLabel);
  if (messages.length === 0) {
    throw new Error("This transcript has no publishable user or assistant messages.");
  }
  const publication = await withPublicationContentHash<Omit<TranscriptPublication, "contentHash">>({
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    publicationId,
    kind: "transcript",
    title,
    createdAt,
    updatedAt: createdAt,
    transcript: {
      textFile: PUBLICATION_TRANSCRIPT_FILE,
      messages,
    },
  });
  validatePublication(publication);
  const plainText = formatPlainTextTranscript(input.turns, input.assistantLabel);
  const files = {
    [PUBLICATION_README_FILE]: transcriptReadme(title, messages),
    [PUBLICATION_INDEX_FILE]: publicationJson(publication),
    [PUBLICATION_TRANSCRIPT_FILE]: `${plainText}\n`,
  };
  validatePublicationFiles(files);
  return {
    publication,
    files,
    source: {
      kind: "transcript",
      paneId: input.pane.id,
      agentId: input.agent.id,
      sessionId: input.agent.sessionId ?? null,
    },
    publicNodeIds: {},
    previewText: plainText,
  };
}

interface ResearchPublicationInput {
  title: string;
  detail: ResearchTreeDetail;
  selectedNodeId: string;
  mode: "answer" | "tree";
  contents: ResearchNodeContent[];
  publicationId?: string;
  createdAt?: string;
}

const TERMINAL_RESEARCH_STATUSES = new Set(["complete", "failed", "cancelled"]);

export async function createResearchPublicationDraft(
  input: ResearchPublicationInput,
): Promise<PublicationDraft> {
  const title = normalizePublicationTitle(input.title, "Published research");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const publicationId = input.publicationId ?? generatePublicationId();
  const contentByNodeId = new Map(input.contents.map((content) => [content.node.id, content]));
  const selected = input.detail.nodes.find((node) => node.id === input.selectedNodeId);
  if (!selected) {
    throw new Error("The selected research result is no longer available.");
  }
  const candidates =
    input.mode === "answer"
      ? [selected]
      : input.detail.nodes.filter((node) => TERMINAL_RESEARCH_STATUSES.has(node.status));
  if (candidates.length === 0) {
    throw new Error("This research has no completed results to publish.");
  }
  if (input.mode === "tree" && !candidates.some((node) => node.id === input.detail.tree.rootNodeId)) {
    throw new Error("The root research result must finish before publishing the tree.");
  }
  for (const node of candidates) {
    if (!TERMINAL_RESEARCH_STATUSES.has(node.status)) {
      throw new Error("The selected research result must finish before it can be published.");
    }
    if (!contentByNodeId.has(node.id)) {
      throw new Error(`The response for "${researchNodeTitle(node, input.detail)}" is unavailable.`);
    }
    const contentNode = contentByNodeId.get(node.id)!.node;
    if (!researchNodeSnapshotMatches(node, contentNode)) {
      throw new Error(
        `Research changed while preparing "${researchNodeTitle(node, input.detail)}". Review the latest result and publish again.`,
      );
    }
  }

  const publicNodeIds = Object.fromEntries(
    candidates.map((node) => [node.id, generatePublicNodeId()]),
  );
  const publicNodes: PublishedResearchNode[] = [];
  const answerFiles: Record<string, string> = {};
  for (const node of candidates) {
    const content = contentByNodeId.get(node.id)!;
    const publicNodeId = publicNodeIds[node.id];
    const answer = researchAnswerMarkdown(content);
    if (node.status === "complete" && !answer.trim()) {
      throw new Error(`The response for "${researchNodeTitle(node, input.detail)}" is empty.`);
    }
    const answerFile = `${publicNodeId}.md`;
    const fileContent = researchNodeMarkdown(input.detail, node, answer);
    answerFiles[answerFile] = fileContent;
    publicNodes.push({
      id: publicNodeId,
      parentId:
        input.mode === "tree" && node.parentNodeId
          ? publicNodeIds[node.parentNodeId] ?? null
          : null,
      kind: node.kind ?? "run",
      title: researchNodeTitle(node, input.detail),
      prompt: node.prompt,
      answerFile,
      contentHash: await sha256Hex(fileContent),
      responseRevision: content.responseRevision ?? null,
      status: node.status as "complete" | "failed" | "cancelled",
      createdAt: node.createdAt,
    });
  }

  const rootNodeId =
    input.mode === "answer"
      ? publicNodeIds[selected.id]
      : publicNodeIds[input.detail.tree.rootNodeId];
  const selectedNodeId = publicNodeIds[selected.id] ?? rootNodeId;
  const publication = await withPublicationContentHash<Omit<ResearchPublication, "contentHash">>({
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    publicationId,
    kind: input.mode === "answer" ? "research-answer" : "research-tree",
    title,
    createdAt,
    updatedAt: createdAt,
    research: {
      rootNodeId,
      selectedNodeId,
      nodes: publicNodes,
    },
  });
  validatePublication(publication);
  const readme = researchReadme(title, publication.research.nodes, rootNodeId);
  const files = {
    [PUBLICATION_README_FILE]: readme,
    [PUBLICATION_INDEX_FILE]: publicationJson(publication),
    ...answerFiles,
  };
  validatePublicationFiles(files);
  return {
    publication,
    files,
    source:
      input.mode === "answer"
        ? {
            kind: "researchAnswer",
            treeId: input.detail.tree.id,
            nodeId: selected.id,
          }
        : {
            kind: "researchTree",
            treeId: input.detail.tree.id,
          },
    publicNodeIds,
    previewText:
      input.mode === "answer"
        ? researchNodeMarkdown(
            input.detail,
            selected,
            researchAnswerMarkdown(contentByNodeId.get(selected.id)!),
          )
        : readme,
  };
}

function transcriptReadme(
  title: string,
  messages: ReturnType<typeof plainTextTranscriptMessages>,
) {
  const body = messages
    .map((message) => `## ${markdownHeading(message.label)}\n\n${message.text.trim()}`)
    .join("\n\n");
  return `# ${markdownHeading(title)}\n\n${body}\n\n---\n\nPublished with [qmux](https://qmux.app).\n`;
}

function markdownHeading(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function researchAnswerMarkdown(content: ResearchNodeContent) {
  return assistantTextFromTimelineItems(
    timelineItemsAfterLastToolCall(buildTimelineItems(content.turns)),
  ).trim();
}

function researchNodeTitle(node: ResearchNode, detail: ResearchTreeDetail) {
  if (node.id === detail.tree.rootNodeId) {
    return normalizePublicationTitle(node.title ?? detail.tree.title, detail.tree.title);
  }
  const promptLine = node.prompt
    .split(/\r?\n/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return normalizePublicationTitle(node.title ?? promptLine ?? "", "Research follow-up");
}

function researchNodeMarkdown(detail: ResearchTreeDetail, node: ResearchNode, answer: string) {
  const title = researchNodeTitle(node, detail);
  const prompt =
    (node.kind ?? "run") === "document" || !node.prompt.trim()
      ? ""
      : `## Question\n\n${node.prompt.trim()}\n\n`;
  const response =
    answer ||
    (node.status === "failed"
      ? node.error?.trim() || "This research run failed without a response."
      : node.status === "cancelled"
        ? "This research run was cancelled without a response."
        : "No response is available.");
  return `# ${markdownHeading(title)}\n\n${prompt}## Answer\n\n${response}\n`;
}

function researchReadme(
  title: string,
  nodes: ResearchPublication["research"]["nodes"],
  rootNodeId: string,
) {
  const children = new Map<string | null, typeof nodes>();
  for (const node of nodes) {
    const parent = node.parentId ?? null;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const lines: string[] = [`# ${markdownHeading(title)}`, ""];
  const append = (nodeId: string, depth: number) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }
    const status = node.status === "complete" ? "" : ` · ${node.status}`;
    lines.push(`${"  ".repeat(depth)}- [${markdownLinkLabel(node.title)}](${node.answerFile})${status}`);
    for (const child of children.get(node.id) ?? []) {
      append(child.id, depth + 1);
    }
  };
  append(rootNodeId, 0);
  lines.push("", "---", "", "Published with [qmux](https://qmux.app).", "");
  return lines.join("\n");
}

function markdownLinkLabel(value: string) {
  return markdownHeading(value).replace(/([\\[\]])/g, "\\$1");
}

export function researchNodeSnapshotMatches(expected: ResearchNode, actual: ResearchNode) {
  return (
    expected.id === actual.id &&
    expected.treeId === actual.treeId &&
    (expected.parentNodeId ?? null) === (actual.parentNodeId ?? null) &&
    (expected.kind ?? "run") === (actual.kind ?? "run") &&
    expected.prompt === actual.prompt &&
    (expected.title ?? null) === (actual.title ?? null) &&
    expected.status === actual.status &&
    (expected.responseSnapshotAt ?? null) === (actual.responseSnapshotAt ?? null) &&
    expected.createdAt === actual.createdAt
  );
}
