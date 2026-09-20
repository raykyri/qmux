import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchActivityFeed, {
  JOURNAL_CREATE_ENTRY_LABEL,
  JournalFeedMenuItems,
  recentActivityAnchorOffset,
  recentActivityAnchorScrollTop,
  submitJournalEntryDraft,
  type ResearchActivityFeedProps,
} from "../src/components/research/ResearchActivityFeed";

const noop = () => {};
function renderFeed(overrides: Partial<ResearchActivityFeedProps> = {}) {
  return renderToStaticMarkup(
    createElement(ResearchActivityFeed, {
      composer: createElement("div", null, "Query composer"),
      items: [],
      researchTrees: [],
      nextCursor: null,
      loadingOlder: false,
      olderError: null,
      pendingUndo: null,
      onAddEntry: noop,
      onRemoveEntry: noop,
      onRetryTweet: noop,
      onUndoRemove: noop,
      onDismissUndo: noop,
      onOpenResearchQuery: noop,
      onSetResearchFollowed: noop,
      onSetResearchBookmarked: noop,
      onLoadOlder: noop,
      onRefresh: noop,
      onBack: noop,
      onForward: noop,
      ...overrides,
    }),
  );
}

test("Home renders the mixed feed and the query composer slot", () => {
  const html = renderFeed({
    items: [
      {
        kind: "journal",
        occurredAt: 200,
        entry: {
          kind: "link",
          id: "link",
          createdAt: "1970-01-01T00:00:00.200Z",
          url: "https://example.com/finding",
        },
      },
      {
        kind: "research-query",
        occurredAt: 100,
        query: {
          nodeId: "node",
          treeId: "tree",
          parentNodeId: null,
          inline: false,
          prompt: "Investigate this question",
          adapter: "codex",
          status: "complete",
          createdAt: 100,
          recap: "The finding is X.",
        },
      },
    ],
  });
  assert.match(html, /Home/);
  assert.match(html, /role="feed"/);
  assert.match(html, /journal-column research-reading-surface/);
  assert.match(html, /journal-entry research-content-card/);
  assert.match(html, /research-user-message recent-query-card research-prompt/);
  assert.match(html, /research-summary-text research-recap recent-query-recap/);
  assert.match(html, /Query composer/);
  assert.match(html, /example.com\/finding/);
  assert.match(html, /Investigate this question/);
  assert.match(html, />Saved <time/);
  assert.match(html, /activity-metadata-summary"><time/);
  assert.doesNotMatch(html, />Asked <time/);
  assert.match(html, /Summary: The finding is X\./);
  // Refresh is an icon button in the history-nav recipe, not a labelled control.
  assert.match(
    html,
    /aria-label="Refresh Home"[^>]*class="icon-button research-history-button"/,
  );
  assert.doesNotMatch(html, />Refresh<\/button>/);
  // The old day headers are gone; rows divide on their own.
  assert.doesNotMatch(html, /recent-activity-day-label/);
});

test("research cards end with Follow and Bookmark beside the time", () => {
  const query = {
    nodeId: "node",
    treeId: "tree",
    parentNodeId: null,
    inline: false,
    prompt: "Investigate this question",
    adapter: "codex",
    status: "complete" as const,
    createdAt: 100,
    recap: "The finding is X.",
  };
  const tree = {
    id: "tree",
    title: "Investigate",
    rootNodeId: "node",
    kind: "run" as const,
    workspaceId: "ws",
    runningCount: 0,
    failedCount: 0,
    completedCount: 1,
    cancelledCount: 0,
    updatedAt: 100,
    archivedAt: null,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
  };
  const html = renderFeed({
    items: [{ kind: "research-query", occurredAt: 100, query }],
    researchTrees: [{ ...tree, followed: true, bookmarked: true }],
  });
  const footer = html.indexOf('class="recent-query-footer"');
  assert.ok(footer > 0);
  // The footer is the card's last block: after the recap, with actions before
  // the metadata.
  assert.ok(html.indexOf("Summary: The finding is X.") < footer);
  assert.ok(footer < html.indexOf("research-thread-actions"));
  assert.ok(
    html.indexOf("research-thread-actions") < html.indexOf('class="recent-query-metadata"'),
  );
  assert.match(
    html,
    /aria-pressed="true"[^>]*research-thread-follow is-active"[^>]*>Following<\/button>/,
  );
  assert.match(
    html,
    /aria-pressed="true"[^>]*aria-label="Remove bookmark"[^>]*research-thread-bookmark is-active"/,
  );
  assert.match(
    html,
    /recent-query-metadata"><div class="activity-metadata"[^>]*><span class="activity-metadata-summary"><time/,
  );

  const unflagged = renderFeed({
    items: [{ kind: "research-query", occurredAt: 100, query }],
    researchTrees: [tree],
  });
  assert.match(
    unflagged,
    /aria-pressed="false"[^>]*research-thread-follow">Follow<\/button>/,
  );
  assert.match(unflagged, /aria-label="Bookmark"/);

  // Saved links keep their metadata line above the card and no thread actions.
  const saved = renderFeed({
    items: [
      {
        kind: "journal",
        occurredAt: 200,
        entry: {
          kind: "link",
          id: "link",
          createdAt: "1970-01-01T00:00:00.200Z",
          url: "https://example.com/finding",
        },
      },
    ],
  });
  assert.doesNotMatch(saved, /research-thread-actions/);
  assert.ok(saved.indexOf("activity-metadata") < saved.indexOf("journal-entry research-content-card"));
});

test("the Bookmarks view lists only bookmarked threads without the composer", () => {
  const query = {
    nodeId: "node",
    treeId: "tree",
    parentNodeId: null,
    inline: false,
    prompt: "Bookmarked question",
    adapter: "codex",
    status: "complete" as const,
    createdAt: 100,
  };
  const other = { ...query, nodeId: "other-node", treeId: "other", prompt: "Unbookmarked question" };
  const tree = {
    id: "tree",
    title: "Investigate",
    rootNodeId: "node",
    kind: "run" as const,
    workspaceId: "ws",
    runningCount: 0,
    failedCount: 0,
    completedCount: 1,
    cancelledCount: 0,
    updatedAt: 100,
    archivedAt: null,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
    bookmarked: true,
  };
  const items = [
    {
      kind: "journal" as const,
      occurredAt: 300,
      entry: {
        kind: "link" as const,
        id: "link",
        createdAt: "1970-01-01T00:00:00.300Z",
        url: "https://example.com/saved",
      },
    },
    { kind: "research-query" as const, occurredAt: 200, query: other },
    { kind: "research-query" as const, occurredAt: 100, query },
  ];
  const html = renderFeed({
    view: "bookmarks",
    items,
    researchTrees: [tree, { ...tree, id: "other", rootNodeId: "other-node", bookmarked: false }],
    setupGuide: createElement("div", null, "Setup guide"),
  });
  assert.match(html, /Bookmarks/);
  assert.match(html, /aria-label="Refresh Bookmarks"/);
  assert.match(html, /Bookmarked question/);
  assert.doesNotMatch(html, /Unbookmarked question/);
  assert.doesNotMatch(html, /example.com\/saved/);
  assert.doesNotMatch(html, /Query composer/);
  assert.doesNotMatch(html, /Setup guide/);

  const empty = renderFeed({ view: "bookmarks", items, researchTrees: [{ ...tree, bookmarked: false }] });
  assert.match(empty, /Bookmarked research appears here/);
  assert.doesNotMatch(empty, /Bookmarked question/);

  const home = renderFeed({ items, researchTrees: [tree] });
  assert.match(home, /Unbookmarked question/);
  assert.match(home, /Query composer/);
});

test("feed pagination errors and deletion undo remain visible with workspace history controls", () => {
  const html = renderFeed({
    nextCursor: { occurredAt: 100, sourceRank: 0, id: "link" },
    olderError: "Temporarily unavailable",
    pendingUndo: {
      entry: {
        kind: "link",
        id: "deleted",
        createdAt: "1970-01-01T00:00:00.100Z",
        url: "https://example.com/restore",
      },
    },
    canGoBack: true,
  });
  assert.match(html, /Retry older activity/);
  assert.match(html, /Temporarily unavailable/);
  assert.match(html, /Entry removed/);
  assert.match(html, /Dismiss undo/);
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /aria-label="Forward"/);
});

