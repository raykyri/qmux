import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TranscriptMarkdown, {
  transcriptMathPluginsReady,
} from "../src/components/TranscriptMarkdown";
import {
  MAX_WIKILINK_CHARS,
  escapeWikilinkTablePipes,
  splitWikilinkText,
  stripWikilinks,
} from "../src/lib/wikilinks";

function render(text: string, inline = false) {
  return renderToStaticMarkup(createElement(TranscriptMarkdown, { text, inline }));
}

const LINK = (term: string, label = term) =>
  `<a class="research-wikilink" data-wikilink="${term}" role="link" tabindex="0">${label}</a>`;

// Before the math chunk resolves the renderer runs the base plugin list; the
// wikilink transform must be present there too, or links appear only after
// the chunk swaps in.
test("wikilinks render before the math plugins are ready", () => {
  const html = render("See [[Rust]].");
  assert.ok(html.includes(LINK("Rust")), html);
});

await transcriptMathPluginsReady;

test("a bare wikilink renders as a destination-less link", () => {
  const html = render("See [[Rust]] today.");
  assert.ok(html.includes(`See ${LINK("Rust")} today.`), html);
  assert.equal(html.includes("[["), false);
  assert.equal(html.includes("href="), false);
});

test("an alias shows the alias and keeps the canonical term", () => {
  const html = render("Runs on [[Tokio|the tokio]] runtime.");
  assert.ok(html.includes(LINK("Tokio", "the tokio")), html);
});

test("terms and aliases are trimmed", () => {
  const html = render("[[ Rust | the Rust language ]]");
  assert.ok(html.includes(LINK("Rust", "the Rust language")), html);
});

test("every item in a list links independently", () => {
  const html = render("- [[Alpha]]: first\n- [[Beta|betas]]: second\n- plain");
  assert.ok(html.includes(`<li>${LINK("Alpha")}: first</li>`), html);
  assert.ok(html.includes(`<li>${LINK("Beta", "betas")}: second</li>`), html);
  assert.ok(html.includes("<li>plain</li>"), html);
});

test("wikilinks survive inside emphasis and table cells", () => {
  const html = render("**[[Bold term]]** and _[[Italic term]]_");
  assert.ok(html.includes(`<strong>${LINK("Bold term")}</strong>`), html);
  assert.ok(html.includes(`<em>${LINK("Italic term")}</em>`), html);
  const table = render("| a | b |\n| - | - |\n| [[Cell]] | x |");
  assert.ok(table.includes(`<td>${LINK("Cell")}</td>`), table);
});

// GFM splits table cells on `|` before inline parsing, so an alias wikilink
// on a row would otherwise land in two cells and push the rest of the row
// over by one, dropping the last cell. The renderer escapes the pipe first.
test("alias wikilinks keep their table cell intact", () => {
  const html = render(
    "| Network | Proof | Cost |\n|---|---|---|\n| [[X (Twitter)|X]] | Strong | Weak |\n| Plain [[Bluesky|Bsky]] and [[Trusted Verifier|Trusted Verifiers]] | a | b |",
  );
  assert.ok(html.includes(`<td>${LINK("X (Twitter)", "X")}</td><td>Strong</td><td>Weak</td>`), html);
  assert.ok(
    html.includes(
      `<td>Plain ${LINK("Bluesky", "Bsky")} and ${LINK("Trusted Verifier", "Trusted Verifiers")}</td><td>a</td><td>b</td>`,
    ),
    html,
  );
  assert.equal(html.includes("[["), false);
  assert.equal(html.includes("]]"), false);
});

test("a pipe the agent already escaped on a table row is not escaped twice", () => {
  const html = render("| a | b |\n|---|---|\n| [[X (Twitter)\\|X]] | c |");
  assert.ok(html.includes(`<td>${LINK("X (Twitter)", "X")}</td><td>c</td>`), html);
});

test("escapeWikilinkTablePipes only touches table rows outside code", () => {
  assert.equal(escapeWikilinkTablePipes("Runs on [[Tokio|the tokio]] runtime."), "Runs on [[Tokio|the tokio]] runtime.");
  assert.equal(escapeWikilinkTablePipes("| [[A|a]] | x |"), "| [[A\\|a]] | x |");
  assert.equal(escapeWikilinkTablePipes("[[A|a]] | x"), "[[A\\|a]] | x");
  assert.equal(escapeWikilinkTablePipes("| [[A\\|a]] | x |"), "| [[A\\|a]] | x |");
  assert.equal(escapeWikilinkTablePipes("| [[A]] | [[B|b]] |"), "| [[A]] | [[B\\|b]] |");
  const fenced = "```\n| [[A|a]] | x |\n```\n| [[B|b]] | y |";
  assert.equal(escapeWikilinkTablePipes(fenced), "```\n| [[A|a]] | x |\n```\n| [[B\\|b]] | y |");
  assert.equal(escapeWikilinkTablePipes("    | [[A|a]] | x |"), "    | [[A|a]] | x |");
  const untouched = "no pipes here [[A]]";
  assert.equal(escapeWikilinkTablePipes(untouched), untouched);
});

test("code, URLs, and existing links stay literal", () => {
  const html = render(
    "`arr[[0]]` and\n\n```\n[[Not a link]]\n```\n\n[text [[x]]](https://example.com/[[y]])",
  );
  assert.equal(html.includes("research-wikilink"), false, html);
  assert.ok(html.includes("arr[[0]]"), html);
  assert.ok(html.includes("[[Not a link]]"), html);
});

test("malformed markers stay literal text", () => {
  for (const source of [
    "[[]]",
    "[[ ]]",
    "[[unclosed",
    "[[two|pipes|here]]",
    "[[multi\nline]]",
    "[[a]b]]",
    `[[${"x".repeat(MAX_WIKILINK_CHARS + 1)}]]`,
  ]) {
    const html = render(source);
    assert.equal(html.includes("research-wikilink"), false, source);
  }
  // An extra opener is a literal bracket in front of a real link.
  assert.ok(render("[[[Term]]").includes(`[${LINK("Term")}`));
});

test("the inline (preview) variant keeps wikilinks as links", () => {
  const html = render("- [[Alpha]] leads", true);
  assert.ok(html.includes(LINK("Alpha")), html);
  assert.equal(html.includes("<li>"), false);
});

test("stripWikilinks keeps only display text and mirrors the parser", () => {
  assert.equal(stripWikilinks("no links"), "no links");
  assert.equal(
    stripWikilinks("Use [[Rust]] and [[Tokio|tokio's]] runtime."),
    "Use Rust and tokio's runtime.",
  );
  assert.equal(stripWikilinks("[[ spaced term ]]"), "spaced term");
  assert.equal(stripWikilinks("[[Term| ]]"), "Term");
  assert.equal(stripWikilinks("[[[Term]]"), "[Term");
  assert.equal(stripWikilinks("[[[[Term]]"), "[[Term");
  for (const literal of ["[[]]", "[[ ]]", "[[unclosed", "[[two|pipes|here]]", "[[a]b]]"]) {
    assert.equal(stripWikilinks(literal), literal);
  }
});

test("splitWikilinkText returns null when a text node has nothing to link", () => {
  assert.equal(splitWikilinkText("plain"), null);
  assert.equal(splitWikilinkText("[[ ]]"), null);
  const nodes = splitWikilinkText("a [[B]] c");
  assert.deepEqual(
    nodes?.map((node) => node.type),
    ["text", "wikilink", "text"],
  );
});
