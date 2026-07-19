import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  encodeProposalResolution,
  encodeResearchProposal,
  parseResearchProposal,
  researchProposalDigestInput,
} from "../src/lib/publicationComments";
import {
  createResearchPublicationDraft,
  createTranscriptPublicationDraft,
} from "../src/lib/publicationDrafts";
import type {
  AgentInfo,
  PaneInfo,
  ResearchNode,
  ResearchTreeDetail,
  Turn,
} from "../src/types";
import { safeReturnTo } from "./githubAuth";
import { createQmuxRequestHandler } from "./server";

const pane: PaneInfo = {
  id: "pane-comments",
  title: "Comments",
  kind: "agent",
  agentId: "agent-comments",
  groupId: "group-comments",
  cwd: "/tmp/project",
  cols: 80,
  rows: 24,
  status: "running",
};

const agent: AgentInfo = {
  id: "agent-comments",
  groupId: pane.groupId,
  adapter: "codex",
  worktreeDir: pane.cwd,
  paneId: pane.id,
  status: "idle",
  createdAt: 1,
};

function turn(text: string): Turn {
  return {
    id: "turn-comments",
    agentId: agent.id,
    role: "assistant",
    blocks: [{ type: "text", text }],
    sourceIndex: 1,
  };
}

test("transcripts render without the comment bridge", async () => {
  const draft = await createTranscriptPublicationDraft({
    title: "Commented transcript",
    pane,
    agent,
    assistantLabel: "Codex",
    publicationId: "pub_comments123",
    createdAt: "2026-07-16T12:00:00.000Z",
    turns: [turn("Published answer")],
  });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/comments")) {
      throw new Error("transcript pages must not fetch gist comments");
    }
    if (url.endsWith("/gists/comment12345")) {
      return Response.json({
        id: "comment12345",
        html_url: "https://gist.github.com/octocat/comment12345",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: Object.fromEntries(
          Object.entries(draft.files).map(([filename, content]) => [
            filename,
            {
              filename,
              size: Buffer.byteLength(content),
              content,
              truncated: false,
            },
          ]),
        ),
        owner: {
          login: "octocat",
          html_url: "https://github.com/octocat",
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const handler = createQmuxRequestHandler({
    fetchImpl,
    githubToken: "reader-token",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    sessionSecret: "a".repeat(32),
    publicOrigin: "https://qmux.app",
    secureCookies: false,
  });

  const page = await dispatch(handler, request("GET", "/p/comment12345"));
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Published answer/);
  assert.equal(page.body.includes("publication-comments"), false);
  assert.equal(page.body.includes("Comment as"), false);

  // The comment POST route is gone; only proposals accept POSTs.
  const create = await dispatch(
    handler,
    request(
      "POST",
      "/p/comment12345/comments",
      new URLSearchParams({ body: "hello" }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    ),
  );
  assert.equal(create.statusCode, 405);
});


// Comment fetching now only serves research-tree proposals, so pagination
// behavior is exercised against a minimal published tree.
async function researchFixture(publicationId: string, title: string) {
  const root: ResearchNode = {
    id: `${publicationId}-root`,
    treeId: `${publicationId}-tree`,
    prompt: "Root question",
    title: "Root result",
    adapter: "codex",
    groupId: "private-group",
    worktreeDir: "/private/research",
    status: "complete",
    createdAt: 1,
    highlights: [],
  };
  const detail: ResearchTreeDetail = {
    tree: {
      id: root.treeId,
      title,
      rootNodeId: root.id,
      workspaceId: "private-workspace",
      createdAt: 1,
      updatedAt: 1,
    },
    nodes: [root],
  };
  const draft = await createResearchPublicationDraft({
    title,
    detail,
    selectedNodeId: root.id,
    mode: "tree",
    publicationId,
    createdAt: "2026-07-16T12:00:00.000Z",
    contents: [
      {
        node: root,
        turns: [
          {
            id: `${publicationId}-turn`,
            agentId: "private-agent",
            role: "assistant",
            blocks: [{ type: "text" as const, text: "Root answer." }],
            sourceIndex: 1,
          },
        ],
        children: [],
        responseRevision: "a".repeat(64),
      },
    ],
  });
  if (draft.publication.kind !== "research-tree") {
    throw new Error("expected research tree");
  }
  return { draft, publicRootId: draft.publication.research.rootNodeId };
}

test("comment pagination is capped even when every upstream comment is invalid", async () => {
  const { draft } = await researchFixture("pub_bounded123", "Bounded comments");
  let commentPages = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/gists/bounded12345")) {
      return Response.json({
        id: "bounded12345",
        html_url: "https://gist.github.com/octocat/bounded12345",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: Object.fromEntries(
          Object.entries(draft.files).map(([filename, content]) => [
            filename,
            { filename, size: Buffer.byteLength(content), content },
          ]),
        ),
      });
    }
    if (url.includes("/gists/bounded12345/comments?")) {
      commentPages += 1;
      return Response.json(
        Array.from({ length: 100 }, (_, index) => ({
          id: 0,
          body: `invalid ${index}`,
          created_at: "2026-07-16T12:30:00Z",
          updated_at: "2026-07-16T12:30:00Z",
          user: { login: "octocat" },
        })),
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const handler = createQmuxRequestHandler({
    fetchImpl,
    githubToken: "reader-token",
  });

  const page = await dispatch(
    handler,
    request("GET", "/p/bounded12345"),
  );
  assert.equal(page.statusCode, 200);
  assert.equal(commentPages, 3);
});

test("comment pagination keeps the newest bounded page window", async () => {
  const { draft, publicRootId } = await researchFixture(
    "pub_newest123",
    "Newest proposals",
  );
  const requestedPages: number[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/gists/newest12345") {
      return Response.json({
        id: "newest12345",
        html_url: "https://gist.github.com/octocat/newest12345",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: Object.fromEntries(
          Object.entries(draft.files).map(([filename, content]) => [
            filename,
            { filename, size: Buffer.byteLength(content), content },
          ]),
        ),
      });
    }
    if (url.pathname === "/gists/newest12345/comments") {
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      const comments =
        page === 6
          ? [
              {
                id: 601,
                body: encodeResearchProposal({
                  publicationId: draft.publication.publicationId,
                  parentNodeId: publicRootId,
                  prompt: "Newest visible proposal",
                }),
                created_at: "2026-07-16T13:00:00Z",
                updated_at: "2026-07-16T13:00:00Z",
                user: { login: "alice" },
              },
            ]
          : Array.from({ length: 100 }, (_, index) => ({
              id: page === 1 ? index + 1 : 0,
              body: page === 1 ? `Old comment ${index}` : "invalid",
              created_at: "2026-07-16T12:30:00Z",
              updated_at: "2026-07-16T12:30:00Z",
              user: { login: "octocat" },
            }));
      return Response.json(comments, {
        headers:
          page === 1
            ? {
                Link: '<https://api.github.com/gists/newest12345/comments?per_page=100&page=6>; rel="last"',
              }
            : undefined,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const handler = createQmuxRequestHandler({
    fetchImpl,
    githubToken: "reader-token",
  });

  const page = await dispatch(
    handler,
    request("GET", "/p/newest12345"),
  );
  assert.equal(page.statusCode, 200);
  assert.deepEqual(requestedPages, [1, 4, 5, 6]);
  assert.match(page.body, /Newest visible proposal/);
  assert.equal(page.body.includes("Old comment 0"), false);
});

test("published research accepts structured follow-up proposals and owner resolutions", async () => {
  const root: ResearchNode = {
    id: "private-proposal-root",
    treeId: "private-proposal-tree",
    prompt: "Root question",
    title: "Root result",
    adapter: "codex",
    groupId: "private-group",
    worktreeDir: "/private/research",
    status: "complete",
    createdAt: 1,
    highlights: [],
  };
  const detail: ResearchTreeDetail = {
    tree: {
      id: root.treeId,
      title: "Proposal research",
      rootNodeId: root.id,
      workspaceId: "private-workspace",
      createdAt: 1,
      updatedAt: 1,
    },
    nodes: [root],
  };
  const draft = await createResearchPublicationDraft({
    title: detail.tree.title,
    detail,
    selectedNodeId: root.id,
    mode: "tree",
    publicationId: "pub_proposal123",
    createdAt: "2026-07-16T12:00:00.000Z",
    contents: [
      {
        node: root,
        turns: [
          {
            id: "proposal-answer",
            agentId: "private-agent",
            role: "assistant",
            blocks: [{ type: "text", text: "Root answer." }],
            sourceIndex: 1,
          },
        ],
        children: [],
        responseRevision: "a".repeat(64),
      },
    ],
  });
  assert.equal(draft.publication.kind, "research-tree");
  if (draft.publication.kind !== "research-tree") {
    assert.fail("expected research tree");
  }
  const publicRootId = draft.publication.research.rootNodeId;
  const acceptedProposal = {
    publicationId: draft.publication.publicationId,
    parentNodeId: publicRootId,
    prompt: "What evidence would change this answer?",
    answerMarkdown: "A contributor's initial view.",
  };
  const acceptedProposalDigest = createHash("sha256")
    .update(researchProposalDigestInput(acceptedProposal))
    .digest("hex");
  const editedProposal = {
    publicationId: draft.publication.publicationId,
    parentNodeId: publicRootId,
    prompt: "Edited after the owner reviewed it.",
  };
  const preEditProposalDigest = createHash("sha256")
    .update(
      researchProposalDigestInput({
        ...editedProposal,
        prompt: "Original text the owner reviewed.",
      }),
    )
    .digest("hex");
  let createdProposal = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho_proposer", scope: "gist" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "alice" });
    }
    if (url.endsWith("/gists/proposal12345")) {
      return Response.json({
        id: "proposal12345",
        html_url: "https://gist.github.com/octocat/proposal12345",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: Object.fromEntries(
          Object.entries(draft.files).map(([filename, content]) => [
            filename,
            { filename, size: Buffer.byteLength(content), content },
          ]),
        ),
        owner: {
          login: "octocat",
          html_url: "https://github.com/octocat",
        },
      });
    }
    if (url.includes("/gists/proposal12345/comments?")) {
      return Response.json([
        {
          id: 21,
          body: encodeResearchProposal(acceptedProposal),
          created_at: "2026-07-16T12:30:00Z",
          updated_at: "2026-07-16T12:30:00Z",
          user: { login: "bob", html_url: "https://github.com/bob" },
        },
        {
          id: 22,
          body: encodeProposalResolution({
            publicationId: draft.publication.publicationId,
            proposalCommentId: 21,
            proposalDigest: acceptedProposalDigest,
            status: "accepted",
          }),
          created_at: "2026-07-16T12:40:00Z",
          updated_at: "2026-07-16T12:40:00Z",
          user: { login: "octocat", html_url: "https://github.com/octocat" },
        },
        {
          id: 24,
          body: encodeResearchProposal(editedProposal),
          created_at: "2026-07-16T12:50:00Z",
          updated_at: "2026-07-16T13:10:00Z",
          user: { login: "carol", html_url: "https://github.com/carol" },
        },
        {
          id: 25,
          body: encodeProposalResolution({
            publicationId: draft.publication.publicationId,
            proposalCommentId: 24,
            proposalDigest: preEditProposalDigest,
            status: "accepted",
          }),
          created_at: "2026-07-16T13:00:00Z",
          updated_at: "2026-07-16T13:00:00Z",
          user: { login: "octocat", html_url: "https://github.com/octocat" },
        },
      ]);
    }
    if (
      url.endsWith("/gists/proposal12345/comments") &&
      init?.method === "POST"
    ) {
      createdProposal = JSON.parse(String(init.body)).body;
      return Response.json({ id: 23 }, { status: 201 });
    }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  };
  const handler = createQmuxRequestHandler({
    fetchImpl,
    githubToken: "reader-token",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    sessionSecret: "b".repeat(32),
    publicOrigin: "https://qmux.app",
    secureCookies: false,
  });
  const begin = await dispatch(
    handler,
    request("GET", `/auth/github?returnTo=%2Fp%2Fproposal12345%2Fn%2F${publicRootId}`),
  );
  const authorizationUrl = new URL(begin.header("location"));
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);
  const callback = await dispatch(
    handler,
    request(
      "GET",
      `/auth/github/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      "",
      { cookie: cookiePair(begin.setCookies(), "qmux_oauth_state") },
    ),
  );
  const sessionCookie = cookiePair(callback.setCookies(), "qmux_session");
  const page = await dispatch(
    handler,
    request("GET", `/p/proposal12345/n/${publicRootId}`, "", {
      cookie: sessionCookie,
    }),
  );
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /What evidence would change this answer/);
  assert.match(page.body, /Edited after the owner reviewed it/);
  assert.equal(
    page.body.match(/proposal-status is-accepted/g)?.length,
    1,
  );
  assert.equal(
    page.body.match(/proposal-status is-pending/g)?.length,
    1,
  );
  assert.match(page.body, /Propose a follow-up…/);
  assert.match(page.body, /as @alice/);
  const csrfToken = page.body.match(/name="csrfToken" value="([^"]+)"/)?.[1];
  assert.ok(csrfToken);

  const create = await dispatch(
    handler,
    request(
      "POST",
      `/p/proposal12345/n/${publicRootId}/proposals`,
      new URLSearchParams({
        csrfToken,
        prompt: "A second follow-up?",
        answerMarkdown: "Optional answer.",
      }).toString(),
      {
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
    ),
  );
  assert.equal(create.statusCode, 303);
  assert.deepEqual(parseResearchProposal(createdProposal), {
    publicationId: draft.publication.publicationId,
    parentNodeId: publicRootId,
    prompt: "A second follow-up?",
    answerMarkdown: "Optional answer.",
  });

  // The sign-out affordance now lives beside the proposal composer.
  assert.match(page.body, /Signed in as @alice/);
  const logout = await dispatch(
    handler,
    request(
      "POST",
      "/auth/logout",
      new URLSearchParams({
        csrfToken,
        returnTo: `/p/proposal12345/n/${publicRootId}`,
      }).toString(),
      {
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
    ),
  );
  assert.equal(logout.statusCode, 303);
  assert.match(
    logout.setCookies().find((value) => value.startsWith("qmux_session=")) ?? "",
    /Max-Age=0/,
  );
});

test("OAuth return paths reject response-header control characters", () => {
  assert.equal(safeReturnTo("/p/comment12345#comments"), "/p/comment12345#comments");
  assert.equal(safeReturnTo("/p/comment12345\r\nX-Test: injected"), "/");
  assert.equal(safeReturnTo("//example.com"), "/");
});

type RequestHandler = ReturnType<typeof createQmuxRequestHandler>;

function request(
  method: string,
  url: string,
  body = "",
  headers: Record<string, string> = {},
) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(stream, {
    method,
    url,
    headers,
  }) as unknown as IncomingMessage;
}

async function dispatch(handler: RequestHandler, incoming: IncomingMessage) {
  const response = new MemoryResponse();
  await handler(incoming, response as unknown as ServerResponse);
  return response;
}

class MemoryResponse {
  statusCode = 200;
  body = "";
  private readonly headers = new Map<string, string | string[] | number>();

  setHeader(name: string, value: string | string[] | number) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }

  writeHead(
    statusCode: number,
    headers?: Record<string, string | string[] | number>,
  ) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers ?? {})) {
      this.setHeader(name, value);
    }
    return this;
  }

  end(chunk?: string | Buffer) {
    if (chunk !== undefined) {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    }
    return this;
  }

  header(name: string) {
    const value = this.getHeader(name);
    return Array.isArray(value) ? value[0] : String(value ?? "");
  }

  setCookies() {
    const value = this.getHeader("set-cookie");
    return Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
  }
}

function cookiePair(cookies: string[], name: string) {
  const value = cookies.find((item) => item.startsWith(`${name}=`));
  assert.ok(value, `expected ${name} cookie`);
  return value.split(";", 1)[0];
}
