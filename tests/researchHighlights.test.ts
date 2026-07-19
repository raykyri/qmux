import assert from "node:assert/strict";
import test from "node:test";
import {
  expandedResearchHighlightOffsets,
  intersectingResearchHighlightIds,
  overlappingResearchHighlightRegions,
} from "../src/lib/researchHighlights";

test("intersecting ids: overlap counts, edge contact does not", () => {
  const highlights = [
    { id: "a", start: 10, end: 20 },
    { id: "b", start: 30, end: 40 },
  ];
  assert.deepEqual(
    intersectingResearchHighlightIds({ start: 15, end: 35 }, highlights),
    ["a", "b"],
  );
  assert.deepEqual(
    intersectingResearchHighlightIds({ start: 20, end: 30 }, highlights),
    [],
  );
});

test("expand: no overlap yields nothing to expand", () => {
  assert.equal(
    expandedResearchHighlightOffsets({ start: 0, end: 5 }, [
      { id: "a", start: 10, end: 20 },
    ]),
    null,
  );
});

test("expand: a selection inside one highlight would only recreate it", () => {
  assert.equal(
    expandedResearchHighlightOffsets({ start: 12, end: 18 }, [
      { id: "a", start: 10, end: 20 },
    ]),
    null,
  );
  // Selecting the entire highlight is equally a no-op.
  assert.equal(
    expandedResearchHighlightOffsets({ start: 10, end: 20 }, [
      { id: "a", start: 10, end: 20 },
    ]),
    null,
  );
});

test("expand: a selection extending past a highlight grows it", () => {
  assert.deepEqual(
    expandedResearchHighlightOffsets({ start: 15, end: 25 }, [
      { id: "a", start: 10, end: 20 },
    ]),
    { start: 10, end: 25 },
  );
  assert.deepEqual(
    expandedResearchHighlightOffsets({ start: 5, end: 12 }, [
      { id: "a", start: 10, end: 20 },
    ]),
    { start: 5, end: 20 },
  );
});

test("expand: a selection bridging several highlights merges them", () => {
  assert.deepEqual(
    expandedResearchHighlightOffsets({ start: 15, end: 35 }, [
      { id: "a", start: 10, end: 20 },
      { id: "b", start: 30, end: 40 },
    ]),
    { start: 10, end: 40 },
  );
});

test("overlap regions: partial overlap yields the shared span only", () => {
  assert.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 10, end: 30 },
      { start: 20, end: 40 },
    ]),
    [{ start: 20, end: 30 }],
  );
});

test("overlap regions: edge contact and disjoint ranges yield nothing", () => {
  assert.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 10, end: 20 },
      { start: 20, end: 30 },
      { start: 40, end: 50 },
    ]),
    [],
  );
});

test("overlap regions: containment and triple stacks merge into one span", () => {
  assert.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 0, end: 50 },
      { start: 10, end: 20 },
      { start: 15, end: 35 },
    ]),
    [{ start: 10, end: 35 }],
  );
});

test("overlap regions: chained pairwise overlaps stay contiguous", () => {
  // a∩b ends exactly where b∩c begins; the paint should not split there.
  assert.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 10, end: 20 },
    ]),
    [{ start: 5, end: 15 }],
  );
});

test("overlap regions: empty ranges never count toward depth", () => {
  assert.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 10, end: 10 },
      { start: 5, end: 15 },
    ]),
    [],
  );
});

test("expand: only intersected highlights join the union", () => {
  assert.deepEqual(
    expandedResearchHighlightOffsets({ start: 15, end: 25 }, [
      { id: "a", start: 10, end: 20 },
      { id: "far", start: 100, end: 110 },
    ]),
    { start: 10, end: 25 },
  );
});
