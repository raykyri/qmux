import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
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
import { createQmuxWebServer } from "./server";

const pane: PaneInfo = {
  id: "pane-1",
  title: "Test transcript",
  kind: "agent",
  agentId: "agent-1",
  groupId: "group-1",
  cwd: "/tmp/project",
  cols: 80,
  rows: 24,
  status: "running",
};

const agent: AgentInfo = {
  id: "agent-1",
  groupId: "group-1",
  adapter: "codex",
  worktreeDir: "/tmp/project",
  paneId: pane.id,
  status: "idle",
  createdAt: 1,
};

function turn(id: string, role: string, text: string): Turn {
  return {
    id,
    agentId: agent.id,
    role,
    blocks: [{ type: "text", text }],
    sourceIndex: Number(id.split("-").at(-1) ?? 0),
  };
}

test("the public server renders a valid transcript without executing raw HTML", async (t) => {
  const draft = await createTranscriptPublicationDraft({
    title: "Server render",
    pane,
    agent,
    assistantLabel: "Codex",
    publicationId: "pub_abcdefgh",
    createdAt: "2026-07-16T12:00:00.000Z",
    turns: [
      turn("turn-1", "user", "Question"),
      turn("turn-2", "assistant", "Answer <script>alert('no')</script>"),
    ],
  });
  const index = draft.files["publication.json"];
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "abcde12345",
        html_url: "https://gist.github.com/octocat/abcde12345",
        public: false,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: {
          "publication.json": {
            filename: "publication.json",
            size: Buffer.byteLength(index),
            content: index,
            truncated: false,
          },
        },
        owner: {
          login: "octocat",
          html_url: "https://github.com/octocat",
        },
      }),
      { status: 200, headers: { ETag: '"v1"' } },
    );
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/p/abcde12345`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Server render/);
  assert.match(body, /octocat/);
  assert.equal(body.includes("<script>alert"), false);
  assert.equal(body.includes("Answer"), true);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("the public server renders deep-linked research nodes and verifies their files", async (t) => {
  const root: ResearchNode = {
    id: "private-root",
    treeId: "private-tree",
    prompt: "Root question",
    title: "Root result",
    adapter: "codex",
    groupId: "private-group",
    worktreeDir: "/private/research",
    status: "complete",
    createdAt: 1,
    highlights: [],
  };
  const child: ResearchNode = {
    ...root,
    id: "private-child",
    parentNodeId: root.id,
    prompt: "Child question",
    title: "Child result",
    createdAt: 2,
  };
  const detail: ResearchTreeDetail = {
    tree: {
      id: "private-tree",
      title: "Research render",
      rootNodeId: root.id,
      workspaceId: "private-workspace",
      createdAt: 1,
      updatedAt: 2,
    },
    nodes: [root, child],
  };
  const content = (node: ResearchNode, answer: string, revision: string) => ({
    node,
    turns: [
      {
        id: `${node.id}-turn`,
        agentId: "private-agent",
        role: "assistant",
        blocks: [{ type: "text" as const, text: answer }],
        sourceIndex: 1,
      },
    ],
    children: [],
    responseRevision: revision,
  });
  const draft = await createResearchPublicationDraft({
    title: detail.tree.title,
    detail,
    selectedNodeId: child.id,
    mode: "tree",
    publicationId: "pub_render1234",
    createdAt: "2026-07-16T12:00:00.000Z",
    contents: [
      content(root, "Root **answer**.", "a".repeat(64)),
      content(child, "Child answer <script>alert('no')</script>", "b".repeat(64)),
    ],
  });
  assert.equal(draft.publication.kind, "research-tree");
  if (draft.publication.kind !== "research-tree") {
    assert.fail("expected research tree");
  }
  const selectedNodeId = draft.publication.research.selectedNodeId!;
  const gistFiles = Object.fromEntries(
    Object.entries(draft.files).map(([filename, fileContent]) => [
      filename,
      {
        filename,
        size: Buffer.byteLength(fileContent),
        content: fileContent,
        truncated: false,
      },
    ]),
  );
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "research12345",
        html_url: "https://gist.github.com/octocat/research12345",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: gistFiles,
        owner: {
          login: "octocat",
          html_url: "https://github.com/octocat",
        },
      }),
      { status: 200, headers: { ETag: '"research-v1"' } },
    );
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(
    `http://127.0.0.1:${address.port}/p/research12345/n/${selectedNodeId}`,
  );
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Research render/);
  assert.match(body, /Child result/);
  assert.match(body, /Child answer/);
  assert.match(body, /Parent/);
  assert.equal(body.includes("<script>alert"), false);
});

