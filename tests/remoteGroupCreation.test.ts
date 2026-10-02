import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useRemoteGroupCreation } from "../src/hooks/useRemoteGroupCreation";
import PendingRemoteGroup from "../src/components/PendingRemoteGroup";
import type { GroupWithInitialPane } from "../src/lib/api";

const dom = new JSDOM('<!doctype html><div id="root"></div>');
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const frames: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (callback) => frames.push(callback);
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root")!;
let root = createRoot(container);
let controller: ReturnType<typeof useRemoteGroupCreation>;
function Harness() {
  controller = useRemoteGroupCreation();
  return h("div", {}, controller.pendingRemoteGroups.map((group) => h(PendingRemoteGroup, { key: group.id, group })));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function frame() {
  const callbacks = frames.splice(0);
  await act(() => callbacks.forEach((callback) => callback(0)));
}
const size = { cols: 100, rows: 30 };
// The hook returns the server response unchanged; pane/group details are owned
// by the backend and the App's existing insertion path.
const created = { group: { id: "group-real" }, pane: { id: "pane-real" } } as GroupWithInitialPane;
afterEach(async () => {
  await act(() => root.unmount());
  clearMocks();
  frames.length = 0;
  root = createRoot(container);
});
after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

for (const protocol of ["ssh", "sftp"] as const) {
  test(`${protocol} group is rendered before remote work starts and remains while setup is blocked`, async () => {
    const setup = deferred<GroupWithInitialPane>();
    let calls = 0;
    mockIPC((command, payload) => {
      assert.equal(command, "group_create_with_shell");
      assert.deepEqual(payload, {
        dir: "~", afterGroupId: "anchor", initialSize: size,
        remoteId: "devbox", remoteProtocol: protocol,
      });
      calls++;
      return setup.promise;
    });
    await act(() => root.render(h(Harness)));
    let creation!: Promise<GroupWithInitialPane>;
    await act(() => {
      creation = controller.createPendingRemoteGroup("devbox", "Dev box", protocol, "anchor", size);
    });
    assert.match(container.textContent!, /Dev box/);
    assert.match(container.textContent!, protocol === "ssh" ? /Connecting SSH shell/ : /Opening SFTP files/);
    assert.equal(container.querySelectorAll('[role="status"]').length, 1);
    assert.equal(calls, 0);
    await frame();
    assert.equal(calls, 0, "allow a paint before starting the backend request");
    await frame();
    assert.equal(calls, 1);
    assert.equal(controller.pendingRemoteGroups[0].afterGroupId, "anchor");
    assert.match(container.textContent!, /Dev box/);
    await act(async () => {
      setup.resolve(created);
      assert.deepEqual(await creation, created);
    });
    assert.equal(container.textContent, "");
  });
}

test("a failed launch removes only its placeholder and propagates the error for app-wide reporting", async () => {
  const first = deferred<GroupWithInitialPane>();
  const second = deferred<GroupWithInitialPane>();
  const requests = [first, second];
  mockIPC(() => requests.shift()!.promise);
  await act(() => root.render(h(Harness)));
  let failure!: Promise<unknown>;
  let success!: Promise<GroupWithInitialPane>;
  await act(() => {
    failure = controller.createPendingRemoteGroup("one", "First", "ssh", null, size).catch((error) => error);
    success = controller.createPendingRemoteGroup("two", "Second", "sftp", null, size);
  });
  await frame();
  await frame();
  const error = new Error("SSH connection failed");
  await act(async () => {
    first.reject(error);
    assert.equal(await failure, error);
  });
  assert.equal(controller.pendingRemoteGroups.length, 1);
  assert.match(container.textContent!, /Second/);
  assert.doesNotMatch(container.textContent!, /First/);
  await act(async () => {
    second.resolve(created);
    await success;
  });
  assert.equal(controller.pendingRemoteGroups.length, 0);
});
