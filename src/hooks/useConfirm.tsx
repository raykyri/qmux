import { useCallback, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { claimNativeTerminalPointerForWebDrag } from "../lib/api";
import { Button, Dialog, DialogActions, DialogRoot } from "../components/ui";

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

  const open = state !== null;
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    // This hook is used by component-local dialogs that App cannot include in
    // nativeTerminalInputBlocked. Their fixed backdrop can cover a Ghostty
    // surface, whose native event monitor otherwise consumes mouseup before
    // the DOM button can produce a click. Own the full pointer gesture for the
    // lifetime of the modal; the claim is reference-counted with every other
    // web overlay and releases when the confirmation settles.
    return claimNativeTerminalPointerForWebDrag();
  }, [open]);

  const dialog = state ? (
    <DialogRoot onDismiss={() => settle(false)}>
      <Dialog aria-label={state.message}>
        <p>{state.message}</p>
        <DialogActions>
          <Button onClick={() => settle(false)}>{state.cancelLabel ?? "Cancel"}</Button>
          <Button autoFocus onClick={() => settle(true)}>
            {state.confirmLabel ?? "OK"}
          </Button>
        </DialogActions>
      </Dialog>
    </DialogRoot>
  ) : null;

  return { confirm, dialog };
}
