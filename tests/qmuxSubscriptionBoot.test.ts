import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { AgentInfo, PaneInfo, PaneSplitInfo } from "../src/types";

// Run MainApp's actual hooks, boot, effects and commands. Only the final JSX
// tree is omitted: native terminal and unrelated leaf UI need a real WebView.
// The observer reads the component's lexical state, never a reconstructed model.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "localStorage", "navigator", "DOMParser"])
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
const output = await mkdtemp(path.resolve("tests/.workspace-app-"));
await build({
  entryPoints: ["src/App.tsx"], outfile: path.join(output, "App.mjs"),
  bundle: true, platform: "node", format: "esm", packages: "external",
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
  define: { "import.meta.env.DEV": "false" },
  plugins: [{ name: "observe-main-app", setup(build) {
    build.onLoad({ filter: /\/src\/App\.tsx$/ }, async ({ path: file }) => {
      const source = await readFile(file, "utf8");
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const main = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "MainApp") as ts.FunctionDeclaration;
      const last = main.body!.statements.at(-1)!;
      assert.ok(ts.isReturnStatement(last));
      return { contents: source.slice(0, last.pos) + `
        globalThis.__workspaceObserve({ activePaneId });
        return null;
      ` + source.slice(last.end), loader: "tsx" };
    });
  } }],
});
const { default: App } = await import(pathToFileURL(path.join(output, "App.mjs")).href);
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root")!;
let root = createRoot(container);
let state: any;
(globalThis as any).__workspaceObserve = (value: any) => { state = value; };
let readyCount = 0;
let commands: string[] = [];
const pane = (id: string): PaneInfo => ({ id, groupId: "g", title: id, kind: "shell", cwd: "/tmp", cols: 80, rows: 24, status: "running" });
const agent = (status: AgentInfo["status"], transcriptPath = "/old"): AgentInfo => ({ id: "x", groupId: "g", paneId: "a", adapter: "codex", worktreeDir: "/tmp", status, createdAt: 1, transcriptPath });
const split: PaneSplitInfo = { id: "split", paneIds: ["a", "b"], sizes: { a: 0.5, b: 0.5 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function install(override: (command: string, args: any) => any = () => undefined) {
  mockIPC((command, args: any) => {
    commands.push(command);
    const result = override(command, args);
    if (result !== undefined) return result;
    switch (command) {
      case "get_runtime_config": return { adapters: [], remotes: [], workspaceRoot: "/tmp", homeDir: "/tmp", socketPath: "/tmp/qmux.sock", tabTitleGeneration: { appleFoundationModelsAvailable: false }, fileServerPort: null };
      case "list_panes": return [pane("a"), pane("b"), pane("c")];
      case "list_agents": return [agent("idle")];
      case "list_groups": return [{ id: "g", name: "Group", scope: "terminal", cwd: "/tmp", collapsed: false }];
      case "active_tab_get": return "b";
      case "pane_splits_get": return [split];
      case "pane_splits_set": return args.splits;
      case "list_research_folders": return { folders: [], membership: {}, starred: [], collapsed: [] };
      case "composer_snapshot": return { queues: {}, drafts: {}, globalDrafts: [] };
      case "get_notification_log": return [];
      case "plugin:window|is_focused": return true;
      case "plugin:window|scale_factor": return 1;
      case "human_browser_history_list": return [];
      default: return [];
    }
  }, { shouldMockEvents: true });
  mockWindows("main");
}
async function mount() { await act(async () => { root.render(h(App, { onReady: () => readyCount++ })); }); }
afterEach(async () => {
  await act(() => root.unmount());
  clearMocks(); localStorage.clear(); commands = []; readyCount = 0;
  root = createRoot(container);
});
after(async () => { await act(() => root.unmount()); await rm(output, { recursive: true, force: true }); dom.window.close(); });

test("App: snapshots wait until the global event subscription is registered", async () => {
  install();
  const registration = deferred<void>();
  const invoke = (window as any).__TAURI_INTERNALS__.invoke;
  (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
    if (command === "plugin:event|listen" && args.event === "qmux-event") {
      return registration.promise.then(() => invoke(command, args));
    }
    return invoke(command, args);
  };
  await mount();
  assert.equal(commands.includes("list_panes"), false, "no read may precede subscription readiness");
  assert.equal(readyCount, 0);
  await act(async () => registration.resolve());
  assert.equal(readyCount, 1);
  assert.equal(state.activePaneId, "b");
});

test("App: pending listener registration is cleaned up after disposal without booting", async () => {
  install();
  const registration = deferred<void>();
  const invoke = (window as any).__TAURI_INTERNALS__.invoke;
  let qmuxListener: number | undefined;
  let unlistened = false;
  (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
    if (command === "plugin:event|listen" && args.event === "qmux-event") {
      await registration.promise;
      qmuxListener = await invoke(command, args);
      return qmuxListener;
    }
    if (command === "plugin:event|unlisten" && args.eventId === qmuxListener) unlistened = true;
    return invoke(command, args);
  };
  await mount();
  await act(() => root.unmount());
  root = createRoot(container);
  await act(async () => registration.resolve());
  assert.equal(commands.includes("list_panes"), false);
  assert.equal(readyCount, 0);
  assert.equal(unlistened, true);
});


test("App: registration retry starts boot exactly once after recovery", async () => {
  install();
  const invoke = (window as any).__TAURI_INTERNALS__.invoke;
  let registrations = 0;
  const originalError = console.error;
  console.error = () => {};
  (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
    if (command === "plugin:event|listen" && args.event === "qmux-event" && ++registrations === 1) {
      return Promise.reject(new Error("transient registration failure"));
    }
    return invoke(command, args);
  };
  try {
    await mount();
    assert.equal(commands.includes("list_panes"), false);
    assert.equal(readyCount, 0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    assert.equal(registrations, 2);
    assert.equal(readyCount, 1);
    assert.equal(commands.filter(command => command === "list_panes").length, 1);
  } finally {
    console.error = originalError;
  }
});
