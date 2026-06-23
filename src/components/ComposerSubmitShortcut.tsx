import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function isComposerSubmitShortcut(
  event: ReactKeyboardEvent,
  requireCmdEnter: boolean,
) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) {
    return false;
  }
  if (requireCmdEnter) {
    return event.metaKey;
  }
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function composerSubmitShortcutAriaLabel(requireCmdEnter: boolean) {
  return requireCmdEnter ? "Command Enter" : "Enter";
}

export function ComposerSubmitShortcutGlyph({
  requireCmdEnter,
  className,
  ariaHidden = false,
}: {
  requireCmdEnter: boolean;
  className?: string;
  ariaHidden?: boolean;
}) {
  return (
    <span
      className={className}
      aria-hidden={ariaHidden ? "true" : undefined}
      aria-label={ariaHidden ? undefined : composerSubmitShortcutAriaLabel(requireCmdEnter)}
    >
      {requireCmdEnter ? "⌘" : null}
      <span className="enter-glyph" aria-hidden="true">
        ↵
      </span>
    </span>
  );
}
