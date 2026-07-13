import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_DOCUMENT_WORD_LIMIT,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
} from "../src/lib/researchDocuments";

test("word counting matches whitespace-delimited tokens", () => {
  assert.equal(countResearchDocumentWords(""), 0);
  assert.equal(countResearchDocumentWords("   \n\t"), 0);
  assert.equal(countResearchDocumentWords("one"), 1);
  assert.equal(countResearchDocumentWords("# Heading\n\nTwo  words\there\n"), 5);
  assert.equal(
    countResearchDocumentWords(Array(RESEARCH_DOCUMENT_WORD_LIMIT).fill("w").join(" ")),
    RESEARCH_DOCUMENT_WORD_LIMIT,
  );
});

test("word counting agrees with Rust split_whitespace on the code points JS \\s gets wrong", () => {
  // U+0085 NEL is Unicode White_Space (a separator to the backend) but not
  // JS \s; U+FEFF is JS \s but not White_Space. Pinned against the matching
  // backend test in src-tauri/src/research.rs.
  assert.equal(countResearchDocumentWords("a\u0085b"), 2);
  assert.equal(countResearchDocumentWords("a\uFEFFb"), 1);
});

test("derived titles prefer the first content line and strip heading markers", () => {
  assert.equal(deriveResearchDocumentTitle("\n\n## Quarterly Report\n\nBody"), "Quarterly Report");
  assert.equal(deriveResearchDocumentTitle("plain first line\nsecond"), "plain first line");
  // A heading-marker-only line has no content; the next line wins.
  assert.equal(deriveResearchDocumentTitle("#\nReal title"), "Real title");
  assert.equal(deriveResearchDocumentTitle("  \n\t"), "Untitled document");
});

test("derived titles normalize whitespace and truncate like backend titles", () => {
  assert.equal(deriveResearchDocumentTitle("a   spaced  title"), "a spaced title");
  const long = deriveResearchDocumentTitle(`# ${"x".repeat(80)}`);
  assert.equal([...long].length, 73);
  assert.ok(long.endsWith("…"));
});
