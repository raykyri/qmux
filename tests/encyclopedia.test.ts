import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { EncyclopediaPage, EncyclopediaPageSummary } from "../src/types";
import {
  MAX_ENCYCLOPEDIA_SLUG_CHARS,
  buildWikilinkExcerpt,
  encyclopediaPageStatusBySlug,
  encyclopediaSlug,
  encyclopediaSummaryOfPage,
  parseEncyclopediaEvent,
  removeEncyclopediaSummary,
  upsertEncyclopediaSummary,
} from "../src/lib/encyclopedia";

// The slug is the page's file name, so both sides must map a term to the same
// slug. The cases live in one fixture that the Rust test reads as well.
const SLUG_CASES = JSON.parse(
  readFileSync(new URL("../src-tauri/fixtures/encyclopedia-slugs.json", import.meta.url), "utf8"),
) as { term: string; slug: string }[];

test("slugs match the shared fixture the backend also checks", () => {
  assert.ok(SLUG_CASES.length > 0);
  for (const { term, slug } of SLUG_CASES) {
    assert.equal(encyclopediaSlug(term), slug, JSON.stringify(term));
  }
  assert.equal([...encyclopediaSlug("a".repeat(200))].length, MAX_ENCYCLOPEDIA_SLUG_CHARS);
  assert.ok(!encyclopediaSlug(`${"a".repeat(79)} b`).endsWith("-"));
});

test("excerpt keeps the clicked block and splits the rest between neighbors", () => {
  assert.equal(buildWikilinkExcerpt(null, "  the   block ", null), "the block");
  assert.equal(
    buildWikilinkExcerpt("before text", "block", "after text"),
    "before text\n\nblock\n\nafter text",
  );
  // The block always survives; neighbors only get what is left, and a
  // leftover too small for a whole word is dropped rather than padded with
  // a fragment.
  const long = "word ".repeat(400).trim();
  const excerpt = buildWikilinkExcerpt("prev prev", long, "next next", 100);
  assert.ok(excerpt.length <= 100);
  assert.ok(!excerpt.includes("prev") && !excerpt.includes("v\n"));
  assert.ok(!excerpt.includes("next"));
  assert.equal(buildWikilinkExcerpt(null, "x".repeat(50), null, 10), "x".repeat(10));
  // Neighbors are cut at word boundaries: the tail of the previous block and
  // the head of the next.
  const cut = buildWikilinkExcerpt("alpha beta gamma", "block", "one two three", 25);
  assert.equal(cut, "gamma\n\nblock\n\none two");
});

function summary(slug: string, title: string, status: EncyclopediaPageSummary["status"] = "ready") {
  return {
    slug,
    term: title,
    title,
    status,
    workspaceId: "ws",
    createdAt: 1,
    updatedAt: 1,
    sourceCount: 1,
  } satisfies EncyclopediaPageSummary;
}

test("summaries stay sorted by title and replace by slug", () => {
  let pages = upsertEncyclopediaSummary([], summary("zed", "Zed"));
  pages = upsertEncyclopediaSummary(pages, summary("alpha", "alpha"));
  pages = upsertEncyclopediaSummary(pages, summary("mid", "Mid"));
  assert.deepEqual(
    pages.map((page) => page.slug),
    ["alpha", "mid", "zed"],
  );
  pages = upsertEncyclopediaSummary(pages, summary("mid", "Aardvark"));
  assert.deepEqual(
    pages.map((page) => page.slug),
    ["mid", "alpha", "zed"],
  );
  const same = removeEncyclopediaSummary(pages, "missing");
  assert.equal(same, pages);
  assert.deepEqual(
    removeEncyclopediaSummary(pages, "alpha").map((page) => page.slug),
    ["mid", "zed"],
  );
  assert.deepEqual(
    [...encyclopediaPageStatusBySlug([summary("a", "A", "generating"), summary("b", "B")])],
    [
      ["a", "generating"],
      ["b", "ready"],
    ],
  );
});

const page: EncyclopediaPage = {
  slug: "daemon",
  term: "Daemon",
  title: "Daemon (novel)",
  body: "A [[Daniel Suarez]] novel.",
  status: "ready",
  adapter: "claude",
  workspaceId: "ws",
  createdAt: 1,
  updatedAt: 2,
  sources: [{ nodeId: "n1", treeId: "t1", excerpt: "…", createdAt: 1 }],
  links: ["daniel-suarez"],
};

test("page events parse and unrelated or malformed ones are ignored", () => {
  assert.deepEqual(encyclopediaSummaryOfPage(page), summary("daemon", "Daemon (novel)") && {
    ...summary("daemon", "Daemon (novel)"),
    term: "Daemon",
    updatedAt: 2,
  });
  assert.deepEqual(
    parseEncyclopediaEvent({
      type: "encyclopedia.page.updated",
      payload: { page },
      timestamp: 0,
    }),
    { type: "encyclopedia.page.updated", page },
  );
  assert.deepEqual(
    parseEncyclopediaEvent({
      type: "encyclopedia.page.removed",
      payload: { workspaceId: "ws", slug: "daemon" },
      timestamp: 0,
    }),
    { type: "encyclopedia.page.removed", workspaceId: "ws", slug: "daemon" },
  );
  assert.equal(
    parseEncyclopediaEvent({
      type: "encyclopedia.page.updated",
      payload: { page: { slug: "x" } },
      timestamp: 0,
    }),
    null,
  );
  assert.equal(
    parseEncyclopediaEvent({ type: "research.node.updated", payload: {}, timestamp: 0 }),
    null,
  );
});
