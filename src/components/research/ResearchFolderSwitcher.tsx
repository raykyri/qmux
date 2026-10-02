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
import { Button, Menu, MenuItem, PopoverPortal, useAnchoredPopover } from "../ui";
import type { GroupInfo } from "../../types";
import type { ResearchFolderScope } from "../../lib/researchScope";
import { listenToResearchFolderMenuToggle } from "../../lib/researchShortcuts";

interface ResearchFolderSwitcherProps {
  folders: GroupInfo[];
  scope: ResearchFolderScope;
  // Tree counts (active + archived) keyed by workspace id for the menu badges.
  treeCounts: Map<string, number>;
  folderPickerBusy: boolean;
  /** Show the held-⌘ shortcut badge on the trigger. */
  shortcutHintsShown: boolean;
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
  shortcutHintsShown,
  onSelectScope,
  onNewFolder,
  onOpenFolder,
  onRenameFolder,
  onMoveFolder,
  onRemoveFolder,
}: ResearchFolderSwitcherProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const position = useAnchoredPopover({
    open,
    onClose: () => setOpen(false),
    triggerRef,
    popoverRef: menuRef,
    preferredWidth: "trigger",
  });

  // The app dispatcher receives Cmd-O even while Ghostty owns native focus.
  useEffect(
    () =>
      listenToResearchFolderMenuToggle(() => {
        if (open) close();
        else setOpen(true);
      }),
    [open],
  );

  const scopedFolder = folders.find((folder) => folder.id === scope);
  const folderName = (folder: GroupInfo) => folder.nameOverride || folder.name;

  function select(next: ResearchFolderScope) {
    close();
    onSelectScope(next);
  }

  return (
    <div className="research-folder-switcher">
      <Button
        ref={triggerRef}
        className="research-folder-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={scopedFolder?.dir ?? "No research folder selected"}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Folder size={13} aria-hidden="true" />
        <span className="research-folder-trigger-copy">
          <span className="research-folder-trigger-name">
            {scopedFolder ? folderName(scopedFolder) : "Research folders"}
          </span>
          {scopedFolder ? <span className="research-folder-path">{scopedFolder.dir}</span> : null}
        </span>
        <ChevronDown size={13} aria-hidden="true" className={open ? "is-open" : undefined} />
      </Button>
      {shortcutHintsShown ? (
        <span className="pane-tab-shortcut-hint research-folder-shortcut-hint" aria-hidden="true">
          ⌘O
        </span>
      ) : null}
      {open ? (
        <PopoverPortal>
          <Menu
            ref={menuRef}
            className="research-folder-menu"
            aria-label="Research folders"
            style={position ?? { left: -9999, top: -9999 }}
          >
            {folders.length > 0
              ? folders.map((folder) => (
                  <MenuItem
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
                  </MenuItem>
                ))
              : null}
            <div className="research-folder-menu-separator" role="separator" />
            <MenuItem
              type="button"
              role="menuitem"
              className="research-folder-item"
              disabled={folderPickerBusy}
              onClick={() => {
                close();
                void onNewFolder().then((workspace) => {
                  if (workspace) {
                    onSelectScope(workspace.id);
                  }
                });
              }}
            >
              <FolderPlus size={13} aria-hidden="true" />
              <span className="research-folder-item-name">Open new folder…</span>
            </MenuItem>
            {scopedFolder ? (
              <>
                <div className="research-folder-menu-separator" role="separator" />
                <MenuItem
                  type="button"
                  role="menuitem"
                  className="research-folder-item"
                  onClick={() => {
                    close();
                    void onOpenFolder(scopedFolder);
                  }}
                >
                  <FolderOpen size={13} aria-hidden="true" />
                  <span className="research-folder-item-name">Open selected folder</span>
                </MenuItem>
                <MenuItem
                  type="button"
                  role="menuitem"
                  className="research-folder-item"
                  onClick={() => {
                    close();
                    onRenameFolder(scopedFolder);
                  }}
                >
                  <Pencil size={13} aria-hidden="true" />
                  <span className="research-folder-item-name">
                    Rename “{folderName(scopedFolder)}”
                  </span>
                </MenuItem>
                <MenuItem
                  type="button"
                  role="menuitem"
                  className="research-folder-item"
                  disabled={folderPickerBusy}
                  onClick={() => {
                    close();
                    void onMoveFolder(scopedFolder);
                  }}
                >
                  <FolderInput size={13} aria-hidden="true" />
                  <span className="research-folder-item-name">Move selected folder…</span>
                </MenuItem>
                <MenuItem
                  type="button"
                  role="menuitem"
                  className="research-folder-item is-remove"
                  onClick={() => {
                    close();
                    onRemoveFolder(scopedFolder);
                  }}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  <span className="research-folder-item-name">Remove selected folder</span>
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </PopoverPortal>
      ) : null}
    </div>
  );
}
