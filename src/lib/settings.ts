import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "./terminalFont";
import {
  DEFAULT_CONFIRM_PASTE_OVER_CHARS,
  type PasteProtectionSettings,
} from "./paste";

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

export type CursorStyle = "block" | "underline" | "bar";
export type CursorInactiveStyle = "outline" | "block" | "bar" | "underline" | "none";
export type MouseWheelSensitivity = "low" | "normal" | "high";

export const CURSOR_STYLE_OPTIONS: { id: CursorStyle; label: string }[] = [
  { id: "block", label: "Block" },
  { id: "bar", label: "Bar" },
  { id: "underline", label: "Underline" },
];

export const CURSOR_INACTIVE_STYLE_OPTIONS: { id: CursorInactiveStyle; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "block", label: "Block" },
  { id: "bar", label: "Bar" },
  { id: "underline", label: "Underline" },
  { id: "none", label: "Hidden" },
];

export const MOUSE_WHEEL_SENSITIVITY_OPTIONS: {
  id: MouseWheelSensitivity;
  label: string;
  value: number;
}[] = [
  { id: "low", label: "Low", value: 0.65 },
  { id: "normal", label: "Standard", value: 1 },
  { id: "high", label: "High", value: 1.75 },
];

export const DEFAULT_SCROLLBACK_ROWS = 10000;
export const SCROLLBACK_ROWS_MIN = 1000;
export const SCROLLBACK_ROWS_MAX = 200000;
export const DEFAULT_SCROLL_DURATION_MS = 0;
export const SCROLL_DURATION_MS_MIN = 0;
export const SCROLL_DURATION_MS_MAX = 500;
export const SCROLL_DURATION_MS_STEP = 25;
export const DEFAULT_LINE_HEIGHT = 1;
export const LINE_HEIGHT_MIN = 0.7;
export const LINE_HEIGHT_MAX = 1.3;
export const LINE_HEIGHT_STEP = 0.1;
export const CONFIRM_PASTE_OVER_CHARS_MIN = 1;
export const CONFIRM_PASTE_OVER_CHARS_MAX = 5_000_000;

