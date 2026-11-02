import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, StrictMode, Activity } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { PromptLibrary, PromptScope, SavedPrompt } from "../src/types";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const key of [
  "window", "document", "HTMLElement", "Element", "Node", "DOMRect",
  "CustomEvent", "Event", "MouseEvent", "KeyboardEvent",
]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
const { default: PromptLibraryMenu } = await import("../src/components/PromptLibraryMenu");
const { requestPromptAction, requestSaveDraftAsPrompt, listenToPromptLibraryChanged } =
  await import("../src/lib/promptLibrary");
const container = document.getElementById("root")!;
let root = createRoot(container);
let unsubscribe = () => {};
afterEach(async () => {
  unsubscribe();
  unsubscribe = () => {};
  await act(() => root.unmount());
  clearMocks();
  document.body.innerHTML = "";
  document.body.appendChild(container);
  root = createRoot(container);
});
after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const prompt = (name: string, scope: PromptScope = "project"): SavedPrompt =>
  ({ name, content: `${name} text`, scope, modifiedMs: 7 });
const library = (name: string, hasProjectScope = true): PromptLibrary =>
  ({ prompts: [prompt(name)], hasProjectScope });
const listedNames = () => [...document.querySelectorAll(".prompt-library-item-name")]
  .map((item) => item.textContent);
const editor = () => document.querySelector('[role="dialog"][aria-label$="prompt"]')!;
const button = (label: string, within: ParentNode = document) => {
  const result = [...within.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => label === "Save"
      ? item.textContent?.trim().startsWith("Save") : item.textContent?.trim() === label);
  assert.ok(result, `button ${label} exists`);
  return result;
};
const click = async (element: Element) => act(() => {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const render = async (projectDir: string | null, agentId = "agent", strict = false) => act(() => {
  const pane = h("div", { className: "turn-pane" },
    h(PromptLibraryMenu, { agentId, projectDir, onInsert: () => {} }));
  root.render(strict ? h(StrictMode, null, pane) : pane);
});
const open = () => click(document.querySelector('[aria-label="Prompt library"]')!);
const action = (kind: "edit" | "delete", value: SavedPrompt, agentId = "agent") => act(() => {
  requestPromptAction({ agentId, action: kind, prompt: value,
    returnFocusTo: document.querySelector<HTMLButtonElement>('[aria-label="Prompt library"]')! });
});
async function inputName(value: string) {
  const input = document.querySelector<HTMLInputElement>(".prompt-library-name-input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(input.value, value);
}
async function drop(value: SavedPrompt, target: "Global" | "Project") {
  await act(() => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: {
      getData: () => JSON.stringify({ scope: value.scope, name: value.name }),
    } });
    document.querySelector(`[role="group"][aria-label="${target}"]`)!.dispatchEvent(event);
  });
}
function ipc() {
  const calls: Array<{ command: string; args: any }> = [];
  const mutations: ReturnType<typeof deferred>[] = [];
  const config = {
    list: (projectDir: string | null): unknown => library(projectDir === "/a" ? "a" : "b"),
  };
  mockIPC((command, args) => {
    if (!command.startsWith("prompt_library_")) return undefined;
    calls.push({ command, args });
    if (command === "prompt_library_list") return config.list((args as any).projectDir);
    const pending = deferred();
    mutations.push(pending);
    return pending.promise;
  });
  const listCalls = () => calls.filter((call) => call.command === "prompt_library_list");
  return { calls, mutations, config, listCalls };
}
type Mutation = "create" | "edit" | "rename" | "delete" | "move";
async function startMutation(kind: Mutation, value = prompt("a")) {
  if (kind === "move") return drop(value, "Global");
  if (kind === "create") {
    await act(() => requestSaveDraftAsPrompt("agent", "New reusable content"));
    await inputName("created");
  } else {
    await action(kind === "delete" ? "delete" : "edit", value);
    if (kind === "rename") await inputName("renamed");
  }
  await click(button(kind === "delete" ? "Delete" : "Save", editor()));
}

for (const finalProject of ["/b", "/a"]) {
  test(`late load cannot cross project lifetime /a → /b${finalProject === "/a" ? " → /a" : ""}`, async () => {
    const { config } = ipc();
    const old = deferred<PromptLibrary>();
    config.list = () => old.promise;
    await render("/a");
    await open();
    await render("/b");
    if (finalProject === "/a") await render("/a");
    config.list = () => library("current");
    await open();
    await act(() => old.resolve(library("obsolete", false)));
    assert.deepEqual(listedNames(), ["/current"]);
    assert.ok(document.querySelector('[role="group"][aria-label="Project"]'));
  });
}

