import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, useRef, useState } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { SelectProps } from "../src/components/ui/Select";
import type { WorktreeCreateDialogState } from "../src/components/repositoryDialogs.types";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost", pretendToBeVisual: true,
});
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "DOMRect", "Event", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true,
  });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
  cancelAnimationFrame: () => {},
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
const { Select, DialogRoot, DialogForm, Input, Button } = await import("../src/components/ui");
const container = document.getElementById("root")!;
let root = createRoot(container);
let changes: string[] = [];
let dismissed = 0;
let submitted = 0;
const options = [
  { value: "", label: "Current commit (new branch)" },
  { value: "main", label: "main", group: "Local branches" },
  { value: "disabled", label: "feature/disabled", group: "Local branches", disabled: true },
  { value: "feature", label: "feature/search — checked out", group: "Local branches" },
  { value: "remote", label: "origin/feature/search", group: "Remote branches" },
];
function Fixture({ props = {} }: { props?: Partial<SelectProps> }) {
  const [value, setValue] = useState("");
  return h(DialogRoot, { onDismiss: () => dismissed++ },
    h(DialogForm, { "aria-label": "Open worktree", onSubmit: (event) => { event.preventDefault(); submitted++; } },
      h("label", { htmlFor: "branch" }, "Start at"),
      h(Select, {
        id: "branch", searchable: true, searchPlaceholder: "Search branches…", value, options,
        onChange: (next) => { changes.push(next); setValue(next); }, ...props,
      }),
      h(Input, { id: "name", "aria-label": "Worktree name" }),
      h(Button, { type: "submit" }, "Open worktree"),
    ));
}
const render = (props: Partial<SelectProps> = {}) => act(() => root.render(h(Fixture, { props })));
const trigger = () => document.getElementById("branch") as HTMLButtonElement;
const search = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const list = () => document.querySelector('[role="listbox"]');
const labels = () => [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent);
const click = (element: HTMLElement) => act(() => element.click());
async function key(element: Element, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  await act(() => element.dispatchEvent(event));
  return event;
}
async function type(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search(), value);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
afterEach(async () => {
  await act(() => root.unmount());
  clearMocks(); changes = []; dismissed = 0; submitted = 0;
  root = createRoot(container);
});
after(async () => { await act(() => root.unmount()); dom.window.close(); });
beforeEach(() => mockIPC(() => undefined));

test("search filters branch substrings case-insensitively, retains groups, and commits only on selection", async () => {
  await render(); await click(trigger());
  assert.equal(document.activeElement, search());
  await type("SEARCH");
  assert.deepEqual(labels(), ["feature/search — checked out", "origin/feature/search"]);
  assert.equal(document.querySelectorAll('[role="group"]').length, 2);
  assert.match(trigger().textContent!, /Current commit/);
  assert.deepEqual(changes, []);
  const active = search().getAttribute("aria-activedescendant")!;
  assert.equal(document.getElementById(active)?.textContent, labels()[0]);
  await key(search(), "ArrowDown"); await key(search(), "Enter");
  assert.deepEqual(changes, ["remote"]);
  assert.equal(list(), null);
  assert.equal(document.activeElement, trigger());
  assert.match(trigger().textContent!, /origin\/feature\/search/);
  assert.equal(submitted, 0);
  await click(trigger());
  assert.equal(search().value, "");
  assert.equal(labels().length, options.length);
});

test("Escape cancels the search before dismissing the dialog and Tab restores the normal tab origin", async () => {
  await render(); await key(trigger(), "s");
  assert.equal(search().value, "s");
  await key(search(), "Escape");
  assert.equal(list(), null); assert.equal(dismissed, 0);
  assert.equal(document.activeElement, trigger());
  await click(trigger()); await type("no-match");
  assert.deepEqual(labels(), []);
  assert.equal(search().getAttribute("aria-activedescendant"), null);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /No matching/);
  await key(search(), "Enter");
  assert.equal(submitted, 0); assert.deepEqual(changes, []);
  const tab = await key(search(), "Tab");
  assert.equal(tab.defaultPrevented, false);
  assert.equal(list(), null); assert.equal(document.activeElement, trigger());
  await key(trigger(), "Escape"); assert.equal(dismissed, 1);
});

