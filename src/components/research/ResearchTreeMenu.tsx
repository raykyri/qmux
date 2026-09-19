import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  FolderMinus,
  FolderPlus,
  Pencil,
  RefreshCw,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import type { ResearchTreeSummary } from "../../types";
import { isResearchStarred, type ResearchFolderState } from "../../lib/researchFolders";
import {
  Button,
  Dialog,
  DialogActions,
  DialogForm,
  DialogRoot,
  DialogTitle,
  Input,
  MenuItem,
} from "../ui";

/** Width the anchored popover reserves for this menu. */
export const RESEARCH_TREE_MENU_WIDTH = 190;

/** The per-thread action list. The sidebar and the Home feed both render it
 * inside their own menu surface, so a thread offers the same actions wherever
 * it is shown. Each item closes the menu before running its handler. */
export function ResearchTreeMenuItems({
  tree,
  archived,
  folderState,
  onClose,
  onToggleStar,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  onRemoveFromFolder,
  onRequestCreateFolder,
  onRegenerateTitle,
  onRegenerateSummary,
}: {
  tree: ResearchTreeSummary;
  archived: boolean;
  folderState: ResearchFolderState;
  onClose: () => void;
  onToggleStar: (treeId: string) => void;
  onRename: (tree: ResearchTreeSummary) => void;
  onArchive: (treeId: string) => void;
  onRestore: (treeId: string) => void;
  onDelete: (tree: ResearchTreeSummary) => void;
  onRemoveFromFolder: (treeIds: string[]) => void;
  onRequestCreateFolder: (treeIds: string[]) => void;
  /** Only run roots have a selected research model. Documents and exported
   * conversations keep their content-derived titles. */
  onRegenerateTitle?: (treeId: string) => void;
  /** Query-specific action used by Home's research activity menu. */
  onRegenerateSummary?: () => void;
}) {
  const starred = isResearchStarred(folderState, tree.id);
  const inFolder = Boolean(folderState.membership[tree.id]);
  const running = tree.runningCount > 0;
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div className="group-context-actions">
      {onRegenerateSummary ? (
        <>
          <MenuItem onClick={run(onRegenerateSummary)}>
            <RefreshCw size={13} aria-hidden="true" />
            <span>Generate summary</span>
          </MenuItem>
          <div className="context-menu-divider" role="separator" />
        </>
      ) : null}
      {archived ? (
        <MenuItem onClick={run(() => onRestore(tree.id))}>
          <ArchiveRestore size={13} aria-hidden="true" />
          <span>Unarchive research</span>
        </MenuItem>
      ) : (
        <>
          <MenuItem onClick={run(() => onToggleStar(tree.id))}>
            {starred ? (
              <StarOff size={13} aria-hidden="true" />
            ) : (
              <Star size={13} aria-hidden="true" />
            )}
            <span>{starred ? "Unstar" : "Star"}</span>
          </MenuItem>
          <MenuItem onClick={run(() => onRename(tree))}>
            <Pencil size={13} aria-hidden="true" />
            <span>Rename</span>
          </MenuItem>
          {onRegenerateTitle && tree.kind === "run" ? (
            <MenuItem onClick={run(() => onRegenerateTitle(tree.id))}>
              <RefreshCw size={13} aria-hidden="true" />
              <span>Regenerate title</span>
            </MenuItem>
          ) : null}
          {inFolder ? (
            <MenuItem onClick={run(() => onRemoveFromFolder([tree.id]))}>
              <FolderMinus size={13} aria-hidden="true" />
              <span>Remove from folder</span>
            </MenuItem>
          ) : null}
          <MenuItem onClick={run(() => onRequestCreateFolder([tree.id]))}>
            <FolderPlus size={13} aria-hidden="true" />
            <span>New folder with item</span>
          </MenuItem>
        </>
      )}
      {!archived ? (
        <>
          <div className="context-menu-divider" role="separator" />
          <MenuItem
            className="context-menu-has-shortcut"
            disabled={running}
            title={running ? "Research with active runs cannot be archived" : undefined}
            onClick={run(() => onArchive(tree.id))}
          >
            <Archive size={13} aria-hidden="true" />
            <span>Archive</span>
            <kbd className="context-menu-shortcut is-keycap">A</kbd>
          </MenuItem>
        </>
      ) : null}
      <MenuItem
        tone="danger"
        className="context-menu-danger context-menu-has-shortcut"
        disabled={running}
        title={running ? "Research with active runs cannot be deleted" : undefined}
        onClick={run(() => onDelete(tree))}
      >
        <Trash2 size={13} aria-hidden="true" />
        <span>Delete</span>
        <kbd className="context-menu-shortcut is-keycap">D</kbd>
      </MenuItem>
    </div>
  );
}

/** Rename one research thread. Escape, backdrop dismissal and focus
 * restoration come from the shared dialog primitives. */
export function ResearchTreeRenameDialog({
  tree,
  onClose,
  onRename,
}: {
  tree: ResearchTreeSummary;
  onClose: () => void;
  onRename: (treeId: string, title: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(tree.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const trimmed = draft.trim();
  return (
    <DialogRoot onDismiss={onClose}>
      <DialogForm
        className="rename-dialog"
        aria-labelledby="rename-research-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || trimmed === tree.title) {
            onClose();
            return;
          }
          void onRename(tree.id, trimmed);
          onClose();
        }}
      >
        <DialogTitle id="rename-research-dialog-title">Rename research</DialogTitle>
        <Input
          ref={inputRef}
          className="rename-dialog-input"
          value={draft}
          aria-label="Research title"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit">Rename</Button>
        </DialogActions>
      </DialogForm>
    </DialogRoot>
  );
}

/** Confirm deleting one research thread. Stays open and reports the failure
 * when the command rejects, so the thread is never silently kept. */
export function ResearchTreeDeleteDialog({
  tree,
  onClose,
  onRemove,
}: {
  tree: ResearchTreeSummary;
  onClose: () => void;
  onRemove: (treeId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogRoot onDismiss={onClose} dismissDisabled={busy}>
      <Dialog aria-labelledby="delete-research-dialog-title" aria-busy={busy}>
        <DialogTitle id="delete-research-dialog-title">Delete “{tree.title}”?</DialogTitle>
        <p>
          This permanently deletes this research and its completed work and follow-up history.
          This can’t be undone.
        </p>
        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <DialogActions>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="danger"
            autoFocus
            disabled={busy}
            onClick={() => {
              if (busy) {
                return;
              }
              setError(null);
              setBusy(true);
              void onRemove(tree.id)
                .then(() => {
                  onClose();
                })
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {busy ? "Deleting…" : "Delete research"}
          </Button>
        </DialogActions>
      </Dialog>
    </DialogRoot>
  );
}
