import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLauncherModelLabel,
  modelPresetsFor,
  nextModelPreset,
  selectedModelPreset,
} from "../src/lib/launcherModels";

test("preserves exact Codex model ids in launcher labels", () => {
  assert.equal(formatLauncherModelLabel("codex", "gpt-6-astra"), "gpt-6-astra");
  assert.equal(formatLauncherModelLabel("codex", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(formatLauncherModelLabel("codex", "custom"), "Custom");
  assert.equal(formatLauncherModelLabel("claude", "opus"), "Opus");
});

test("cycles model presets within the selected provider", () => {
  assert.equal(modelPresetsFor("codex")[0], "gpt-6-astra");
  assert.equal(selectedModelPreset("codex", null), "gpt-6-astra");
  assert.equal(nextModelPreset("codex", "gpt-6-astra"), "gpt-5.6-sol");
  assert.equal(nextModelPreset("codex", "custom"), "gpt-6-astra");
  assert.equal(selectedModelPreset("claude", null), "fable");
  assert.equal(nextModelPreset("claude", "fable"), "opus");
  assert.equal(nextModelPreset("claude", "custom"), "fable");
});
