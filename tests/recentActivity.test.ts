import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activityDayLabel,
  activityEventFromJournalEntry,
  activityEventFromResearchQuery,
  buildRecentActivity,
  buildRecentActivityFromItems,
  mergeRecentActivityItems,
  recentActivityItemFromJournalEntry,
  reconcileRecentActivityHead,
  recentResearchQueryFromNode,
  upsertRecentActivityItem,
  upsertRecentActivityResearchNode,
  upsertRecentResearchQuery,
} from "../src/lib/activity";
import {
  normalizeRecentActivityPage,
  type RecentActivityItem,
} from "../src/lib/journal";
import ActivityMetadataLine, {
  formatActivityMetadataSummary,
  formatResearchModelSummary,
} from "../src/components/ActivityMetadataLine";
import {
  buildRecentActivityVirtualRows,
  virtualActivityRange,
} from "../src/components/research/ResearchActivityFeed";
import type { JournalEntry } from "../src/lib/journal";
import type { RecentResearchQuery, ResearchNode, ResearchTreeSummary } from "../src/types";

const tree: ResearchTreeSummary = {
  id: "tree-1",
  title: "Collective memory",
  rootNodeId: "root",
  kind: "run",
  workspaceId: "workspace",
  runningCount: 0,
  failedCount: 0,
  completedCount: 2,
  cancelledCount: 0,
  updatedAt: 200,
  hasUnseenUpdate: false,
  hasUnseenFailure: false,
};

const query: RecentResearchQuery = {
  nodeId: "child",
  treeId: tree.id,
  parentNodeId: "root",
  inline: false,
  prompt: "How does retrieval change the result?",
  title: "Retrieval",
  adapter: "codex",
  model: "gpt-5",
  status: "running",
  createdAt: 200,
};

test("research metadata follows the shared actor/action/object grammar", () => {
  const event = activityEventFromResearchQuery(query, tree);
  assert.deepEqual(event.actor, { kind: "user", label: "You" });
  assert.deepEqual(event.action, { kind: "asked", label: "asked" });
  assert.equal(event.object.kind, "research-query");
  assert.equal(event.relationship?.label, "Follow-up");
  assert.equal(event.context?.label, tree.title);
  assert.deepEqual(event.execution, { adapter: "codex", model: "gpt-5" });
  assert.equal(event.state?.label, "Running");
});

