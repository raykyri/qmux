import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBackdrop,
  Input,
  Menu,
  MenuItem,
  NativeSelect,
  Select,
  Textarea,
  classNames,
} from "../src/components/ui";
import {
  firstEnabledIndex,
  lastEnabledIndex,
  nextEnabledIndex,
  nextTypeaheadQuery,
  typeaheadIndex,
} from "../src/components/ui/hooks/useListbox";
import {
  LAUNCHER_SUBMENU_VALUE,
  LauncherSelectSubmenuRow,
  launcherSelectNavOptions,
  launcherSubmenuKeyAction,
} from "../src/components/LauncherSelect";

test("classNames keeps only applicable component classes", () => {
  assert.equal(classNames("base", false, null, undefined, "active"), "base active");
});

test("button variants provide shared chrome, tone, and safe default types", () => {
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(
        Button,
        { variant: "menu", size: "compact", className: "feature-action" },
        "Open",
      ),
      createElement(Button, { tone: "danger" }, "Delete"),
    ),
  );
  assert.match(markup, /type="button"/);
  assert.match(markup, /class="menu-item menu-item--compact feature-action"/);
  assert.match(markup, /class="control-button danger"/);
});

test("form controls compose the form-field primitive with feature classes", () => {
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(Input, { className: "name-input", defaultValue: "Name" }),
      createElement(Textarea, { className: "body-input", defaultValue: "Body" }),
      createElement(
        NativeSelect,
        { className: "kind-select", defaultValue: "one" },
        createElement("option", { value: "one" }, "One"),
      ),
    ),
  );
  assert.match(markup, /class="form-field name-input"/);
  assert.match(markup, /class="form-field body-input"/);
  assert.match(markup, /class="form-field kind-select"/);
});

test("dialog and menu composition applies accessible shared structure", () => {
  const dialog = renderToStaticMarkup(
    createElement(
      DialogBackdrop,
      null,
      createElement(
        Dialog,
        { "aria-label": "Confirm action" },
        createElement(DialogActions, null, createElement(Button, null, "OK")),
      ),
    ),
  );
  assert.match(dialog, /class="confirm-dialog-backdrop"/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /class="confirm-dialog-actions"/);

  const menu = renderToStaticMarkup(
    createElement(Menu, null, createElement(MenuItem, { selected: true }, "Selected")),
  );
  assert.match(menu, /class="popover-surface popover-surface--context"/);
  assert.match(menu, /role="menu"/);
  assert.match(menu, /class="menu-item is-selected"/);
});

test("listbox navigation skips disabled options and wraps", () => {
  const options = [
    { value: "one", label: "One" },
    { value: "two", label: "Two", disabled: true },
    { value: "three", label: "Three" },
  ];
  assert.equal(firstEnabledIndex(options), 0);
  assert.equal(lastEnabledIndex(options), 2);
  assert.equal(nextEnabledIndex(options, 0, 1), 2);
  assert.equal(nextEnabledIndex(options, 2, 1), 0);
  assert.equal(nextEnabledIndex(options, 0, -1), 2);
  assert.equal(typeaheadIndex(options, 0, "th"), 2);
  assert.equal(typeaheadIndex(options, 2, "o"), 0);
  assert.equal(nextTypeaheadQuery("a", "a", 100), "a");
  assert.equal(nextTypeaheadQuery("a", "b", 100), "ab");
  assert.equal(nextTypeaheadQuery("ab", "c", 600), "c");
});

test("Select exposes valid fallback and empty combobox states", () => {
  const invalid = renderToStaticMarkup(
    createElement(Select, {
      id: "agent-select",
      value: "missing",
      placeholder: "Choose agent",
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two", group: "Other" },
      ],
      onChange: () => undefined,
    }),
  );
  assert.match(invalid, /class="custom-select"/);
  assert.match(invalid, /role="combobox"/);
  assert.match(invalid, /aria-expanded="false"/);
  assert.match(invalid, />Choose agent</);
  assert.doesNotMatch(invalid, />One</);

  const empty = renderToStaticMarkup(
    createElement(Select, { value: "", options: [], onChange: () => undefined }),
  );
  assert.match(empty, /disabled=""/);
});

