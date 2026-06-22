export const TERMINAL_FONT_SIZE = 14;
// Bounds for the in-session Cmd-=/Cmd-- zoom. The size is not persisted, so each
// launch starts back at TERMINAL_FONT_SIZE.
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const TERMINAL_FONT_FACE = `"JetBrains Mono"`;

export function isTerminalFontLoaded() {
  return !document.fonts || document.fonts.check(`${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FACE}`);
}

export async function loadTerminalFont() {
  if (!document.fonts) {
    return;
  }

  await Promise.all([
    document.fonts.load(`${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FACE}`),
    document.fonts.load(`700 ${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FACE}`),
    document.fonts.load(`italic ${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FACE}`),
    document.fonts.load(`italic 700 ${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FACE}`),
  ]);
}
