import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SelectionAnchor } from "../appTypes";

// A small floating button group shown above (or below) a non-empty text selection,
// offering to ask the active agent about the quoted text. Portals to <body> so it
// escapes the terminal/transcript clipping containers, positions itself in viewport
// (fixed) coordinates measured from the selection's bounding box, and clamps into
// the viewport. Dismisses on outside mousedown, Escape, scroll, or resize.
export default function SelectionAskPopup({
  anchor,
  canAskNewThread,
  onAsk,
  onAskNewThread,
  onClose,
}: {
  anchor: SelectionAnchor;
  canAskNewThread: boolean;
  onAsk: () => void;
  onAskNewThread: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // App passes a fresh `onClose` arrow each render and re-renders often (streaming
  // agent events). Read it through a ref so the listener effect can subscribe once
  // instead of tearing down and re-adding all four listeners on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Measure self once mounted and place it centered over the selection, preferring
  // above; flip below when there isn't room. Then clamp into the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const gap = 8;
    const { width, height } = el.getBoundingClientRect();
    const centerX = (anchor.left + anchor.right) / 2;
    let left = centerX - width / 2;
    let top = anchor.top - height - gap;
    if (top < gap) {
      top = anchor.bottom + gap;
    }
    left = Math.max(gap, Math.min(left, window.innerWidth - width - gap));
    top = Math.max(gap, Math.min(top, window.innerHeight - height - gap));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onCloseRef.current();
      }
    };
    // Dismiss on any key, not just Escape: the popup has no text input, so any
    // keystroke means the user has moved on (typing in the composer, or opening
    // another overlay via a shortcut like Cmd-;, which the popup would otherwise
    // float over).
    const onKey = () => onCloseRef.current();
    // Any scroll (capture, so nested scrollers count) or resize moves the anchor,
    // so just dismiss rather than chase it.
    const onReflow = () => onCloseRef.current();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      className="selection-ask-popup"
      role="group"
      aria-label="Ask about selection"
      // Keep it offscreen until measured so it doesn't flash at the origin.
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      <button
        type="button"
        className="selection-ask-button"
        // Don't clear the selection or steal focus before the click registers.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAsk}
      >
        Ask
      </button>
      <button
        type="button"
        className="selection-ask-button"
        disabled={!canAskNewThread}
        title={
          canAskNewThread
            ? "Ask in new thread"
            : "New threads are available for Claude sessions after a session id is recorded"
        }
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAskNewThread}
      >
        Ask in new thread
      </button>
    </div>,
    document.body,
  );
}
