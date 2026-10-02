import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { RemoteProbeResult } from "../src/types";
import {
  useRemoteSettings,
  type RemoteSettingsController,
} from "../src/hooks/useRemoteSettings";

const dom = new JSDOM('<!doctype html><div id="root"></div>');
Object.defineProperty(globalThis, "window", {
  value: dom.window,
  configurable: true,
});
Object.defineProperty(globalThis, "document", {
  value: dom.window.document,
  configurable: true,
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root")!;
let root = createRoot(container);
let controller: RemoteSettingsController;
function Harness({ open = true }: { open?: boolean }) {
  controller = useRemoteSettings({
    config: null,
    setConfig: () => {},
    settingsOpen: open,
    settingsTab: "remotes",
    showAppToast: () => {},
  });
  return null;
}
function pendingProbe() {
  let resolve!: (value: RemoteProbeResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<RemoteProbeResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result: RemoteProbeResult = { checks: [], adapters: [] };
async function startDraft() {
  await act(() => root.render(h(Harness)));
  await act(() => controller.beginAddingRemoteFromSshAlias("devbox"));
}
afterEach(async () => {
  await act(() => root.unmount());
  clearMocks();
  root = createRoot(container);
});
after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

test("editing a remote invalidates the pending probe, while the next probe can complete", async () => {
  const stale = pendingProbe();
  const current = pendingProbe();
  const requests = [stale, current];
  mockIPC((command) => {
    assert.equal(command, "probe_remote");
    return requests.shift()!.promise;
  });
  await startDraft();
  let first!: Promise<void>;
  await act(() => {
    first = controller.testRemoteSettings(controller.remoteSettingsDraftState!);
  });
  assert.equal(controller.remoteProbeLoadingId, "devbox");
  await act(() =>
    controller.changeRemoteSettingsDraft((draft) => ({
      ...draft,
      id: "renamed",
      host: "new-host",
    })),
  );
  let second!: Promise<void>;
  await act(() => {
    second = controller.testRemoteSettings(
      controller.remoteSettingsDraftState!,
    );
  });
  await act(async () => {
    stale.resolve(result);
    await first;
  });
  assert.deepEqual(controller.remoteProbeResults, {});
  assert.equal(controller.remoteProbeLoadingId, "renamed");
  await act(async () => {
    current.resolve(result);
    await second;
  });
  assert.deepEqual(controller.remoteProbeResults, { renamed: result });
  assert.equal(controller.remoteProbeLoadingId, null);
});

test("superseded failures and responses after closing settings cannot restore probe state", async () => {
  const stale = pendingProbe();
  const current = pendingProbe();
  const requests = [stale, current];
  mockIPC(() => requests.shift()!.promise);
  await startDraft();
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(() => {
    first = controller.testRemoteSettings(controller.remoteSettingsDraftState!);
  });
  await act(() => {
    second = controller.testRemoteSettings(
      controller.remoteSettingsDraftState!,
    );
  });
  await act(async () => {
    stale.reject(new Error("stale failure"));
    await first;
  });
  assert.equal(controller.remoteSettingsError, null);
  assert.equal(controller.remoteProbeLoadingId, "devbox");
  await act(() => root.render(h(Harness, { open: false })));
  await act(async () => {
    current.resolve(result);
    await second;
  });
  assert.deepEqual(controller.remoteProbeResults, {});
  assert.equal(controller.remoteProbeLoadingId, null);
  await act(() => root.render(h(Harness)));
  assert.deepEqual(controller.remoteProbeResults, {});
});
