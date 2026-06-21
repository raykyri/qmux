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

// Returns a confirmation prompt for an oversized paste, or null when the paste is
// small enough to accept silently. Callers show the message in an in-app dialog and
// only proceed if the user confirms. (window.confirm can't be used: it is a no-op
// in the Tauri webview, which previously made large pastes silently fail.) Size is
// measured in UTF-8 bytes so multibyte text is counted at its real on-the-wire weight.
export function largePastePrompt(text: string): string | null {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes <= LARGE_PASTE_THRESHOLD_BYTES) {
    return null;
  }
  return `This paste is ${formatPasteSize(bytes)}. Paste it anyway?`;
}
