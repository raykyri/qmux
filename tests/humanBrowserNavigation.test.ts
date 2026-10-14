import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, useState } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "DOMRect"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
let nextFrame = 0;
const frames = new Map<number, () => void>();
let nextInterval = 0;
const intervals = new Map<number, () => void>();
Object.assign(dom.window, {
  setInterval: (callback: () => void) => {
    const id = ++nextInterval;
    intervals.set(id, callback);
    return id;
  },
  clearInterval: (id: number) => intervals.delete(id),
});
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  ResizeObserver: class { observe() {} disconnect() {} },
});
dom.window.HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
const { createRoot } = await import("react-dom/client");
const { default: BrowserOverlay } = await import("../src/components/BrowserOverlay");
const { hideAllHumanBrowsers } = await import("../src/lib/api");
const container = document.getElementById("root")!;
let root = createRoot(container);
const initialUrl = "https://example.com/old";
const desiredUrl = "https://example.com/new";
let navigate!: (url: string) => void;

function Overlay() {
  const [state, setState] = useState({ url: initialUrl, reloadNonce: 0 });
  navigate = url => setState(previous => ({ url, reloadNonce: previous.reloadNonce + 1 }));
  return h(BrowserOverlay, {
    ...state,
    paneId: "pane-a",
    sandbox: false,
    bodyFontId: "system",
    initialPreviewScroll: null,
    fullWidth: false,
    occluded: false,
    geometryRevision: 0,
    onNavigate: navigate,
    onLocationChange: url => setState(previous => ({ ...previous, url })),
    onPreviewScroll: () => {},
    onRefresh: () => {},
    onOpenExternal: () => {},
    onClose: () => {},
    onResize: () => {},
    onFullWidthChange: () => {},
  });
}

async function paint() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) frame();
  });
}

afterEach(async () => {
  await act(() => root.unmount());
  await hideAllHumanBrowsers();
  clearMocks();
  frames.clear();
  intervals.clear();
  root = createRoot(container);
});
after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

for (const duringSync of [false, true]) {
  test(`an old page popup cannot replace typed navigation ${duringSync ? "during native sync" : "before its frame"}`, async () => {
    const requests: { url: string; visible: boolean }[] = [];
    let completeNavigation: ((value: unknown) => void) | undefined;
    mockIPC((command, args) => {
      if (command === "human_browser_generation") return 1;
      if (command === "human_browser_hide_all") return true;
      if (command === "human_browser_sync") {
        const request = (args as { request: (typeof requests)[number] }).request;
        if (request.visible) requests.push(request);
        if (duringSync && request.visible && requests.length === 2) {
          return new Promise(resolve => { completeNavigation = resolve; });
        }
        return { applied: true, snapshot: null };
      }
      return undefined;
    }, { shouldMockEvents: true });
    await act(() => root.render(h(Overlay)));
    await paint();
    await act(() => navigate(desiredUrl));
    if (duringSync) await paint();
    await act(async () => {
      await emit("human-browser-event", {
        ownerId: "pane-a", kind: "newWindow", url: "https://example.com/old-popup", title: null, loading: null,
      });
    });
    if (completeNavigation) {
      await act(async () => completeNavigation!({ applied: true, snapshot: null }));
    }
    await paint();
    assert.equal(container.querySelector("input")?.value, desiredUrl);
    assert.equal(requests.at(-1)?.url, desiredUrl);

    const popupUrl = "https://example.com/current-popup";
    await act(async () => {
      await emit("human-browser-event", {
        ownerId: "pane-a", kind: "newWindow", url: popupUrl, title: null, loading: null,
      });
    });
    await paint();
    assert.equal(container.querySelector("input")?.value, popupUrl);
    assert.equal(requests.at(-1)?.url, popupUrl);
  });
}

for (const kind of ["title", "navigation"] as const) {
  test(`old page ${kind} event cannot replace a typed URL before native navigation`, async () => {
    const requests: { url: string; navigationRevision: number; visible: boolean }[] = [];
    mockIPC((command, args) => {
      if (command === "human_browser_generation") return 1;
      if (command === "human_browser_hide_all") return true;
      if (command === "human_browser_sync") {
        const request = (args as { request: (typeof requests)[number] }).request;
        if (request.visible) requests.push(request);
        return { applied: true, snapshot: null };
      }
      if (command === "human_browser_snapshot") return null;
      return undefined;
    }, { shouldMockEvents: true });
    await act(() => root.render(h(Overlay)));
    await paint();
    assert.equal(requests.at(-1)?.url, initialUrl);
    await act(() => navigate(desiredUrl));
    assert.equal(requests.length, 1, "navigation waits for the next animation frame");
    await act(async () => {
      await emit("human-browser-event", {
        ownerId: "pane-a", kind, url: initialUrl, title: "Old page changed title", loading: false,
      });
    });
    await paint();
    assert.equal(requests.at(-1)?.navigationRevision, 1);
    assert.equal(requests.at(-1)?.url, desiredUrl);
    const redirectedUrl = "https://example.com/redirected";
    await act(async () => {
      await emit("human-browser-event", {
        ownerId: "pane-a", kind, url: redirectedUrl, title: "New page", loading: false,
      });
    });
    assert.equal(container.querySelector("input")?.value, redirectedUrl);
    await paint();
    assert.equal(requests.at(-1)?.url, redirectedUrl);
    assert.equal(requests.at(-1)?.navigationRevision, 1);
  });
}

