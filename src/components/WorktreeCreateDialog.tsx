import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  Button,
  DialogActions,
  DialogForm,
  DialogRoot,
  DialogTitle,
  Input,
  Select,
} from "./ui";
import ConfirmDialogActionButton from "./ConfirmDialogActionButton";
import { repositoryWorktreeName } from "../lib/appHelpers";
import type { WorktreeCreateDialogState } from "./repositoryDialogs.types";

type Props = {
  worktreeCreateDialog: WorktreeCreateDialogState;
  setWorktreeCreateDialog: Dispatch<
    SetStateAction<WorktreeCreateDialogState | null>
  >;
  dismissWorktreeCreateDialog: (created: boolean) => void;
  createWorktreeFromDialog: () => Promise<void>;
  worktreeNameInputRef: RefObject<HTMLInputElement | null>;
};

export default function WorktreeCreateDialog({
  worktreeCreateDialog,
  setWorktreeCreateDialog,
  dismissWorktreeCreateDialog,
  createWorktreeFromDialog,
  worktreeNameInputRef,
}: Props) {
  return (
    <DialogRoot
      onDismiss={() => dismissWorktreeCreateDialog(false)}
      dismissDisabled={worktreeCreateDialog.creating}
    >
      <DialogForm
        className="rename-dialog"
        aria-labelledby="create-worktree-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          void createWorktreeFromDialog();
        }}
      >
        <DialogTitle id="create-worktree-dialog-title">
          {worktreeCreateDialog.action.kind === "fork"
            ? "Fork session in worktree"
            : "Open worktree"}
        </DialogTitle>
        {worktreeCreateDialog.action.kind === "open" ? (
          <>
            <label
              className="confirm-dialog-field-label"
              htmlFor="create-worktree-start"
            >
              Start at commit
            </label>
            <Select
              id="create-worktree-start"
              className="create-worktree-start-select"
              searchable
              searchPlaceholder="Search branches…"
              emptyMessage="No matching branches"
              loading={worktreeCreateDialog.inventoryLoading}
              value={worktreeCreateDialog.startRef ?? ""}
              disabled={worktreeCreateDialog.creating}
              options={[
                { value: "", label: "Current commit (new branch)" },
                ...(worktreeCreateDialog.inventory?.branches
                  .filter((branch) => !branch.remote)
                  .map((branch) => ({
                    value: branch.fullRef,
                    label: `${branch.name}${branch.checkedOutPath ? " — checked out" : ""}`,
                    group: "Local branches",
                  })) ?? []),
                ...(worktreeCreateDialog.inventory?.branches
                  .filter((branch) => branch.remote)
                  .map((branch) => ({
                    value: branch.fullRef,
                    label: branch.name,
                    group: "Remote branches",
                  })) ?? []),
              ]}
              onChange={(nextValue) => {
                const startRef = nextValue || null;
                setWorktreeCreateDialog((current) => {
                  if (!current) return current;
                  const branch = startRef
                    ? current.inventory?.branches.find(
                        (candidate) => candidate.fullRef === startRef,
                      )
                    : undefined;
                  return {
                    ...current,
                    startRef,
                    name: branch
                      ? repositoryWorktreeName(branch)
                      : current.suggestedName,
                    error: null,
                  };
                });
              }}
            />
            {worktreeCreateDialog.inventoryError ? (
              <p className="confirm-dialog-error" role="alert">
                Could not load branches: {worktreeCreateDialog.inventoryError}
              </p>
            ) : null}
          </>
        ) : null}
        <label
          className="confirm-dialog-field-label"
          htmlFor="create-worktree-name"
        >
          New worktree name
        </label>
        <Input
          ref={worktreeNameInputRef}
          id="create-worktree-name"
          className="rename-dialog-input"
          value={worktreeCreateDialog.name}
          disabled={worktreeCreateDialog.creating}
          spellCheck={false}
          maxLength={240}
          onChange={(event) => {
            const name = event.currentTarget.value;
            setWorktreeCreateDialog((current) =>
              current ? { ...current, name, error: null } : current,
            );
          }}
          aria-describedby="create-worktree-name-hint"
        />
        <p id="create-worktree-name-hint" className="rename-dialog-hint">
          Also used as the directory name. Letters, numbers, hyphens, or underscores only.
        </p>
        {worktreeCreateDialog.error ? (
          <p className="confirm-dialog-error" role="alert">
            {worktreeCreateDialog.error}
          </p>
        ) : null}
        <DialogActions>
          <Button
            disabled={worktreeCreateDialog.creating}
            onClick={() => dismissWorktreeCreateDialog(false)}
          >
            Cancel
          </Button>
          <ConfirmDialogActionButton
            type="submit"
            disabled={
              !worktreeCreateDialog.name.trim() || worktreeCreateDialog.creating
            }
            pending={worktreeCreateDialog.creating}
            pendingLabel={
              worktreeCreateDialog.action.kind === "fork"
                ? "Creating…"
                : "Opening…"
            }
          >
            {worktreeCreateDialog.action.kind === "fork"
              ? "Fork session"
              : "Open worktree"}
          </ConfirmDialogActionButton>
        </DialogActions>
      </DialogForm>
    </DialogRoot>
  );
}
