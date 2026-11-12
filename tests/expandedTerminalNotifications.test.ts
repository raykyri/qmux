import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, Fragment } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { UserNotificationItem } from "../src/components/UserNotificationStack";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return this.classList.contains("user-notification-stack")
    ? new dom.window.DOMRect(600, 18, 380, 100)
    : new dom.window.DOMRect(950, 27, 24, 24);
};
const { createRoot } = await import("react-dom/client");
const { default: ExpandedTerminal } = await import("../src/components/ExpandedTerminal");
const { UserNotificationStack } = await import("../src/components/UserNotificationStack");
const { Dialog, DialogRoot } = await import("../src/components/ui");
after(() => { clearMocks(); dom.window.close(); });

test("global notifications retain their DOM and native pointer region across terminal expansion", async () => {
  const regions: { regionId: string; x: number; visible: boolean }[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "native_terminal_set_web_overlay_region") {
      regions.push((args as { region: (typeof regions)[number] }).region);
    }
  });
  const rootElement = document.getElementById("root")!;
  const root = createRoot(rootElement);
  const opened: string[] = [];
  const notification: UserNotificationItem = {
    id: "before-expansion", title: "Agent finished", body: "Review the result",
    tone: "success", timeoutMs: 30_000, paneId: "agent-pane", createdAt: Date.now(),
  };
  const render = async (expanded: boolean, notifications = [notification]) => {
    await act(async () => {
      root.render(h(Fragment, null,
        h(UserNotificationStack, {
          notifications, reduceMotion: true, onDismiss: () => {}, onOpenPane: (id) => opened.push(id),
        }),
        expanded ? h(ExpandedTerminal, {
          rect: { left: 19, top: 19, width: 986, height: 730 },
          onRestore: () => {}, children: null,
        }) : null,
      ));
    });
  };
  try {
    await render(false);
    const stack = document.querySelector<HTMLElement>(".user-notification-stack")!;
    const originalCard = stack.querySelector(".user-notification");
    const regionId = regions.find((region) => region.x === 600)!.regionId;
    const latestRegion = () => regions.filter((region) => region.regionId === regionId).at(-1)!;
    assert.equal(stack.parentElement, document.body);
    assert.equal(stack.dataset.reduceMotion, "true");

    await render(true);
    assert.ok(rootElement.style.clipPath, "the real expansion aperture is active");
    assert.equal(rootElement.inert, true);
    assert.equal(rootElement.contains(stack), false, "notices must escape the clipped app root");
    assert.equal(stack.querySelector(".user-notification"), originalCard, "expansion must not reset notice timers");
    assert.equal(latestRegion().visible, true, "the native overlay scope must retain notice clicks");

    await render(true, [notification, { ...notification, id: "during-expansion", paneId: "second-agent" }]);
    const buttons = stack.querySelectorAll<HTMLButtonElement>("button.user-notification-open");
    assert.equal(buttons.length, 2, "new notifications arrive above the expanded terminal");
    assert.equal(latestRegion().visible, true);
    await act(async () => buttons[1].click());
    assert.deepEqual(opened, ["second-agent"]);

    await render(false);
    assert.equal(stack.querySelector(".user-notification"), originalCard);
    assert.equal(latestRegion().visible, true);
    await render(false, []);
    assert.equal(latestRegion().visible, false, "removing notices releases their native pointer region");
    assert.equal(document.querySelector(".user-notification-stack"), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("ordinary dialogs keep portaled notifications inert, including above an expanded terminal", async () => {
  const regions: { regionId: string; x: number; visible: boolean }[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "native_terminal_set_web_overlay_region") {
      regions.push((args as { region: (typeof regions)[number] }).region);
    }
  });
  const root = createRoot(document.getElementById("root")!);
  const notification: UserNotificationItem = {
    id: "modal-notification", title: "Notice", body: "Preserve this card",
    tone: "info", timeoutMs: 30_000, paneId: null, createdAt: Date.now(),
  };
  const render = async (expanded: boolean, ordinaryDialog: boolean) => {
    await act(async () => {
      root.render(h(Fragment, null,
        h(UserNotificationStack, { notifications: [notification], onDismiss: () => {}, onOpenPane: () => {} }),
        expanded ? h(ExpandedTerminal, {
          rect: { left: 19, top: 19, width: 986, height: 730 },
          onRestore: () => {}, children: null,
        }) : null,
        ordinaryDialog ? h(DialogRoot, {
          children: h(Dialog, { "aria-label": "Confirmation" }, h("button", null, "Confirm")),
        }) : null,
      ));
    });
  };
  try {
    await render(false, false);
    const stack = document.querySelector<HTMLElement>(".user-notification-stack")!;
    const card = stack.querySelector(".user-notification");
    const regionId = regions.find((region) => region.x === 600)!.regionId;
    const latestRegion = () => regions.filter((region) => region.regionId === regionId).at(-1)!;
    for (const expanded of [false, true]) {
      await render(expanded, true);
      assert.equal(stack.hasAttribute("inert"), true, "ordinary dialogs retain notification modality");
      assert.equal(latestRegion().visible, false, "blocked notices leave no native pointer blocker");
      assert.equal(stack.querySelector(".user-notification"), card);
      await render(expanded, false);
      assert.equal(stack.hasAttribute("inert"), false);
      assert.equal(latestRegion().visible, true, "dismissing the ordinary dialog restores notice routing");
      assert.equal(stack.querySelector(".user-notification"), card);
    }
    await render(true, true);
  } finally {
    await act(async () => root.unmount());
  }
  const nextRoot = createRoot(document.getElementById("root")!);
  try {
    await act(async () => nextRoot.render(h(UserNotificationStack, {
      notifications: [notification], onDismiss: () => {}, onOpenPane: () => {},
    })));
    assert.equal(document.querySelector(".user-notification-stack")!.hasAttribute("inert"), false,
      "unmounting the whole nested modal tree must release ordinary-dialog bookkeeping");
  } finally {
    await act(async () => nextRoot.unmount());
  }
});
