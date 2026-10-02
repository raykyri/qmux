import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { TranscriptOption } from "../types";
import { turnPaneRectFrom } from "../lib/appHelpers";
import { formatRelativeTime, sessionMenuTitle } from "../lib/transcriptSessions";
import { Button, Popover, PopoverPortal, useAnchoredPopover, useListbox } from "./ui";

const preferredWidth = (trigger: HTMLElement) =>
  Math.max(trigger.getBoundingClientRect().width, 280);

// A compact, portaled transcript listbox in the empty transcript view. Focus
// stays on the trigger; aria-activedescendant identifies keyboard navigation.
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
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const sessions = [...options].sort((a, b) => b.modifiedMs - a.modifiedMs);
  const listbox = useListbox({
    options: sessions.map((option) => ({ value: option.path, label: sessionMenuTitle(option) })),
    value: activePath ?? "",
    open,
    onOpenChange: setOpen,
    allowReselect: true,
    onChange: (path) => {
      triggerRef.current?.focus();
      onSelect(path === activePath ? null : path);
    },
  });
  const position = useAnchoredPopover({
    open,
    onClose: listbox.closeListbox,
    triggerRef,
    popoverRef,
    preferredWidth,
    paneRect: turnPaneRectFrom,
  });
  useLayoutEffect(() => {
    if (open && listbox.activeIndex >= 0) {
      document
        .getElementById(`${listboxId}-${listbox.activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
    if (sessions.length === 0) setOpen(false);
  }, [listbox.activeIndex, listboxId, open, sessions.length]);

  if (sessions.length === 0) return <span className="turn-empty-notice">No transcript loaded</span>;
  return (
    <span className="turn-empty-picker">
      <Button
        ref={triggerRef}
        variant="link"
        className="turn-empty-picker-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && listbox.activeIndex >= 0 ? `${listboxId}-${listbox.activeIndex}` : undefined
        }
        onClick={() => (open ? listbox.closeListbox() : listbox.openListbox())}
        onKeyDown={listbox.handleKeyDown}
      >
        No transcript loaded
        <ChevronDown size={13} className="turn-empty-picker-chevron" aria-hidden="true" />
      </Button>
      {open ? (
        <PopoverPortal>
          <Popover
            ref={popoverRef}
            id={listboxId}
            className="turn-empty-picker-popover"
            role="listbox"
            aria-label="Available transcripts"
            style={position ?? { left: -9999, top: -9999 }}
          >
            {sessions.map((option, index) => (
              <Button
                key={option.path}
                id={`${listboxId}-${index}`}
                variant="menu"
                role="option"
                tabIndex={-1}
                aria-selected={option.path === activePath}
                className={`session-menu-item${option.path === activePath ? " is-active" : ""}${index === listbox.activeIndex ? " is-highlighted" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => listbox.setActiveIndex(index)}
                onClick={() => listbox.chooseIndex(index)}
              >
                <span className="session-menu-title">{sessionMenuTitle(option)}</span>
                <span className="session-menu-meta">
                  {formatRelativeTime(option.modifiedMs)}
                  {option.boundToOtherAgent ? " · In use" : ""}
                </span>
              </Button>
            ))}
          </Popover>
        </PopoverPortal>
      ) : null}
    </span>
  );
}
