import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function isComposerSubmitShortcut(
  event: ReactKeyboardEvent,
  codeMode: boolean,
) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) {
    return false;
  }
  if (codeMode) {
    return event.metaKey;
  }
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function composerSubmitShortcutAriaLabel(codeMode: boolean) {
  return codeMode ? "Command Enter" : "Enter";
}

export function ComposerSubmitShortcutGlyph({
  codeMode,
  className,
  ariaHidden = false,
}: {
  codeMode: boolean;
  className?: string;
  ariaHidden?: boolean;
}) {
  return (
    <span
      className={className}
      aria-hidden={ariaHidden ? "true" : undefined}
      aria-label={ariaHidden ? undefined : composerSubmitShortcutAriaLabel(codeMode)}
    >
      {codeMode ? "⌘" : null}
      <span className="enter-glyph" aria-hidden="true">
        ↵
      </span>
    </span>
  );
}
