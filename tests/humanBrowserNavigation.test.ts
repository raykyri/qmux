import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, useState } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import {
  humanBrowserNavigationStateFor,
  pruneHumanBrowserNavigationState,
  type HumanBrowserNavigationState,
} from "../src/lib/humanBrowserState";

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
const { destroyHumanBrowser, hideAllHumanBrowsers } = await import("../src/lib/api");
const container = document.getElementById("root")!;
let root = createRoot(container);
const initialUrl = "https://example.com/old";
const desiredUrl = "https://example.com/new";
let navigate!: (url: string) => void;
let setOccluded!: (occluded: boolean) => void;
let setPane!: (paneId: string) => void;
let setOpen!: (open: boolean) => void;
let renderedState: { url: string; reloadNonce: number };
let navigationByOwner: Map<string, HumanBrowserNavigationState>;

function Overlay() {
  const [open, updateOpen] = useState(true);
  setOpen = updateOpen;
  const [cache] = useState(() => new Map<string, HumanBrowserNavigationState>());
  navigationByOwner = cache;
  const [occluded, updateOccluded] = useState(false);
  const [paneId, updatePane] = useState("pane-a");
  setOccluded = updateOccluded;
  setPane = updatePane;
  const [state, setState] = useState({ url: initialUrl, reloadNonce: 0 });
  renderedState = state;
  navigate = url => setState(previous => ({ url, reloadNonce: previous.reloadNonce + 1 }));
  return open ? h(BrowserOverlay, {
    ...state,
    key: paneId,
    paneId,
    navigationState: humanBrowserNavigationStateFor(cache, paneId),
    sandbox: false,
    bodyFontId: "system",
    initialPreviewScroll: null,
    fullWidth: false,
    occluded,
    geometryRevision: 0,
    onNavigate: navigate,
    onLocationChange: url => setState(previous => ({ ...previous, url })),
    onPreviewScroll: () => {},
    onRefresh: () => {},
    onOpenExternal: () => {},
    onClose: () => {},
    onResize: () => {},
    onFullWidthChange: () => {},
  }) : null;
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

type NativeRequest = {
  ownerId: string;
  url: string;
  navigationRevision: number;
  generation: number;
  revision: number;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

// A minimal native contract fixture, not a WebKit implementation. Keep the two
// revision domains separate, as in human_browser.rs: surface revisions fence
// ownership/geometry, while only a *greater* navigation revision loads/reloads.
// beforeSync models validation/busy failures; afterCommit models a failed native
// surface transition after navigation_revision and bounds have been stored.
function nativeBrowser() {
  type View = {
    url: string;
    navigationRevision: number;
    bounds: { x: number; y: number; width: number; height: number };
    canGoBack: boolean;
    canGoForward: boolean;
  };
  const views = new Map<string, View>();
  const ownerRevisions = new Map<string, number>();
  let latestSurfaceRevision = 0;
  const requests: NativeRequest[] = [];
  const navigations: { kind: "create" | "navigate" | "reload"; url: string }[] = [];
  const hooks: {
    beforeSync?: (request: NativeRequest) => void | Promise<void>;
    afterCommit?: (request: NativeRequest) => void | Promise<void>;
    snapshot?: (ownerId: string) => unknown;
  } = {};
  const snapshot = (ownerId = "pane-a") => {
    const view = views.get(ownerId);
    return view ? {
      ownerId, url: view.url, canGoBack: view.canGoBack, canGoForward: view.canGoForward,
    } : null;
  };
  mockIPC(async (command, args) => {
    if (command === "human_browser_generation") return 1;
    if (command === "human_browser_hide_all") {
      latestSurfaceRevision = (args as { request: { revision: number } }).request.revision;
      return true;
    }
    if (command === "human_browser_snapshot") {
      const { ownerId } = (args as { request: { ownerId: string } }).request;
      return hooks.snapshot ? hooks.snapshot(ownerId) : snapshot(ownerId);
    }
    if (command === "human_browser_destroy") {
      const { ownerId, revision } = (args as { request: { ownerId: string; revision: number } }).request;
      ownerRevisions.set(ownerId, revision);
      views.delete(ownerId);
      return undefined;
    }
    if (command !== "human_browser_sync") return undefined;
    const request = (args as { request: NativeRequest }).request;
    if (!request.visible) {
      ownerRevisions.set(request.ownerId, request.revision);
      return { applied: true, snapshot: null };
    }
    requests.push(request);
    await hooks.beforeSync?.(request);
    if (request.generation !== 1 || request.revision <= latestSurfaceRevision ||
        request.revision <= (ownerRevisions.get(request.ownerId) ?? 0)) {
      return { applied: false, snapshot: null };
    }
    latestSurfaceRevision = request.revision;
    ownerRevisions.set(request.ownerId, request.revision);
    let view = views.get(request.ownerId);
    if (!view) {
      navigations.push({ kind: "create", url: request.url });
      view = {
        url: request.url, navigationRevision: request.navigationRevision,
        bounds: request, canGoBack: false, canGoForward: false,
      };
      views.set(request.ownerId, view);
    } else if (request.navigationRevision > view.navigationRevision) {
      navigations.push({ kind: view.url === request.url ? "reload" : "navigate", url: request.url });
      view.canGoBack ||= view.url !== request.url;
      view.url = request.url;
      view.navigationRevision = request.navigationRevision;
    }
    view.bounds = { x: request.x, y: request.y, width: request.width, height: request.height };
    await hooks.afterCommit?.(request);
    return { applied: true, snapshot: snapshot(request.ownerId) };
  }, { shouldMockEvents: true });
  return { requests, navigations, hooks, views, snapshot };
}

async function locationEvent(url: string, kind = "navigation", ownerId = "pane-a") {
  await act(async () => {
    await emit("human-browser-event", { ownerId, kind, url, title: null, loading: false });
  });
}

async function poll() {
  await act(async () => {
    for (const callback of intervals.values()) callback();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const recovery of ["event", "poll"] as const) {
  test(`a rejected navigation recovers by ${recovery} without reloading the surviving document`, async context => {
    let now = 0;
    context.mock.method(performance, "now", () => now);
    const native = nativeBrowser();
    await act(() => root.render(h(Overlay)));
    await paint();
    native.hooks.beforeSync = request => {
      if (request.url === desiredUrl) throw new Error("refusing to navigate the human browser to qmux's app origin");
    };
    await act(() => navigate(desiredUrl));
    await paint();
    assert.match(container.textContent!, /refusing to navigate/);
    const actualUrl = `${initialUrl}#section`;
    native.views.get("pane-a")!.url = actualUrl;
    native.views.get("pane-a")!.canGoBack = true;
    if (recovery === "event") {
      await locationEvent(actualUrl, "title");
    } else {
      await poll();
      assert.equal(container.querySelector("input")?.value, desiredUrl, "keep the navigation grace interval");
      now = 2000;
      await poll();
    }
    assert.equal(container.querySelector("input")?.value, actualUrl);
    assert.equal(renderedState.reloadNonce, 1, "App location feedback does not create navigation intent");
    await paint(); // Include the observed URL -> App state -> surface sync round trip.
    await poll();
    assert.deepEqual(native.navigations, [{ kind: "create", url: initialUrl }]);
    assert.equal(native.requests.at(-1)?.navigationRevision, 0);
    assert.equal(container.querySelector<HTMLButtonElement>('button[title="Go back"]')?.disabled, false);
    assert.match(container.textContent!, /refusing to navigate/, "location/geometry recovery retains the navigation error");

    native.hooks.beforeSync = undefined;
    await act(() => navigate(actualUrl));
    await paint();
    assert.equal(native.requests.at(-1)?.navigationRevision, 2);
    assert.deepEqual(native.navigations.at(-1), { kind: "reload", url: actualUrl });
    assert.doesNotMatch(container.textContent!, /refusing to navigate/);
  });
}

test("a post-commit failure recovers its redirect and geometry with a lower navigation revision", async context => {
  const native = nativeBrowser();
  await act(() => root.render(h(Overlay)));
  await paint();
  native.hooks.afterCommit = request => {
    if (request.navigationRevision === 1) {
      native.views.get("pane-a")!.url = "https://example.com/redirected";
      throw new Error("failed to show native browser surface");
    }
  };
  await act(() => navigate(desiredUrl));
  await paint();
  assert.equal(native.views.get("pane-a")?.navigationRevision, 1, "native commit preceded rejection");
  native.hooks.afterCommit = undefined;
  context.mock.method(dom.window.HTMLElement.prototype, "getBoundingClientRect", () => new DOMRect(20, 30, 640, 480));
  await act(() => window.dispatchEvent(new dom.window.Event("resize")));
  await paint();
  assert.deepEqual(native.views.get("pane-a")?.bounds, { x: 20, y: 30, width: 640, height: 480 });
  assert.equal(native.requests.at(-1)?.navigationRevision, 0, "a rejected operation is not an acknowledgement");
  assert.ok(native.requests.at(-1)!.revision > native.requests.at(-2)!.revision, "surface ownership still advances");
  await locationEvent("https://example.com/redirected");
  await paint();
  assert.equal(container.querySelector("input")?.value, "https://example.com/redirected");
  assert.equal(native.navigations.length, 2, "geometry and observed redirects never navigate or reload");
  assert.match(container.textContent!, /failed to show native browser surface/);
});

test("a failed newer request preserves the last acknowledged native revision", async () => {
  const native = nativeBrowser();
  await act(() => root.render(h(Overlay)));
  await paint();
  await act(() => navigate(desiredUrl));
  await paint();
  native.hooks.beforeSync = request => {
    if (request.navigationRevision === 2) throw new Error("navigation failed");
  };
  await act(() => navigate("https://example.com/rejected"));
  await paint();
  await locationEvent(desiredUrl);
  await paint();
  assert.equal(native.requests.at(-1)?.navigationRevision, 1);
  assert.equal(native.navigations.length, 2);
  assert.equal(container.querySelector("input")?.value, desiredUrl);
});

test("an older rejection cannot settle, retry, or display an error for a newer pending navigation", async () => {
  const native = nativeBrowser();
  await act(() => root.render(h(Overlay)));
  await paint();
  const old = deferred<void>();
  const current = deferred<void>();
  native.hooks.beforeSync = request => {
    if (request.navigationRevision === 1) return old.promise;
    if (request.navigationRevision === 2) return current.promise;
  };
  await act(() => navigate(desiredUrl));
  await paint();
  const latestUrl = "https://example.com/latest";
  await act(() => navigate(latestUrl));
  await act(async () => old.reject(new Error("obsolete navigation failed")));
  const staleError = container.textContent!;
  await locationEvent(initialUrl);
  await poll();
  assert.equal(container.querySelector("input")?.value, latestUrl);
  await paint();
  await locationEvent(initialUrl, "title");
  assert.equal(container.querySelector("input")?.value, latestUrl);
  await act(async () => current.resolve());
  assert.doesNotMatch(staleError, /obsolete navigation failed/);
  await locationEvent(`${latestUrl}#ready`);
  await paint();
  assert.equal(container.querySelector("input")?.value, `${latestUrl}#ready`);
  assert.deepEqual(native.navigations.at(-1), { kind: "navigate", url: latestUrl });
});

test("a late poll from before a rejected navigation cannot overwrite its recovered location", async context => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  const native = nativeBrowser();
  await act(() => root.render(h(Overlay)));
  await paint();
  const oldPoll = deferred<unknown>();
  native.hooks.snapshot = () => oldPoll.promise;
  await poll();
  native.hooks.beforeSync = request => {
    if (request.navigationRevision === 1) throw new Error("navigation failed");
  };
  await act(() => navigate(desiredUrl));
  await paint();
  const actualUrl = `${initialUrl}#newer`;
  native.views.get("pane-a")!.url = actualUrl;
  await locationEvent(actualUrl);
  await paint();
  await act(async () => oldPoll.resolve({ ownerId: "pane-a", url: initialUrl, canGoBack: false, canGoForward: true }));
  assert.equal(container.querySelector("input")?.value, actualUrl);
  native.hooks.snapshot = undefined;
  now = 2000;
  await poll();
  assert.equal(container.querySelector("input")?.value, actualUrl);
  assert.equal(native.navigations.length, 1);
});

test("a hidden surface acknowledgement does not consume a pending navigation", async () => {
  const native = nativeBrowser();
  await act(() => root.render(h(Overlay)));
  await paint();
  await act(() => { setOccluded(true); navigate(desiredUrl); });
  await paint();
  await locationEvent(initialUrl);
  assert.equal(container.querySelector("input")?.value, desiredUrl);
  await act(() => setOccluded(false));
  await paint();
  assert.equal(native.views.get("pane-a")?.url, desiredUrl);
  assert.equal(native.views.get("pane-a")?.navigationRevision, 1);
});

for (const replacement of ["unmount", "pane"] as const) {
  test(`late navigation rejection after ${replacement} cannot affect the replacement`, async () => {
    const native = nativeBrowser();
    await act(() => root.render(h(Overlay)));
    await paint();
    const pending = deferred<void>();
    native.hooks.beforeSync = request => request.ownerId === "pane-a" && request.navigationRevision === 1
      ? pending.promise : undefined;
    await act(() => navigate(desiredUrl));
    await paint();
    await act(() => replacement === "pane" ? setPane("pane-b") : root.render(null));
    await paint();
    await act(async () => pending.reject(new Error("retired navigation failed")));
    await paint();
    assert.doesNotMatch(container.textContent!, /retired navigation failed/);
    if (replacement === "pane") {
      assert.equal(container.querySelector("input")?.value, desiredUrl);
      assert.equal(native.views.get("pane-b")?.url, desiredUrl);
    } else {
      assert.equal(container.children.length, 0);
      assert.equal(native.requests.length, 2);
    }
  });
}

test("busy retries keep location gated until native accepts the explicit navigation", async context => {
  const retryTimers = new Map<number, () => void>();
  let nextRetryTimer = 0;
  context.mock.method(window, "setTimeout", (callback: () => void) => {
    const id = ++nextRetryTimer;
    retryTimers.set(id, callback);
    return id;
  });
  context.mock.method(window, "clearTimeout", (id: number) => retryTimers.delete(id));
  const native = nativeBrowser();
  await act(() => root.render(h(Overlay)));
  await paint();
  let attempts = 0;
  native.hooks.beforeSync = request => {
    if (request.navigationRevision === 1 && ++attempts <= 5) {
      throw new Error("human browser lifecycle is busy; retry the request");
    }
  };
  await act(() => navigate(desiredUrl));
  await paint();
  // Exercise the real API's five short retries; only the component's deferred
  // retry timer is controlled here. No native lifecycle implementation is mocked
  // into the component or the API queue.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  assert.equal(attempts, 5);
  assert.equal(retryTimers.size, 1);
  await locationEvent(initialUrl);
  await poll();
  assert.equal(container.querySelector("input")?.value, desiredUrl);
  assert.equal(navigationByOwner.get("pane-a")?.settledRevision, 0);
  await act(() => {
    const callbacks = [...retryTimers.values()];
    retryTimers.clear();
    for (const retry of callbacks) retry();
  });
  await paint();
  assert.equal(attempts, 6);
  assert.equal(native.views.get("pane-a")?.url, desiredUrl);
  assert.equal(navigationByOwner.get("pane-a")?.acknowledgedRevision, 1);
  assert.doesNotMatch(container.textContent!, /lifecycle is busy/);
  assert.equal(retryTimers.size, 0);
});

test("a surface request revoked by cleanup is not mistaken for an acknowledged navigation", async () => {
  const native = nativeBrowser();
  await act(() => root.render(h(Overlay)));
  await paint();
  const pending = deferred<void>();
  native.hooks.beforeSync = request => request.navigationRevision === 1 ? pending.promise : undefined;
  await act(() => navigate(desiredUrl));
  await paint();
  await act(async () => { await hideAllHumanBrowsers(); pending.resolve(); });
  await locationEvent(initialUrl);
  await poll();
  assert.equal(container.querySelector("input")?.value, desiredUrl);
  assert.deepEqual(navigationByOwner.get("pane-a"), { settledRevision: 0, acknowledgedRevision: 0 });
  assert.equal(native.navigations.length, 1);
  await act(() => navigate("https://example.com/fresh"));
  await paint();
  assert.equal(native.views.get("pane-a")?.navigationRevision, 2);
});

for (const remount of ["tab-return", "recreate"] as const) {
  test(`a recovered failed revision is not replayed after ${remount}`, async () => {
    const native = nativeBrowser();
    await act(() => root.render(h(Overlay)));
    await paint();
    native.hooks.beforeSync = request => {
      if (request.url === desiredUrl) throw new Error("navigation failed");
    };
    await act(() => navigate(desiredUrl));
    await paint();
    const actualUrl = `${initialUrl}#recovered`;
    native.views.get("pane-a")!.url = actualUrl;
    await locationEvent(actualUrl);
    await paint();
    const originalProgress = navigationByOwner.get("pane-a");
    if (remount === "tab-return") {
      await act(() => setPane("pane-b"));
      await paint();
      await act(() => setPane("pane-a"));
    } else {
      await act(() => setOpen(false));
      await destroyHumanBrowser("pane-a");
      await act(() => setOpen(true));
    }
    await paint();
    assert.equal(navigationByOwner.get("pane-a"), originalProgress);
    assert.equal(native.requests.at(-1)?.navigationRevision, 0);
    assert.equal(native.views.get("pane-a")?.url, actualUrl);
    assert.equal(native.navigations.filter(operation => operation.kind === "reload").length, 0);
    await act(() => navigate(actualUrl));
    await paint();
    assert.deepEqual(native.navigations.at(-1), { kind: "reload", url: actualUrl });
    assert.equal(native.views.get("pane-a")?.navigationRevision, 2);
  });
}

for (const [phase, result] of [
  ["beforeSync", "reject"], ["beforeSync", "resolve"],
  ["afterCommit", "reject"], ["afterCommit", "resolve"],
] as const) {
  test(`a retired owner's late ${result} from ${phase} cannot change a recreated owner's navigation progress`, async () => {
    const native = nativeBrowser();
    await act(() => root.render(h(Overlay)));
    await paint();
    const oldProgress = navigationByOwner.get("pane-a")!;
    const pending = deferred<void>();
    native.hooks[phase] = request => request.navigationRevision === 1 ? pending.promise : undefined;
    await act(() => navigate(desiredUrl));
    await paint();
    await act(() => setOpen(false));
    pruneHumanBrowserNavigationState(navigationByOwner, new Set());
    await hideAllHumanBrowsers(); // Cleanup fences and releases the old queued work.
    await destroyHumanBrowser("pane-a");
    const freshProgress = humanBrowserNavigationStateFor(navigationByOwner, "pane-a");
    assert.notEqual(freshProgress, oldProgress);
    native.hooks.beforeSync = undefined;
    native.hooks.afterCommit = undefined;
    await act(() => { navigate("https://example.com/recreated"); setOpen(true); });
    await paint();
    assert.deepEqual(freshProgress, { settledRevision: 2, acknowledgedRevision: 2 });
    await act(async () => result === "reject" ? pending.reject(new Error("retired failure")) : pending.resolve());
    assert.deepEqual(oldProgress, { settledRevision: 0, acknowledgedRevision: 0 });
    assert.deepEqual(freshProgress, { settledRevision: 2, acknowledgedRevision: 2 });
    assert.equal(native.views.get("pane-a")?.url, "https://example.com/recreated");
    assert.doesNotMatch(container.textContent!, /retired failure/);
  });
}
