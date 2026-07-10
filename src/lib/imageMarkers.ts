// Pasted images reach transcripts as literal text markers: Claude Code stores the
// bytes in ~/.claude/image-cache and writes "[Image: source: <path>]" as its own
// text block, while images referenced inline in a typed prompt appear as
// "[Image #N]". Both shapes collapse to a muted "[Image]" chip in compact views.
export interface ImageMarkerSegment {
  kind: "text" | "image";
  text: string;
}

export const COLLAPSED_IMAGE_LABEL = "[Image]";

const IMAGE_MARKER_SOURCE = /\[Image: source: [^\]\n]*\]|\[Image #\d+\]/;

function imageMarkerPattern() {
  return new RegExp(IMAGE_MARKER_SOURCE.source, "g");
}

export function splitImageMarkers(text: string): ImageMarkerSegment[] {
  const segments: ImageMarkerSegment[] = [];
  const pattern = imageMarkerPattern();
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > index) {
      segments.push({ kind: "text", text: text.slice(index, start) });
    }
    segments.push({ kind: "image", text: match[0] });
    index = start + match[0].length;
  }

  if (index < text.length || segments.length === 0) {
    segments.push({ kind: "text", text: text.slice(index) });
  }

  return segments;
}

export function collapseImageMarkers(text: string): string {
  return text.replace(imageMarkerPattern(), COLLAPSED_IMAGE_LABEL);
}
