import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Check, Pencil, Trash2 } from "lucide-react";
import type { ResearchTreeSummary } from "../../types";

interface ResearchSidebarSectionProps {
  trees: ResearchTreeSummary[];
  archivedTrees: ResearchTreeSummary[];
  activeTreeId: string | null;
  onSelect: (treeId: string) => void;
  onRename: (treeId: string, title: string) => Promise<void>;
  onArchive: (treeId: string) => Promise<void>;
  onRestore: (treeId: string) => Promise<void>;
  onRemove: (treeId: string) => Promise<void>;
}

function followupCount(tree: ResearchTreeSummary) {
  const nodeCount =
    tree.runningCount + tree.failedCount + tree.completedCount + tree.cancelledCount;
  return Math.max(0, nodeCount - 1);
}

function FollowupHint({ tree }: { tree: ResearchTreeSummary }) {
  const count = followupCount(tree);
  return (
    <span className="research-sidebar-followups">
      {count} {count === 1 ? "follow-up" : "follow-ups"}
    </span>
  );
}

export default function ResearchSidebarSection({
  trees,
  archivedTrees,
  activeTreeId,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onRemove,
}: ResearchSidebarSectionProps) {
  const [renamingTreeId, setRenamingTreeId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);

  // A pending delete confirmation quietly expires rather than lingering as a
  // one-click destructive button.
  useEffect(() => {
    if (!confirmingRemoveId) {
      return;
    }
    const timer = window.setTimeout(() => setConfirmingRemoveId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingRemoveId]);

  function submitRename(treeId: string) {
    const title = renameDraft.trim();
    setRenamingTreeId(null);
    if (!title || title === trees.find((tree) => tree.id === treeId)?.title) {
      return;
    }
    void onRename(treeId, title);
  }

  return (
    <section className="research-sidebar-section" aria-label="Research">
      {trees.length === 0 ? (
        <p className="research-sidebar-empty">
          Ask a question and let an agent investigate in the background.
        </p>
      ) : null}
      {trees.map((tree) =>
        renamingTreeId === tree.id ? (
          <form
            key={tree.id}
            className="research-sidebar-row is-renaming"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename(tree.id);
            }}
          >
            <input
              autoFocus
              value={renameDraft}
              aria-label="Research title"
              onChange={(event) => setRenameDraft(event.currentTarget.value)}
              onBlur={() => submitRename(tree.id)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setRenamingTreeId(null);
                }
              }}
            />
          </form>
        ) : (
          <div
            key={tree.id}
            className={`research-sidebar-row${activeTreeId === tree.id ? " is-selected" : ""}`}
          >
            <button
              type="button"
              className="research-sidebar-select"
              aria-current={activeTreeId === tree.id ? "page" : undefined}
              onClick={() => onSelect(tree.id)}
            >
              <span className="research-sidebar-copy">
                <span className="research-sidebar-title">{tree.title}</span>
                <FollowupHint tree={tree} />
              </span>
              {tree.runningCount > 0 ? (
                <span className="research-sidebar-count" title={`${tree.runningCount} running`}>
                  {tree.runningCount}
                </span>
              ) : tree.hasUnseenFailure ? (
                <span
                  className="research-sidebar-failed"
                  title="Failed since last viewed — open to acknowledge"
                >
                  !
                </span>
              ) : tree.hasUnseenUpdate ? (
                <span className="research-sidebar-unseen" title="Updated since last viewed">
                  New
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="research-sidebar-action"
              title="Rename research"
              aria-label={`Rename ${tree.title}`}
              onClick={() => {
                setConfirmingRemoveId(null);
                setRenameDraft(tree.title);
                setRenamingTreeId(tree.id);
              }}
            >
              <Pencil size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="research-sidebar-action"
              title={tree.runningCount > 0 ? "Research with active runs cannot be archived" : "Archive research"}
              aria-label={`Archive ${tree.title}`}
              disabled={tree.runningCount > 0}
              onClick={() => void onArchive(tree.id)}
            >
              <Archive size={12} aria-hidden="true" />
            </button>
          </div>
        ),
      )}
      {archivedTrees.length > 0 ? (
        <details className="research-sidebar-archive">
          <summary>
            <span>Archived</span>
            <span>{archivedTrees.length}</span>
          </summary>
          {archivedTrees.map((tree) => (
            <div key={tree.id} className="research-sidebar-row is-archived">
              <div className="research-sidebar-select">
                <Archive size={13} aria-hidden="true" />
                <span className="research-sidebar-copy">
                  <span className="research-sidebar-title">{tree.title}</span>
                  <FollowupHint tree={tree} />
                </span>
              </div>
              <button
                type="button"
                className="research-sidebar-action"
                title="Restore research"
                aria-label={`Restore ${tree.title}`}
                onClick={() => void onRestore(tree.id)}
              >
                <ArchiveRestore size={12} aria-hidden="true" />
              </button>
              {confirmingRemoveId === tree.id ? (
                <button
                  type="button"
                  className="research-sidebar-action is-danger"
                  title="Confirm permanent deletion"
                  aria-label={`Confirm permanently deleting ${tree.title}`}
                  onClick={() => {
                    setConfirmingRemoveId(null);
                    void onRemove(tree.id);
                  }}
                >
                  <Check size={12} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="research-sidebar-action"
                  title="Delete permanently"
                  aria-label={`Permanently delete ${tree.title}`}
                  onClick={() => setConfirmingRemoveId(tree.id)}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
