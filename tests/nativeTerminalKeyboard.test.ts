import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  desiredNativeTerminalKeyboardOwner,
  reconcileWebSelectionForTabSwitch,
  windowFocusKeyboardOwner,
} from "../src/lib/nativeTerminalKeyboard";

const eligible = {
  activePaneId: "pane-1",
  paneSurfaceActive: true,
  activePaneVisible: true,
  activePaneReadOnly: false,
  inputBlocked: false,
  webEditableFocused: false,
  webSelectionActive: false,
};

test("eligible active pane is the desired native keyboard owner", () => {
  assert.equal(desiredNativeTerminalKeyboardOwner(eligible), "pane-1");
});

test("keyboard blockers release the desired native keyboard owner", () => {
  for (const update of [
    { paneSurfaceActive: false },
    { activePaneVisible: false },
    { activePaneReadOnly: true },
    { inputBlocked: true },
    { webEditableFocused: true },
    { webSelectionActive: true },
  ]) {
    assert.equal(
      desiredNativeTerminalKeyboardOwner({ ...eligible, ...update }),
      null,
      JSON.stringify(update),
    );
  }
});

test("switching tabs clears an empty range around the outgoing terminal surface", (t) => {
  const { window } = new JSDOM(`
    <div data-pane-content-id="pane-1"><div class="terminal-host"></div></div>
    <div data-pane-content-id="pane-2"><div class="terminal-host"></div></div>
  `);
  t.after(() => window.close());
  const { document } = window;
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.selectNode(document.querySelector('[data-pane-content-id="pane-1"]')!);
  selection.addRange(range);
  assert.equal(selection.isCollapsed, false);
  assert.equal(selection.toString(), "");
  assert.equal(desiredNativeTerminalKeyboardOwner({ ...eligible, webSelectionActive: true }), null);

  const webSelectionActive = reconcileWebSelectionForTabSwitch(document, "pane-1");
  assert.equal(selection.rangeCount, 0);
  assert.equal(desiredNativeTerminalKeyboardOwner({
    ...eligible, activePaneId: "pane-2", webSelectionActive,
  }), "pane-2");
});

test("switching tabs clears the outgoing transcript selection and preserves other web selections", (t) => {
  const { window } = new JSDOM(`
    <section data-pane-content-id="pane-1">Outgoing transcript</section>
    <section data-pane-content-id="pane-2">Other transcript</section>
    <aside>Unrelated web text</aside>
  `);
  t.after(() => window.close());
  const { document } = window;
  const selection = document.getSelection()!;
  for (const surface of document.querySelectorAll("section, aside")) {
    const range = document.createRange();
    range.selectNodeContents(surface);
    selection.removeAllRanges();
    selection.addRange(range);

    const shouldKeepSelection = surface.textContent !== "Outgoing transcript";
    assert.equal(reconcileWebSelectionForTabSwitch(document, "pane-1"), shouldKeepSelection);
    assert.equal(selection.toString(), shouldKeepSelection ? surface.textContent : "");
  }

  const [outgoing, other] = document.querySelectorAll("section");
  const spanningRange = document.createRange();
  spanningRange.setStart(outgoing.firstChild!, 0);
  spanningRange.setEnd(other.firstChild!, 5);
  selection.removeAllRanges();
  selection.addRange(spanningRange);
  assert.equal(reconcileWebSelectionForTabSwitch(document, "pane-1"), true);
  assert.match(selection.toString(), /Outgoing transcript\s+Other/);
});

test("switching tabs can reset a stale blocker when the selection has already collapsed", (t) => {
  const { window } = new JSDOM('<section data-pane-content-id="pane-1">Transcript</section>');
  t.after(() => window.close());
  const { document } = window;
  document.getSelection()!.collapse(document.querySelector("section")!.firstChild, 0);
  assert.equal(reconcileWebSelectionForTabSwitch(document, "pane-1"), false);
});

test("no selected pane has no desired native keyboard owner", () => {
  assert.equal(
    desiredNativeTerminalKeyboardOwner({ ...eligible, activePaneId: null }),
    null,
  );
});

test("transcript and geometry state cannot influence ownership", () => {
  const beforeTranscriptDetach = desiredNativeTerminalKeyboardOwner(eligible);
  // The ownership input intentionally has no transcript membership, width, or
  // frame fields, so a right-pane detach computes from the same state.
  const afterTranscriptDetach = desiredNativeTerminalKeyboardOwner({ ...eligible });
  assert.equal(beforeTranscriptDetach, "pane-1");
  assert.equal(afterTranscriptDetach, beforeTranscriptDetach);
});

test("app reactivation restores the remembered web editor", () => {
  assert.equal(
    windowFocusKeyboardOwner({
      currentWebEditable: false,
      rememberedWebEditable: true,
      returningToApp: true,
    }),
    "remembered-web-editable",
  );
});

test("current web focus wins without requiring restoration", () => {
  assert.equal(
    windowFocusKeyboardOwner({
      currentWebEditable: true,
      rememberedWebEditable: false,
      returningToApp: false,
    }),
    "current-web-editable",
  );
});

test("internal WebKit focus churn does not revive an old editor", () => {
  assert.equal(
    windowFocusKeyboardOwner({
      currentWebEditable: false,
      rememberedWebEditable: true,
      returningToApp: false,
    }),
    "native-terminal",
  );
});
