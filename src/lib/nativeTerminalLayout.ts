export interface NativeTerminalRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function canExpandNativeTerminal(nativeAvailable: boolean, paneCount: number, rightPaneVisible: boolean): boolean {
  return nativeAvailable && (paneCount > 1 || rightPaneVisible);
}

/** A native live resize deliberately holds the terminal's grid until release.
 * Back the entire expanded aperture so new space shows terminal background,
 * not window vibrancy, while that resize is pending. */
export function nativeTerminalBackstopRect(
  stage: NativeTerminalRect,
  expanded: boolean,
  viewportWidth: number,
  viewportHeight: number,
): NativeTerminalRect {
  return expanded ? { left: 0, top: 0, width: viewportWidth, height: viewportHeight } : stage;
}

/**
 * Hidden terminal DOM nodes still follow the active tab's layout. Keep a
 * parked native surface at its last visible frame so another tab adding or
 * removing a right pane cannot resize its PTY behind the scenes.
 */
export function nativeTerminalLayoutRect(
  measuredRect: NativeTerminalRect,
  visible: boolean,
  lastVisibleRect: NativeTerminalRect | null,
): NativeTerminalRect {
  return visible || !lastVisibleRect ? measuredRect : lastVisibleRect;
}

/** Window-sized paint mask with a rounded transparent terminal aperture.
 * The native surface itself remains rectangular and keeps its backing layer. */
export function nativeTerminalCutout(
  rect: NativeTerminalRect,
  viewportWidth: number,
  viewportHeight: number,
  radius: number,
): string {
  const { left: x, top: y, width, height } = rect;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return `path(evenodd, "M0 0H${viewportWidth}V${viewportHeight}H0Z ` +
    `M${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}` +
    `V${y + height - r}A${r} ${r} 0 0 1 ${x + width - r} ${y + height}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + height - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z")`;
}
