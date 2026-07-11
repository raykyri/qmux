import { useLayoutEffect, useRef } from "react";
import { setNativeTerminalWebOverlayRegion } from "../lib/api";

let nextRegionSequence = 0;

/**
 * Keeps the referenced element's bounding rect registered as a web-owned
 * pointer region with the native terminal event router. Without this, any
 * pointer event over a terminal surface is forwarded straight to Ghostty, so
 * a DOM control floating over the terminal never receives its clicks.
 *
 * Attach the returned ref to the floating element; pass `enabled: false` (or
 * unmount) to release the region.
 */
export function useNativeWebOverlayRegion<T extends HTMLElement>(enabled: boolean) {
  const elementRef = useRef<T | null>(null);
  const regionIdRef = useRef<string | null>(null);
  if (regionIdRef.current === null) {
    nextRegionSequence += 1;
    regionIdRef.current = `web-overlay-${nextRegionSequence}`;
  }

  useLayoutEffect(() => {
    const regionId = regionIdRef.current;
    const element = elementRef.current;
    if (!enabled || !regionId || !element) {
      return;
    }
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      const rect = element.getBoundingClientRect();
      void setNativeTerminalWebOverlayRegion({
        regionId,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        visible: rect.width > 0 && rect.height > 0,
      }).catch(() => undefined);
    };
    const schedule = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(sync);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    // A ResizeObserver only reports size changes; the rect also moves when the
    // surrounding layout resizes, so track the offset parent and the window.
    if (element.offsetParent instanceof HTMLElement) {
      observer.observe(element.offsetParent);
    }
    window.addEventListener("resize", schedule);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      void setNativeTerminalWebOverlayRegion({
        regionId,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      }).catch(() => undefined);
    };
  }, [enabled]);

  return elementRef;
}
