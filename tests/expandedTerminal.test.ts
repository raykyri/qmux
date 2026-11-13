import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, createRef, useCallback, useEffect, useState } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ComponentProps } from "react";
import type { TerminalPaneHandle } from "../src/components/TerminalPane";

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
  const expanded = Boolean(this.closest(".terminal-expanded-frame"));
  return new dom.window.DOMRect(expanded ? 30 : 250, expanded ? 58 : 60, expanded ? 964 : 360, expanded ? 680 : 350);
};
const { createRoot } = await import("react-dom/client");
const { default: TerminalPane } = await import("../src/components/TerminalPane");
const { useNativeWebOverlayRegion } = await import("../src/hooks/useNativeWebOverlayRegion");
const { isWebKeyboardTarget } = await import("../src/lib/appHelpers");
const { desiredNativeTerminalKeyboardOwner, windowFocusKeyboardOwner } = await import("../src/lib/nativeTerminalKeyboard");
after(() => { clearMocks(); dom.window.close(); });

function UnderlyingControl() {
  const ref = useNativeWebOverlayRegion<HTMLDivElement>(true, "test");
  return h("div", { ref }, "Underlying split control");
}

test("expansion retains one session, scopes pointer regions, and restores native geometry", async () => {
  const calls: { cmd: string; args: any }[] = [];
  mockIPC((cmd, args) => { calls.push({ cmd, args }); });
  const rootElement = document.getElementById("root")!;
  const root = createRoot(rootElement);
  const handle = createRef<TerminalPaneHandle>();
  let attaches = 0;
  let restores = 0;
  const props: ComponentProps<typeof TerminalPane> = {
    pane: { id: "prototype-pane" } as ComponentProps<typeof TerminalPane>["pane"],
    active: true, visible: true, expandable: true,
    fontSize: 13, fontFamily: "monospace", letterSpacing: 0, lineHeight: 1,
    cursorBlink: false, cursorStyle: "block", scrollbackRows: 1000,
    scrollOnUserInput: true, scrollSensitivity: 1, copyOnSelect: false,
    selectionClearOnCopy: false, themeName: "qmux", pasteProtection: {} as any,
    deferGeometryUpdates: false, coveredByOverlay: false, inputBlocked: false,
    webEditableFocused: false, requestAttach: () => { attaches++; },
    onCloseRemote: () => {}, onRetryRemote: async () => {}, onRestore: () => { restores++; }, ref: handle,
  };
  const render = async (expanded: boolean) => {
    await act(async () => { root.render(h("main", null, h(UnderlyingControl), h(TerminalPane, { ...props, expanded }))); });
  };
  const latestLayout = () => calls.filter(c => c.cmd === "native_terminal_set_layout").at(-1)!.args.layout;
  try {
    await render(false);
    const original = latestLayout();
    const underlyingRegion = calls.find(c => c.cmd === "native_terminal_set_web_overlay_region")!.args.region.regionId;
    await render(true);
    assert.equal(attaches, 1, "the pane must not remount/re-attach when portaled");
    assert.equal(document.querySelector(".terminal-expanded-toolbar"), null);
    const restore = document.querySelector<HTMLButtonElement>('.terminal-expanded-frame .terminal-expand-control button')!;
    assert.equal(restore.getAttribute("aria-label"), "Restore terminal");
    assert.ok(restore.classList.contains("turn-pane-header-button"));
    assert.equal(latestLayout().width, 964);
    assert.match(rootElement.style.clipPath, /path\(evenodd/);
    assert.equal(rootElement.inert, true);
    assert.equal(calls.filter(c => c.cmd === "native_terminal_set_web_overlay_region" && c.args.region.regionId === underlyingRegion).at(-1)!.args.region.visible, false);
    assert.equal(calls.some(c => c.cmd === "native_terminal_set_web_pointer_claimed" && c.args.claimed), false, "expanded terminal must retain native pointer input");

    await act(async () => { handle.current!.openSearch(); });
    const search = document.querySelector<HTMLInputElement>(".terminal-expanded-frame input")!;
    assert.ok(search, "search travels into the expanded portal");
    await act(async () => { search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(restores, 0, "Escape in search closes search, not the terminal presentation");
    assert.equal(document.querySelector(".pane-search"), null);

    await act(async () => { handle.current!.openSearch(); });
    const searchButtons = document.querySelectorAll<HTMLButtonElement>(".pane-search button");
    const closeSearch = searchButtons[searchButtons.length - 1];
    await act(async () => { closeSearch.focus(); });
    await act(async () => { closeSearch.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    assert.equal(restores, 0, "Escape from a search button must close search, not expansion");
    assert.equal(document.querySelector(".pane-search"), null);

    await act(async () => { handle.current!.openSearch(); });
    const tabButtons = document.querySelectorAll<HTMLButtonElement>(".pane-search button");
    const last = tabButtons[tabButtons.length - 1];
    await act(async () => { last.focus(); });
    const tab = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => { last.dispatchEvent(tab); });
    assert.equal(tab.defaultPrevented, true, "Tab from the last search control stays inside the dialog");
    assert.equal(document.activeElement, restore);

    await act(async () => { restore.click(); });
    assert.equal(restores, 1, "the floating restore control is actionable");
    // Keep search open across restore: its new input must regain focus.
    await act(async () => { handle.current!.openSearch(); });
    await render(false);
    assert.equal(document.activeElement, document.querySelector(".pane-search input"));
    assert.equal(attaches, 1);
    assert.equal(latestLayout().width, original.width);
    assert.equal(latestLayout().x, original.x);
    assert.equal(rootElement.style.clipPath, "");
    assert.equal(Boolean(rootElement.inert), false);
    assert.equal(calls.filter(c => c.cmd === "native_terminal_set_web_overlay_region" && c.args.region.regionId === underlyingRegion).at(-1)!.args.region.visible, true);
  } finally {
    await act(async () => root.unmount());
  }
});

test("expanded controls retain web keyboard ownership and restore native focus without reviving a stale composer", async () => {
  mockIPC(() => undefined);
  const root = createRoot(document.getElementById("root")!);
  // When AppKit gives the native terminal first responder, WebKit may retain
  // the previous composer's DOM activeElement despite no longer owning input.
  const staleComposer = document.createElement("textarea");
  document.body.append(staleComposer);
  staleComposer.focus();
  const handle = createRef<TerminalPaneHandle>();
  let nativeOwner: string | null = null;
  let recoveredOwner: ReturnType<typeof windowFocusKeyboardOwner> | undefined;
  const props: ComponentProps<typeof TerminalPane> = {
    pane: { id: "focus-pane" } as ComponentProps<typeof TerminalPane>["pane"],
    active: true, visible: true, expandable: true,
    fontSize: 13, fontFamily: "monospace", letterSpacing: 0, lineHeight: 1,
    cursorBlink: false, cursorStyle: "block", scrollbackRows: 1000,
    scrollOnUserInput: true, scrollSensitivity: 1, copyOnSelect: false,
    selectionClearOnCopy: false, themeName: "qmux", pasteProtection: {} as any,
    deferGeometryUpdates: false, coveredByOverlay: false, inputBlocked: false,
    webEditableFocused: false, requestAttach: () => undefined,
    onCloseRemote: () => undefined, onRetryRemote: async () => undefined, ref: handle,
  };

  function OwnershipHarness() {
    const [expanded, setExpanded] = useState(false);
    const [overlayOpen, setOverlayOpen] = useState(false);
    const [webFocused, setWebFocused] = useState(false);
    const onOverlayStateChange = useCallback((_paneId: string, open: boolean) => setOverlayOpen(open), []);
    // Mirror App's focus sampler and expansion-removal backstop. DOM focus
    // alone is insufficient: native keyboard ownership must remain released.
    useEffect(() => {
      const sample = () => setWebFocused(document.hasFocus() && isWebKeyboardTarget(document.activeElement));
      const recover = () => {
        recoveredOwner = windowFocusKeyboardOwner({
          currentWebEditable: isWebKeyboardTarget(document.activeElement),
          rememberedWebEditable: false,
          returningToApp: false,
        });
        sample();
      };
      window.addEventListener("focusin", sample);
      window.addEventListener("focusout", sample);
      window.addEventListener("focus", recover);
      return () => {
        window.removeEventListener("focusin", sample);
        window.removeEventListener("focusout", sample);
        window.removeEventListener("focus", recover);
      };
    }, []);
    useEffect(() => {
      const frame = requestAnimationFrame(() => {
        setWebFocused(document.hasFocus() && isWebKeyboardTarget(document.activeElement));
      });
      return () => cancelAnimationFrame(frame);
    }, [expanded]);
    nativeOwner = desiredNativeTerminalKeyboardOwner({
      activePaneId: props.pane.id, paneSurfaceActive: true, activePaneVisible: true,
      activePaneReadOnly: false, inputBlocked: overlayOpen,
      webEditableFocused: webFocused, webSelectionActive: false,
    });
    return h(TerminalPane, {
      ...props, expanded, inputBlocked: overlayOpen, webEditableFocused: webFocused,
      onOverlayStateChange, onExpand: () => setExpanded(true), onRestore: () => setExpanded(false),
    });
  }

  try {
    await act(async () => { root.render(h(OwnershipHarness)); });
    assert.equal(document.activeElement, staleComposer);
    assert.equal(nativeOwner, props.pane.id, "native ownership is independent of stale DOM focus");
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Expand terminal"]')!.click(); });
    assert.equal(document.activeElement, document.querySelector(".terminal-expanded-frame"));
    assert.equal(isWebKeyboardTarget(document.activeElement), false);
    assert.equal(nativeOwner, props.pane.id, "initial expansion must leave the keyboard with the terminal");

    await act(async () => { handle.current!.openSearch(); });
    assert.equal(nativeOwner, null);
    const closeSearch = document.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!;
    await act(async () => { closeSearch.focus(); });
    await act(async () => { closeSearch.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    const restore = document.querySelector<HTMLButtonElement>('[aria-label="Restore terminal"]')!;
    assert.equal(document.activeElement, restore);
    assert.equal(document.querySelector(".pane-search"), null);
    assert.equal(nativeOwner, null, "closing search must not reclaim native input while Restore has focus");

    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(recoveredOwner, "current-web-editable", "focus recovery must preserve the marked web control");
    assert.equal(nativeOwner, null);
    await act(async () => { restore.click(); });
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    assert.equal(document.querySelector(".terminal-expanded-frame"), null);
    assert.notEqual(document.activeElement, staleComposer, "native-content dismissal must not refocus a stale composer");
    assert.equal(isWebKeyboardTarget(document.activeElement), false);
    assert.equal(nativeOwner, props.pane.id, "removing the focused portal must return keyboard ownership to the terminal");
  } finally {
    await act(async () => root.unmount());
    staleComposer.remove();
  }
});

test("the corner toolbar groups window controls with expand and yields the corner to search", async () => {
  const calls: { cmd: string; args: any }[] = [];
  mockIPC((cmd, args) => { calls.push({ cmd, args }); });
  const root = createRoot(document.getElementById("root")!);
  const handle = createRef<TerminalPaneHandle>();
  const props: ComponentProps<typeof TerminalPane> = {
    pane: { id: "toolbar-pane" } as ComponentProps<typeof TerminalPane>["pane"],
    active: true, visible: true, expandable: true,
    fontSize: 13, fontFamily: "monospace", letterSpacing: 0, lineHeight: 1,
    cursorBlink: false, cursorStyle: "block", scrollbackRows: 1000,
    scrollOnUserInput: true, scrollSensitivity: 1, copyOnSelect: false,
    selectionClearOnCopy: false, themeName: "qmux", pasteProtection: {} as any,
    deferGeometryUpdates: false, coveredByOverlay: false, inputBlocked: false,
    webEditableFocused: false, requestAttach: () => {},
    onCloseRemote: () => {}, onRetryRemote: async () => {},
    toolbarControls: h("button", { type: "button", "aria-label": "Show left sidebar" }),
    ref: handle,
  };
  const toolbar = () => document.querySelector(".terminal-pane-toolbar");
  const regionUpdates = () => calls.filter(c => c.cmd === "native_terminal_set_web_overlay_region");
  try {
    await act(async () => { root.render(h(TerminalPane, props)); });
    assert.deepEqual(
      [...toolbar()!.querySelectorAll("button")].map(button => button.getAttribute("aria-label")),
      ["Show left sidebar", "Expand terminal"],
      "window controls and expand share one group, expand last",
    );
    const region = regionUpdates().at(-1)!.args.region;
    assert.equal(region.visible, true);

    await act(async () => { handle.current!.openSearch(); });
    assert.equal(toolbar(), null, "the find bar takes the corner while open");
    assert.equal(
      regionUpdates().filter(c => c.args.region.regionId === region.regionId).at(-1)!.args.region.visible,
      false,
      "a hidden toolbar must not keep a pointer region over the terminal",
    );

    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click(); });
    assert.ok(toolbar(), "the toolbar returns when search closes");

    await act(async () => {
      root.render(h(TerminalPane, { ...props, toolbarControls: undefined, inputBlocked: true }));
    });
    assert.equal(toolbar(), null, "nothing to show without controls or an available expand");
  } finally {
    await act(async () => root.unmount());
  }
});
