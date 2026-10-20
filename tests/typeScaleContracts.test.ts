import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");
const readSheet = (path: string) => readFileSync(join(stylesDirectory, path), "utf8");
const tokensCss = readSheet("tokens.css");
const transcriptCss = readSheet(join("features", "transcript.css"));
const turnPaneCss = readSheet(join("features", "turn-pane.css"));
const researchCss = readSheet(join("features", "research.css"));
const composerCss = readSheet(join("features", "composer.css"));

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("DM Sans adds one optical half-pixel to UI type but not monospace text", () => {
  const root = ruleBody(tokensCss, ":root");
  for (const token of ["xs", "sm", "base", "input"]) {
    assert.match(
      root,
      new RegExp(`--fs-${token}:\\s*calc\\([^;]+var\\(--font-ui-size-offset\\)\\)`),
    );
  }
  assert.match(root, /--font-ui-size-offset:\s*0px/);
  assert.match(
    ruleBody(tokensCss, ':root[data-body-font="dm-sans"]'),
    /--font-ui-size-offset:\s*0\.5px/,
  );

  const turnPane = ruleBody(turnPaneCss, ".turn-pane");
  assert.match(turnPane, /--fs-base:[^;]+var\(--font-ui-size-offset\)/s);

  const researchScale = ruleBody(researchCss, ".research-workspace");
  assert.match(researchScale, /--research-meta-font-size:[^;]+\+ var\(--font-ui-size-offset\)/s);

  const heading = ruleBody(transcriptCss, ".turn-markdown h1");
  assert.match(heading, /font-size:[^;]+\+ var\(--font-ui-size-offset\)/);
  const code = ruleBody(transcriptCss, ".turn-markdown code");
  assert.doesNotMatch(code, /font-ui-size-offset/);

  // Monospace text sized off the shared scale takes the offset back out.
  const slashToken = ruleBody(composerCss, ".composer-slash-token");
  assert.match(slashToken, /font-size:[^;]+- var\(--font-ui-size-offset\)/);
});
