import type { ReactNode } from "react";
import { classNames } from "./classNames";

export interface SegmentedControlOption<Value extends string> {
  value: Value;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<Value extends string> {
  /** Radio group name; native radios give arrow-key navigation for free. */
  name: string;
  value: Value;
  options: SegmentedControlOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export default function SegmentedControl<Value extends string>({
  name,
  value,
  options,
  onChange,
  disabled = false,
  className,
  ...ariaProps
}: SegmentedControlProps<Value>) {
  return (
    <div {...ariaProps} role="radiogroup" className={classNames("segmented-control", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        const optionDisabled = disabled || option.disabled;
        return (
          <label
            key={option.value}
            className={classNames(
              "segmented-control-option",
              selected && "is-selected",
              optionDisabled && "is-disabled",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              disabled={optionDisabled}
              onChange={() => onChange(option.value)}
            />
            {option.icon}
            <span>{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
