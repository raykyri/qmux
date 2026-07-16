import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PUBLICATION_FILE_BYTES,
  PUBLICATION_INDEX_FILE,
  PUBLICATION_README_FILE,
  PUBLICATION_TRANSCRIPT_FILE,
  parsePublicationJson,
  validatePublication,
  validatePublicationFiles,
} from "../src/lib/publication";
import {
  createResearchPublicationDraft,
  createTranscriptPublicationDraft,
} from "../src/lib/publicationDrafts";
import type {
  AgentInfo,
  PaneInfo,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  Turn,
} from "../src/types";

const pane: PaneInfo = {
  id: "pane-1",
  title: "Publishing design",
  kind: "agent",
  agentId: "agent-1",
  groupId: "group-1",
  cwd: "/private/project",
  cols: 100,
  rows: 24,
  status: "running",
};

const agent: AgentInfo = {
  id: "agent-1",
  groupId: "group-1",
  adapter: "codex",
  worktreeDir: "/private/project",
  paneId: "pane-1",
  sessionId: "private-session",
  transcriptPath: "/private/transcript.jsonl",
  status: "idle",
  createdAt: 1,
};

function turn(id: string, role: string, blocks: Turn["blocks"]): Turn {
  return {
    id,
    agentId: agent.id,
    sessionId: agent.sessionId,
    role,
    blocks,
    sourceIndex: Number(id.split("-").at(-1) ?? 0),
  };
}

test("transcript publications include only the redacted public projection", async () => {
  const draft = await createTranscriptPublicationDraft({
    title: "  Publishing   design  ",
    pane,
    agent,
    assistantLabel: "Codex",
    publicationId: "pub_12345678",
    createdAt: "2026-07-16T12:00:00.000Z",
    turns: [
      turn("turn-1", "system", [{ type: "text", text: "hidden system prompt" }]),
      turn("turn-2", "user", [{ type: "text", text: "What should we publish?" }]),
      turn("turn-3", "assistant", [
        { type: "toolUse", id: "tool-1", name: "Read", input: { path: "/private/key" } },
        { type: "raw", value: { thinking: "private reasoning" } },
        { type: "text", text: "Only the **answer**." },
      ]),
      turn("turn-4", "user", [
        {
          type: "text",
          text: "<system-reminder>secret</system-reminder>\n\nVisible follow-up",
        },
      ]),
    ],
  });

  assert.deepEqual(Object.keys(draft.files).sort(), [
    PUBLICATION_README_FILE,
    PUBLICATION_INDEX_FILE,
    PUBLICATION_TRANSCRIPT_FILE,
  ].sort());
  assert.equal(draft.publication.kind, "transcript");
  assert.equal(draft.publication.title, "Publishing design");
  assert.equal(draft.previewText.includes("hidden system prompt"), false);
  assert.equal(draft.previewText.includes("/private/key"), false);
  assert.equal(draft.previewText.includes("private reasoning"), false);
  assert.equal(draft.previewText.includes("Visible follow-up"), true);

  const serialized = draft.files[PUBLICATION_INDEX_FILE];
  assert.equal(serialized.includes(agent.worktreeDir), false);
  assert.equal(serialized.includes(agent.sessionId!), false);
  assert.equal(serialized.includes(agent.transcriptPath!), false);
  assert.deepEqual(parsePublicationJson(serialized), draft.publication);
});

test("publication file validation rejects paths and oversized files", () => {
  assert.throws(
    () =>
      validatePublicationFiles({
        [PUBLICATION_INDEX_FILE]: "{}",
        [PUBLICATION_README_FILE]: "ok",
        "../secret.txt": "no",
      }),
    /invalid format/,
  );
  assert.throws(
    () =>
      validatePublicationFiles({
        [PUBLICATION_INDEX_FILE]: "x".repeat(MAX_PUBLICATION_FILE_BYTES + 1),
        [PUBLICATION_README_FILE]: "ok",
      }),
    /exceeds/,
  );
});

function researchNode(
  id: string,
  parentNodeId: string | null,
  prompt: string,
  title: string,
): ResearchNode {
  return {
    id,
    treeId: "private-tree-id",
    parentNodeId,
    prompt,
    title,
    responsePreview: "Private preview",
    adapter: "codex",
    model: "private-model",
    groupId: "private-group",
    worktreeDir: "/private/research-worktree",
    nativeSessionId: "private-session",
    transcriptPath: "/private/research.jsonl",
    agentId: "private-agent",
    paneId: "private-pane",
    threadId: "private-thread",
    status: "complete",
    responseSnapshotAt: 1,
    createdAt: parentNodeId ? 2 : 1,
    completedAt: 3,
    highlights: [],
  };
}

function researchContent(
  node: ResearchNode,
  answer: string,
  revision: string,
): ResearchNodeContent {
  return {
    node,
    turns: [
      {
        id: `${node.id}-answer`,
        agentId: node.agentId!,
        sessionId: node.nativeSessionId,
        role: "assistant",
        blocks: [{ type: "text", text: answer }],
        sourceIndex: 1,
      },
    ],
    children: [],
    responseRevision: revision,
  };
}

