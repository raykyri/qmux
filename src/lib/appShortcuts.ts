export type AppShortcutCommand =
  | { type: "fontZoomIn" }
  | { type: "fontZoomOut" }
  | { type: "fontZoomReset" }
  | { type: "focusTab"; tabIndex: number }
  | { type: "homeOrCycleAdapter" }
  | { type: "focusHome" }
  | { type: "cyclePaneTab"; direction: -1 | 1 }
  | { type: "cycleAllTab"; direction: -1 | 1 }
  | { type: "launcherOrCycleAdapter" }
  | { type: "openSettings" }
  | { type: "openCommandPalette" }
  | { type: "toggleTranscriptOrBrowser" }
  | { type: "splitPaneBelow" }
  | { type: "restoreClosedPane" }
  | { type: "closePane" }
  | { type: "newPane" };

export interface AppShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  terminalTarget?: boolean;
  editableTarget?: boolean;
}

function normalizedKey(key: string): string {
  switch (key.toLowerCase()) {
    case "{":
      return "[";
    case "}":
      return "]";
    default:
      return key.toLowerCase();
  }
}

export function resolveAppShortcut(input: AppShortcutInput): AppShortcutCommand | null {
  const key = normalizedKey(input.key);
  const command = input.metaKey;
  const control = input.ctrlKey;
  const option = input.altKey;
  const shift = input.shiftKey;
  const onePrimaryModifier = command !== control;

  if (command && !control && !option) {
    if (key === "+" || key === "=") {
      return { type: "fontZoomIn" };
    }
    if (key === "-" && !shift) {
      return { type: "fontZoomOut" };
    }
    if (key === "0" && !shift) {
      return { type: "fontZoomReset" };
    }
  }

  if (onePrimaryModifier && !option && !shift && /^[1-9]$/.test(key)) {
    return { type: "focusTab", tabIndex: Number(key) - 1 };
  }

  if (command && !control && !option && !shift && key === "n") {
    return { type: "homeOrCycleAdapter" };
  }
  if (command && !control && !option && shift && key === "h") {
    return { type: "focusHome" };
  }
  if (!command && control && !option && key === "tab") {
    return { type: "cyclePaneTab", direction: shift ? -1 : 1 };
  }
  if (command && !control && !option && shift && (key === "[" || key === "]")) {
    return { type: "cycleAllTab", direction: key === "[" ? -1 : 1 };
  }
  if (onePrimaryModifier && !option && !shift && key === ";") {
    return { type: "launcherOrCycleAdapter" };
  }
  if (onePrimaryModifier && !option && !shift && key === ",") {
    return { type: "openSettings" };
  }
  // Only for web targets: with a terminal focused, ⌘K stays native (clear
  // screen), so the native classifier deliberately doesn't claim it either.
  if (command && !control && !option && !shift && key === "k" && !input.terminalTarget) {
    return { type: "openCommandPalette" };
  }
  if (onePrimaryModifier && !option && shift && key === "e") {
    return { type: "toggleTranscriptOrBrowser" };
  }
  if (command && !control && !option && key === "d") {
    return { type: "splitPaneBelow" };
  }
  if (command && !control && !option && shift && key === "t") {
    return { type: "restoreClosedPane" };
  }
  if (
    key === "w" &&
    !option &&
    !shift &&
    ((command && !control) ||
      (!command && control && !input.terminalTarget && !input.editableTarget))
  ) {
    return { type: "closePane" };
  }
  if (command && !control && !option && !shift && key === "t") {
    return { type: "newPane" };
  }

  return null;
}

export function appShortcutAllowsRepeat(command: AppShortcutCommand): boolean {
  return (
    command.type === "fontZoomIn" ||
    command.type === "fontZoomOut" ||
    command.type === "fontZoomReset"
  );
}

export function parseAppShortcutCommand(
  command: unknown,
  tabIndex: unknown,
): AppShortcutCommand | null {
  switch (command) {
    case "fontZoomIn":
    case "fontZoomOut":
    case "fontZoomReset":
    case "homeOrCycleAdapter":
    case "focusHome":
    case "launcherOrCycleAdapter":
    case "openSettings":
    case "toggleTranscriptOrBrowser":
    case "splitPaneBelow":
    case "restoreClosedPane":
    case "closePane":
    case "newPane":
      return { type: command };
    case "focusTab":
      return typeof tabIndex === "number" && Number.isInteger(tabIndex) && tabIndex >= 0
        ? { type: "focusTab", tabIndex }
        : null;
    case "cyclePaneTabPrevious":
      return { type: "cyclePaneTab", direction: -1 };
    case "cyclePaneTabNext":
      return { type: "cyclePaneTab", direction: 1 };
    case "cycleAllTabPrevious":
      return { type: "cycleAllTab", direction: -1 };
    case "cycleAllTabNext":
      return { type: "cycleAllTab", direction: 1 };
    default:
      return null;
  }
}
