import { useCallback, useState } from "react";
import type { ReactNode } from "react";

// A promise-based in-app confirmation, used in place of window.confirm (which is a
// no-op in the Tauri webview). A component renders the returned `dialog` and calls
// `confirm(...)`, awaiting the user's choice. Only one prompt is shown at a time;
// a new request supersedes any pending one (resolving it as cancelled).
interface ConfirmRequest {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface ConfirmState extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback((request: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      setState((current) => {
        current?.resolve(false);
        return { ...request, resolve };
      });
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    setState((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  const dialog = state ? (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          settle(false);
        }
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={state.message}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settle(false);
          }
        }}
      >
        <p>{state.message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" onClick={() => settle(false)}>
            {state.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" autoFocus onClick={() => settle(true)}>
            {state.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}
