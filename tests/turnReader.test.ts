import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import type { Turn } from "../src/types";
import { buildTimelineItems } from "../src/lib/turnTimeline";

const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
]) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
  });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
    unobserve() {}
  },
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const { createRoot } = await import("react-dom/client");
const { default: TurnOverlay } = await import("../src/components/TurnOverlay");

const container = document.getElementById("root")!;
const root = createRoot(container);

const turns: Turn[] = [
  {
    id: "user-1",
    agentId: "agent-1",
    role: "user",
    blocks: [{ type: "text", text: "Question" }],
    sourceIndex: 0,
  },
  {
    id: "assistant-1",
    agentId: "agent-1",
    role: "assistant",
    blocks: [{ type: "text", text: "The answer sits in the reader." }],
    sourceIndex: 1,
  },
];
const assistantKey = buildTimelineItems(turns).find((item) => item.role === "assistant")!.key;

// jsdom has no PointerEvent. The reader listens for the real pointer events
// WKWebView dispatches; a MouseEvent of that type carries the same button and
// target fields the handler reads.
function pointer(type: string, target: Element, button = 0) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    buttons: type === "pointerdown" ? 1 : 0,
  });
  Object.defineProperty(event, "isPrimary", { value: true });
  target.dispatchEvent(event);
}

function gesture(target: Element, button = 0) {
  pointer("pointerdown", target, button);
  pointer("pointerup", target, button);
}

after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

test("clicking the reader scrim closes the assistant response and inside clicks do not", async () => {
  const closed: Array<string | null> = [];
  await act(() =>
    root.render(
      h(
        "div",
        null,
        h("button", { type: "button", className: "outside-chrome" }, "Sidebar"),
        h(
          "aside",
          { className: "turn-pane is-expanded is-reader-mode" },
          h(
            "div",
            { className: "turn-pane-expanded-split-cell" },
            h(TurnOverlay, {
              turns,
              assistantLabel: "Codex",
              assistantTurnFocusEnabled: true,
              focusedAssistantTurnKey: assistantKey,
              onFocusAssistantTurn: (itemKey: string | null) => {
                closed.push(itemKey);
              },
              linkActions: {
                openLink: () => undefined,
                openLinkMenu: () => undefined,
              },
            }),
          ),
        ),
      ),
    ),
  );

  const scrim = document.querySelector<HTMLElement>(".turn-pane.is-reader-mode")!;
  const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
  const margin = document.querySelector<HTMLElement>(".turn-pane-expanded-split-cell")!;
  const outside = document.querySelector<HTMLElement>(".outside-chrome")!;
  assert.equal(dialog.getAttribute("aria-label"), "Focused assistant turn");
  assert.ok(dialog.textContent?.includes("The answer sits in the reader."));

  gesture(dialog.querySelector(".turn-reader-title")!);
  gesture(dialog);
  assert.deepEqual(closed, []);

  const menu = document.createElement("div");
  menu.className = "popover-surface";
  menu.textContent = "Fork from here";
  document.body.appendChild(menu);
  gesture(menu);
  assert.deepEqual(closed, []);

  gesture(outside);
  assert.deepEqual(closed, []);

  gesture(scrim, 2);
  assert.deepEqual(closed, []);

  pointer("pointerdown", margin);
  pointer("pointerup", dialog);
  assert.deepEqual(closed, []);

  pointer("pointerdown", dialog);
  pointer("pointerup", margin);
  assert.deepEqual(closed, []);

  pointer("pointerdown", margin);
  pointer("pointercancel", margin);
  pointer("pointerup", margin);
  assert.deepEqual(closed, []);

  gesture(margin);
  assert.deepEqual(closed, [null]);

  closed.length = 0;
  gesture(scrim);
  assert.deepEqual(closed, [null]);

  closed.length = 0;
  await act(() => {
    dialog.querySelector<HTMLButtonElement>(".turn-reader-close-button")!.click();
  });
  assert.deepEqual(closed, [null]);

  closed.length = 0;
  await act(() => {
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  assert.deepEqual(closed, [null]);
});
