import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, RefObject } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import {
  Button,
  Popover,
  PopoverPortal,
  classNames,
  firstEnabledIndex,
  useAnchoredPopover,
  useListbox,
} from "./ui";

export interface LauncherSelectOption {
  value: string;
  label: string;
  iconSrc?: string;
  iconClassName?: string;
  dividerBefore?: boolean;
  tone?: "danger";
  detail?: string;
  disabled?: boolean;
}

/** A secondary option list reached from a row at the bottom of the popover, for
 * a setting that belongs to the primary choice (a model's effort level) instead
 * of competing with it for width in the launcher row. */
export interface LauncherSelectSubmenu {
  label: string;
  value: string;
  options: LauncherSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

interface LauncherSelectProps {
  value: string;
  options: LauncherSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  submenu?: LauncherSelectSubmenu;
}

/** Sentinel value of the synthetic navigation entry that stands for the submenu
 * row. It can never collide with a real option because `value` is a model or
 * effort id. */
export const LAUNCHER_SUBMENU_VALUE = "__launcher-select-submenu__";

/** The listbox navigation model: the real options plus, when a submenu exists, a
 * trailing row for it. Keyboard traversal, typeahead and `aria-activedescendant`
 * all run over this list; only the submenu row is not selectable. */
export function launcherSelectNavOptions(
  options: LauncherSelectOption[],
  submenu?: LauncherSelectSubmenu,
): LauncherSelectOption[] {
  if (!submenu) return options;
  return [
    ...options,
    { value: LAUNCHER_SUBMENU_VALUE, label: submenu.label, dividerBefore: true },
  ];
}

/** Keys that cross the boundary between a listbox and its submenu. */
export function launcherSubmenuKeyAction(key: string): "open" | "close" | null {
  if (key === "ArrowRight" || key === "Enter" || key === " ") return "open";
  if (key === "ArrowLeft") return "close";
  return null;
}

const launcherPopoverWidth = (trigger: HTMLElement, popover: HTMLElement) =>
  Math.max(trigger.getBoundingClientRect().width, popover.scrollWidth);

export function LauncherSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  submenu,
}: LauncherSelectProps) {
  const [open, setOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const generatedId = useId();
  const listboxId = `launcher-select-${generatedId}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const submenuRowRef = useRef<HTMLButtonElement | null>(null);
  const navOptions = useMemo(
    () => launcherSelectNavOptions(options, submenu),
    [options, submenu],
  );
  const submenuIndex = submenu ? navOptions.length - 1 : -1;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSubmenuOpen(false);
  };
  const listbox = useListbox({
    options: navOptions,
    value,
    open,
    onOpenChange: changeOpen,
    onChange,
  });
  const popoverStyle = useAnchoredPopover({
    open,
    onClose: listbox.closeListbox,
    triggerRef,
    popoverRef,
    preferredWidth: launcherPopoverWidth,
    // While the submenu is open it owns Escape, Tab and outside clicks, so this
    // popover does not also dismiss itself on the same event.
    suspended: submenuOpen,
  });

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setSubmenuOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (listbox.selectedOption || options.length === 0) return;
    const fallbackIndex = firstEnabledIndex(options);
    if (fallbackIndex >= 0) onChange(options[fallbackIndex].value);
  }, [listbox.selectedOption, onChange, options, value]);

  useLayoutEffect(() => {
    if (!open || listbox.activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-option-${listbox.activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listbox.activeIndex, listboxId, open]);

  const openSubmenu = () => {
    setSubmenuOpen(true);
    submenuRowRef.current?.focus();
  };
  const closeSubmenu = () => {
    setSubmenuOpen(false);
    submenuRowRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      submenu &&
      open &&
      listbox.activeIndex === submenuIndex &&
      launcherSubmenuKeyAction(event.key) === "open"
    ) {
      event.preventDefault();
      openSubmenu();
      return;
    }
    listbox.handleKeyDown(event);
  };

  /** Virtual focus lives on the select trigger, so handing control back to the
   * parent list means restoring real focus there before replaying the key. */
  const returnToParent = (event: KeyboardEvent<HTMLElement>) => {
    triggerRef.current?.focus();
    listbox.handleKeyDown(event);
  };

  const selected = listbox.selectedOption;
  const triggerIconClass = classNames("launcher-select-icon", selected?.iconClassName);

  return (
    <div className="launcher-select">
      <Button
        ref={triggerRef}
        className={classNames("launcher-select-trigger", selected?.tone && `is-${selected.tone}`)}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-activedescendant={
          open && listbox.activeIndex >= 0
            ? `${listboxId}-option-${listbox.activeIndex}`
            : undefined
        }
        disabled={disabled || listbox.empty}
        onClick={() => (open ? listbox.closeListbox() : listbox.openListbox())}
        onKeyDown={handleTriggerKeyDown}
      >
        {selected?.iconSrc ? (
          <img className={triggerIconClass} src={selected.iconSrc} alt="" aria-hidden="true" />
        ) : null}
        <span className="launcher-select-value">{selected?.label}</span>
        <ChevronDown size={13} className="launcher-select-chevron" aria-hidden="true" />
      </Button>
      {open && !disabled ? (
        <PopoverPortal target={triggerRef.current?.closest(".confirm-dialog-backdrop")}>
          <Popover
            ref={popoverRef}
            id={listboxId}
            className="launcher-select-popover"
            role="listbox"
            aria-label={ariaLabel}
            style={popoverStyle ?? { left: -9999, top: -9999 }}
          >
            {options.map((option, index) => {
              const selectedOption = index === listbox.selectedIndex;
              return (
                <Fragment key={`${option.value}-${index}`}>
                  {option.dividerBefore ? (
                    <div
                      className="launcher-select-separator"
                      role="separator"
                      aria-hidden="true"
                    />
                  ) : null}
                  <Button
                    id={`${listboxId}-option-${index}`}
                    variant="menu"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selectedOption}
                    disabled={option.disabled}
                    className={classNames(
                      "launcher-select-item",
                      option.tone && `is-${option.tone}`,
                      index === listbox.activeIndex && "is-highlighted",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => {
                      setSubmenuOpen(false);
                      if (!option.disabled) listbox.setActiveIndex(index);
                    }}
                    onClick={() => listbox.chooseIndex(index)}
                  >
                    {option.iconSrc ? (
                      <img
                        className={classNames("launcher-select-icon", option.iconClassName)}
                        src={option.iconSrc}
                        alt=""
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="launcher-select-item-label">{option.label}</span>
                    {option.detail ? (
                      <span className="launcher-select-item-detail">{option.detail}</span>
                    ) : null}
                    {selectedOption ? (
                      <Check size={14} className="launcher-select-check" aria-hidden="true" />
                    ) : null}
                  </Button>
                </Fragment>
              );
            })}
            {submenu ? (
              <LauncherSelectSubmenuRow
                id={`${listboxId}-option-${submenuIndex}`}
                rowRef={submenuRowRef}
                submenu={submenu}
                open={submenuOpen}
                highlighted={listbox.activeIndex === submenuIndex}
                onOpen={openSubmenu}
                onClose={closeSubmenu}
                onHighlight={() => listbox.setActiveIndex(submenuIndex)}
                onReturnToParent={returnToParent}
              />
            ) : null}
          </Popover>
        </PopoverPortal>
      ) : null}
    </div>
  );
}

/** The submenu row and its nested list. Exported so the UI catalog test can
 * assert the row's ARIA contract without a DOM; use it through
 * `LauncherSelect`'s `submenu` prop. */
export function LauncherSelectSubmenuRow({
  id,
  rowRef,
  submenu,
  open,
  highlighted,
  onOpen,
  onClose,
  onHighlight,
  onReturnToParent,
}: {
  id: string;
  rowRef: RefObject<HTMLButtonElement | null>;
  submenu: LauncherSelectSubmenu;
  open: boolean;
  highlighted: boolean;
  onOpen: () => void;
  onClose: () => void;
  onHighlight: () => void;
  onReturnToParent: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const generatedId = useId();
  const listboxId = `launcher-select-submenu-${generatedId}`;
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listbox = useListbox({
    options: submenu.options,
    value: submenu.value,
    open,
    onOpenChange: (next) => {
      if (!next) onClose();
    },
    onChange: submenu.onChange,
  });
  const popoverStyle = useAnchoredPopover({
    open,
    onClose,
    triggerRef: rowRef,
    popoverRef,
    preferredWidth: launcherPopoverWidth,
  });

  useLayoutEffect(() => {
    if (!open || listbox.activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-option-${listbox.activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listbox.activeIndex, listboxId, open]);

  // Real focus rests on the row itself while the submenu is open; its options
  // are tracked virtually, exactly as the parent list tracks its own.
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const action = launcherSubmenuKeyAction(event.key);
    if (!open) {
      if (action === "open") {
        event.preventDefault();
        onOpen();
        return;
      }
      onReturnToParent(event);
      return;
    }
    if (action === "close") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // Tab leaves the whole control, not just this level: close the parent list
      // too and let the browser move on from its trigger.
      onReturnToParent(event);
      return;
    }
    listbox.handleKeyDown(event);
  };

  return (
    <>
      <div className="launcher-select-separator" role="separator" aria-hidden="true" />
      <Button
        ref={rowRef}
        id={id}
        variant="menu"
        role="option"
        tabIndex={-1}
        aria-selected={false}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && listbox.activeIndex >= 0
            ? `${listboxId}-option-${listbox.activeIndex}`
            : undefined
        }
        className={classNames(
          "launcher-select-item",
          "launcher-select-submenu-trigger",
          open && "is-open",
          highlighted && "is-highlighted",
        )}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={onHighlight}
        onClick={() => (open ? onClose() : onOpen())}
        onKeyDown={handleKeyDown}
      >
        <span className="launcher-select-item-label">{submenu.label}</span>
        <span className="launcher-select-item-detail">{listbox.selectedOption?.label}</span>
        <ChevronRight size={14} className="launcher-select-submenu-chevron" aria-hidden="true" />
      </Button>
      {open ? (
        <PopoverPortal target={rowRef.current?.closest(".confirm-dialog-backdrop")}>
          <Popover
            ref={popoverRef}
            id={listboxId}
            className="launcher-select-popover launcher-select-submenu"
            role="listbox"
            aria-label={submenu.ariaLabel ?? submenu.label}
            style={popoverStyle ?? { left: -9999, top: -9999 }}
          >
            {submenu.options.map((option, index) => {
              const selectedOption = index === listbox.selectedIndex;
              return (
                <Button
                  key={`${option.value}-${index}`}
                  id={`${listboxId}-option-${index}`}
                  variant="menu"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selectedOption}
                  disabled={option.disabled}
                  className={classNames(
                    "launcher-select-item",
                    option.tone && `is-${option.tone}`,
                    index === listbox.activeIndex && "is-highlighted",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    if (!option.disabled) listbox.setActiveIndex(index);
                  }}
                  onClick={() => listbox.chooseIndex(index)}
                >
                  <span className="launcher-select-item-label">{option.label}</span>
                  {option.detail ? (
                    <span className="launcher-select-item-detail">{option.detail}</span>
                  ) : null}
                  {selectedOption ? (
                    <Check size={14} className="launcher-select-check" aria-hidden="true" />
                  ) : null}
                </Button>
              );
            })}
          </Popover>
        </PopoverPortal>
      ) : null}
    </>
  );
}
