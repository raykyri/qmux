import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { useQmuxEvents } = await import("../src/hooks/useQmuxEvents");
const { listenToEvents } = await import("../src/lib/api");
type Handlers = Parameters<typeof useQmuxEvents>[0];
const internals = () => (window as any).__TAURI_INTERNALS__;
const callbacks = () => internals().callbacks as Map<number, unknown>;
let root = createRoot(document.getElementById("root")!);
let ready = 0;
let timers = new Map<number, { callback: () => void; delay: number }>();
let nextTimer = 0;
const originalSetTimeout = window.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalError = console.error;
window.setTimeout = ((callback: () => void, delay: number) => {
  timers.set(++nextTimer, { callback, delay });
  return nextTimer;
}) as typeof window.setTimeout;
globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
console.error = () => {};
async function mount() {
  const handlers = new Proxy({ onEventsReady: () => ready++ } as Partial<Handlers>, {
    get: (target, key) => (target as any)[key] ?? (() => {}),
  }) as Handlers;
  function Harness() { useQmuxEvents(handlers); return null; }
  await act(async () => root.render(h(Harness)));
}
async function retry() {
  assert.equal(timers.size, 1, "only one serial retry may be pending");
  const [id, timer] = [...timers][0];
  timers.delete(id);
  await act(async () => timer.callback());
  return timer.delay;
}
afterEach(async () => {
  await act(() => root.unmount());
  root = createRoot(document.getElementById("root")!);
  clearMocks(); timers.clear(); ready = 0;
});
after(async () => {
  await act(() => root.unmount());
  window.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  console.error = originalError;
  dom.window.close();
});

test("API rejected event registrations release their actual Tauri callback", async () => {
  mockIPC(() => { throw new Error("registration failed"); });
  for (let i = 0; i < 12; i++) {
    await assert.rejects(listenToEvents(() => {}), /registration failed/);
    assert.equal(callbacks().size, 0);
  }
});

test("API keeps event id and callback id distinct and removes each subscription once", async () => {
  let handler = 0;
  const unlistens: unknown[] = [];
  const received: unknown[] = [];
  mockIPC((cmd, args: any) => {
    if (cmd === "plugin:event|listen") {
      assert.equal(args.event, "qmux-event");
      assert.deepEqual(args.target, { kind: "Any" });
      handler = args.handler;
      return 17;
    }
    if (cmd === "plugin:event|unlisten") unlistens.push(args);
  });
  const cleanup = await listenToEvents(event => received.push(event));
  internals().runCallback(handler, { event: "qmux-event", id: 17, payload: { type: "pane.removed" } });
  assert.deepEqual(received, [{ type: "pane.removed" }]);
  cleanup(); cleanup();
  assert.equal(callbacks().size, 0);
  assert.deepEqual(unlistens, [{ event: "qmux-event", eventId: 17 }]);
});

test("hook retries subscription serially without leaking callbacks and signals ready once", async () => {
  let listens = 0, marks = 0, unlistens = 0;
  mockIPC((cmd, args: any) => {
    if (cmd === "plugin:event|listen") {
      if (++listens < 10) throw new Error("transient registration failure");
      return args.handler; // Tauri mock's event id equals callback id.
    }
    if (cmd === "mark_events_listener_ready") marks++;
    if (cmd === "plugin:event|unlisten") unlistens++;
  });
  await mount();
  for (let attempt = 0; attempt < 9; attempt++) {
    assert.equal(callbacks().size, 0);
    assert.equal(ready, 0);
    assert.equal(await retry(), Math.min(100 * 2 ** attempt, 2000));
  }
  assert.equal(listens, 10);
  assert.equal(callbacks().size, 1);
  assert.equal(marks, 1);
  assert.equal(ready, 1);
  assert.equal(timers.size, 0);
  await act(() => root.unmount());
  root = createRoot(document.getElementById("root")!);
  assert.equal(callbacks().size, 0);
  assert.equal(unlistens, 1);
});

test("native readiness retries keep the same subscription and do not replay ready effects", async () => {
  let listens = 0, marks = 0;
  mockIPC((cmd, args: any) => {
    if (cmd === "plugin:event|listen") { listens++; return args.handler; }
    if (cmd === "mark_events_listener_ready" && ++marks < 3) throw new Error("ready failed");
  });
  await mount();
  assert.equal(ready, 1);
  await retry(); await retry();
  assert.equal(listens, 1);
  assert.equal(marks, 3);
  assert.equal(ready, 1);
  assert.equal(callbacks().size, 1);
  assert.equal(timers.size, 0);
});

test("disposing cancels a pending retry and releases a successful registration arriving late", async () => {
  let resolve!: (id: number) => void;
  let callbackID = 0, unlistens = 0, marks = 0;
  mockIPC((cmd, args: any) => {
    if (cmd === "plugin:event|listen") {
      callbackID = args.handler;
      return new Promise<number>(yes => { resolve = yes; });
    }
    if (cmd === "plugin:event|unlisten") { unlistens++; throw new Error("already closed"); }
    if (cmd === "mark_events_listener_ready") marks++;
  });
  await mount();
  await act(() => root.unmount());
  root = createRoot(document.getElementById("root")!);
  await act(async () => resolve(callbackID));
  assert.equal(callbacks().size, 0);
  assert.equal(unlistens, 1);
  assert.equal(marks, 0);
  assert.equal(ready, 0);
  assert.equal(timers.size, 0);
});

test("disposal cancels subscription and native-readiness retry timers", async () => {
  for (const failListen of [true, false]) {
    mockIPC((cmd, args: any) => {
      if (cmd === "plugin:event|listen") {
        if (failListen) throw new Error("listen failed");
        return args.handler;
      }
      if (cmd === "mark_events_listener_ready") throw new Error("ready failed");
    });
    await mount();
    assert.equal(timers.size, 1);
    await act(() => root.unmount());
    root = createRoot(document.getElementById("root")!);
    assert.equal(timers.size, 0);
    assert.equal(callbacks().size, 0);
    clearMocks();
  }
});

test("native ready failure arriving after disposal cannot schedule a retry", async () => {
  let reject!: (error: Error) => void;
  mockIPC((cmd, args: any) => {
    if (cmd === "plugin:event|listen") return args.handler;
    if (cmd === "mark_events_listener_ready") return new Promise((_, no) => { reject = no; });
  });
  await mount();
  await act(() => root.unmount());
  root = createRoot(document.getElementById("root")!);
  await act(async () => reject(new Error("late failure")));
  assert.equal(timers.size, 0);
  assert.equal(callbacks().size, 0);
});
