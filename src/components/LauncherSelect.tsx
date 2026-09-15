import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown } from "lucide-react";
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

interface LauncherSelectProps {
  value: string;
  options: LauncherSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

const launcherPopoverWidth = (trigger: HTMLElement, popover: HTMLElement) =>
  Math.max(trigger.getBoundingClientRect().width, popover.scrollWidth);

export function LauncherSelect({ value, options, onChange, ariaLabel }: LauncherSelectProps) {
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const listboxId = `launcher-select-${generatedId}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listbox = useListbox({ options, value, open, onOpenChange: setOpen, onChange });
  const popoverStyle = useAnchoredPopover({
    open,
    onClose: listbox.closeListbox,
    triggerRef,
    popoverRef,
    preferredWidth: launcherPopoverWidth,
  });

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
        disabled={listbox.empty}
        onClick={() => (open ? listbox.closeListbox() : listbox.openListbox())}
        onKeyDown={listbox.handleKeyDown}
      >
        {selected?.iconSrc ? (
          <img className={triggerIconClass} src={selected.iconSrc} alt="" aria-hidden="true" />
        ) : null}
        <span className="launcher-select-value">{selected?.label}</span>
        <ChevronDown size={13} className="launcher-select-chevron" aria-hidden="true" />
      </Button>
      {open ? (
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
          </Popover>
        </PopoverPortal>
      ) : null}
    </div>
  );
}
