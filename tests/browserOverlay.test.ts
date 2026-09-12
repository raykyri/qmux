import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserOverlayState } from "../src/appTypes";
import {
  anyBrowserOverlayOpen,
  browserOverlayIsOpen,
  browserOverlayShowsLink,
  closeAllBrowserOverlaysState,
  closeBrowserOverlayState,
  resolveTranscriptOrBrowserToggle,
} from "../src/lib/browserOverlay";

function overlay(overrides: Partial<BrowserOverlayState> = {}): BrowserOverlayState {
  return {
    url: "https://example.com/",
    open: true,
    reloadNonce: 1,
    sandbox: false,
    mode: "webkit",
    size: null,
    ...overrides,
  };
}

test("anyBrowserOverlayOpen looks at every owner, not just the active tab", () => {
  assert.equal(anyBrowserOverlayOpen({}), false);
  assert.equal(anyBrowserOverlayOpen({ a: overlay({ open: false }) }), false);
  assert.equal(
    anyBrowserOverlayOpen({
      a: overlay({ open: false }),
      b: overlay(),
    }),
    true,
  );
  assert.equal(browserOverlayIsOpen(overlay()), true);
  assert.equal(browserOverlayIsOpen(overlay({ open: false })), false);
});

test("closeAllBrowserOverlaysState closes every owner and preserves identity when already closed", () => {
  const alreadyClosed = { a: overlay({ open: false }) };
  assert.equal(closeAllBrowserOverlaysState(alreadyClosed), alreadyClosed);

  const closed = closeAllBrowserOverlaysState({
    a: overlay(),
    b: overlay({ open: false, url: "https://kept.example/" }),
  });
  assert.equal(closed.a.open, false);
  assert.equal(closed.b.open, false);
  assert.equal(closed.b.url, "https://kept.example/");
});

test("browserOverlayShowsLink matches the open document, not a reload of a different page", () => {
  const token = "a".repeat(64);
  const fileUrl = `http://127.0.0.1:8123/${token}/tmp/preview.html`;
  const fileOverlay = overlay({ url: fileUrl, sandbox: true });
  assert.equal(browserOverlayShowsLink(fileOverlay, { path: "/tmp/preview.html" }, 8123), true);
  assert.equal(
    browserOverlayShowsLink(fileOverlay, { path: "/private/tmp/preview.html" }, 8123),
    true,
  );
  assert.equal(browserOverlayShowsLink(fileOverlay, { path: "/tmp/other.html" }, 8123), false);
  assert.equal(
    browserOverlayShowsLink({ ...fileOverlay, open: false }, { path: "/tmp/preview.html" }, 8123),
    false,
  );

  const web = overlay({ url: "https://example.com/report.html#old" });
  assert.equal(browserOverlayShowsLink(web, { url: "https://example.com/report.html" }, null), true);
  assert.equal(browserOverlayShowsLink(web, { url: "https://example.com/other.html" }, null), false);
});

test("closeBrowserOverlayState closes only the requested owner", () => {
  const overlays = {
    a: overlay(),
    b: overlay({ url: "https://kept.example/" }),
  };
  const closed = closeBrowserOverlayState(overlays, "a");
  assert.equal(closed.a.open, false);
  assert.equal(closed.b.open, true);
  assert.equal(closeBrowserOverlayState({ a: overlay({ open: false }) }, "a").a.open, false);
});

test("⌘⇧E closes a live browser instead of expanding the transcript", () => {
  assert.deepEqual(
    resolveTranscriptOrBrowserToggle({
      anyBrowserOpen: true,
      canToggleTranscript: true,
    }),
    { type: "close-browser" },
  );
  assert.deepEqual(
    resolveTranscriptOrBrowserToggle({
      anyBrowserOpen: false,
      canToggleTranscript: true,
    }),
    { type: "toggle-transcript" },
  );
  assert.deepEqual(
    resolveTranscriptOrBrowserToggle({
      anyBrowserOpen: false,
      canToggleTranscript: false,
    }),
    { type: "toggle-browser" },
  );
});
