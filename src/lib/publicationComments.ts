const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const COMMENT_MARKER_PREFIX = "<!-- qmux-comment:v1 ";
const COMMENT_MARKER_SUFFIX = " -->";
const PROPOSAL_MARKER_PREFIX = "<!-- qmux-proposal:v1 ";
const PROPOSAL_RESOLUTION_MARKER_PREFIX = "<!-- qmux-proposal-resolution:v1 ";
export const MAX_RESEARCH_PROPOSAL_PROMPT_CHARACTERS = 10_000;
export const MAX_RESEARCH_PROPOSAL_ANSWER_CHARACTERS = 40_000;
export const MAX_RESEARCH_PROPOSAL_QUOTE_CHARACTERS = 2_000;
const MAX_RESEARCH_PROPOSAL_CONTEXT_CHARACTERS = 500;

export interface PublicationCommentAnchor {
  publicationId: string;
  nodeId?: string | null;
}

export interface ParsedPublicationComment {
  anchor: PublicationCommentAnchor | null;
  body: string;
}

/** The passage of the parent's published answer an anchored proposal was
 * asked about: offsets into the page's rendered-text projection plus the
 * quote and nearby context, the same shape published query anchors use. */
export interface ResearchProposalAnchor {
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

export interface ResearchProposalPayload {
  publicationId: string;
  parentNodeId: string;
  prompt: string;
  answerMarkdown?: string | null;
  anchor?: ResearchProposalAnchor | null;
}

export interface ProposalResolutionPayload {
  publicationId: string;
  proposalCommentId: number;
  proposalDigest: string;
  status: "accepted" | "declined";
  publicNodeId?: string | null;
}

export function encodePublicationComment(
  anchor: PublicationCommentAnchor,
  body: string,
) {
  const normalized = validatePublicationCommentAnchor(anchor);
  const text = body.trim();
  if (!text) {
    throw new Error("comment body cannot be empty");
  }
  return `${COMMENT_MARKER_PREFIX}${JSON.stringify(normalized)}${COMMENT_MARKER_SUFFIX}\n\n${text}`;
}

export function parsePublicationComment(raw: string): ParsedPublicationComment {
  if (!raw.startsWith(COMMENT_MARKER_PREFIX)) {
    return { anchor: null, body: raw.trim() };
  }
  const markerEnd = raw.indexOf(COMMENT_MARKER_SUFFIX);
  if (markerEnd < COMMENT_MARKER_PREFIX.length) {
    return { anchor: null, body: raw.trim() };
  }
  const encoded = raw.slice(COMMENT_MARKER_PREFIX.length, markerEnd);
  try {
    const value = JSON.parse(encoded) as unknown;
    const anchor = validatePublicationCommentAnchor(value);
    return {
      anchor,
      body: raw.slice(markerEnd + COMMENT_MARKER_SUFFIX.length).trim(),
    };
  } catch {
    return { anchor: null, body: raw.trim() };
  }
}

export function encodeResearchProposal(payload: ResearchProposalPayload) {
  const normalized = validateResearchProposal(payload);
  const sections = [
    "## Proposed follow-up",
    "",
    normalized.prompt,
  ];
  if (normalized.answerMarkdown) {
    sections.push("", "## Proposed answer", "", normalized.answerMarkdown);
  }
  return `${PROPOSAL_MARKER_PREFIX}${encodeMarkerPayload(normalized)}${COMMENT_MARKER_SUFFIX}\n\n${sections.join("\n")}`;
}

export function parseResearchProposal(raw: string): ResearchProposalPayload | null {
  return parseMarkerPayload(raw, PROPOSAL_MARKER_PREFIX, validateResearchProposal);
}

export function researchProposalDigestInput(payload: ResearchProposalPayload) {
  const normalized = validateResearchProposal(payload);
  // Anchor-free proposals keep the original four-element input so digests in
  // existing resolution comments stay valid; an anchor extends the array.
  return JSON.stringify([
    normalized.publicationId,
    normalized.parentNodeId,
    normalized.prompt,
    normalized.answerMarkdown ?? null,
    ...(normalized.anchor
      ? [
          normalized.anchor.start,
          normalized.anchor.end,
          normalized.anchor.exact,
          normalized.anchor.prefix,
          normalized.anchor.suffix,
        ]
      : []),
  ]);
}

export function encodeProposalResolution(payload: ProposalResolutionPayload) {
  const normalized = validateProposalResolution(payload);
  const message =
    normalized.status === "accepted"
      ? "Accepted this follow-up into the owner's qmux research tree."
      : "The owner declined this follow-up.";
  return `${PROPOSAL_RESOLUTION_MARKER_PREFIX}${encodeMarkerPayload(normalized)}${COMMENT_MARKER_SUFFIX}\n\n${message}`;
}

export function parseProposalResolution(raw: string): ProposalResolutionPayload | null {
  return parseMarkerPayload(
    raw,
    PROPOSAL_RESOLUTION_MARKER_PREFIX,
    validateProposalResolution,
  );
}

function validatePublicationCommentAnchor(value: unknown): PublicationCommentAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("comment anchor must be an object");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.publicationId !== "string" || !PUBLIC_ID_PATTERN.test(item.publicationId)) {
    throw new Error("comment publicationId is invalid");
  }
  const nodeId = item.nodeId;
  if (
    nodeId !== undefined &&
    nodeId !== null &&
    (typeof nodeId !== "string" || !PUBLIC_ID_PATTERN.test(nodeId))
  ) {
    throw new Error("comment nodeId is invalid");
  }
  return {
    publicationId: item.publicationId,
    ...(nodeId ? { nodeId } : {}),
  };
}

