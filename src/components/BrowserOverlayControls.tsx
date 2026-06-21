import { Globe, RotateCw, X } from "lucide-react";

// Floating controls pinned to the top-right of the terminal (and of the browser when
// it's open): a toggle, with a refresh button to its left while the overlay is open.
interface BrowserOverlayControlsProps {
  open: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}

export default function BrowserOverlayControls({
  open,
  onToggle,
  onRefresh,
}: BrowserOverlayControlsProps) {
  return (
    <div className="browser-overlay-controls">
      {open ? (
        <button
          type="button"
          className="browser-overlay-button"
          title="Refresh browser"
          aria-label="Refresh browser"
          onClick={onRefresh}
        >
          <RotateCw size={14} aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        className={`browser-overlay-button${open ? " is-active" : ""}`}
        title={open ? "Hide browser" : "Show browser"}
        aria-label={open ? "Hide browser" : "Show browser"}
        aria-pressed={open}
        onClick={onToggle}
      >
        {open ? <X size={14} aria-hidden="true" /> : <Globe size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}
