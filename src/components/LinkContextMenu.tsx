import { useRef } from "react";
import { Menu, MenuItem, useAnchoredPopover } from "./ui";
import { ExternalLink, FolderOpen, Globe } from "lucide-react";

// Right-click chooser for a link. Web links choose between the internal and OS
// browsers; local links can preview, reveal, or deliberately use the default app.
// Positioned at the pointer (viewport coords); closes on outside click or Escape.
interface LinkContextMenuProps {
  x: number;
  y: number;
  canOpenInternal: boolean;
  onOpenInternal: () => void;
  externalLabel?: string;
  externalKind?: "browser" | "reveal";
  onOpenExternal: () => void;
  onOpenWithDefaultApp?: (() => void) | null;
  onClose: () => void;
}

export default function LinkContextMenu({
  x,
  y,
  canOpenInternal,
  onOpenInternal,
  externalLabel = "Open in browser",
  externalKind = "browser",
  onOpenExternal,
  onOpenWithDefaultApp = null,
  onClose,
}: LinkContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const triggerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const position = useAnchoredPopover({
    open: true,
    onClose,
    triggerRef,
    popoverRef: ref,
    anchorPoint: { x, y },
    preferredWidth: 230,
    gap: 0,
  });
  const choose = (action: () => void) => {
    triggerRef.current?.focus();
    onClose();
    action();
  };

  return (
    <Menu
      ref={ref}
      className="link-context-menu"
      style={position ?? { left: x, top: y }}
      role="menu"
    >
      {canOpenInternal ? (
        <MenuItem
          type="button"
          role="menuitem"
          className="link-context-menu-item"
          onClick={() => choose(onOpenInternal)}
        >
          <Globe size={14} aria-hidden="true" />
          <span>Open</span>
        </MenuItem>
      ) : null}
      <MenuItem
        type="button"
        role="menuitem"
        className="link-context-menu-item"
        onClick={() => choose(onOpenExternal)}
      >
        {externalKind === "reveal" ? (
          <FolderOpen size={14} aria-hidden="true" />
        ) : (
          <ExternalLink size={14} aria-hidden="true" />
        )}
        <span>{externalLabel}</span>
      </MenuItem>
      {onOpenWithDefaultApp ? (
        <MenuItem
          type="button"
          role="menuitem"
          className="link-context-menu-item"
          onClick={() => choose(onOpenWithDefaultApp)}
        >
          <ExternalLink size={14} aria-hidden="true" />
          <span>Open with default app</span>
        </MenuItem>
      ) : null}
    </Menu>
  );
}
