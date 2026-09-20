// Wikilink syntax for key terms in research answers. The launch prompt asks the
// agent to mark terms as `[[Term]]` or `[[Canonical term|text as written]]`;
// the transcript renderer turns those into link elements, and every plain-text
// consumer (copies, exports) strips the brackets. The Rust side mirrors this
// grammar in `src-tauri/src/wikilinks.rs` for previews and recap sources; keep
// the two in step.
//
// Grammar: `[[` body `]]` on one line. The body is a term, optionally followed
// by `|` and display text. Neither part may contain `[`, `]`, `|`, or a
// newline, and each is capped at MAX_WIKILINK_CHARS code points. A term that is
// only whitespace is not a link. Anything that fails the grammar stays literal
// text, so a preview cut mid-link or a stray `[[` renders exactly as written.
//
// Dependency-free on purpose: `turnTimeline.ts` imports the strip helper and
// must stay loadable by the node test runner without the markdown packages.

import {
  backtickRunLength,
  closesFence,
  markerRunAtLineStart,
  matchingBacktickRunEnd,
  type MarkdownFence,
} from "./markdownMathDelimiters";

export const MAX_WIKILINK_CHARS = 160;

const BODY_PART = `[^\\[\\]|\\n]{1,${MAX_WIKILINK_CHARS}}`;
const WIKILINK_PATTERN = new RegExp(
  `\\[\\[(${BODY_PART})(?:\\|(${BODY_PART}))?\\]\\]`,
  "gu",
);

export interface Wikilink {
  /** The canonical term, trimmed. */
  term: string;
  /** What the reader sees: the alias when given, otherwise the term. */
  label: string;
}

export function parseWikilinkBody(term: string, alias?: string): Wikilink | null {
  const trimmedTerm = term.trim();
  if (!trimmedTerm) {
    return null;
  }
  const trimmedAlias = alias?.trim();
  return { term: trimmedTerm, label: trimmedAlias || trimmedTerm };
}

function stripWikilinksInProse(segment: string): string {
  return segment.replace(WIKILINK_PATTERN, (match, term: string, alias?: string) => {
    const link = parseWikilinkBody(term, alias);
    return link ? link.label : match;
  });
}

/** Rewrite the stretches of one line that sit outside code spans, leaving the
 * spans — and any unmatched backtick run, which is literal text — verbatim. */
function stripWikilinksOutsideCodeSpans(line: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const tick = line.indexOf("`", cursor);
    if (tick === -1) {
      output += stripWikilinksInProse(line.slice(cursor));
      break;
    }
    output += stripWikilinksInProse(line.slice(cursor, tick));
    const runLength = backtickRunLength(line, tick);
    const spanEnd = matchingBacktickRunEnd(line, tick + runLength, runLength);
    if (spanEnd === null) {
      output += line.slice(tick, tick + runLength);
      cursor = tick + runLength;
      continue;
    }
    output += line.slice(tick, spanEnd);
    cursor = spanEnd;
  }
  return output;
}

/** Replace every wikilink with its display text, skipping fenced code blocks,
 * indented code lines, and code spans. The mdast transform below skips `code`
 * and `inlineCode` nodes, so the plain-text derivations must skip them too:
 * these helpers also run over terminal agent output, where `if [[ -f x ]]` and
 * Lua `t[[str]]` would otherwise lose their brackets on copy or export. The
 * block-level scan is the same conservative one `escapeWikilinkTablePipes`
 * uses. */
export function stripWikilinks(text: string): string {
  if (!text.includes("[[")) {
    return text;
  }
  const lines = text.split("\n");
  let fence: MarkdownFence | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
      continue;
    }
    const openingFence = markerRunAtLineStart(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }
    if (line.startsWith("    ") || line.startsWith("\t")) {
      continue;
    }
    if (!line.includes("[[")) {
      continue;
    }
    const stripped = stripWikilinksOutsideCodeSpans(line);
    if (stripped !== line) {
      lines[i] = stripped;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : text;
}

