import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent } from "react";
import Button, { type ButtonTone } from "./Button";
import { classNames } from "./classNames";
import { Popover } from "./Popover";
import { nextTypeaheadQuery } from "./hooks/useListbox";

export interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  surface?: "default" | "context";
  autoFocusFirst?: boolean;
}

export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu(
  {
    surface = "context",
    autoFocusFirst = true,
    className,
    role = "menu",
    onKeyDown,
    ...props
  },
  ref,
) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const typeaheadRef = useRef({ query: "", updatedAt: 0 });
  useImperativeHandle(ref, () => menuRef.current as HTMLDivElement);
  useLayoutEffect(() => {
    if (!autoFocusFirst) return;
    menuRef.current
      ?.querySelector<HTMLElement>(
        "[role^='menuitem']:not([disabled]):not([aria-disabled='true'])",
      )
      ?.focus();
  }, [autoFocusFirst]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "[role^='menuitem']:not([disabled]):not([aria-disabled='true'])",
      ),
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex = -1;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1 + items.length) % items.length;
    else if (event.key === "ArrowUp") {
      nextIndex =
        currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const now = Date.now();
      const previous = typeaheadRef.current;
      const query = nextTypeaheadQuery(previous.query, event.key, now - previous.updatedAt);
      typeaheadRef.current = { query, updatedAt: now };
      const normalized = query.toLocaleLowerCase();
      for (let step = 1; step <= items.length; step += 1) {
        const index = (currentIndex + step + items.length) % items.length;
        if ((items[index].textContent ?? "").trim().toLocaleLowerCase().startsWith(normalized)) {
          nextIndex = index;
          break;
        }
      }
    }
    if (nextIndex >= 0) {
      event.preventDefault();
      items[nextIndex].focus();
    }
  };
  return (
    <Popover
      {...props}
      ref={menuRef}
      surface={surface}
      role={role}
      className={className}
      onKeyDown={handleKeyDown}
    />
  );
});

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  compact?: boolean;
  selected?: boolean;
  tone?: Extract<ButtonTone, "neutral" | "danger">;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  {
    compact = false,
    selected = false,
    tone = "neutral",
    className,
    role = "menuitem",
    tabIndex = -1,
    ...props
  },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant="menu"
      size={compact ? "compact" : "md"}
      tone={tone}
      role={role}
      tabIndex={tabIndex}
      aria-current={selected || undefined}
      className={classNames(selected && "is-selected", className)}
    />
  );
});
