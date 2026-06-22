import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SelectionAnchor } from "../appTypes";

// A small floating button group shown above (or below) a non-empty text selection,
// offering to ask the active agent about the quoted text. Portals to <body> so it
// escapes the terminal/transcript clipping containers, positions itself in viewport
// (fixed) coordinates measured from the selection's bounding box, and clamps into
// the viewport. Dismisses on outside mousedown, Escape, scroll, or resize — except a
// mousedown inside `reselectWithin` (the surface the selection came from), which is
// the start of a new selection: the popup stays mounted and glides to the next anchor
// instead of unmounting and flashing back.
export default function SelectionAskPopup({
  anchor,
  canAskNewThread,
  reselectWithin,
  onAsk,
  onAskNewThread,
  onClose,
}: {
  anchor: SelectionAnchor;
  canAskNewThread: boolean;
  reselectWithin?: string;
  onAsk: () => void;
  onAskNewThread: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Enable the position transition only after the first placement, so the popup
  // doesn't glide in from its offscreen pre-measure origin on mount.
  const [settled, setSettled] = useState(false);
  // App passes fresh `onClose`/`reselectWithin` each render and re-renders often
  // (streaming agent events). Read them through refs so the listener effect can
  // subscribe once instead of tearing down and re-adding all four listeners on every
  // render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const reselectWithinRef = useRef(reselectWithin);
  reselectWithinRef.current = reselectWithin;

  // Measure self once mounted and place it centered over the selection, preferring
  // above; flip below when there isn't room. Then clamp into the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const gap = 7;
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

  // Turn on the glide transition once the popup has been placed for the first time
  // (after paint), so only later anchor changes animate.
  useEffect(() => {
    if (pos && !settled) {
      setSettled(true);
    }
  }, [pos, settled]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const node = event.target as Node | null;
      if (ref.current?.contains(node)) {
        return;
      }
      // A mousedown inside the selection source starts a re-selection; keep the popup
      // mounted and let the following mouse-up re-anchor (or dismiss) it.
      const within = reselectWithinRef.current;
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      if (within && el?.closest(within)) {
        return;
      }
      onCloseRef.current();
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
      className={`selection-ask-popup${settled ? " is-settled" : ""}`}
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
      <span className="selection-ask-divider" aria-hidden="true" />
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
