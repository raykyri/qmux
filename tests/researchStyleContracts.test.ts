import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles", "features");
const tokensCss = readFileSync(join(stylesDirectory, "..", "tokens.css"), "utf8");
const surfaceCss = readFileSync(join(stylesDirectory, "research-surface.css"), "utf8");
const researchCss = readFileSync(join(stylesDirectory, "research.css"), "utf8");
const journalCss = readFileSync(join(stylesDirectory, "journal.css"), "utf8");
const transcriptCss = readFileSync(join(stylesDirectory, "transcript.css"), "utf8");
const turnPaneCss = readFileSync(join(stylesDirectory, "turn-pane.css"), "utf8");

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("DM Sans adds one optical half-pixel to UI type but not monospace text", () => {
  const root = ruleBody(tokensCss, ":root");
  for (const token of ["xs", "sm", "base", "input"]) {
    assert.match(
      root,
      new RegExp(`--fs-${token}:\\s*calc\\([^;]+var\\(--font-ui-size-offset\\)\\)`),
    );
  }
  assert.match(
    ruleBody(tokensCss, ':root[data-body-font="dm-sans"]'),
    /--font-ui-size-offset:\s*0\.5px/,
  );

  const turnPane = ruleBody(turnPaneCss, ".turn-pane");
  assert.match(turnPane, /--fs-base:[^;]+var\(--font-ui-size-offset\)/s);

  const researchScale = ruleBody(surfaceCss, ".research-reading-surface");
  assert.match(
    researchScale,
    /--research-markdown-font-delta:[^;]+- var\(--font-ui-size-offset\)/s,
  );

  const heading = ruleBody(transcriptCss, ".turn-markdown h1");
  assert.match(heading, /font-size:[^;]+\+ var\(--font-ui-size-offset\)/);
  const code = ruleBody(transcriptCss, ".turn-markdown code");
  assert.doesNotMatch(code, /font-ui-size-offset/);
});

test("research summaries get typography only from the shared surface recipe", () => {
  const summary = ruleBody(surfaceCss, ".research-summary-text");
  assert.match(summary, /font-size:\s*var\(--research-summary-font-size\)/);
  assert.match(summary, /line-height:\s*var\(--research-summary-line-height\)/);

  // .recent-query-recap is Home's placement rule; it arrives with the feed in P7.
  const threadPlacement = ruleBody(researchCss, ".research-recap");
  assert.doesNotMatch(threadPlacement, /font(?:-size|-style|-weight)?\s*:/);
  assert.doesNotMatch(threadPlacement, /line-height\s*:/);
});

// Enabled in P11, which restyles the sidebar rows to the feed's body size.
test("research thread titles match feed body size without resizing sidebar chrome", () => {
  const threadRow = ruleBody(researchCss, ".research-sidebar-row[data-research-tree-id]");
  assert.match(threadRow, /font-size:\s*calc\(var\(--fs-input\) - 0\.5px\)/);

  const heading = ruleBody(researchCss, ".research-sidebar-heading");
  assert.match(heading, /font-size:\s*var\(--fs-xs\)/);
});

test("research prose adapts transcript typography on the renderer, not layout roots", () => {
  const readingSurface = ruleBody(surfaceCss, ".research-reading-surface");
  assert.doesNotMatch(readingSurface, /--transcript-/);

  const prose = ruleBody(surfaceCss, ".turn-markdown.research-prose");
  assert.match(prose, /--transcript-font-delta:/);
  assert.match(prose, /--transcript-line-height-delta:/);
  assert.match(prose, /font-size:\s*var\(--research-body-font-size\)/);
  assert.match(prose, /line-height:\s*var\(--research-body-line-height\)/);

  const compact = ruleBody(surfaceCss, ".turn-markdown.research-prose--compact");
  assert.match(compact, /font-size:\s*var\(--research-compact-font-size\)/);
  assert.match(compact, /line-height:\s*var\(--research-compact-line-height\)/);

  // The prompt places the message but must not restate its metrics.
  const prompt = ruleBody(researchCss, ".research-prompt .turn-markdown");
  assert.doesNotMatch(prompt, /font-size\s*:/);
  assert.doesNotMatch(prompt, /line-height\s*:/);
  // .research-response-content-root still pins --research-answer-font-delta for
  // the answer column; that moves onto the renderer when the answer adopts
  // .research-prose in a later phase.
});

test("shared tweet and attachment recipes do not depend on Home CSS", () => {
  assert.match(surfaceCss, /\.journal-tweet\s*\{/);
  assert.match(surfaceCss, /\.research-message-attachments\.has-prompt\s*\{/);
  const tweet = ruleBody(surfaceCss, ".journal-tweet");
  assert.match(tweet, /max-width:\s*var\(--research-feed-max-width\)/);
  const attachment = ruleBody(surfaceCss, ".research-message-attachment");
  assert.match(attachment, /width:\s*min\(100%, var\(--research-feed-max-width\)\)/);
  assert.match(attachment, /border:\s*1px solid var\(--surface-border-default\)/);
  assert.match(attachment, /border-radius:\s*12px/);
  const tweetStats = ruleBody(surfaceCss, ".journal-tweet-stats");
  assert.match(tweetStats, /align-items:\s*center/);
  assert.match(tweetStats, /line-height:\s*1/);
  assert.doesNotMatch(
    ruleBody(surfaceCss, ".research-message-attachments.has-prompt"),
    /border-top/,
  );
  assert.doesNotMatch(journalCss, /journal-tweet/);
  assert.doesNotMatch(journalCss, /\.research-message-attachments\.has-prompt\s*\{/);
  const journalColumn = ruleBody(journalCss, ".journal-column");
  assert.match(journalColumn, /width:\s*100%/);
  assert.match(
    journalColumn,
    /max-width:\s*calc\(var\(--research-feed-max-width\) \+ 2 \* var\(--journal-content-padding\)\)/,
  );
});
