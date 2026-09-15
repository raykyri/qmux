import { forwardRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import Button from "./Button";
import { classNames } from "./classNames";
import { Popover } from "./Popover";

export interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  surface?: "default" | "context";
}

export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu(
  { surface = "context", className, role = "menu", ...props },
  ref,
) {
  return <Popover {...props} ref={ref} surface={surface} role={role} className={className} />;
});

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  compact?: boolean;
  selected?: boolean;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { compact = false, selected = false, className, ...props },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant="menu"
      compact={compact}
      className={classNames(selected && "is-selected", className)}
    />
  );
});
