import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "./terminalFont";

export interface FontOption {
  id: string;
  label: string;
  /** Full CSS font-family stack applied to the terminal. */
  stack: string;
}

// Shared fallback chain so a face that is missing on the host degrades to the
// platform monospace rather than a proportional font.
const MONO_FALLBACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

// The small, curated list shown in the settings dropdown. JetBrains Mono is the
// only bundled face; the rest are common system monospace fonts. Adding an entry
// here is all it takes to grow the menu.
export const FONT_OPTIONS: FontOption[] = [
  { id: "jetbrains-mono", label: "JetBrains Mono", stack: TERMINAL_FONT_FAMILY },
  { id: "sf-mono", label: "SF Mono", stack: `"SF Mono", ${MONO_FALLBACK}` },
  { id: "menlo", label: "Menlo", stack: `"Menlo", ${MONO_FALLBACK}` },
  { id: "monaco", label: "Monaco", stack: `"Monaco", ${MONO_FALLBACK}` },
];

export const DEFAULT_FONT_ID = FONT_OPTIONS[0].id;

export interface AppSettings {
  /** id into FONT_OPTIONS */
  fontId: string;
  /** terminal font size in px */
  fontSize: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontId: DEFAULT_FONT_ID,
  fontSize: TERMINAL_FONT_SIZE,
};

/** Resolves a stored font id to its CSS stack, falling back to the default. */
export function fontStackFor(fontId: string): string {
  return (FONT_OPTIONS.find((option) => option.id === fontId) ?? FONT_OPTIONS[0]).stack;
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) {
    return TERMINAL_FONT_SIZE;
  }
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)));
}

// Bumped if the stored shape ever changes incompatibly; an unknown blob simply
// falls back to defaults.
const STORAGE_KEY = "qmux.settings.v1";

/**
 * Reads the persisted application settings from localStorage. Any missing,
 * corrupt, or out-of-range field is replaced with its default, so a bad blob
 * never breaks startup — it just yields the defaults for the offending field.
 */
export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const fontId =
      typeof parsed.fontId === "string" && FONT_OPTIONS.some((option) => option.id === parsed.fontId)
        ? parsed.fontId
        : DEFAULT_FONT_ID;
    const fontSize =
      typeof parsed.fontSize === "number" ? clampFontSize(parsed.fontSize) : TERMINAL_FONT_SIZE;
    return { fontId, fontSize };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persists the application settings. Failures (e.g. storage disabled or over
 * quota) are swallowed: the settings stay live for the session, just not saved.
 */
export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable; preferences remain in-memory for this session only.
  }
}
