import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  MAX_RESEARCH_PROPOSAL_ANSWER_CHARACTERS,
  MAX_RESEARCH_PROPOSAL_PROMPT_CHARACTERS,
  encodeResearchProposal,
  encodePublicationComment,
  parseProposalResolution,
  parsePublicationComment,
  parseResearchProposal,
  researchProposalDigestInput,
  type PublicationCommentAnchor,
  type ProposalResolutionPayload,
  type ResearchProposalPayload,
} from "../src/lib/publicationComments";
import {
  MAX_PUBLICATION_FILE_BYTES,
  MAX_PUBLICATION_TOTAL_BYTES,
  PUBLICATION_INDEX_FILE,
  parsePublicationJson,
  publicationHashInput,
  type Publication,
  type ResearchPublication,
  type TranscriptPublication,
} from "../src/lib/publication";
import {
  beginGitHubAuthorization,
  clearViewerSession,
  completeGitHubAuthorization,
  resolveGitHubWebAuthConfig,
  viewerSessionFromRequest,
  type GitHubWebAuthConfig,
  type GitHubWebAuthOptions,
  type ViewerSession,
} from "./githubAuth";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const GITHUB_API_VERSION = "2026-03-10";
const LATEST_CACHE_MS = 60_000;
const REVISION_CACHE_MS = 365 * 24 * 60 * 60 * 1000;
const COMMENTS_CACHE_MS = 30_000;
// A deterministic upstream verdict (missing/invalid gist) is cached briefly so a
// flood of repeat requests for the same bad id can't each spend a GitHub call.
const NEGATIVE_CACHE_MS = 60_000;
const MAX_NEGATIVE_CACHE_ENTRIES = 512;
// When GitHub itself rate-limits the shared reader token, stop calling upstream
// for a cooldown and serve 503 rather than piling on and prolonging the block.
const UPSTREAM_COOLDOWN_MS = 60_000;
// Per-client request budget for the GitHub-backed publication route. Distinct
// random ids miss every cache and would otherwise each cost an upstream call, so
// the primary abuse vector (draining the shared token's GitHub quota) is bounded
// per source rather than only per id. Static assets and auth are exempt.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const MAX_RATE_LIMIT_ENTRIES = 4_096;
const MAX_GITHUB_API_RESPONSE_BYTES = 20_000_000;
const MAX_GITHUB_COMMENTS_RESPONSE_BYTES = 5_000_000;
const MAX_PUBLICATION_CACHE_BYTES = 64_000_000;
const MAX_PUBLICATION_CACHE_ENTRIES = 128;
const MAX_COMMENTS_CACHE_BYTES = 32_000_000;
const MAX_COMMENTS_CACHE_ENTRIES = 128;
const MAX_CONCURRENT_PUBLICATION_LOADS = 8;
const MAX_COMMENT_BODY_CHARACTERS = 60_000;
const MAX_COMMENT_FORM_BYTES = 128_000;
const MAX_GIST_COMMENTS = 300;
const GIST_ID_PATTERN = /^[A-Za-z0-9]{5,128}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_RAW_HOSTS = new Set(["gist.githubusercontent.com", "raw.githubusercontent.com"]);

interface GitHubGistFile {
  filename: string;
  size: number;
  truncated?: boolean;
  content?: string;
  raw_url?: string;
}

interface GitHubGist {
  id: string;
  html_url: string;
  description?: string | null;
  public: boolean;
  created_at: string;
  updated_at: string;
  files: Record<string, GitHubGistFile>;
  owner?: {
    login: string;
    avatar_url?: string;
    html_url?: string;
  } | null;
}

interface GitHubGistComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user?: {
    login: string;
    html_url?: string;
  } | null;
  author_association?: string;
}

interface PublicationComment {
  id: number;
  body: string;
  anchor: PublicationCommentAnchor | null;
  proposal: ResearchProposalPayload | null;
  resolution: ProposalResolutionPayload | null;
  createdAt: string;
  updatedAt: string;
  authorAssociation?: string | null;
  user: {
    login: string;
    htmlUrl: string;
  };
}

interface CachedPublication {
  gist: GitHubGist;
  publication: Publication;
  etag?: string | null;
  expiresAt: number;
  weightBytes: number;
}

interface CachedComments {
  comments: PublicationComment[];
  expiresAt: number;
  weightBytes: number;
}

interface CommentsCache {
  entries: Map<string, CachedComments>;
  totalBytes: number;
}

interface PublicationCache {
  entries: Map<string, CachedPublication>;
  totalBytes: number;
}

interface ServerOptions extends GitHubWebAuthOptions {
  fetchImpl?: typeof fetch;
  siteDir?: string;
  githubToken?: string | null;
  now?: () => number;
  // Fly Proxy supplies the real client address in Fly-Client-IP. Enable this
  // automatically on Fly, while allowing tests and other trusted-proxy
  // deployments to opt in explicitly.
  trustFlyClientIp?: boolean;
  // Per-client budget for the publication route; `null` disables it (used by
  // tests that intentionally issue many requests from one address).
  rateLimit?: { windowMs: number; maxRequests: number } | null;
}

export function createQmuxWebServer(options: ServerOptions = {}) {
  return createServer(createQmuxRequestHandler(options));
}

export function createQmuxRequestHandler(options: ServerOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const siteDir = options.siteDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
  const githubToken = options.githubToken ?? process.env.GITHUB_READER_TOKEN ?? null;
  const webAuth = resolveGitHubWebAuthConfig(options);
  const cache: PublicationCache = {
    entries: new Map(),
    totalBytes: 0,
  };
  const rateLimit =
    options.rateLimit === undefined
      ? { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_MAX_REQUESTS }
      : options.rateLimit;
  const context: RouteContext = {
    fetchImpl,
    siteDir,
    githubToken,
    now,
    cache,
    commentsCache: {
      entries: new Map(),
      totalBytes: 0,
    },
    negativeCache: new Map(),
    rateLimit,
    rateLimiter: new Map(),
    trustFlyClientIp:
      options.trustFlyClientIp ?? Boolean(process.env.FLY_APP_NAME),
    upstreamCooldownUntil: 0,
    webAuth,
    activePublicationLoads: 0,
  };

  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      await routeRequest(request, response, context);
    } catch (error) {
      const status = error instanceof PublicationHttpError ? error.status : 500;
      const message =
        error instanceof PublicationHttpError
          ? error.message
          : "The publication could not be loaded.";
      if (!(error instanceof PublicationHttpError)) {
        console.error(error);
      }
      const extraHeaders =
        error instanceof PublicationHttpError ? error.headers : undefined;
      sendHtml(
        response,
        status,
        errorPage("Publication unavailable", message),
        "no-store",
        undefined,
        extraHeaders,
      );
    }
  };
}

