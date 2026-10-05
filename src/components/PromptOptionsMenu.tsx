import { Ellipsis } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { turnPaneRectFrom } from "../lib/appHelpers";
import { Button, Menu, MenuItem, PopoverPortal } from "./ui";
import { useAnchoredPopover } from "./ui/hooks/useAnchoredPopover";

export function PromptOptionsMenu({
  triggerRef,
  anchorPoint,
  onClose,
  onEdit,
  onDelete,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  anchorPoint?: { x: number; y: number };
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const style = useAnchoredPopover({
    open: true,
    triggerRef,
    popoverRef,
    anchorPoint,
    onClose,
    preferredWidth: 140,
    paneRect: turnPaneRectFrom,
    align: anchorPoint ? "start" : "end",
  });
  return (
    <PopoverPortal>
      <Menu
        ref={popoverRef}
        className="prompt-library-row-menu-popover"
        aria-label="Prompt options"
        style={style ?? { left: -9999, top: -9999 }}
      >
        <MenuItem
          className="prompt-library-row-menu-item"
          onClick={() => {
            onClose();
            onEdit();
          }}
        >
          Edit
        </MenuItem>
        <MenuItem
          tone="danger"
          className="prompt-library-row-menu-item"
          onClick={() => {
            onClose();
            onDelete();
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </PopoverPortal>
  );
}

export function PromptRowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        ref={triggerRef}
        className={`prompt-library-item-menu-trigger${open ? " is-open" : ""}`}
        title="Prompt options"
        aria-label="Prompt options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </Button>
      {open ? (
        <PromptOptionsMenu
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}
    </>
  );
}
