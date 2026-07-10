// Guards against accidental giant pastes — a whole file, a screenful of logs —
// that would otherwise slam into the terminal's PTY or the composer in one shot.
// The configurable threshold asks first; above the hard ceiling it's refused
// outright, since even a confirmed multi-hundred-MB paste sent in one shot can
// freeze the UI/PTY.
export const DEFAULT_CONFIRM_PASTE_OVER_CHARS = 250 * 1024;
const MAX_PASTE_BYTES = 50 * 1024 * 1024;

export interface PasteProtectionSettings {
  confirmMultiLinePaste: boolean;
  confirmPasteOverChars: number;
}

function formatPasteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

// The decision for a paste. The hard cap uses UTF-8 byte size (so multibyte text
// is counted at its real on-the-wire weight); the configurable confirmation
// threshold is expressed in user-facing characters:
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

function formatPasteCharacters(chars: number): string {
  return chars === 1 ? "1 character" : `${chars.toLocaleString()} characters`;
}

export function inspectPaste(
  text: string,
  options: Partial<PasteProtectionSettings> = {},
): PasteVerdict {
  const {
    confirmMultiLinePaste = false,
    confirmPasteOverChars = DEFAULT_CONFIRM_PASTE_OVER_CHARS,
  } = options;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_PASTE_BYTES) {
    return {
      action: "reject",
      message: `This paste is ${formatPasteSize(bytes)}, larger than the ${formatPasteSize(
        MAX_PASTE_BYTES,
      )} limit, so it was not pasted.`,
    };
  }
  const chars = Array.from(text).length;
  if (chars > confirmPasteOverChars) {
    return {
      action: "confirm",
      message: `This paste is ${formatPasteCharacters(chars)}. Paste it anyway?`,
    };
  }
  if (confirmMultiLinePaste && /[\r\n]/.test(text)) {
    return {
      action: "confirm",
      message: "This paste contains multiple lines. Paste it anyway?",
    };
  }
  return { action: "accept" };
}
