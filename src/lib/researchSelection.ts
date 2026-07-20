export interface SnappedResearchSelection {
  start: number;
  end: number;
  direction: "forward" | "backward";
}

export type ResearchSelectionSnapper = (
  anchorOffset: number,
  focusOffset: number,
) => SnappedResearchSelection | null;

/** An empty targeted-ask composer follows its passage selection: clicking
 * away closes it, while composer controls, selection actions, and clicks that
 * leave a live passage selection alone do not. */
export function shouldDismissEmptyResearchAskOnClick(input: {
  followup: string;
  selectionCollapsed: boolean;
  insideComposer: boolean;
  insideSelectionActions: boolean;
}) {
  return (
    !input.followup.trim() &&
    input.selectionCollapsed &&
    !input.insideComposer &&
    !input.insideSelectionActions
  );
}

interface SelectionUnit {
  start: number;
  end: number;
}

interface WordSegment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

interface SegmenterLike {
  segment(input: string): Iterable<WordSegment>;
}

interface SegmenterConstructor {
  new (
    locale?: string,
    options?: { granularity: "word" | "grapheme" },
  ): SegmenterLike;
}

function segmenterConstructor() {
  return (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter ?? null;
}

function selectionUnits(text: string, locale?: string) {
  const Segmenter = segmenterConstructor();
  if (!Segmenter) {
    return null;
  }

  try {
    const units: SelectionUnit[] = [];
    for (const part of new Segmenter(locale, { granularity: "word" }).segment(text)) {
      if (part.isWordLike) {
        units.push({ start: part.index, end: part.index + part.segment.length });
      }
    }

    // Word segmentation deliberately labels emoji as non-word content. Treat
    // each emoji grapheme as a selectable unit so a snapped drag never splits
    // a ZWJ sequence or leaves an emoji-only answer impossible to select.
    if (/\p{Extended_Pictographic}/u.test(text)) {
      for (const part of new Segmenter(locale, { granularity: "grapheme" }).segment(text)) {
        if (/\p{Extended_Pictographic}/u.test(part.segment)) {
          units.push({ start: part.index, end: part.index + part.segment.length });
        }
      }
    }

    units.sort((a, b) => a.start - b.start || a.end - b.end);
    return units;
  } catch {
    // An invalid document language tag should degrade the same way as a
    // missing Segmenter: keep WebKit's native character-precise selection.
    return null;
  }
}

function firstUnitStartingAtOrAfter(units: SelectionUnit[], offset: number) {
  let low = 0;
  let high = units.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((units[middle]?.start ?? Number.POSITIVE_INFINITY) < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Unit that supplies a selection's leading edge. At a shared boundary this
 * chooses the unit to the right; in whitespace it chooses the next unit. */
function leadingUnit(units: SelectionUnit[], offset: number) {
  const nextIndex = firstUnitStartingAtOrAfter(units, offset);
  const next = units[nextIndex];
  if (next?.start === offset) {
    return next;
  }
  const previous = units[nextIndex - 1];
  return previous && previous.end >= offset ? previous : next ?? null;
}

/** Unit that supplies a selection's trailing edge. At a shared boundary this
 * chooses the unit to the left; in whitespace it chooses the previous unit. */
function trailingUnit(units: SelectionUnit[], offset: number) {
  const nextIndex = firstUnitStartingAtOrAfter(units, offset);
  const previous = units[nextIndex - 1];
  if (previous && previous.end >= offset) {
    return previous;
  }
  const next = units[nextIndex];
  return next?.start === offset ? next : previous ?? null;
}

/** Expands a drag's flat rendered-text offsets to linguistic word boundaries.
 * The returned offsets are normalized, while `direction` preserves which end
 * owns the live focus. Equal offsets deliberately select one whole unit once
 * the caller's pointer-distance threshold has activated the drag. */
export function createResearchSelectionSnapper(
  text: string,
  locale?: string,
): ResearchSelectionSnapper | null {
  const units = selectionUnits(text, locale);
  if (!text || !units || units.length === 0) {
    return null;
  }
  return (anchorOffset, focusOffset) => {
    if (
      anchorOffset < 0 ||
      focusOffset < 0 ||
      anchorOffset > text.length ||
      focusOffset > text.length
    ) {
      return null;
    }
    const direction = focusOffset < anchorOffset ? "backward" : "forward";
    const rawStart = direction === "forward" ? anchorOffset : focusOffset;
    const rawEnd = direction === "forward" ? focusOffset : anchorOffset;
    const first = leadingUnit(units, rawStart);
    const last = trailingUnit(units, rawEnd);

    // A short drag can land in the whitespace immediately beside its anchor.
    // Keep the anchor's whole word selected rather than producing no range.
    if (!first || !last || first.start > last.start) {
      const anchor =
        leadingUnit(units, anchorOffset) ?? trailingUnit(units, anchorOffset);
      return anchor
        ? { start: anchor.start, end: anchor.end, direction }
        : null;
    }
    return { start: first.start, end: last.end, direction };
  };
}

export function snapResearchDragSelection(
  text: string,
  anchorOffset: number,
  focusOffset: number,
  locale?: string,
): SnappedResearchSelection | null {
  return (
    createResearchSelectionSnapper(text, locale)?.(anchorOffset, focusOffset) ?? null
  );
}
