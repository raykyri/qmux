import { ArrowLeft, ArrowRight } from "lucide-react";
import DocumentDialog from "./DocumentDialog";

interface NewDocumentPaneProps {
  /** Kept mounted while hidden so a draft survives surface switches. */
  hidden?: boolean;
  initialMarkdown?: string;
  workspaceId: string | null;
  onClose: () => void;
  onCreate: (input: {
    markdown: string;
    title: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Full-pane composer for adding a pasted or imported Markdown document as a
 * root-level research item. Renders in the research surface with the standard
 * document header — history controls disabled, "New document" as the path —
 * and the composer form in the answer column of the response grid, leaving
 * the follow-up column empty. Workspace resolution remains this wrapper's
 * job; field behavior and validation are shared with document editing. */
export default function NewDocumentPane({
  hidden = false,
  initialMarkdown = "",
  workspaceId,
  onClose,
  onCreate,
  onDirtyChange,
}: NewDocumentPaneProps) {
  return (
    <div className="research-workspace" hidden={hidden}>
      <main className="research-document">
        <header className="research-document-header">
          <div className="research-history-nav" aria-label="Research history">
            <button
              type="button"
              className="control-button research-history-button"
              disabled
              aria-label="Back"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="control-button research-history-button"
              disabled
              aria-label="Forward"
            >
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="research-breadcrumb" aria-label="Research path">
            <span>
              <button className="control-button" type="button" disabled>
                New document
              </button>
            </span>
          </div>
        </header>
        <article className="research-document-scroll">
          <div className="research-document-content">
            <div className="research-response-grid">
              <section className="research-response" aria-label="New document">
                <DocumentDialog
                  open
                  mode="create"
                  variant="page"
                  initialMarkdown={initialMarkdown}
                  resetKey={initialMarkdown}
                  onClose={onClose}
                  onDirtyChange={onDirtyChange}
                  onSubmit={({ markdown, title }) =>
                    onCreate({ markdown, title, workspaceId })
                  }
                />
              </section>
            </div>
          </div>
        </article>
      </main>
    </div>
  );
}
