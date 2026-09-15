import { forwardRef, useEffect, useRef } from "react";
import type {
  FormHTMLAttributes,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
} from "react";
import { classNames } from "./classNames";

export interface DialogBackdropProps extends HTMLAttributes<HTMLDivElement> {
  onDismiss?: () => void;
  dismissDisabled?: boolean;
}

export const DialogBackdrop = forwardRef<HTMLDivElement, DialogBackdropProps>(
  function DialogBackdrop(
    { onDismiss, dismissDisabled = false, className, onMouseDown, ...props },
    ref,
  ) {
    const restoreFocusRef = useRef<Element | null>(
      typeof document === "undefined" ? null : document.activeElement,
    );
    useEffect(
      () => () => {
        const target = restoreFocusRef.current;
        if (target instanceof HTMLElement && target.isConnected) target.focus();
      },
      [],
    );
    const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
      onMouseDown?.(event);
      if (
        !event.defaultPrevented &&
        event.target === event.currentTarget &&
        !dismissDisabled
      ) {
        onDismiss?.();
      }
    };
    return (
      <div
        {...props}
        ref={ref}
        role="presentation"
        className={classNames("confirm-dialog-backdrop", className)}
        onMouseDown={handleMouseDown}
      />
    );
  },
);

interface SharedDialogProps {
  onDismiss?: () => void;
  dismissDisabled?: boolean;
}

function handleDialogKeyDown<ElementType extends HTMLElement>(
  event: KeyboardEvent<ElementType>,
  onKeyDown: ((event: KeyboardEvent<ElementType>) => void) | undefined,
  onDismiss: (() => void) | undefined,
  dismissDisabled: boolean,
) {
  onKeyDown?.(event);
  if (!event.defaultPrevented && event.key === "Escape" && !dismissDisabled) {
    event.preventDefault();
    event.stopPropagation();
    onDismiss?.();
  }
}

export interface DialogProps extends HTMLAttributes<HTMLDivElement>, SharedDialogProps {}

export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog(
  { onDismiss, dismissDisabled = false, className, onKeyDown, role = "dialog", ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      role={role}
      aria-modal="true"
      className={classNames("confirm-dialog", className)}
      onKeyDown={(event) =>
        handleDialogKeyDown(event, onKeyDown, onDismiss, dismissDisabled)
      }
    />
  );
});

export interface DialogFormProps
  extends FormHTMLAttributes<HTMLFormElement>,
    SharedDialogProps {}

export const DialogForm = forwardRef<HTMLFormElement, DialogFormProps>(function DialogForm(
  { onDismiss, dismissDisabled = false, className, onKeyDown, role = "dialog", ...props },
  ref,
) {
  return (
    <form
      {...props}
      ref={ref}
      role={role}
      aria-modal="true"
      className={classNames("confirm-dialog", className)}
      onKeyDown={(event) =>
        handleDialogKeyDown(event, onKeyDown, onDismiss, dismissDisabled)
      }
    />
  );
});

export const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function DialogTitle({ className, ...props }, ref) {
    return <h2 {...props} ref={ref} className={className} />;
  },
);

export const DialogActions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogActions({ className, ...props }, ref) {
    return <div {...props} ref={ref} className={classNames("confirm-dialog-actions", className)} />;
  },
);
