import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "DOMRect"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});
dom.window.HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
const { createRoot } = await import("react-dom/client");
const { default: BrowserOverlay } = await import("../src/components/BrowserOverlay");
const { hideAllHumanBrowsers } = await import("../src/lib/api");
const container = document.getElementById("root")!;
let root = createRoot(container);

const props = {
  paneId: "pane-a",
  url: "https://example.com/",
  reloadNonce: 0,
  sandbox: false,
  mode: "webkit" as const,
  bodyFontId: "system",
  initialPreviewScroll: null,
  fullWidth: false,
  occluded: false,
  geometryRevision: 0,
  onNavigate: () => {},
  onLocationChange: () => {},
  onPreviewScroll: () => {},
  onRefresh: () => {},
  onOpenExternal: () => {},
  onClose: () => {},
  onModeChange: () => {},
  onResize: () => {},
  onFullWidthChange: () => {},
};

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.ok(predicate(), "browser operation did not complete");
}

afterEach(async () => {
  await act(() => root.unmount());
  await hideAllHumanBrowsers();
  clearMocks();
  root = createRoot(container);
});
after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

function stalledCreation() {
  let release!: () => void;
  const creation = new Promise<void>(resolve => { release = resolve; });
  let creating = false;
  let first = true;
  let busyAttempts = 0;
  let visible = false;
  let shows = 0;
  let shownUrl: string | null = null;
  mockIPC(async (command, args) => {
    if (command === "human_browser_generation") return 1;
    if (command === "human_browser_hide_all") {
      visible = false;
      return true;
    }
    if (command === "human_browser_sync") {
      const request = (args as { request: { visible: boolean; url: string } }).request;
      if (!request.visible) {
        visible = false;
        return { applied: true, snapshot: null };
      }
      shows += 1;
      if (first) {
        first = false;
        creating = true;
        await creation;
        creating = false;
        return { applied: false, snapshot: null };
      }
      if (creating) {
        busyAttempts += 1;
        throw new Error("human browser lifecycle is busy; retry the request");
      }
      visible = true;
      shownUrl = request.url;
      return { applied: true, snapshot: null };
    }
    if (command === "human_browser_snapshot") return null;
    return undefined;
  });
  return {
    release,
    isCreating: () => creating,
    isVisible: () => visible,
    busyAttempts: () => busyAttempts,
    shows: () => shows,
    shownUrl: () => shownUrl,
  };
}

async function reopenDuringCreation(backend: ReturnType<typeof stalledCreation>) {
  await act(() => root.render(h(BrowserOverlay, props)));
  await eventually(backend.isCreating);
  await act(async () => {
    await hideAllHumanBrowsers();
    root.render(null);
  });
  await act(() => root.render(h(BrowserOverlay, props)));
  await eventually(() => backend.busyAttempts() >= 5);
}

test("reopening recovers when old native creation outlasts the short busy retry", async () => {
  const backend = stalledCreation();
  await reopenDuringCreation(backend);
  await act(async () => { backend.release(); });
  await eventually(backend.isVisible);
  assert.equal(container.querySelector(".browser-overlay-native-slot")?.textContent, "");
});

test("unmount cancels a deferred retry after reopening during native creation", async () => {
  const backend = stalledCreation();
  await reopenDuringCreation(backend);
  await act(() => root.render(null));
  const shows = backend.shows();
  await act(async () => {
    backend.release();
    await new Promise(resolve => setTimeout(resolve, 600));
  });
  assert.equal(backend.shows(), shows);
  assert.equal(backend.isVisible(), false);
});

test("a newer navigation can recover immediately and cancels the deferred retry", async () => {
  const backend = stalledCreation();
  await reopenDuringCreation(backend);
  await act(async () => { backend.release(); });
  const url = "https://example.com/new";
  await act(() => root.render(h(BrowserOverlay, { ...props, url, reloadNonce: 1 })));
  await eventually(backend.isVisible);
  assert.equal(backend.shownUrl(), url);
  const shows = backend.shows();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  assert.equal(backend.shows(), shows);
});
