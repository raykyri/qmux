import { Button } from "./ui";
import { useState } from "react";
import type { RemotePreviewState } from "../lib/remotePreview";

export default function RemotePreviewStatus({ preview, onRetry, onCached, onCopy, onClose, onDownload }: {
  preview: RemotePreviewState;
  onRetry: () => void;
  onCached: () => void;
  onCopy: () => void;
  onClose: () => void;
  onDownload: () => Promise<boolean>;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try { await onDownload(); }
    catch (error) { setDownloadError(String(error)); }
    finally { setDownloading(false); }
  }
  const busy = !preview.url && !preview.error;
  const message = preview.error ?? (preview.fetchedAt
    ? `${preview.cachedOnly ? "Cached copy" : "Snapshot"} · downloaded ${new Date(preview.fetchedAt * 1000).toLocaleString()}`
    : preview.total !== null
      ? `Downloading ${Math.round(preview.bytes / 1024)} of ${Math.round(preview.total / 1024)} KB…`
      : preview.cachedOnly ? "Opening cached copy…" : "Connecting to remote…");
  return (
    <div className="remote-preview-status">
      <div className="remote-preview-status-row">
        <div className="remote-preview-message" role={preview.error ? "alert" : "status"} aria-live="polite">{message}</div>
        <div className="remote-preview-actions">
          <Button size="sm" onClick={() => void download()} disabled={busy || downloading}>{downloading ? "Downloading…" : "Download"}</Button>
          {!busy ? <Button size="sm" onClick={onRetry}>{preview.error ? "Retry" : "Refresh from remote"}</Button> : null}
          {preview.error && preview.cachedAvailable ? <Button size="sm" onClick={onCached}>Open cached copy</Button> : null}
          <Button size="sm" onClick={onCopy}>Copy remote path</Button>
          <Button size="sm" onClick={onClose}>{busy ? "Cancel" : "Close"}</Button>
        </div>
      </div>
      {busy ? <progress aria-label="Remote file download" max={preview.total || undefined} value={preview.total ? preview.bytes : undefined} /> : null}
      {downloadError ? <div role="alert">{downloadError}</div> : null}
    </div>
  );
}
