import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatResearchReplySnippet,
  ResearchSegmentPrompt,
  ResearchTimelineItem,
} from "../src/components/research/ResearchDocument";
import {
  ResearchMessageBody,
  ResearchUserMessage,
  visibleResearchPrompt,
} from "../src/components/research/ResearchMessage";
import type { ResearchMessageAttachment } from "../src/types";

const tweetAttachment: ResearchMessageAttachment = {
  kind: "tweet",
  schemaVersion: 1,
  sourceUrl: "https://x.com/example/status/123",
  tweetId: "123",
  placement: "trailing",
  provider: "xSyndication",
  status: "resolved",
  attemptedAt: 1,
  fetchedAt: 2,
  tweet: {
    id: "123",
    url: "https://x.com/example/status/123",
    author: { name: "Example", handle: "example", verified: true },
    createdAt: "2026-09-12T12:00:00.000Z",
    runs: [{ kind: "text", text: "Captured post text" }],
    partial: false,
    media: [
      {
        kind: "photo",
        imageUrl: "https://pbs.twimg.com/media/example.jpg",
        altText: "A useful diagram",
        width: 1200,
        height: 800,
      },
    ],
  },
};

const promptProps = {
  visible: true,
  parentNodeId: null,
  queryQuote: null,
  prompt: "> foo\n> bar",
  adapter: "claude",
  model: "fable",
  onSelectNode: () => {},
} as const;

test("research prompts preserve Markdown blockquotes", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, { ...promptProps, index: 0 }),
  );

  assert.match(html, /Claude Fable/);
  assert.doesNotMatch(html, /You asked/);
  assert.match(html, /research-user-message research-prompt/);
  assert.doesNotMatch(html, /research-content-card/);
  assert.doesNotMatch(html, /Reply to:/);
  assert.ok(html.indexOf("<blockquote>") < html.indexOf("Claude Fable"));
  assert.match(html, /<blockquote>/);
  assert.match(html, /foo<br\/>[\n]?bar/);
});

test("the root prompt footer pairs thread actions with the model and relative time", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      ...promptProps,
      index: 0,
      createdAt: Date.now() - 3 * 60 * 60 * 1000,
      followed: true,
      bookmarked: false,
      onToggleFollow: () => {},
      onToggleBookmark: () => {},
    }),
  );

  assert.match(html, /research-prompt-metadata is-after-prompt research-prompt-footer/);
  assert.match(html, /aria-pressed="true"[^>]*research-thread-follow is-active"/);
  assert.match(html, />Following<\/button>/);
  assert.match(html, /aria-label="Bookmark"/);
  assert.match(
    html,
    /research-prompt-footer-meta"[^>]*>Claude Fable<span[^>]*> · <\/span><time[^>]*>3 hr ago<\/time>/,
  );
  // Follow-ups keep their reply line and never render the thread footer.
  const followUp = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      ...promptProps,
      index: 1,
      createdAt: Date.now(),
      replyToAnswer: "Earlier answer",
      onToggleFollow: () => {},
      onToggleBookmark: () => {},
    }),
  );
  assert.doesNotMatch(followUp, /research-prompt-footer/);
  assert.doesNotMatch(followUp, /research-thread-actions/);
});

test("a running root prompt hides the footer row until the answer settles", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      ...promptProps,
      index: 0,
      running: true,
      createdAt: Date.now(),
      onToggleFollow: () => {},
      onToggleBookmark: () => {},
    }),
  );
  assert.doesNotMatch(html, /research-prompt-footer/);
  assert.doesNotMatch(html, /research-thread-actions/);
  assert.doesNotMatch(html, /Claude Fable/);
  assert.doesNotMatch(html, /has-trailing-metadata/);
});

test("the shared user-message primitive stays unboxed", () => {
  const html = renderToStaticMarkup(
    createElement(
      ResearchUserMessage,
      { className: "research-conversation-prompt research-prompt" },
      createElement(ResearchMessageBody, { prompt: "Conversation question" }),
    ),
  );

  assert.match(html, /research-user-message research-conversation-prompt research-prompt/);
  assert.doesNotMatch(html, /research-content-card/);
  assert.match(html, /turn-markdown research-prose research-prose--body/);
});

test("follow-up research prompts omit the asked-model line", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, { ...promptProps, index: 1 }),
  );

  assert.doesNotMatch(html, /You asked/);
  assert.doesNotMatch(html, /Claude Fable/);
  assert.match(html, /<blockquote>/);
});

