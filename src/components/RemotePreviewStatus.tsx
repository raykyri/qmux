import { Button } from "./ui";
import type { RemotePreviewState } from "../lib/remotePreview";

export default function RemotePreviewStatus({ preview, onRetry, onCached, onCopy, onClose }: {
  preview: RemotePreviewState;
  onRetry: () => void;
  onCached: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const busy = !preview.url && !preview.error;
  const message = preview.error ?? (preview.fetchedAt
    ? `${preview.cachedOnly ? "Cached copy" : "Snapshot"} · downloaded ${new Date(preview.fetchedAt * 1000).toLocaleString()}`
    : preview.total !== null
      ? `Downloading ${Math.round(preview.bytes / 1024)} of ${Math.round(preview.total / 1024)} KB…`
      : preview.cachedOnly ? "Opening cached copy…" : "Connecting to remote…");
  return (
    <div className="remote-preview-status">
      <div role={preview.error ? "alert" : "status"} aria-live="polite">{message}</div>
      {busy ? <progress aria-label="Remote file download" max={preview.total || undefined} value={preview.total ? preview.bytes : undefined} /> : null}
      <div className="remote-preview-actions">
        {!busy ? <Button size="sm" onClick={onRetry}>{preview.error ? "Retry" : "Refresh from remote"}</Button> : null}
        {preview.error && preview.cachedAvailable ? <Button size="sm" onClick={onCached}>Open cached copy</Button> : null}
        <Button size="sm" onClick={onCopy}>Copy remote path</Button>
        <Button size="sm" onClick={onClose}>{busy ? "Cancel" : "Close"}</Button>
      </div>
    </div>
  );
}
