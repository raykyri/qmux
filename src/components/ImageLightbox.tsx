import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  closeImageLightbox,
  getImageLightbox,
  subscribeImageLightbox,
} from "../lib/imageLightbox";

// Mounted once at the app root. Renders whatever image openImageLightbox last
// set, full-size over a dimmed backdrop; dismissed by clicking anywhere or the
// close button. Escape is handled by the app-level Escape dispatcher in App
// (which reads this component's module store), so there is no keydown listener
// here — it kept the dispatcher's fixed overlay ordering the whole story. The
// image is already a loaded data URL, so there is no loading state here — the
// thumbnail the user clicked shares the same cached bytes.
export default function ImageLightbox() {
  const state = useSyncExternalStore(subscribeImageLightbox, getImageLightbox, getImageLightbox);

  if (!state) {
    return null;
  }
  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={state.alt}
      onClick={closeImageLightbox}
    >
      <button
        type="button"
        className="image-lightbox-close control-button"
        aria-label="Close image"
        onClick={closeImageLightbox}
      >
        ✕
      </button>
      {/* Stop the click on the image itself from dismissing, so only the
          backdrop (and the explicit close button) close the lightbox. */}
      <img
        className="image-lightbox-img"
        src={state.src}
        alt={state.alt}
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
