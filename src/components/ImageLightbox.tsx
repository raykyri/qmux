import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  closeImageLightbox,
  getImageLightbox,
  subscribeImageLightbox,
} from "../lib/imageLightbox";

// Mounted once at the app root. Renders whatever image openImageLightbox last
// set, full-size over a dimmed backdrop; dismissed by clicking anywhere or
// pressing Escape. The image is already a loaded data URL, so there is no
// loading state here — the thumbnail the user clicked shares the same cached
// bytes.
export default function ImageLightbox() {
  const state = useSyncExternalStore(subscribeImageLightbox, getImageLightbox, getImageLightbox);

  useEffect(() => {
    if (!state) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImageLightbox();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [state]);

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