test("research metadata names thread prompts and left-aligned Home activity", () => {
  const followUp = activityEventFromResearchQuery(query, tree);
  assert.equal(formatActivityMetadataSummary(followUp), "Replied in “Collective memory”");

  const topLevel = activityEventFromResearchQuery(
    { ...query, parentNodeId: null, adapter: "claude", model: "fable" },
    tree,
  );
  assert.equal(formatActivityMetadataSummary(topLevel), "");
  assert.equal(formatResearchModelSummary("claude", "fable"), "Claude Fable");
  assert.equal(formatResearchModelSummary("claude", null), "Claude");
  assert.equal(formatResearchModelSummary("claude", "claude-opus-4-6"), "Claude");
  assert.equal(formatResearchModelSummary("", null), "");
  assert.equal(formatResearchModelSummary("claude", "fable", "imported"), "Imported");

  const html = renderToStaticMarkup(
    createElement(ActivityMetadataLine, {
      event: { ...topLevel, occurredAt: Date.now() - 2 * 60 * 60 * 1000 },
    }),
  );
  assert.ok(html.includes('class="activity-metadata-summary"'));
  assert.match(html, /activity-metadata-summary"><time/);
  assert.match(html, />2 hr ago<\/time>/);
});

test("saved metadata resolves type and source context", () => {
  const link: JournalEntry = {
    kind: "link",
    id: "saved",
    createdAt: "2026-08-30T12:00:00.000Z",
    url: "https://example.com/paper",
  };
  const event = activityEventFromJournalEntry(link);
  assert.equal(event.object.label, "Link");
  assert.equal(event.context?.label, "example.com");
  assert.equal(event.state, undefined);
  assert.equal(formatActivityMetadataSummary(event), "Saved");
});

test("mixed activity sorts deterministically and malformed saved dates last", () => {
  const entries: JournalEntry[] = [
    { kind: "note", id: "bad", createdAt: "not-a-date", text: "old" },
    { kind: "note", id: "new", createdAt: "1970-01-01T00:00:00.300Z", text: "new" },
  ];
  assert.deepEqual(
    buildRecentActivity(entries, [query], [tree]).map((event) => event.id),
    ["journal:new", "research:child", "journal:bad"],
  );
});

test("Home hides archived research and shows it again when restored", () => {
  const items: RecentActivityItem[] = [
    { kind: "research-query", occurredAt: query.createdAt, query },
    {
      kind: "research-query",
      occurredAt: 150,
      query: { ...query, nodeId: "active", treeId: "active-tree", createdAt: 150 },
    },
    recentActivityItemFromJournalEntry({
      kind: "link",
      id: "saved",
      createdAt: "1970-01-01T00:00:00.100Z",
      url: "https://example.com/paper",
    }),
  ];
  const activeTree = { ...tree, id: "active-tree" };
  assert.deepEqual(
    buildRecentActivityFromItems(items, [{ ...tree, archivedAt: 300 }, activeTree]).map(
      (event) => event.id,
    ),
    ["research:active", "journal:saved"],
  );
  assert.deepEqual(
    buildRecentActivityFromItems(items, [{ ...tree, archivedAt: null }, activeTree]).map(
      (event) => event.id,
    ),
    ["research:child", "research:active", "journal:saved"],
  );
});

test("live follow-ups stay under their root and survive root updates", () => {
  const root = {
    id: "root",
    treeId: tree.id,
    parentNodeId: null,
    prompt: "Root",
    adapter: "codex",
    groupId: "workspace",
    worktreeDir: "/tmp/workspace",
    status: "complete",
    createdAt: 100,
    highlights: [],
  } satisfies ResearchNode;
  let items = upsertRecentActivityResearchNode([], root);
  const child = {
    ...root,
    id: "child",
    parentNodeId: root.id,
    prompt: "Follow up",
    createdAt: 300,
  };
  items = upsertRecentActivityResearchNode(items, child);
  items = upsertRecentActivityResearchNode(items, { ...child, id: "earlier", createdAt: 200 });
  items = upsertRecentActivityResearchNode(items, { ...child, prompt: "Updated follow up" });
  items = upsertRecentActivityResearchNode(items, {
    ...child,
    id: "grandchild",
    parentNodeId: child.id,
  });
  items = upsertRecentActivityResearchNode(items, { ...root, prompt: "Updated root" });
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.kind, "research-query");
  if (item.kind !== "research-query") return;
  assert.equal(item.query.prompt, "Updated root");
  assert.deepEqual(item.query.children?.map((entry) => entry.nodeId), ["earlier", "child"]);
  assert.equal(item.query.children?.[1].prompt, "Updated follow up");
  // A follow-up never moves its root: the row keeps the root's own timestamp.
  assert.equal(item.occurredAt, 100);
  // A follow-up with no loaded root is dropped rather than promoted to a row.
  assert.deepEqual(upsertRecentActivityResearchNode([], child), []);
});

test("run nodes enter history while documents do not", () => {
  const node = {
    id: "root",
    treeId: tree.id,
    parentNodeId: null,
    prompt: "Question",
    adapter: "codex",
    groupId: "workspace",
    worktreeDir: "/tmp/workspace",
    status: "complete",
    createdAt: 100,
    highlights: [],
  } satisfies ResearchNode;
  assert.equal(recentResearchQueryFromNode(node)?.nodeId, "root");
  assert.equal(recentResearchQueryFromNode({ ...node, kind: "document" }), null);
  // Follow-ups are only produced when the caller asks for them; they travel as
  // a root's children, not as rows of their own.
  const reply = {
    ...node,
    id: "reply",
    parentNodeId: "root",
    queryAnchor: {
      version: 1,
      projection: "answer-v1",
      responseRevision: "revision",
      start: 0,
      end: 15,
      exact: "Selected answer",
      prefix: "",
      suffix: "",
    },
  } satisfies ResearchNode;
  assert.equal(recentResearchQueryFromNode(reply), null);
  assert.equal(recentResearchQueryFromNode(reply, true)?.queryTarget, "Selected answer");
  assert.equal(recentResearchQueryFromNode(node, true)?.queryTarget, undefined);
  // The feed carries the recap text itself; a blank one never reaches a card.
  assert.equal(recentResearchQueryFromNode(node)?.recap, undefined);
  assert.equal(
    recentResearchQueryFromNode({
      ...node,
      recap: { text: "  The result is ready.  ", responseRevision: "revision" },
    })?.recap,
    "The result is ready.",
  );
  assert.equal(
    recentResearchQueryFromNode({
      ...node,
      recap: { text: "   ", responseRevision: "revision" },
    })?.recap,
    undefined,
  );
  assert.deepEqual(
    upsertRecentResearchQuery([query], { ...query, status: "failed" }),
    [{ ...query, status: "failed" }],
  );
});

test("day labels provide stable nearby buckets", () => {
  const now = new Date(2026, 7, 30, 12).getTime();
  assert.equal(activityDayLabel(new Date(2026, 7, 30, 8).getTime(), now), "Today");
  assert.equal(activityDayLabel(new Date(2026, 7, 29, 23).getTime(), now), "Yesterday");
  assert.equal(activityDayLabel(Number.NEGATIVE_INFINITY, now), "Earlier");
});

