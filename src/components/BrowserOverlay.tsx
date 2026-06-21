// The browser overlay floats over the sidebar + center terminal (leaving a left
// strip of the tabs visible) and renders a URL bound to the active tab. The URL is a
// loopback file-server URL or a localhost dev server, both built/allowed by the
// backend, so the iframe just loads what it's given.
interface BrowserOverlayProps {
  url: string | null;
  // Bumped on open/refresh so the iframe key changes and the page reloads.
  reloadNonce: number;
}

export default function BrowserOverlay({ url, reloadNonce }: BrowserOverlayProps) {
  return (
    <div className="browser-overlay" role="region" aria-label="Browser overlay">
      {url ? (
        <iframe
          key={`${url}::${reloadNonce}`}
          className="browser-overlay-frame"
          src={url}
          title="Browser overlay"
        />
      ) : (
        <div className="browser-overlay-empty">
          <p>
            Nothing loaded yet. Run <code>qmux open &lt;file&gt;</code> (or a
            <code>http://localhost</code> URL) to render a page here.
          </p>
        </div>
      )}
    </div>
  );
}