test("the public server rejects a research file that does not match publication.json", async (t) => {
  const answerFile = "node_abcdefgh.md";
  const index = JSON.stringify({
    schemaVersion: 1,
    publicationId: "pub_tamper1234",
    kind: "research-answer",
    title: "Tampered",
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    contentHash: "0".repeat(64),
    research: {
      rootNodeId: "node_abcdefgh",
      selectedNodeId: "node_abcdefgh",
      nodes: [
        {
          id: "node_abcdefgh",
          parentId: null,
          kind: "run",
          title: "Result",
          prompt: "Question",
          answerFile,
          contentHash: "f".repeat(64),
          responseRevision: "a".repeat(64),
          status: "complete",
          createdAt: 1,
        },
      ],
    },
  });
  const parsed = JSON.parse(index);
  const { canonicalJson } = await import("../src/lib/publication");
  const { createHash } = await import("node:crypto");
  const unhashed = { ...parsed };
  delete unhashed.contentHash;
  parsed.contentHash = createHash("sha256").update(canonicalJson(unhashed)).digest("hex");
  const validIndex = `${JSON.stringify(parsed)}\n`;
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "tamper12345",
        html_url: "https://gist.github.com/octocat/tamper12345",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: {
          "publication.json": {
            filename: "publication.json",
            size: Buffer.byteLength(validIndex),
            content: validIndex,
          },
          [answerFile]: {
            filename: answerFile,
            size: 8,
            content: "tampered",
          },
        },
      }),
      { status: 200 },
    );
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/p/tamper12345`);
  assert.equal(response.status, 422);
  assert.match(await response.text(), /invalid content hash/);
});

test("the public server reports malformed publication.json as unprocessable", async (t) => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "malformed12",
        html_url: "https://gist.github.com/octocat/malformed12",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: {
          "publication.json": {
            filename: "publication.json",
            size: 8,
            content: "not json",
          },
        },
      }),
      { status: 200 },
    );
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/p/malformed12`);
  assert.equal(response.status, 422);
  assert.match(await response.text(), /not valid JSON/);
});

