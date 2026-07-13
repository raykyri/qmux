import { useEffect, useMemo, useState } from "react";
import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
} from "../../lib/researchDocuments";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../ComposerSubmitShortcut";

interface NewDocumentDialogProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
  onCreate: (input: {
    markdown: string;
    title: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
}

/** Composer for adding a pasted-markdown document as a root-level research
 * item. Unlike the prompt launcher, Escape and backdrop clicks only dismiss
 * while the composer is empty — a pasted document must survive a stray
 * click — and Enter always inserts a newline, so submit is Cmd+Enter or the
 * explicit button. */
export default function NewDocumentDialog({
  open,
  workspaceId,
  onClose,
  onCreate,
}: NewDocumentDialogProps) {
  const [markdown, setMarkdown] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Shown inside the dialog, like the research launcher: the global banner
  // renders behind the modal backdrop. Fields are kept for the retry.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setMarkdown("");
    setTitle("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  // Memoized on the body: these walk the whole document (up to hundreds of
  // KB), and without the memo every title-field keystroke re-scanned it.
  const { wordCount, byteCount, derivedTitle } = useMemo(
    () => ({
      wordCount: countResearchDocumentWords(markdown),
      byteCount: new TextEncoder().encode(markdown).length,
      derivedTitle: markdown.trim() ? deriveResearchDocumentTitle(markdown) : "",
    }),
    [markdown],
  );

  if (!open) {
    return null;
  }

  const overWordLimit = wordCount > RESEARCH_DOCUMENT_WORD_LIMIT;
  const overByteLimit = byteCount > RESEARCH_DOCUMENT_BYTE_LIMIT;
  const pristine = !markdown.trim() && !title.trim();
  const canSubmit = Boolean(markdown.trim()) && !overWordLimit && !overByteLimit && !submitting;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        markdown,
        title: title.trim() || null,
        workspaceId,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="confirm-dialog-backdrop new-document-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && pristine && !submitting) {
          onClose();
        }
      }}
    >
      <form
        className="new-document-composer"
        role="dialog"
        aria-modal
        aria-label="New document"
        onKeyDown={(event) => {
          if (event.key === "Escape" && pristine && !submitting) {
            onClose();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>New document</h2>
        <input
          className="new-document-title"
          type="text"
          value={title}
          placeholder={derivedTitle || "Title (uses the first line if left blank)"}
          aria-label="Document title"
          onChange={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Block the browser's implicit form submission: creating the
            // document is deliberate (Cmd+Enter or the button), never a side
            // effect of pressing Enter while editing the title.
            if (event.key === "Enter" && !isComposerSubmitShortcut(event, true)) {
              event.preventDefault();
            }
          }}
        />
        <textarea
          autoFocus
          className="new-document-markdown"
          value={markdown}
          placeholder="Paste or write Markdown…"
          aria-label="Document markdown"
          onChange={(event) => setMarkdown(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (isComposerSubmitShortcut(event, true)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <footer className="new-document-footer">
          <span
            className={`new-document-wordcount${overWordLimit || overByteLimit ? " is-over" : ""}`}
            role={overWordLimit || overByteLimit ? "alert" : undefined}
            title={
              overWordLimit
                ? `Documents are limited to ${RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()} words for now`
                : undefined
            }
          >
            {wordCount.toLocaleString()} / {RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()} words
            {overByteLimit ? " · over the 2 MB size limit" : ""}
          </span>
          {error ? (
            <p className="new-document-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="confirm-dialog-actions">
            <button type="button" disabled={submitting} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit}>
              <span>{submitting ? "Adding…" : "Add document"}</span>
              {!submitting ? (
                <ComposerSubmitShortcutGlyph requireCmdEnter className="shortcut-hint" />
              ) : null}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
