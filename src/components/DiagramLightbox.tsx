import { useSyncExternalStore } from "react";
import { Button, Dialog, DialogRoot } from "./ui";
import {
  closeDiagramLightbox,
  getDiagramLightbox,
  subscribeDiagramLightbox,
} from "../lib/diagramLightbox";

// The shared dialog owns DOM focus containment/restoration. App's window
// capture dispatcher still handles Escape first, preserving overlay ordering.
export default function DiagramLightbox() {
  const state = useSyncExternalStore(
    subscribeDiagramLightbox,
    getDiagramLightbox,
    getDiagramLightbox,
  );

  if (!state) {
    return null;
  }
  return (
    <DialogRoot onDismiss={closeDiagramLightbox} className="diagram-lightbox">
      <Dialog
        variant="media"
        aria-label={`Expanded ${state.label} diagram`}
        onClick={closeDiagramLightbox}
      >
        <Button
          className="image-lightbox-close"
          aria-label="Close diagram"
          onClick={closeDiagramLightbox}
        >
          ✕
        </Button>
        <div className="diagram-lightbox-panel" onClick={(event) => event.stopPropagation()}>
          <div className="diagram-lightbox-lang">{state.label}</div>
          {/* Reuses .turn-diagram-svg so the expanded diagram renders exactly
            like the inline one (font override, graphviz light canvas). The
            click handler swallows everything: an injected anchor must not
            navigate its inert href="#" and a panel click must not bubble to
            the backdrop, which would dismiss the lightbox. Diagram links stay
            clickable in the inline view; this surface is for reading. */}
          <div
            className="turn-diagram-svg diagram-lightbox-canvas"
            data-lang={state.lang}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </div>
      </Dialog>
    </DialogRoot>
  );
}
