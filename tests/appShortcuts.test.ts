import assert from "node:assert/strict";
import test from "node:test";
import {
  appShortcutAllowsRepeat,
  parseAppShortcutCommand,
  resolveAppShortcut,
  type AppShortcutInput,
} from "../src/lib/appShortcuts";

const shortcut = (overrides: Partial<AppShortcutInput>): AppShortcutInput => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("resolves qmux command and control shortcuts", () => {
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "t", metaKey: true })), {
    type: "newPane",
  });
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "Tab", ctrlKey: true })), {
    type: "cyclePaneTab",
    direction: 1,
  });
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "Tab", ctrlKey: true, shiftKey: true })),
    { type: "cyclePaneTab", direction: -1 },
  );
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "4", ctrlKey: true })), {
    type: "focusTab",
    tabIndex: 3,
  });
});

test("normalizes shifted bracket shortcuts", () => {
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "{", metaKey: true, shiftKey: true })),
    { type: "cycleAllTab", direction: -1 },
  );
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "}", metaKey: true, shiftKey: true })),
    { type: "cycleAllTab", direction: 1 },
  );
});

test("leaves terminal command chords and control editing keys alone", () => {
  for (const key of ["k", "a", "z", "Enter"]) {
    assert.equal(resolveAppShortcut(shortcut({ key, metaKey: true })), null);
  }
  assert.equal(
    resolveAppShortcut(shortcut({ key: "w", ctrlKey: true, terminalTarget: true })),
    null,
  );
  assert.equal(resolveAppShortcut(shortcut({ key: "t", ctrlKey: true })), null);
});

test("only font commands repeat", () => {
  assert.equal(appShortcutAllowsRepeat({ type: "fontZoomIn" }), true);
  assert.equal(appShortcutAllowsRepeat({ type: "newPane" }), false);
});

test("parses semantic commands from native payloads", () => {
  assert.deepEqual(parseAppShortcutCommand("focusTab", 2), {
    type: "focusTab",
    tabIndex: 2,
  });
  assert.deepEqual(parseAppShortcutCommand("cycleAllTabPrevious", null), {
    type: "cycleAllTab",
    direction: -1,
  });
  assert.equal(parseAppShortcutCommand("focusTab", -1), null);
  assert.equal(parseAppShortcutCommand("notACommand", null), null);
});
