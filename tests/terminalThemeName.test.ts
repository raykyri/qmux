import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_THEME_ID, type Appearance, type ColorTheme } from "../src/lib/settings";
import { terminalThemeNameFor } from "../src/lib/terminalThemeName";

/**
 * The one table three surfaces must agree on: the Ghostty theme qmux runs in
 * its panes, the --terminal-pane-bg token the surrounding chrome paints, and
 * the Swift definition that paints a pane's pre-first-frame pixels. A mismatch
 * shows up as a dark rectangle flashing at every pane creation in light mode,
 * so it is asserted rather than eyeballed.
 */
const CASES: {
  themeId: string;
  colorTheme: ColorTheme;
  appearance: Appearance;
  themeName: string;
  backgroundHex: string;
  foregroundHex: string;
}[] = [
  {
    themeId: DEFAULT_THEME_ID,
    colorTheme: "green-blob",
    appearance: "dark",
    themeName: "qmux",
    backgroundHex: "#111315",
    foregroundHex: "#e7e7e2",
  },
  {
    themeId: DEFAULT_THEME_ID,
    colorTheme: "orange-blob",
    appearance: "dark",
    themeName: "qmux-warm",
    backgroundHex: "#161514",
    foregroundHex: "#e7e7e2",
  },
  {
    themeId: DEFAULT_THEME_ID,
    colorTheme: "green-blob",
    appearance: "light",
    themeName: "qmux-light",
    backgroundHex: "#f7f8f7",
    foregroundHex: "#23282a",
  },
  {
    themeId: DEFAULT_THEME_ID,
    colorTheme: "orange-blob",
    appearance: "light",
    themeName: "qmux-warm-light",
    backgroundHex: "#f8f6f3",
    foregroundHex: "#23282a",
  },
];

test("the built-in terminal theme follows the color theme and the appearance", () => {
  for (const testCase of CASES) {
    assert.equal(
      terminalThemeNameFor({
        themeId: testCase.themeId,
        colorTheme: testCase.colorTheme,
        appearance: testCase.appearance,
      }),
      testCase.themeName,
      `${testCase.colorTheme}/${testCase.appearance}`,
    );
  }
});

test("an explicitly chosen Ghostty theme keeps its authored colors everywhere", () => {
  for (const colorTheme of ["green-blob", "orange-blob"] as ColorTheme[]) {
    for (const appearance of ["dark", "light"] as Appearance[]) {
      assert.equal(
        terminalThemeNameFor({ themeId: "Cursor Dark", colorTheme, appearance }),
        "Cursor Dark",
        `${colorTheme}/${appearance}`,
      );
    }
  }
});

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");
const tokensCss = readFileSync(join(stylesDirectory, "tokens.css"), "utf8");

/**
 * Resolves --terminal-pane-bg the way the cascade does for one appearance and
 * color theme: later blocks of equal specificity win, and a more specific
 * selector beats a less specific one.
 */
function terminalPaneBackground(colorTheme: ColorTheme, appearance: Appearance): string | null {
  let resolved: string | null = null;
  let resolvedSpecificity = -1;
  const blockPattern = /((?::root[^{,]*,?\s*)+)\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  for (const block of tokensCss.matchAll(blockPattern)) {
    const declaration = block[2].match(/--terminal-pane-bg:\s*([^;]+);/);
    if (!declaration) continue;
    for (const selector of block[1].split(",")) {
      const trimmed = selector.trim();
      if (!trimmed.startsWith(":root")) continue;
      const wantsLight = trimmed.includes('data-appearance="light"');
      if (wantsLight !== (appearance === "light")) continue;
      const themeMatch = trimmed.match(/data-color-theme="([a-z-]+)"/);
      if (themeMatch && themeMatch[1] !== colorTheme) continue;
      const specificity = (wantsLight ? 1 : 0) + (themeMatch ? 1 : 0);
      if (specificity < resolvedSpecificity) continue;
      resolved = declaration[1].trim();
      resolvedSpecificity = specificity;
    }
  }
  return resolved;
}

test("--terminal-pane-bg matches the background of the theme the panes run", () => {
  for (const testCase of CASES) {
    assert.equal(
      terminalPaneBackground(testCase.colorTheme, testCase.appearance),
      testCase.backgroundHex,
      `${testCase.colorTheme}/${testCase.appearance}`,
    );
  }
});

const swiftTheme = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "src-tauri",
    "swift-terminal",
    "Sources",
    "QmuxNativeTerminal",
    "QmuxTerminalTheme.swift",
  ),
  "utf8",
);

