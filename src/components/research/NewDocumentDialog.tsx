import DocumentDialog from "./DocumentDialog";

interface NewDocumentDialogProps {
  open: boolean;
  initialMarkdown?: string;
  workspaceId: string | null;
  onClose: () => void;
  onCreate: (input: {
    markdown: string;
    title: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
}

/** Composer for adding a pasted or imported Markdown document as a root-level
 * research item. Workspace resolution remains the new-document wrapper's job;
 * field behavior and validation are shared with document editing. */
export default function NewDocumentDialog({
  open,
  initialMarkdown = "",
  workspaceId,
  onClose,
  onCreate,
}: NewDocumentDialogProps) {
  return (
    <DocumentDialog
      open={open}
      mode="create"
      initialMarkdown={initialMarkdown}
      resetKey={initialMarkdown}
      onClose={onClose}
      onSubmit={({ markdown, title }) => onCreate({ markdown, title, workspaceId })}
    />
  );
}
