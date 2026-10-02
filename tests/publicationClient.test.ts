import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = readFileSync(new URL("../web/client/publication.js", import.meta.url), "utf8");
function page(body: string) {
  const dom = new JSDOM(body, { url: "https://qmux.app/p/example", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect(10, 10, 100, 20);
  dom.window.Range.prototype.getClientRects = () => [new dom.window.DOMRect(10, 10, 100, 20)] as unknown as DOMRectList;
  return dom;
}
const composer = `<form class="proposal-composer"><input name="anchor"><div data-qmux-proposal-quote hidden><span class="research-followup-quote"></span><button type="button" class="research-followup-quote-dismiss">Clear</button></div><textarea></textarea></form>`;

test("publication client copies the original markdown", async (t) => {
  const dom = page('<button data-qmux-copy="markdown" hidden>Copy</button><script type="application/json" id="markdown">"**original**"</script>');
  t.after(() => dom.window.close());
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  dom.window.eval(script);
  const button = dom.window.document.querySelector("button")!;
  assert.equal(button.hidden, false);
  button.click(); await Promise.resolve();
  assert.deepEqual(copied, ["**original**"]); assert.equal(button.textContent, "Copied");
});

test("selection creates a trimmed proposal anchor, focuses the prompt, and clears the quote", async (t) => {
  const dom = page(`<div id="qmux-answer-root">  Selected passage  </div>${composer}`);
  t.after(() => dom.window.close()); dom.window.eval(script);
  const document = dom.window.document;
  const range = document.createRange(); range.selectNodeContents(document.getElementById("qmux-answer-root")!);
  dom.window.getSelection()!.addRange(range);
  document.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  const ask = document.querySelector<HTMLButtonElement>(".research-highlight-action")!;
  assert.equal(ask.hidden, false); ask.click();
  const input = document.querySelector<HTMLInputElement>("input[name=anchor]")!;
  assert.deepEqual(JSON.parse(input.value), { start: 2, end: 18, exact: "Selected passage", prefix: "  ", suffix: "  " });
  assert.equal(document.activeElement, document.querySelector("textarea"));
  assert.equal(document.querySelector<HTMLElement>("[data-qmux-proposal-quote]")!.hidden, false);
  document.querySelector<HTMLButtonElement>(".research-followup-quote-dismiss")!.click();
  assert.equal(input.value, ""); assert.equal(document.querySelector<HTMLElement>("[data-qmux-proposal-quote]")!.hidden, true);
});

test("conversation selections cannot cross turn boundaries", async (t) => {
  const dom = page(`<div id="qmux-answer-root"><div class="research-conversation"><div class="conversation-turn-body">First turn</div><div class="conversation-turn-body">Second turn</div></div></div>${composer}`);
  t.after(() => dom.window.close()); dom.window.eval(script);
  const document = dom.window.document;
  const turns = document.querySelectorAll(".conversation-turn-body");
  const range = document.createRange(); range.setStart(turns[0].firstChild!, 0); range.setEnd(turns[1].firstChild!, 6);
  dom.window.getSelection()!.addRange(range);
  document.dispatchEvent(new dom.window.MouseEvent("mouseup")); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(document.querySelector<HTMLButtonElement>(".research-highlight-action")!.hidden, true);
});

test("stored anchors relocate and link their cards on keyboard focus", (t) => {
  const anchor = { nodeId: "child", exact: "passage", start: 0, end: 7, prefix: "", suffix: "" };
  const dom = page(`<div class="research-response-grid"><div id="qmux-answer-root">Moved passage here</div><aside class="research-followups"><div class="research-followup-cards"><a href="/next" data-anchor-node-id="child">Follow-up</a></div></aside></div><script type="application/json" id="qmux-anchor-data">${JSON.stringify([anchor])}</script>`);
  t.after(() => dom.window.close()); dom.window.eval(script);
  const card = dom.window.document.querySelector<HTMLAnchorElement>("[data-anchor-node-id]")!;
  assert.equal(card.classList.contains("is-anchored"), true);
  card.focus(); assert.equal(card.classList.contains("is-anchor-linked"), true);
  card.blur(); assert.equal(card.classList.contains("is-anchor-linked"), false);
});
