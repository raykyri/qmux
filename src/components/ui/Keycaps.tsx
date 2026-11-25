import { classNames } from "./classNames";

const MODIFIER_SYMBOLS: Record<string, string> = {
  Command: "⌘",
  Cmd: "⌘",
  CommandOrControl: "⌘",
  CmdOrCtrl: "⌘",
  Super: "⌘",
  Option: "⌥",
  Alt: "⌥",
  Shift: "⇧",
  Control: "⌃",
  Ctrl: "⌃",
};

/** Splits an accelerator such as "Option+Space" into display keys. */
export function acceleratorKeys(accelerator: string): string[] {
  const parts = accelerator.split("+");
  // Splitting "Command++" leaves two empty parts for the plus key.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts.splice(parts.length - 2, 2, "+");
  }
  return parts.filter(Boolean).map((part) => MODIFIER_SYMBOLS[part] ?? part);
}

export interface KeycapsProps {
  accelerator: string;
  className?: string;
}

/** Displays shortcut keys. Provide separate text for screen readers. */
export default function Keycaps({ accelerator, className }: KeycapsProps) {
  return (
    <span className={classNames("keycaps", className)} aria-hidden="true">
      {acceleratorKeys(accelerator).map((key, index) => (
        <kbd key={`${index}-${key}`} className="keycap">
          {key}
        </kbd>
      ))}
    </span>
  );
}
