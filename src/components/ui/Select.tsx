import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import Button from "./Button";
import { classNames } from "./classNames";
import { Popover, PopoverPortal } from "./Popover";
import { useAnchoredPopover } from "./hooks/useAnchoredPopover";
import { useListbox, type ListboxOption } from "./hooks/useListbox";

export interface SelectOption extends ListboxOption {
  group?: string;
}

export interface SelectProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

export default function Select({
  id,
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder = "Select…",
  className,
}: SelectProps) {
  const generatedId = useId();
  const triggerId = id ?? `select-${generatedId}`;
  const listboxId = `${triggerId}-options`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listbox = useListbox({ options, value, open, onOpenChange: setOpen, onChange });
  const popoverStyle = useAnchoredPopover({
    open,
    onClose: listbox.closeListbox,
    triggerRef,
    popoverRef,
    preferredWidth: "trigger",
  });

  useLayoutEffect(() => {
    if (!open || listbox.activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-option-${listbox.activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listbox.activeIndex, listboxId, open]);

  const groups = options.reduce<
    Array<{ label?: string; options: Array<{ option: SelectOption; index: number }> }>
  >((result, option, index) => {
    const current = result[result.length - 1];
    if (!current || current.label !== option.group) {
      result.push({ label: option.group, options: [{ option, index }] });
    } else {
      current.options.push({ option, index });
    }
    return result;
  }, []);
  const unavailable = disabled || listbox.empty;

  return (
    <div className={classNames("custom-select", className)}>
      <Button
        ref={triggerRef}
        id={triggerId}
        variant="unstyled"
        className="custom-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && listbox.activeIndex >= 0
            ? `${listboxId}-option-${listbox.activeIndex}`
            : undefined
        }
        disabled={unavailable}
        onClick={() => (open ? listbox.closeListbox() : listbox.openListbox())}
        onKeyDown={listbox.handleKeyDown}
      >
        <span
          className={classNames(
            "custom-select-value",
            !listbox.selectedOption && "is-placeholder",
          )}
        >
          {listbox.selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className="custom-select-chevron" size={16} aria-hidden="true" />
      </Button>
      {open ? (
        <PopoverPortal target={triggerRef.current?.closest(".confirm-dialog-backdrop")}>
          <Popover
            ref={popoverRef}
            id={listboxId}
            className="custom-select-popover"
            role="listbox"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : triggerId}
            style={popoverStyle ?? { left: -9999, top: -9999 }}
          >
            {groups.map((group, groupIndex) => {
              const groupLabelId = `${listboxId}-group-${groupIndex}`;
              const content = group.options.map(({ option, index }) => {
                const selected = index === listbox.selectedIndex;
                return (
                  <Button
                    key={`${option.value}-${index}`}
                    id={`${listboxId}-option-${index}`}
                    variant="menu"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    disabled={option.disabled}
                    className={classNames(
                      "custom-select-option",
                      index === listbox.activeIndex && "is-highlighted",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => {
                      if (!option.disabled) listbox.setActiveIndex(index);
                    }}
                    onClick={() => listbox.chooseIndex(index)}
                  >
                    <span>{option.label}</span>
                    {selected ? <Check size={15} aria-hidden="true" /> : null}
                  </Button>
                );
              });
              return group.label ? (
                <div key={`${group.label}-${groupIndex}`} role="group" aria-labelledby={groupLabelId}>
                  <div id={groupLabelId} className="custom-select-group-label">
                    {group.label}
                  </div>
                  {content}
                </div>
              ) : (
                <Fragment key={`ungrouped-${groupIndex}`}>{content}</Fragment>
              );
            })}
          </Popover>
        </PopoverPortal>
      ) : null}
    </div>
  );
}
