import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { BrowserOverlayState } from "../src/appTypes";
import {
  anyBrowserOverlayOpen,
  browserPreviewScrollFor,
  browserOverlayIsOpen,
  browserOverlayShowsLink,
  browserOverlayTerminalFocusTarget,
  closeAllBrowserOverlaysState,
  closeBrowserOverlayState,
  previewCanvasColor,
  pruneBrowserPreviewScroll,
  rememberBrowserPreviewScroll,
  resolveTranscriptOrBrowserToggle,
  type BrowserPreviewScrollCache,
} from "../src/lib/browserOverlay";

function overlay(overrides: Partial<BrowserOverlayState> = {}): BrowserOverlayState {
  return {
    url: "https://example.com/",
    open: true,
    reloadNonce: 1,
    sandbox: false,
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

test("browser close focuses only an open terminal owner", () => {
  const overlays = {
    "pane-a": overlay(),
    "pane-closed": overlay({ open: false }),
    "research-tree": overlay(),
  };
  const terminalPaneIds = new Set(["pane-a", "pane-closed"]);
  assert.equal(browserOverlayTerminalFocusTarget(overlays, "pane-a", terminalPaneIds), "pane-a");
  assert.equal(browserOverlayTerminalFocusTarget(overlays, "pane-closed", terminalPaneIds), null);
  assert.equal(browserOverlayTerminalFocusTarget(overlays, "research-tree", terminalPaneIds), null);
  assert.equal(browserOverlayTerminalFocusTarget(overlays, null, terminalPaneIds), null);
});

test("browser preview scroll survives owner switches without crossing URLs", () => {
  const cache: BrowserPreviewScrollCache = new Map();
  const position = { url: "http://127.0.0.1/doc.md", x: 12, y: 480 };
  rememberBrowserPreviewScroll(cache, "pane-a", position);

  assert.equal(browserPreviewScrollFor(cache, "pane-a", position.url), position);
  assert.equal(browserPreviewScrollFor(cache, "pane-b", position.url), null);
  assert.equal(browserPreviewScrollFor(cache, "pane-a", "http://127.0.0.1/other.md"), null);

  pruneBrowserPreviewScroll(cache, new Set(["pane-b"]));
  assert.equal(cache.size, 0);
});

test("preview canvas colors are opaque computed colors only", () => {
  assert.equal(previewCanvasColor("rgb(30, 34, 39)"), "rgb(30, 34, 39)");
  assert.equal(previewCanvasColor("  rgba(30, 34, 39, 1)  "), "rgba(30, 34, 39, 1)");
  assert.equal(previewCanvasColor("rgb(30 34 39)"), "rgb(30 34 39)");
  assert.equal(previewCanvasColor("rgb(30 34 39 / 1)"), "rgb(30 34 39 / 1)");
  assert.equal(previewCanvasColor("rgba(255, 255, 255, 1.0)"), "rgba(255, 255, 255, 1.0)");
  assert.equal(previewCanvasColor("rgba(30, 34, 39, 0.4)"), null);
  assert.equal(previewCanvasColor("rgb(30 34 39 / 0)"), null);
  assert.equal(previewCanvasColor("rgb(256, 0, 0)"), null);
  assert.equal(previewCanvasColor("#1e2227"), null);
  assert.equal(previewCanvasColor("rgb(0, 0, 0) url(https://example.test)"), null);
  assert.equal(previewCanvasColor("transparent"), null);
  assert.equal(previewCanvasColor(null), null);
});

test("the file preview canvas matches rendered markdown and source pages", () => {
  const root = join(import.meta.dirname, "..");
  const tokens = readFileSync(join(root, "src/styles/tokens.css"), "utf8");
  const fileServer = readFileSync(join(root, "src-tauri/src/file_server.rs"), "utf8");
  assert.match(tokens, /--preview-canvas-bg: #1e2227;/);
  assert.match(tokens, /--preview-canvas-bg: #ffffff;/);
  assert.match(fileServer, /html, body \{ background: #ffffff; color: #1f2328; \}/);
  assert.match(fileServer, /html, body \{ background: #1e2227; color: #e2e6ea; \}/);
  assert.match(fileServer, /qmux-preview-canvas/);
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
