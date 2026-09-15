import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type {
  FormHTMLAttributes,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";
import { createPortal } from "react-dom";
import { claimNativeTerminalPointerForWebDrag } from "../../lib/api";
import { classNames } from "./classNames";

interface DialogContextValue {
  onDismiss?: () => void;
  dismissDisabled: boolean;
}

const DialogContext = createContext<DialogContextValue | null>(null);
let inertModalCount = 0;
let appRootWasInert = false;
const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function assignRef<ElementType>(ref: Ref<ElementType> | undefined, value: ElementType | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function focusableElements(backdrop: HTMLElement): HTMLElement[] {
  return Array.from(backdrop.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

function useModalLifecycle(
  backdropRef: React.RefObject<HTMLDivElement | null>,
  onDismiss: (() => void) | undefined,
  dismissDisabled: boolean,
  inertAppRoot: boolean,
) {
  const restoreFocusRef = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const onDismissRef = useRef(onDismiss);
  const dismissDisabledRef = useRef(dismissDisabled);
  onDismissRef.current = onDismiss;
  dismissDisabledRef.current = dismissDisabled;

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const dialog = backdrop.querySelector<HTMLElement>("[role='dialog']");
    if (dialog && !dialog.contains(document.activeElement)) {
      const initial =
        dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
        focusableElements(dialog)[0] ??
        dialog;
      if (initial === dialog && !dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
      initial.focus();
    }

    const appRoot = inertAppRoot ? document.getElementById("root") : null;
    if (appRoot) {
      if (inertModalCount === 0) appRootWasInert = appRoot.inert;
      inertModalCount += 1;
      appRoot.inert = true;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !dismissDisabledRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(backdrop);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !backdrop.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (appRoot) {
        inertModalCount = Math.max(0, inertModalCount - 1);
        if (inertModalCount === 0) appRoot.inert = appRootWasInert;
      }
      const target = restoreFocusRef.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [backdropRef, inertAppRoot]);

  useEffect(() => claimNativeTerminalPointerForWebDrag(), []);
}

export interface DialogBackdropProps extends HTMLAttributes<HTMLDivElement> {
  onDismiss?: () => void;
  dismissDisabled?: boolean;
  inertAppRoot?: boolean;
}

export const DialogBackdrop = forwardRef<HTMLDivElement, DialogBackdropProps>(
  function DialogBackdrop(
    {
      onDismiss,
      dismissDisabled = false,
      inertAppRoot = false,
      className,
      onMouseDown,
      ...props
    },
    forwardedRef,
  ) {
    const backdropRef = useRef<HTMLDivElement | null>(null);
    useModalLifecycle(backdropRef, onDismiss, dismissDisabled, inertAppRoot);
    const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
      onMouseDown?.(event);
      if (!event.defaultPrevented && event.target === event.currentTarget && !dismissDisabled) {
        onDismiss?.();
      }
    };
    return (
      <DialogContext.Provider value={{ onDismiss, dismissDisabled }}>
        <div
          {...props}
          ref={(element) => {
            backdropRef.current = element;
            assignRef(forwardedRef, element);
          }}
          role="presentation"
          className={classNames("confirm-dialog-backdrop", className)}
          onMouseDown={handleMouseDown}
        />
      </DialogContext.Provider>
    );
  },
);

export interface DialogRootProps extends Omit<DialogBackdropProps, "inertAppRoot"> {
  open?: boolean;
  children: ReactNode;
  portalTarget?: Element | null;
  inertAppRoot?: boolean;
}

export function DialogRoot({
  open = true,
  children,
  portalTarget,
  inertAppRoot,
  ...props
}: DialogRootProps) {
  if (!open || typeof document === "undefined") return null;
  const target = portalTarget ?? document.body;
  return createPortal(
    <DialogBackdrop {...props} inertAppRoot={inertAppRoot ?? target === document.body}>
      {children}
    </DialogBackdrop>,
    target,
  );
}

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
  { onDismiss, dismissDisabled, className, onKeyDown, role = "dialog", ...props },
  ref,
) {
  const context = useContext(DialogContext);
  const dismiss = onDismiss ?? context?.onDismiss;
  const blocked = dismissDisabled ?? context?.dismissDisabled ?? false;
  return (
    <div
      {...props}
      ref={ref}
      role={role}
      aria-modal="true"
      className={classNames("confirm-dialog", className)}
      onKeyDown={(event) => handleDialogKeyDown(event, onKeyDown, dismiss, blocked)}
    />
  );
});

export interface DialogFormProps
  extends FormHTMLAttributes<HTMLFormElement>,
    SharedDialogProps {}

export const DialogForm = forwardRef<HTMLFormElement, DialogFormProps>(function DialogForm(
  { onDismiss, dismissDisabled, className, onKeyDown, role = "dialog", ...props },
  ref,
) {
  const context = useContext(DialogContext);
  const dismiss = onDismiss ?? context?.onDismiss;
  const blocked = dismissDisabled ?? context?.dismissDisabled ?? false;
  return (
    <form
      {...props}
      ref={ref}
      role={role}
      aria-modal="true"
      className={classNames("confirm-dialog", className)}
      onKeyDown={(event) => handleDialogKeyDown(event, onKeyDown, dismiss, blocked)}
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
