// A tiny app-global store for the Whisper voice-model download. The model is
// shared across every composer (the browser caches it after the first fetch), so
// the "Downloading voice model…" toast belongs to the app shell, not to any one
// composer. The dictation hook (useDictation) publishes progress here; App
// subscribes via useSyncExternalStore and renders the toast.

export interface DictationDownload {
  // Bytes fetched so far and the total across the model's files. `total` is null
  // until at least one file reports its size.
  loaded: number;
  total: number | null;
}

let current: DictationDownload | null = null;
const listeners = new Set<() => void>();

export function setDictationDownload(next: DictationDownload | null) {
  // Skip no-op churn (same byte counts) so subscribers don't re-render needlessly.
  if (current === next) return;
  if (current && next && current.loaded === next.loaded && current.total === next.total) return;
  current = next;
  for (const l of listeners) l();
}

export function getDictationDownload(): DictationDownload | null {
  return current;
}

export function subscribeDictationDownload(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
