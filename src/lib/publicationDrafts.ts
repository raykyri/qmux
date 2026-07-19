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
  updatedAt?: string;
}

export async function createTranscriptPublicationDraft(
  input: TranscriptPublicationInput,
): Promise<PublicationDraft> {
  const title = normalizePublicationTitle(input.title, "Published transcript");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;
  const publicationId = input.publicationId ?? generatePublicationId();
  // Timeline keys embed the originating turn id, which carries the internal
  // agent id (and with it the agent's creation timestamp) — local identifiers
  // this feature elsewhere deliberately keeps out of published files (research
  // nodes mint public ids for exactly that reason). Published message ids are
  // only ever used as list keys on the public page, so replace them with
  // ordinals before anything leaves the machine.
  const messages = plainTextTranscriptMessages(input.turns, input.assistantLabel).map(
    (message, index) => ({ ...message, id: `m-${index + 1}` }),
  );
  if (messages.length === 0) {
    throw new Error("This transcript has no publishable user or assistant messages.");
  }
  const publication = await withPublicationContentHash<Omit<TranscriptPublication, "contentHash">>({
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    publicationId,
    kind: "transcript",
    title,
    createdAt,
    updatedAt,
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
  updatedAt?: string;
  publicNodeIds?: Record<string, string>;
  contributionsByNodeId?: Record<
    string,
    { githubLogin: string; proposalCommentId: number }
  >;
}

const TERMINAL_RESEARCH_STATUSES = new Set(["complete", "failed", "cancelled"]);

export async function createResearchPublicationDraft(
  input: ResearchPublicationInput,
): Promise<PublicationDraft> {
  const title = normalizePublicationTitle(input.title, "Published research");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;
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
    candidates.map((node) => [
      node.id,
      input.publicNodeIds?.[node.id] ?? generatePublicNodeId(),
    ]),
  );
  if (new Set(Object.values(publicNodeIds)).size !== candidates.length) {
    throw new Error("The saved publication contains duplicate public research node IDs.");
  }
  const publicNodes: PublishedResearchNode[] = [];
  const answerFiles: Record<string, string> = {};
  for (const node of candidates) {
    const content = contentByNodeId.get(node.id)!;
    const publicNodeId = publicNodeIds[node.id];
    // A conversation node (a terminal export) has no single answer — its whole
    // multi-turn transcript is the body. Runs and documents keep their Q/A
    // shape: just the assistant's answer after the last tool call.
    const answer =
      (node.kind ?? "run") === "conversation"
        ? conversationBodyMarkdown(content)
        : researchAnswerMarkdown(content);
    if (node.status === "complete" && !answer.trim()) {
      throw new Error(`The response for "${researchNodeTitle(node, input.detail)}" is empty.`);
    }
    const answerFile = `${publicNodeId}.md`;
    const contribution = input.contributionsByNodeId?.[node.id] ?? null;
    const fileContent = researchNodeMarkdown(input.detail, node, answer, contribution);
    answerFiles[answerFile] = fileContent;
    const publishedParentId =
      input.mode === "tree" && node.parentNodeId
        ? publicNodeIds[node.parentNodeId] ?? null
        : null;
    // A targeted follow-up's anchor only means something on its parent's
    // published page, and only against the exact response revision the anchor
    // was captured on — otherwise the public page could paint a stale or
    // unrelated passage.
    const parentContent = node.parentNodeId
      ? contentByNodeId.get(node.parentNodeId)
      : undefined;
    const queryAnchor =
      publishedParentId &&
      node.queryAnchor &&
      parentContent?.responseRevision &&
      node.queryAnchor.responseRevision === parentContent.responseRevision &&
      node.queryAnchor.exact.length > 0 &&
      node.queryAnchor.exact.length <= 10_000 &&
      node.queryAnchor.prefix.length <= 500 &&
      node.queryAnchor.suffix.length <= 500
        ? {
            start: node.queryAnchor.start,
            end: node.queryAnchor.end,
            exact: node.queryAnchor.exact,
            prefix: node.queryAnchor.prefix,
            suffix: node.queryAnchor.suffix,
          }
        : null;
    publicNodes.push({
      id: publicNodeId,
      parentId: publishedParentId,
      kind:
        node.kind === "document"
          ? "document"
          : node.kind === "conversation"
            ? "conversation"
            : "run",
      title: researchNodeTitle(node, input.detail),
      // A conversation's opening turn already leads its published body, so it
      // carries no separate prompt — the public page renders the transcript
      // whole rather than a prompt card above an answer.
      prompt: (node.kind ?? "run") === "conversation" ? "" : node.prompt,
      answerFile,
      contentHash: await sha256Hex(fileContent),
      responseRevision: content.responseRevision ?? null,
      status: node.status as "complete" | "failed" | "cancelled",
      createdAt: node.createdAt,
      ...(typeof node.startedAt === "number" ? { startedAt: node.startedAt } : {}),
      ...(typeof node.completedAt === "number" ? { completedAt: node.completedAt } : {}),
      ...(queryAnchor ? { queryAnchor } : {}),
      ...(contribution ? { contribution } : {}),
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
    updatedAt,
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

function researchNodeMarkdown(
  detail: ResearchTreeDetail,
  node: ResearchNode,
  answer: string,
  contribution?: { githubLogin: string; proposalCommentId: number } | null,
) {
  const title = researchNodeTitle(node, detail);
  const credit = contribution
    ? `> Proposed by [@${contribution.githubLogin}](https://github.com/${contribution.githubLogin}) in Gist comment ${contribution.proposalCommentId}.\n\n`
    : "";
  // A conversation is published as the transcript itself: the body already
  // carries the interleaved turns, so there is no Question/Answer split to
  // impose over it. The public page reads everything after the title line
  // (answerBodyMarkdown's fallback), so no "## Answer" header is emitted.
  if ((node.kind ?? "run") === "conversation") {
    const body = answer.trim() || "This conversation has no readable messages.";
    return `# ${markdownHeading(title)}\n\n${credit}${body}\n`;
  }
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
  return `# ${markdownHeading(title)}\n\n${credit}${prompt}## Answer\n\n${response}\n`;
}

// The published body for a conversation node: every user/assistant turn in
// order, each under a bold speaker label, matching the app's exported-
// conversation reading view. Tool activity and empty turns are dropped, the
// same projection plainTextTranscriptMessages produces for transcript
// publications — so published query anchors resolve against identical text.
const CONVERSATION_ASSISTANT_LABEL = "Assistant";

function conversationBodyMarkdown(content: ResearchNodeContent) {
  return plainTextTranscriptMessages(content.turns, CONVERSATION_ASSISTANT_LABEL)
    .map((message) => `**${markdownHeading(message.label)}**\n\n${message.text.trim()}`)
    .join("\n\n")
    .trim();
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
    const credit = node.contribution ? ` · proposed by @${node.contribution.githubLogin}` : "";
    lines.push(`${"  ".repeat(depth)}- [${markdownLinkLabel(node.title)}](${node.answerFile})${status}${credit}`);
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
