import { useSyncExternalStore } from "react";
import { Button, Dialog, DialogRoot } from "./ui";
import { closeImageLightbox, getImageLightbox, subscribeImageLightbox } from "../lib/imageLightbox";

// The shared dialog owns DOM focus containment/restoration. App's window
// capture dispatcher still handles Escape first, preserving overlay ordering.
export default function ImageLightbox() {
  const state = useSyncExternalStore(subscribeImageLightbox, getImageLightbox, getImageLightbox);

  if (!state) {
    return null;
  }
  return (
    <DialogRoot onDismiss={closeImageLightbox} className="image-lightbox">
      <Dialog variant="media" aria-label={state.alt} onClick={closeImageLightbox}>
        <Button
          className="image-lightbox-close"
          aria-label="Close image"
          onClick={closeImageLightbox}
        >
          ✕
        </Button>
        {/* Stop the click on the image itself from dismissing, so only the
          backdrop (and the explicit close button) close the lightbox. */}
        <img
          className="image-lightbox-img"
          src={state.src}
          alt={state.alt}
          onClick={(event) => event.stopPropagation()}
        />
      </Dialog>
    </DialogRoot>
  );
}
