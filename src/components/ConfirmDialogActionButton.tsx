import { LoaderCircle } from "lucide-react";
import { forwardRef } from "react";
import type { ReactNode } from "react";
import Button, { type ButtonProps } from "./ui/Button";

type ConfirmDialogActionButtonProps = ButtonProps & {
  pending?: boolean;
  pendingLabel?: ReactNode;
};

/** A confirm-dialog action that stays mounted and visibly busy while async work runs. */
const ConfirmDialogActionButton = forwardRef<
  HTMLButtonElement,
  ConfirmDialogActionButtonProps
>(function ConfirmDialogActionButton(
  {
    pending = false,
    pendingLabel = "Working…",
    disabled,
    children,
    className,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <Button
      {...props}
      className={className}
      ref={ref}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending ? (
        <>
          <LoaderCircle className="confirm-dialog-action-spinner" size={14} aria-hidden="true" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
});

export default ConfirmDialogActionButton;
