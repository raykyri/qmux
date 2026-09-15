import { forwardRef } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import { classNames } from "./classNames";

export interface PopoverProps extends HTMLAttributes<HTMLDivElement> {
  surface?: "default" | "context";
}

export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  { surface = "default", className, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={classNames(
        "popover-surface",
        surface === "context" && "popover-surface--context",
        className,
      )}
    />
  );
});

export function PopoverPortal({
  children,
  target,
}: {
  children: ReactNode;
  target?: Element | null;
}) {
  return typeof document === "undefined" ? null : createPortal(children, target ?? document.body);
}
