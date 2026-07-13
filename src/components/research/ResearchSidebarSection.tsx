import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  FileText,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ResearchTreeSummary } from "../../types";
import { moveResearchTreeIdToGap } from "../../lib/researchOrder";

const RESEARCH_MENU_WIDTH = 190;
const RESEARCH_MENU_HEIGHT_ESTIMATE = 132;
const RESEARCH_MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

export type ResearchVisibilityFilter = "active" | "archived" | "all";

interface ResearchSidebarSectionProps {
  trees: ResearchTreeSummary[];
  archivedTrees: ResearchTreeSummary[];
  visibilityFilter: ResearchVisibilityFilter;
  activeTreeId: string | null;
  onSelect: (treeId: string) => void;
  onRename: (treeId: string, title: string) => Promise<void>;
  onArchive: (treeId: string) => Promise<void>;
  onRegenerateTitle: (treeId: string) => Promise<void>;
  onRestore: (treeId: string) => Promise<void>;
  onRemove: (treeId: string) => Promise<void>;
  onReorder: (archived: boolean, orderedTreeIds: string[]) => void;
}

type ResearchMenu = {
  treeId: string;
  archived: boolean;
  left: number;
  top: number;
};

type ResearchPointerDrag = {
  pointerId: number;
  treeId: string;
  archived: boolean;
  startX: number;
  startY: number;
  active: boolean;
};

type ResearchDropTarget = {
  archived: boolean;
  index: number;
};

const RESEARCH_DRAG_START_THRESHOLD = 4;
const RESEARCH_DRAG_CLICK_SUPPRESS_MS = 100;

function ResearchSidebarTitle({ tree }: { tree: ResearchTreeSummary }) {
  return (
    <span className="research-sidebar-title">
      {tree.kind === "document" ? (
        <FileText className="research-sidebar-doc-icon" size={12} aria-hidden="true" />
      ) : null}
      <span className="research-sidebar-title-text">{tree.title}</span>
    </span>
  );
}

