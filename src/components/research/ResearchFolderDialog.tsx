import { useEffect, useState } from "react";

interface ResearchFolderDialogProps {
  open: boolean;
  itemCount: number;
  onClose: () => void;
  onCreate: (name: string) => void;
}

export default function ResearchFolderDialog({
  open,
  itemCount,
  onClose,
  onCreate,
}: ResearchFolderDialogProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const trimmedName = name.trim();
  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        className="confirm-dialog rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-research-folder-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedName) {
            onCreate(trimmedName);
          }
        }}
      >
        <h2 id="create-research-folder-dialog-title">New folder</h2>
        <p>
          {itemCount > 0
            ? `Name the folder before moving ${itemCount} selected ${
                itemCount === 1 ? "item" : "items"
              } into it.`
            : "Create an empty folder for research you want to organize later."}
        </p>
        <input
          className="rename-dialog-input"
          value={name}
          aria-label="Folder name"
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="control-button" type="submit" disabled={!trimmedName}>
            {itemCount > 0 ? "Create and move" : "Create folder"}
          </button>
        </div>
      </form>
    </div>
  );
}
