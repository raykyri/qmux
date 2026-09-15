import assert from "node:assert/strict";
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

test("classNames keeps only applicable component classes", () => {
  assert.equal(classNames("base", false, null, undefined, "active"), "base active");
});

test("button variants provide shared chrome and safe default types", () => {
  const markup = renderToStaticMarkup(
    createElement(Button, { variant: "menu", compact: true, className: "feature-action" }, "Open"),
  );
  assert.match(markup, /type="button"/);
  assert.match(markup, /class="menu-item menu-item--compact feature-action"/);
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

test("Select exposes the shared custom combobox API", () => {
  const markup = renderToStaticMarkup(
    createElement(Select, {
      id: "agent-select",
      value: "one",
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two", group: "Other" },
      ],
      onChange: () => undefined,
    }),
  );
  assert.match(markup, /class="custom-select"/);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />One</);
});
