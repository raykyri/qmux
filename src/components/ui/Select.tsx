import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import Button from "./Button";
import { Input } from "./FormField";
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
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  loading?: boolean;
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
  searchable = false,
  searchPlaceholder = "Search options…",
  emptyMessage = "No matching options",
  loading = false,
}: SelectProps) {
  const generatedId = useId();
  const triggerId = id ?? `select-${generatedId}`;
  const listboxId = `${triggerId}-options`;
  const [requestedOpen, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = searchable && normalizedQuery
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery))
    : options;
  const selectedOption = options.find((option) => option.value === value);
  const unavailable = disabled || (!searchable && options.every((option) => option.disabled));
  const open = requestedOpen && !unavailable;
  useLayoutEffect(() => {
    if (unavailable) setOpen(false);
    if (!open) setQuery("");
  }, [open, unavailable]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listbox = useListbox({
    options: filteredOptions,
    value,
    open,
    disabled: unavailable,
    editable: searchable,
    onOpenChange: (nextOpen) => {
      if (!nextOpen && popoverRef.current?.contains(document.activeElement)) {
        triggerRef.current?.focus();
      }
      setOpen(nextOpen);
    },
    onChange,
  });
  const popoverStyle = useAnchoredPopover({
    open,
    onClose: listbox.closeListbox,
    triggerRef,
    popoverRef,
    preferredWidth: "trigger",
  });

  useLayoutEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  useLayoutEffect(() => {
    if (!open || listbox.activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-option-${listbox.activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listbox.activeIndex, listboxId, open]);

  const groups = filteredOptions.reduce<
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

  return (
    <div className={classNames("custom-select", className)}>
      <Button
        ref={triggerRef}
        id={triggerId}
        variant="unstyled"
        className="custom-select-trigger"
        role={searchable ? undefined : "combobox"}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          !searchable && open && listbox.activeOption
            ? `${listboxId}-option-${listbox.activeIndex}`
            : undefined
        }
        disabled={unavailable}
        onClick={() => (open ? listbox.closeListbox() : listbox.openListbox())}
        onKeyDown={(event) => {
          if (
            searchable && event.key.length === 1 && !event.nativeEvent.isComposing &&
            !event.altKey && !event.ctrlKey && !event.metaKey
          ) {
            event.preventDefault();
            setQuery(event.key === " " ? "" : event.key);
            listbox.openListbox();
          } else {
            listbox.handleKeyDown(event);
          }
        }}
      >
        <span
          className={classNames("custom-select-value", !selectedOption && "is-placeholder")}
          title={selectedOption?.label}
        >
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className="custom-select-chevron" size={16} aria-hidden="true" />
      </Button>
      {open ? (
        <PopoverPortal target={triggerRef.current?.closest(".confirm-dialog-backdrop")}>
          <Popover
            ref={popoverRef}
            className={classNames(
              "custom-select-popover",
              searchable && "custom-select-popover--searchable",
            )}
            style={popoverStyle ?? { left: -9999, top: -9999 }}
          >
            {searchable ? (
              <div className="custom-select-search">
                <Search size={15} aria-hidden="true" />
                <Input
                  ref={searchRef}
                  // Focus is managed from the trigger; Tab resumes from there.
                  tabIndex={-1}
                  className="custom-select-search-input"
                  role="combobox"
                  aria-label={searchPlaceholder}
                  aria-expanded={open}
                  aria-controls={listboxId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    listbox.activeOption
                      ? `${listboxId}-option-${listbox.activeIndex}`
                      : undefined
                  }
                  placeholder={searchPlaceholder}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={listbox.handleKeyDown}
                />
              </div>
            ) : null}
            <div
              id={listboxId}
              className="custom-select-options"
              role="listbox"
              aria-label={ariaLabel}
              aria-labelledby={ariaLabel ? undefined : triggerId}
              aria-busy={loading || undefined}
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
                      aria-disabled={option.disabled || undefined}
                      disabled={option.disabled}
                      className={classNames(
                        "custom-select-option",
                        index === listbox.activeIndex && "is-highlighted",
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => {
                        if (!option.disabled) listbox.setActiveIndex(index);
                      }}
                      title={option.label}
                      onClick={() => listbox.chooseIndex(index)}
                    >
                      <span>{option.label}</span>
                      {selected ? <Check size={15} aria-hidden="true" /> : null}
                    </Button>
                  );
                });
                return group.label ? (
                  <div
                    key={`${group.label}-${groupIndex}`}
                    role="group"
                    aria-labelledby={groupLabelId}
                  >
                    <div id={groupLabelId} className="custom-select-group-label">
                      {group.label}
                    </div>
                    {content}
                  </div>
                ) : (
                  <Fragment key={`ungrouped-${groupIndex}`}>{content}</Fragment>
                );
              })}
            </div>
            {loading || filteredOptions.length === 0 ? (
              <div className="custom-select-status" role="status">
                {loading ? "Loading…" : emptyMessage}
              </div>
            ) : null}
          </Popover>
        </PopoverPortal>
      ) : null}
    </div>
  );
}
