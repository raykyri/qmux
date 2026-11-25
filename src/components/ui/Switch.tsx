import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { classNames } from "./classNames";

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "type"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * A button with role="switch" for settings that apply immediately.
 * An associated label names it and toggles it when clicked. Space and Enter
 * also toggle it.
 */
const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, className, onClick, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={classNames("switch", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onChange(!checked);
        }
      }}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
});

export default Switch;
