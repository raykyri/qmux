import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import RemotePreviewStatus from "../src/components/RemotePreviewStatus";
import type { RemotePreviewState } from "../src/lib/remotePreview";

const dom = new JSDOM('<!doctype html><div id="root"></div>');
for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.getElementById("root")!;
let root = createRoot(container);
afterEach(async () => { await act(() => root.unmount()); root = createRoot(container); });
after(async () => { await act(() => root.unmount()); dom.window.close(); });
const preview: RemotePreviewState = {
  target: { paneId: "pane", transcript: "session", path: "/tmp/reports.zip", fragment: "" },
  cachedOnly: false, bytes: 0, total: null, error: "This file format cannot be previewed",
  cachedAvailable: false, fetchedAt: null, url: null,
};
const props = {
  preview, onRetry() {}, onCached() {}, onCopy() {}, onClose() {},
  onDownload: async () => true,
};
function button(label: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === label)!;
}

test("unsupported remote files offer download beside their status and existing actions", async () => {
  let downloads = 0;
  let finish!: (saved: boolean) => void;
  await act(() => root.render(h(RemotePreviewStatus, { ...props, onDownload: () => {
    downloads += 1;
    return new Promise<boolean>((resolve) => { finish = resolve; });
  } })));
  assert.equal(button("Download").disabled, false);
  assert.ok(button("Retry"));
  assert.ok(button("Copy remote path"));
  assert.ok(button("Close"));
  const row = container.querySelector(".remote-preview-status-row")!;
  assert.ok(row.contains(container.querySelector('[role="alert"]')));
  assert.ok(row.contains(button("Download")));
  await act(() => button("Download").click());
  assert.equal(downloads, 1);
  assert.equal(button("Downloading…").disabled, true);
  await act(() => finish(true));
  assert.equal(button("Download").disabled, false);
});

test("a downloaded snapshot can be saved and cancelling the chooser keeps it open", async () => {
  let closes = 0;
  const ready = { ...preview, error: null, url: "http://localhost/snapshot", fetchedAt: 1234 };
  await act(() => root.render(h(RemotePreviewStatus, { ...props, preview: ready,
    onDownload: async () => false, onClose: () => { closes += 1; },
  })));
  assert.ok(button("Refresh from remote"));
  await act(() => button("Download").click());
  assert.equal(closes, 0);
  assert.match(container.textContent!, /Snapshot · downloaded/);
  assert.equal(button("Download").disabled, false);
});

test("download failure is visible and permits retry without closing the preview", async () => {
  await act(() => root.render(h(RemotePreviewStatus, { ...props,
    onDownload: async () => { throw new Error("Disk is full"); },
  })));
  await act(() => button("Download").click());
  assert.match(container.textContent!, /Disk is full/);
  assert.equal(button("Download").disabled, false);
  assert.ok(button("Close"));
});

test("an unsettled preview keeps download disabled and allows cancellation", async () => {
  let closes = 0;
  await act(() => root.render(h(RemotePreviewStatus, { ...props,
    preview: { ...preview, error: null }, onClose: () => { closes += 1; },
  })));
  assert.equal(button("Download").disabled, true);
  assert.ok(container.querySelector("progress"));
  await act(() => button("Cancel").click());
  assert.equal(closes, 1);
});
