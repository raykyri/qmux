import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { placePanePopover } from "../../../lib/appHelpers";

interface UseAnchoredPopoverOptions {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLElement | null>;
  anchorPoint?: { x: number; y: number };
  preferredWidth: number | "trigger" | ((trigger: HTMLElement, popover: HTMLElement) => number);
  paneRect?: (trigger: HTMLElement) => DOMRect | null;
  align?: "start" | "end";
  prefer?: "above" | "below";
  margin?: number;
  gap?: number;
  closeOnTab?: boolean;
}

export function useAnchoredPopover({
  open,
  onClose,
  triggerRef,
  popoverRef,
  preferredWidth,
  anchorPoint,
  paneRect,
  align = "start",
  prefer = "below",
  margin,
  gap,
  closeOnTab = true,
}: UseAnchoredPopoverOptions): CSSProperties | null {
  const pointX = anchorPoint?.x;
  const pointY = anchorPoint?.y;
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!popover || (!trigger && pointX === undefined)) return;
    const triggerRect =
      pointX !== undefined
        ? new DOMRect(pointX, pointY ?? 0, 0, 0)
        : trigger!.getBoundingClientRect();
    const width =
      typeof preferredWidth === "function"
        ? preferredWidth(trigger!, popover)
        : preferredWidth === "trigger"
          ? triggerRect.width
          : preferredWidth;
    const { height } = popover.getBoundingClientRect();
    const placement = placePanePopover({
      triggerRect,
      popoverSize: { width, height },
      paneRect: trigger ? paneRect?.(trigger) : undefined,
      align,
      prefer,
      margin,
      gap,
    });
    setStyle({
      left: placement.left,
      top: placement.top,
      width: Math.min(width, placement.maxWidth),
      maxWidth: placement.maxWidth,
      maxHeight: placement.maxHeight,
    });
  }, [
    align,
    gap,
    margin,
    paneRect,
    pointX,
    pointY,
    popoverRef,
    prefer,
    preferredWidth,
    triggerRef,
  ]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        (pointX !== undefined || !triggerRef.current?.contains(target)) &&
        !popoverRef.current?.contains(target)
      )
        onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        requestAnimationFrame(() => triggerRef.current?.focus());
      } else if (closeOnTab && event.key === "Tab") {
        // Move to the trigger before the browser performs its normal Tab step,
        // rather than leaving focus in a portal that is about to disappear.
        if (popoverRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        onClose();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [closeOnTab, onClose, open, pointX, popoverRef, reposition, triggerRef]);

  return style;
}
