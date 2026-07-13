import assert from "node:assert/strict";
import test from "node:test";
import {
  appShortcutAllowsRepeat,
  contextualizeAppShortcut,
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
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "n", metaKey: true, shiftKey: true })),
    { type: "newGroup" },
  );
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
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "r", metaKey: true, shiftKey: true })),
    { type: "focusResearchMode" },
  );
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "`", metaKey: true })), {
    type: "toggleSidebarMode",
  });
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "ArrowUp", altKey: true })), {
    type: "moveSidebarItem",
    direction: -1,
  });
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "ArrowDown", altKey: true })), {
    type: "moveSidebarItem",
    direction: 1,
  });
  assert.equal(
    resolveAppShortcut(shortcut({ key: "ArrowUp", altKey: true, editableTarget: true })),
    null,
  );
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "Dead", code: "Backquote", metaKey: true })),
    { type: "toggleSidebarMode" },
  );
  assert.equal(resolveAppShortcut(shortcut({ key: ";", metaKey: true })), null);
  assert.equal(resolveAppShortcut(shortcut({ key: ";", ctrlKey: true })), null);
  assert.equal(
    resolveAppShortcut(shortcut({ key: "r", metaKey: true, altKey: true })),
    null,
  );
  // ⌘K opens the palette for web targets only; the terminal keeps it (clear
  // screen), matching the native classifier which never claims ⌘K.
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "k", metaKey: true })), {
    type: "openCommandPalette",
  });
});

test("uses command-shift-t to leave Research and reopen tabs elsewhere", () => {
  const command = resolveAppShortcut(
    shortcut({ key: "t", metaKey: true, shiftKey: true }),
  );
  assert.deepEqual(command, { type: "restoreClosedPane" });
  assert.deepEqual(contextualizeAppShortcut(command!, "research"), {
    type: "focusTerminalMode",
  });
  assert.deepEqual(contextualizeAppShortcut(command!, "terminal"), {
    type: "restoreClosedPane",
  });
});

test("uses command-n for Research Home and the launcher elsewhere", () => {
  const command = resolveAppShortcut(shortcut({ key: "n", metaKey: true }));
  assert.deepEqual(command, { type: "homeOrCycleAdapter" });
  assert.deepEqual(contextualizeAppShortcut(command!, "research"), {
    type: "focusResearchHome",
  });
  assert.deepEqual(contextualizeAppShortcut(command!, "terminal"), {
    type: "homeOrCycleAdapter",
  });
});

test("uses command-t for new research and new panes elsewhere", () => {
  const command = resolveAppShortcut(shortcut({ key: "t", metaKey: true }));
  assert.deepEqual(command, { type: "newPane" });
  assert.deepEqual(contextualizeAppShortcut(command!, "research"), {
    type: "openNewResearch",
  });
  assert.deepEqual(contextualizeAppShortcut(command!, "terminal"), {
    type: "newPane",
  });
});

test("keeps the Home shortcut within the active mode", () => {
  const command = resolveAppShortcut(
    shortcut({ key: "h", metaKey: true, shiftKey: true }),
  );
  assert.deepEqual(command, { type: "focusHome" });
  assert.deepEqual(contextualizeAppShortcut(command!, "research"), {
    type: "focusResearchHome",
  });
  assert.deepEqual(contextualizeAppShortcut(command!, "terminal"), command);
});

test("keeps numbered tab shortcuts within the active mode", () => {
  const command = resolveAppShortcut(shortcut({ key: "4", metaKey: true }));
  assert.deepEqual(command, { type: "focusTab", tabIndex: 3 });
  assert.deepEqual(contextualizeAppShortcut(command!, "research"), {
    type: "focusResearchTab",
    tabIndex: 3,
  });
  assert.deepEqual(contextualizeAppShortcut(command!, "terminal"), command);
});

test("normalizes shifted bracket shortcuts", () => {
  const previous = resolveAppShortcut(
    shortcut({ key: "{", metaKey: true, shiftKey: true }),
  );
  const next = resolveAppShortcut(
    shortcut({ key: "}", metaKey: true, shiftKey: true }),
  );
  assert.deepEqual(previous, { type: "cycleAllTab", direction: -1 });
  assert.deepEqual(next, { type: "cycleAllTab", direction: 1 });
  assert.deepEqual(contextualizeAppShortcut(previous!, "research"), {
    type: "cyclePaneTab",
    direction: -1,
  });
  assert.deepEqual(contextualizeAppShortcut(next!, "research"), {
    type: "cyclePaneTab",
    direction: 1,
  });
  assert.deepEqual(contextualizeAppShortcut(previous!, "terminal"), previous);
  assert.deepEqual(contextualizeAppShortcut(next!, "terminal"), next);
});

test("leaves terminal command chords and control editing keys alone", () => {
  for (const key of ["a", "z", "Enter"]) {
    assert.equal(resolveAppShortcut(shortcut({ key, metaKey: true })), null);
  }
  assert.equal(
    resolveAppShortcut(shortcut({ key: "k", metaKey: true, terminalTarget: true })),
    null,
  );
  assert.equal(
    resolveAppShortcut(shortcut({ key: "w", ctrlKey: true, terminalTarget: true })),
    null,
  );
  assert.equal(resolveAppShortcut(shortcut({ key: "t", ctrlKey: true })), null);
});

test("continuous adjustment commands repeat", () => {
  assert.equal(appShortcutAllowsRepeat({ type: "fontZoomIn" }), true);
  assert.equal(
    appShortcutAllowsRepeat({ type: "moveSidebarItem", direction: -1 }),
    true,
  );
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
  assert.deepEqual(parseAppShortcutCommand("newGroup", null), {
    type: "newGroup",
  });
  assert.deepEqual(parseAppShortcutCommand("focusTerminalMode", null), {
    type: "focusTerminalMode",
  });
  assert.deepEqual(parseAppShortcutCommand("focusResearchMode", null), {
    type: "focusResearchMode",
  });
  assert.deepEqual(parseAppShortcutCommand("toggleSidebarMode", null), {
    type: "toggleSidebarMode",
  });
  assert.deepEqual(parseAppShortcutCommand("moveSidebarItemUp", null), {
    type: "moveSidebarItem",
    direction: -1,
  });
  assert.deepEqual(parseAppShortcutCommand("moveSidebarItemDown", null), {
    type: "moveSidebarItem",
    direction: 1,
  });
  // Emitted by the native stranded-WKWebView fallback for Cmd+K; Swift has
  // already consumed the keyDown by then, so dropping it kills the chord.
  assert.deepEqual(parseAppShortcutCommand("openCommandPalette", null), {
    type: "openCommandPalette",
  });
  assert.equal(parseAppShortcutCommand("launcherOrCycleAdapter", null), null);
  assert.equal(parseAppShortcutCommand("focusTab", -1), null);
  assert.equal(parseAppShortcutCommand("notACommand", null), null);
});
