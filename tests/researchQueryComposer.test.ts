import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAdapterMetadata } from "../src/types";

// Registered before the composer is pulled in, since it reaches adapter icons.
register("./svgStubLoader.mjs", import.meta.url);
const { default: ResearchQueryComposer, researchEffortOptionsFor } = await import(
  "../src/components/research/ResearchQueryComposer"
);

function adapter(id: string): AgentAdapterMetadata {
  return {
    id,
    label: id === "claude" ? "Claude Code" : id,
    default: id === "claude",
    supportsFork: true,
    supportsResearch: true,
    supportsRecapGeneration: true,
    supportsForkAtMessage: true,
    supportsRemote: false,
    configuredBinary: id,
    resolvedBinary: `/bin/${id}`,
    readiness: "ready",
    researchReadiness: "ready",
    message: null,
    version: null,
    auth: "authenticated",
    checkedAt: 1_700_000_000_000,
    loginCommand: null,
    installCommand: null,
    installUrl: null,
    updateCommand: null,
    instanceId: `local:${id}`,
    target: { kind: "local", id: null, label: "This Mac" },
  };
}

function renderComposer() {
  return renderToStaticMarkup(
    createElement(ResearchQueryComposer, {
      adapters: [adapter("claude")],
      requireCmdEnterToSend: false,
      workspaceId: "workspace",
      onOpenAgentSettings: () => {},
      onCreate: async () => {},
    }),
  );
}

test("the composer is a page form, not a dialog", () => {
  const html = renderComposer();

  assert.match(html, /<form[^>]*class="command-launcher new-research-launcher"/);
  assert.match(html, /aria-label="New research"/);
  // A modal would carry these; the composer is the first row of the Home feed.
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal/);
});

test("the composer offers the prompt, model and agent controls", () => {
  const html = renderComposer();

  assert.match(html, /placeholder="What would you like to investigate\?"/);
  assert.match(html, /new-research-model-controls/);
  assert.match(html, /command-launcher-adapter-select/);
  assert.match(html, /aria-label="Start research"/);
});

test("Claude reasoning options omit the word effort", () => {
  const options = researchEffortOptionsFor("claude", "fable");
  assert.deepEqual(
    options?.map((option) => option.label),
    ["Default", "Low", "Medium", "High", "Extra", "Max", "Ultracode"],
  );
});

test("gpt-5.4 caps its reasoning options at extra high", () => {
  const options = researchEffortOptionsFor("codex", "gpt-5.4");
  assert.deepEqual(
    options?.map((option) => option.value),
    ["", "low", "medium", "high", "xhigh"],
  );
  const other = researchEffortOptionsFor("codex", "gpt-5.4-codex");
  assert.ok((other?.length ?? 0) > (options?.length ?? 0));
});

test("adapters without a reasoning-effort option get none", () => {
  assert.equal(researchEffortOptionsFor("grok", "grok-5"), null);
});