interface NegativeCacheEntry {
  status: number;
  message: string;
  expiresAt: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RouteContext {
  fetchImpl: typeof fetch;
  siteDir: string;
  githubToken: string | null;
  webAuth: GitHubWebAuthConfig | null;
  now: () => number;
  cache: PublicationCache;
  commentsCache: CommentsCache;
  negativeCache: Map<string, NegativeCacheEntry>;
  rateLimit: { windowMs: number; maxRequests: number } | null;
  rateLimiter: Map<string, RateLimitEntry>;
  trustFlyClientIp: boolean;
  upstreamCooldownUntil: number;
  activePublicationLoads: number;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/auth/github") {
    if (!context.webAuth) {
      throw new PublicationHttpError(503, "GitHub comments are not configured.");
    }
    beginGitHubAuthorization(
      response,
      context.webAuth,
      url.searchParams.get("returnTo") ?? "/",
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/auth/github/callback") {
    if (!context.webAuth) {
      throw new PublicationHttpError(503, "GitHub comments are not configured.");
    }
    await completeGitHubAuthorization(
      request,
      response,
      url,
      context.webAuth,
      context.fetchImpl,
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/auth/logout") {
    await handleLogout(request, response, context, url);
    return;
  }
  const proposalRoute = publicationProposalRoute(url.pathname);
  if (request.method === "POST" && proposalRoute) {
    await handleCreateProposal(request, response, context, proposalRoute);
    return;
  }
  const commentRoute = publicationCommentRoute(url.pathname);
  if (request.method === "POST" && commentRoute) {
    await handleCreateComment(request, response, context, commentRoute);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD, POST" });
    response.end();
    return;
  }
  if (url.pathname === "/healthz") {
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : "ok\n");
    return;
  }
  if (url.pathname === "/") {
    await serveStaticFile(response, join(context.siteDir, "index.html"), "text/html; charset=utf-8", request.method);
    return;
  }
  if (url.pathname === "/logo.png" || url.pathname === "/qmux.png") {
    const name = normalize(url.pathname.slice(1));
    await serveStaticFile(response, join(context.siteDir, name), "image/png", request.method);
    return;
  }

  const route = publicationRoute(url.pathname);
  if (!route) {
    sendHtml(response, 404, errorPage("Not found", "This page does not exist."));
    return;
  }
  enforcePublicationRateLimit(request, context);
  if (context.activePublicationLoads >= MAX_CONCURRENT_PUBLICATION_LOADS) {
    throw new PublicationHttpError(
      503,
      "The publication server is busy. Try again shortly.",
    );
  }
  context.activePublicationLoads += 1;
  try {
    const loaded = await loadPublication(route.gistId, route.revision, context);
    const viewer = viewerSessionFromRequest(request, context.webAuth);
    let comments: PublicationComment[] = [];
    let commentsError: string | null = null;
    if (!route.revision && (context.webAuth || context.githubToken)) {
      try {
        comments = await loadPublicationComments(route.gistId, context);
      } catch (error) {
        commentsError =
          error instanceof Error ? error.message : "Comments could not be loaded.";
      }
    }
    const page =
      loaded.publication.kind === "transcript"
        ? transcriptPage(
            loaded.gist,
            loaded.publication,
            route.revision,
            comments,
            commentsError,
            viewer,
            context.webAuth,
          )
        : researchPage(
            loaded.gist,
            loaded.publication,
            route.revision,
            route.nodeId,
            comments,
            commentsError,
            viewer,
            context.webAuth,
          );
    const cacheControl = viewer
      ? "private, no-store"
      : route.revision
      ? "public, max-age=31536000, immutable"
      : "public, max-age=30, stale-while-revalidate=120";
    sendHtml(response, 200, page, cacheControl, request.method);
  } finally {
    context.activePublicationLoads -= 1;
  }
}

function publicationRoute(pathname: string) {
  const revisionNode = pathname.match(/^\/p\/([^/]+)\/r\/([^/]+)\/n\/([^/]+)\/?$/);
  if (
    revisionNode &&
    GIST_ID_PATTERN.test(revisionNode[1]) &&
    REVISION_PATTERN.test(revisionNode[2]) &&
    /^[A-Za-z0-9_-]{8,128}$/.test(revisionNode[3])
  ) {
    return {
      gistId: revisionNode[1],
      revision: revisionNode[2],
      nodeId: revisionNode[3],
    };
  }
  const latestNode = pathname.match(/^\/p\/([^/]+)\/n\/([^/]+)\/?$/);
  if (
    latestNode &&
    GIST_ID_PATTERN.test(latestNode[1]) &&
    /^[A-Za-z0-9_-]{8,128}$/.test(latestNode[2])
  ) {
    return { gistId: latestNode[1], revision: null, nodeId: latestNode[2] };
  }
  const latest = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (latest && GIST_ID_PATTERN.test(latest[1])) {
    return { gistId: latest[1], revision: null, nodeId: null };
  }
  const revision = pathname.match(/^\/p\/([^/]+)\/r\/([^/]+)\/?$/);
  if (
    revision &&
    GIST_ID_PATTERN.test(revision[1]) &&
    REVISION_PATTERN.test(revision[2])
  ) {
    return { gistId: revision[1], revision: revision[2], nodeId: null };
  }
  return null;
}

function publicationCommentRoute(pathname: string) {
  const node = pathname.match(/^\/p\/([^/]+)\/n\/([^/]+)\/comments\/?$/);
  if (
    node &&
    GIST_ID_PATTERN.test(node[1]) &&
    /^[A-Za-z0-9_-]{8,128}$/.test(node[2])
  ) {
    return { gistId: node[1], nodeId: node[2] };
  }
  const publication = pathname.match(/^\/p\/([^/]+)\/comments\/?$/);
  if (publication && GIST_ID_PATTERN.test(publication[1])) {
    return { gistId: publication[1], nodeId: null };
  }
  return null;
}

function publicationProposalRoute(pathname: string) {
  const node = pathname.match(/^\/p\/([^/]+)\/n\/([^/]+)\/proposals\/?$/);
  if (
    node &&
    GIST_ID_PATTERN.test(node[1]) &&
    /^[A-Za-z0-9_-]{8,128}$/.test(node[2])
  ) {
    return { gistId: node[1], nodeId: node[2] };
  }
  return null;
}

async function handleLogout(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  url: URL,
) {
  if (!context.webAuth) {
    throw new PublicationHttpError(404, "GitHub comments are not configured.");
  }
  const session = viewerSessionFromRequest(request, context.webAuth);
  const form = await readUrlEncodedForm(request);
  if (!session || form.get("csrfToken") !== session.csrfToken) {
    throw new PublicationHttpError(403, "The sign-out request could not be verified.");
  }
  clearViewerSession(
    response,
    context.webAuth,
    form.get("returnTo") ?? url.searchParams.get("returnTo") ?? "/",
  );
}

async function handleCreateComment(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  route: { gistId: string; nodeId: string | null },
) {
  if (!context.webAuth) {
    throw new PublicationHttpError(503, "GitHub comments are not configured.");
  }
  const session = viewerSessionFromRequest(request, context.webAuth);
  if (!session) {
    throw new PublicationHttpError(401, "Sign in with GitHub before commenting.");
  }
  const form = await readUrlEncodedForm(request);
  if (form.get("csrfToken") !== session.csrfToken) {
    throw new PublicationHttpError(403, "The comment request could not be verified.");
  }
  const loaded = await loadPublication(route.gistId, null, context);
  const nodeId = resolvedCommentNodeId(loaded.publication, route.nodeId);
  const body = (form.get("body") ?? "").trim();
  if (!body || body.length > MAX_COMMENT_BODY_CHARACTERS) {
    throw new PublicationHttpError(
      422,
      `Comments must contain between 1 and ${MAX_COMMENT_BODY_CHARACTERS.toLocaleString()} characters.`,
    );
  }
  const encoded = encodePublicationComment(
    {
      publicationId: loaded.publication.publicationId,
      ...(nodeId ? { nodeId } : {}),
    },
    body,
  );
  const upstream = await context.fetchImpl(
    `https://api.github.com/gists/${encodeURIComponent(route.gistId)}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "qmux-publisher",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ body: encoded }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const responseBody = await readResponseTextLimited(
    upstream,
    MAX_GITHUB_COMMENTS_RESPONSE_BYTES,
    "GitHub comment response",
  );
  if (!upstream.ok) {
    throw new PublicationHttpError(
      upstream.status,
      githubApiErrorMessage(responseBody, "GitHub could not create this comment."),
    );
  }
  deleteCommentsCacheEntry(context.commentsCache, route.gistId);
  const returnTo = commentReturnPath(route.gistId, nodeId);
  response.writeHead(303, {
    Location: `${returnTo}#comments`,
    "Cache-Control": "no-store",
  });
  response.end();
}

