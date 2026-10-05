import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "DOMRect",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
const { default: Select } = await import("../src/components/ui/Select");
const { default: ResearchFolderSwitcher } = await import(
  "../src/components/research/ResearchFolderSwitcher"
);
const { default: TranscriptPickerLink } = await import("../src/components/TranscriptPickerLink");
const { default: LinkContextMenu } = await import("../src/components/LinkContextMenu");
const { default: ImageLightbox } = await import("../src/components/ImageLightbox");
const { default: DiagramLightbox } = await import("../src/components/DiagramLightbox");
const { openImageLightbox, closeImageLightbox } = await import("../src/lib/imageLightbox");
const { openDiagramLightbox, closeDiagramLightbox } = await import("../src/lib/diagramLightbox");
const { requestResearchFolderMenuToggle } = await import("../src/lib/researchShortcuts");
const { default: EmptyPromptCards } = await import("../src/components/EmptyPromptCards");
const { default: PromptLibraryMenu } = await import("../src/components/PromptLibraryMenu");
const { listenToComposerInsert } = await import("../src/lib/promptLibrary");
const container = document.getElementById("root")!;
let root = createRoot(container);
const click = async (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
async function key(value: string, shiftKey = false) {
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
afterEach(async () => {
  await act(() => {
    closeImageLightbox();
    closeDiagramLightbox();
    root.unmount();
  });
  clearMocks();
  document.body.innerHTML = "";
  document.body.appendChild(container);
  root = createRoot(container);
});
after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

test("an open Select closes and rejects choices when disabled, including re-enabling", async () => {
  const choices: string[] = [];
  const props = {
    value: "one",
    options: [
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
    ],
    onChange: (v: string) => choices.push(v),
  };
  await act(() => root.render(h(Select, props)));
  await click(document.querySelector("[role=combobox]")!);
  const staleOption = document.querySelectorAll("[role=option]")[1];
  await act(() => root.render(h(Select, { ...props, disabled: true })));
  assert.equal(document.querySelector("[role=listbox]"), null);
  await click(staleOption);
  assert.deepEqual(choices, []);
  await act(() => root.render(h(Select, props)));
  assert.equal(document.querySelector("[role=listbox]"), null);
  await click(document.querySelector("[role=combobox]")!);
  await click(document.querySelectorAll("[role=option]")[1]);
  assert.deepEqual(choices, ["two"]);
});

test("folder shortcut opens focused menu with arrows, typeahead, Escape and Tab dismissal", async () => {
  await act(() =>
    root.render(
      h(ResearchFolderSwitcher, {
        folders: [
          { id: "a", name: "Alpha", dir: "/a" },
          { id: "b", name: "Beta", dir: "/b" },
        ] as any,
        scope: "a",
        treeCounts: new Map(),
        folderPickerBusy: true,
        shortcutHintsShown: false,
        onSelectScope: () => {},
        onNewFolder: async () => null,
        onOpenFolder: async () => {},
        onRenameFolder: () => {},
        onMoveFolder: async () => {},
        onRemoveFolder: () => {},
      }),
    ),
  );
  const trigger = document.querySelector<HTMLButtonElement>(".research-folder-trigger")!;
  await act(() => requestResearchFolderMenuToggle());
  assert.match(document.activeElement!.textContent!, /Alpha/);
  await key("ArrowDown");
  assert.match(document.activeElement!.textContent!, /Beta/);
  await key("a");
  assert.match(document.activeElement!.textContent!, /Alpha/);
  await key("Escape");
  assert.equal(document.querySelector("[role=menu]"), null);
  assert.equal(document.activeElement, trigger);
  await act(() => requestResearchFolderMenuToggle());
  await key("Tab");
  assert.equal(document.querySelector("[role=menu]"), null);
  assert.equal(document.activeElement, trigger); // browser subsequently performs the normal Tab step
});

test("transcript listbox navigates, selects and allows deselecting the active session", async () => {
  const selected: Array<string | null> = [];
  await act(() =>
    root.render(
      h(TranscriptPickerLink, {
        options: [
          { path: "/a", modifiedMs: 2, title: "Alpha" },
          { path: "/b", modifiedMs: 1, title: "Beta" },
        ] as any,
        activePath: "/a",
        onSelect: (path) => selected.push(path),
      }),
    ),
  );
  const trigger = document.querySelector<HTMLButtonElement>("[role=combobox]")!;
  trigger.focus();
  await key("ArrowDown");
  await key("ArrowDown");
  await key("Enter");
  assert.deepEqual(selected, ["/b"]);
  await click(trigger);
  await click(document.querySelectorAll("[role=option]")[0]);
  assert.deepEqual(selected, ["/b", null]);
  await click(trigger);
  await key("Escape");
  assert.equal(document.activeElement, trigger);
});

test("link context menu focuses actions and restores focus on Escape", async () => {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  trigger.focus();
  let closed = false;
  await act(() =>
    root.render(
      h(LinkContextMenu, {
        x: 20,
        y: 30,
        canOpenInternal: true,
        onOpenInternal: () => {},
        onOpenExternal: () => {},
        onClose: () => {
          closed = true;
        },
      }),
    ),
  );
  assert.equal(document.activeElement!.textContent, "Open");
  await key("ArrowDown");
  assert.equal(document.activeElement!.textContent, "Open in browser");
  await key("Escape");
  assert.ok(closed);
  assert.equal(document.activeElement, trigger);
});

for (const kind of ["image", "diagram"] as const) {
  test(`${kind} lightbox traps focus, inerts the app, and restores focus on close`, async () => {
    await act(() => root.render(h(kind === "image" ? ImageLightbox : DiagramLightbox)));
    const trigger = document.createElement("button");
    container.appendChild(trigger);
    trigger.focus();
    await act(() =>
      kind === "image"
        ? openImageLightbox({ src: "data:image/png;base64,", alt: "Preview" })
        : openDiagramLightbox({ lang: "dot", label: "Graph", svg: "<svg></svg>" }),
    );
    const close = document.querySelector<HTMLButtonElement>(".image-lightbox-close")!;
    assert.equal(document.activeElement, close);
    assert.equal(container.inert, true);
    await key("Tab");
    assert.equal(document.activeElement, close);
    await key("Tab", true);
    assert.equal(document.activeElement, close);
    await key("Escape");
    assert.equal(document.querySelector("[role=dialog]"), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(container.inert, undefined);
  });
}

test("app-level Escape dispatch keeps priority over the media dialog listener", async () => {
  await act(() => root.render(h(ImageLightbox)));
  let appHandled = false;
  const dispatch = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      appHandled = true;
      event.stopImmediatePropagation();
      event.stopPropagation();
      closeImageLightbox();
    }
  };
  window.addEventListener("keydown", dispatch, true);
  try {
    await act(() => openImageLightbox({ src: "data:image/png;base64,", alt: "Preview" }));
    await key("Escape");
    assert.equal(appHandled, true);
    assert.equal(document.querySelector("[role=dialog]"), null);
  } finally {
    window.removeEventListener("keydown", dispatch, true);
  }
});

test("remote link menu skips unavailable cache, copies, and restores focus on Tab", async () => {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  trigger.focus();
  let copied = false;
  let closed = false;
  await act(() => root.render(h(LinkContextMenu, {
    x: 10, y: 10, canOpenInternal: true,
    onOpenInternal: () => undefined, onOpenExternal: () => { throw Error("local action must be hidden"); },
    onClose: () => { closed = true; },
    remoteActions: { cachedAvailable: false, onCached: () => { throw Error("cache unavailable"); }, onCopy: () => { copied = true; } },
  })));
  assert.equal(document.activeElement!.textContent, "Open preview");
  assert.ok((document.querySelectorAll("[role=menuitem]")[1] as HTMLButtonElement).disabled);
  assert.doesNotMatch(document.body.textContent!, /Open in browser|Reveal in Finder|default app/u);
  await key("ArrowDown");
  assert.equal(document.activeElement!.textContent, "Copy remote path");
  await click(document.activeElement!);
  assert.ok(copied); assert.ok(closed); assert.equal(document.activeElement, trigger);
  closed = false;
  (document.querySelector("[role=menuitem]") as HTMLElement).focus();
  await key("Tab");
  assert.ok(closed); assert.equal(document.activeElement, trigger);
});


for (const headerless of [false, true]) {
  test(`prompt cards open their Edit/Delete menu and restore focus (${headerless ? "headerless" : "header"})`, async () => {
    const prompt = { name: "review", content: "Review changes", scope: "project", modifiedMs: 7 };
    let prompts = [prompt];
    const inserted: string[] = [];
    let deletion: unknown;
    mockIPC((command, args) => {
      if (command === "prompt_library_list") return { prompts, hasProjectScope: true };
      if (command === "prompt_library_delete") {
        deletion = args;
        prompts = [];
      }
    });
    await act(() => root.render(h("div", { className: "turn-pane" },
      !headerless ? h(PromptLibraryMenu, { agentId: "agent", projectDir: "/project" }) : null,
      h("div", { className: "turn-timeline", tabIndex: 0 },
        h(EmptyPromptCards, {
          projectDir: "/project",
          promptLibraryAgentId: headerless ? null : "agent",
          onInsert: (text: string) => inserted.push(text),
        }),
      ),
    )));
    const card = document.querySelector<HTMLButtonElement>(".turn-empty-prompt-card")!;
    await click(card);
    assert.deepEqual(inserted, [prompt.content]);
    const openContext = async () => act(() => {
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 100 }));
    });
    await openContext();
    assert.equal(document.activeElement?.textContent, "Edit");
    await key("ArrowDown");
    assert.equal(document.activeElement?.textContent, "Delete");
    await key("Escape");
    assert.equal(document.querySelector('[aria-label="Prompt options"][role="menu"]'), null);
    assert.equal(document.activeElement, card);

    await openContext();
    await click(document.activeElement!);
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Edit prompt");
    assert.equal(document.querySelector<HTMLInputElement>(".prompt-library-name-input")?.value, "review");
    await key("Escape");
    assert.equal(document.activeElement, card);

    await key("F10", true);
    assert.equal(document.activeElement?.textContent, "Edit");
    await key("Tab");
    assert.equal(document.querySelector('[aria-label="Prompt options"][role="menu"]'), null);

    await openContext();
    await key("ArrowDown");
    await click(document.activeElement!);
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Delete prompt");
    await click(document.querySelector(".confirm-dialog-actions button:last-child")!);
    assert.deepEqual(deletion, {
      scope: "project", name: "review", projectDir: "/project", expectedModifiedMs: 7,
    });
    assert.equal(document.querySelector(".turn-empty-prompt-card"), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, document.querySelector(headerless ? ".turn-timeline" : ".turn-pane-header-button"));
    assert.deepEqual(inserted, [prompt.content], "context-menu actions never insert the prompt");
  });
}


test("reselecting a placeholder prompt already in the composer skips the fill form", async () => {
  const prompt = { name: "review", content: "Review {target}", scope: "global", modifiedMs: 1 };
  mockIPC((command) => command === "prompt_library_list" ? { prompts: [prompt], hasProjectScope: false } : undefined);
  const selections: string[] = [];
  const stop = listenToComposerInsert("agent", (text, onlyIfPresent) => {
    assert.equal(onlyIfPresent, true);
    selections.push(text);
    return true;
  });
  try {
    await act(() => root.render(h("div", { className: "turn-pane" },
      h(PromptLibraryMenu, { agentId: "agent", onInsert: () => assert.fail("must only refocus") }),
    )));
    await click(document.querySelector(".turn-pane-header-button")!);
    await click(document.querySelector(".prompt-library-item-main")!);
    assert.deepEqual(selections, [prompt.content]);
    assert.equal(document.querySelector(".prompt-library-menu"), null);
    assert.equal(document.querySelector(".prompt-library-fill-snippet"), null);
  } finally {
    stop();
  }
});
