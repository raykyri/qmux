// Client-side mirrors of the backend's research-document rules
// (src-tauri/src/research.rs), so the composer can validate and derive a
// title preview without a round trip. The backend remains authoritative, and
// both sides pin the shared cases in tests (tests/researchDocuments.test.ts,
// research.rs document_* tests) so drift is caught.

export const RESEARCH_DOCUMENT_WORD_LIMIT = 10_000;
export const RESEARCH_DOCUMENT_BYTE_LIMIT = 2 * 1024 * 1024;

// Tokens are delimited exactly like Rust's split_whitespace (the Unicode
// White_Space set): JS \s must additionally treat U+0085 NEL as whitespace
// and U+FEFF as a word character, or the composer's count disagrees with the
// backend validator near the limit.
const DOCUMENT_WORD_PATTERN = /(?:[^\s\u0085]|\uFEFF)+/gu;

export function countResearchDocumentWords(markdown: string): number {
  return markdown.match(DOCUMENT_WORD_PATTERN)?.length ?? 0;
}

const DOCUMENT_TITLE_MAX_CHARS = 72;

/** Title for a document without an explicit one: the first line with content,
 * ATX heading markers stripped, truncated like a prompt-derived title. Scans
 * line by line rather than splitting the whole document — this feeds a
 * composer placeholder recomputed as the user types. */
export function deriveResearchDocumentTitle(markdown: string): string {
  let start = 0;
  while (start <= markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const rawLine = newline === -1 ? markdown.slice(start) : markdown.slice(start, newline);
    const line = rawLine.trim().replace(/^#+/, "").trim();
    if (line) {
      const normalized = line.split(/\s+/).join(" ");
      const characters = [...normalized];
      return characters.length > DOCUMENT_TITLE_MAX_CHARS
        ? `${characters.slice(0, DOCUMENT_TITLE_MAX_CHARS).join("").trimEnd()}…`
        : normalized;
    }
    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }
  return "Untitled document";
}