test("the public server follows a trusted raw URL for truncated publication.json", async (t) => {
  const draft = await createTranscriptPublicationDraft({
    title: "Raw fallback",
    pane,
    agent,
    assistantLabel: "Codex",
    publicationId: "pub_rawfallback",
    createdAt: "2026-07-16T12:00:00.000Z",
    turns: [turn("turn-1", "assistant", "Loaded from the raw file.")],
  });
  const index = draft.files["publication.json"];
  let fetchCount = 0;
  const fetchImpl: typeof fetch = async (url) => {
    fetchCount += 1;
    if (String(url).startsWith("https://api.github.com/")) {
      return new Response(
        JSON.stringify({
          id: "rawfallback1",
          html_url: "https://gist.github.com/octocat/rawfallback1",
          public: true,
          created_at: "2026-07-16T12:00:00Z",
          updated_at: "2026-07-16T12:00:00Z",
          files: {
            "publication.json": {
              filename: "publication.json",
              size: Buffer.byteLength(index),
              truncated: true,
              raw_url:
                "https://gist.githubusercontent.com/octocat/rawfallback1/raw/publication.json",
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(index, { status: 200 });
  };
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/p/rawfallback1`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Loaded from the raw file/);
  assert.equal(fetchCount, 2);
});

test("the public server refuses truncated files from non-GitHub raw hosts", async (t) => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "rawuntrusted1",
        html_url: "https://gist.github.com/octocat/rawuntrusted1",
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: {
          "publication.json": {
            filename: "publication.json",
            size: 100,
            truncated: true,
            raw_url: "https://example.com/publication.json",
          },
        },
      }),
      { status: 200 },
    );
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/p/rawuntrusted1`);
  assert.equal(response.status, 422);
  assert.match(await response.text(), /untrusted raw URL/);
});

test("the public server rejects an oversized GitHub API response before reading it", async (t) => {
  const fetchImpl: typeof fetch = async () =>
    new Response("{}", {
      status: 200,
      headers: { "Content-Length": "20000001" },
    });
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/p/oversized1`);
  assert.equal(response.status, 413);
  assert.match(await response.text(), /too large/);
});

test("the public server evicts old publication cache entries", async (t) => {
  const draft = await createTranscriptPublicationDraft({
    title: "Cache entry",
    pane,
    agent,
    assistantLabel: "Codex",
    publicationId: "pub_cacheentry",
    createdAt: "2026-07-16T12:00:00.000Z",
    turns: [turn("turn-1", "assistant", "Cached answer")],
  });
  const index = draft.files["publication.json"];
  let fetchCount = 0;
  const fetchImpl: typeof fetch = async (url) => {
    fetchCount += 1;
    const gistId = String(url).split("/").at(-1)!;
    return new Response(
      JSON.stringify({
        id: gistId,
        html_url: `https://gist.github.com/octocat/${gistId}`,
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: {
          "publication.json": {
            filename: "publication.json",
            size: Buffer.byteLength(index),
            content: index,
          },
        },
      }),
      { status: 200 },
    );
  };
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  for (let index = 0; index < 129; index += 1) {
    const gistId = `cache${index.toString().padStart(4, "0")}`;
    const pageResponse: Response = await fetch(
      `http://127.0.0.1:${address.port}/p/${gistId}`,
    );
    assert.equal(pageResponse.status, 200);
    await pageResponse.arrayBuffer();
  }
  const repeated = await fetch(`http://127.0.0.1:${address.port}/p/cache0000`);
  assert.equal(repeated.status, 200);
  assert.equal(fetchCount, 130);
});

test("the public server caps concurrent publication loads", async (t) => {
  const draft = await createTranscriptPublicationDraft({
    title: "Concurrent load",
    pane,
    agent,
    assistantLabel: "Codex",
    publicationId: "pub_concurrent1",
    createdAt: "2026-07-16T12:00:00.000Z",
    turns: [turn("turn-1", "assistant", "Concurrent answer")],
  });
  const index = draft.files["publication.json"];
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl: typeof fetch = async (url) => {
    started += 1;
    await gate;
    const gistId = String(url).split("/").at(-1)!;
    return new Response(
      JSON.stringify({
        id: gistId,
        html_url: `https://gist.github.com/octocat/${gistId}`,
        public: true,
        created_at: "2026-07-16T12:00:00Z",
        updated_at: "2026-07-16T12:00:00Z",
        files: {
          "publication.json": {
            filename: "publication.json",
            size: Buffer.byteLength(index),
            content: index,
          },
        },
      }),
      { status: 200 },
    );
  };
  const server = createQmuxWebServer({ fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const activeRequests = Array.from({ length: 8 }, (_, index) =>
    fetch(`http://127.0.0.1:${address.port}/p/concurrent${index}`),
  );
  while (started < 8) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const busyResponse = await fetch(
    `http://127.0.0.1:${address.port}/p/concurrent8`,
  );
  assert.equal(busyResponse.status, 503);
  release();
  const responses = await Promise.all(activeRequests);
  for (const response of responses) {
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});
