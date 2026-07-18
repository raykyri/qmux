import { useEffect, useState } from "react";
import type { GroupInfo } from "../../types";

// Confirmation for "Export to Research": pick the destination Research
// folder, optionally name the tree, and state plainly what the export does —
// it copies the conversation (the pane keeps running), the copy excludes tool
// input/output, and the result can later be published, so this is the moment
// to think about anything sensitive on the transcript.
interface ExportToResearchDialogProps {
  paneTitle: string;
  folders: GroupInfo[];
  /** The research folder currently scoped in the sidebar, preferred as the
   * destination so the export lands where the user is looking. */
  defaultFolderId: string | null;
  onClose: () => void;
  onExport: (input: { workspaceId: string | null; title: string | null }) => Promise<void>;
}

export default function ExportToResearchDialog({
  paneTitle,
  folders,
  defaultFolderId,
  onClose,
  onExport,
}: ExportToResearchDialogProps) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    (defaultFolderId && folders.some((folder) => folder.id === defaultFolderId)
      ? defaultFolderId
      : null) ??
      folders[0]?.id ??
      null,
  );
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Shown inside the dialog: a global banner renders behind the modal
  // backdrop. Fields are kept for the retry.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWorkspaceId((current) =>
      current && folders.some((folder) => folder.id === current)
        ? current
        : (folders[0]?.id ?? null),
    );
  }, [folders]);

  async function submit() {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onExport({ workspaceId, title: title.trim() || null });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <form
        className="confirm-dialog export-research-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Export ${paneTitle} to Research`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !submitting) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>
          Export <strong>{paneTitle}</strong> to Research
        </p>
        <p className="export-research-note">
          Copies the conversation so far into a read-only research item — the
          terminal keeps running. Tool input and output are left out, and the
          copy can later be published, so review it for anything sensitive
          before sharing.
        </p>
        {folders.length > 1 ? (
          <label className="export-research-field">
            <span>Research folder</span>
            <select
              value={workspaceId ?? ""}
              aria-label="Research folder"
              onChange={(event) => setWorkspaceId(event.currentTarget.value || null)}
            >
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="export-research-field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            autoFocus
            placeholder="Optional — defaults to the first prompt"
            aria-label="Research title"
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        {error ? (
          <p className="export-research-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button
            className="control-button"
            type="button"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="control-button" type="submit" disabled={submitting}>
            {submitting ? "Exporting…" : "Export"}
          </button>
        </div>
      </form>
    </div>
  );
}
