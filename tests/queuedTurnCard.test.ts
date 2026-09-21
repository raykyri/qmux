import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderQueuedTurnText } from "../src/components/QueuedTurnCard";

function renderQueuedText(text: string) {
  return renderToStaticMarkup(
    createElement(Fragment, null, renderQueuedTurnText(text)),
  );
}

test("queued images use rows separate from surrounding text", () => {
  const markup = renderQueuedText("before [Image #1] after");

  assert.match(
    markup,
    /^<span class="queued-turn-content"><span class="queued-turn-text-row">before <\/span><span class="queued-turn-image-row">/,
  );
  assert.match(
    markup,
    /<\/span><span class="queued-turn-text-row"> after<\/span><\/span>$/,
  );
});

test("adjacent queued images share one image row", () => {
  const markup = renderQueuedText("[Image #1]\n[Image #2]");

  assert.equal(markup.match(/queued-turn-image-row/g)?.length, 1);
  assert.equal(markup.match(/queued-turn-image-chip/g)?.length, 2);
  assert.doesNotMatch(markup, /queued-turn-text-row/);
});
