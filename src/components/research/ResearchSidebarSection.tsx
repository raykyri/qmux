import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ResearchTreeSummary } from "../../types";

const RESEARCH_MENU_WIDTH = 190;
const RESEARCH_MENU_HEIGHT_ESTIMATE = 132;
const RESEARCH_MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

interface ResearchSidebarSectionProps {
  trees: ResearchTreeSummary[];
  archivedTrees: ResearchTreeSummary[];
  activeTreeId: string | null;
  onSelect: (treeId: string) => void;
  onRename: (treeId: string, title: string) => Promise<void>;
  onArchive: (treeId: string) => Promise<void>;
  onRegenerateTitle: (treeId: string) => Promise<void>;
  onRestore: (treeId: string) => Promise<void>;
  onRemove: (treeId: string) => Promise<void>;
}

type ResearchMenu = {
  treeId: string;
  archived: boolean;
  left: number;
  top: number;
};

export default function ResearchSidebarSection({
  trees,
  archivedTrees,
  activeTreeId,
  onSelect,
  onRename,
  onArchive,
  onRegenerateTitle,
  onRestore,
  onRemove,
}: ResearchSidebarSectionProps) {
  const [menu, setMenu] = useState<ResearchMenu | null>(null);
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const menuTree = menu
    ? (menu.archived ? archivedTrees : trees).find((tree) => tree.id === menu.treeId) ?? null
    : null;

  useEffect(() => {
    if (!menu) {
      return;
    }
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !(target instanceof Element && target.closest("[data-research-menu-trigger]"))
      ) {
        setMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
      }
    };
    const closeOnReflow = () => setMenu(null);
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeOnReflow);
    window.addEventListener("scroll", closeOnReflow, true);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeOnReflow);
      window.removeEventListener("scroll", closeOnReflow, true);
    };
  }, [menu]);

  useEffect(() => {
    if (renamingTree) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingTree]);

  function openMenu(trigger: HTMLButtonElement, treeId: string, archived: boolean) {
    if (menu?.treeId === treeId && menu.archived === archived) {
      setMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        rect.right - RESEARCH_MENU_WIDTH,
        window.innerWidth - RESEARCH_MENU_WIDTH - VIEWPORT_MARGIN,
      ),
    );
    const below = rect.bottom + RESEARCH_MENU_GAP;
    const top =
      below + RESEARCH_MENU_HEIGHT_ESTIMATE <= window.innerHeight - VIEWPORT_MARGIN
        ? below
        : Math.max(
            VIEWPORT_MARGIN,
            rect.top - RESEARCH_MENU_HEIGHT_ESTIMATE - RESEARCH_MENU_GAP,
          );
    setMenu({ treeId, archived, left, top });
  }

  function openContextMenu(
    treeId: string,
    archived: boolean,
    clientX: number,
    clientY: number,
  ) {
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(clientX, window.innerWidth - RESEARCH_MENU_WIDTH - VIEWPORT_MARGIN),
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        clientY,
        window.innerHeight - RESEARCH_MENU_HEIGHT_ESTIMATE - VIEWPORT_MARGIN,
      ),
    );
    setMenu({ treeId, archived, left, top });
  }

  function openDeleteDialog(tree: ResearchTreeSummary) {
    setMenu(null);
    setDeletingTree(tree);
  }

  function openRenameDialog(tree: ResearchTreeSummary) {
    setMenu(null);
    setRenameDraft(tree.title);
    setRenamingTree(tree);
  }

  function submitRename() {
    if (!renamingTree) {
      return;
    }
    const tree = renamingTree;
    const title = renameDraft.trim();
    setRenamingTree(null);
    if (!title || title === tree.title) {
      return;
    }
    void onRename(tree.id, title);
  }

  return (
    <>
      <section className="research-sidebar-section" aria-label="Research">
        {trees.map((tree) => (
          <div
            key={tree.id}
            className={`research-sidebar-row${activeTreeId === tree.id ? " is-selected" : ""}${
              menu?.treeId === tree.id ? " has-open-menu" : ""
            }`}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openContextMenu(tree.id, false, event.clientX, event.clientY);
            }}
            onDoubleClick={() => openRenameDialog(tree)}
          >
            <button
              type="button"
              className="research-sidebar-select"
              aria-current={activeTreeId === tree.id ? "page" : undefined}
              title={tree.title}
              onClick={(event) => {
                // A double-click still selects the research on its first click,
                // but does not start a second redundant detail fetch before the
                // rename dialog opens.
                if (event.detail <= 1) {
                  onSelect(tree.id);
                }
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                openRenameDialog(tree);
              }}
            >
              <span className="research-sidebar-copy">
                <span className="research-sidebar-title">{tree.title}</span>
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
              className="research-sidebar-menu-trigger"
              title="Research actions"
              aria-label={`Actions for ${tree.title}`}
              aria-haspopup="menu"
              aria-expanded={menu?.treeId === tree.id}
              data-research-menu-trigger
              onClick={(event) => openMenu(event.currentTarget, tree.id, false)}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        {archivedTrees.length > 0 ? (
          <details className="research-sidebar-archive">
            <summary>
              <span>Archived</span>
              <span>{archivedTrees.length}</span>
            </summary>
            {archivedTrees.map((tree) => (
              <div
                key={tree.id}
                className={`research-sidebar-row is-archived${
                  menu?.archived && menu.treeId === tree.id ? " has-open-menu" : ""
                }`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openContextMenu(tree.id, true, event.clientX, event.clientY);
                }}
              >
                <div className="research-sidebar-select" title={tree.title}>
                  <span className="research-sidebar-copy">
                    <span className="research-sidebar-title">{tree.title}</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="research-sidebar-menu-trigger"
                  title="Research actions"
                  aria-label={`Actions for ${tree.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.archived && menu.treeId === tree.id}
                  data-research-menu-trigger
                  onClick={(event) => openMenu(event.currentTarget, tree.id, true)}
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
          </details>
        ) : null}
      </section>
      {menu && menuTree
        ? createPortal(
            <div
              ref={menuRef}
              className="pane-context-menu research-sidebar-menu"
              role="menu"
              aria-label={`Actions for ${menuTree.title}`}
              style={{ left: menu.left, top: menu.top }}
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="group-context-actions">
                {menu.archived ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      void onRestore(menuTree.id);
                    }}
                  >
                    <ArchiveRestore size={13} aria-hidden="true" />
                    <span>Restore research</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openRenameDialog(menuTree)}
                    >
                      <Pencil size={13} aria-hidden="true" />
                      <span>Rename research</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        void onRegenerateTitle(menuTree.id);
                      }}
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      <span>Regenerate title</span>
                    </button>
                  </>
                )}
                <div className="context-menu-divider" role="separator" />
                {!menu.archived ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={menuTree.runningCount > 0}
                    title={
                      menuTree.runningCount > 0
                        ? "Research with active runs cannot be archived"
                        : undefined
                    }
                    onClick={() => {
                      setMenu(null);
                      void onArchive(menuTree.id);
                    }}
                  >
                    <Archive size={13} aria-hidden="true" />
                    <span>Archive research</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="context-menu-danger"
                  disabled={menuTree.runningCount > 0}
                  title={
                    menuTree.runningCount > 0
                      ? "Research with active runs cannot be deleted"
                      : undefined
                  }
                  onClick={() => openDeleteDialog(menuTree)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  <span>Delete permanently</span>
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      {deletingTree
        ? createPortal(
            <div
              className="confirm-dialog-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setDeletingTree(null);
                }
              }}
            >
              <div
                className="confirm-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-research-dialog-title"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDeletingTree(null);
                  }
                }}
              >
                <h2 id="delete-research-dialog-title">Delete “{deletingTree.title}”?</h2>
                <p>
                  This permanently deletes this research and its completed work and follow-up
                  history. This can’t be undone.
                </p>
                <div className="confirm-dialog-actions">
                  <button type="button" onClick={() => setDeletingTree(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    autoFocus
                    onClick={() => {
                      const treeId = deletingTree.id;
                      setDeletingTree(null);
                      void onRemove(treeId);
                    }}
                  >
                    Delete research
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {renamingTree
        ? createPortal(
            <div
              className="confirm-dialog-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setRenamingTree(null);
                }
              }}
            >
              <form
                className="confirm-dialog rename-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="rename-research-dialog-title"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitRename();
                }}
              >
                <h2 id="rename-research-dialog-title">Rename research</h2>
                <input
                  ref={renameInputRef}
                  className="rename-dialog-input"
                  value={renameDraft}
                  aria-label="Research title"
                  onChange={(event) => setRenameDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingTree(null);
                    }
                  }}
                />
                <div className="confirm-dialog-actions">
                  <button type="button" onClick={() => setRenamingTree(null)}>
                    Cancel
                  </button>
                  <button type="submit">Rename</button>
                </div>
              </form>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