test("Home renders direct children as follow-up buttons within the root item", () => {
  const root = {
    nodeId: "root",
    treeId: "tree",
    parentNodeId: null,
    inline: false,
    prompt: "Root question",
    adapter: "codex",
    status: "complete" as const,
    createdAt: 100,
  };
  const html = renderFeed({
    items: [
      {
        kind: "research-query",
        occurredAt: 100,
        query: {
          ...root,
          children: [
            {
              ...root,
              nodeId: "child",
              parentNodeId: "root",
              prompt: "Follow up question here",
              children: [
                { ...root, nodeId: "grandchild", parentNodeId: "child", prompt: "Nested descendant" },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.match(html, /aria-label="Follow-up questions"/);
  assert.match(html, /recent-query-child-question">Follow up question here<\/span>/);
  assert.ok(html.indexOf("Root question") < html.indexOf("Follow up question here"));
  // The footer (actions + time) closes the item, after the follow-up list.
  assert.ok(html.indexOf("Follow up question here") < html.indexOf("activity-metadata"));
  assert.equal((html.match(/aria-posinset=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Nested descendant/);
});

test("Home prefixes targeted follow-ups with a muted target excerpt", () => {
  const root = {
    nodeId: "root",
    treeId: "tree",
    parentNodeId: null,
    inline: false,
    prompt: "Root question",
    adapter: "codex",
    status: "complete" as const,
    createdAt: 100,
  };
  const target = "The selected answer passage has enough words to require a short excerpt here";
  const html = renderFeed({
    items: [
      {
        kind: "research-query",
        occurredAt: 100,
        query: {
          ...root,
          children: [
            {
              ...root,
              nodeId: "child",
              parentNodeId: "root",
              prompt: "How does this change the result?",
              queryTarget: target,
            },
          ],
        },
      },
    ],
  });

  assert.match(
    html,
    /recent-query-child-target" title="[^"]+">@The selected answer passage has…<\/span>/,
  );
  assert.match(html, /recent-query-child-question">How does this change the result\?<\/span>/);
  assert.ok(
    html.indexOf("recent-query-child-target") < html.indexOf("recent-query-child-question"),
  );
  assert.match(
    html,
    /recent-query-child-target"[^>]*>[^<]+<\/span> <span class="recent-query-child-link" role="button"/,
  );
});

test("Home places follow-up questions below the research summary", () => {
  const root = {
    nodeId: "root",
    treeId: "tree",
    parentNodeId: null,
    inline: false,
    prompt: "Root question",
    adapter: "codex",
    status: "complete" as const,
    createdAt: 100,
  };
  const html = renderFeed({
    items: [
      {
        kind: "research-query",
        occurredAt: 100,
        query: {
          ...root,
          recap: "The root answer.",
          children: [{ ...root, nodeId: "child", parentNodeId: "root", prompt: "Follow up question" }],
        },
      },
    ],
  });

  assert.ok(html.indexOf("Root question") < html.indexOf("Summary: The root answer."));
  assert.ok(html.indexOf("Summary: The root answer.") < html.indexOf("Follow up question"));
  assert.ok(html.indexOf("Follow up question") < html.indexOf("activity-metadata"));
});

test("the feed keeps a reachable path for saving links, notes and posts", () => {
  // The composer slot belongs to the research query composer, so creation
  // moved into the feed's own actions menu.
  assert.match(renderFeed(), /aria-label="Feed actions"/);
  assert.doesNotMatch(renderFeed({ view: "bookmarks" }), /aria-label="Feed actions"/);

  const menu = renderToStaticMarkup(
    createElement(JournalFeedMenuItems, { onCreateEntry: noop }),
  );
  assert.match(menu, /role="menuitem"/);
  assert.match(menu, /Add link or note…/);
  assert.equal(JOURNAL_CREATE_ENTRY_LABEL, "Add link or note…");

  // Submitting the dialog hands the raw draft to the feed's classifier; a
  // blank draft is a no-op that leaves the dialog open.
  const added: string[] = [];
  const collect = (input: string) => added.push(input);
  assert.equal(submitJournalEntryDraft("   ", collect), false);
  assert.equal(submitJournalEntryDraft("  https://example.com/paper  ", collect), true);
  assert.deepEqual(added, ["https://example.com/paper"]);
});

// Enabled in P16, which supplies the agent setup guide this slot renders.
test.skip("the agent setup guide appears only when the Home feed is empty", () => {
  const setupGuide = createElement("div", null, "Agent setup guide");

  const emptyWithGuide = renderFeed({ setupGuide });
  assert.match(emptyWithGuide, /Agent setup guide/);
  assert.doesNotMatch(emptyWithGuide, /appear here, newest first/);
  assert.match(renderFeed({}), /appear here, newest first/);
  assert.doesNotMatch(
    renderFeed({
      setupGuide,
      items: [
        {
          kind: "journal",
          occurredAt: 200,
          entry: {
            kind: "link",
            id: "link",
            createdAt: "1970-01-01T00:00:00.200Z",
            url: "https://example.com/finding",
          },
        },
      ],
    }),
    /Agent setup guide/,
  );
});

test("the feed scroll anchor round-trips correctly", () => {
  // Canvas top accounts for elements above the virtualized list.
  const canvasTop = 212;
  for (const [rowOffset, scrollTop] of [
    [0, 0],
    [1840, 1900],
    [4096, 300],
    [640, 640],
  ]) {
    const offset = recentActivityAnchorOffset(canvasTop, rowOffset, scrollTop);
    assert.equal(
      recentActivityAnchorScrollTop(canvasTop, rowOffset, offset),
      scrollTop,
      `round trip for a row at ${rowOffset} viewed from ${scrollTop}`,
    );
  }
  // Negative offset across the top edge round-trips correctly.
  assert.equal(recentActivityAnchorOffset(0, 500, 560), -60);
  assert.equal(recentActivityAnchorScrollTop(0, 500, -60), 560);
  // Scroll position clamps to zero if the calculated offset is negative.
  assert.equal(recentActivityAnchorScrollTop(0, 40, 400), 0);
});

test("Home offers report import and imported cards identify provenance", () => {
  const html = renderFeed({
    onImportReport: async () => {},
    items: [
      {
        kind: "research-query",
        occurredAt: 100,
        query: {
          nodeId: "import",
          treeId: "import-tree",
          parentNodeId: null,
          inline: false,
          prompt: "Original prompt",
          adapter: "codex",
          model: null,
          origin: "imported",
          status: "complete",
          createdAt: 100,
        },
      },
    ],
  });
  assert.match(html, /Import report/);
  // The picker matches the backend reader, which accepts both extensions.
  assert.match(html, /accept=".md,.markdown,text\/markdown"/);
  assert.match(html, /Imported <time/);
  assert.doesNotMatch(
    renderFeed({ view: "bookmarks", onImportReport: async () => {} }),
    /Import report/,
  );
});