test("editing keys, shortcuts, spaces, and IME input are not intercepted", async () => {
  await render(); await key(trigger(), " ");
  for (const [keyName, extra] of [
    ["Home", {}], ["End", {}], [" ", {}], ["a", { metaKey: true }],
    ["ArrowDown", { ctrlKey: true }], ["Enter", { isComposing: true }],
  ] as Array<[string, KeyboardEventInit]>) {
    assert.equal((await key(search(), keyName, extra)).defaultPrevented, false, keyName);
    assert.ok(list()); assert.deepEqual(changes, []);
  }
});

test("Shift-Tab from the first dialog control wraps to its last action, not the disappearing popup", async () => {
  await render(); await click(trigger());
  const event = await key(search(), "Tab", { shiftKey: true });
  assert.equal(list(), null);
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.activeElement?.textContent, "Open worktree");
});

test("navigation skips disabled matches; mouse selection and reselection restore focus", async () => {
  await render(); await click(trigger()); await type("feature");
  assert.match(document.getElementById(search().getAttribute("aria-activedescendant")!)!.textContent!, /checked out/);
  await key(search(), "ArrowUp");
  assert.match(document.getElementById(search().getAttribute("aria-activedescendant")!)!.textContent!, /origin/);
  await click(document.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]);
  assert.deepEqual(changes, ["feature"]); assert.equal(document.activeElement, trigger());
  await click(trigger()); await key(search(), "Enter");
  assert.equal(list(), null); assert.equal(document.activeElement, trigger());
  assert.deepEqual(changes, ["feature"]);
});

test("loading options arrive during search; empty and disabled states stay usable", async () => {
  await render({ options: [], loading: true }); await click(trigger());
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Loading/);
  await type("main"); await render({ loading: false });
  assert.equal(document.activeElement, search());
  assert.deepEqual(labels(), ["main"]);
  await key(search(), "Enter"); assert.deepEqual(changes, ["main"]);
  await render({ disabled: true }); await click(trigger()); assert.equal(list(), null);
  await render({ options: [] }); await click(trigger());
  assert.ok(search()); assert.deepEqual(labels(), []);
  await render({ disabled: true }); assert.equal(list(), null);
});

test("outside clicks dismiss without committing and ordinary selects retain typeahead", async () => {
  await render(); await click(trigger()); await type("search");
  await act(() => document.getElementById("name")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  assert.equal(list(), null); assert.deepEqual(changes, []);
  await render({ searchable: false });
  await key(trigger(), "m");
  assert.equal(document.getElementById(trigger().getAttribute("aria-activedescendant")!)!.textContent, "main");
  await key(trigger(), "Enter"); assert.deepEqual(changes, ["main"]);
});

test("the worktree dialog searches local and remote branches and updates the name", async () => {
  const { default: WorktreeCreateDialog } = await import("../src/components/WorktreeCreateDialog");
  function WorktreeFixture() {
    const [state, setState] = useState<WorktreeCreateDialogState | null>({
      pane: { id: "pane", title: "Terminal", kind: "shell", groupId: "group", cwd: "/repo", cols: 80, rows: 24, status: "running" },
      action: { kind: "open" }, name: "suggested-name", suggestedName: "suggested-name",
      creating: false, error: null, inventoryLoading: false, inventoryError: null,
      startRef: null, requestId: 1,
      inventory: { repositoryRoot: "/repo", worktrees: [], branches: [
        { name: "feature/local", fullRef: "refs/heads/feature/local", head: "abc", remote: false, checkedOutPath: "/repo/local" },
        { name: "origin/feature/remote", fullRef: "refs/remotes/origin/feature/remote", head: "abc", remote: true },
      ] },
    });
    const inputRef = useRef<HTMLInputElement | null>(null);
    return state && h(WorktreeCreateDialog, {
      worktreeCreateDialog: state, setWorktreeCreateDialog: setState,
      dismissWorktreeCreateDialog: () => {}, createWorktreeFromDialog: async () => {},
      worktreeNameInputRef: inputRef,
    });
  }
  await act(() => root.render(h(WorktreeFixture)));
  const start = () => document.getElementById("create-worktree-start") as HTMLButtonElement;
  const name = () => (document.getElementById("create-worktree-name") as HTMLInputElement).value;
  await click(start()); await type("LOCAL"); await key(search(), "Enter");
  assert.equal(name(), "local");
  await click(start()); await type("remote"); await key(search(), "Enter");
  assert.equal(name(), "remote");
  await click(start()); await type("Current commit"); await key(search(), "Enter");
  assert.equal(name(), "suggested-name");
});