for (const staleResult of ["success", "failure"]) {
  test(`same-project newer refresh wins over old ${staleResult}`, async () => {
    const { config } = ipc();
    const old = deferred<PromptLibrary>();
    config.list = () => old.promise;
    await render("/a");
    await open();
    config.list = () => library("current");
    await action("edit", prompt("current"));
    await act(() => staleResult === "success"
      ? old.resolve(library("obsolete", false)) : old.reject(Error("obsolete load error")));
    assert.deepEqual(listedNames(), ["/current"]);
    assert.doesNotMatch(document.body.textContent!, /obsolete/);
  });
}

test("a project switch clears previous validation data before its first load succeeds", async () => {
  const { config } = ipc();
  await render("/a");
  await open();
  const pending = deferred();
  config.list = () => pending.promise;
  await render("/b");
  await action("edit", prompt("b"));
  assert.equal(button("Save", editor()).disabled, true);
  await act(() => pending.resolve(library("b")));
  assert.equal(button("Save", editor()).disabled, false);
});

for (const kind of ["create", "edit", "rename", "delete", "move"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`${kind} ${outcome} from old project cannot refresh, close, or poison current editor`, async () => {
      const { mutations, calls, listCalls } = ipc();
      let notifications = 0;
      unsubscribe = listenToPromptLibraryChanged(() => notifications++);
      await render("/a");
      await open();
      await startMutation(kind);
      assert.equal(mutations.length, 1);
      const write = calls.find((call) => call.command !== "prompt_library_list")!;
      assert.equal(write.args.projectDir, "/a");
      assert.equal(write.args.name, kind === "rename" ? "renamed" : kind === "create" ? "created" : "a");
      assert.equal(write.args.expectedModifiedMs, kind === "create" ? null : 7);
      if (kind !== "delete") {
        assert.equal(write.args.scope, kind === "create" || kind === "move" ? "global" : "project");
        assert.equal(write.args.previousName, kind === "create" ? null : "a");
      }
      await render("/b");
      await open();
      await action("edit", prompt("b"));
      const currentEditor = editor();
      const reads = listCalls().length;
      await act(() => outcome === "success"
        ? mutations[0].resolve(prompt("saved")) : mutations[0].reject(Error("old mutation error")));
      assert.equal(listCalls().length, reads, "obsolete continuation never issues another list");
      assert.equal(editor(), currentEditor, "old operation cannot close a new dialog");
      assert.equal(button("Save", editor()).disabled, false);
      assert.deepEqual(listedNames(), ["/b"]);
      assert.doesNotMatch(document.body.textContent!, /old mutation error/);
      assert.equal(notifications, outcome === "success" ? 1 : 0);
    });
  }
}

test("A → B → A does not revive an earlier save or its busy ownership", async () => {
  const { mutations, listCalls } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  await render("/b");
  await render("/a");
  await action("edit", prompt("a"));
  await click(button("Save", editor()));
  assert.equal(mutations.length, 2, "returning project can save while its old lifetime is pending");
  const reads = listCalls().length;
  await act(() => mutations[0].resolve(prompt("a")));
  assert.equal(listCalls().length, reads);
  assert.ok(button("Saving…", editor()).disabled, "old finally must not release the new save");
  await act(() => mutations[1].resolve(prompt("a")));
  assert.equal(editor(), null);
});

test("stale mutation error cannot mask first-load retry in the new project", async () => {
  const { mutations, config } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  await render("/b");
  config.list = () => Promise.reject(Error("current load error"));
  await action("edit", prompt("b"));
  await act(() => mutations[0].reject(Error("old mutation error")));
  assert.doesNotMatch(editor().textContent!, /old mutation error/);
  assert.equal(button("Save", editor()).disabled, true);
  config.list = () => library("b");
  await click(button("Retry", editor()));
  assert.equal(button("Save", editor()).disabled, false);
  assert.doesNotMatch(editor().textContent!, /current load error/);
});

test("failed first load retries in the editor and a failed retry remains recoverable", async () => {
  const { config, listCalls } = ipc();
  config.list = () => Promise.reject(Error("unavailable"));
  await render("/a");
  await action("edit", prompt("a"));
  await click(button("Retry", editor()));
  assert.equal(listCalls().length, 2);
  config.list = () => library("a");
  await click(button("Retry", editor()));
  assert.equal(button("Save", editor()).disabled, false);
});

