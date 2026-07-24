// A single app-wide image lightbox. Pasted images render as small inline
// thumbnails (transcript) or rail-card previews; clicking one opens the full
// image here. Kept as a module-level store rather than App state so any image —
// nested deep in the transcript or the home rails — can open it with a bare
// import, without threading a callback through the render tree.
export interface ImageLightboxState {
  // A data URL (images are already loaded/encoded by the caller before opening).
  src: string;
  alt: string;
}

let current: ImageLightboxState | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function openImageLightbox(state: ImageLightboxState) {
  current = state;
  emit();
}

export function closeImageLightbox() {
  if (current === null) {
    return;
  }
  current = null;
  emit();
}

export function getImageLightbox(): ImageLightboxState | null {
  return current;
}

export function subscribeImageLightbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
