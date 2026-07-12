import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Folders,
  FolderSync,
  Pencil,
  Trash2,
} from "lucide-react";
import type { GroupInfo } from "../../types";
import { ALL_RESEARCH_SCOPE, type ResearchFolderScope } from "../../lib/researchScope";

interface ResearchFolderSwitcherProps {
  folders: GroupInfo[];
  scope: ResearchFolderScope;
  // Tree counts (active + archived) keyed by workspace id; used both for the
  // menu badges and the folder-replace dialog's messaging.
  treeCounts: Map<string, number>;
  totalTreeCount: number;
  folderPickerBusy: boolean;
  onSelectScope: (scope: ResearchFolderScope) => void;
  onNewFolder: () => Promise<GroupInfo | null>;
  onRenameFolder: (folder: GroupInfo) => void;
  /** Repoints the folder's workspace at a different directory (native picker).
   * The recovery path for a folder that moved or vanished: trees cannot move
   * between workspaces, so without this a missing directory permanently
   * blocks every future run in them. */
  onReplaceFolder: (folder: GroupInfo) => void;
  onRemoveFolder: (folder: GroupInfo) => void;
}

export default function ResearchFolderSwitcher({
  folders,
  scope,
  treeCounts,
  totalTreeCount,
  folderPickerBusy,
  onSelectScope,
  onNewFolder,
  onRenameFolder,
  onReplaceFolder,
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

  const scopedFolder = scope === ALL_RESEARCH_SCOPE ? null : folders.find((f) => f.id === scope);
  const folderName = (folder: GroupInfo) => folder.nameOverride || folder.name;

  function select(next: ResearchFolderScope) {
    setOpen(false);
    onSelectScope(next);
  }

  return (
    <div className="research-folder-switcher" ref={rootRef}>
      <button
        type="button"
        className="research-folder-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={scopedFolder ? scopedFolder.dir : "Showing research from every folder"}
        onClick={() => setOpen((current) => !current)}
      >
        {scopedFolder ? (
          <Folder size={13} aria-hidden="true" />
        ) : (
          <Folders size={13} aria-hidden="true" />
        )}
        <span className="research-folder-trigger-copy">
          <span className="research-folder-trigger-name">
            {scopedFolder ? folderName(scopedFolder) : "All research"}
          </span>
          {scopedFolder ? (
            <span className="research-folder-path">{scopedFolder.dir}</span>
          ) : null}
        </span>
        <span className="research-folder-count">
          {scopedFolder ? (treeCounts.get(scopedFolder.id) ?? 0) : totalTreeCount}
        </span>
        <ChevronDown size={13} aria-hidden="true" className={open ? "is-open" : undefined} />
      </button>
      {open ? (
        <div className="research-folder-menu" role="menu" aria-label="Research folders">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={scope === ALL_RESEARCH_SCOPE}
            className={`research-folder-item${scope === ALL_RESEARCH_SCOPE ? " is-selected" : ""}`}
            onClick={() => select(ALL_RESEARCH_SCOPE)}
          >
            <Folders size={13} aria-hidden="true" />
            <span className="research-folder-item-name">All research</span>
            {scope === ALL_RESEARCH_SCOPE ? <Check size={13} aria-hidden="true" /> : null}
            <span className="research-folder-count">{totalTreeCount}</span>
          </button>
          {folders.length > 0 ? (
            <>
              <div className="research-folder-menu-separator" role="separator" />
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={scope === folder.id}
                  className={`research-folder-item${scope === folder.id ? " is-selected" : ""}`}
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
              ))}
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="research-folder-item"
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
            <span className="research-folder-item-name">New folder…</span>
          </button>
          {scopedFolder ? (
            <>
              <div className="research-folder-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="research-folder-item"
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
                className="research-folder-item"
                disabled={folderPickerBusy}
                title={scopedFolder.dir}
                onClick={() => {
                  setOpen(false);
                  onReplaceFolder(scopedFolder);
                }}
              >
                <FolderSync size={13} aria-hidden="true" />
                <span className="research-folder-item-name">Replace folder…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="research-folder-item is-remove"
                onClick={() => {
                  setOpen(false);
                  onRemoveFolder(scopedFolder);
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
                <span className="research-folder-item-name">Remove folder</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
