import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Minus } from "lucide-react";
import { placePanePopover } from "../lib/appHelpers";

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
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);

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

  const position = useCallback(() => {
    const trigger = caretRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) {
      return;
    }
    const { height } = menu.getBoundingClientRect();
    setPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width: HOME_GROUP_MENU_WIDTH, height },
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
      if (!caretRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    position();
    const onReflow = () => position();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, position]);

  return (
    <div
      className={`home-group-chip${checkState === false ? " is-off" : ""}${
        checkState === "mixed" ? " is-mixed" : ""
      }`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checkState}
        className="control-button home-group-toggle"
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
      </button>
      <button
        ref={caretRef}
        type="button"
        className={`control-button home-group-caret${open ? " is-open" : ""}`}
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
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="popover-surface popover-surface--context home-group-menu"
              role="menu"
              aria-label={`Terminals in ${group.name}`}
              style={
                pos
                  ? {
                      left: pos.left,
                      top: pos.top,
                      maxHeight: pos.maxHeight,
                      width: Math.min(HOME_GROUP_MENU_WIDTH, pos.maxWidth),
                      maxWidth: pos.maxWidth,
                    }
                  : { left: -9999, top: -9999 }
              }
            >
              {group.terminals.map((terminal) => {
                const shown = !hiddenTerminalIds.has(terminal.agentId);
                return (
                  <button
                    key={terminal.agentId}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={shown}
                    className={`menu-item home-group-menu-item${shown ? " is-shown" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleTerminal(terminal.agentId);
                    }}
                  >
                    <span className="home-group-checkbox" aria-hidden="true">
                      {shown ? <Check size={10} strokeWidth={3} /> : null}
                    </span>
                    <span className="home-group-menu-item-name">{terminal.title}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
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
