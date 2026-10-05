import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import LinkContextMenu from "./LinkContextMenu";
import { canPreviewLocalFilePath } from "../lib/links";
import { writeClipboardText } from "../lib/clipboard";
import type { RemotePreviewTarget } from "../lib/remotePreview";

export default function RemoteLinkContextMenu({ target, x, y, onOpen, onClose, onError }: {
  target: RemotePreviewTarget;
  x: number; y: number;
  onOpen: (cachedOnly: boolean) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [info, setInfo] = useState<{ cachedAvailable: boolean; path: string } | null>(null);
  const { paneId, transcript, path } = target;
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    void invoke<{ cachedAvailable: boolean; path: string }>("remote_preview_info", { paneId, transcript, path })
      .then((value) => { if (!cancelled) setInfo(value); })
      .catch(() => undefined); // Opening reports missing provenance; copy remains useful.
    return () => { cancelled = true; };
  }, [paneId, transcript, path]);
  return <LinkContextMenu x={x} y={y}
    canOpenInternal={canPreviewLocalFilePath(path)} onOpenInternal={() => onOpen(false)}
    onOpenExternal={() => undefined} onClose={onClose}
    remoteActions={{
      cachedAvailable: info?.cachedAvailable ?? false,
      onCached: () => onOpen(true),
      onRefresh: info?.cachedAvailable ? () => onOpen(false) : undefined,
      onCopy: () => { void writeClipboardText(info?.path ?? path).catch(onError); },
    }}
  />;
}
