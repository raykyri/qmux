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

function contextMatchesAt(
  projection: string,
  start: number,
  exactLength: number,
  prefix: string,
  suffix: string,
) {
  const end = start + exactLength;
  const prefixMatches = prefix
    ? projection.slice(Math.max(0, start - prefix.length), start) === prefix
    : start === 0;
  const suffixMatches = suffix
    ? projection.slice(end, end + suffix.length) === suffix
    : end === projection.length;
  return prefixMatches && suffixMatches;
}

// Relocate only when both sides of the quote still agree. A visibility change
// can remove the selected source while leaving the same short phrase elsewhere;
// accepting an exact-only match would silently paint the unrelated occurrence.
export function resolveResearchHighlightOffset(
  projection: string,
  responseRevision: string,
  highlight: ResearchHighlight,
): ResearchHighlightOffsets | null {
  const { anchor } = highlight;
  if (anchor.responseRevision !== responseRevision || !anchor.exact) {
    return null;
  }

  if (
    anchor.start >= 0 &&
    anchor.end <= projection.length &&
    projection.slice(anchor.start, anchor.end) === anchor.exact &&
    contextMatchesAt(
      projection,
      anchor.start,
      anchor.exact.length,
      anchor.prefix,
      anchor.suffix,
    )
  ) {
    return { start: anchor.start, end: anchor.end };
  }

  let bestStart = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let candidate = projection.indexOf(anchor.exact);
  while (candidate >= 0) {
    if (
      contextMatchesAt(
        projection,
        candidate,
        anchor.exact.length,
        anchor.prefix,
        anchor.suffix,
      )
    ) {
      const distance = Math.abs(candidate - anchor.start);
      if (distance < bestDistance) {
        bestStart = candidate;
        bestDistance = distance;
      }
    }
    candidate = projection.indexOf(anchor.exact, candidate + 1);
  }
  return bestStart >= 0
    ? { start: bestStart, end: bestStart + anchor.exact.length }
    : null;
}