test("mixed activity pages merge by one deterministic source-aware order", () => {
  const note = recentActivityItemFromJournalEntry({
    kind: "note",
    id: "note",
    createdAt: "1970-01-01T00:00:00.200Z",
    text: "Saved at the same millisecond",
  });
  const research: RecentActivityItem = {
    kind: "research-query",
    occurredAt: 200,
    query,
  };
  assert.deepEqual(
    mergeRecentActivityItems([note], [research]).map((item) => item.kind),
    ["research-query", "journal"],
  );
});

test("live activity upserts insert into the sorted position without disturbing peers", () => {
  const asItem = (nodeId: string, createdAt: number): RecentActivityItem => ({
    kind: "research-query",
    occurredAt: createdAt,
    query: { ...query, nodeId, createdAt },
  });
  const current = [asItem("newest", 300), asItem("oldest", 100)];
  const next = upsertRecentActivityItem(current, asItem("middle", 200));
  assert.deepEqual(
    next.map((item) => (item.kind === "research-query" ? item.query.nodeId : "")),
    ["newest", "middle", "oldest"],
  );
});

test("head reconciliation preserves a loaded tail without retaining stale head rows", () => {
  const head = { ...query, nodeId: "head", createdAt: 300 };
  const stale = { ...query, nodeId: "stale", createdAt: 250 };
  const tail = { ...query, nodeId: "tail", createdAt: 100 };
  const asItem = (candidate: RecentResearchQuery): RecentActivityItem => ({
    kind: "research-query",
    occurredAt: candidate.createdAt,
    query: candidate,
  });
  const reconciled = reconcileRecentActivityHead(
    [asItem(stale), asItem(tail)],
    [asItem(head)],
    { occurredAt: 200, sourceRank: 1, id: "boundary" },
  );
  assert.deepEqual(
    reconciled.map((item) => (item.kind === "research-query" ? item.query.nodeId : "")),
    ["head", "tail"],
  );
});

test("restoring a tree archived before load drops the tail so the next page refetches it", () => {
  const asItem = (candidate: RecentResearchQuery): RecentActivityItem => ({
    kind: "research-query",
    occurredAt: candidate.createdAt,
    query: candidate,
  });
  const head = asItem({ ...query, nodeId: "head", createdAt: 300 });
  const tail = asItem({ ...query, nodeId: "tail", createdAt: 100 });
  // Archived trees are omitted from activity pages, so the loaded tail did not
  // include this item.
  const restored = asItem({
    ...query,
    nodeId: "restored",
    treeId: "restored-tree",
    createdAt: 200,
  });
  const headCursor = { occurredAt: 250, sourceRank: 1, id: "boundary" };
  const nodeIds = (items: RecentActivityItem[]) =>
    items.map((item) => (item.kind === "research-query" ? item.query.nodeId : ""));

  assert.deepEqual(nodeIds(reconcileRecentActivityHead([head, tail], [head], headCursor)), [
    "head",
    "tail",
  ]);
  const reset = reconcileRecentActivityHead([head, tail], [head], null);
  assert.deepEqual(nodeIds(reset), ["head"]);
  assert.deepEqual(nodeIds(mergeRecentActivityItems(reset, [restored, tail])), [
    "head",
    "restored",
    "tail",
  ]);
});

test("activity page normalization drops malformed opaque journal records", () => {
  const page = normalizeRecentActivityPage({
    items: [
      {
        kind: "journal",
        occurredAt: 10,
        entry: { id: "broken" } as JournalEntry,
      },
      { kind: "research-query", occurredAt: query.createdAt, query },
    ],
    nextCursor: null,
  });
  assert.deepEqual(page.items.map((item) => item.kind), ["research-query"]);
});

test("variable-height virtualization returns a small overscanned window", () => {
  const sizes = Array.from({ length: 10_000 }, (_, index) => 40 + (index % 3) * 10);
  const offsets: number[] = [];
  let offset = 0;
  for (const size of sizes) {
    offsets.push(offset);
    offset += size;
  }
  const range = virtualActivityRange(offsets, sizes, 200_000, 800, 600);
  assert.ok(range.start > 0);
  assert.ok(range.end < sizes.length);
  assert.ok(range.end - range.start < 50);
});

test("virtual feed rows retain day headers and feed positions", () => {
  const events = buildRecentActivity(
    [{ kind: "note", id: "note", createdAt: "1970-01-01T00:00:00.300Z", text: "n" }],
    [query],
    [tree],
  );
  const rows = buildRecentActivityVirtualRows(events);
  assert.equal(rows.filter((row) => row.kind === "event").length, 2);
  assert.deepEqual(
    rows.filter((row) => row.kind === "event").map((row) => row.position),
    [1, 2],
  );
});