export default function ResearchSidebarSection({
  trees,
  archivedTrees,
  visibilityFilter,
  activeTreeId,
  onSelect,
  onRename,
  onArchive,
  onRegenerateTitle,
  onRestore,
  onRemove,
  onReorder,
}: ResearchSidebarSectionProps) {
  const [menu, setMenu] = useState<ResearchMenu | null>(null);
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const [removingTreeId, setRemovingTreeId] = useState<string | null>(null);
  const [treeRemovalError, setTreeRemovalError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const pointerDragRef = useRef<ResearchPointerDrag | null>(null);
  const dropTargetRef = useRef<ResearchDropTarget | null>(null);
  const suppressClickRef = useRef(false);
  const [draggingTreeId, setDraggingTreeId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ResearchDropTarget | null>(null);
  const visibleTrees = visibilityFilter === "archived" ? [] : trees;
  const visibleArchivedTrees = visibilityFilter === "active" ? [] : archivedTrees;
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
        return;
      }
      if (!menuTree || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== "d" && (key !== "a" || menu.archived)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (menuTree.runningCount > 0) {
        return;
      }
      if (key === "d") {
        openDeleteDialog(menuTree);
        return;
      }

      setMenu(null);
      void onArchive(menuTree.id);
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
  }, [menu, menuTree, onArchive]);

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
    setTreeRemovalError(null);
    setDeletingTree(tree);
  }

  function openRenameDialog(tree: ResearchTreeSummary) {
    setMenu(null);
    setRenameDraft(tree.title);
    setRenamingTree(tree);
  }

  async function confirmTreeRemoval() {
    if (!deletingTree || removingTreeId) {
      return;
    }
    const treeId = deletingTree.id;
    setTreeRemovalError(null);
    setRemovingTreeId(treeId);
    try {
      await onRemove(treeId);
      setDeletingTree(null);
    } catch (err) {
      // The app shell surfaces the backend error. Keep the confirmation open so
      // the user does not have to reopen the menu after a transient rejection.
      setTreeRemovalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingTreeId(null);
    }
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

  function clearPointerDrag() {
    pointerDragRef.current = null;
    dropTargetRef.current = null;
    setDraggingTreeId(null);
    setDropTarget(null);
  }

  function computeDropTarget(
    clientY: number,
    treeId: string,
    archived: boolean,
  ): ResearchDropTarget | null {
    const section = sectionRef.current;
    const sectionTrees = archived ? visibleArchivedTrees : visibleTrees;
    const dragIndex = sectionTrees.findIndex((tree) => tree.id === treeId);
    if (!section || dragIndex < 0) {
      return null;
    }
    const rows = Array.from(
      section.querySelectorAll<HTMLElement>(
        `.research-sidebar-row[data-research-archived="${archived}"]`,
      ),
    );
    const gapTarget = (index: number): ResearchDropTarget | null =>
      index === dragIndex || index === dragIndex + 1 ? null : { archived, index };
    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return gapTarget(index);
      }
    }
    return gapTarget(rows.length);
  }

  function handlePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    treeId: string,
    archived: boolean,
  ) {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("[data-research-menu-trigger]"))
    ) {
      return;
    }
    pointerDragRef.current = {
      pointerId: event.pointerId,
      treeId,
      archived,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < RESEARCH_DRAG_START_THRESHOLD) {
        return;
      }
      drag.active = true;
      setMenu(null);
      setDraggingTreeId(drag.treeId);
    }
    event.preventDefault();
    const target = computeDropTarget(event.clientY, drag.treeId, drag.archived);
    dropTargetRef.current = target;
    setDropTarget(target);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The platform may already have released capture.
    }
    if (!drag.active) {
      pointerDragRef.current = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, RESEARCH_DRAG_CLICK_SUPPRESS_MS);
    const target =
      dropTargetRef.current ?? computeDropTarget(event.clientY, drag.treeId, drag.archived);
    clearPointerDrag();
    if (!target) {
      return;
    }
    const sectionTrees = drag.archived ? visibleArchivedTrees : visibleTrees;
    const currentIds = sectionTrees.map((tree) => tree.id);
    const nextIds = moveResearchTreeIdToGap(currentIds, drag.treeId, target.index);
    if (nextIds !== currentIds) {
      onReorder(drag.archived, nextIds);
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerDragRef.current?.pointerId === event.pointerId) {
      clearPointerDrag();
    }
  }

  function dragClasses(treeId: string, archived: boolean, index: number, length: number) {
    return `${draggingTreeId === treeId ? " is-dragging" : ""}${
      dropTarget?.archived === archived && dropTarget.index === index
        ? " is-drop-before"
        : ""
    }${
      dropTarget?.archived === archived && dropTarget.index === length && index === length - 1
        ? " is-drop-after"
        : ""
    }`;
  }

  return (
    <>
      <section
        ref={sectionRef}
        className={`research-sidebar-section${draggingTreeId ? " is-dragging" : ""}`}
        aria-label="Research"
      >
        {visibleTrees.map((tree, index) => (
          <div
            key={tree.id}
            className={`research-sidebar-row${activeTreeId === tree.id ? " is-selected" : ""}${
              menu?.treeId === tree.id ? " has-open-menu" : ""
            }${dragClasses(tree.id, false, index, visibleTrees.length)}`}
            data-research-tree-id={tree.id}
            data-research-archived="false"
            onPointerDown={(event) => handlePointerDown(event, tree.id, false)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
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
                if (suppressClickRef.current) {
                  return;
                }
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
                <ResearchSidebarTitle tree={tree} />
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
        {visibilityFilter !== "active"
          ? visibleArchivedTrees.map((tree, index) => (
              <div
                key={tree.id}
                className={`research-sidebar-row is-archived${
                  activeTreeId === tree.id ? " is-selected" : ""
                }${
                  menu?.archived && menu.treeId === tree.id ? " has-open-menu" : ""
                }${dragClasses(tree.id, true, index, visibleArchivedTrees.length)}`}
                data-research-tree-id={tree.id}
                data-research-archived="true"
                onPointerDown={(event) => handlePointerDown(event, tree.id, true)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openContextMenu(tree.id, true, event.clientX, event.clientY);
                }}
              >
                <button
                  type="button"
                  className="research-sidebar-select"
                  aria-current={activeTreeId === tree.id ? "page" : undefined}
                  title={tree.title}
                  onClick={() => {
                    if (!suppressClickRef.current) {
                      onSelect(tree.id);
                    }
                  }}
                >
                  <span className="research-sidebar-copy">
                    <ResearchSidebarTitle tree={tree} />
                  </span>
                </button>
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
            ))
          : null}
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
                    <span>Unarchive research</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openRenameDialog(menuTree)}
                    >
                      <Pencil size={13} aria-hidden="true" />
                      <span>Rename</span>
                    </button>
                    {menuTree.kind !== "document" ? (
                      // Title regeneration reruns the root prompt through the
                      // title model; a document has no prompt to rerun.
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
                    ) : null}
                  </>
                )}
                {!menu.archived ? (
                  <>
                    <div className="context-menu-divider" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="context-menu-has-shortcut"
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
                      <span>Archive</span>
                      <kbd className="context-menu-shortcut is-keycap">A</kbd>
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="context-menu-danger context-menu-has-shortcut"
                  disabled={menuTree.runningCount > 0}
                  title={
                    menuTree.runningCount > 0
                      ? "Research with active runs cannot be deleted"
                      : undefined
                  }
                  onClick={() => openDeleteDialog(menuTree)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  <span>Delete</span>
                  <kbd className="context-menu-shortcut is-keycap">D</kbd>
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
                if (event.target === event.currentTarget && !removingTreeId) {
                  setDeletingTree(null);
                }
              }}
            >
              <div
                className="confirm-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-research-dialog-title"
                aria-busy={removingTreeId === deletingTree.id}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !removingTreeId) {
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
                {treeRemovalError ? (
                  <p className="confirm-dialog-error" role="alert">
                    {treeRemovalError}
                  </p>
                ) : null}
                <div className="confirm-dialog-actions">
                  <button
                    type="button"
                    disabled={removingTreeId !== null}
                    onClick={() => setDeletingTree(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    autoFocus
                    disabled={removingTreeId !== null}
                    onClick={() => void confirmTreeRemoval()}
                  >
                    {removingTreeId === deletingTree.id ? "Deleting…" : "Delete research"}
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