test("the launcher submenu row keeps its own listbox navigation model", () => {
  const options = [
    { value: "fable", label: "Fable" },
    { value: "opus", label: "Opus" },
  ];
  const submenu = {
    label: "Effort",
    value: "medium",
    options: [{ value: "medium", label: "Medium" }],
    onChange: () => undefined,
  };
  assert.equal(launcherSelectNavOptions(options, undefined), options);
  const nav = launcherSelectNavOptions(options, submenu);
  assert.equal(nav.length, 3);
  assert.deepEqual(nav[2], {
    value: LAUNCHER_SUBMENU_VALUE,
    label: "Effort",
    dividerBefore: true,
  });
  assert.equal(launcherSubmenuKeyAction("ArrowRight"), "open");
  assert.equal(launcherSubmenuKeyAction("Enter"), "open");
  assert.equal(launcherSubmenuKeyAction(" "), "open");
  assert.equal(launcherSubmenuKeyAction("ArrowLeft"), "close");
  assert.equal(launcherSubmenuKeyAction("ArrowDown"), null);
});

test("the launcher submenu row announces its nested list in both states", () => {
  const props = {
    id: "launcher-select-x-option-2",
    rowRef: { current: null },
    submenu: {
      label: "Effort",
      ariaLabel: "Reasoning effort",
      value: "medium",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
      ],
      onChange: () => undefined,
    },
    highlighted: true,
    onOpen: () => undefined,
    onClose: () => undefined,
    onHighlight: () => undefined,
    onReturnToParent: () => undefined,
  };
  const closed = renderToStaticMarkup(createElement(LauncherSelectSubmenuRow, {
    ...props,
    open: false,
  }));
  assert.match(closed, /class="launcher-select-separator" role="separator"/);
  assert.match(closed, /role="option"/);
  assert.match(closed, /aria-haspopup="listbox"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /launcher-select-submenu-trigger/);
  assert.match(closed, /launcher-select-submenu-chevron/);
  assert.doesNotMatch(closed, /is-open/);
  assert.match(closed, />Medium</);

  const open = renderToStaticMarkup(createElement(LauncherSelectSubmenuRow, {
    ...props,
    open: true,
  }));
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /launcher-select-submenu-trigger is-open is-highlighted/);
  assert.match(open, /aria-controls="launcher-select-submenu-/);
});

test("the checkbox box recipe lives in primitives, not in the feature sheets", () => {
  const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");
  const primitives = readFileSync(join(stylesDirectory, "primitives.css"), "utf8");
  const transcript = readFileSync(join(stylesDirectory, "features", "transcript.css"), "utf8");
  const shell = readFileSync(join(stylesDirectory, "features", "shell.css"), "utf8");

  // One rule carries appearance, border, fill and the checked glyph for every
  // checkbox in the app, including the GFM task-list inputs react-markdown
  // renders without a class.
  const recipe = primitives.match(/\.checkbox-control,[\s\S]*?\n\}/);
  assert.ok(recipe, "primitives.css must declare the shared checkbox recipe");
  assert.match(recipe[0], /\.settings-checkbox/);
  assert.match(recipe[0], /\.turn-markdown input\[type="checkbox"\]/);
  assert.match(recipe[0], /appearance: none/);
  assert.match(primitives, /background-image: var\(--checkbox-check\)/);
  assert.match(primitives, /\.checkbox-control:focus-visible/);
  assert.match(primitives, /\.checkbox-control:disabled/);

  // Feature sheets keep only their own modifiers.
  for (const [name, css] of [
    ["transcript.css", transcript],
    ["shell.css", shell],
  ] as const) {
    assert.doesNotMatch(css, /-webkit-appearance: none;\n\s+width: 1[34]px/, name);
    assert.doesNotMatch(css, /background-image: var\(--checkbox-check\)/, name);
  }
  const taskList = transcript.match(/\.turn-markdown input\[type="checkbox"\] \{([^}]*)\}/);
  assert.ok(taskList, "transcript.css must retune the task-list checkbox");
  assert.match(taskList[1], /--checkbox-size: 13px/);
  assert.match(taskList[1], /vertical-align: -2px/);
  assert.match(taskList[1], /cursor: default/);
});
