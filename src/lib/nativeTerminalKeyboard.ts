export interface NativeTerminalKeyboardOwnerInputs {
  activePaneId: string | null;
  paneSurfaceActive: boolean;
  activePaneVisible: boolean;
  activePaneReadOnly: boolean;
  inputBlocked: boolean;
  webEditableFocused: boolean;
  webSelectionActive: boolean;
}

export type WindowFocusKeyboardOwner =
  | "current-web-editable"
  | "remembered-web-editable"
  | "native-terminal";

/** Distinguishes a real app reactivation from WebKit first-responder churn.
 * A remembered editor is restored only when the whole app is returning; on an
 * internal webview focus event the active terminal still reclaims ownership. */
export function windowFocusKeyboardOwner({
  currentWebEditable,
  rememberedWebEditable,
  returningToApp,
}: {
  currentWebEditable: boolean;
  rememberedWebEditable: boolean;
  returningToApp: boolean;
}): WindowFocusKeyboardOwner {
  if (currentWebEditable) {
    return "current-web-editable";
  }
  if (returningToApp && rememberedWebEditable) {
    return "remembered-web-editable";
  }
  return "native-terminal";
}

/**
 * Computes the one pane that should logically own native terminal keyboard
 * input. Geometry and transcript membership are deliberately absent: resizing
 * a live terminal must not arbitrate focus.
 */
export function desiredNativeTerminalKeyboardOwner({
  activePaneId,
  paneSurfaceActive,
  activePaneVisible,
  activePaneReadOnly,
  inputBlocked,
  webEditableFocused,
  webSelectionActive,
}: NativeTerminalKeyboardOwnerInputs): string | null {
  if (
    !activePaneId ||
    !paneSurfaceActive ||
    !activePaneVisible ||
    activePaneReadOnly ||
    inputBlocked ||
    webEditableFocused ||
    webSelectionActive
  ) {
    return null;
  }
  return activePaneId;
}
