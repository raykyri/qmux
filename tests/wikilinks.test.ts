import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TranscriptMarkdown, {
  TranscriptWikilinkActionsProvider,
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

// Outside a wikilink provider the term is a plain span: nothing to activate, so
// nothing focusable. `LINKED` is the interactive form a provider renders.
const LINK = (term: string, label = term) =>
  `<span class="research-wikilink" data-wikilink="${term}">${label}</span>`;
const LINKED = (
  term: string,
  label = term,
  className = "research-wikilink",
  title = `Create encyclopedia page: ${term}`,
) =>
  `<a class="${className}" data-wikilink="${term}" role="link" tabindex="0" title="${title}">${label}</a>`;

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

test("stripWikilinks leaves fenced code blocks alone", () => {
  const fenced = 'Check it:\n\n```bash\nif [[ -f x ]]; then echo hi; fi\n```\n\nDone.';
  assert.equal(stripWikilinks(fenced), fenced);
  const tildes = '~~~\nif [[ -n "$VAR" ]]; then :; fi\n~~~';
  assert.equal(stripWikilinks(tildes), tildes);
  const indented = "text\n\n    if [[ -d dir ]]; then :; fi\n";
  assert.equal(stripWikilinks(indented), indented);
  // An unclosed fence runs to the end of the text.
  assert.equal(
    stripWikilinks("before [[Rust]]\n```\n[[ -f x ]]\nstill code [[Term]]"),
    "before Rust\n```\n[[ -f x ]]\nstill code [[Term]]",
  );
});

test("stripWikilinks leaves code spans alone", () => {
  assert.equal(
    stripWikilinks('Use `[[ -n "$VAR" ]]` to test.'),
    'Use `[[ -n "$VAR" ]]` to test.',
  );
  assert.equal(
    stripWikilinks("Lua ``t[[str]]`` and arr `[[1]]`."),
    "Lua ``t[[str]]`` and arr `[[1]]`.",
  );
  // An unmatched backtick run is literal text, so the prose around it strips.
  assert.equal(stripWikilinks("a ` stray tick and [[Term]]"), "a ` stray tick and Term");
});

test("stripWikilinks still strips genuine wikilinks beside code", () => {
  assert.equal(
    stripWikilinks("See [[Rust]].\n\n```bash\n[[ -f x ]]\n```\n\nAnd [[Tokio|tokio]]."),
    "See Rust.\n\n```bash\n[[ -f x ]]\n```\n\nAnd tokio.",
  );
  assert.equal(
    stripWikilinks("[[Rust]] uses `[[Term]]` then [[Tokio]]"),
    "Rust uses `[[Term]]` then Tokio",
  );
});

test("the renderer and stripWikilinks agree about code", () => {
  const source = 'Use [[Rust]] and `[[ -n "$VAR" ]]`.';
  const html = render(source);
  assert.ok(html.includes(LINK("Rust")), html);
  assert.ok(html.includes("<code>[[ -n &quot;$VAR&quot; ]]</code>"), html);
  assert.equal((html.match(/research-wikilink/g) ?? []).length, 1, html);
  assert.equal(stripWikilinks(source), 'Use Rust and `[[ -n "$VAR" ]]`.');
});

test("a provider turns the term into an activatable link", () => {
  const html = renderToStaticMarkup(
    createElement(
      TranscriptWikilinkActionsProvider,
      {
        actions: { resolve: (term: string) => (term === "Rust" ? "ready" : null), activate: () => {} },
      },
      createElement(TranscriptMarkdown, { text: "See [[Rust]] and [[Tokio]]." }),
    ),
  );
  assert.ok(
    html.includes(
      LINKED("Rust", "Rust", "research-wikilink is-ready", "Open encyclopedia page: Rust"),
    ),
    html,
  );
  assert.ok(html.includes(LINKED("Tokio")), html);
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