export interface AppSettings {
  /** id into FONT_OPTIONS */
  fontId: string;
  /** terminal font size in px */
  fontSize: number;
  /** whether the focused terminal cursor blinks */
  cursorBlink: boolean;
  /** focused terminal cursor shape */
  cursorStyle: CursorStyle;
  /** unfocused terminal cursor shape */
  cursorInactiveStyle: CursorInactiveStyle;
  /** terminal scrollback rows retained by xterm */
  scrollbackRows: number;
  /** scroll to bottom when the user types into the terminal */
  scrollOnUserInput: boolean;
  /** mouse wheel scrolling speed preset */
  mouseWheelSensitivity: MouseWheelSensitivity;
  /** smooth scroll duration in milliseconds */
  scrollDurationMs: number;
  /** terminal line-height multiplier */
  lineHeight: number;
  /** copy terminal selections as soon as text is selected */
  copyOnSelect: boolean;
  /** clear terminal selection after a copy action */
  selectionClearOnCopy: boolean;
  /** confirm pasted text containing more than one line */
  confirmMultiLinePaste: boolean;
  /** confirm pasted text above this many characters */
  confirmPasteOverChars: number;
  /** skip paste confirmation when bracketed paste mode is active */
  bracketedPasteSafe: boolean;
  /** show Cmd-held shortcut badges in the sidebar */
  showShortcutHints: boolean;
  /** disable decorative/status pulse animations */
  reduceMotion: boolean;
  /** OpenRouter API key */
  openRouterKey: string;
  /** OpenRouter model id */
  openRouterModel: string;
  /**
   * Opt in to generating tab titles by summarizing each pane's first user message
   * through OpenRouter. Off by default because it sends message text to a third-party
   * cloud service; titling stays local until this is explicitly enabled.
   */
  openRouterTitlesEnabled: boolean;
  /** keep the machine awake while any agent is running */
  preventSleep: boolean;
  /**
   * Run shells as login shells, sourcing the user's login profile files
   * (~/.zprofile + ~/.zlogin, or ~/.bash_profile/~/.profile) in addition to the
   * interactive rc. On by default so spawned shells match how terminal emulators
   * launch them. The backend persists its own copy (read on the spawn path,
   * including startup recovery); this mirror keeps the dialog in sync.
   */
  useLoginShell: boolean;
  /**
   * Show code-oriented context in tabs and the launcher: per-tab paths, git
   * worktree metadata, and the "New worktree" launcher option. When off, tabs
   * collapse to a single aligned row (status dot · title · status).
   */
  codeMode: boolean;
  /** show per-tab working directories when code mode is enabled */
  showTabDirectories: boolean;
  /** show tool calls and other activity detail in agent transcripts */
  showToolCalls: boolean;
  /** require Command+Enter instead of bare Enter for composer submit shortcuts */
  requireCmdEnterToSend: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontId: DEFAULT_FONT_ID,
  fontSize: TERMINAL_FONT_SIZE,
  cursorBlink: false,
  cursorStyle: "block",
  cursorInactiveStyle: "outline",
  scrollbackRows: DEFAULT_SCROLLBACK_ROWS,
  scrollOnUserInput: true,
  mouseWheelSensitivity: "normal",
  scrollDurationMs: DEFAULT_SCROLL_DURATION_MS,
  lineHeight: DEFAULT_LINE_HEIGHT,
  copyOnSelect: false,
  selectionClearOnCopy: false,
  confirmMultiLinePaste: false,
  confirmPasteOverChars: DEFAULT_CONFIRM_PASTE_OVER_CHARS,
  bracketedPasteSafe: false,
  showShortcutHints: true,
  reduceMotion: false,
  openRouterKey: "",
  openRouterModel: "",
  openRouterTitlesEnabled: false,
  preventSleep: true,
  useLoginShell: true,
  codeMode: true,
  showTabDirectories: true,
  showToolCalls: true,
  requireCmdEnterToSend: true,
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

export function clampScrollbackRows(rows: number): number {
  if (!Number.isFinite(rows)) {
    return DEFAULT_SCROLLBACK_ROWS;
  }
  return Math.min(SCROLLBACK_ROWS_MAX, Math.max(SCROLLBACK_ROWS_MIN, Math.round(rows)));
}

export function clampScrollDurationMs(duration: number): number {
  if (!Number.isFinite(duration)) {
    return DEFAULT_SCROLL_DURATION_MS;
  }
  return Math.min(
    SCROLL_DURATION_MS_MAX,
    Math.max(SCROLL_DURATION_MS_MIN, Math.round(duration / SCROLL_DURATION_MS_STEP) * SCROLL_DURATION_MS_STEP),
  );
}

export function clampLineHeight(lineHeight: number): number {
  if (!Number.isFinite(lineHeight)) {
    return DEFAULT_LINE_HEIGHT;
  }
  const clamped = Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, lineHeight));
  return Math.round(clamped * 10) / 10;
}

export function clampConfirmPasteOverChars(chars: number): number {
  if (!Number.isFinite(chars)) {
    return DEFAULT_CONFIRM_PASTE_OVER_CHARS;
  }
  return Math.min(
    CONFIRM_PASTE_OVER_CHARS_MAX,
    Math.max(CONFIRM_PASTE_OVER_CHARS_MIN, Math.round(chars)),
  );
}

export function scrollSensitivityFor(setting: MouseWheelSensitivity): number {
  return (
    MOUSE_WHEEL_SENSITIVITY_OPTIONS.find((option) => option.id === setting) ??
    MOUSE_WHEEL_SENSITIVITY_OPTIONS[1]
  ).value;
}