// An alias wikilink whose `|` is not already escaped. Used to escape the pipe
// on table rows; a term ending in `\` means the agent escaped it already, and
// doubling the backslash would turn it back into a cell separator.
const UNESCAPED_ALIAS_PATTERN = new RegExp(
  `\\[\\[(${BODY_PART})(?<!\\\\)\\|(${BODY_PART})\\]\\]`,
  "gu",
);

/** Escape the alias pipe of every wikilink on a Markdown table row, so the
 * GFM parser does not split `[[Term|shown]]` into two cells (which also drops
 * the row's overflow cell). GFM reads `\|` in a cell as a literal `|`, so the
 * remark transform still sees `[[Term|shown]]` after parsing. Runs on the
 * source before parsing, since the split happens during parsing.
 *
 * A line counts as a table row when it has a `|` outside its wikilinks; that
 * covers rows with or without leading pipes, and leaves prose alone. Lines in
 * fenced or indented code are skipped. Code spans on a row are rewritten
 * too: GFM splits cells on a pipe inside a code span as well, and `\|` is
 * the spec's way to keep one literal there. */
export function escapeWikilinkTablePipes(source: string): string {
  if (!source.includes("[[") || !source.includes("|")) {
    return source;
  }
  const lines = source.split("\n");
  let fence: MarkdownFence | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
      continue;
    }
    const openingFence = markerRunAtLineStart(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }
    if (line.startsWith("    ") || line.startsWith("\t")) {
      continue;
    }
    if (!line.includes("[[") || !line.replace(WIKILINK_PATTERN, "").includes("|")) {
      continue;
    }
    const escaped = line.replace(UNESCAPED_ALIAS_PATTERN, "[[$1\\|$2]]");
    if (escaped !== line) {
      lines[i] = escaped;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : source;
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

export const WIKILINK_CLASS_NAME = "research-wikilink";

// Contexts whose text must stay literal: code, URLs and existing links, raw
// HTML, and TeX. The prompt tells the agent not to link inside these, and the
// renderer must not either, so a bracketed array index in a code span or a
// `[[` inside a URL never becomes a link.
const OPAQUE_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "html",
  "math",
  "inlineMath",
]);

function wikilinkNode(link: Wikilink): MdastNode {
  return {
    type: "wikilink",
    data: {
      hName: "a",
      hProperties: { className: [WIKILINK_CLASS_NAME], dataWikilink: link.term },
    },
    children: [{ type: "text", value: link.label }],
  };
}

/** Split one mdast text node around its wikilinks, or return null when it has
 * none so the caller leaves the original node untouched. */
export function splitWikilinkText(value: string): MdastNode[] | null {
  if (!value.includes("[[")) {
    return null;
  }
  const nodes: MdastNode[] = [];
  let cursor = 0;
  WIKILINK_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(WIKILINK_PATTERN)) {
    const link = parseWikilinkBody(match[1], match[2]);
    if (!link) {
      continue;
    }
    const start = match.index ?? 0;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(wikilinkNode(link));
    cursor = start + match[0].length;
  }
  if (nodes.length === 0) {
    return null;
  }
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

/** remark transform: `[[Term]]` / `[[Term|shown]]` in prose becomes an `a`
 * element carrying `class="research-wikilink"` and `data-wikilink="Term"`,
 * with no destination. The transcript link component recognizes the marker.
 * Runs as a plain tree walk (same approach as the math tweaks) rather than a
 * micromark extension: `[[…]]` is already literal text to CommonMark, so
 * there is no tokenizer conflict to resolve. */
export function remarkWikilinks() {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      const children = node.children;
      if (!children) {
        return;
      }
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (OPAQUE_NODE_TYPES.has(child.type)) {
          continue;
        }
        if (child.type === "text") {
          const replacement = splitWikilinkText(child.value ?? "");
          if (replacement) {
            children.splice(i, 1, ...replacement);
            i += replacement.length - 1;
          }
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}
