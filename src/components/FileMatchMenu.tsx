import { useRef } from "react";
import { Menu, MenuItem, PopoverPortal, useAnchoredPopover } from "./ui";

interface FileMatchMenuProps {
  name: string;
  paths: string[];
  incomplete: boolean;
  cwd?: string;
  trigger: HTMLElement;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function FileMatchMenu({
  name,
  paths,
  incomplete,
  cwd,
  trigger,
  onSelect,
  onClose,
}: FileMatchMenuProps) {
  const triggerRef = useRef<HTMLElement | null>(trigger);
  const menuRef = useRef<HTMLDivElement | null>(null);
  triggerRef.current = trigger;
  const style = useAnchoredPopover({
    open: true,
    onClose,
    triggerRef,
    popoverRef: menuRef,
    preferredWidth: 360,
  });
  return (
    <PopoverPortal>
      <Menu
        ref={menuRef}
        className="file-match-menu"
        style={style ?? { visibility: "hidden" }}
        aria-label={`Choose ${name}`}
      >
        {paths.map((path) => (
          <MenuItem key={path} title={path} onClick={() => onSelect(path)}>
            {cwd && path.startsWith(`${cwd.replace(/\/+$/u, "")}/`)
              ? path.slice(cwd.replace(/\/+$/u, "").length + 1)
              : path}
          </MenuItem>
        ))}
        {incomplete ? <MenuItem disabled>Search limit reached; other matches may exist</MenuItem> : null}
      </Menu>
    </PopoverPortal>
  );
}
