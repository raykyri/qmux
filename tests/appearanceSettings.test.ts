import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/lib/settings";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
};
const key = "qmux.settings.v1";

test("appearance persists and unknown values fall back to dark", () => {
  store.set(key, JSON.stringify({ appearance: "light" }));
  assert.equal(loadSettings().appearance, "light");
  store.set(key, JSON.stringify({ appearance: "sepia" }));
  assert.equal(loadSettings().appearance, "dark");
  store.set(key, JSON.stringify({ appearance: 3 }));
  assert.equal(loadSettings().appearance, "dark");
  const settings = loadSettings();
  saveSettings({ ...settings, appearance: "light" });
  assert.equal(JSON.parse(store.get(key)!).appearance, "light");
  assert.equal(loadSettings().appearance, "light");
});

test("settings stored before the appearance field keep every other preference", () => {
  // The appearance field is additive on the existing qmux.settings.v1 blob, so a
  // blob written by an older build must load unchanged apart from the new default.
  store.set(
    key,
    JSON.stringify({
      colorTheme: "orange-blob",
      bodyFontId: "system",
      themeId: "Dracula",
      fontSize: 18,
      preventSleep: false,
      researchLaunchInstruction: "Check primary sources",
    }),
  );
  const settings = loadSettings();
  assert.equal(settings.appearance, DEFAULT_SETTINGS.appearance);
  assert.equal(settings.appearance, "dark");
  assert.equal(settings.colorTheme, "orange-blob");
  assert.equal(settings.bodyFontId, "system");
  assert.equal(settings.themeId, "Dracula");
  assert.equal(settings.fontSize, 18);
  assert.equal(settings.preventSleep, false);
  assert.equal(settings.researchLaunchInstruction, "Check primary sources");
  saveSettings(settings);
  assert.equal(loadSettings().fontSize, 18);
  assert.equal(loadSettings().colorTheme, "orange-blob");
});
