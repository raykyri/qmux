// Client-side mirrors of the backend's research-document rules
// (src-tauri/src/research.rs), so the composer can validate and derive a
// title preview without a round trip. The backend remains authoritative.

export const RESEARCH_DOCUMENT_WORD_LIMIT = 10_000;

export function countResearchDocumentWords(markdown: string): number {
  return markdown.match(/\S+/g)?.length ?? 0;
}

const DOCUMENT_TITLE_MAX_CHARS = 72;

/** Title for a document without an explicit one: the first line with content,
 * ATX heading markers stripped, truncated like a prompt-derived title. */
export function deriveResearchDocumentTitle(markdown: string): string {
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim().replace(/^#+/, "").trim();
    if (!line) {
      continue;
    }
    const normalized = line.split(/\s+/).join(" ");
    const characters = [...normalized];
    return characters.length > DOCUMENT_TITLE_MAX_CHARS
      ? `${characters.slice(0, DOCUMENT_TITLE_MAX_CHARS).join("").trimEnd()}…`
      : normalized;
  }
  return "Untitled document";
}
