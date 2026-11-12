import assert from "node:assert/strict";
import test from "node:test";

import {
  nativeTerminalLayoutRect,
  nativeTerminalCutout,
  canExpandNativeTerminal,
  nativeTerminalBackstopRect,
  type NativeTerminalRect,
} from "../src/lib/nativeTerminalLayout";

const rect = (
  left: number,
  top: number,
  width: number,
  height: number,
): NativeTerminalRect => ({ left, top, width, height });

test("visible terminals use and remember their measured layout", () => {
  const measured = rect(100, 50, 700, 600);

  assert.equal(nativeTerminalLayoutRect(measured, true, null), measured);
});

test("a hidden terminal keeps its last visible frame across right-pane changes", () => {
  const withRightPane = rect(100, 50, 700, 600);
  const withoutRightPane = rect(100, 50, 1100, 600);

  assert.equal(
    nativeTerminalLayoutRect(withoutRightPane, false, withRightPane),
    withRightPane,
  );
});

test("a full-width terminal keeps the same frame through a tab round trip", () => {
  const fullWidth = rect(100, 50, 1100, 600);
  const otherTab = rect(100, 50, 700, 600);
  const parked = nativeTerminalLayoutRect(otherTab, false, fullWidth);
  const restored = nativeTerminalLayoutRect(fullWidth, true, parked);

  assert.equal(parked, fullWidth);
  assert.equal(restored, fullWidth);
});

test("a never-visible terminal may adopt its initial hidden frame", () => {
  const initial = rect(100, 50, 1100, 600);

  assert.equal(nativeTerminalLayoutRect(initial, false, null), initial);
});


test("full-bleed cutout rounds all four corners without moving the native rectangle", () => {
  const cutout = nativeTerminalCutout(rect(19, 19, 962, 662), 1000, 700, 11);
  assert.match(cutout, /^path\(evenodd, "M0 0H1000V700H0Z M30 19H970/);
  assert.equal((cutout.match(/A11 11 0 0 1/g) ?? []).length, 4);
  assert.ok(cutout.endsWith('A11 11 0 0 1 30 19Z")'));
  assert.equal((nativeTerminalCutout(rect(0, 0, 10, 8), 10, 8, 11).match(/A4 4/g) ?? []).length, 4);
});


test("expansion is available for splits or an unsplit terminal beside a right pane", () => {
  assert.equal(canExpandNativeTerminal(true, 1, true), true);
  assert.equal(canExpandNativeTerminal(true, 2, false), true);
  assert.equal(canExpandNativeTerminal(true, 1, false), false);
  assert.equal(canExpandNativeTerminal(false, 2, true), false);
});

test("expanded backstop covers growth beyond the normal terminal stage during deferred fitting", () => {
  const stage = rect(268, 0, 600, 700);
  assert.equal(nativeTerminalBackstopRect(stage, false, 1280, 800), stage);
  assert.deepEqual(nativeTerminalBackstopRect(stage, true, 1280, 800), rect(0, 0, 1280, 800));
  assert.deepEqual(nativeTerminalBackstopRect(stage, true, 1600, 1000), rect(0, 0, 1600, 1000));
});