test("same-project replacement dialog can save concurrently and old finally cannot clear busy", async () => {
  const { mutations } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  await action("edit", prompt("second"));
  await click(button("Save", editor()));
  assert.equal(mutations.length, 2);
  await act(() => mutations[0].resolve(prompt("a")));
  assert.ok(button("Saving…", editor()).disabled);
  assert.equal(document.querySelector<HTMLInputElement>(".prompt-library-name-input")!.value, "second");
  await act(() => mutations[1].reject(Error("second save conflict")));
  assert.match(editor().textContent!, /second save conflict/);
  assert.equal(button("Save", editor()).disabled, false);
  await click(button("Save", editor()));
  await act(() => mutations[2].resolve(prompt("second")));
  assert.equal(editor(), null);
});

test("older same-project save failure cannot overwrite the newer editor error", async () => {
  const { mutations } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  await action("edit", prompt("second"));
  await click(button("Save", editor()));
  assert.equal(mutations.length, 2);
  await act(() => mutations[1].reject(Error("new conflict")));
  await act(() => mutations[0].reject(Error("old conflict")));
  assert.match(editor().textContent!, /new conflict/);
  assert.doesNotMatch(editor().textContent!, /old conflict/);
});

test("save response followed by project change during refresh cannot close the new editor", async () => {
  const { mutations, config } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  const refresh = deferred<PromptLibrary>();
  config.list = () => refresh.promise;
  await act(() => mutations[0].resolve(prompt("a")));
  await render("/b");
  config.list = () => library("b");
  await action("edit", prompt("b"));
  await act(() => refresh.resolve(library("obsolete")));
  assert.equal(document.querySelector<HTMLInputElement>(".prompt-library-name-input")!.value, "b");
  assert.equal(button("Save", editor()).disabled, false);
});

test("same project with a different composer invalidates old operation ownership", async () => {
  const { mutations, listCalls } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  await render("/a", "other-agent");
  await action("edit", prompt("second"), "other-agent");
  const reads = listCalls().length;
  await act(() => mutations[0].resolve(prompt("a")));
  assert.equal(listCalls().length, reads);
  assert.equal(document.querySelector<HTMLInputElement>(".prompt-library-name-input")!.value, "second");
});

for (const outcome of ["success", "failure"] as const) {
  test(`unmount prevents ${outcome} continuation from fetching but preserves committed notification`, async () => {
    const { mutations, listCalls } = ipc();
    let notifications = 0;
    unsubscribe = listenToPromptLibraryChanged(() => notifications++);
    await render("/a");
    await open();
    await startMutation("edit");
    await act(() => root.render(null));
    const reads = listCalls().length;
    await act(() => outcome === "success"
      ? mutations[0].resolve(prompt("a")) : mutations[0].reject(Error("disposed error")));
    assert.equal(listCalls().length, reads);
    assert.equal(notifications, outcome === "success" ? 1 : 0);
    await render("/a");
    await open();
    assert.deepEqual(listedNames(), ["/a"]);
  });
}

test("initial refresh survives StrictMode setup/cleanup and ordinary same-project rerender", async () => {
  const { config, mutations } = ipc();
  const first = deferred<PromptLibrary>();
  config.list = () => first.promise;
  await render("/a", "agent", true);
  await open();
  await render("/a", "agent", true);
  await act(() => first.resolve(library("a")));
  assert.deepEqual(listedNames(), ["/a"]);
  config.list = () => library("a");
  await startMutation("edit");
  assert.equal(document.querySelector<HTMLInputElement>(".prompt-library-name-input")!.disabled, true);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".prompt-library-editor")!.disabled, true);
  assert.ok([...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].every((el) => el.disabled));
  await act(() => mutations[0].resolve(prompt("a")));
  assert.equal(editor(), null);
});

test("two save shortcuts in one event batch issue only one write", async () => {
  const { mutations } = ipc();
  await render("/a");
  await action("edit", prompt("a"));
  await act(() => {
    for (let index = 0; index < 2; index++) {
      editor().dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", metaKey: true, bubbles: true, cancelable: true,
      }));
    }
  });
  assert.equal(mutations.length, 1);
  await act(() => mutations[0].resolve(prompt("a")));
});