test("QmuxTerminalTheme declares every built-in theme with the same background", () => {
  for (const testCase of CASES) {
    // The Swift side names its variants through static lets, so match the name
    // constant's value and read the background that follows it.
    const nameConstant = swiftTheme.match(
      new RegExp(`static let (\\w+) = "${testCase.themeName}"`),
    );
    assert.ok(nameConstant, `no Swift name constant for ${testCase.themeName}`);
    const definitionBody = swiftTheme.match(
      new RegExp(`name:\\s*${nameConstant[1]},\\s*\\n\\s*background:\\s*"([0-9a-f]{6})"`),
    );
    assert.ok(definitionBody, `no Swift definition for ${testCase.themeName}`);
    assert.equal(
      `#${definitionBody[1]}`,
      testCase.backgroundHex,
      `${testCase.colorTheme}/${testCase.appearance}`,
    );
  }
});

/**
 * The collapsed-pane preview paints from --terminal-pane-bg/-fg whenever the
 * running theme is one of the built-in variants, which the user-facing catalog
 * deliberately omits. Those two tokens must therefore carry the same colors the
 * Swift definitions do, per appearance.
 */
function terminalPaneForeground(appearance: Appearance): string | null {
  let resolved: string | null = null;
  const blockPattern = /((?::root[^{,]*,?\s*)+)\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  for (const block of tokensCss.matchAll(blockPattern)) {
    const declaration = block[2].match(/--terminal-pane-fg:\s*([^;]+);/);
    if (!declaration) continue;
    for (const selector of block[1].split(",")) {
      const trimmed = selector.trim();
      if (!trimmed.startsWith(":root")) continue;
      if (trimmed.includes('data-appearance="light"') !== (appearance === "light")) continue;
      resolved = declaration[1].trim();
    }
  }
  return resolved;
}

test("--terminal-pane-fg matches the foreground of the theme the panes run", () => {
  for (const testCase of CASES) {
    assert.equal(
      terminalPaneForeground(testCase.appearance),
      testCase.foregroundHex,
      `${testCase.colorTheme}/${testCase.appearance}`,
    );
    const nameConstant = swiftTheme.match(
      new RegExp(`static let (\\w+) = "${testCase.themeName}"`),
    );
    assert.ok(nameConstant, `no Swift name constant for ${testCase.themeName}`);
    const definitionBody = swiftTheme.match(
      new RegExp(
        `name:\\s*${nameConstant[1]},[\\s\\S]*?foreground:\\s*"([0-9a-f]{6})"`,
      ),
    );
    assert.ok(definitionBody, `no Swift foreground for ${testCase.themeName}`);
    assert.equal(`#${definitionBody[1]}`, testCase.foregroundHex, testCase.themeName);
  }
});

test("the collapsed pane preview falls back to the appearance terminal tokens", () => {
  const turnPaneCss = readFileSync(join(stylesDirectory, "features", "turn-pane.css"), "utf8");
  assert.match(
    turnPaneCss,
    /--terminal-pip-surface:\s*var\(--terminal-pip-bg, var\(--terminal-pane-bg\)\)/,
  );
  assert.match(
    turnPaneCss,
    /--terminal-pip-ink:\s*var\(--terminal-pip-fg, var\(--terminal-pane-fg\)\)/,
  );
});
