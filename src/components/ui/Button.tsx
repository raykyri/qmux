import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { classNames } from "./classNames";

export type ButtonTone = "neutral" | "primary" | "danger";
export type ButtonVariant = "control" | "icon" | "link" | "menu" | "unstyled";

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  className?: string;
};

type ControlButtonProps = NativeButtonProps & {
  variant?: "control";
  tone?: ButtonTone;
  size?: "sm" | "md";
};

type IconButtonProps = NativeButtonProps & {
  variant: "icon";
  tone?: "neutral" | "danger";
  size?: "sm" | "md";
};

type LinkButtonProps = NativeButtonProps & {
  variant: "link";
  tone?: "neutral" | "danger";
  size?: "md";
};

type MenuButtonProps = NativeButtonProps & {
  variant: "menu";
  tone?: "neutral" | "danger";
  size?: "compact" | "md";
};

type UnstyledButtonProps = NativeButtonProps & {
  variant: "unstyled";
  tone?: never;
  size?: never;
};

export type ButtonProps =
  | ControlButtonProps
  | IconButtonProps
  | LinkButtonProps
  | MenuButtonProps
  | UnstyledButtonProps;

const variantClass: Record<ButtonVariant, string | undefined> = {
  control: "control-button",
  icon: "icon-button",
  link: "link-button",
  menu: "menu-item",
  unstyled: undefined,
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const {
    variant = "control",
    tone = "neutral",
    size = "md",
    className,
    type = "button",
    ...nativeProps
  } = props;
  const toneClass =
    tone === "primary"
      ? "is-primary"
      : tone === "danger"
        ? variant === "menu"
          ? "is-danger"
          : "danger"
        : undefined;
  return (
    <button
      {...nativeProps}
      ref={ref}
      type={type}
      className={classNames(
        variantClass[variant],
        size === "compact" && "menu-item--compact",
        size === "sm" && `${variantClass[variant]}--sm`,
        toneClass,
        className,
      )}
    />
  );
});

export default Button;
