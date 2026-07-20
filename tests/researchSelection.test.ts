import assert from "node:assert/strict";
import test from "node:test";
import { snapResearchDragSelection } from "../src/lib/researchSelection";

test("snaps forward and backward drags to whole words", () => {
  const text = "The quick, brown fox.";
  assert.deepEqual(snapResearchDragSelection(text, 6, 13), {
    start: 4,
    end: 16,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection(text, 13, 6), {
    start: 4,
    end: 16,
    direction: "backward",
  });
});

test("keeps the anchor word selected while a drag reverses inside it", () => {
  const text = "The quick brown fox";
  assert.deepEqual(snapResearchDragSelection(text, 7, 5), {
    start: 4,
    end: 9,
    direction: "backward",
  });
  assert.deepEqual(snapResearchDragSelection(text, 7, 7), {
    start: 4,
    end: 9,
    direction: "forward",
  });
});

test("excludes outer whitespace and punctuation but retains them internally", () => {
  const text = "The quick, brown fox.";
  assert.deepEqual(snapResearchDragSelection(text, 5, 10), {
    start: 4,
    end: 9,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection(text, 5, 20), {
    start: 4,
    end: 20,
    direction: "forward",
  });
});

test("follows locale-aware boundaries for contractions, hyphens, and CJK", () => {
  assert.deepEqual(snapResearchDragSelection("don't stop", 2, 2), {
    start: 0,
    end: 5,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection("state-of-the-art", 1, 10), {
    start: 0,
    end: 12,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection("你好世界", 1, 3), {
    start: 0,
    end: 4,
    direction: "forward",
  });
});

test("treats composed emoji as indivisible selectable units", () => {
  const text = "go 👩‍💻 now";
  assert.deepEqual(snapResearchDragSelection(text, 4, 4), {
    start: 3,
    end: 8,
    direction: "forward",
  });
  assert.deepEqual(snapResearchDragSelection("e\u0301lan", 2, 2), {
    start: 0,
    end: 5,
    direction: "forward",
  });
});

test("rejects invalid offsets", () => {
  assert.equal(snapResearchDragSelection("answer", -1, 2), null);
  assert.equal(snapResearchDragSelection("answer", 1, 99), null);
});

test("falls back cleanly when the locale cannot be segmented", () => {
  assert.equal(snapResearchDragSelection("answer", 1, 2, "not_a_locale"), null);
});
