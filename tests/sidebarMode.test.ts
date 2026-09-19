import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_BOOKMARKS_TAB_ID,
  RESEARCH_HIGHLIGHTS_TAB_ID,
  RESEARCH_HOME_TAB_ID,
  RESEARCH_JOURNAL_TAB_IDS,
  RESEARCH_JOURNAL_VIEWS,
  researchEncyclopediaSlugFromTabId,
  researchEncyclopediaTabId,
  researchJournalTabId,
  researchJournalViewFromTabId,
  researchTreeIdFromTabId,
  researchTreeTabId,
} from "../src/lib/sidebarMode";

test("journal tab ids round-trip through their view names", () => {
  assert.deepEqual(RESEARCH_JOURNAL_VIEWS, ["home", "bookmarks", "highlights"]);
  for (const view of RESEARCH_JOURNAL_VIEWS) {
    assert.equal(researchJournalViewFromTabId(researchJournalTabId(view)), view);
  }
  assert.equal(researchJournalTabId("home"), RESEARCH_HOME_TAB_ID);
  assert.equal(researchJournalTabId("bookmarks"), RESEARCH_BOOKMARKS_TAB_ID);
  assert.equal(researchJournalTabId("highlights"), RESEARCH_HIGHLIGHTS_TAB_ID);
});

test("ids that belong to another surface are not journal views", () => {
  assert.equal(researchJournalViewFromTabId("pane-1"), null);
  assert.equal(researchJournalViewFromTabId(researchTreeTabId("tree-1")), null);
  assert.equal(researchJournalViewFromTabId(researchEncyclopediaTabId("alpha")), null);
  assert.equal(researchJournalViewFromTabId(""), null);
});

test("encyclopedia tab ids round-trip, including slugs containing the prefix colon", () => {
  assert.equal(researchEncyclopediaTabId("alpha"), "__research_encyclopedia__:alpha");
  assert.equal(researchEncyclopediaSlugFromTabId("__research_encyclopedia__:alpha"), "alpha");

  // A slug is everything after the first colon, so a slug that itself contains
  // the prefix (or a colon) survives the round trip unchanged.
  const nested = researchEncyclopediaTabId("__research_encyclopedia__:beta");
  assert.equal(researchEncyclopediaSlugFromTabId(nested), "__research_encyclopedia__:beta");
  assert.equal(researchEncyclopediaSlugFromTabId(researchEncyclopediaTabId("a:b")), "a:b");
});

test("non-encyclopedia ids yield no slug, and an empty slug is rejected", () => {
  assert.equal(researchEncyclopediaSlugFromTabId("__research_encyclopedia__"), null);
  assert.equal(researchEncyclopediaSlugFromTabId("__research_encyclopedia__:"), null);
  assert.equal(researchEncyclopediaSlugFromTabId(RESEARCH_HOME_TAB_ID), null);
  assert.equal(researchEncyclopediaSlugFromTabId(researchTreeTabId("tree-1")), null);
  assert.equal(researchTreeIdFromTabId(researchEncyclopediaTabId("alpha")), null);
});

test("the journal cycle list stays empty until App.tsx can dispatch its ids", () => {
  // P8 adds Home and its dispatch arm; P11 adds Bookmarks and Highlights.
  // Until then an id here would make Ctrl-Tab focus a pane that does not exist.
  assert.deepEqual(RESEARCH_JOURNAL_TAB_IDS, []);
});
