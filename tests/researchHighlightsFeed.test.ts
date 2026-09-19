import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchHighlightsFeed, {
  formatHighlightDayLabel,
  type ResearchHighlightsFeedProps,
} from "../src/components/research/ResearchHighlightsFeed";

const noop = () => {};
function render(overrides: Partial<ResearchHighlightsFeedProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchHighlightsFeed, {
    items: [], loading: false, error: null, onOpen: noop, onRefresh: noop, ...overrides,
  }));
}

test("Highlights shows passages in context under day headers with their thread and time", () => {
  const now = Date.now();
  const html = render({
    items: [
      {
        highlightId: "h-2", nodeId: "node-2", treeId: "tree", treeTitle: "Collective memory",
        nodeLabel: "Why do rituals persist?", exact: "Rituals encode shared expectations.",
        prefix: "The persistence of a ritual has less to do with belief than with cost. ",
        suffix: " Once that evidence thins, defection becomes cheap.",
        createdAt: now - 2 * 60 * 60 * 1000,
      },
      {
        highlightId: "h-1", nodeId: "node-1", treeId: "doc", treeTitle: "Original title",
        nodeLabel: "Original title", exact: "Body", prefix: "", suffix: "",
        createdAt: now - 3 * 24 * 60 * 60 * 1000,
      },
    ],
  });
  assert.match(html, /Highlights/);
  assert.match(html, /aria-label="Refresh Highlights"/);
  assert.match(html, /role="feed" aria-label="Highlights"/);
  assert.match(html, /research-highlight-excerpt"[^>]*role="button"/);
  assert.match(html, /research-highlight-context">…The persistence of a ritual[^<]*<\/span><mark class="research-highlight-mark">Rituals encode shared expectations\.<\/mark><span class="research-highlight-context"> Once that evidence thins, defection becomes cheap\.…<\/span>/);
  // No context: the mark stands alone.
  assert.match(html, /research-highlight-excerpt"[^>]*><mark class="research-highlight-mark">Body<\/mark><\/div>/);
  // Day headers: one per distinct day, newest first (the first is today or,
  // when the test runs just after midnight, yesterday).
  assert.match(html, /research-highlight-day">(Today|Yesterday)<\/div>/);
  assert.equal((html.match(/research-highlight-day"/g) ?? []).length, 2);
  // Node label is appended only when it differs from the thread title.
  assert.match(html, /research-highlight-source">Collective memory › Why do rituals persist\?<\/button>/);
  assert.match(html, /research-highlight-source">Original title<\/button>/);
  assert.match(html, /<\/button><time[^>]*>2 hr ago<\/time>/);
  assert.ok(html.indexOf("Rituals encode") < html.indexOf(">Body<"));
});

test("day labels resolve to Today, Yesterday, or a short date", () => {
  const now = new Date(2026, 8, 14, 15, 0, 0).getTime();
  assert.equal(formatHighlightDayLabel(now - 60_000, now), "Today");
  assert.equal(formatHighlightDayLabel(new Date(2026, 8, 13, 23, 59).getTime(), now), "Yesterday");
  assert.equal(formatHighlightDayLabel(new Date(2026, 8, 1, 9, 0).getTime(), now), "Sep 1");
  assert.equal(formatHighlightDayLabel(new Date(2025, 11, 25).getTime(), now), "Dec 25, 2025");
});

test("long context trims to the nearest word on the side facing the passage", () => {
  const html = render({
    items: [{
      highlightId: "h", nodeId: "n", treeId: "t", treeTitle: "T", nodeLabel: "T", exact: "X",
      prefix: Array.from({ length: 60 }, (_, index) => `before${index}`).join(" ") + " ",
      suffix: " " + Array.from({ length: 60 }, (_, index) => `after${index}`).join(" "),
      createdAt: Date.now(),
    }],
  });
  const prefix = html.match(/research-highlight-context">…([^<]*)<\/span><mark/);
  const suffix = html.match(/<\/mark><span class="research-highlight-context">([^<]*)…<\/span>/);
  assert.ok(prefix && prefix[1].length <= 140 && prefix[1].endsWith("before59 "));
  assert.ok(prefix && !prefix[1].startsWith("efore"), prefix?.[1].slice(0, 12));
  assert.ok(suffix && suffix[1].length <= 140 && suffix[1].startsWith(" after0"));
  assert.ok(suffix && !/after\d*[a-z]?$/.test(suffix[1].replace(/after\d+$/, "")), suffix?.[1].slice(-12));
});

test("Highlights shows loading, empty, and error states", () => {
  assert.match(render({ loading: true }), /Loading highlights…/);
  assert.match(render(), /Text you highlight in research answers appears here/);
  const failed = render({ error: "Backend unavailable" });
  assert.match(failed, /role="alert"[^>]*>Backend unavailable/);
  assert.match(failed, />Retry<\/button>/);
});
