// Encyclopedia pages grown from wikilinks. Slug derivation and the click
// context gathered for page generation live here so both are unit-testable
// without React; the backend (src-tauri/src/encyclopedia.rs) owns storage
// and generation and mirrors the slug rules. Keep the two in step.

import type {
  EncyclopediaPage,
  EncyclopediaPageStatus,
  EncyclopediaPageSummary,
  QmuxEvent,
} from "../types";

export const MAX_ENCYCLOPEDIA_SLUG_CHARS = 80;
/** Cap on the plain-text excerpt sent with a page request. */
export const ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT = 1_500;

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** Lowercase alphanumeric runs joined by single dashes, capped in characters.
 * Mirrors `encyclopedia_slug` in the backend, which uses the same slug as
 * the page's file name. */
export function encyclopediaSlug(term: string): string {
  let slug = "";
  let count = 0;
  let pendingDash = false;
  for (const ch of term.trim().toLowerCase()) {
    if (ALPHANUMERIC.test(ch)) {
      if (pendingDash && slug) {
        if (count + 1 >= MAX_ENCYCLOPEDIA_SLUG_CHARS) break;
        slug += "-";
        count += 1;
      }
      pendingDash = false;
      if (count >= MAX_ENCYCLOPEDIA_SLUG_CHARS) break;
      slug += ch;
      count += 1;
    } else {
      pendingDash = true;
    }
  }
  return slug;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The head of `text` within `limit`, ending on a word boundary. With no
 * boundary inside the limit, `hard` keeps the partial head; otherwise the
 * result is empty, since a fragment of one word adds no context. */
function cutAtWordStart(text: string, limit: number, hard = false): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const cut = head.lastIndexOf(" ");
  return cut > 0 ? head.slice(0, cut) : hard ? head : "";
}

/** The tail of `text` within `limit`, starting on a word boundary. */
function cutAtWordEnd(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  const cut = tail.indexOf(" ");
  return cut >= 0 ? tail.slice(cut + 1) : "";
}

const EXCERPT_SEPARATOR = "\n\n";

/** Joins the clicked block with its neighbors into one excerpt within
 * `limit` characters. The block is always kept (cut at the limit if it alone
 * exceeds it); the remaining budget is split between the tail of the previous
 * block and the head of the next, so the term's own sentence never loses room
 * to its surroundings. */
export function buildWikilinkExcerpt(
  before: string | null | undefined,
  block: string,
  after: string | null | undefined,
  limit = ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT,
): string {
  const center = cutAtWordStart(collapseWhitespace(block), limit, true);
  const previous = collapseWhitespace(before ?? "");
  const next = collapseWhitespace(after ?? "");
  let budget =
    limit -
    center.length -
    (previous ? EXCERPT_SEPARATOR.length : 0) -
    (next ? EXCERPT_SEPARATOR.length : 0);
  const parts: string[] = [];
  if (previous && budget > 0) {
    const share = next ? Math.ceil(budget / 2) : budget;
    const piece = cutAtWordEnd(previous, share);
    if (piece) {
      parts.push(piece);
      budget -= piece.length;
    }
  }
  parts.push(center);
  if (next && budget > 0) {
    const piece = cutAtWordStart(next, budget);
    if (piece) parts.push(piece);
  }
  return parts.join(EXCERPT_SEPARATOR);
}

export interface WikilinkClickContext {
  excerpt: string;
  /** Other wikilink terms in the same block, the strongest disambiguator. */
  siblingTerms: string[];
}

const BLOCK_SELECTOR = "li, p, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, pre";

/** Neighbor blocks around a block element. A list item's neighbors are the
 * adjacent items, falling back to the block before or after the whole list at
 * either end so the first item still sees the paragraph that introduced it. */
function neighborText(block: Element, direction: "previous" | "next"): string | null {
  const sibling =
    direction === "previous" ? block.previousElementSibling : block.nextElementSibling;
  if (sibling) return sibling.textContent;
  if (block.tagName === "LI") {
    const list = block.parentElement;
    const beyond =
      direction === "previous" ? list?.previousElementSibling : list?.nextElementSibling;
    return beyond?.textContent ?? null;
  }
  return null;
}

/** Gathers generation context from the DOM around a clicked wikilink. */
export function wikilinkClickContext(anchor: Element, term: string): WikilinkClickContext {
  const block = anchor.closest(BLOCK_SELECTOR) ?? anchor.parentElement ?? anchor;
  const excerpt = buildWikilinkExcerpt(
    neighborText(block, "previous"),
    block.textContent ?? "",
    neighborText(block, "next"),
  );
  const siblingTerms: string[] = [];
  const seen = new Set<string>([term.toLowerCase()]);
  for (const element of block.querySelectorAll("[data-wikilink]")) {
    const sibling = element.getAttribute("data-wikilink")?.trim();
    if (!sibling) continue;
    const key = sibling.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    siblingTerms.push(sibling);
  }
  return { excerpt, siblingTerms };
}

function compareTitles(left: EncyclopediaPageSummary, right: EncyclopediaPageSummary): number {
  return (
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    left.slug.localeCompare(right.slug)
  );
}

export function upsertEncyclopediaSummary(
  pages: EncyclopediaPageSummary[],
  summary: EncyclopediaPageSummary,
): EncyclopediaPageSummary[] {
  const next = pages.filter((page) => page.slug !== summary.slug);
  next.push(summary);
  next.sort(compareTitles);
  return next;
}

export function removeEncyclopediaSummary(
  pages: EncyclopediaPageSummary[],
  slug: string,
): EncyclopediaPageSummary[] {
  return pages.some((page) => page.slug === slug)
    ? pages.filter((page) => page.slug !== slug)
    : pages;
}

export function encyclopediaSummaryOfPage(page: EncyclopediaPage): EncyclopediaPageSummary {
  return {
    slug: page.slug,
    term: page.term,
    title: page.title,
    status: page.status,
    workspaceId: page.workspaceId,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    sourceCount: page.sources.length,
  };
}

export function encyclopediaPageStatusBySlug(
  pages: EncyclopediaPageSummary[],
): Map<string, EncyclopediaPageStatus> {
  return new Map(pages.map((page) => [page.slug, page.status]));
}

export type EncyclopediaEvent =
  | { type: "encyclopedia.page.updated"; page: EncyclopediaPage }
  | { type: "encyclopedia.page.removed"; workspaceId: string; slug: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isEncyclopediaPage(value: unknown): value is EncyclopediaPage {
  return (
    isRecord(value) &&
    typeof value.slug === "string" &&
    typeof value.term === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    (value.status === "generating" || value.status === "ready" || value.status === "failed") &&
    typeof value.workspaceId === "string" &&
    Array.isArray(value.sources) &&
    Array.isArray(value.links)
  );
}

/** Narrow a backend event to an encyclopedia event, or null when it is
 * unrelated or malformed. */
export function parseEncyclopediaEvent(event: QmuxEvent): EncyclopediaEvent | null {
  const payload = event.payload;
  if (event.type === "encyclopedia.page.updated") {
    return isEncyclopediaPage(payload.page) ? { type: event.type, page: payload.page } : null;
  }
  if (event.type === "encyclopedia.page.removed") {
    return typeof payload.workspaceId === "string" && typeof payload.slug === "string"
      ? { type: event.type, workspaceId: payload.workspaceId, slug: payload.slug }
      : null;
  }
  return null;
}
