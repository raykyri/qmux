// Guards against accidental giant pastes — a whole file, a screenful of logs —
// that would otherwise slam into the terminal's PTY or the composer in one shot.
// Anything at or below this size pastes silently; anything larger asks first.
const LARGE_PASTE_THRESHOLD_BYTES = 250 * 1024;

function formatPasteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

// Returns true if a paste of this text should be accepted. Small pastes always
// pass; an oversized one prompts (reporting its size) and returns the user's
// choice. Callers cancel the paste — preventDefault, or skip feeding xterm —
// when this returns false. Size is measured in UTF-8 bytes so multibyte text is
// counted at its real on-the-wire weight.
export function confirmLargePaste(text: string): boolean {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes <= LARGE_PASTE_THRESHOLD_BYTES) {
    return true;
  }
  return window.confirm(`This paste is ${formatPasteSize(bytes)}. Paste it anyway?`);
}
