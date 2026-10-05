import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RemotePreviewRequests, type RemotePreviewState, type RemotePreviewStatus } from "../lib/remotePreview";

export function useRemoteFilePreviews() {
  const [previews, setPreviews] = useState<Record<string, RemotePreviewState>>({});
  const [requests] = useState(() => new RemotePreviewRequests({
    start: (target, cachedOnly) => invoke<string>("remote_preview_start", {
      paneId: target.paneId, transcript: target.transcript, path: target.path, cachedOnly,
    }),
    status: (requestId) => invoke<RemotePreviewStatus>("remote_preview_status", { requestId }),
    close: (requestId) => invoke<void>("remote_preview_close", { requestId }),
  }, setPreviews));
  useEffect(() => () => requests.dispose(), [requests]);
  return { previews, requests };
}