async function handleCreateProposal(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  route: { gistId: string; nodeId: string },
) {
  if (!context.webAuth) {
    throw new PublicationHttpError(503, "GitHub contributions are not configured.");
  }
  const session = viewerSessionFromRequest(request, context.webAuth);
  if (!session) {
    throw new PublicationHttpError(401, "Sign in with GitHub before proposing a follow-up.");
  }
  const form = await readUrlEncodedForm(request);
  if (form.get("csrfToken") !== session.csrfToken) {
    throw new PublicationHttpError(403, "The proposal request could not be verified.");
  }
  const loaded = await loadPublication(route.gistId, null, context);
  if (
    loaded.publication.kind !== "research-tree" ||
    !loaded.publication.research.nodes.some((node) => node.id === route.nodeId)
  ) {
    throw new PublicationHttpError(
      404,
      "That published research proposal target was not found.",
    );
  }
  const prompt = (form.get("prompt") ?? "").trim();
  const answerMarkdown = (form.get("answerMarkdown") ?? "").trim();
  if (!prompt || prompt.length > MAX_RESEARCH_PROPOSAL_PROMPT_CHARACTERS) {
    throw new PublicationHttpError(
      422,
      `Follow-up questions must contain between 1 and ${MAX_RESEARCH_PROPOSAL_PROMPT_CHARACTERS.toLocaleString()} characters.`,
    );
  }
  if (answerMarkdown.length > MAX_RESEARCH_PROPOSAL_ANSWER_CHARACTERS) {
    throw new PublicationHttpError(
      422,
      `Proposed answers cannot exceed ${MAX_RESEARCH_PROPOSAL_ANSWER_CHARACTERS.toLocaleString()} characters.`,
    );
  }
  const body = encodeResearchProposal({
    publicationId: loaded.publication.publicationId,
    parentNodeId: route.nodeId,
    prompt,
    ...(answerMarkdown ? { answerMarkdown } : {}),
  });
  const upstream = await context.fetchImpl(
    `https://api.github.com/gists/${encodeURIComponent(route.gistId)}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "qmux-publisher",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ body }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const responseBody = await readResponseTextLimited(
    upstream,
    MAX_GITHUB_COMMENTS_RESPONSE_BYTES,
    "GitHub proposal response",
  );
  if (!upstream.ok) {
    throw new PublicationHttpError(
      upstream.status,
      githubApiErrorMessage(responseBody, "GitHub could not create this proposal."),
    );
  }
  deleteCommentsCacheEntry(context.commentsCache, route.gistId);
  const returnTo = commentReturnPath(route.gistId, route.nodeId);
  response.writeHead(303, {
    Location: `${returnTo}#proposals`,
    "Cache-Control": "no-store",
  });
  response.end();
}

function resolvedCommentNodeId(
  publication: Publication,
  requestedNodeId: string | null,
) {
  if (publication.kind === "transcript") {
    if (requestedNodeId) {
      throw new PublicationHttpError(404, "That transcript comment target was not found.");
    }
    return null;
  }
  const nodeId =
    requestedNodeId ??
    publication.research.selectedNodeId ??
    publication.research.rootNodeId;
  if (!publication.research.nodes.some((node) => node.id === nodeId)) {
    throw new PublicationHttpError(404, "That research comment target was not found.");
  }
  return nodeId;
}

function commentReturnPath(gistId: string, nodeId: string | null) {
  return nodeId
    ? `/p/${encodeURIComponent(gistId)}/n/${encodeURIComponent(nodeId)}`
    : `/p/${encodeURIComponent(gistId)}`;
}

async function readUrlEncodedForm(request: IncomingMessage) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new PublicationHttpError(415, "This form submission has an unsupported content type.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_COMMENT_FORM_BYTES) {
      throw new PublicationHttpError(413, "This form submission is too large.");
    }
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks, totalBytes).toString("utf8"));
}

async function loadPublicationComments(
  gistId: string,
  context: RouteContext,
): Promise<PublicationComment[]> {
  const cached = context.commentsCache.entries.get(gistId);
  if (cached && cached.expiresAt > context.now()) {
    touchCommentsCacheEntry(context.commentsCache, gistId, cached);
    return cached.comments;
  }
  if (cached) {
    deleteCommentsCacheEntry(context.commentsCache, gistId);
  }
  const comments: PublicationComment[] = [];
  const maxPages = Math.ceil(MAX_GIST_COMMENTS / 100);
  const firstPage = await fetchGitHubCommentsPage(gistId, 1, context);
  const lastPage = firstPage.lastPage;
  const pageNumbers = lastPage
    ? Array.from(
        { length: Math.min(lastPage, maxPages) },
        (_, index) =>
          Math.max(1, lastPage - maxPages + 1) + index,
      )
    : Array.from({ length: maxPages }, (_, index) => index + 1);
  for (const page of pageNumbers) {
    const pageComments =
      page === 1
        ? firstPage.comments
        : (await fetchGitHubCommentsPage(gistId, page, context)).comments;
    for (const comment of pageComments) {
      const normalized = normalizeGitHubComment(comment);
      if (normalized) {
        comments.push(normalized);
      }
      if (comments.length >= MAX_GIST_COMMENTS) {
        break;
      }
    }
    if (comments.length >= MAX_GIST_COMMENTS) {
      break;
    }
    if (!firstPage.lastPage && pageComments.length < 100) {
      break;
    }
  }
  comments.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  cacheComments(context.commentsCache, gistId, {
    comments,
    expiresAt: context.now() + COMMENTS_CACHE_MS,
    weightBytes: commentsCacheWeight(comments),
  });
  return comments;
}

