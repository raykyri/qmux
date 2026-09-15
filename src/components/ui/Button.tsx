import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { classNames } from "./classNames";

export type ButtonVariant = "control" | "icon" | "link" | "menu" | "unstyled";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  compact?: boolean;
}

const variantClass: Record<ButtonVariant, string | undefined> = {
  control: "control-button",
  icon: "icon-button",
  link: "link-button",
  menu: "menu-item",
  unstyled: undefined,
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "control", compact = false, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classNames(variantClass[variant], compact && "menu-item--compact", className)}
    />
  );
});

export default Button;
