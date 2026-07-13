import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { TranscriptOption } from "../types";
import { placePanePopover, turnPaneRectFrom } from "../lib/appHelpers";
import { formatRelativeTime, sessionMenuTitle } from "../lib/transcriptSessions";

// Preferred natural width; placement clamps to the right pane so a narrow pane
// cannot push the menu past the outer edge.
const PICKER_PREFERRED_WIDTH = 280;

// Shown in the empty transcript state when no transcript is loaded: a "No
// transcript loaded" link with a chevron that opens a dropdown of the available
// sessions — the same items as the header session menu — and loads
// the chosen one. With no sessions to offer it degrades to plain text. The
// dropdown is portaled to <body> so it escapes the timeline's clipping.
export default function TranscriptPickerLink({
  options,
  activePath,
  onSelect,
}: {
  options: TranscriptOption[];
  activePath: string | null;
  onSelect: (path: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const sessions = [...options].sort((a, b) => b.modifiedMs - a.modifiedMs);

  // Left-align to the trigger (grows right / toward the pane center from the
  // centered empty-state control), clamp width/height to the right pane.
  const positionPopover = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const { height } = popover.getBoundingClientRect();
    const preferredWidth = Math.max(triggerRect.width, PICKER_PREFERRED_WIDTH);
    setPos(
      placePanePopover({
        triggerRect,
        popoverSize: { width: preferredWidth, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "start",
        prefer: "below",
      }),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    positionPopover();
    const onReflow = () => positionPopover();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, positionPopover, sessions.length]);

  // Nothing to pick — just say so, no link.
  if (sessions.length === 0) {
    return <span className="turn-empty-notice">No transcript loaded</span>;
  }

  return (
    <span className="turn-empty-picker">
      <button
        ref={triggerRef}
        type="button"
        className="link-button turn-empty-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        No transcript loaded
        <ChevronDown size={13} className="turn-empty-picker-chevron" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="popover-surface turn-empty-picker-popover"
              role="listbox"
              aria-label="Available transcripts"
              style={
                pos
                  ? {
                      left: pos.left,
                      top: pos.top,
                      maxHeight: pos.maxHeight,
                      width: Math.min(
                        Math.max(triggerRef.current?.getBoundingClientRect().width ?? 0, PICKER_PREFERRED_WIDTH),
                        pos.maxWidth,
                      ),
                      maxWidth: pos.maxWidth,
                    }
                  : { left: -9999, top: -9999 }
              }
            >
              {sessions.map((option) => {
                const active = option.path === activePath;
                return (
                  <button
                    key={option.path}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`menu-item session-menu-item${active ? " is-active" : ""}`}
                    onClick={() => {
                      setOpen(false);
                      onSelect(active ? null : option.path);
                    }}
                  >
                    <span className="session-menu-title">{sessionMenuTitle(option)}</span>
                    <span className="session-menu-meta">
                      {formatRelativeTime(option.modifiedMs)}
                      {option.boundToOtherAgent ? " · In use" : ""}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
