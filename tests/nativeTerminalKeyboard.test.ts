import assert from "node:assert/strict";
import test from "node:test";

import { desiredNativeTerminalKeyboardOwner } from "../src/lib/nativeTerminalKeyboard";

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