test("a late location poll cannot restore the page preceding a native navigation event", async () => {
  let resolveSnapshot!: (snapshot: unknown) => void;
  mockIPC((command, args) => {
    if (command === "human_browser_generation") return 1;
    if (command === "human_browser_hide_all") return true;
    if (command === "human_browser_sync") {
      const request = (args as { request: { url: string } }).request;
      return { applied: true, snapshot: {
        ownerId: "pane-a", url: request.url, canGoBack: request.url !== initialUrl, canGoForward: false,
      } };
    }
    if (command === "human_browser_snapshot") {
      return new Promise(resolve => { resolveSnapshot = resolve; });
    }
    return undefined;
  }, { shouldMockEvents: true });
  await act(() => root.render(h(Overlay)));
  await paint();
  await act(async () => {
    for (const poll of intervals.values()) poll();
  });
  assert.ok(resolveSnapshot, "the location poll started");
  await act(async () => {
    await emit("human-browser-event", {
      ownerId: "pane-a", kind: "navigation", url: desiredUrl, title: null, loading: false,
    });
  });
  await paint();
  await act(async () => resolveSnapshot({
    ownerId: "pane-a", url: initialUrl, canGoBack: false, canGoForward: true,
  }));
  assert.equal(container.querySelector("input")?.value, desiredUrl);
  assert.equal(container.querySelector<HTMLButtonElement>('button[title="Go back"]')?.disabled, false);
});

for (const kind of ["title", "navigation"] as const) {
  test(`old page ${kind} event cannot replace a typed URL while native sync is pending`, async () => {
    const requests: { url: string; navigationRevision: number; visible: boolean }[] = [];
    let completeNavigation!: (value: unknown) => void;
    mockIPC((command, args) => {
      if (command === "human_browser_generation") return 1;
      if (command === "human_browser_hide_all") return true;
      if (command === "human_browser_sync") {
        const request = (args as { request: (typeof requests)[number] }).request;
        if (request.visible) requests.push(request);
        if (request.visible && requests.length === 2) {
          return new Promise(resolve => { completeNavigation = resolve; });
        }
        return { applied: true, snapshot: null };
      }
      return undefined;
    }, { shouldMockEvents: true });
    await act(() => root.render(h(Overlay)));
    await paint();
    await act(() => navigate(desiredUrl));
    await paint();
    assert.equal(requests.at(-1)?.url, desiredUrl);
    await act(async () => {
      await emit("human-browser-event", {
        ownerId: "pane-a", kind, url: initialUrl, title: "Old page", loading: false,
      });
    });
    await act(async () => completeNavigation({ applied: true, snapshot: null }));
    await paint();
    assert.equal(container.querySelector("input")?.value, desiredUrl);
    assert.equal(requests.at(-1)?.url, desiredUrl);
  });
}

test("a redirect emitted before native navigation acknowledgement is recovered by polling", async context => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  const redirectedUrl = "https://example.com/redirected";
  let completeNavigation!: (value: unknown) => void;
  mockIPC((command, args) => {
    if (command === "human_browser_generation") return 1;
    if (command === "human_browser_hide_all") return true;
    if (command === "human_browser_sync") {
      const request = (args as { request: { url: string; visible: boolean } }).request;
      if (request.visible && request.url === desiredUrl) {
        return new Promise(resolve => { completeNavigation = resolve; });
      }
      return { applied: true, snapshot: null };
    }
    if (command === "human_browser_snapshot") {
      return { ownerId: "pane-a", url: redirectedUrl, canGoBack: true, canGoForward: false };
    }
    return undefined;
  }, { shouldMockEvents: true });
  await act(() => root.render(h(Overlay)));
  await paint();
  await act(() => navigate(desiredUrl));
  await paint();
  await act(async () => {
    await emit("human-browser-event", {
      ownerId: "pane-a", kind: "navigation", url: redirectedUrl, title: null, loading: false,
    });
  });
  await act(async () => completeNavigation({ applied: true, snapshot: null }));
  now = 2000;
  await act(async () => {
    for (const poll of intervals.values()) poll();
  });
  assert.equal(container.querySelector("input")?.value, redirectedUrl);
  assert.equal(container.querySelector<HTMLButtonElement>('button[title="Go back"]')?.disabled, false);
});

test("a sync snapshot cannot replace history state after a newer native navigation event", async () => {
  let visibleSyncs = 0;
  let completeSync!: (value: unknown) => void;
  mockIPC((command, args) => {
    if (command === "human_browser_generation") return 1;
    if (command === "human_browser_hide_all") return true;
    if (command === "human_browser_sync") {
      const request = (args as { request: { visible: boolean } }).request;
      if (request.visible && ++visibleSyncs === 2) {
        return new Promise(resolve => { completeSync = resolve; });
      }
      return { applied: true, snapshot: {
        ownerId: "pane-a", url: initialUrl, canGoBack: true, canGoForward: false,
      } };
    }
    return undefined;
  }, { shouldMockEvents: true });
  await act(() => root.render(h(Overlay)));
  await paint();
  await act(() => window.dispatchEvent(new dom.window.Event("resize")));
  await paint();
  await act(async () => {
    await emit("human-browser-event", {
      ownerId: "pane-a", kind: "navigation", url: desiredUrl, title: null, loading: false,
    });
  });
  await act(async () => completeSync({ applied: true, snapshot: {
    ownerId: "pane-a", url: initialUrl, canGoBack: false, canGoForward: true,
  } }));
  assert.equal(container.querySelector("input")?.value, desiredUrl);
  assert.equal(container.querySelector<HTMLButtonElement>('button[title="Go back"]')?.disabled, false);
});
