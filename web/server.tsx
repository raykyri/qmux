import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const GITHUB_API_VERSION = "2026-03-10";
const LATEST_CACHE_MS = 60_000;
const REVISION_CACHE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_GITHUB_API_RESPONSE_BYTES = 20_000_000;
const MAX_PUBLICATION_CACHE_BYTES = 64_000_000;
const MAX_PUBLICATION_CACHE_ENTRIES = 128;
const MAX_CONCURRENT_PUBLICATION_LOADS = 8;
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

interface CachedPublication {
  gist: GitHubGist;
  publication: Publication;
  etag?: string | null;
  expiresAt: number;
  weightBytes: number;
}

interface PublicationCache {
  entries: Map<string, CachedPublication>;
  totalBytes: number;
}

interface ServerOptions {
  fetchImpl?: typeof fetch;
  siteDir?: string;
  githubToken?: string | null;
  now?: () => number;
}

export function createQmuxWebServer(options: ServerOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const siteDir = options.siteDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
  const githubToken = options.githubToken ?? process.env.GITHUB_READER_TOKEN ?? null;
  const cache: PublicationCache = {
    entries: new Map(),
    totalBytes: 0,
  };
  const context: RouteContext = {
    fetchImpl,
    siteDir,
    githubToken,
    now,
    cache,
    activePublicationLoads: 0,
  };

  return createServer(async (request, response) => {
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
      sendHtml(response, status, errorPage("Publication unavailable", message));
    }
  });
}

interface RouteContext {
  fetchImpl: typeof fetch;
  siteDir: string;
  githubToken: string | null;
  now: () => number;
  cache: PublicationCache;
  activePublicationLoads: number;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
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
  if (context.activePublicationLoads >= MAX_CONCURRENT_PUBLICATION_LOADS) {
    throw new PublicationHttpError(
      503,
      "The publication server is busy. Try again shortly.",
    );
  }
  context.activePublicationLoads += 1;
  try {
    const loaded = await loadPublication(route.gistId, route.revision, context);
    const page =
      loaded.publication.kind === "transcript"
        ? transcriptPage(loaded.gist, loaded.publication, route.revision)
        : researchPage(
            loaded.gist,
            loaded.publication,
            route.revision,
            route.nodeId,
          );
    const cacheControl = route.revision
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60, stale-while-revalidate=300";
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
    throw new PublicationHttpError(404, "The requested Gist was not found.");
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
    throw new PublicationHttpError(422, `This Gist does not contain ${PUBLICATION_INDEX_FILE}.`);
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
  ) {
    super(message);
  }
}

function transcriptPage(
  gist: GitHubGist,
  publication: TranscriptPublication,
  revision: string | null,
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
          </main>
        </div>
        <footer className="publication-footer">
          Published with <a href="/">qmux</a>
        </footer>
      </>
    ),
  });
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
) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": cacheControl,
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
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
.error-page { max-width:640px; margin:0 auto; padding:64px 28px; }
.error-page h1 { margin-top:40px; }
.error-page p { color:var(--muted); }
@media (max-width:640px) {
  .publication-header { grid-template-columns:1fr auto; gap:14px; padding:24px 18px 20px; }
  .publication-heading { grid-column:1 / -1; grid-row:2; }
  .transcript { padding:8px 18px 40px; }
  .message { grid-template-columns:1fr; gap:8px; padding:20px 0; }
  .publication-footer { padding:18px 18px 36px; }
  .publication-heading h1, .error-page h1 { font-size:28px; }
  .research-layout { grid-template-columns:1fr; gap:24px; padding:22px 18px 44px; }
  .research-index { padding-bottom:20px; border-bottom:1px solid var(--line); }
  .research-answer h1 { font-size:25px; }
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
