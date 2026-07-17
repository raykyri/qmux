export interface NativeTerminalKeyboardOwnerInputs {
  activePaneId: string | null;
  paneSurfaceActive: boolean;
  activePaneVisible: boolean;
  activePaneReadOnly: boolean;
  inputBlocked: boolean;
  webEditableFocused: boolean;
  webSelectionActive: boolean;
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
