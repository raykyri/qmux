import type { ResearchHighlight } from "../types";

export interface ResearchHighlightOffsets {
  start: number;
  end: number;
}

export interface ResolvedResearchHighlightRange extends ResearchHighlightOffsets {
  id: string;
}

// A selection removes stored highlights as whole annotations. Any positive
// overlap counts, including a selection contained inside one highlight or a
// range crossing parts of several; merely touching an edge does not.
export function intersectingResearchHighlightIds(
  selection: ResearchHighlightOffsets,
  highlights: ResolvedResearchHighlightRange[],
) {
  return highlights
    .filter(
      ({ start, end }) => selection.start < end && selection.end > start,
    )
    .map(({ id }) => id);
}

// Regions covered by two or more painted ranges (saved highlights and
// follow-up query anchors share one paint, so stacked coverage is invisible
// unless repainted). Edge contact is not overlap; regions where the covering
// set changes but depth stays at two or more merge into one.
export function overlappingResearchHighlightRegions(
  ranges: ResearchHighlightOffsets[],
): ResearchHighlightOffsets[] {
  const events: Array<{ at: number; delta: number }> = [];
  for (const { start, end } of ranges) {
    if (end <= start) {
      continue;
    }
    events.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  const regions: ResearchHighlightOffsets[] = [];
  let depth = 0;
  let regionStart: number | null = null;
  for (const { at, delta } of events) {
    depth += delta;
    if (depth >= 2 && regionStart === null) {
      regionStart = at;
    } else if (depth < 2 && regionStart !== null) {
      const last = regions[regions.length - 1];
      if (last && last.end === regionStart) {
        last.end = at;
      } else if (at > regionStart) {
        regions.push({ start: regionStart, end: at });
      }
      regionStart = null;
    }
  }
  return regions;
}

interface ResearchHighlightShortcutInput {
  key: string;
  defaultPrevented: boolean;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

function isBareShortcutKey(input: ResearchHighlightShortcutInput, key: string) {
  return (
    !input.defaultPrevented &&
    !input.repeat &&
    !input.metaKey &&
    !input.ctrlKey &&
    !input.altKey &&
    input.key.toLowerCase() === key
  );
}

export function isResearchHighlightActionShortcut(
  input: ResearchHighlightShortcutInput,
) {
  return isBareShortcutKey(input, "h");
}

export function isResearchAskActionShortcut(
  input: ResearchHighlightShortcutInput,
) {
  return isBareShortcutKey(input, "a");
}

export function isResearchExpandActionShortcut(
  input: ResearchHighlightShortcutInput,
) {
  return isBareShortcutKey(input, "e");
}

// A selection that overlaps stored highlights can grow them into one
// annotation: the expansion covers the selection plus every highlight it
// intersects (the same overlap rule removal uses). Null when there is nothing
// to expand — no overlap, or a selection already contained in a single
// highlight, where the union would just recreate it.
export function expandedResearchHighlightOffsets(
  selection: ResearchHighlightOffsets,
  highlights: ResolvedResearchHighlightRange[],
): ResearchHighlightOffsets | null {
  const intersecting = highlights.filter(
    ({ start, end }) => selection.start < end && selection.end > start,
  );
  if (intersecting.length === 0) {
    return null;
  }
  let start = selection.start;
  let end = selection.end;
  for (const highlight of intersecting) {
    start = Math.min(start, highlight.start);
    end = Math.max(end, highlight.end);
  }
  if (
    intersecting.length === 1 &&
    intersecting[0].start === start &&
    intersecting[0].end === end
  ) {
    return null;
  }
  return { start, end };
}

function contextSidesAt(
  projection: string,
  start: number,
  exactLength: number,
  prefix: string,
  suffix: string,
): { prefix: boolean; suffix: boolean; both: boolean } {
  const end = start + exactLength;
  const prefixMatches = prefix
    ? projection.slice(Math.max(0, start - prefix.length), start) === prefix
    : start === 0;
  const suffixMatches = suffix
    ? projection.slice(end, end + suffix.length) === suffix
    : end === projection.length;
  return {
    prefix: prefixMatches,
    suffix: suffixMatches,
    both: prefixMatches && suffixMatches,
  };
}

// Locate a highlight's passage in the current rendered-text projection.
//
// Two things move the stored offset. A visibility toggle keeps the same
// snapshot revision but shifts the flat text as tool/thinking rows appear.
// An edit to the document produces a new revision with genuinely different
// text. Both are handled the same way — re-locate from the saved quote and
// its surrounding context instead of trusting the raw offset — so a highlight
// survives an edit elsewhere in the document rather than being orphaned the
// moment the revision changes.
//
//   1. Same revision: the stored offset addresses the exact text, so accept it
//      in place once its context still checks out (the fast path).
//   2. Otherwise scan every occurrence of the quote and keep the nearest one
//      whose prefix and suffix both still agree.
//   3. If no occurrence keeps both sides — an edit reached the quote's own
//      neighbourhood — relocate only to a single occurrence that keeps one
//      side, so an identical short phrase surviving elsewhere can never be
//      mistaken for it.
//
// Returns null when the quote is gone or too ambiguous to place safely; the
// caller then treats the highlight as orphaned rather than painting a guess.
export function resolveResearchHighlightOffset(
  projection: string,
  responseRevision: string,
  highlight: ResearchHighlight,
): ResearchHighlightOffsets | null {
  const { anchor } = highlight;
  if (!anchor.exact) {
    return null;
  }

  if (
    anchor.responseRevision === responseRevision &&
    anchor.start >= 0 &&
    anchor.end <= projection.length &&
    projection.slice(anchor.start, anchor.end) === anchor.exact &&
    contextSidesAt(
      projection,
      anchor.start,
      anchor.exact.length,
      anchor.prefix,
      anchor.suffix,
    ).both
  ) {
    return { start: anchor.start, end: anchor.end };
  }

  let bestStart = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let looseStart = -1;
  let looseCount = 0;
  let candidate = projection.indexOf(anchor.exact);
  while (candidate >= 0) {
    const sides = contextSidesAt(
      projection,
      candidate,
      anchor.exact.length,
      anchor.prefix,
      anchor.suffix,
    );
    if (sides.both) {
      const distance = Math.abs(candidate - anchor.start);
      if (distance < bestDistance) {
        bestStart = candidate;
        bestDistance = distance;
      }
    } else if (sides.prefix || sides.suffix) {
      looseStart = candidate;
      looseCount += 1;
    }
    candidate = projection.indexOf(anchor.exact, candidate + 1);
  }
  if (bestStart >= 0) {
    return { start: bestStart, end: bestStart + anchor.exact.length };
  }
  if (looseCount === 1) {
    return { start: looseStart, end: looseStart + anchor.exact.length };
  }
  return null;
}
