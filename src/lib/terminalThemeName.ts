import { DEFAULT_THEME_ID, type Appearance, type ColorTheme } from "./settings";

/** Warm variant of the built-in qmux palette, for the Warm blob color theme. */
export const WARM_QMUX_TERMINAL_THEME_ID = "qmux-warm";
/** Light variant of the built-in qmux palette. */
export const LIGHT_QMUX_TERMINAL_THEME_ID = "qmux-light";
/** Warm light variant of the built-in qmux palette. */
export const WARM_LIGHT_QMUX_TERMINAL_THEME_ID = "qmux-warm-light";

/**
 * Picks the Ghostty theme name the panes should run.
 *
 * The application color theme and the light/dark appearance only adjust qmux's
 * own built-in terminal palette: an explicitly selected Ghostty theme keeps its
 * authored background in every appearance, which is why the 2x2 map below
 * applies only while the default theme is selected.
 *
 * The backgrounds of the four built-in variants must stay in step with
 * `--terminal-pane-bg` in src/styles/tokens.css and with QmuxTerminalTheme on
 * the Swift side; tests/terminalThemeName.test.ts holds that table.
 */
export function terminalThemeNameFor({
  themeId,
  colorTheme,
  appearance,
}: {
  themeId: string;
  colorTheme: ColorTheme;
  appearance: Appearance;
}): string {
  if (themeId !== DEFAULT_THEME_ID) return themeId;
  if (appearance === "light") {
    return colorTheme === "orange-blob"
      ? WARM_LIGHT_QMUX_TERMINAL_THEME_ID
      : LIGHT_QMUX_TERMINAL_THEME_ID;
  }
  return colorTheme === "orange-blob" ? WARM_QMUX_TERMINAL_THEME_ID : DEFAULT_THEME_ID;
}
