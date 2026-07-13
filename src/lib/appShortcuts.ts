export type AppShortcutCommand =
  | { type: "fontZoomIn" }
  | { type: "fontZoomOut" }
  | { type: "fontZoomReset" }
  | { type: "focusTab"; tabIndex: number }
  | { type: "focusResearchTab"; tabIndex: number }
  | { type: "homeOrCycleAdapter" }
  | { type: "openNewResearch" }
  | { type: "focusHome" }
  | { type: "focusResearchHome" }
  | { type: "focusTerminalMode" }
  | { type: "focusResearchMode" }
  | { type: "toggleSidebarMode" }
  | { type: "cyclePaneTab"; direction: -1 | 1 }
  | { type: "cycleAllTab"; direction: -1 | 1 }
  | { type: "moveSidebarItem"; direction: -1 | 1 }
  | { type: "openSettings" }
  | { type: "openCommandPalette" }
  | { type: "toggleTranscriptOrBrowser" }
  | { type: "splitPaneBelow" }
  | { type: "restoreClosedPane" }
  | { type: "closePane" }
  | { type: "newGroup" }
  | { type: "newPane" };

export interface AppShortcutInput {
  key: string;
  code?: string;
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
  // WebKit can expose the backquote key as "Dead" (or a composed character)
  // after focus moves through web content. Use the physical code for this
  // layout-independent app shortcut so it remains available on Research.
  const key = input.code === "Backquote" ? "`" : normalizedKey(input.key);
  const command = input.metaKey;
  const control = input.ctrlKey;
  const option = input.altKey;
  const shift = input.shiftKey;
  const onePrimaryModifier = command !== control;

  if (
    !command &&
    !control &&
    option &&
    !shift &&
    !input.editableTarget &&
    (key === "arrowup" || key === "arrowdown")
  ) {
    return { type: "moveSidebarItem", direction: key === "arrowup" ? -1 : 1 };
  }

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
  if (command && !control && !option && shift && key === "r") {
    return { type: "focusResearchMode" };
  }
  if (command && !control && !option && !shift && key === "`") {
    return { type: "toggleSidebarMode" };
  }
  if (!command && control && !option && key === "tab") {
    return { type: "cyclePaneTab", direction: shift ? -1 : 1 };
  }
  if (command && !control && !option && shift && (key === "[" || key === "]")) {
    return { type: "cycleAllTab", direction: key === "[" ? -1 : 1 };
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
  if (command && !control && !option && shift && key === "n") {
    return { type: "newGroup" };
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

// Commands whose meaning follows the active workspace are resolved here so
// both DOM and native-terminal shortcut paths share the same behavior.
export function contextualizeAppShortcut(
  command: AppShortcutCommand,
  sidebarMode: "terminal" | "research",
): AppShortcutCommand {
  if (sidebarMode === "research" && command.type === "homeOrCycleAdapter") {
    return { type: "focusResearchHome" };
  }
  if (sidebarMode === "research" && command.type === "newPane") {
    return { type: "openNewResearch" };
  }
  if (sidebarMode === "research" && command.type === "focusTab") {
    return { type: "focusResearchTab", tabIndex: command.tabIndex };
  }
  if (sidebarMode === "research" && command.type === "focusHome") {
    return { type: "focusResearchHome" };
  }
  if (sidebarMode === "research" && command.type === "restoreClosedPane") {
    return { type: "focusTerminalMode" };
  }
  if (sidebarMode === "research" && command.type === "cycleAllTab") {
    return { type: "cyclePaneTab", direction: command.direction };
  }
  return command;
}

export function appShortcutAllowsRepeat(command: AppShortcutCommand): boolean {
  return (
    command.type === "fontZoomIn" ||
    command.type === "fontZoomOut" ||
    command.type === "fontZoomReset" ||
    command.type === "moveSidebarItem"
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
    case "openNewResearch":
    case "focusHome":
    case "focusResearchHome":
    case "focusTerminalMode":
    case "focusResearchMode":
    case "toggleSidebarMode":
    case "openSettings":
    case "openCommandPalette":
    case "toggleTranscriptOrBrowser":
    case "splitPaneBelow":
    case "restoreClosedPane":
    case "closePane":
    case "newGroup":
    case "newPane":
      return { type: command };
    case "focusTab":
      return typeof tabIndex === "number" && Number.isInteger(tabIndex) && tabIndex >= 0
        ? { type: "focusTab", tabIndex }
        : null;
    case "focusResearchTab":
      return typeof tabIndex === "number" && Number.isInteger(tabIndex) && tabIndex >= 0
        ? { type: "focusResearchTab", tabIndex }
        : null;
    case "cyclePaneTabPrevious":
      return { type: "cyclePaneTab", direction: -1 };
    case "cyclePaneTabNext":
      return { type: "cyclePaneTab", direction: 1 };
    case "cycleAllTabPrevious":
      return { type: "cycleAllTab", direction: -1 };
    case "cycleAllTabNext":
      return { type: "cycleAllTab", direction: 1 };
    case "moveSidebarItemUp":
      return { type: "moveSidebarItem", direction: -1 };
    case "moveSidebarItemDown":
      return { type: "moveSidebarItem", direction: 1 };
    default:
      return null;
  }
}