async function fetchGitHubCommentsPage(
  gistId: string,
  page: number,
  context: RouteContext,
) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "qmux-publisher",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (context.githubToken) {
    headers.Authorization = `Bearer ${context.githubToken}`;
  }
  const upstream = await context.fetchImpl(
    `https://api.github.com/gists/${encodeURIComponent(gistId)}/comments?per_page=100&page=${page}`,
    {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const lastPage = githubLastPage(upstream.headers.get("link"));
  const raw = await readResponseTextLimited(
    upstream,
    MAX_GITHUB_COMMENTS_RESPONSE_BYTES,
    "GitHub comments response",
  );
  if (!upstream.ok) {
    throw new PublicationHttpError(
      upstream.status,
      githubApiErrorMessage(raw, "GitHub comments could not be loaded."),
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("comments response is not an array");
    }
    return {
      comments: parsed as GitHubGistComment[],
      lastPage,
    };
  } catch {
    throw new PublicationHttpError(502, "GitHub returned invalid comments.");
  }
}

function githubLastPage(link: string | null) {
  if (!link) {
    return null;
  }
  for (const segment of link.split(",")) {
    const [target, ...parameters] = segment.split(";");
    if (!parameters.some((value) => value.trim() === 'rel="last"')) {
      continue;
    }
    const match = target.trim().match(/^<([^>]+)>$/);
    if (!match) {
      return null;
    }
    try {
      const page = Number(new URL(match[1]).searchParams.get("page"));
      return Number.isSafeInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

function commentsCacheWeight(comments: PublicationComment[]) {
  return comments.reduce(
    (total, comment) =>
      total +
      Buffer.byteLength(comment.body) * 2 +
      Buffer.byteLength(comment.user.login) +
      Buffer.byteLength(comment.user.htmlUrl) +
      512,
    1_024,
  );
}

function touchCommentsCacheEntry(
  cache: CommentsCache,
  key: string,
  entry: CachedComments,
) {
  cache.entries.delete(key);
  cache.entries.set(key, entry);
}

function deleteCommentsCacheEntry(cache: CommentsCache, key: string) {
  const existing = cache.entries.get(key);
  if (!existing) {
    return;
  }
  cache.entries.delete(key);
  cache.totalBytes -= existing.weightBytes;
}

function cacheComments(
  cache: CommentsCache,
  key: string,
  entry: CachedComments,
) {
  deleteCommentsCacheEntry(cache, key);
  if (entry.weightBytes > MAX_COMMENTS_CACHE_BYTES) {
    return;
  }
  while (
    cache.entries.size >= MAX_COMMENTS_CACHE_ENTRIES ||
    cache.totalBytes + entry.weightBytes > MAX_COMMENTS_CACHE_BYTES
  ) {
    const oldestKey = cache.entries.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    deleteCommentsCacheEntry(cache, oldestKey);
  }
  cache.entries.set(key, entry);
  cache.totalBytes += entry.weightBytes;
}

function normalizeGitHubComment(comment: GitHubGistComment): PublicationComment | null {
  if (
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    typeof comment.body !== "string" ||
    comment.body.length > 65_536 ||
    !comment.user?.login ||
    Number.isNaN(Date.parse(comment.created_at))
  ) {
    return null;
  }
  const parsed = parsePublicationComment(comment.body);
  const proposal = parseResearchProposal(comment.body);
  const resolution = parseProposalResolution(comment.body);
  return {
    id: comment.id,
    body: parsed.body,
    anchor: parsed.anchor,
    proposal,
    resolution,
    createdAt: comment.created_at,
    updatedAt: Number.isNaN(Date.parse(comment.updated_at))
      ? comment.created_at
      : comment.updated_at,
    authorAssociation: comment.author_association ?? null,
    user: {
      login: comment.user.login,
      htmlUrl: githubProfileUrl(comment.user.html_url, comment.user.login),
    },
  };
}

function researchProposalDigest(proposal: ResearchProposalPayload) {
  return createHash("sha256")
    .update(researchProposalDigestInput(proposal))
    .digest("hex");
}

function githubProfileUrl(value: string | undefined, login: string) {
  const fallback = `https://github.com/${encodeURIComponent(login)}`;
  if (!value) {
    return fallback;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

function githubApiErrorMessage(raw: string, fallback: string) {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message
      : fallback;
  } catch {
    return fallback;
  }
}

async function loadPublication(
  gistId: string,
  revision: string | null,
  context: RouteContext,
): Promise<CachedPublication> {
  const key = `${gistId}@${revision ?? "latest"}`;
  const cached = context.cache.entries.get(key);
  if (cached && cached.expiresAt > context.now()) {
    touchCacheEntry(context.cache, key, cached);
    return cached;
  }
  const negative = context.negativeCache.get(key);
  if (negative && negative.expiresAt > context.now()) {
    throw new PublicationHttpError(negative.status, negative.message);
  }
  // GitHub is rate-limiting the shared reader token; don't add to the pile-up.
  if (context.upstreamCooldownUntil > context.now()) {
    throw new PublicationHttpError(
      503,
      "The publication server is briefly rate-limited. Try again shortly.",
    );
  }
  const endpoint = revision
    ? `https://api.github.com/gists/${encodeURIComponent(gistId)}/${encodeURIComponent(revision)}`
    : `https://api.github.com/gists/${encodeURIComponent(gistId)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "qmux-publisher",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (context.githubToken) {
    headers.Authorization = `Bearer ${context.githubToken}`;
  }
  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }
  const upstream = await context.fetchImpl(endpoint, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  if (upstream.status === 304 && cached) {
    cached.expiresAt = context.now() + (revision ? REVISION_CACHE_MS : LATEST_CACHE_MS);
    touchCacheEntry(context.cache, key, cached);
    return cached;
  }
  if (upstream.status === 404) {
    throwNegativePublication(context, key, 404, "The requested Gist was not found.");
  }
  // GitHub rate-limit (429, or 403 with the remaining-quota header at zero):
  // enter a global cooldown so every id — not just this one — stops calling
  // upstream until the token recovers.
  if (
    upstream.status === 429 ||
    (upstream.status === 403 && upstream.headers.get("x-ratelimit-remaining") === "0")
  ) {
    context.upstreamCooldownUntil = context.now() + UPSTREAM_COOLDOWN_MS;
    throw new PublicationHttpError(
      503,
      "The publication server is briefly rate-limited. Try again shortly.",
    );
  }
  if (!upstream.ok) {
    throw new PublicationHttpError(
      upstream.status,
      `GitHub returned ${upstream.status} while loading this publication.`,
    );
  }
  const gistRaw = await readResponseTextLimited(
    upstream,
    MAX_GITHUB_API_RESPONSE_BYTES,
    "GitHub Gist response",
  );
  let gist: GitHubGist;
  try {
    gist = JSON.parse(gistRaw) as GitHubGist;
  } catch {
    throw new PublicationHttpError(502, "GitHub returned an invalid Gist response.");
  }
  const index = gist.files?.[PUBLICATION_INDEX_FILE];
  if (!index) {
    // Deterministic for this gist's current content — a stranger's gist that
    // simply isn't a qmux publication. Cache it so probing such ids stays cheap.
    throwNegativePublication(
      context,
      key,
      422,
      `This Gist does not contain ${PUBLICATION_INDEX_FILE}.`,
    );
  }
  const indexContent = await loadGistFileContent(
    index,
    context,
    PUBLICATION_INDEX_FILE,
  );
  index.content = indexContent;
  index.truncated = false;
  let publication: Publication;
  try {
    publication = parsePublicationJson(indexContent);
  } catch (error) {
    throw new PublicationHttpError(
      422,
      error instanceof Error ? error.message : `${PUBLICATION_INDEX_FILE} is invalid.`,
    );
  }
  const expectedHash = createHash("sha256")
    .update(publicationHashInput(publication))
    .digest("hex");
  if (expectedHash !== publication.contentHash) {
    throw new PublicationHttpError(422, "The publication content hash is invalid.");
  }
  if (publication.kind !== "transcript") {
    await validateResearchFiles(gist, publication, context, Buffer.byteLength(indexContent));
  }
  retainPublicationFiles(gist, publication);
  const weightBytes = cachedPublicationWeight(gist, indexContent);
  const loaded = {
    gist,
    publication,
    etag: upstream.headers.get("etag"),
    expiresAt: context.now() + (revision ? REVISION_CACHE_MS : LATEST_CACHE_MS),
    weightBytes,
  };
  cachePublication(context.cache, key, loaded);
  return loaded;
}

async function validateResearchFiles(
  gist: GitHubGist,
  publication: ResearchPublication,
  context: RouteContext,
  initialBytes: number,
) {
  let totalBytes = initialBytes;
  for (const node of publication.research.nodes) {
    const file = gist.files[node.answerFile];
    if (!file) {
      throw new PublicationHttpError(422, `This Gist is missing ${node.answerFile}.`);
    }
    const content = await loadGistFileContent(file, context, node.answerFile);
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_PUBLICATION_TOTAL_BYTES) {
      throw new PublicationHttpError(413, "This publication is too large to render.");
    }
    file.content = content;
    file.truncated = false;
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== node.contentHash) {
      throw new PublicationHttpError(422, `${node.answerFile} has an invalid content hash.`);
    }
  }
}

async function loadGistFileContent(
  file: GitHubGistFile,
  context: RouteContext,
  label: string,
) {
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_PUBLICATION_FILE_BYTES) {
    throw new PublicationHttpError(413, `${label} is too large to render.`);
  }
  if (!file.truncated && file.content !== undefined) {
    if (Buffer.byteLength(file.content) > MAX_PUBLICATION_FILE_BYTES) {
      throw new PublicationHttpError(413, `${label} is too large to render.`);
    }
    return file.content;
  }
  const rawUrl = validatedGitHubRawUrl(file.raw_url, label);
  const response = await context.fetchImpl(rawUrl, {
    headers: {
      "User-Agent": "qmux-publisher",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new PublicationHttpError(
      response.status === 404 ? 422 : 502,
      `GitHub could not provide ${label}.`,
    );
  }
  if (response.url) {
    validatedGitHubRawUrl(response.url, label);
  }
  return readResponseTextLimited(response, MAX_PUBLICATION_FILE_BYTES, label);
}

function validatedGitHubRawUrl(value: string | undefined, label: string) {
  if (!value) {
    throw new PublicationHttpError(422, `${label} is truncated and has no raw URL.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicationHttpError(422, `${label} has an invalid raw URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !GITHUB_RAW_HOSTS.has(url.hostname)
  ) {
    throw new PublicationHttpError(422, `${label} has an untrusted raw URL.`);
  }
  return url.toString();
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
  label: string,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new PublicationHttpError(413, `${label} is too large to render.`);
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new PublicationHttpError(413, `${label} is too large to render.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
}

function retainPublicationFiles(gist: GitHubGist, publication: Publication) {
  const names = new Set([PUBLICATION_INDEX_FILE]);
  if (publication.kind !== "transcript") {
    for (const node of publication.research.nodes) {
      names.add(node.answerFile);
    }
  }
  gist.files = Object.fromEntries(
    Object.entries(gist.files).filter(([name]) => names.has(name)),
  );
}

function cachedPublicationWeight(gist: GitHubGist, indexContent: string) {
  let bytes = Buffer.byteLength(indexContent) * 4 + 4_096;
  for (const [name, file] of Object.entries(gist.files)) {
    if (name === PUBLICATION_INDEX_FILE) {
      continue;
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(file.content ?? "") * 2 + 1_024;
  }
  return bytes;
}

function touchCacheEntry(
  cache: PublicationCache,
  key: string,
  entry: CachedPublication,
) {
  cache.entries.delete(key);
  cache.entries.set(key, entry);
}

function cachePublication(
  cache: PublicationCache,
  key: string,
  entry: CachedPublication,
) {
  const replaced = cache.entries.get(key);
  if (replaced) {
    cache.entries.delete(key);
    cache.totalBytes -= replaced.weightBytes;
  }
  if (entry.weightBytes > MAX_PUBLICATION_CACHE_BYTES) {
    return;
  }
  while (
    cache.entries.size >= MAX_PUBLICATION_CACHE_ENTRIES ||
    cache.totalBytes + entry.weightBytes > MAX_PUBLICATION_CACHE_BYTES
  ) {
    const oldestKey = cache.entries.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    const oldest = cache.entries.get(oldestKey);
    cache.entries.delete(oldestKey);
    if (oldest) {
      cache.totalBytes -= oldest.weightBytes;
    }
  }
  cache.entries.set(key, entry);
  cache.totalBytes += entry.weightBytes;
}

class PublicationHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

// Fixed-window per-client limit on the GitHub-backed publication route. Fly
// Proxy's client header is trusted only inside a Fly Machine; elsewhere the
// socket peer remains authoritative so callers cannot spoof past the limit.
function enforcePublicationRateLimit(request: IncomingMessage, context: RouteContext) {
  if (!context.rateLimit) {
    return;
  }
  const now = context.now();
  const key = publicationRateLimitKey(request, context);
  const entry = context.rateLimiter.get(key);
  if (!entry || entry.resetAt <= now) {
    if (context.rateLimiter.size >= MAX_RATE_LIMIT_ENTRIES) {
      for (const [candidate, value] of context.rateLimiter) {
        if (value.resetAt <= now) {
          context.rateLimiter.delete(candidate);
        }
      }
    }
    context.rateLimiter.set(key, { count: 1, resetAt: now + context.rateLimit.windowMs });
    return;
  }
  if (entry.count >= context.rateLimit.maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    throw new PublicationHttpError(
      429,
      `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
      { "Retry-After": String(retryAfter) },
    );
  }
  entry.count += 1;
}

function publicationRateLimitKey(
  request: IncomingMessage,
  context: RouteContext,
) {
  if (context.trustFlyClientIp) {
    const flyClientIp = request.headers["fly-client-ip"];
    if (typeof flyClientIp === "string") {
      const normalizedIp = flyClientIp.trim();
      if (isIP(normalizedIp) !== 0) {
        return normalizedIp;
      }
    }
  }
  return request.socket?.remoteAddress ?? "unknown";
}

// Records a deterministic upstream verdict so repeat requests for the same bad
// id are answered from memory, then throws it.
function throwNegativePublication(
  context: RouteContext,
  key: string,
  status: number,
  message: string,
): never {
  const now = context.now();
  if (context.negativeCache.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
    for (const [candidate, value] of context.negativeCache) {
      if (value.expiresAt <= now) {
        context.negativeCache.delete(candidate);
      }
    }
  }
  context.negativeCache.set(key, { status, message, expiresAt: now + NEGATIVE_CACHE_MS });
  throw new PublicationHttpError(status, message);
}

function transcriptPage(
  gist: GitHubGist,
  publication: TranscriptPublication,
  revision: string | null,
  comments: PublicationComment[],
  commentsError: string | null,
  viewer: ViewerSession | null,
  webAuth: GitHubWebAuthConfig | null,
) {
  const author = gist.owner?.login ?? "GitHub user";
  const description = `A published qmux transcript by ${author}.`;
  return documentPage({
    title: publication.title,
    description,
    body: (
      <>
        <header className="publication-header">
          <a className="brand" href="/" aria-label="qmux home">
            qmux
          </a>
          <div className="publication-heading">
            <p className="publication-kind">Published transcript</p>
            <h1>{publication.title}</h1>
            <p className="publication-meta">
              <a href={gist.owner?.html_url ?? gist.html_url}>{author}</a>
              <span>{formatDate(publication.updatedAt)}</span>
              {revision ? <span>Revision {revision.slice(0, 8)}</span> : null}
            </p>
          </div>
          <a className="github-link" href={gist.html_url}>
            View Gist
          </a>
        </header>
        <main className="transcript">
          {publication.transcript.messages.map((message) => (
            <article className={`message message-${message.role}`} key={message.id}>
              <div className="message-label">{message.label}</div>
              <div className="message-body">
                <SafeMarkdown>{message.text}</SafeMarkdown>
              </div>
            </article>
          ))}
        </main>
        {!revision ? (
          <PublicationComments
            gist={gist}
            publication={publication}
            nodeId={null}
            comments={comments}
            error={commentsError}
            viewer={viewer}
            webAuth={webAuth}
          />
        ) : null}
        <footer className="publication-footer">
          Published with <a href="/">qmux</a>
        </footer>
      </>
    ),
  });
}

function researchPage(
  gist: GitHubGist,
  publication: ResearchPublication,
  revision: string | null,
  requestedNodeId: string | null,
  comments: PublicationComment[],
  commentsError: string | null,
  viewer: ViewerSession | null,
  webAuth: GitHubWebAuthConfig | null,
) {
  const selectedNodeId =
    requestedNodeId ??
    publication.research.selectedNodeId ??
    publication.research.rootNodeId;
  const selected = publication.research.nodes.find((node) => node.id === selectedNodeId);
  if (!selected) {
    throw new PublicationHttpError(404, "That published research result was not found.");
  }
  const author = gist.owner?.login ?? "GitHub user";
  const description =
    publication.kind === "research-answer"
      ? `A published qmux research answer by ${author}.`
      : `Published qmux research by ${author}.`;
  const file = gist.files[selected.answerFile];
  const children = publication.research.nodes
    .filter((node) => node.parentId === selected.id)
    .sort((left, right) => left.createdAt - right.createdAt);
  const parent = selected.parentId
    ? publication.research.nodes.find((node) => node.id === selected.parentId) ?? null
    : null;
  return documentPage({
    title: `${selected.title} · ${publication.title}`,
    description,
    body: (
      <>
        <header className="publication-header research-publication-header">
          <a className="brand" href="/" aria-label="qmux home">
            qmux
          </a>
          <div className="publication-heading">
            <p className="publication-kind">
              {publication.kind === "research-answer"
                ? "Published research answer"
                : "Published research"}
            </p>
            <h1>{publication.title}</h1>
            <p className="publication-meta">
              <a href={gist.owner?.html_url ?? gist.html_url}>{author}</a>
              <span>{formatDate(publication.updatedAt)}</span>
              <span>
                {publication.research.nodes.length}{" "}
                {publication.research.nodes.length === 1 ? "result" : "results"}
              </span>
              {revision ? <span>Revision {revision.slice(0, 8)}</span> : null}
            </p>
          </div>
          <a className="github-link" href={gist.html_url}>
            View Gist
          </a>
        </header>
        <div className="research-layout">
          <aside className="research-index" aria-label="Research results">
            <ResearchTreeNav
              gistId={gist.id}
              publication={publication}
              revision={revision}
              selectedNodeId={selected.id}
            />
          </aside>
          <main className="research-result">
            <nav className="research-result-nav" aria-label="Research result navigation">
              {parent ? (
                <a href={publicationNodePath(gist.id, revision, parent.id)}>← Parent</a>
              ) : (
                <span />
              )}
              <span className={`research-status is-${selected.status}`}>{selected.status}</span>
            </nav>
            {selected.contribution ? (
              <p className="research-contribution">
                Proposed by{" "}
                <a href={`https://github.com/${encodeURIComponent(selected.contribution.githubLogin)}`}>
                  @{selected.contribution.githubLogin}
                </a>
              </p>
            ) : null}
            <article className="research-answer">
              <SafeMarkdown>{file.content ?? ""}</SafeMarkdown>
            </article>
            {children.length > 0 ? (
              <section className="research-children">
                <h2>Follow-ups</h2>
                <div>
                  {children.map((child) => (
                    <a
                      key={child.id}
                      href={publicationNodePath(gist.id, revision, child.id)}
                    >
                      <span>{child.title}</span>
                      <small>{child.status}</small>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
            {!revision && publication.kind === "research-tree" ? (
              <PublicationProposals
                gist={gist}
                publication={publication}
                nodeId={selected.id}
                comments={comments}
                viewer={viewer}
                webAuth={webAuth}
              />
            ) : null}
            {!revision ? (
              <PublicationComments
                gist={gist}
                publication={publication}
                nodeId={selected.id}
                comments={comments}
                error={commentsError}
                viewer={viewer}
                webAuth={webAuth}
              />
            ) : null}
          </main>
        </div>
        <footer className="publication-footer">
          Published with <a href="/">qmux</a>
        </footer>
      </>
    ),
  });
}

function PublicationProposals({
  gist,
  publication,
  nodeId,
  comments,
  viewer,
  webAuth,
}: {
  gist: GitHubGist;
  publication: ResearchPublication;
  nodeId: string;
  comments: PublicationComment[];
  viewer: ViewerSession | null;
  webAuth: GitHubWebAuthConfig | null;
}) {
  const ownerLogin = gist.owner?.login ?? null;
  const proposals = comments.filter(
    (comment) =>
      comment.proposal?.publicationId === publication.publicationId &&
      comment.proposal.parentNodeId === nodeId,
  );
  const proposalsById = new Map(proposals.map((comment) => [comment.id, comment]));
  const resolutions = new Map<number, ProposalResolutionPayload>();
  for (const comment of comments) {
    const proposalComment = comment.resolution
      ? proposalsById.get(comment.resolution.proposalCommentId)
      : null;
    if (
      comment.resolution &&
      comment.resolution.publicationId === publication.publicationId &&
      comment.user.login === ownerLogin &&
      proposalComment?.proposal &&
      comment.resolution.proposalDigest ===
        researchProposalDigest(proposalComment.proposal)
    ) {
      resolutions.set(comment.resolution.proposalCommentId, comment.resolution);
    }
  }
  const returnTo = commentReturnPath(gist.id, nodeId);
  return (
    <section
      className="publication-proposals"
      id="proposals"
      aria-labelledby="proposals-title"
    >
      <div className="comments-heading">
        <div>
          <p className="comments-kicker">Contributions</p>
          <h2 id="proposals-title">Proposed follow-ups</h2>
        </div>
      </div>
      {proposals.length > 0 ? (
        <div className="proposal-list">
          {proposals.map((comment) => {
            const proposal = comment.proposal!;
            const resolution = resolutions.get(comment.id) ?? null;
            return (
              <article className="publication-proposal" key={comment.id}>
                <header>
                  <a href={comment.user.htmlUrl}>@{comment.user.login}</a>
                  <time dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time>
                  <span className={`proposal-status is-${resolution?.status ?? "pending"}`}>
                    {resolution?.status ?? "pending"}
                  </span>
                </header>
                <div className="proposal-question">
                  <SafeMarkdown>{proposal.prompt}</SafeMarkdown>
                </div>
                {proposal.answerMarkdown ? (
                  <details>
                    <summary>Proposed answer</summary>
                    <div className="comment-body">
                      <SafeMarkdown>{proposal.answerMarkdown}</SafeMarkdown>
                    </div>
                  </details>
                ) : null}
                {resolution?.publicNodeId ? (
                  <a
                    className="proposal-result-link"
                    href={publicationNodePath(gist.id, null, resolution.publicNodeId)}
                  >
                    Open published result
                  </a>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="comments-empty">No follow-ups have been proposed for this result.</p>
      )}
      {viewer ? (
        <form
          className="proposal-composer"
          method="post"
          action={`${returnTo}/proposals`}
        >
          <input type="hidden" name="csrfToken" value={viewer.csrfToken} />
          <label htmlFor="proposal-prompt">Propose a follow-up as @{viewer.login}</label>
          <textarea
            id="proposal-prompt"
            name="prompt"
            required
            maxLength={MAX_RESEARCH_PROPOSAL_PROMPT_CHARACTERS}
            rows={4}
          />
          <label htmlFor="proposal-answer">Proposed answer (optional)</label>
          <textarea
            id="proposal-answer"
            name="answerMarkdown"
            maxLength={MAX_RESEARCH_PROPOSAL_ANSWER_CHARACTERS}
            rows={4}
          />
          <button type="submit">Submit proposal</button>
        </form>
      ) : webAuth ? (
        <a
          className="github-sign-in"
          href={`/auth/github?returnTo=${encodeURIComponent(`${returnTo}#proposals`)}`}
        >
          Sign in with GitHub to propose a follow-up
        </a>
      ) : null}
    </section>
  );
}

function PublicationComments({
  gist,
  publication,
  nodeId,
  comments,
  error,
  viewer,
  webAuth,
}: {
  gist: GitHubGist;
  publication: Publication;
  nodeId: string | null;
  comments: PublicationComment[];
  error: string | null;
  viewer: ViewerSession | null;
  webAuth: GitHubWebAuthConfig | null;
}) {
  const visibleComments = comments.filter((comment) => {
    if (comment.proposal || comment.resolution) {
      return false;
    }
    if (!comment.anchor) {
      return true;
    }
    if (comment.anchor.publicationId !== publication.publicationId) {
      return false;
    }
    return (comment.anchor.nodeId ?? null) === nodeId;
  });
  const returnTo = commentReturnPath(gist.id, nodeId);
  const commentAction = `${returnTo}/comments`;
  return (
    <section className="publication-comments" id="comments" aria-labelledby="comments-title">
      <div className="comments-heading">
        <div>
          <p className="comments-kicker">Discussion</p>
          <h2 id="comments-title">
            {visibleComments.length} {visibleComments.length === 1 ? "comment" : "comments"}
          </h2>
        </div>
        <a href={`${gist.html_url}#comments`}>View on GitHub</a>
      </div>
      {error ? (
        <p className="comments-error" role="status">
          {error}
        </p>
      ) : null}
      {visibleComments.length > 0 ? (
        <div className="comments-list">
          {visibleComments.map((comment) => (
            <article className="publication-comment" key={comment.id}>
              <header>
                <a href={comment.user.htmlUrl}>@{comment.user.login}</a>
                {comment.authorAssociation === "OWNER" ? <span>Author</span> : null}
                <time dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time>
              </header>
              <div className="comment-body">
                <SafeMarkdown>{comment.body}</SafeMarkdown>
              </div>
            </article>
          ))}
        </div>
      ) : error ? null : (
        <p className="comments-empty">No comments yet.</p>
      )}
      {viewer ? (
        <div className="comment-composer">
          <form method="post" action={commentAction}>
            <input type="hidden" name="csrfToken" value={viewer.csrfToken} />
            <label htmlFor="comment-body">Comment as @{viewer.login}</label>
            <textarea
              id="comment-body"
              name="body"
              required
              maxLength={MAX_COMMENT_BODY_CHARACTERS}
              rows={5}
            />
            <button type="submit">Post comment</button>
          </form>
          <form className="sign-out-form" method="post" action="/auth/logout">
            <input type="hidden" name="csrfToken" value={viewer.csrfToken} />
            <input type="hidden" name="returnTo" value={`${returnTo}#comments`} />
            <span>Signed in as @{viewer.login}</span>
            <button type="submit">Sign out</button>
          </form>
        </div>
      ) : webAuth ? (
        <a
          className="github-sign-in"
          href={`/auth/github?returnTo=${encodeURIComponent(`${returnTo}#comments`)}`}
        >
          Sign in with GitHub to comment
        </a>
      ) : null}
    </section>
  );
}

function ResearchTreeNav({
  gistId,
  publication,
  revision,
  selectedNodeId,
}: {
  gistId: string;
  publication: ResearchPublication;
  revision: string | null;
  selectedNodeId: string;
}) {
  const children = new Map<string | null, ResearchPublication["research"]["nodes"]>();
  for (const node of publication.research.nodes) {
    const parentId = node.parentId ?? null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
  }
  const renderNode = (nodeId: string): React.ReactNode => {
    const node = publication.research.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return null;
    }
    return (
      <li key={node.id}>
        <a
          className={node.id === selectedNodeId ? "is-selected" : undefined}
          href={publicationNodePath(gistId, revision, node.id)}
          aria-current={node.id === selectedNodeId ? "page" : undefined}
        >
          <span>{node.title}</span>
          {node.status === "complete" ? null : <small>{node.status}</small>}
        </a>
        {(children.get(node.id)?.length ?? 0) > 0 ? (
          <ul>{children.get(node.id)!.map((child) => renderNode(child.id))}</ul>
        ) : null}
      </li>
    );
  };
  return (
    <>
      <p className="research-index-title">Results</p>
      <ul>{renderNode(publication.research.rootNodeId)}</ul>
    </>
  );
}

function publicationNodePath(gistId: string, revision: string | null, nodeId: string) {
  const base = revision
    ? `/p/${encodeURIComponent(gistId)}/r/${encodeURIComponent(revision)}`
    : `/p/${encodeURIComponent(gistId)}`;
  return `${base}/n/${encodeURIComponent(nodeId)}`;
}

function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      skipHtml
      components={{
        a: ({ href, children: label }) => (
          <a href={safeHref(href)} rel="noreferrer">
            {label}
          </a>
        ),
        img: ({ alt }) => <span className="image-omitted">[Image omitted{alt ? `: ${alt}` : ""}]</span>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function safeHref(value?: string) {
  if (!value) {
    return "#";
  }
  try {
    const parsed = new URL(value, "https://qmux.app");
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      ? value
      : "#";
  } catch {
    return "#";
  }
}

function documentPage(input: { title: string; description: string; body: React.ReactNode }) {
  const markup = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content={input.description} />
        <meta property="og:type" content="article" />
        <meta property="og:site_name" content="qmux" />
        <meta property="og:title" content={input.title} />
        <meta property="og:description" content={input.description} />
        <meta name="twitter:card" content="summary" />
        <title>{`${input.title} · qmux`}</title>
        <style>{PAGE_CSS}</style>
      </head>
      <body>{input.body}</body>
    </html>,
  );
  return `<!doctype html>${markup}`;
}

function errorPage(title: string, message: string) {
  return documentPage({
    title,
    description: message,
    body: (
      <main className="error-page">
        <a className="brand" href="/">
          qmux
        </a>
        <h1>{title}</h1>
        <p>{message}</p>
      </main>
    ),
  });
}

async function serveStaticFile(
  response: ServerResponse,
  path: string,
  contentType: string,
  method: string | undefined,
) {
  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.byteLength,
      "Cache-Control": contentType.startsWith("image/") ? "public, max-age=86400" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : body);
  } catch {
    sendHtml(response, 404, errorPage("Not found", "This page does not exist."));
  }
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
  cacheControl = "no-store",
  method?: string,
  extraHeaders?: Record<string, string>,
) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": cacheControl,
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(method === "HEAD" ? undefined : body);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

const PAGE_CSS = `
:root { color-scheme: light dark; --bg:#f7f8f7; --surface:#fff; --text:#202522; --muted:#66706a; --line:#d9dedb; --accent:#177a55; --user:#eef4f1; --code:#edf0ee; }
@media (prefers-color-scheme: dark) { :root { --bg:#151817; --surface:#1d211f; --text:#e7ebe8; --muted:#9da7a1; --line:#353c38; --accent:#66c79d; --user:#222c27; --code:#272c29; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.65 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.publication-header { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:24px; align-items:start; max-width:880px; margin:0 auto; padding:34px 28px 26px; border-bottom:1px solid var(--line); }
.brand { color:var(--text); font-size:17px; font-weight:750; }
.publication-kind { margin:0 0 4px; color:var(--accent); font-size:12px; font-weight:700; text-transform:uppercase; }
h1 { margin:0; font-size:38px; line-height:1.15; font-weight:720; overflow-wrap:anywhere; }
.publication-meta { display:flex; flex-wrap:wrap; gap:8px 16px; margin:12px 0 0; color:var(--muted); font-size:13px; }
.github-link { padding-top:2px; white-space:nowrap; }
.transcript { max-width:880px; margin:0 auto; padding:22px 28px 56px; }
.message { display:grid; grid-template-columns:112px minmax(0,1fr); gap:22px; padding:24px 0; border-bottom:1px solid var(--line); }
.message-label { color:var(--muted); font-size:13px; font-weight:700; overflow-wrap:anywhere; }
.message-assistant .message-label { color:var(--accent); }
.message-body { min-width:0; }
.message-body > :first-child { margin-top:0; }
.message-body > :last-child { margin-bottom:0; }
.message-body p, .message-body ul, .message-body ol, .message-body pre, .message-body table, .message-body blockquote { margin:0 0 16px; }
.message-body pre { overflow:auto; padding:14px 16px; border:1px solid var(--line); border-radius:6px; background:var(--code); }
.message-body code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; }
.message-body :not(pre) > code { padding:2px 5px; border-radius:4px; background:var(--code); }
.message-body table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; }
.message-body th, .message-body td { padding:7px 10px; border:1px solid var(--line); text-align:left; }
.message-body blockquote { margin-left:0; padding-left:16px; border-left:3px solid var(--line); color:var(--muted); }
.image-omitted { color:var(--muted); font-style:italic; }
.publication-footer { max-width:880px; margin:0 auto; padding:20px 28px 44px; color:var(--muted); font-size:13px; }
.publication-comments { max-width:880px; margin:0 auto; padding:32px 28px 18px; border-top:1px solid var(--line); }
.comments-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:18px; }
.comments-kicker { margin:0 0 2px; color:var(--accent); font-size:11px; font-weight:700; text-transform:uppercase; }
.comments-heading h2 { margin:0; font-size:20px; line-height:1.3; }
.comments-heading > a { padding-top:4px; font-size:13px; white-space:nowrap; }
.comments-list { display:grid; }
.publication-comment { padding:18px 0; border-top:1px solid var(--line); }
.publication-comment header { display:flex; flex-wrap:wrap; align-items:center; gap:7px 10px; margin-bottom:9px; color:var(--muted); font-size:12px; }
.publication-comment header > a { font-weight:700; }
.publication-comment header > span { padding:1px 5px; border:1px solid var(--line); border-radius:4px; font-size:10px; }
.publication-comment header time { margin-left:auto; }
.comment-body > :first-child { margin-top:0; }
.comment-body > :last-child { margin-bottom:0; }
.comment-body p, .comment-body ul, .comment-body ol, .comment-body pre, .comment-body blockquote { margin:0 0 12px; }
.comment-body pre { overflow:auto; padding:12px 14px; border:1px solid var(--line); border-radius:6px; background:var(--code); }
.comment-body code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; }
.comment-body :not(pre) > code { padding:2px 5px; border-radius:4px; background:var(--code); }
.comments-empty, .comments-error { margin:0; color:var(--muted); }
.comments-error { color:#a74444; }
.comment-composer { margin-top:24px; padding-top:20px; border-top:1px solid var(--line); }
.comment-composer form:first-child { display:grid; gap:9px; }
.comment-composer label { font-size:13px; font-weight:700; }
.comment-composer textarea { width:100%; min-height:116px; resize:vertical; padding:11px 12px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--text); font:inherit; letter-spacing:0; }
.comment-composer textarea:focus { outline:2px solid color-mix(in srgb,var(--accent) 35%,transparent); outline-offset:1px; border-color:var(--accent); }
.comment-composer button, .github-sign-in { justify-self:start; display:inline-flex; align-items:center; min-height:34px; padding:7px 11px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--text); font:inherit; font-size:13px; font-weight:650; cursor:pointer; }
.comment-composer button:hover, .github-sign-in:hover { border-color:var(--accent); text-decoration:none; }
.sign-out-form { display:flex; align-items:center; gap:10px; margin-top:14px; color:var(--muted); font-size:12px; }
.sign-out-form button { min-height:auto; padding:3px 7px; color:var(--muted); font-size:12px; }
.github-sign-in { margin-top:22px; }
.publication-proposals { margin-top:38px; padding-top:28px; border-top:1px solid var(--line); }
.proposal-list { display:grid; gap:18px; }
.publication-proposal { padding:15px 0 0; border-top:1px solid var(--line); }
.publication-proposal header { display:flex; flex-wrap:wrap; align-items:center; gap:7px 10px; margin-bottom:9px; color:var(--muted); font-size:12px; }
.publication-proposal header time { margin-left:auto; }
.proposal-status { padding:1px 6px; border:1px solid var(--line); border-radius:4px; text-transform:capitalize; }
.proposal-status.is-accepted { color:var(--accent); }
.proposal-status.is-declined { color:#a74444; }
.proposal-question > :first-child { margin-top:0; }
.proposal-question > :last-child { margin-bottom:0; }
.publication-proposal details { margin-top:12px; color:var(--muted); font-size:13px; }
.publication-proposal details summary { cursor:pointer; }
.publication-proposal details .comment-body { margin-top:10px; color:var(--text); font-size:15px; }
.proposal-result-link { display:inline-block; margin-top:12px; font-size:13px; }
.proposal-composer { display:grid; gap:9px; margin-top:24px; padding-top:20px; border-top:1px solid var(--line); }
.proposal-composer label { font-size:13px; font-weight:700; }
.proposal-composer textarea { width:100%; resize:vertical; padding:11px 12px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--text); font:inherit; letter-spacing:0; }
.proposal-composer textarea:focus { outline:2px solid color-mix(in srgb,var(--accent) 35%,transparent); outline-offset:1px; border-color:var(--accent); }
.proposal-composer button { justify-self:start; min-height:34px; padding:7px 11px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--text); font:inherit; font-size:13px; font-weight:650; cursor:pointer; }
.proposal-composer button:hover { border-color:var(--accent); }
.research-publication-header { max-width:1120px; }
.research-layout { display:grid; grid-template-columns:minmax(210px,280px) minmax(0,760px); gap:44px; max-width:1120px; margin:0 auto; padding:30px 28px 60px; }
.research-index { min-width:0; }
.research-index-title { margin:0 0 10px; color:var(--muted); font-size:12px; font-weight:700; text-transform:uppercase; }
.research-index ul { margin:0; padding:0; list-style:none; }
.research-index ul ul { margin:3px 0 3px 14px; padding-left:10px; border-left:1px solid var(--line); }
.research-index a { display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding:7px 8px; border-radius:5px; color:var(--muted); font-size:13px; line-height:1.35; overflow-wrap:anywhere; }
.research-index a:hover { background:var(--surface); color:var(--text); text-decoration:none; }
.research-index a.is-selected { background:var(--user); color:var(--text); font-weight:650; }
.research-index small, .research-children small { color:var(--muted); font-size:11px; font-weight:400; }
.research-result { min-width:0; }
.research-result-nav { display:flex; align-items:center; justify-content:space-between; min-height:28px; margin-bottom:16px; font-size:13px; }
.research-contribution { margin:-6px 0 16px; color:var(--muted); font-size:12px; }
.research-status { padding:2px 7px; border:1px solid var(--line); border-radius:4px; color:var(--muted); font-size:11px; text-transform:capitalize; }
.research-status.is-failed { color:#b94040; }
.research-status.is-cancelled { color:var(--muted); }
.research-answer { min-width:0; }
.research-answer > :first-child { margin-top:0; }
.research-answer > :last-child { margin-bottom:0; }
.research-answer h1 { margin-bottom:24px; font-size:30px; }
.research-answer h2 { margin:30px 0 12px; font-size:20px; line-height:1.3; }
.research-answer h3 { margin:24px 0 10px; font-size:16px; }
.research-answer p, .research-answer ul, .research-answer ol, .research-answer pre, .research-answer table, .research-answer blockquote { margin:0 0 16px; }
.research-answer pre { overflow:auto; padding:14px 16px; border:1px solid var(--line); border-radius:6px; background:var(--code); }
.research-answer code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; }
.research-answer :not(pre) > code { padding:2px 5px; border-radius:4px; background:var(--code); }
.research-answer table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; }
.research-answer th, .research-answer td { padding:7px 10px; border:1px solid var(--line); text-align:left; }
.research-answer blockquote { margin-left:0; padding-left:16px; border-left:3px solid var(--line); color:var(--muted); }
.research-children { margin-top:40px; padding-top:24px; border-top:1px solid var(--line); }
.research-children h2 { margin:0 0 12px; font-size:15px; }
.research-children > div { display:grid; gap:7px; }
.research-children a { display:flex; justify-content:space-between; gap:12px; padding:10px 12px; border:1px solid var(--line); border-radius:6px; color:var(--text); }
.research-children a:hover { border-color:var(--accent); text-decoration:none; }
.research-result > .publication-comments { margin-top:38px; padding:28px 0 0; }
.error-page { max-width:640px; margin:0 auto; padding:64px 28px; }
.error-page h1 { margin-top:40px; }
.error-page p { color:var(--muted); }
@media (max-width:640px) {
  .publication-header { grid-template-columns:1fr auto; gap:14px; padding:24px 18px 20px; }
  .publication-heading { grid-column:1 / -1; grid-row:2; }
  .transcript { padding:8px 18px 40px; }
  .message { grid-template-columns:1fr; gap:8px; padding:20px 0; }
  .publication-footer { padding:18px 18px 36px; }
  .publication-comments { padding:26px 18px 12px; }
  .comments-heading { align-items:baseline; }
  .publication-comment header time { width:100%; margin-left:0; }
  .publication-heading h1, .error-page h1 { font-size:28px; }
  .research-layout { grid-template-columns:1fr; gap:24px; padding:22px 18px 44px; }
  .research-index { padding-bottom:20px; border-bottom:1px solid var(--line); }
  .research-answer h1 { font-size:25px; }
  .research-result > .publication-comments { padding-left:0; padding-right:0; }
}
`;

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const server = createQmuxWebServer();
  server.listen(port, host, () => {
    console.log(`qmux web listening on http://${host}:${port}`);
  });
}
