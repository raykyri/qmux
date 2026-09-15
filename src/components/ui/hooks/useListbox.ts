import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface ListboxOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function firstEnabledIndex(options: ListboxOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

export function lastEnabledIndex(options: ListboxOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

export function nextEnabledIndex(
  options: ListboxOption[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;
  for (let step = 1; step <= options.length; step += 1) {
    const index = (currentIndex + direction * step + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

export function nextTypeaheadQuery(
  previousQuery: string,
  key: string,
  elapsedMs: number,
): string {
  if (elapsedMs > 500 || !previousQuery) return key;
  const normalizedKey = key.toLocaleLowerCase();
  const repeatsKey = Array.from(previousQuery).every(
    (character) => character.toLocaleLowerCase() === normalizedKey,
  );
  return repeatsKey ? key : `${previousQuery}${key}`;
}

export function typeaheadIndex(
  options: ListboxOption[],
  currentIndex: number,
  query: string,
): number {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return -1;
  for (let step = 1; step <= options.length; step += 1) {
    const index = (currentIndex + step + options.length) % options.length;
    const option = options[index];
    if (!option.disabled && option.label.toLocaleLowerCase().startsWith(normalized)) return index;
  }
  return -1;
}

interface UseListboxOptions<Option extends ListboxOption> {
  options: Option[];
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
}

export function useListbox<Option extends ListboxOption>({
  options,
  value,
  open,
  onOpenChange,
  onChange,
}: UseListboxOptions<Option>) {
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const initialIndex =
    selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : firstEnabledIndex(options);
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const typeaheadRef = useRef({ query: "", updatedAt: 0 });
  const optionSignature = useMemo(
    () => options.map((option) => `${option.value}:${option.disabled ? 1 : 0}`).join("\u0000"),
    [options],
  );
  const previousSignatureRef = useRef(optionSignature);
  const previousValueRef = useRef(value);

  useEffect(() => {
    if (!open) return;
    const reset =
      previousSignatureRef.current !== optionSignature || previousValueRef.current !== value;
    previousSignatureRef.current = optionSignature;
    previousValueRef.current = value;
    setActiveIndex((current) => {
      if (reset) return initialIndex;
      if (current >= 0 && current < options.length && !options[current].disabled) return current;
      return initialIndex;
    });
  }, [initialIndex, open, optionSignature, options, value]);

  const openListbox = () => {
    if (firstEnabledIndex(options) < 0) return;
    setActiveIndex(initialIndex);
    onOpenChange(true);
  };

  const closeListbox = () => onOpenChange(false);

  const chooseIndex = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    closeListbox();
    if (option.value !== value) onChange(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openListbox();
      } else {
        setActiveIndex((current) =>
          nextEnabledIndex(options, current, event.key === "ArrowDown" ? 1 : -1),
        );
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) openListbox();
      setActiveIndex(event.key === "Home" ? firstEnabledIndex(options) : lastEnabledIndex(options));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openListbox();
      else chooseIndex(activeIndex);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeListbox();
      return;
    }
    if (event.key === "Tab" && open) {
      closeListbox();
      return;
    }
    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const now = Date.now();
      const previous = typeaheadRef.current;
      const query = nextTypeaheadQuery(previous.query, event.key, now - previous.updatedAt);
      typeaheadRef.current = { query, updatedAt: now };
      const match = typeaheadIndex(options, activeIndex, query);
      if (match >= 0) {
        event.preventDefault();
        if (!open) onOpenChange(true);
        setActiveIndex(match);
      }
    }
  };

  return {
    activeIndex,
    activeOption: activeIndex >= 0 ? options[activeIndex] : undefined,
    chooseIndex,
    closeListbox,
    empty: firstEnabledIndex(options) < 0,
    handleKeyDown,
    openListbox,
    selectedIndex,
    selectedOption,
    setActiveIndex,
  };
}
