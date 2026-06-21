import { useEffect, useRef } from "react";
import { ExternalLink, Globe } from "lucide-react";

// Right-click chooser for a link: open it in the internal browser overlay or the OS
// browser. Positioned at the pointer (viewport coords); closes on outside click,
// Escape, or either choice.
interface LinkContextMenuProps {
  x: number;
  y: number;
  onOpenInternal: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
}

export default function LinkContextMenu({
  x,
  y,
  onOpenInternal,
  onOpenExternal,
  onClose,
}: LinkContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="link-context-menu" style={{ left: x, top: y }} role="menu">
      <button
        type="button"
        role="menuitem"
        className="link-context-menu-item"
        onClick={onOpenInternal}
      >
        <Globe size={14} aria-hidden="true" />
        <span>Open in internal browser</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="link-context-menu-item"
        onClick={onOpenExternal}
      >
        <ExternalLink size={14} aria-hidden="true" />
        <span>Open in external browser</span>
      </button>
    </div>
  );
}
