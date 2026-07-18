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
