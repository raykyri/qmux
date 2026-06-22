import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { TranscriptOption } from "../types";
import { formatRelativeTime, sessionMenuTitle } from "../lib/transcriptSessions";

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
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const sessions = [...options].sort((a, b) => b.modifiedMs - a.modifiedMs);

  const measure = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    }
  };

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
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  // Nothing to pick — just say so, no link.
  if (sessions.length === 0) {
    return <span className="turn-empty-notice">No transcript loaded</span>;
  }

  return (
    <span className="turn-empty-picker">
      <button
        ref={triggerRef}
        type="button"
        className="turn-empty-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            measure();
          }
          setOpen((prev) => !prev);
        }}
      >
        No transcript loaded
        <ChevronDown size={13} className="turn-empty-picker-chevron" aria-hidden="true" />
      </button>
      {open && anchor
        ? createPortal(
            <div
              ref={popoverRef}
              className="turn-empty-picker-popover"
              role="listbox"
              aria-label="Available transcripts"
              style={{ left: anchor.left, top: anchor.top, minWidth: Math.max(anchor.width, 220) }}
            >
              {sessions.map((option) => {
                const active = option.path === activePath;
                return (
                  <button
                    key={option.path}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`session-menu-item${active ? " is-active" : ""}`}
                    onClick={() => {
                      setOpen(false);
                      onSelect(active ? null : option.path);
                    }}
                  >
                    <span className="session-menu-title">{sessionMenuTitle(option)}</span>
                    <span className="session-menu-meta">
                      {formatRelativeTime(option.modifiedMs)}
                      {option.boundToOtherAgent ? " · in use by another agent" : ""}
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