export function pasteProtectionFor(settings: AppSettings): PasteProtectionSettings {
  return {
    confirmMultiLinePaste: settings.confirmMultiLinePaste,
    confirmPasteOverChars: settings.confirmPasteOverChars,
    bracketedPasteSafe: settings.bracketedPasteSafe,
  };
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
    const cursorBlink =
      typeof parsed.cursorBlink === "boolean"
        ? parsed.cursorBlink
        : DEFAULT_SETTINGS.cursorBlink;
    const cursorStyle =
      typeof parsed.cursorStyle === "string" &&
      CURSOR_STYLE_OPTIONS.some((option) => option.id === parsed.cursorStyle)
        ? parsed.cursorStyle
        : DEFAULT_SETTINGS.cursorStyle;
    const cursorInactiveStyle =
      typeof parsed.cursorInactiveStyle === "string" &&
      CURSOR_INACTIVE_STYLE_OPTIONS.some((option) => option.id === parsed.cursorInactiveStyle)
        ? parsed.cursorInactiveStyle
        : DEFAULT_SETTINGS.cursorInactiveStyle;
    const scrollbackRows =
      typeof parsed.scrollbackRows === "number"
        ? clampScrollbackRows(parsed.scrollbackRows)
        : DEFAULT_SETTINGS.scrollbackRows;
    const scrollOnUserInput =
      typeof parsed.scrollOnUserInput === "boolean"
        ? parsed.scrollOnUserInput
        : DEFAULT_SETTINGS.scrollOnUserInput;
    const mouseWheelSensitivity =
      typeof parsed.mouseWheelSensitivity === "string" &&
      MOUSE_WHEEL_SENSITIVITY_OPTIONS.some((option) => option.id === parsed.mouseWheelSensitivity)
        ? parsed.mouseWheelSensitivity
        : DEFAULT_SETTINGS.mouseWheelSensitivity;
    const scrollDurationMs =
      typeof parsed.scrollDurationMs === "number"
        ? clampScrollDurationMs(parsed.scrollDurationMs)
        : DEFAULT_SETTINGS.scrollDurationMs;
    const lineHeight =
      typeof parsed.lineHeight === "number"
        ? clampLineHeight(parsed.lineHeight)
        : DEFAULT_SETTINGS.lineHeight;
    const copyOnSelect =
      typeof parsed.copyOnSelect === "boolean"
        ? parsed.copyOnSelect
        : DEFAULT_SETTINGS.copyOnSelect;
    const selectionClearOnCopy =
      typeof parsed.selectionClearOnCopy === "boolean"
        ? parsed.selectionClearOnCopy
        : DEFAULT_SETTINGS.selectionClearOnCopy;
    const confirmMultiLinePaste =
      typeof parsed.confirmMultiLinePaste === "boolean"
        ? parsed.confirmMultiLinePaste
        : DEFAULT_SETTINGS.confirmMultiLinePaste;
    const confirmPasteOverChars =
      typeof parsed.confirmPasteOverChars === "number"
        ? clampConfirmPasteOverChars(parsed.confirmPasteOverChars)
        : DEFAULT_SETTINGS.confirmPasteOverChars;
    const bracketedPasteSafe =
      typeof parsed.bracketedPasteSafe === "boolean"
        ? parsed.bracketedPasteSafe
        : DEFAULT_SETTINGS.bracketedPasteSafe;
    const preventSleep =
      typeof parsed.preventSleep === "boolean"
        ? parsed.preventSleep
        : DEFAULT_SETTINGS.preventSleep;
    const useLoginShell =
      typeof parsed.useLoginShell === "boolean"
        ? parsed.useLoginShell
        : DEFAULT_SETTINGS.useLoginShell;
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
    const showTabDirectories =
      typeof parsed.showTabDirectories === "boolean" ? parsed.showTabDirectories : codeMode;
    const showToolCalls =
      typeof parsed.showToolCalls === "boolean" ? parsed.showToolCalls : codeMode;
    const requireCmdEnterToSend =
      typeof parsed.requireCmdEnterToSend === "boolean"
        ? parsed.requireCmdEnterToSend
        : codeMode;
    const openRouterKey =
      typeof parsed.openRouterKey === "string"
        ? parsed.openRouterKey
        : DEFAULT_SETTINGS.openRouterKey;
    const openRouterModel =
      typeof parsed.openRouterModel === "string"
        ? parsed.openRouterModel
        : DEFAULT_SETTINGS.openRouterModel;
    const openRouterTitlesEnabled =
      typeof parsed.openRouterTitlesEnabled === "boolean"
        ? parsed.openRouterTitlesEnabled
        : DEFAULT_SETTINGS.openRouterTitlesEnabled;
    return {
      fontId,
      fontSize,
      cursorBlink,
      cursorStyle,
      cursorInactiveStyle,
      scrollbackRows,
      scrollOnUserInput,
      mouseWheelSensitivity,
      scrollDurationMs,
      lineHeight,
      copyOnSelect,
      selectionClearOnCopy,
      confirmMultiLinePaste,
      confirmPasteOverChars,
      bracketedPasteSafe,
      showShortcutHints,
      reduceMotion,
      openRouterKey,
      openRouterModel,
      openRouterTitlesEnabled,
      preventSleep,
      useLoginShell,
      codeMode,
      showTabDirectories,
      showToolCalls,
      requireCmdEnterToSend,
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
