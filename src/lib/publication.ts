export const PUBLICATION_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_INDEX_FILE = "publication.json";
export const PUBLICATION_README_FILE = "README.md";
export const PUBLICATION_TRANSCRIPT_FILE = "transcript.txt";
export const MAX_PUBLICATION_FILE_BYTES = 10_000_000;
export const MAX_PUBLICATION_TOTAL_BYTES = 12_000_000;
export const MAX_PUBLICATION_FILES = 250;

const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PUBLIC_NODE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PUBLICATION_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type PublicationKind = "transcript" | "research-answer" | "research-tree";

export interface PublishedTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  label: string;
  text: string;
}

/** The passage of the parent's published answer a targeted follow-up was
 * asked about. A trimmed copy of the in-app ResearchHighlightAnchor: offsets
 * plus quote context against the parent's rendered-text projection, included
 * only when the parent ships in the same publication with a matching response
 * revision, so the public page can paint the passage and anchor the card. */
export interface PublishedResearchAnchor {
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

/** One speaker turn of a published conversation node, so the public page can
 * render the transcript as labelled per-turn bubbles instead of one flat
 * markdown blob. Present only on `kind: "conversation"` nodes; the answer file
 * still carries the same turns as markdown for hashing, copy, and word count. */
export interface PublishedConversationTurn {
  role: "user" | "assistant";
  label: string;
  text: string;
}

export interface PublishedResearchNode {
  id: string;
  parentId: string | null;
  kind: "run" | "document" | "conversation";
  title: string;
  prompt: string;
  answerFile: string;
  /** Per-turn transcript for conversation nodes; absent for runs/documents. */
  conversation?: PublishedConversationTurn[] | null;
  contentHash: string;
  responseRevision: string | null;
  status: "complete" | "failed" | "cancelled";
  createdAt: number;
  /** Run timing, when the source node recorded it; lets the public page show
   * the app's "ran for" duration in the answer meta line. */
  startedAt?: number | null;
  completedAt?: number | null;
  queryAnchor?: PublishedResearchAnchor | null;
  contribution?: {
    githubLogin: string;
    proposalCommentId: number;
  } | null;
}

interface PublicationBase {
  schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  publicationId: string;
  kind: PublicationKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

export interface TranscriptPublication extends PublicationBase {
  kind: "transcript";
  transcript: {
    textFile: typeof PUBLICATION_TRANSCRIPT_FILE;
    messages: PublishedTranscriptMessage[];
  };
}

export interface ResearchPublication extends PublicationBase {
  kind: "research-answer" | "research-tree";
  research: {
    rootNodeId: string;
    selectedNodeId: string | null;
    nodes: PublishedResearchNode[];
  };
}

export type Publication = TranscriptPublication | ResearchPublication;
export type PublicationWithoutHash =
  | Omit<TranscriptPublication, "contentHash">
  | Omit<ResearchPublication, "contentHash">;

export type PublicationSource =
  | {
      kind: "transcript";
      paneId: string;
      agentId?: string | null;
      sessionId?: string | null;
    }
  | {
      kind: "researchAnswer";
      treeId: string;
      nodeId: string;
    }
  | {
      kind: "researchTree";
      treeId: string;
    };

export interface PublicationDraft {
  publication: Publication;
  files: Record<string, string>;
  source: PublicationSource;
  publicNodeIds: Record<string, string>;
  previewText: string;
}

export interface PublicationBinding {
  publicationId: string;
  gistId: string;
  gistUrl: string;
  shareUrl: string;
  ownerLogin?: string | null;
  revision?: string | null;
  isPublic: boolean;
  source: PublicationSource;
  publicNodeIds: Record<string, string>;
  proposalStates: Record<string, PublicationProposalState>;
  publicationCreatedAt?: string | null;
  warning?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicationProposalState {
  proposalCommentId: number;
  status: "accepted" | "declined";
  authorLogin: string;
  parentPublicNodeId: string;
  prompt: string;
  answerMarkdown?: string | null;
  localNodeId?: string | null;
  resolutionCommentId?: number | null;
  publishedPublicNodeId?: string | null;
}

export interface PublicationProposal {
  commentId: number;
  authorLogin: string;
  authorUrl: string;
  parentPublicNodeId: string;
  parentNodeId?: string | null;
  prompt: string;
  answerMarkdown?: string | null;
  /** The quoted passage an anchored proposal was asked about, in the shared
   * proposal-anchor shape from publicationComments. */
  anchor?: {
    start: number;
    end: number;
    exact: string;
    prefix: string;
    suffix: string;
  } | null;
  createdAt: string;
  status: "pending" | "accepted" | "declined";
  localNodeId?: string | null;
}

export interface PublishingAuthStatus {
  configured: boolean;
  connected: boolean;
  login?: string | null;
  expiresAt?: number | null;
}

export interface PublishingDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
}

export type PublishingAuthPollResult =
  | { status: "pending"; intervalSeconds: number }
  | { status: "connected"; account: PublishingAuthStatus };

export interface PublishPublicationRequest {
  publicationId: string;
  title: string;
  isPublic: boolean;
  files: Record<string, string>;
  source: PublicationSource;
  publicNodeIds: Record<string, string>;
}

export interface SyncPublicationRequest {
  publicationId: string;
  title: string;
  isPublic: boolean;
  files: Record<string, string>;
  source: PublicationSource;
  publicNodeIds: Record<string, string>;
}

export function generatePublicationId(prefix = "pub") {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random.replace(/-/g, "")}`;
}

export function generatePublicNodeId() {
  return generatePublicationId("node");
}

export function normalizePublicationTitle(value: string, fallback = "Untitled publication") {
  const normalized = value.replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, 240);
}

export function publicationHashInput(publication: PublicationWithoutHash | Publication) {
  const value = { ...publication } as Record<string, unknown>;
  delete value.contentHash;
  return canonicalJson(value);
}

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function withPublicationContentHash<T extends PublicationWithoutHash>(
  publication: T,
): Promise<T & { contentHash: string }> {
  return {
    ...publication,
    contentHash: await sha256Hex(publicationHashInput(publication)),
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function publicationJson(publication: Publication) {
  return `${JSON.stringify(publication, null, 2)}\n`;
}

export function parsePublicationJson(raw: string): Publication {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("publication.json is not valid JSON");
  }
  return validatePublication(value);
}

export function validatePublication(value: unknown): Publication {
  const root = objectValue(value, "publication");
  if (root.schemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    throw new Error(`unsupported publication schema version ${String(root.schemaVersion)}`);
  }
  const publicationId = boundedString(root.publicationId, "publicationId", 128);
  if (!PUBLICATION_ID_PATTERN.test(publicationId)) {
    throw new Error("publicationId has an invalid format");
  }
  const kind = root.kind;
  if (kind !== "transcript" && kind !== "research-answer" && kind !== "research-tree") {
    throw new Error("publication kind is unsupported");
  }
  const title = boundedString(root.title, "title", 240);
  const createdAt = isoDateString(root.createdAt, "createdAt");
  const updatedAt = isoDateString(root.updatedAt, "updatedAt");
  const contentHash = boundedString(root.contentHash, "contentHash", 64);
  if (!SHA256_PATTERN.test(contentHash)) {
    throw new Error("contentHash must be a lowercase SHA-256 digest");
  }

  const base = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    publicationId,
    kind,
    title,
    createdAt,
    updatedAt,
    contentHash,
  };
  if (kind === "transcript") {
    const transcript = objectValue(root.transcript, "transcript");
    if (transcript.textFile !== PUBLICATION_TRANSCRIPT_FILE) {
      throw new Error(`transcript.textFile must be ${PUBLICATION_TRANSCRIPT_FILE}`);
    }
    if (!Array.isArray(transcript.messages) || transcript.messages.length > 10_000) {
      throw new Error("transcript.messages must be an array with at most 10,000 entries");
    }
    const messages: PublishedTranscriptMessage[] = transcript.messages.map((message, index) => {
      const item = objectValue(message, `transcript.messages[${index}]`);
      const role = item.role;
      if (role !== "user" && role !== "assistant") {
        throw new Error(`transcript.messages[${index}].role is invalid`);
      }
      return {
        id: boundedString(item.id, `transcript.messages[${index}].id`, 256),
        role,
        label: boundedString(item.label, `transcript.messages[${index}].label`, 120),
        text: boundedString(
          item.text,
          `transcript.messages[${index}].text`,
          MAX_PUBLICATION_FILE_BYTES,
        ),
      };
    });
    return {
      ...base,
      kind,
      transcript: {
        textFile: PUBLICATION_TRANSCRIPT_FILE,
        messages,
      },
    };
  }

  const research = objectValue(root.research, "research");
  const rootNodeId = publicNodeId(research.rootNodeId, "research.rootNodeId");
  const selectedNodeId =
    research.selectedNodeId === null || research.selectedNodeId === undefined
      ? null
      : publicNodeId(research.selectedNodeId, "research.selectedNodeId");
  if (!Array.isArray(research.nodes) || research.nodes.length === 0) {
    throw new Error("research.nodes must contain at least one node");
  }
  if (research.nodes.length > MAX_PUBLICATION_FILES - 2) {
    throw new Error("research publication contains too many nodes");
  }
  const nodes: PublishedResearchNode[] = research.nodes.map((node, index) => {
    const item = objectValue(node, `research.nodes[${index}]`);
    const nodeKind = item.kind;
    if (nodeKind !== "run" && nodeKind !== "document" && nodeKind !== "conversation") {
      throw new Error(`research.nodes[${index}].kind is invalid`);
    }
    const status = item.status;
    if (status !== "complete" && status !== "failed" && status !== "cancelled") {
      throw new Error(`research.nodes[${index}].status is invalid`);
    }
    const answerFile = publicationFilename(item.answerFile, `research.nodes[${index}].answerFile`);
    const contentHash = boundedString(
      item.contentHash,
      `research.nodes[${index}].contentHash`,
      64,
    );
    if (!SHA256_PATTERN.test(contentHash)) {
      throw new Error(`research.nodes[${index}].contentHash is invalid`);
    }
    const responseRevision =
      item.responseRevision === null || item.responseRevision === undefined
        ? null
        : boundedString(
            item.responseRevision,
            `research.nodes[${index}].responseRevision`,
            64,
          );
    if (responseRevision && !SHA256_PATTERN.test(responseRevision)) {
      throw new Error(`research.nodes[${index}].responseRevision is invalid`);
    }
    const contribution =
      item.contribution === null || item.contribution === undefined
        ? null
        : publishedContribution(
            item.contribution,
            `research.nodes[${index}].contribution`,
          );
    const queryAnchor =
      item.queryAnchor === null || item.queryAnchor === undefined
        ? null
        : publishedAnchor(item.queryAnchor, `research.nodes[${index}].queryAnchor`);
    const conversation =
      item.conversation === null || item.conversation === undefined
        ? null
        : publishedConversation(
            item.conversation,
            nodeKind,
            `research.nodes[${index}].conversation`,
          );
    return {
      id: publicNodeId(item.id, `research.nodes[${index}].id`),
      parentId:
        item.parentId === null || item.parentId === undefined
          ? null
          : publicNodeId(item.parentId, `research.nodes[${index}].parentId`),
      kind: nodeKind,
      title: boundedString(item.title, `research.nodes[${index}].title`, 240),
      prompt: boundedStringAllowEmpty(
        item.prompt,
        `research.nodes[${index}].prompt`,
        MAX_PUBLICATION_FILE_BYTES,
      ),
      answerFile,
      contentHash,
      responseRevision,
      status,
      createdAt: finiteNumber(item.createdAt, `research.nodes[${index}].createdAt`),
      ...(item.startedAt === null || item.startedAt === undefined
        ? {}
        : { startedAt: finiteNumber(item.startedAt, `research.nodes[${index}].startedAt`) }),
      ...(item.completedAt === null || item.completedAt === undefined
        ? {}
        : {
            completedAt: finiteNumber(
              item.completedAt,
              `research.nodes[${index}].completedAt`,
            ),
          }),
      ...(queryAnchor ? { queryAnchor } : {}),
      ...(contribution ? { contribution } : {}),
      ...(conversation ? { conversation } : {}),
    };
  });
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length || !ids.has(rootNodeId)) {
    throw new Error("research publication has duplicate nodes or an unknown root");
  }
  if (selectedNodeId && !ids.has(selectedNodeId)) {
    throw new Error("research.selectedNodeId does not name a published node");
  }
  for (const node of nodes) {
    if (node.parentId && !ids.has(node.parentId)) {
      throw new Error(`research node ${node.id} has an unknown parent`);
    }
  }
  assertAcyclicResearchNodes(nodes);
  assertConnectedResearchNodes(nodes, rootNodeId);
  return {
    ...base,
    kind,
    research: {
      rootNodeId,
      selectedNodeId,
      nodes,
    },
  };
}

function publishedAnchor(value: unknown, label: string): PublishedResearchAnchor {
  const item = objectValue(value, label);
  const start = finiteNumber(item.start, `${label}.start`);
  const end = finiteNumber(item.end, `${label}.end`);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new Error(`${label} offsets are invalid`);
  }
  const exact = boundedString(item.exact, `${label}.exact`, 10_000);
  const prefix = boundedStringAllowEmpty(item.prefix, `${label}.prefix`, 500);
  const suffix = boundedStringAllowEmpty(item.suffix, `${label}.suffix`, 500);
  return { start, end, exact, prefix, suffix };
}

function publishedConversation(
  value: unknown,
  nodeKind: unknown,
  label: string,
): PublishedConversationTurn[] {
  if (nodeKind !== "conversation") {
    throw new Error(`${label} is only allowed on conversation nodes`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((turn, index) => {
    const item = objectValue(turn, `${label}[${index}]`);
    const role = item.role;
    if (role !== "user" && role !== "assistant") {
      throw new Error(`${label}[${index}].role is invalid`);
    }
    return {
      role,
      label: boundedString(item.label, `${label}[${index}].label`, 240),
      text: boundedString(item.text, `${label}[${index}].text`, MAX_PUBLICATION_FILE_BYTES),
    };
  });
}

function publishedContribution(value: unknown, label: string) {
  const item = objectValue(value, label);
  const githubLogin = boundedString(item.githubLogin, `${label}.githubLogin`, 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(githubLogin)) {
    throw new Error(`${label}.githubLogin is invalid`);
  }
  const proposalCommentId = item.proposalCommentId;
  if (
    typeof proposalCommentId !== "number" ||
    !Number.isSafeInteger(proposalCommentId) ||
    proposalCommentId <= 0
  ) {
    throw new Error(`${label}.proposalCommentId is invalid`);
  }
  return { githubLogin, proposalCommentId };
}

export function validatePublicationFiles(files: Record<string, string>) {
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_PUBLICATION_FILES) {
    throw new Error(`a publication must contain between 1 and ${MAX_PUBLICATION_FILES} files`);
  }
  if (!(PUBLICATION_INDEX_FILE in files) || !(PUBLICATION_README_FILE in files)) {
    throw new Error(`a publication must contain ${PUBLICATION_INDEX_FILE} and ${PUBLICATION_README_FILE}`);
  }
  let total = 0;
  for (const [name, content] of entries) {
    publicationFilename(name, "publication filename");
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > MAX_PUBLICATION_FILE_BYTES) {
      throw new Error(`${name} exceeds the ${MAX_PUBLICATION_FILE_BYTES.toLocaleString()} byte limit`);
    }
    total += bytes;
  }
  if (total > MAX_PUBLICATION_TOTAL_BYTES) {
    throw new Error(
      `publication exceeds the ${MAX_PUBLICATION_TOTAL_BYTES.toLocaleString()} byte total limit`,
    );
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function boundedStringAllowEmpty(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${label} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function isoDateString(value: unknown, label: string) {
  const string = boundedString(value, label, 64);
  if (Number.isNaN(Date.parse(string))) {
    throw new Error(`${label} must be an ISO date`);
  }
  return string;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function publicNodeId(value: unknown, label: string) {
  const id = boundedString(value, label, 128);
  if (!PUBLIC_NODE_ID_PATTERN.test(id)) {
    throw new Error(`${label} has an invalid format`);
  }
  return id;
}

function publicationFilename(value: unknown, label: string) {
  const name = boundedString(value, label, 120);
  if (!PUBLICATION_FILENAME_PATTERN.test(name)) {
    throw new Error(`${label} has an invalid format`);
  }
  return name;
}

function assertAcyclicResearchNodes(nodes: PublishedResearchNode[]) {
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
  for (const node of nodes) {
    const seen = new Set<string>();
    let current: string | null = node.id;
    while (current) {
      if (seen.has(current)) {
        throw new Error("research publication contains a parent cycle");
      }
      seen.add(current);
      current = parentById.get(current) ?? null;
    }
  }
}

function assertConnectedResearchNodes(
  nodes: PublishedResearchNode[],
  rootNodeId: string,
) {
  const root = nodes.find((node) => node.id === rootNodeId);
  if (!root || root.parentId !== null) {
    throw new Error("research root must have a null parent");
  }
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.id !== rootNodeId && node.parentId === null) {
      throw new Error(`research node ${node.id} is disconnected from the root`);
    }
    if (node.parentId) {
      const children = childrenByParent.get(node.parentId) ?? [];
      children.push(node.id);
      childrenByParent.set(node.parentId, children);
    }
  }
  const reachable = new Set<string>();
  const pending = [rootNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    pending.push(...(childrenByParent.get(nodeId) ?? []));
  }
  if (reachable.size !== nodes.length) {
    throw new Error("research publication contains nodes disconnected from the root");
  }
}
