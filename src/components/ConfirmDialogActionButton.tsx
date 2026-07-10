import { LoaderCircle } from "lucide-react";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ConfirmDialogActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  pending?: boolean;
  pendingLabel?: ReactNode;
}

/** A confirm-dialog action that stays mounted and visibly busy while async work runs. */
const ConfirmDialogActionButton = forwardRef<
  HTMLButtonElement,
  ConfirmDialogActionButtonProps
>(function ConfirmDialogActionButton(
  { pending = false, pendingLabel = "Working…", disabled, children, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? "button"}
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
    </button>
  );
});

export default ConfirmDialogActionButton;
