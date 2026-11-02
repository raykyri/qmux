import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, StrictMode } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import ts from "typescript";
import { usePaneSplitPersistence } from "../src/hooks/usePaneSplitPersistence";
import {
  normalizePaneSplitsForPanes, paneSplitsEqual, resizeSplitNodeFractions,
} from "../src/lib/paneSplits";
import type { PaneInfo, PaneSplitInfo } from "../src/types";

const dom = new JSDOM('<!doctype html><div id="root"></div>');
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root")!;
let root = createRoot(container);
let controller: ReturnType<typeof usePaneSplitPersistence>;
const paneSplitsRef = { current: [] as PaneSplitInfo[] };
const panesRef = { current: [] as PaneInfo[] };
const errors: string[] = [];
function Harness() {
  controller = usePaneSplitPersistence(paneSplitsRef, panesRef, (message) => errors.push(message));
  return h("output", {}, JSON.stringify(controller.paneSplits));
}
function pane(id: string): PaneInfo {
  return { id, title: id, kind: "shell", groupId: "g", cwd: "/tmp", cols: 80, rows: 24, status: "running", depth: 0 };
}
function layout(fraction: number): PaneSplitInfo[] {
  return [{ id: "split-ab", paneIds: ["a", "b"], axis: "horizontal", sizes: { a: fraction, b: 1 - fraction } }];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const saves: { splits: PaneSplitInfo[]; request: ReturnType<typeof deferred<PaneSplitInfo[]>> }[] = [];
const reads: ReturnType<typeof deferred<PaneSplitInfo[]>>[] = [];
async function mount() {
  panesRef.current = [pane("a"), pane("b")];
  mockIPC((command, payload) => {
    const request = deferred<PaneSplitInfo[]>();
    if (command === "pane_splits_set") {
      saves.push({ splits: (payload as { splits: PaneSplitInfo[] }).splits, request });
    } else {
      assert.equal(command, "pane_splits_get");
      reads.push(request);
    }
    return request.promise;
  });
  await act(() => root.render(h(StrictMode, {}, h(Harness))));
  await act(() => controller.setPaneSplitsState(layout(0.5)));
}
async function save(fraction: number, reportErrors = true) {
  await act(() => controller.savePaneSplits(layout(fraction), panesRef.current, { reportErrors }));
}
async function settle(index: number) {
  await act(async () => { saves[index].request.resolve(saves[index].splits); });
}
async function echo(fraction: number) {
  await act(() => controller.onPaneSplitsChanged(layout(fraction)));
}
function expectFraction(fraction: number) {
  assert.ok(Math.abs(controller.paneSplits[0].sizes!.a - fraction) < 1e-9, `rendered fraction ${controller.paneSplits[0].sizes!.a} should be ${fraction}`);
  assert.deepEqual(paneSplitsRef.current, controller.paneSplits);
  assert.deepEqual(JSON.parse(container.textContent!), controller.paneSplits);
}
afterEach(async () => {
  await act(() => root.unmount());
  clearMocks();
  paneSplitsRef.current = [];
  saves.length = 0;
  reads.length = 0;
  errors.length = 0;
  root = createRoot(container);
});
after(async () => { await act(() => root.unmount()); dom.window.close(); });

// Exercise the production App keyboard/effect bodies with the real hook. The
// large native-terminal App cannot be mounted in jsdom; only its surrounding
// DOM/native services are omitted. These callbacks are not rewritten models.
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (!result && predicate(node)) result = node;
    if (!result) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, "production callback must exist");
  return result;
}
function callback(source: string, context: Record<string, unknown>) {
  const code = ts.transpileModule(`const callback = ${source};`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(context), `${code}\nreturn callback;`)(...Object.values(context));
}
function keyboard() {
  const fn = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === "resizeTerminalSplitWithKeyboard");
  return callback(fn.getText(ast), {
    paneSplitsRef, paneSplits: controller.paneSplits,
    savePaneSplits: controller.savePaneSplits, resizeSplitNodeFractions,
  });
}
function normalize() {
  const call = findNode((node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
    node.arguments[0]?.getText(ast).includes("const normalized = normalizePaneSplitsForPanes(current, panes)")
  ) as ts.CallExpression;
  return callback(call.arguments[0].getText(ast), {
    paneSplitsRef, panes: panesRef.current, normalizePaneSplitsForPanes, paneSplitsEqual,
    setPaneSplitsState: controller.setPaneSplitsState, savePaneSplits: controller.savePaneSplits,
    // Baseline callback invokes this API directly inside a state updater.
    persistPaneSplits: async (splits: PaneSplitInfo[]) => {
      const { setPaneSplits } = await import("../src/lib/api");
      return setPaneSplits(splits);
    },
  });
}
const key = (key = "ArrowRight", shiftKey = false) => ({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
const divider = { axis: "horizontal", path: "", index: 0 };

test("an older response does not replace a newer optimistic resize", async () => {
  await mount();
  await save(0.53);
  await save(0.56);
  await settle(0);
  expectFraction(0.56);
  await settle(1);
  expectFraction(0.56);
});

test("out-of-order completion keeps the latest local response", async () => {
  await mount();
  await save(0.53);
  await save(0.56);
  await settle(1);
  await settle(0);
  expectFraction(0.56);
});

test("an older echo cannot replace a pending optimistic resize", async () => {
  await mount();
  await save(0.53);
  await save(0.56);
  await echo(0.53);
  expectFraction(0.56);
  await settle(1);
  assert.equal(reads.length, 0, "wait for all outstanding responses");
  await settle(0);
  assert.equal(reads.length, 1);
  await act(async () => { reads[0].resolve(layout(0.56)); });
  expectFraction(0.56);
});

test("a newer accepted backend event invalidates an earlier reconciliation GET", async () => {
  await mount();
  await save(0.6);
  await echo(0.6);
  await settle(0);
  assert.equal(reads.length, 1);
  await echo(0.8);
  await act(async () => { reads[0].resolve(layout(0.6)); });
  expectFraction(0.8);
});

test("a new save invalidates an earlier reconciliation GET", async () => {
  await mount();
  await save(0.6);
  await echo(0.6);
  await settle(0);
  await save(0.7);
  await act(async () => { reads[0].resolve(layout(0.6)); });
  expectFraction(0.7);
  await settle(1);
  expectFraction(0.7);
});

test("an optimistic preview invalidates an earlier reconciliation GET", async () => {
  await mount();
  await save(0.6);
  await echo(0.6);
  await settle(0);
  await act(() => controller.setPaneSplitsState(layout(0.7)));
  await act(async () => { reads[0].resolve(layout(0.6)); });
  expectFraction(0.7);
});

test("multiple deferred echoes coalesce and external changes are reconciled", async () => {
  await mount();
  await save(0.6);
  await echo(0.6);
  await echo(0.7);
  await echo(0.8);
  expectFraction(0.6);
  await settle(0);
  assert.equal(reads.length, 1);
  await act(async () => { reads[0].resolve(layout(0.8)); });
  expectFraction(0.8);
});

test("backend events with no local save apply immediately", async () => {
  await mount();
  await echo(0.8);
  expectFraction(0.8);
  assert.equal(reads.length, 0);
});

test("stale errors are suppressed, current errors report, and a later save succeeds", async () => {
  await mount();
  await save(0.6);
  await save(0.7);
  await act(async () => { saves[0].request.reject(new Error("old failure")); });
  assert.deepEqual(errors, []);
  await act(async () => { saves[1].request.reject(new Error("current failure")); });
  assert.deepEqual(errors, ["current failure"]);
  expectFraction(0.7);
  await save(0.8);
  await settle(2);
  expectFraction(0.8);
});

test("silent normalization failures stay silent and deferred echoes still reconcile", async () => {
  await mount();
  await save(0.6, false);
  await echo(0.5);
  await act(async () => { saves[0].request.reject(new Error("normalization failure")); });
  assert.deepEqual(errors, []);
  assert.equal(reads.length, 1);
  await act(async () => { reads[0].resolve(layout(0.5)); });
  expectFraction(0.5);
});

test("failed reconciliation preserves the local value and later events still apply", async () => {
  await mount();
  await save(0.6);
  await echo(0.6);
  await settle(0);
  await act(async () => { reads[0].reject(new Error("GET failed")); });
  expectFraction(0.6);
  assert.deepEqual(errors, []);
  await echo(0.8);
  expectFraction(0.8);
});

test("unmount ignores a pending response and does not start reconciliation", async () => {
  await mount();
  await save(0.6);
  await echo(0.6);
  await act(() => root.unmount());
  const snapshot = paneSplitsRef.current;
  await settle(0);
  assert.equal(paneSplitsRef.current, snapshot);
  assert.equal(reads.length, 0);
  assert.deepEqual(errors, []);
  root = createRoot(container);
});

test("unmount ignores pending errors", async () => {
  await mount();
  await save(0.6);
  await act(() => root.unmount());
  await act(async () => { saves[0].request.reject(new Error("after unmount")); });
  assert.deepEqual(errors, []);
  root = createRoot(container);
});

test("a pending GET cannot mutate a newly mounted owner's ref", async () => {
  await mount();
  await save(0.6);
  await echo(0.6);
  await settle(0);
  await act(() => root.unmount());
  root = createRoot(container);
  await act(() => root.render(h(StrictMode, {}, h(Harness))));
  await act(() => controller.setPaneSplitsState(layout(0.8)));
  await act(async () => { reads[0].resolve(layout(0.6)); });
  expectFraction(0.8);
});

test("App keyboard steps accumulate within one render batch", async () => {
  await mount();
  const resize = keyboard();
  const renderedSplit = controller.paneSplits[0];
  await act(() => {
    resize(key(), renderedSplit, divider);
    resize(key(), renderedSplit, divider);
  });
  expectFraction(0.56);
  assert.equal(saves.length, 2);
  assert.ok(Math.abs(saves[1].splits[0].sizes!.a - 0.56) < 1e-9);
  await settle(0);
  await settle(1);
  expectFraction(0.56);
});

test("App keyboard ignores unrelated keys and no longer existing splits", async () => {
  await mount();
  const resize = keyboard();
  const renderedSplit = controller.paneSplits[0];
  await act(() => resize(key("Tab"), renderedSplit, divider));
  assert.equal(saves.length, 0);
  await act(() => controller.setPaneSplitsState([]));
  await act(() => resize(key(), renderedSplit, divider));
  assert.equal(saves.length, 0);
  assert.deepEqual(controller.paneSplits, []);
});

test("App normalization runs once even if the effect is replayed", async () => {
  await mount();
  panesRef.current = [pane("a")];
  const normalizeSplits = normalize();
  await act(() => { normalizeSplits(); normalizeSplits(); });
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].splits, []);
  assert.deepEqual(controller.paneSplits, []);
  await act(async () => { saves[0].request.reject(new Error("normalization failure")); });
  assert.deepEqual(errors, []);
});

test("persisted splits can use the requested pane snapshot before the pane event arrives", async () => {
  await mount();
  const requestedPanes = [...panesRef.current, pane("c")];
  const next: PaneSplitInfo[] = [{ id: "split-abc", paneIds: ["a", "b", "c"], sizes: { a: 0.3, b: 0.3, c: 0.4 } }];
  await act(() => controller.savePaneSplits(next, requestedPanes));
  await settle(0);
  assert.deepEqual(controller.paneSplits[0].paneIds, ["a", "b", "c"]);
  assert.deepEqual(paneSplitsRef.current, controller.paneSplits);
});

test("the latest save accepts backend normalization", async () => {
  await mount();
  await save(0.6);
  await act(async () => { saves[0].request.resolve(layout(0.58)); });
  expectFraction(0.58);
});

test("a pending response does not replace a newer pointer preview", async () => {
  await mount();
  await save(0.6);
  await act(() => controller.setPaneSplitsState(layout(0.7)));
  await settle(0);
  expectFraction(0.7);
});

test("App keyboard reads the latest split and preserves other split identities", async () => {
  await mount();
  panesRef.current = [...panesRef.current, pane("c"), pane("d")];
  const resize = keyboard();
  const renderedSplit = controller.paneSplits[0];
  const sibling: PaneSplitInfo = { id: "split-cd", paneIds: ["c", "d"], sizes: { c: 0.4, d: 0.6 } };
  await act(() => controller.setPaneSplitsState([...layout(0.6), sibling]));
  await act(() => resize(key(), renderedSplit, divider));
  expectFraction(0.63);
  assert.deepEqual(controller.paneSplits[1], sibling);
  await settle(0);
  expectFraction(0.63);
});

test("reconciliation retains backend split members before their pane event arrives", async () => {
  await mount();
  const requestedPanes = [...panesRef.current, pane("c")];
  const next: PaneSplitInfo[] = [{ id: "split-abc", paneIds: ["a", "b", "c"], sizes: { a: 0.3, b: 0.3, c: 0.4 } }];
  await act(() => controller.savePaneSplits(next, requestedPanes));
  await act(() => controller.onPaneSplitsChanged(next));
  await settle(0);
  assert.equal(reads.length, 1);
  await act(async () => { reads[0].resolve(next); });
  assert.deepEqual(controller.paneSplits[0].paneIds, ["a", "b", "c"]);
  assert.deepEqual(paneSplitsRef.current, controller.paneSplits);
});
