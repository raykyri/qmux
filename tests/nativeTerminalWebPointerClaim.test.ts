import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, StrictMode } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

const dom = new JSDOM('<!doctype html><div id="root"></div>');
for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true,
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { DialogBackdrop } = await import("../src/components/ui/Dialog");
const api = await import("../src/lib/api");
const claimDrag = api.claimNativeTerminalPointerForWebDrag;
// The fallback lets these regressions exercise the baseline's actual API too.
const claimOverlay = (api as { claimNativeTerminalPointerForWebOverlay?: () => () => void })
  .claimNativeTerminalPointerForWebOverlay ?? claimDrag;
type Claim = { claimed: boolean; sticky?: boolean };
let calls: Claim[] = [];
let releases: (() => void)[] = [];
const take = (kind: "drag" | "overlay") => {
  const release = (kind === "drag" ? claimDrag : claimOverlay)();
  releases.push(release);
  return release;
};
// Flush the real serialized IPC chain, with a deadline only to detect a stall.
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "pointer IPC did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
beforeEach(() => {
  calls = [];
  releases = [];
  mockIPC((cmd, args) => {
    if (cmd === "native_terminal_set_web_pointer_claimed") calls.push(args as Claim);
  });
});
afterEach(async () => {
  for (const release of releases) release();
  await settle();
  clearMocks();
});
after(() => dom.window.close());

test("overlay ownership is explicitly sticky even when acquired on a press", async () => {
  take("overlay");
  await until(() => calls.length > 0);
  assert.deepEqual(calls[0], { claimed: true, sticky: true });
});

test("a new claimant republishes after native independently retires a drag", async () => {
  const releaseDrag = take("drag");
  await until(() => calls.length > 0);
  calls = []; // Native may clear on pointer-up/blur; there is no JS notification.
  const releaseMenu = take("overlay");
  await settle();
  assert.deepEqual(calls, [{ claimed: true, sticky: true }]);
  releaseDrag();
  await settle();
  assert.equal(calls.length, 1, "an old drag release must not clear the new menu");
  releaseMenu();
  await until(() => calls.length === 2);
  assert.deepEqual(calls[1], { claimed: false, sticky: false });
});

test("overlapping overlays dominate gestures; final overlay release downgrades to drag", async () => {
  const a = take("overlay");
  const b = take("overlay");
  const drag = take("drag");
  await until(() => calls.length === 3);
  assert.ok(calls.every((value) => value.claimed && value.sticky));
  a(); a();
  await settle();
  assert.equal(calls.length, 3);
  b();
  await until(() => calls.length === 4);
  assert.deepEqual(calls[3], { claimed: true, sticky: false });
  drag(); drag();
  await until(() => calls.length === 5);
  assert.deepEqual(calls[4], { claimed: false, sticky: false });
});

test("a new gesture also republishes while a retired gesture is still counted", async () => {
  const old = take("drag");
  await until(() => calls.length > 0);
  const next = take("drag");
  await until(() => calls.length === 2);
  assert.deepEqual(calls[1], { claimed: true, sticky: false });
  old();
  await settle();
  assert.equal(calls.length, 2);
  next();
  await until(() => calls.length === 3);
  assert.deepEqual(calls[2], { claimed: false, sticky: false });
});

test("a pending acquisition cannot be overtaken by release and remount", async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  mockIPC(async (cmd, args) => {
    if (cmd !== "native_terminal_set_web_pointer_claimed") return;
    calls.push(args as Claim);
    if (calls.length === 1) await gate;
  });
  const release = take("overlay");
  await until(() => calls.length === 1);
  release();
  const remount = take("overlay");
  await settle();
  assert.equal(calls.length, 1);
  complete();
  await until(() => calls.length === 3);
  remount();
  await until(() => calls.length === 4);
  assert.deepEqual(calls, [
    { claimed: true, sticky: true }, { claimed: false, sticky: false },
    { claimed: true, sticky: true }, { claimed: false, sticky: false },
  ]);
});

test("release retries remain ordered and exhausted failures do not poison remount", async () => {
  let failures = 3;
  mockIPC((cmd, args) => {
    if (cmd !== "native_terminal_set_web_pointer_claimed") return;
    const value = args as Claim;
    calls.push(value);
    if (!value.claimed && failures-- > 0) throw new Error("bridge unavailable");
  });
  const release = take("overlay");
  release();
  const next = take("overlay");
  await until(() => calls.length === 5);
  assert.deepEqual(calls.map((value) => value.claimed), [true, false, false, false, true]);
  assert.equal(calls[4].sticky, true);
  next();
  await until(() => calls.length === 6);
  assert.deepEqual(calls[5], { claimed: false, sticky: false });
});

test("shared Dialog mounts sticky, releases on disposal, and survives StrictMode remount", async () => {
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(h(StrictMode, null,
      h(DialogBackdrop, null, h("div", { role: "dialog" }, "menu")))));
    await until(() => calls.length === 3);
    assert.deepEqual(calls, [
      { claimed: true, sticky: true }, { claimed: false, sticky: false },
      { claimed: true, sticky: true },
    ]);
  } finally {
    await act(async () => root.unmount());
  }
  await until(() => calls.length === 4);
  assert.deepEqual(calls[3], { claimed: false, sticky: false });
});
