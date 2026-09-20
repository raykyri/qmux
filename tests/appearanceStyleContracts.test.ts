import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");

function styleFilesOutsideTokens(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(stylesDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of readdirSync(join(stylesDirectory, entry.name))) {
        if (nested.endsWith(".css")) files.push(join(entry.name, nested));
      }
    } else if (entry.name.endsWith(".css") && entry.name !== "tokens.css") {
      files.push(entry.name);
    }
  }
  return files;
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;

test("feature stylesheets take every color from tokens so light mode covers them", () => {
  const offenders: string[] = [];
  for (const file of styleFilesOutsideTokens()) {
    const lines = readFileSync(join(stylesDirectory, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      // Two escape hatches: colors that must not change with the appearance
      // (image scrims, paper canvases, the native terminal's own chrome) and
      // ::highlight() pseudos, where custom properties resolve unreliably so
      // each appearance spells its own literal.
      if (
        COLOR_LITERAL.test(line) &&
        !line.includes("appearance-invariant") &&
        !line.includes("highlight-pseudo-literal")
      ) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "raw color literals outside tokens.css");
});

const tokensCss = readFileSync(join(stylesDirectory, "tokens.css"), "utf8");

function tokensDeclaredIn(selectorFilter: (selector: string) => boolean): Set<string> {
  const declared = new Set<string>();
  const blockPattern = /(:root[^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  for (const match of tokensCss.matchAll(blockPattern)) {
    if (!selectorFilter(match[1])) continue;
    for (const token of match[2].matchAll(/(--[a-z0-9-]+):/g)) {
      declared.add(token[1]);
    }
  }
  return declared;
}

test("every dark color token has a light-appearance override", () => {
  const dark = tokensDeclaredIn((selector) => !selector.includes("data-appearance"));
  const light = tokensDeclaredIn((selector) => selector.includes('data-appearance="light"'));
  // Layout, type, motion, and stacking tokens are appearance-independent, as are
  // the lightbox scrims that sit over images.
  const appearanceIndependent =
    /^--(fs|control-h|radius|z|font|transition|research-feed|lightbox)-|^--control-fg$/;
  const missing = [...dark].filter(
    (token) => !light.has(token) && !appearanceIndependent.test(token),
  );
  assert.deepEqual(missing, [], "dark tokens without a light override");
});

test("light appearance blocks follow the dark theme blocks and flip color-scheme", () => {
  const firstLight = tokensCss.indexOf(':root[data-appearance="light"]');
  const lastDarkTheme = tokensCss.lastIndexOf(':root[data-color-theme="orange-blob"] {');
  assert.ok(firstLight > lastDarkTheme, "light overrides must win the cascade over dark themes");
  assert.match(tokensCss, /:root\s*\{[^}]*color-scheme:\s*dark/s);
  assert.match(tokensCss, /:root\[data-appearance="light"\]\s*\{[^}]*color-scheme:\s*light/s);
  assert.ok(
    tokensCss.includes(':root[data-appearance="light"][data-color-theme="orange-blob"]'),
    "each color theme needs its own light variant",
  );
});
