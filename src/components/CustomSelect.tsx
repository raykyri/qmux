import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface CustomSelectOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

interface CustomSelectProps {
  id?: string;
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

interface PopoverPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export default function CustomSelect({
  id,
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}: CustomSelectProps) {
  const generatedId = useId();
  const triggerId = id ?? `custom-select-${generatedId}`;
  const listboxId = `${triggerId}-options`;
  const [open, setOpen] = useState(false);
  const [highlightedValue, setHighlightedValue] = useState(value);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const enabledOptions = options.filter((option) => !option.disabled);

  const measure = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 6;
    const viewportGap = 8;
    const popoverHeight = popoverRef.current?.offsetHeight ?? 280;
    const spaceBelow = window.innerHeight - rect.bottom - viewportGap - gap;
    const spaceAbove = rect.top - viewportGap - gap;
    const openAbove = spaceBelow < Math.min(popoverHeight, 160) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(96, openAbove ? spaceAbove : spaceBelow);
    setPosition({
      left: Math.max(viewportGap, Math.min(rect.left, window.innerWidth - rect.width - viewportGap)),
      top: openAbove
        ? Math.max(viewportGap, rect.top - gap - Math.min(popoverHeight, maxHeight))
        : rect.bottom + gap,
      width: rect.width,
      maxHeight,
    });
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const show = () => {
    if (disabled || enabledOptions.length === 0) return;
    setHighlightedValue(
      enabledOptions.some((option) => option.value === value) ? value : enabledOptions[0].value,
    );
    measure();
    setOpen(true);
  };

  const moveHighlight = (direction: 1 | -1) => {
    if (enabledOptions.length === 0) return;
    const currentIndex = enabledOptions.findIndex((option) => option.value === highlightedValue);
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : enabledOptions.length - 1
        : (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
    setHighlightedValue(enabledOptions[nextIndex].value);
  };

  const choose = (nextValue: string) => {
    close(true);
    if (nextValue !== value) onChange(nextValue);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show();
      else moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!open || enabledOptions.length === 0) return;
      event.preventDefault();
      setHighlightedValue(
        enabledOptions[event.key === "Home" ? 0 : enabledOptions.length - 1].value,
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) show();
      else if (enabledOptions.some((option) => option.value === highlightedValue)) {
        choose(highlightedValue);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    const handleWindowChange = () => measure();
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  const groups = options.reduce<Array<{ label?: string; options: CustomSelectOption[] }>>(
    (result, option) => {
      const current = result[result.length - 1];
      if (!current || current.label !== option.group) {
        result.push({ label: option.group, options: [option] });
      } else {
        current.options.push(option);
      }
      return result;
    },
    [],
  );
  const classes = ["custom-select", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="custom-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-${highlightedValue}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={handleKeyDown}
      >
        <span className="custom-select-value">{selected?.label}</span>
        <ChevronDown className="custom-select-chevron" size={16} aria-hidden="true" />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popoverRef}
              id={listboxId}
              className="popover-surface custom-select-popover"
              role="listbox"
              aria-label={ariaLabel}
              style={position}
            >
              {groups.map((group, groupIndex) => {
                const groupLabelId = `${listboxId}-group-${groupIndex}`;
                const content = group.options.map((option) => {
                  const selectedOption = option.value === value;
                  const highlighted = option.value === highlightedValue;
                  return (
                    <button
                      key={option.value}
                      id={`${listboxId}-${option.value}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={selectedOption}
                      disabled={option.disabled}
                      className={`menu-item custom-select-option${highlighted ? " is-highlighted" : ""}`}
                      onMouseEnter={() => {
                        if (!option.disabled) setHighlightedValue(option.value);
                      }}
                      onClick={() => choose(option.value)}
                    >
                      <span>{option.label}</span>
                      {selectedOption ? <Check size={15} aria-hidden="true" /> : null}
                    </button>
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
