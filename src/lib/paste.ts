// Guards against accidental giant pastes — a whole file, a screenful of logs —
// that would otherwise slam into the terminal's PTY or the composer in one shot.
// Anything at or below the threshold pastes silently; above it asks first; above
// the hard ceiling it's refused outright, since even a confirmed multi-hundred-MB
// paste sent in one shot can freeze the UI/PTY.
const LARGE_PASTE_THRESHOLD_BYTES = 250 * 1024;
const MAX_PASTE_BYTES = 50 * 1024 * 1024;

function formatPasteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

// The decision for a paste, based on its UTF-8 byte size (so multibyte text is
// counted at its real on-the-wire weight):
//   - "accept":  small enough to insert silently.
//   - "confirm": large; show `message` and only proceed if the user confirms.
//   - "reject":  over the hard ceiling; show `message` and do not paste at all.
// Callers render the message in an in-app dialog (window.confirm is a no-op in the
// Tauri webview). The byte length is computed once here so large pastes aren't
// re-encoded at every call site.
export type PasteVerdict =
  | { action: "accept" }
  | { action: "confirm"; message: string }
  | { action: "reject"; message: string };

export function inspectPaste(text: string): PasteVerdict {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_PASTE_BYTES) {
    return {
      action: "reject",
      message: `This paste is ${formatPasteSize(bytes)}, larger than the ${formatPasteSize(
        MAX_PASTE_BYTES,
      )} limit, so it was not pasted.`,
    };
  }
  if (bytes > LARGE_PASTE_THRESHOLD_BYTES) {
    return { action: "confirm", message: `This paste is ${formatPasteSize(bytes)}. Paste it anyway?` };
  }
  return { action: "accept" };
}
