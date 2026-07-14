import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import type { GroupInfo } from "../../types";
import type { ResearchFolderScope } from "../../lib/researchScope";

interface ResearchFolderSwitcherProps {
  folders: GroupInfo[];
  scope: ResearchFolderScope;
  // Tree counts (active + archived) keyed by workspace id for the menu badges.
  treeCounts: Map<string, number>;
  folderPickerBusy: boolean;
  onSelectScope: (scope: ResearchFolderScope) => void;
  onNewFolder: () => Promise<GroupInfo | null>;
  onOpenFolder: (folder: GroupInfo) => Promise<void>;
  onRenameFolder: (folder: GroupInfo) => void;
  onMoveFolder: (folder: GroupInfo) => Promise<void>;
  onRemoveFolder: (folder: GroupInfo) => void;
}

export default function ResearchFolderSwitcher({
  folders,
  scope,
  treeCounts,
  folderPickerBusy,
  onSelectScope,
  onNewFolder,
  onOpenFolder,
  onRenameFolder,
  onMoveFolder,
  onRemoveFolder,
}: ResearchFolderSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const scopedFolder = folders.find((folder) => folder.id === scope);
  const folderName = (folder: GroupInfo) => folder.nameOverride || folder.name;

  function select(next: ResearchFolderScope) {
    setOpen(false);
    onSelectScope(next);
  }

  return (
    <div className="research-folder-switcher" ref={rootRef}>
      <button
        type="button"
        className="control-button research-folder-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={scopedFolder?.dir ?? "No research folder selected"}
        onClick={() => setOpen((current) => !current)}
      >
        <Folder size={13} aria-hidden="true" />
        <span className="research-folder-trigger-copy">
          <span className="research-folder-trigger-name">
            {scopedFolder ? folderName(scopedFolder) : "Research folders"}
          </span>
          {scopedFolder ? (
            <span className="research-folder-path">{scopedFolder.dir}</span>
          ) : null}
        </span>
        <ChevronDown size={13} aria-hidden="true" className={open ? "is-open" : undefined} />
      </button>
      {open ? (
        <div className="research-folder-menu" role="menu" aria-label="Research folders">
          {folders.length > 0 ? (
            folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={scope === folder.id}
                  className={`control-button research-folder-item${scope === folder.id ? " is-selected" : ""}`}
                  title={folder.dir}
                  onClick={() => select(folder.id)}
                >
                  <Folder size={13} aria-hidden="true" />
                  <span className="research-folder-item-copy">
                    <span className="research-folder-item-name">{folderName(folder)}</span>
                    <span className="research-folder-path">{folder.dir}</span>
                  </span>
                  {scope === folder.id ? <Check size={13} aria-hidden="true" /> : null}
                  <span className="research-folder-count">{treeCounts.get(folder.id) ?? 0}</span>
                </button>
              ))
          ) : null}
          <div className="research-folder-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="control-button research-folder-item"
            disabled={folderPickerBusy}
            onClick={() => {
              setOpen(false);
              void onNewFolder().then((workspace) => {
                if (workspace) {
                  onSelectScope(workspace.id);
                }
              });
            }}
          >
            <FolderPlus size={13} aria-hidden="true" />
            <span className="research-folder-item-name">Open new folder…</span>
          </button>
          {scopedFolder ? (
            <>
              <div className="research-folder-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="control-button research-folder-item"
                onClick={() => {
                  setOpen(false);
                  void onOpenFolder(scopedFolder);
                }}
              >
                <FolderOpen size={13} aria-hidden="true" />
                <span className="research-folder-item-name">Open selected folder</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="control-button research-folder-item"
                onClick={() => {
                  setOpen(false);
                  onRenameFolder(scopedFolder);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
                <span className="research-folder-item-name">
                  Rename “{folderName(scopedFolder)}”
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="control-button research-folder-item"
                disabled={folderPickerBusy}
                onClick={() => {
                  setOpen(false);
                  void onMoveFolder(scopedFolder);
                }}
              >
                <FolderInput size={13} aria-hidden="true" />
                <span className="research-folder-item-name">Move selected folder…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="control-button research-folder-item is-remove"
                onClick={() => {
                  setOpen(false);
                  onRemoveFolder(scopedFolder);
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
                <span className="research-folder-item-name">Remove selected folder</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