test("research tree publications expose only public topology and readable node files", async () => {
  const root = researchNode(
    "private-root-node",
    null,
    "What is the publishing architecture?",
    "Publishing architecture",
  );
  const child = researchNode(
    "private-child-node",
    root.id,
    "How should updates work?",
    "Incremental updates",
  );
  const detail: ResearchTreeDetail = {
    tree: {
      id: "private-tree-id",
      title: "Publishing research",
      rootNodeId: root.id,
      workspaceId: "private-workspace",
      createdAt: 1,
      updatedAt: 3,
    },
    nodes: [root, child],
  };
  const draft = await createResearchPublicationDraft({
    title: "Publishing research",
    detail,
    selectedNodeId: child.id,
    mode: "tree",
    publicationId: "pub_research123",
    createdAt: "2026-07-16T12:00:00.000Z",
    contents: [
      researchContent(root, "Use a **versioned** public manifest.", "a".repeat(64)),
      researchContent(child, "Compare durable response revisions.", "b".repeat(64)),
    ],
  });

  assert.equal(draft.publication.kind, "research-tree");
  if (draft.publication.kind !== "research-tree") {
    assert.fail("expected research publication");
  }
  assert.equal(draft.publication.research.nodes.length, 2);
  const publishedRoot = draft.publication.research.nodes.find(
    (node) => node.id === draft.publication.research.rootNodeId,
  );
  const publishedChild = draft.publication.research.nodes.find(
    (node) => node.id === draft.publication.research.selectedNodeId,
  );
  assert.ok(publishedRoot);
  assert.ok(publishedChild);
  assert.equal(publishedChild.parentId, publishedRoot.id);
  assert.equal(publishedChild.responseRevision, "b".repeat(64));
  assert.match(draft.files[publishedChild.answerFile], /Compare durable response revisions/);
  assert.match(draft.files[PUBLICATION_README_FILE], /Incremental updates/);

  const publicFiles = JSON.stringify(draft.files);
  for (const privateValue of [
    detail.tree.id,
    root.id,
    child.id,
    root.worktreeDir,
    root.nativeSessionId!,
    root.transcriptPath!,
    root.agentId!,
  ]) {
    assert.equal(publicFiles.includes(privateValue), false);
  }
  assert.equal(draft.publicNodeIds[root.id], publishedRoot.id);
  assert.equal(draft.publicNodeIds[child.id], publishedChild.id);
  assert.deepEqual(
    parsePublicationJson(draft.files[PUBLICATION_INDEX_FILE]),
    draft.publication,
  );
});

test("research answer publications detach the selected result from private ancestry", async () => {
  const root = researchNode("private-root-answer", null, "Root?", "Root");
  const child = researchNode("private-child-answer", root.id, "Follow-up?", "Follow-up");
  const detail: ResearchTreeDetail = {
    tree: {
      id: "private-answer-tree",
      title: "Answer tree",
      rootNodeId: root.id,
      workspaceId: "private-workspace",
      createdAt: 1,
      updatedAt: 2,
    },
    nodes: [root, child],
  };
  const draft = await createResearchPublicationDraft({
    title: "Selected answer",
    detail,
    selectedNodeId: child.id,
    mode: "answer",
    publicationId: "pub_answer1234",
    createdAt: "2026-07-16T12:00:00.000Z",
    contents: [researchContent(child, "The selected result.", "c".repeat(64))],
  });

  assert.equal(draft.publication.kind, "research-answer");
  if (draft.publication.kind !== "research-answer") {
    assert.fail("expected research answer publication");
  }
  assert.equal(draft.publication.research.nodes.length, 1);
  assert.equal(draft.publication.research.nodes[0].parentId, null);
  assert.equal(
    draft.publication.research.rootNodeId,
    draft.publication.research.nodes[0].id,
  );
  assert.deepEqual(Object.keys(draft.publicNodeIds), [child.id]);
});

test("generated transcripts are schema-validated before upload", async () => {
  const turns = Array.from({ length: 10_001 }, (_, index) =>
    turn(`turn-${index + 1}`, index % 2 === 0 ? "user" : "assistant", [
      { type: "text", text: "x" },
    ]),
  );
  await assert.rejects(
    createTranscriptPublicationDraft({
      title: "Too many messages",
      pane,
      agent,
      assistantLabel: "Codex",
      publicationId: "pub_toomany123",
      createdAt: "2026-07-16T12:00:00.000Z",
      turns,
    }),
    /10,000/,
  );
});

test("research publishing rejects content fetched from a changed node revision", async () => {
  const root = researchNode("private-stale-root", null, "Original prompt", "Original title");
  const detail: ResearchTreeDetail = {
    tree: {
      id: root.treeId,
      title: "Stale research",
      rootNodeId: root.id,
      workspaceId: "private-workspace",
      createdAt: 1,
      updatedAt: 2,
    },
    nodes: [root],
  };
  const changedNode = { ...root, title: "Changed title", responseSnapshotAt: 2 };
  await assert.rejects(
    createResearchPublicationDraft({
      title: detail.tree.title,
      detail,
      selectedNodeId: root.id,
      mode: "answer",
      contents: [researchContent(changedNode, "Changed answer", "d".repeat(64))],
    }),
    /Research changed/,
  );
});

test("research validation rejects nodes disconnected from the declared root", async () => {
  const root = researchNode("private-connected-root", null, "Root", "Root");
  const child = researchNode("private-connected-child", root.id, "Child", "Child");
  const detail: ResearchTreeDetail = {
    tree: {
      id: root.treeId,
      title: "Connected",
      rootNodeId: root.id,
      workspaceId: "private-workspace",
      createdAt: 1,
      updatedAt: 2,
    },
    nodes: [root, child],
  };
  const draft = await createResearchPublicationDraft({
    title: detail.tree.title,
    detail,
    selectedNodeId: child.id,
    mode: "tree",
    contents: [
      researchContent(root, "Root answer", "a".repeat(64)),
      researchContent(child, "Child answer", "b".repeat(64)),
    ],
  });
  assert.equal(draft.publication.kind, "research-tree");
  if (draft.publication.kind !== "research-tree") {
    assert.fail("expected research tree");
  }
  const disconnected = structuredClone(draft.publication);
  disconnected.research.nodes[1].parentId = null;
  assert.throws(() => validatePublication(disconnected), /disconnected/);
});
