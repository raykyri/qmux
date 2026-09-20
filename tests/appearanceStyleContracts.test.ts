import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");

// Sheets still carrying raw literals while the appearance sweep lands one
// surface group at a time. This set must be empty once the sweep is complete.
const PENDING_SWEEP = new Set([
  join("features", "shell.css"),
  join("features", "terminal.css"),
  join("features", "browser.css"),
  join("features", "composer.css"),
  join("features", "history.css"),
  join("features", "notifications.css"),
  join("features", "agent-debug-panel.css"),
  join("features", "artifact-tray.css"),
]);

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
  return files.filter((file) => !PENDING_SWEEP.has(file));
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
