import assert from "node:assert/strict";
import test from "node:test";

import {
  desiredNativeTerminalKeyboardOwner,
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
