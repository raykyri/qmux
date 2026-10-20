import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");

// Every .css file under src/styles at any depth, so a new sheet is covered
// without being registered here.
function styleFilesOutsideTokens(directory = stylesDirectory): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...styleFilesOutsideTokens(path));
    } else if (entry.name.endsWith(".css")) {
      files.push(relative(stylesDirectory, path));
    }
  }
  return files.filter((file) => file !== "tokens.css");
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

test("the style sweep finds the sheets it is meant to cover", () => {
  const files = styleFilesOutsideTokens();
  assert.ok(files.includes("primitives.css"));
  assert.ok(files.includes(join("components", "dialog.css")));
  assert.ok(files.includes(join("features", "research.css")));
});

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
