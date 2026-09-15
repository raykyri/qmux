import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, Minus } from "lucide-react";
import { Button, Menu, MenuItem, PopoverPortal, useAnchoredPopover } from "./ui";

export interface HomeGroupTerminal {
  agentId: string;
  title: string;
}

export interface HomeGroup {
  id: string;
  name: string;
  terminals: HomeGroupTerminal[];
}

interface HomeGroupSelectorProps {
  groups: HomeGroup[];
  /** Whether the application-global Drafts rail is shown on Home. */
  draftsVisible: boolean;
  onDraftsVisibleChange: (visible: boolean) => void;
  /** Agent ids whose rail is currently hidden from Home. Absence = shown. */
  hiddenTerminalIds: Set<string>;
  /** Show/hide every terminal in the passed list in one write (group checkbox). */
  onSetTerminalsHidden: (agentIds: string[], hidden: boolean) => void;
  /** Toggle a single terminal's visibility (a dropdown row). */
  onToggleTerminal: (agentId: string) => void;
}

const HOME_GROUP_MENU_WIDTH = 240;

/** One group's chip: a checkbox that shows/hides the whole group and a caret
 *  opening a per-terminal menu. The checkbox reads three ways — all shown,
 *  none shown, or a mixed subset. */
function HomeGroupChip({
  group,
  hiddenTerminalIds,
  onSetTerminalsHidden,
  onToggleTerminal,
}: {
  group: HomeGroup;
  hiddenTerminalIds: Set<string>;
  onSetTerminalsHidden: (agentIds: string[], hidden: boolean) => void;
  onToggleTerminal: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const menuStyle = useAnchoredPopover({
    open,
    onClose: closeMenu,
    triggerRef: caretRef,
    popoverRef: menuRef,
    preferredWidth: HOME_GROUP_MENU_WIDTH,
  });

  const agentIds = group.terminals.map((terminal) => terminal.agentId);
  const visibleCount = agentIds.filter((id) => !hiddenTerminalIds.has(id)).length;
  const allVisible = visibleCount === agentIds.length;
  const noneVisible = visibleCount === 0;
  const checkState: boolean | "mixed" = allVisible ? true : noneVisible ? false : "mixed";

  const toggleGroup = () => {
    // Anything short of fully shown reveals the whole group; a fully-shown group
    // hides. Mirrors a tristate checkbox's "click resolves to all-on".
    onSetTerminalsHidden(agentIds, allVisible);
  };

  return (
    <div
      className={`home-group-chip${checkState === false ? " is-off" : ""}${
        checkState === "mixed" ? " is-mixed" : ""
      }`}
    >
      <Button
        role="checkbox"
        aria-checked={checkState}
        className="home-group-toggle"
        onClick={toggleGroup}
      >
        <span className="home-group-checkbox" aria-hidden="true">
          {checkState === true ? (
            <Check size={10} strokeWidth={3} />
          ) : checkState === "mixed" ? (
            <Minus size={10} strokeWidth={3} />
          ) : null}
        </span>
        <span className="home-group-name">{group.name}</span>
        <span className="home-group-count">
          {visibleCount}/{agentIds.length}
        </span>
      </Button>
      <Button
        ref={caretRef}
        className={`home-group-caret${open ? " is-open" : ""}`}
        title={`Choose terminals in ${group.name}`}
        aria-label={`Choose terminals in ${group.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <ChevronDown size={13} aria-hidden="true" />
      </Button>
      {open ? (
        <PopoverPortal target={caretRef.current?.closest(".confirm-dialog-backdrop")}>
          <Menu
            ref={menuRef}
            className="home-group-menu"
            role="menu"
            aria-label={`Terminals in ${group.name}`}
            style={menuStyle ?? { left: -9999, top: -9999 }}
          >
            {group.terminals.map((terminal) => {
              const shown = !hiddenTerminalIds.has(terminal.agentId);
              return (
                <MenuItem
                  key={terminal.agentId}
                  role="menuitemcheckbox"
                  aria-checked={shown}
                  className={`home-group-menu-item${shown ? " is-shown" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleTerminal(terminal.agentId);
                  }}
                >
                  <span className="home-group-checkbox" aria-hidden="true">
                    {shown ? <Check size={10} strokeWidth={3} /> : null}
                  </span>
                  <span className="home-group-menu-item-name">{terminal.title}</span>
                </MenuItem>
              );
            })}
          </Menu>
        </PopoverPortal>
      ) : null}
    </div>
  );
}

/** Home stream visibility: a Drafts chip plus one chip per root sidebar group,
 *  with a whole-group checkbox and a caret for picking individual terminals. */
export default function HomeGroupSelector({
  groups,
  draftsVisible,
  onDraftsVisibleChange,
  hiddenTerminalIds,
  onSetTerminalsHidden,
  onToggleTerminal,
}: HomeGroupSelectorProps) {
  return (
    <div className="home-group-selector" role="group" aria-label="Home streams">
      <div className={`home-group-chip${draftsVisible ? "" : " is-off"}`}>
        <button
          type="button"
          role="checkbox"
          aria-checked={draftsVisible}
          className="control-button home-group-toggle"
          onClick={() => onDraftsVisibleChange(!draftsVisible)}
        >
          <span className="home-group-checkbox" aria-hidden="true">
            {draftsVisible ? <Check size={10} strokeWidth={3} /> : null}
          </span>
          <span className="home-group-name">Drafts</span>
        </button>
      </div>
      {groups.map((group) => (
        <HomeGroupChip
          key={group.id}
          group={group}
          hiddenTerminalIds={hiddenTerminalIds}
          onSetTerminalsHidden={onSetTerminalsHidden}
          onToggleTerminal={onToggleTerminal}
        />
      ))}
    </div>
  );
}
