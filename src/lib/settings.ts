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
  /**
   * Extra inter-character spacing in px passed to xterm's `letterSpacing`.
   * Defaults to 0 when omitted. Monaco's glyphs sit a touch tight in xterm, so
   * a hairline 0.01px nudge keeps the cells from looking cramped.
   */
  letterSpacing?: number;
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
  { id: "monaco", label: "Monaco", stack: `"Monaco", ${MONO_FALLBACK}`, letterSpacing: 0.01 },
];

export const DEFAULT_FONT_ID = FONT_OPTIONS[0].id;

export interface AppSettings {
  /** id into FONT_OPTIONS */
  fontId: string;
  /** terminal font size in px */
  fontSize: number;
  /** show Cmd-held shortcut badges in the sidebar */
  showShortcutHints: boolean;
  /** disable decorative/status pulse animations */
  reduceMotion: boolean;
  /** OpenRouter API key */
  openRouterKey: string;
  /** OpenRouter model id */
  openRouterModel: string;
  /** keep the machine awake while any agent is running */
  preventSleep: boolean;
  /**
   * Show code-oriented context in tabs and the launcher: per-tab paths, git
   * worktree metadata, and the "New worktree" launcher option. When off, tabs
   * collapse to a single aligned row (status dot · title · status).
   */
  codeMode: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontId: DEFAULT_FONT_ID,
  fontSize: TERMINAL_FONT_SIZE,
  showShortcutHints: true,
  reduceMotion: false,
  openRouterKey: "",
  openRouterModel: "",
  preventSleep: true,
  codeMode: true,
};

/** Resolves a stored font id to its CSS stack, falling back to the default. */
export function fontStackFor(fontId: string): string {
  return (FONT_OPTIONS.find((option) => option.id === fontId) ?? FONT_OPTIONS[0]).stack;
}

/**
 * Resolves a stored font id to its terminal letter spacing (px), falling back
 * to the default. Fonts without an explicit value spell out 0 (no extra gap).
 */
export function letterSpacingFor(fontId: string): number {
  return (FONT_OPTIONS.find((option) => option.id === fontId) ?? FONT_OPTIONS[0]).letterSpacing ?? 0;
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
    const preventSleep =
      typeof parsed.preventSleep === "boolean"
        ? parsed.preventSleep
        : DEFAULT_SETTINGS.preventSleep;
    const showShortcutHints =
      typeof parsed.showShortcutHints === "boolean"
        ? parsed.showShortcutHints
        : DEFAULT_SETTINGS.showShortcutHints;
    const reduceMotion =
      typeof parsed.reduceMotion === "boolean"
        ? parsed.reduceMotion
        : DEFAULT_SETTINGS.reduceMotion;
    const codeMode =
      typeof parsed.codeMode === "boolean" ? parsed.codeMode : DEFAULT_SETTINGS.codeMode;
    const openRouterKey =
      typeof parsed.openRouterKey === "string"
        ? parsed.openRouterKey
        : DEFAULT_SETTINGS.openRouterKey;
    const openRouterModel =
      typeof parsed.openRouterModel === "string"
        ? parsed.openRouterModel
        : DEFAULT_SETTINGS.openRouterModel;
    return {
      fontId,
      fontSize,
      showShortcutHints,
      reduceMotion,
      openRouterKey,
      openRouterModel,
      preventSleep,
      codeMode,
    };
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
