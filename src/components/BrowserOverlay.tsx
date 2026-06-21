import { RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";

// The browser overlay floats over the sidebar + center terminal (leaving a left
// strip of the tabs visible) and renders a URL bound to the active tab. A minimal
// navigation bar at the top shows the current URL and lets the user navigate, with
// refresh + close controls pinned to its right.
interface BrowserOverlayProps {
  url: string | null;
  // Bumped on open/refresh so the iframe key changes and the page reloads.
  reloadNonce: number;
  // True for token-bearing file-server URLs: sandbox the frame so served (possibly
  // untrusted) content gets an opaque origin and can't read the token back to fetch
  // other workspace files. Left off for trusted localhost dev servers, which need a
  // real same-origin context to function.
  sandbox: boolean;
  // Navigate to a typed address (a URL, or a bare host that gets http:// prefixed).
  onNavigate: (rawInput: string) => void;
  // Reload the current page.
  onRefresh: () => void;
  // Close the overlay.
  onClose: () => void;
}

export default function BrowserOverlay({
  url,
  reloadNonce,
  sandbox,
  onNavigate,
  onRefresh,
  onClose,
}: BrowserOverlayProps) {
  // Editable copy of the address, re-synced whenever the loaded URL changes so the
  // bar tracks navigation without clobbering what the user is mid-typing.
  const [draft, setDraft] = useState(url ?? "");
  useEffect(() => {
    setDraft(url ?? "");
  }, [url]);

  return (
    <div className="browser-overlay" role="region" aria-label="Browser overlay">
      <div className="browser-overlay-nav">
        <form
          className="browser-overlay-nav-form"
          onSubmit={(event) => {
            event.preventDefault();
            onNavigate(draft);
            event.currentTarget.querySelector("input")?.blur();
          }}
        >
          <input
            type="text"
            className="browser-overlay-url"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(url ?? "");
                event.currentTarget.blur();
              }
            }}
            placeholder="Enter a URL"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-label="Address"
          />
        </form>
        <div className="browser-overlay-nav-controls">
          <button
            type="button"
            className="browser-overlay-button"
            title="Refresh browser"
            aria-label="Refresh browser"
            onClick={onRefresh}
          >
            <RotateCw size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="browser-overlay-button"
            title="Hide browser"
            aria-label="Hide browser"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="browser-overlay-body">
        {url ? (
          <iframe
            key={`${url}::${reloadNonce}`}
            className="browser-overlay-frame"
            src={url}
            title="Browser overlay"
            // allow-scripts (so scripted reports still render) without
            // allow-same-origin (opaque origin → can't read the token-gated server).
            sandbox={sandbox ? "allow-scripts" : undefined}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="browser-overlay-empty">
            <p>
              Nothing loaded yet. Run <code>qmux open &lt;file&gt;</code> (or enter a
              <code>http://localhost</code> URL above) to render a page here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
