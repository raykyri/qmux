import assert from "node:assert/strict";
import test from "node:test";
import { readActivityFeedState, saveActivityFeedState } from "../src/lib/activityFeedState";

const key = "qmux.research-activity.state.v1";
function storage(initial: string | null = null) {
  const values = new Map<string, string>(initial === null ? [] : [[key, initial]]);
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
  };
}

test("the Home feed restores the saved scroll anchor", () => {
  const saved = storage(
    JSON.stringify({
      values: { activityScroll: { key: "research:node-7", offset: -24 } },
    }),
  );
  assert.deepEqual(readActivityFeedState(saved), {
    scroll: { key: "research:node-7", offset: -24 },
  });
});

test("saving feed scroll preserves unrelated stored values", () => {
  const saved = storage(JSON.stringify({ values: { "followup:tree:root": "Keep this" } }));
  saveActivityFeedState({ scroll: { key: "journal:entry-2", offset: 12 } }, saved);
  assert.deepEqual(readActivityFeedState(saved), {
    scroll: { key: "journal:entry-2", offset: 12 },
  });
  const values = JSON.parse(saved.getItem(key)!).values;
  assert.equal(values["followup:tree:root"], "Keep this");
});

test("malformed or unavailable storage falls back safely and can be repaired", () => {
  const malformed = [
    "broken",
    "null",
    "[]",
    '{"values":null}',
    '{"values":{"activityScroll":"far"}}',
    // A bare pixel offset is not an anchor.
    '{"values":{"activityScroll":1372}}',
    '{"values":{"activityScroll":{"key":"research:node-1"}}}',
    '{"values":{"activityScroll":{"key":"","offset":10}}}',
    '{"values":{"activityScroll":{"key":"research:node-1","offset":1e999}}}',
  ];
  for (const value of malformed) {
    const saved = storage(value);
    assert.deepEqual(readActivityFeedState(saved), { scroll: null });
    saveActivityFeedState({ scroll: { key: "research:node-3", offset: 20 } }, saved);
    assert.deepEqual(readActivityFeedState(saved), {
      scroll: { key: "research:node-3", offset: 20 },
    });
  }
  const unavailable = {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  };
  assert.deepEqual(readActivityFeedState(unavailable), { scroll: null });
  assert.doesNotThrow(() =>
    saveActivityFeedState({ scroll: { key: "research:node-4", offset: 12 } }, unavailable),
  );
});

test("clearing the anchor leaves the feed at the top on the next visit", () => {
  const saved = storage();
  saveActivityFeedState({ scroll: { key: "research:node-9", offset: 40 } }, saved);
  saveActivityFeedState({ scroll: null }, saved);
  assert.deepEqual(readActivityFeedState(saved), { scroll: null });
});