test("a stale load success cannot clear the newest first-load failure and Retry", async () => {
  const { config } = ipc();
  const old = deferred<PromptLibrary>();
  config.list = () => old.promise;
  await render("/a");
  await open();
  config.list = () => Promise.reject(Error("newest load failed"));
  await action("edit", prompt("a"));
  await act(() => old.resolve(library("obsolete")));
  assert.equal(button("Save", editor()).disabled, true);
  assert.match(editor().textContent!, /newest load failed/);
  config.list = () => library("a");
  await click(button("Retry", editor()));
  assert.deepEqual(listedNames(), ["/a"]);
});

test("a current save that persisted still closes after refresh failure, leaving list Retry", async () => {
  const { config, mutations } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  config.list = () => Promise.reject(Error("refresh unavailable"));
  await act(() => mutations[0].resolve(prompt("a")));
  assert.equal(editor(), null);
  assert.match(document.body.textContent!, /refresh unavailable/);
  config.list = () => library("saved");
  await click(button("Retry"));
  assert.deepEqual(listedNames(), ["/saved"]);
  assert.doesNotMatch(document.body.textContent!, /refresh unavailable/);
});

test("same-project mutation completion refreshes data without closing its replacement editor", async () => {
  const { config, mutations } = ipc();
  await render("/a");
  await open();
  await startMutation("edit");
  await action("edit", prompt("second"));
  config.list = () => ({ prompts: [prompt("a"), prompt("second")], hasProjectScope: true });
  await act(() => mutations[0].resolve(prompt("a")));
  assert.deepEqual(listedNames(), ["/a", "/second"]);
  assert.equal(document.querySelector<HTMLInputElement>(".prompt-library-name-input")!.value, "second");
  assert.equal(button("Save", editor()).disabled, false);
});

for (const kind of ["delete", "move"] as const) {
  test(`current ${kind} failure releases busy, keeps the error, and permits retry`, async () => {
    const { mutations, config } = ipc();
    await render("/a");
    await open();
    await startMutation(kind);
    await act(() => mutations[0].reject(Error("current mutation conflict")));
    assert.match(document.body.textContent!, /current mutation conflict/);
    if (kind === "delete") await click(button("Delete", editor()));
    else await drop(prompt("a"), "Global");
    assert.equal(mutations.length, 2);
    config.list = () => ({ prompts: [], hasProjectScope: true });
    await act(() => mutations[1].resolve(undefined));
    assert.equal(editor(), null);
    assert.deepEqual(listedNames(), []);
    assert.doesNotMatch(document.body.textContent!, /current mutation conflict/);
  });
}

test("late pre-mutation list cannot undo the post-mutation refresh", async () => {
  const { config, mutations } = ipc();
  await render("/a");
  await open();
  const older = deferred<PromptLibrary>();
  config.list = () => older.promise;
  await action("edit", prompt("a"));
  await click(button("Save", editor()));
  config.list = () => library("saved");
  await act(() => mutations[0].resolve(prompt("saved")));
  await act(() => older.resolve(library("obsolete")));
  assert.deepEqual(listedNames(), ["/saved"]);
});

test("late unmounted read cannot affect a fresh mount", async () => {
  const { config } = ipc();
  const old = deferred<PromptLibrary>();
  config.list = () => old.promise;
  await render("/a");
  await open();
  await act(() => root.render(null));
  config.list = () => library("remounted");
  await render("/a");
  await open();
  await act(() => old.resolve(library("obsolete")));
  assert.deepEqual(listedNames(), ["/remounted"]);
});


test("effect disposal and reactivation cannot revive an earlier mutation's refresh", async () => {
  const { mutations, listCalls } = ipc();
  const activity = (mode: "visible" | "hidden") => act(() => root.render(
    h(Activity, { mode }, h("div", { className: "turn-pane" },
      h(PromptLibraryMenu, { agentId: "agent", projectDir: "/a", onInsert: () => {} }))),
  ));
  await activity("visible");
  await open();
  await startMutation("edit");
  await activity("hidden");
  await activity("visible");
  await action("edit", prompt("current"));
  const reads = listCalls().length;
  await act(() => mutations[0].resolve(prompt("a")));
  assert.equal(listCalls().length, reads, "reactivation must not admit an old operation's read");
  assert.equal(document.querySelector<HTMLInputElement>(".prompt-library-name-input")!.value, "current");
});
