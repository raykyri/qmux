// Pure anchoring + message-assembly logic for transcript message annotations.
// Kept free of DOM and React imports so it is unit-testable in isolation (the
// DOM helpers that read a live selection live in the annotation layer component).

import type { MessageAnnotation, MessageAnnotationAnchor } from "../types";

export interface AnnotationOffsets {
  start: number;
  end: number;
}

export interface ResolvedAnnotationRange extends AnnotationOffsets {
  id: string;
}

// Context captured on each side of a selection so a drifted anchor can be
// relocated. Matches the research-highlight context length.
export const TRANSCRIPT_ANNOTATION_CONTEXT_LENGTH = 128;

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

// Resolve an anchor to current offsets in `projection`, relocating via the exact
// quote plus surrounding context when the stored offsets have drifted. Unlike
// research highlights there is no revision gate: transcript messages stream and
// re-parse constantly, so we always attempt relocation and lean on the context
// match to avoid painting an unrelated occurrence of a short quote. Returns null
// when the quote (with agreeing context) can no longer be found — the annotation
// is then treated as detached rather than mispainted.
export function resolveAnnotationOffset(
  projection: string,
  anchor: MessageAnnotationAnchor,
): AnnotationOffsets | null {
  if (!anchor.exact) {
    return null;
  }
  if (
    anchor.start >= 0 &&
    anchor.end <= projection.length &&
    projection.slice(anchor.start, anchor.end) === anchor.exact &&
    contextMatchesAt(projection, anchor.start, anchor.exact.length, anchor.prefix, anchor.suffix)
  ) {
    return { start: anchor.start, end: anchor.end };
  }

  let bestStart = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let candidate = projection.indexOf(anchor.exact);
  while (candidate >= 0) {
    if (
      contextMatchesAt(projection, candidate, anchor.exact.length, anchor.prefix, anchor.suffix)
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

// Groups a flat annotation list by the message it belongs to, preserving
// creation order within each message. The backend already returns oldest-first.
export function groupAnnotationsByMessage(
  annotations: readonly MessageAnnotation[],
): Map<string, MessageAnnotation[]> {
  const grouped = new Map<string, MessageAnnotation[]>();
  for (const annotation of annotations) {
    const list = grouped.get(annotation.messageKey);
    if (list) {
      list.push(annotation);
    } else {
      grouped.set(annotation.messageKey, [annotation]);
    }
  }
  return grouped;
}

// Assembles collected annotations into a follow-up message for the agent: each
// annotated span is quoted, followed by the user's note. Used by "add to
// composer" — the text is inserted into the composer for review, not auto-sent.
export function buildAnnotationMessage(
  annotations: readonly Pick<MessageAnnotation, "comment" | "anchor">[],
): string {
  const blocks: string[] = [];
  for (const annotation of annotations) {
    const exact = annotation.anchor.exact.trim();
    const comment = annotation.comment.trim();
    if (!comment && !exact) {
      continue;
    }
    const quoted = exact
      ? exact
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      : "";
    blocks.push(quoted && comment ? `${quoted}\n${comment}` : quoted || comment);
  }
  if (blocks.length === 0) {
    return "";
  }
  const intro =
    blocks.length === 1
      ? "A note on your response:"
      : `${blocks.length} notes on your response:`;
  return `${intro}\n\n${blocks.join("\n\n")}`;
}

// Assembles the launch prompt for a side thread branched off a selected span:
// the quoted excerpt followed by the user's instruction. The branch resumes the
// full session, so the quote anchors the sub-conversation to the right place.
export function buildSideThreadPrompt(quote: string, instruction: string): string {
  const trimmedInstruction = instruction.trim();
  const trimmedQuote = quote.trim();
  if (!trimmedQuote) {
    return trimmedInstruction;
  }
  const quoted = trimmedQuote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return trimmedInstruction
    ? `Regarding this from your earlier message:\n\n${quoted}\n\n${trimmedInstruction}`
    : `Regarding this from your earlier message:\n\n${quoted}`;
}
