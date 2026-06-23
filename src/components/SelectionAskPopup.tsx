import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SelectionAnchor } from "../appTypes";

// Two selection boxes "overlap" when their viewport rectangles intersect — used to
// decide whether a re-selection is near enough that the popup should glide to it
// (e.g. growing a word to its line) rather than snap (a jump to a far-off selection,
// which would otherwise slide distractingly across the pane).
function anchorsOverlap(a: SelectionAnchor, b: SelectionAnchor) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

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
  // Whether the current position update should animate, decided per anchor change:
  // glide only when the new selection overlaps the previous one, and never on the
  // first placement (no previous anchor) — which would slide in from offscreen.
  const [glide, setGlide] = useState(false);
  const prevAnchorRef = useRef<SelectionAnchor | null>(null);
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
    const previous = prevAnchorRef.current;
    setGlide(previous != null && anchorsOverlap(previous, anchor));
    prevAnchorRef.current = anchor;
    setPos({ left, top });
  }, [anchor]);

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
      className={`selection-ask-popup${glide ? " is-gliding" : ""}`}
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
            : "New threads are available after a supported session id is recorded"
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
