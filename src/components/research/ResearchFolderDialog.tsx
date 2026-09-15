import { useEffect, useState } from "react";
import {
  Button,
  DialogActions,
  DialogForm,
  DialogRoot,
  DialogTitle,
  Input,
} from "../ui";

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
    <DialogRoot onDismiss={onClose}>
      <DialogForm
        className="rename-dialog"
        aria-labelledby="create-research-folder-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedName) {
            onCreate(trimmedName);
          }
        }}
      >
        <DialogTitle id="create-research-folder-dialog-title">New folder</DialogTitle>
        <p>
          {itemCount > 0
            ? `Name the folder before moving ${itemCount} selected ${
                itemCount === 1 ? "item" : "items"
              } into it.`
            : "Create an empty folder for research you want to organize later."}
        </p>
        <Input
          className="rename-dialog-input"
          value={name}
          aria-label="Folder name"
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!trimmedName}>
            {itemCount > 0 ? "Create and move" : "Create folder"}
          </Button>
        </DialogActions>
      </DialogForm>
    </DialogRoot>
  );
}