function validateResearchProposal(value: unknown): ResearchProposalPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("research proposal must be an object");
  }
  const item = value as Record<string, unknown>;
  const publicationId = publicId(item.publicationId, "proposal publicationId");
  const parentNodeId = publicId(item.parentNodeId, "proposal parentNodeId");
  const prompt = boundedText(
    item.prompt,
    "proposal prompt",
    MAX_RESEARCH_PROPOSAL_PROMPT_CHARACTERS,
  );
  const answerMarkdown =
    item.answerMarkdown === undefined || item.answerMarkdown === null
      ? null
      : boundedTextAllowEmpty(
          item.answerMarkdown,
          "proposal answerMarkdown",
          MAX_RESEARCH_PROPOSAL_ANSWER_CHARACTERS,
        ).trim() || null;
  const anchor =
    item.anchor === undefined || item.anchor === null
      ? null
      : validateResearchProposalAnchor(item.anchor);
  return {
    publicationId,
    parentNodeId,
    prompt,
    ...(answerMarkdown ? { answerMarkdown } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

export function validateResearchProposalAnchor(value: unknown): ResearchProposalAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("proposal anchor must be an object");
  }
  const item = value as Record<string, unknown>;
  const start = item.start;
  const end = item.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    throw new Error("proposal anchor offsets are invalid");
  }
  const exact = boundedText(
    item.exact,
    "proposal anchor exact",
    MAX_RESEARCH_PROPOSAL_QUOTE_CHARACTERS,
  );
  const prefix = boundedTextAllowEmpty(
    item.prefix,
    "proposal anchor prefix",
    MAX_RESEARCH_PROPOSAL_CONTEXT_CHARACTERS,
  );
  const suffix = boundedTextAllowEmpty(
    item.suffix,
    "proposal anchor suffix",
    MAX_RESEARCH_PROPOSAL_CONTEXT_CHARACTERS,
  );
  return { start, end, exact, prefix, suffix };
}

function validateProposalResolution(value: unknown): ProposalResolutionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("proposal resolution must be an object");
  }
  const item = value as Record<string, unknown>;
  const proposalCommentId = item.proposalCommentId;
  const proposalDigest = item.proposalDigest;
  const status = item.status;
  if (!Number.isSafeInteger(proposalCommentId) || Number(proposalCommentId) <= 0) {
    throw new Error("proposal resolution comment ID is invalid");
  }
  if (typeof proposalDigest !== "string" || !/^[a-f0-9]{64}$/.test(proposalDigest)) {
    throw new Error("proposal resolution digest is invalid");
  }
  if (status !== "accepted" && status !== "declined") {
    throw new Error("proposal resolution status is invalid");
  }
  const publicNodeId =
    item.publicNodeId === undefined || item.publicNodeId === null
      ? null
      : publicId(item.publicNodeId, "proposal resolution publicNodeId");
  return {
    publicationId: publicId(item.publicationId, "proposal resolution publicationId"),
    proposalCommentId: Number(proposalCommentId),
    proposalDigest,
    status,
    ...(publicNodeId ? { publicNodeId } : {}),
  };
}

function parseMarkerPayload<T>(
  raw: string,
  prefix: string,
  validate: (value: unknown) => T,
): T | null {
  if (!raw.startsWith(prefix)) {
    return null;
  }
  const markerEnd = raw.indexOf(COMMENT_MARKER_SUFFIX);
  if (markerEnd < prefix.length) {
    return null;
  }
  try {
    const encoded = raw.slice(prefix.length, markerEnd);
    return validate(JSON.parse(decodeBase64Url(encoded)) as unknown);
  } catch {
    return null;
  }
}

function encodeMarkerPayload(value: unknown) {
  return encodeBase64Url(JSON.stringify(value));
}

function encodeBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100_000) {
    throw new Error("marker payload is invalid");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function publicId(value: unknown, label: string) {
  if (typeof value !== "string" || !PUBLIC_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maxCharacters: number) {
  const text = boundedTextAllowEmpty(value, label, maxCharacters).trim();
  if (!text) {
    throw new Error(`${label} cannot be empty`);
  }
  return text;
}

function boundedTextAllowEmpty(
  value: unknown,
  label: string,
  maxCharacters: number,
) {
  if (typeof value !== "string" || value.length > maxCharacters) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