test("branch prompts place Back above the asked-model line", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      ...promptProps,
      index: 0,
      parentNodeId: "parent",
      queryQuote: "Selected answer passage",
    }),
  );

  assert.match(html, /research-parent-link/);
  assert.ok(html.indexOf("Back") < html.indexOf("Selected answer passage"));
  assert.ok(html.indexOf("Selected answer passage") < html.indexOf("research-user-message"));
  assert.ok(html.indexOf("Selected answer passage") < html.indexOf("Claude Fable"));
});

test("follow-up research prompts quote a truncated previous answer", () => {
  assert.equal(
    formatResearchReplySnippet("Ready — what would you like to work on?"),
    "Ready — what would you like to work on?",
  );
  assert.equal(
    formatResearchReplySnippet(
      "The workspace is not a git repository so you will need to initialize one first.",
    ),
    "The workspace is not a git repository so…",
  );

  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      ...promptProps,
      index: 1,
      replyToAnswer:
        "The workspace is not a git repository so you will need to initialize one first.",
    }),
  );

  assert.doesNotMatch(html, /You asked/);
  assert.match(html, /research-prompt-reply/);
  assert.match(html, /Reply to: The workspace is not a git repository so…/);
  assert.doesNotMatch(html, /initialize one first/);
});

test("resolved trailing tweet URLs are presentation-only while the embed renders", () => {
  const prompt = `What does this mean?\n\n${tweetAttachment.sourceUrl}`;
  assert.equal(visibleResearchPrompt(prompt, [tweetAttachment]), "What does this mean?");

  const html = renderToStaticMarkup(
    createElement(ResearchMessageBody, { prompt, attachments: [tweetAttachment] }),
  );
  assert.match(html, /What does this mean\?/);
  assert.match(html, /Captured post text/);
  assert.match(html, /A useful diagram/);
  assert.doesNotMatch(html, />https:\/\/x\.com\/example\/status\/123</);
});

test("inline or unavailable tweet URLs remain visible", () => {
  const inline = { ...tweetAttachment, placement: "inline" as const };
  const unavailable: ResearchMessageAttachment = {
    ...tweetAttachment,
    status: "unavailable",
    tweet: undefined,
    failure: "timeout",
  };
  const prompt = `Review ${tweetAttachment.sourceUrl}`;
  assert.equal(visibleResearchPrompt(prompt, [inline]), prompt);
  assert.equal(visibleResearchPrompt(prompt, [unavailable]), prompt);
});

test("imported report metadata hides its summary agent and model", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchSegmentPrompt, {
      ...promptProps,
      index: 0,
      origin: "imported",
      createdAt: 100,
    }),
  );
  assert.match(html, />Imported<span/);
  assert.doesNotMatch(html, /Claude|Fable/);
});

test("long imported reports retain Markdown and their final conclusion", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTimelineItem, {
      imported: true,
      item: {
        type: "message",
        key: "imported-report",
        role: "assistant",
        blocks: [
          {
            type: "text",
            text: `# Long report\n\n${"Evidence. ".repeat(35_000)}\n\n**Final conclusion.**`,
          },
        ],
        activities: [],
        sourceTurnIds: ["imported"],
        blockSourceTurnIds: ["imported"],
      },
    }),
  );

  assert.match(html, /<h1>Long report<\/h1>/);
  assert.match(html, /<strong>Final conclusion\.<\/strong>/);
  // The oversized-content fold would have replaced the Markdown with a
  // plain-text preview; an imported report is rendered whole.
  assert.doesNotMatch(html, /research-plaintext/);
});

test("imported reports hide citation handles and preserve Markdown sources", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchTimelineItem, {
      imported: true,
      item: {
        type: "message",
        key: "imported-citations",
        role: "assistant",
        blocks: [
          {
            type: "text",
            text:
              "Finding. \uE200cite\uE202turn25view0\uE202turn22view1\uE201\n\n" +
              "[Source](https://example.com/paper) [1]\n\n" +
              "Another finding.\uE200cite\uE202turn19search24\uE201",
          },
        ],
        activities: [],
        sourceTurnIds: ["imported"],
        blockSourceTurnIds: ["imported"],
      },
    }),
  );

  assert.match(html, /<p>Finding\.<\/p>/);
  assert.match(html, /href="https:\/\/example.com\/paper"/);
  assert.match(html, /\[1\]/);
  assert.match(html, /<p>Another finding\.<\/p>/);
  assert.doesNotMatch(html, /turn25view0|turn22view1|turn19search24|[\uE200-\uE202]/);
});
