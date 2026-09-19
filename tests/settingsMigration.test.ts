import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
};

import { DEFAULT_SETTINGS, loadSettings } from "../src/lib/settings";

const STORAGE_KEY = "qmux.settings.v1";

test("an unrecognized stored title provider does not revive the legacy OpenRouter opt-in", () => {
  store.clear();
  // A corrupt or future provider id is a real selection, so the retired
  // openRouterTitlesEnabled flag must not decide for it.
  store.set(
    STORAGE_KEY,
    JSON.stringify({ tabTitleProvider: "bogus", openRouterTitlesEnabled: true }),
  );
  assert.equal(loadSettings().tabTitleProvider, DEFAULT_SETTINGS.tabTitleProvider);
  assert.equal(DEFAULT_SETTINGS.tabTitleProvider, "appleFoundationModels");
});

test("the legacy OpenRouter opt-in still migrates when no provider was ever saved", () => {
  store.clear();
  store.set(STORAGE_KEY, JSON.stringify({ openRouterTitlesEnabled: true }));
  assert.equal(loadSettings().tabTitleProvider, "openRouter");
});
