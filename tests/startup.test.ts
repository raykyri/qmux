import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, useEffect } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { default: Startup } = await import("../src/components/Startup");
const container = document.getElementById("root")!;
let root = createRoot(container);
const calls: string[] = [];
let progress = { phase: "loading", completed: 0, total: 0, error: null as string | null, quitting: false };
let mounts = 0;
let completeInterface: (() => void) | undefined;
function Application({ onReady }: { onReady?: () => void }) {
  useEffect(() => { mounts++; completeInterface = onReady; }, []);
  return h("div", { "data-app": true }, "Workspace");
}
const loadApp = async () => Application;
function installIPC() {
  mockIPC((command) => {
    calls.push(command);
    if (command === "startup_progress") return progress;
  });
}
async function poll() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
}
afterEach(async () => {
  await act(() => root.unmount());
  clearMocks();
  calls.length = 0;
  mounts = 0;
  completeInterface = undefined;
  progress = { phase: "loading", completed: 0, total: 0, error: null, quitting: false };
  dom.reconfigure({ url: "http://localhost" });
  root = createRoot(container);
});
after(async () => { await act(() => root.unmount()); dom.window.close(); });

test("reveals progress before recovery and gates application effects until ready", async () => {
  installIPC();
  await act(async () => { root.render(h(Startup, { loadApp })); });
  assert.ok(calls.includes("app_window_ready"));
  assert.equal(mounts, 0);
  assert.match(container.textContent!, /Restoring session/);
  progress = { ...progress, phase: "panes", completed: 2, total: 5 };
  await poll();
  assert.equal(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "2");
  assert.equal(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax"), "5");
  progress = { ...progress, phase: "ready" };
  await poll();
  assert.equal(mounts, 1);
  assert.ok(container.querySelector(".startup-screen"));
  await act(() => completeInterface?.());
  assert.equal(container.querySelector(".startup-screen"), null);
  assert.equal(calls.filter(c => c === "app_window_ready").length, 1);
});

test("backend failure keeps a readable error and an operable Quit control", async () => {
  progress = { ...progress, phase: "failed", error: "Saved session could not be read" };
  installIPC();
  await act(async () => { root.render(h(Startup, { loadApp })); });
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Saved session could not be read/);
  assert.equal(mounts, 0);
  await act(() => container.querySelector("button")!.click());
  assert.ok(calls.includes("startup_quit"));
});

test("quick launcher waits for recovery without revealing the main window", async () => {
  dom.reconfigure({ url: "http://localhost?global-task-launcher=1" });
  installIPC();
  await act(async () => { root.render(h(Startup, { loadApp })); });
  assert.equal(mounts, 0);
  progress = { ...progress, phase: "ready" };
  await poll();
  assert.equal(mounts, 1);
  assert.equal(container.querySelector(".startup-screen"), null);
  assert.ok(!calls.includes("app_window_ready"));
});

test("a quit during recovery never mounts the application", async () => {
  progress = { ...progress, phase: "panes", quitting: true };
  installIPC();
  await act(async () => { root.render(h(Startup, { loadApp })); });
  assert.match(container.textContent!, /Closing qmux/);
  assert.equal(container.querySelector("button")!.disabled, true);
  progress = { ...progress, phase: "ready" };
  await poll();
  assert.equal(mounts, 0);
});

test("interface import failure still reveals a screen with a working Quit button", async () => {
  progress = { ...progress, phase: "ready" };
  installIPC();
  await act(async () => { root.render(h(Startup, {
    loadApp: async () => { throw new Error("Interface bundle unavailable"); },
  })); });
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Interface bundle unavailable/);
  assert.ok(calls.includes("app_window_ready"));
  await act(() => container.querySelector("button")!.click());
  assert.ok(calls.includes("startup_quit"));
});
